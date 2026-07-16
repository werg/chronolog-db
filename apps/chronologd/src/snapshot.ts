import { readFile, rename } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { createCoreExecutionManifest } from '@chronolog/compiler-sqlite'
import {
  DeterministicMaterializer,
  readNativeEngineInfo,
} from '@chronolog/materializer-doltlite'
import {
  FeedForkRegistry,
  JsonFeedForkPersistence,
  commitStagedSnapshot,
  exportSnapshotArchive,
  signSnapshotManifest,
  stageSnapshotArchive,
  type SnapshotFeedHead,
  type TrustedSnapshotManifest,
} from '@chronolog/node-core'
import { equalBytes } from '@chronolog/protocol'
import type { TransportRecord } from '@chronolog/transport-ssb'

import { fromBase64, loadOrCreateConfig } from './config.js'
import { acquireDataDirectoryLock } from './data-lock.js'
import { daemonSecretStoreFromEnvironment } from './secret-store.js'

interface RepairPlanDocument {
  readonly feedId: string
  readonly trustedHeadId: string
  readonly records: readonly {
    readonly author: string
    readonly sequence: string
    readonly id: string
    readonly previous?: string
    readonly receivedAtMs: number
    readonly payload: string
  }[]
}

const args = process.argv.slice(2)
const command = args.shift()
const archiveDirectory = resolve(required(args.shift(), '<export|import|repair> ARCHIVE_DIRECTORY'))
const dataDirectory = resolve(process.env.CHRONOLOG_DATA_DIR ?? '.chronolog')
const lock = await acquireDataDirectoryLock(dataDirectory, `snapshot-${command ?? 'unknown'}`)
try {
  const secretStore = daemonSecretStoreFromEnvironment(process.env)
  const { config, identity } = await loadOrCreateConfig(dataDirectory, secretStore)
  const groupId = fromBase64(config.groupId)
  const executionManifest = createCoreExecutionManifest({
    profile: 'chronolog-core-portable',
    engineDigest: readNativeEngineInfo().digest,
  })
  const databasePath = join(dataDirectory, 'application.db')
  if (command === 'export') {
    const materializer = await DeterministicMaterializer.open({ path: databasePath, executionManifest })
    let manifest: TrustedSnapshotManifest
    try {
      manifest = {
        version: 1,
        groupId,
        executionManifestDigest: materializer.executionManifestDigest,
        materializedRevision: materializer.revision,
        orderLength: materializer.orderLength,
        databaseContentHash: materializer.databaseContentHash,
        transactionLogDigest: await materializer.transactionLogDigest(),
        feedHeads: feedHeads(join(dataDirectory, 'feed-continuity.json')),
        createdAtMs: BigInt(Date.now()),
      }
    } finally { materializer.close() }
    await exportSnapshotArchive({
      archiveDirectory,
      databasePath,
      signedManifest: await signSnapshotManifest(manifest, identity),
    })
    output({ exported: true, archiveDirectory, revision: manifest.materializedRevision.toString(10), signer: b64(identity.publicKeyBytes) })
  } else if (command === 'import' || command === 'repair') {
    const signer = b64bytes(required(option(args, '--signer'), `${command} requires --signer BASE64URL_PUBLIC_KEY`), 32)
    const current = await DeterministicMaterializer.open({ path: databasePath, executionManifest })
    const minimumRevision = current.revision
    current.close()
    const staged = await stageSnapshotArchive({
      archiveDirectory,
      targetDatabasePath: databasePath,
      expectations: { groupId, executionManifestDigest: current.executionManifestDigest, authorizedSigners: [signer], minimumRevision },
      validateDatabase: async (path, manifest) => validateMaterializer(path, executionManifest, manifest),
    })
    if (!args.includes('--confirm-replace')) throw new Error('SNAPSHOT_REPLACE_CONFIRMATION_REQUIRED')
    const backupPath = `${databasePath}.pre-snapshot-r${staged.manifest.materializedRevision}`
    await commitStagedSnapshot({ staged, targetDatabasePath: databasePath, backupPath })
    await invalidateControlSnapshot(dataDirectory, staged.manifest.materializedRevision)
    if (command === 'repair') {
      const planPath = required(option(args, '--plan'), 'repair requires --plan FILE')
      await applyFeedRepair(dataDirectory, staged.manifest, JSON.parse(await readFile(resolve(planPath), 'utf8')) as RepairPlanDocument)
    }
    output({ imported: true, repaired: command === 'repair', revision: staged.manifest.materializedRevision.toString(10), backupPath })
  } else throw new Error('Usage: chronolog-snapshot <export ARCHIVE|import ARCHIVE --signer KEY --confirm-replace|repair ARCHIVE --signer KEY --plan FILE --confirm-replace>')
} finally {
  await lock.release()
}

async function validateMaterializer(
  path: string,
  executionManifest: ReturnType<typeof createCoreExecutionManifest>,
  manifest: TrustedSnapshotManifest,
): Promise<void> {
  const materializer = await DeterministicMaterializer.open({ path, executionManifest })
  try {
    if (materializer.revision !== manifest.materializedRevision || materializer.orderLength !== manifest.orderLength ||
        materializer.databaseContentHash !== manifest.databaseContentHash ||
        !equalBytes(await materializer.transactionLogDigest(), manifest.transactionLogDigest)) {
      throw new Error('SNAPSHOT_MATERIALIZED_EVIDENCE_MISMATCH')
    }
  } finally { materializer.close() }
}

function feedHeads(path: string): readonly SnapshotFeedHead[] {
  const snapshot = new JsonFeedForkPersistence(path).load()
  return (snapshot?.feeds ?? []).flatMap((feed) => {
    const head = feed.records.at(-1)
    return head === undefined ? [] : [{ feedId: feed.feedId, sequence: BigInt(head.sequence), recordId: head.id }]
  }).sort((left, right) => left.feedId.localeCompare(right.feedId))
}

async function applyFeedRepair(dataDirectory: string, manifest: TrustedSnapshotManifest, document: RepairPlanDocument): Promise<void> {
  const signedHead = manifest.feedHeads.find((head) => head.feedId === document.feedId)
  if (signedHead?.recordId !== document.trustedHeadId) throw new Error('FEED_REPAIR_SNAPSHOT_HEAD_MISMATCH')
  const records: TransportRecord[] = document.records.map((record) => ({
    author: record.author,
    sequence: decimal(record.sequence, 'sequence'),
    id: record.id,
    ...(record.previous === undefined ? {} : { previous: record.previous }),
    receivedAtMs: record.receivedAtMs,
    payload: b64bytes(record.payload),
  }))
  const registry = new FeedForkRegistry(new JsonFeedForkPersistence(join(dataDirectory, 'feed-continuity.json')))
  registry.applyRepair(registry.createRepairPlan(document.feedId, records, document.trustedHeadId))
}

async function invalidateControlSnapshot(dataDirectory: string, revision: bigint): Promise<void> {
  try { await rename(join(dataDirectory, 'control.json'), join(dataDirectory, `control.json.pre-snapshot-r${revision}`)) }
  catch (error) { if (!missing(error)) throw error }
}
function option(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name)
  return index < 0 ? undefined : args[index + 1]
}
function required(value: string | undefined, usage: string): string { if (value === undefined) throw new Error(usage); return value }
function decimal(value: string, label: string): bigint { if (!/^[1-9][0-9]*$/u.test(value)) throw new Error(`${label} must be a positive decimal`); return BigInt(value) }
function b64bytes(value: string, length?: number): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error('SNAPSHOT_BASE64URL_INVALID')
  const result = Uint8Array.from(Buffer.from(value, 'base64url'))
  if (b64(result) !== value || (length !== undefined && result.length !== length)) throw new Error('SNAPSHOT_BASE64URL_INVALID')
  return result
}
function b64(value: Uint8Array): string { return Buffer.from(value).toString('base64url') }
function missing(error: unknown): boolean { return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'ENOENT' }
function output(value: unknown): void { process.stdout.write(`${JSON.stringify(value)}\n`) }
