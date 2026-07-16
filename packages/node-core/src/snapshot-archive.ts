import { createHash, randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { copyFile, mkdir, open, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import {
  assertSnapshotTrust,
  decodeSignedSnapshotManifest,
  encodeSignedSnapshotManifest,
  type SignedSnapshotManifest,
  type TrustedSnapshotManifest,
} from './snapshots.js'

interface SnapshotArchiveIndex {
  readonly format: 'chronolog-snapshot-archive-v1'
  readonly database: { readonly file: 'application.db'; readonly bytes: number; readonly sha256: string }
  readonly signedManifest: { readonly file: 'snapshot.cbor'; readonly bytes: number; readonly sha256: string }
}

export interface StagedSnapshotArchive {
  readonly databasePath: string
  readonly manifest: TrustedSnapshotManifest
  readonly archiveDirectory: string
}

export async function exportSnapshotArchive(options: {
  readonly archiveDirectory: string
  readonly databasePath: string
  readonly signedManifest: SignedSnapshotManifest
}): Promise<void> {
  await mkdir(options.archiveDirectory, { recursive: false, mode: 0o700 })
  const manifestBytes = encodeSignedSnapshotManifest(options.signedManifest)
  const databasePath = join(options.archiveDirectory, 'application.db')
  const manifestPath = join(options.archiveDirectory, 'snapshot.cbor')
  await copyFile(options.databasePath, databasePath)
  await writeFile(manifestPath, manifestBytes, { mode: 0o600, flag: 'wx' })
  const database = await evidence(databasePath)
  const signedManifest = await evidence(manifestPath)
  const index: SnapshotArchiveIndex = {
    format: 'chronolog-snapshot-archive-v1',
    database: { file: 'application.db', ...database },
    signedManifest: { file: 'snapshot.cbor', ...signedManifest },
  }
  await writeFile(join(options.archiveDirectory, 'archive.json'), `${JSON.stringify(index, null, 2)}\n`, {
    encoding: 'utf8', mode: 0o600, flag: 'wx',
  })
}

export async function stageSnapshotArchive(options: {
  readonly archiveDirectory: string
  readonly targetDatabasePath: string
  readonly expectations: Parameters<typeof assertSnapshotTrust>[1]
  readonly validateDatabase: (path: string, manifest: TrustedSnapshotManifest) => Promise<void>
  readonly maximumDatabaseBytes?: number
}): Promise<StagedSnapshotArchive> {
  const index = parseIndex(JSON.parse(await readFile(join(options.archiveDirectory, 'archive.json'), 'utf8')))
  const databaseSource = join(options.archiveDirectory, index.database.file)
  const manifestSource = join(options.archiveDirectory, index.signedManifest.file)
  await assertEvidence(databaseSource, index.database, options.maximumDatabaseBytes ?? 64 * 1024 * 1024 * 1024)
  await assertEvidence(manifestSource, index.signedManifest, 1024 * 1024)
  const signed = decodeSignedSnapshotManifest(Uint8Array.from(await readFile(manifestSource)))
  const manifest = await assertSnapshotTrust(signed, options.expectations)
  const databasePath = `${options.targetDatabasePath}.snapshot-stage-${randomBytes(8).toString('hex')}`
  await copyFile(databaseSource, databasePath)
  await syncFile(databasePath)
  try { await options.validateDatabase(databasePath, manifest) }
  catch (error) {
    // Keep the failed stage for forensic inspection; it is never selected by
    // the daemon because only the exact target path is opened.
    throw new Error('SNAPSHOT_STAGED_DATABASE_INVALID', { cause: error })
  }
  return { databasePath, manifest, archiveDirectory: options.archiveDirectory }
}

export async function commitStagedSnapshot(options: {
  readonly staged: StagedSnapshotArchive
  readonly targetDatabasePath: string
  readonly backupPath: string
}): Promise<void> {
  if (options.staged.databasePath === options.targetDatabasePath ||
      dirname(options.staged.databasePath) !== dirname(options.targetDatabasePath)) {
    throw new Error('SNAPSHOT_STAGE_NOT_ATOMIC')
  }
  await copyFile(options.targetDatabasePath, options.backupPath, constants.COPYFILE_EXCL)
  await syncFile(options.backupPath)
  await rename(options.staged.databasePath, options.targetDatabasePath)
  await syncDirectory(dirname(options.targetDatabasePath))
}

function parseIndex(value: unknown): SnapshotArchiveIndex {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('SNAPSHOT_ARCHIVE_INDEX_INVALID')
  const record = value as Record<string, unknown>
  if (record.format !== 'chronolog-snapshot-archive-v1' || !validEntry(record.database, 'application.db') ||
      !validEntry(record.signedManifest, 'snapshot.cbor')) throw new Error('SNAPSHOT_ARCHIVE_INDEX_INVALID')
  return record as unknown as SnapshotArchiveIndex
}
function validEntry(value: unknown, file: string): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const entry = value as Record<string, unknown>
  return Object.keys(entry).length === 3 && entry.file === file &&
    Number.isSafeInteger(entry.bytes) && (entry.bytes as number) >= 0 &&
    typeof entry.sha256 === 'string' && /^[0-9a-f]{64}$/u.test(entry.sha256)
}
async function evidence(path: string): Promise<{ readonly bytes: number; readonly sha256: string }> {
  const value = await readFile(path)
  return { bytes: value.byteLength, sha256: createHash('sha256').update(value).digest('hex') }
}
async function assertEvidence(path: string, expected: { readonly bytes: number; readonly sha256: string }, maximum: number): Promise<void> {
  const metadata = await stat(path)
  if (!metadata.isFile() || metadata.size !== expected.bytes || metadata.size > maximum) throw new Error('SNAPSHOT_ARCHIVE_SIZE_MISMATCH')
  const actual = await evidence(path)
  if (actual.sha256 !== expected.sha256) throw new Error('SNAPSHOT_ARCHIVE_DIGEST_MISMATCH')
}
async function syncFile(path: string): Promise<void> {
  const handle = await open(path, 'r')
  try { await handle.sync() } finally { await handle.close() }
}
async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r')
  try { await handle.sync() } finally { await handle.close() }
}
