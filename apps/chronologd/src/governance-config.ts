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
  exportEd25519PrivateKey,
  generateEd25519KeyPair,
  type Ed25519KeyPair,
} from '@chronolog/protocol'

export interface LoadedGovernanceBootstrap {
  readonly genesis: SignedGenesis
  readonly validationPolicyId: Uint8Array
  readonly recipientId: Uint8Array
  readonly recipientPublicKey: Uint8Array
  readonly recipientPrivateKey: CryptoKey
  /** Development recovery kit; production deployments move these references to separate stores. */
  readonly recoveryPrivateKeysPkcs8: readonly [Uint8Array, Uint8Array, Uint8Array]
}

interface GovernanceDocument {
  readonly format: 'chronolog-governance-bootstrap-v1'
  readonly signedGenesis: string
  readonly recipientId: string
  readonly recipientPublicKey: string
  readonly recipientPrivateKeyPkcs8: string
  readonly recoveryPrivateKeysPkcs8: readonly [string, string, string]
}

export async function loadOrCreateGovernanceBootstrap(options: {
  readonly dataDirectory: string
  readonly groupId: Uint8Array
  readonly schemaId: Uint8Array
  readonly identity: Ed25519KeyPair
  readonly transportAuthor: string
  readonly now?: () => number
}): Promise<LoadedGovernanceBootstrap> {
  const path = join(options.dataDirectory, 'governance.json')
  let document: GovernanceDocument
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
    document = {
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
    await atomicWrite(path, `${JSON.stringify(document, null, 2)}\n`)
  }
  const genesis = decodeSignedGenesis(unbase64(document.signedGenesis))
  if (!sameBytes(genesis.manifest.groupId, options.groupId)) throw new Error('GOVERNANCE_GROUP_MISMATCH')
  return {
    genesis,
    validationPolicyId: await validationPolicyId(genesis.manifest.validationPolicies[0]!),
    recipientId: unbase64(document.recipientId),
    recipientPublicKey: unbase64(document.recipientPublicKey),
    recipientPrivateKey: await importX25519PrivateKey(unbase64(document.recipientPrivateKeyPkcs8), false),
    recoveryPrivateKeysPkcs8: document.recoveryPrivateKeysPkcs8.map(unbase64) as unknown as readonly [Uint8Array, Uint8Array, Uint8Array],
  }
}

function parseDocument(value: unknown): GovernanceDocument {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('GOVERNANCE_CONFIG_INVALID')
  const record = value as Record<string, unknown>
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
