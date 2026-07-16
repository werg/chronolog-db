import { chmod, mkdir, open, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import {
  decodeSignedGenesis,
  encodeSignedGenesis,
  signGenesis,
  validationPolicyId,
  type GenesisManifest,
  type SignedGenesis,
  type ValidationPolicy,
} from '@chronolog/capabilities'
import {
  exportX25519PrivateKey,
  generateX25519KeyPair,
  importX25519PrivateKey,
} from '@chronolog/crypto'
import {
  DOMAINS,
  exportEd25519PrivateKey,
  generateEd25519KeyPair,
  importEd25519PrivateKey,
  signDomain,
  utf8,
  verifyDomain,
  type Ed25519KeyPair,
} from '@chronolog/protocol'
import type { DaemonSecretStore } from './secret-store.js'

export interface LoadedGovernanceBootstrap {
  readonly genesis: SignedGenesis
  readonly validationPolicyId: Uint8Array
  readonly recipientId: Uint8Array
  readonly recipientPublicKey: Uint8Array
  readonly recipientPrivateKey: CryptoKey
  /** Development recovery kit; production deployments move these references to separate stores. */
  readonly recoveryPrivateKeysPkcs8?: readonly [Uint8Array, Uint8Array, Uint8Array]
}

interface GovernanceDocument {
  readonly format: 'chronolog-governance-bootstrap-v1'
  readonly signedGenesis: string
  readonly recipientId: string
  readonly recipientPublicKey: string
  readonly recipientPrivateKeyPkcs8: string
  readonly recoveryPrivateKeysPkcs8: readonly [string, string, string]
}

interface GovernanceDocumentV2 extends Omit<GovernanceDocument, 'format' | 'recipientPrivateKeyPkcs8' | 'recoveryPrivateKeysPkcs8'> {
  readonly format: 'chronolog-governance-bootstrap-v2'
  readonly recipientPrivateKeyRef: string
  readonly recoveryPrivateKeyRefs: readonly [string, string, string]
}

interface GovernanceDocumentV3 extends Omit<GovernanceDocumentV2, 'format' | 'recoveryPrivateKeyRefs'> {
  readonly format: 'chronolog-governance-bootstrap-v3'
  readonly recoveryCustody: 'external'
}

type StoredGovernanceDocument = GovernanceDocument | GovernanceDocumentV2 | GovernanceDocumentV3

export interface RecoveryCustodyManifest {
  readonly format: 'chronolog-recovery-custody-v1'
  readonly groupId: string
  readonly recoveryThreshold: string
  readonly recoveryPublicKeys: readonly [string, string, string]
  readonly shares: readonly [
    { readonly index: 0; readonly file: 'recovery-share-0.pkcs8.base64' },
    { readonly index: 1; readonly file: 'recovery-share-1.pkcs8.base64' },
    { readonly index: 2; readonly file: 'recovery-share-2.pkcs8.base64' },
  ]
}

interface ResolvedGovernanceDocument {
  readonly signedGenesis: string
  readonly recipientId: string
  readonly recipientPublicKey: string
  readonly recipientPrivateKeyPkcs8: string
  readonly recoveryPrivateKeysPkcs8?: readonly [string, string, string]
}

export async function loadOrCreateGovernanceBootstrap(options: {
  readonly dataDirectory: string
  readonly groupId: Uint8Array
  readonly schemaId: Uint8Array
  readonly identity: Ed25519KeyPair
  readonly transportAuthor: string
  readonly now?: () => number
  readonly secretStore?: DaemonSecretStore
}): Promise<LoadedGovernanceBootstrap> {
  const path = join(options.dataDirectory, 'governance.json')
  let document: StoredGovernanceDocument
  try {
    document = parseDocument(JSON.parse(await readFile(path, 'utf8')))
    await chmod(path, 0o600)
  } catch (error) {
    if (!isMissing(error)) throw error
    const recipient = await generateX25519KeyPair()
    const recovery = await Promise.all([
      generateEd25519KeyPair(), generateEd25519KeyPair(), generateEd25519KeyPair(),
    ])
    const policy: ValidationPolicy = {
      version: 1n,
      minimumValidators: 1n,
      classMinimums: new Map(),
      requiredOrganizations: [],
    }
    const common = {
      subjectId: options.identity.publicKeyBytes,
      signingPublicKey: options.identity.publicKeyBytes,
      transportAuthor: options.transportAuthor,
      validFromRevision: 0n,
    }
    const manifest: GenesisManifest = {
      groupId: options.groupId,
      schemaId: options.schemaId,
      rootAdminPublicKey: options.identity.publicKeyBytes,
      capabilityLogFeed: new TextEncoder().encode(options.transportAuthor),
      recoveryPublicKeys: [recovery[0].publicKeyBytes, recovery[1].publicKeyBytes, recovery[2].publicKeyBytes],
      recoveryThreshold: 2n,
      initialCapabilities: [
        { ...common, role: 'administrator' },
        { ...common, role: 'schema-administrator' },
        { ...common, role: 'writer' },
        { ...common, role: 'validator', minimumAuthorTimestampMs: 0n },
        { ...common, role: 'reader', readerScope: 'audit', hpkePublicKey: recipient.publicKeyBytes },
      ],
      validationPolicies: [policy],
      clockPolicy: { maxFutureSkewMs: 30_000n, cutoffLagMs: 60_000n, heartbeatIntervalMs: 30_000n },
      resourcePolicy: { maxCandidateBytes: 16_000_000n, maxProgramNodes: 10_000n, maxPreconditions: 1_000n, maxMutations: 1_000n },
      encryptionSuite: 'HPKE-X25519-HKDF-SHA256-AES-256-GCM',
      createdAtMs: BigInt(Math.trunc(options.now?.() ?? Date.now())),
    }
    const genesis = await signGenesis(manifest, options.identity.privateKey)
    const inlineDocument: GovernanceDocument = {
      format: 'chronolog-governance-bootstrap-v1',
      signedGenesis: base64(encodeSignedGenesis(genesis)),
      recipientId: base64(options.identity.publicKeyBytes),
      recipientPublicKey: base64(recipient.publicKeyBytes),
      recipientPrivateKeyPkcs8: base64(await exportX25519PrivateKey(recipient.privateKey)),
      recoveryPrivateKeysPkcs8: [
        base64(await exportEd25519PrivateKey(recovery[0].privateKey)),
        base64(await exportEd25519PrivateKey(recovery[1].privateKey)),
        base64(await exportEd25519PrivateKey(recovery[2].privateKey)),
      ],
    }
    document = options.secretStore === undefined
      ? inlineDocument
      : await externalizeDocument(inlineDocument, options.groupId, options.secretStore)
    await atomicWrite(path, `${JSON.stringify(document, null, 2)}\n`)
  }
  if (document.format === 'chronolog-governance-bootstrap-v1' && options.secretStore !== undefined) {
    document = await externalizeDocument(document, options.groupId, options.secretStore)
    await atomicWrite(path, `${JSON.stringify(document, null, 2)}\n`)
  }
  const resolved = await resolveDocument(document, options.secretStore)
  const genesis = decodeSignedGenesis(unbase64(resolved.signedGenesis))
  if (!sameBytes(genesis.manifest.groupId, options.groupId)) throw new Error('GOVERNANCE_GROUP_MISMATCH')
  return {
    genesis,
    validationPolicyId: await validationPolicyId(genesis.manifest.validationPolicies[0]!),
    recipientId: unbase64(resolved.recipientId),
    recipientPublicKey: unbase64(resolved.recipientPublicKey),
    recipientPrivateKey: await importX25519PrivateKey(unbase64(resolved.recipientPrivateKeyPkcs8), false),
    ...(resolved.recoveryPrivateKeysPkcs8 === undefined ? {} : {
      recoveryPrivateKeysPkcs8: resolved.recoveryPrivateKeysPkcs8.map(unbase64) as unknown as readonly [Uint8Array, Uint8Array, Uint8Array],
    }),
  }
}

export async function exportRecoveryCustody(options: {
  readonly dataDirectory: string
  readonly outputDirectory: string
  readonly secretStore?: DaemonSecretStore
}): Promise<RecoveryCustodyManifest> {
  const document = parseDocument(JSON.parse(await readFile(join(options.dataDirectory, 'governance.json'), 'utf8')))
  if (document.format === 'chronolog-governance-bootstrap-v3') throw new Error('RECOVERY_CUSTODY_ALREADY_EXTERNAL')
  const resolved = await resolveDocument(document, options.secretStore)
  const privateKeys = resolved.recoveryPrivateKeysPkcs8
  if (privateKeys === undefined) throw new Error('RECOVERY_CUSTODY_ALREADY_EXTERNAL')
  const genesis = decodeSignedGenesis(unbase64(resolved.signedGenesis))
  await verifyRecoveryShares(privateKeys, genesis.manifest.recoveryPublicKeys)
  await mkdir(options.outputDirectory, { recursive: false, mode: 0o700 })
  const shares = [
    { index: 0, file: 'recovery-share-0.pkcs8.base64' },
    { index: 1, file: 'recovery-share-1.pkcs8.base64' },
    { index: 2, file: 'recovery-share-2.pkcs8.base64' },
  ] as const
  for (const share of shares) {
    await writeFile(join(options.outputDirectory, share.file), `${privateKeys[share.index]}\n`, {
      encoding: 'utf8', mode: 0o600, flag: 'wx',
    })
  }
  const manifest: RecoveryCustodyManifest = {
    format: 'chronolog-recovery-custody-v1',
    groupId: base64(genesis.manifest.groupId),
    recoveryThreshold: genesis.manifest.recoveryThreshold.toString(10),
    recoveryPublicKeys: genesis.manifest.recoveryPublicKeys.map(base64) as unknown as [string, string, string],
    shares,
  }
  await writeFile(join(options.outputDirectory, 'recovery-custody.json'), `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: 'utf8', mode: 0o600, flag: 'wx',
  })
  return manifest
}

export async function purgeExportedRecoveryCustody(options: {
  readonly dataDirectory: string
  readonly custodyDirectory: string
  readonly secretStore?: DaemonSecretStore
  readonly confirmExternalCustody: boolean
}): Promise<void> {
  if (!options.confirmExternalCustody) throw new Error('RECOVERY_CUSTODY_CONFIRMATION_REQUIRED')
  const path = join(options.dataDirectory, 'governance.json')
  const document = parseDocument(JSON.parse(await readFile(path, 'utf8')))
  if (document.format === 'chronolog-governance-bootstrap-v3') return
  const resolved = await resolveDocument(document, options.secretStore)
  const manifest = parseCustodyManifest(JSON.parse(await readFile(join(options.custodyDirectory, 'recovery-custody.json'), 'utf8')))
  const genesis = decodeSignedGenesis(unbase64(resolved.signedGenesis))
  if (manifest.groupId !== base64(genesis.manifest.groupId) ||
      manifest.recoveryThreshold !== genesis.manifest.recoveryThreshold.toString(10) ||
      manifest.recoveryPublicKeys.some((key, index) => key !== base64(genesis.manifest.recoveryPublicKeys[index]!))) {
    throw new Error('RECOVERY_CUSTODY_MANIFEST_MISMATCH')
  }
  const exported = await Promise.all(manifest.shares.map(async (share) =>
    (await readFile(join(options.custodyDirectory, share.file), 'utf8')).trim())) as [string, string, string]
  await verifyRecoveryShares(exported, genesis.manifest.recoveryPublicKeys)
  const external: GovernanceDocumentV3 = {
    format: 'chronolog-governance-bootstrap-v3',
    signedGenesis: resolved.signedGenesis,
    recipientId: resolved.recipientId,
    recipientPublicKey: resolved.recipientPublicKey,
    recipientPrivateKeyRef: document.format === 'chronolog-governance-bootstrap-v1'
      ? await externalizeRecipient(document, genesis.manifest.groupId, options.secretStore)
      : document.recipientPrivateKeyRef,
    recoveryCustody: 'external',
  }
  await atomicWrite(path, `${JSON.stringify(external, null, 2)}\n`)
  if (document.format === 'chronolog-governance-bootstrap-v2') {
    if (options.secretStore === undefined) throw new Error('DAEMON_SECRET_STORE_REQUIRED')
    for (const reference of document.recoveryPrivateKeyRefs) await options.secretStore.delete(reference)
  }
}

function parseDocument(value: unknown): StoredGovernanceDocument {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('GOVERNANCE_CONFIG_INVALID')
  const record = value as Record<string, unknown>
  if (record.format === 'chronolog-governance-bootstrap-v2') return parseExternalDocument(record)
  if (record.format === 'chronolog-governance-bootstrap-v3') return parseExternalCustodyDocument(record)
  const allowed = new Set([
    'format', 'signedGenesis', 'recipientId', 'recipientPublicKey',
    'recipientPrivateKeyPkcs8', 'recoveryPrivateKeysPkcs8',
  ])
  if (record.format !== 'chronolog-governance-bootstrap-v1' || Object.keys(record).some((key) => !allowed.has(key)) ||
      typeof record.signedGenesis !== 'string' || typeof record.recipientId !== 'string' ||
      typeof record.recipientPublicKey !== 'string' || typeof record.recipientPrivateKeyPkcs8 !== 'string' ||
      !Array.isArray(record.recoveryPrivateKeysPkcs8) || record.recoveryPrivateKeysPkcs8.length !== 3 ||
      record.recoveryPrivateKeysPkcs8.some((key: unknown) => typeof key !== 'string')) {
    throw new Error('GOVERNANCE_CONFIG_INVALID')
  }
  return record as unknown as GovernanceDocument
}

function parseExternalCustodyDocument(record: Record<string, unknown>): GovernanceDocumentV3 {
  const allowed = new Set([
    'format', 'signedGenesis', 'recipientId', 'recipientPublicKey',
    'recipientPrivateKeyRef', 'recoveryCustody',
  ])
  if (Object.keys(record).some((key) => !allowed.has(key)) ||
      typeof record.signedGenesis !== 'string' || typeof record.recipientId !== 'string' ||
      typeof record.recipientPublicKey !== 'string' || typeof record.recipientPrivateKeyRef !== 'string' ||
      record.recoveryCustody !== 'external') throw new Error('GOVERNANCE_CONFIG_INVALID')
  validateReference(record.recipientPrivateKeyRef)
  return record as unknown as GovernanceDocumentV3
}

function parseExternalDocument(record: Record<string, unknown>): GovernanceDocumentV2 {
  const allowed = new Set([
    'format', 'signedGenesis', 'recipientId', 'recipientPublicKey',
    'recipientPrivateKeyRef', 'recoveryPrivateKeyRefs',
  ])
  if (Object.keys(record).some((key) => !allowed.has(key)) ||
      typeof record.signedGenesis !== 'string' || typeof record.recipientId !== 'string' ||
      typeof record.recipientPublicKey !== 'string' || typeof record.recipientPrivateKeyRef !== 'string' ||
      !Array.isArray(record.recoveryPrivateKeyRefs) || record.recoveryPrivateKeyRefs.length !== 3 ||
      record.recoveryPrivateKeyRefs.some((key: unknown) => typeof key !== 'string')) {
    throw new Error('GOVERNANCE_CONFIG_INVALID')
  }
  validateReference(record.recipientPrivateKeyRef)
  for (const reference of record.recoveryPrivateKeyRefs as string[]) validateReference(reference)
  return record as unknown as GovernanceDocumentV2
}

async function externalizeDocument(
  document: GovernanceDocument,
  groupId: Uint8Array,
  secretStore: DaemonSecretStore,
): Promise<GovernanceDocumentV2> {
  const suffix = Buffer.from(groupId).toString('base64url')
  const recipientPrivateKeyRef = `groups/${suffix}/governance-recipient`
  const recoveryPrivateKeyRefs = [0, 1, 2].map(
    (index) => `groups/${suffix}/recovery/${index}`,
  ) as [string, string, string]
  await secretStore.set(recipientPrivateKeyRef, document.recipientPrivateKeyPkcs8)
  for (const [index, reference] of recoveryPrivateKeyRefs.entries()) {
    await secretStore.set(reference, document.recoveryPrivateKeysPkcs8[index]!)
  }
  return {
    format: 'chronolog-governance-bootstrap-v2',
    signedGenesis: document.signedGenesis,
    recipientId: document.recipientId,
    recipientPublicKey: document.recipientPublicKey,
    recipientPrivateKeyRef,
    recoveryPrivateKeyRefs,
  }
}

async function externalizeRecipient(
  document: GovernanceDocument,
  groupId: Uint8Array,
  secretStore: DaemonSecretStore | undefined,
): Promise<string> {
  if (secretStore === undefined) throw new Error('DAEMON_SECRET_STORE_REQUIRED')
  const reference = `groups/${Buffer.from(groupId).toString('base64url')}/governance-recipient`
  await secretStore.set(reference, document.recipientPrivateKeyPkcs8)
  return reference
}

async function resolveDocument(
  document: StoredGovernanceDocument,
  secretStore: DaemonSecretStore | undefined,
): Promise<ResolvedGovernanceDocument> {
  if (document.format === 'chronolog-governance-bootstrap-v1') return document
  if (secretStore === undefined) throw new Error('DAEMON_SECRET_STORE_REQUIRED')
  return {
    signedGenesis: document.signedGenesis,
    recipientId: document.recipientId,
    recipientPublicKey: document.recipientPublicKey,
    recipientPrivateKeyPkcs8: await secretStore.get(document.recipientPrivateKeyRef),
    ...(document.format === 'chronolog-governance-bootstrap-v3' ? {} : {
      recoveryPrivateKeysPkcs8: await Promise.all(
        document.recoveryPrivateKeyRefs.map((reference) => secretStore.get(reference)),
      ) as [string, string, string],
    }),
  }
}

async function verifyRecoveryShares(
  privateKeys: readonly [string, string, string],
  publicKeys: readonly [Uint8Array, Uint8Array, Uint8Array],
): Promise<void> {
  const challenge = utf8('chronolog/recovery-custody-export/v1')
  for (let index = 0; index < 3; index += 1) {
    const privateKey = await importEd25519PrivateKey(unbase64(privateKeys[index]!))
    const signature = await signDomain(DOMAINS.recovery, challenge, privateKey)
    if (!await verifyDomain(DOMAINS.recovery, challenge, signature, publicKeys[index]!)) {
      throw new Error(`RECOVERY_CUSTODY_KEY_MISMATCH:${index}`)
    }
  }
}

function parseCustodyManifest(value: unknown): RecoveryCustodyManifest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('RECOVERY_CUSTODY_MANIFEST_INVALID')
  const record = value as Record<string, unknown>
  if (record.format !== 'chronolog-recovery-custody-v1' || typeof record.groupId !== 'string' ||
      typeof record.recoveryThreshold !== 'string' || !Array.isArray(record.recoveryPublicKeys) ||
      record.recoveryPublicKeys.length !== 3 || record.recoveryPublicKeys.some((key) => typeof key !== 'string') ||
      !Array.isArray(record.shares) || record.shares.length !== 3) throw new Error('RECOVERY_CUSTODY_MANIFEST_INVALID')
  const expected = ['recovery-share-0.pkcs8.base64', 'recovery-share-1.pkcs8.base64', 'recovery-share-2.pkcs8.base64']
  for (const [index, share] of record.shares.entries()) {
    if (typeof share !== 'object' || share === null || Array.isArray(share) ||
        (share as Record<string, unknown>).index !== index ||
        (share as Record<string, unknown>).file !== expected[index]) throw new Error('RECOVERY_CUSTODY_MANIFEST_INVALID')
  }
  return record as unknown as RecoveryCustodyManifest
}

function validateReference(reference: string): void {
  if (!/^[A-Za-z0-9._:/-]{1,256}$/u.test(reference)) throw new Error('GOVERNANCE_SECRET_REFERENCE_INVALID')
}

async function atomicWrite(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.tmp`
  await writeFile(temporary, contents, { encoding: 'utf8', mode: 0o600 })
  await chmod(temporary, 0o600)
  const handle = await open(temporary, 'r')
  try { await handle.sync() } finally { await handle.close() }
  await rename(temporary, path)
}

function base64(value: Uint8Array): string { return Buffer.from(value).toString('base64') }
function unbase64(value: string): Uint8Array { return Uint8Array.from(Buffer.from(value, 'base64')) }
function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}
function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'ENOENT'
}
