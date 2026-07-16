import { chmod, mkdir, open, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import {
  DOMAINS,
  exportEd25519PrivateKey,
  generateEd25519KeyPair,
  importEd25519PrivateKey,
  importEd25519PublicKey,
  signDomain,
  utf8,
  verifyDomain,
  type Ed25519KeyPair,
} from '@chronolog/protocol'
import type { DaemonSecretStore } from './secret-store.js'

export interface DaemonConfig {
  readonly format: 'chronolog-daemon'
  readonly groupId: string
  readonly groupRoute: string
  readonly membershipRevision: string
  readonly validationPolicy: string
  readonly validatorCapability: string
  readonly epoch: string
  readonly epochContentKey: string
  readonly publicKey: string
  readonly privateKeyPkcs8: string
}

interface DaemonConfigV2 extends Omit<DaemonConfig, 'format' | 'epochContentKey' | 'privateKeyPkcs8'> {
  readonly format: 'chronolog-daemon-v2'
  readonly epochContentKeyRef: string
  readonly privateKeyPkcs8Ref: string
}

type DaemonConfigDocument = DaemonConfig | DaemonConfigV2

export interface LoadedDaemonConfig {
  readonly config: DaemonConfig
  readonly identity: Ed25519KeyPair
}

export interface DaemonRuntimeConfig {
  readonly host: string
  readonly port: number
  readonly token?: string
  readonly ssbHost: string
  readonly ssbPort: number
  readonly ssbScope: 'device' | 'local' | 'public'
  readonly peers: readonly { readonly address: string; readonly feedId: string }[]
  readonly staleReconnectMs?: number
  readonly checkpointEvery: number
  readonly cutoffLagMs: number
  readonly maxFutureSkewMs: number
  readonly heartbeatIntervalMs: number
  readonly publicSsbAddress?: string
  readonly natDiscoveryUrl?: string
  readonly natVerificationUrl?: string
  readonly natDiscoveryTimeoutMs: number
  readonly blobMaxInlineBytes?: number
  readonly blobChunkBytes?: number
  readonly blobPeers: readonly { readonly url: string; readonly token?: string }[]
}

export function parseDaemonRuntimeConfig(environment: NodeJS.ProcessEnv): DaemonRuntimeConfig {
  const host = nonempty(environment.CHRONOLOG_HOST ?? '127.0.0.1', 'CHRONOLOG_HOST')
  const ssbHost = nonempty(environment.CHRONOLOG_SSB_HOST ?? '127.0.0.1', 'CHRONOLOG_SSB_HOST')
  const token = environment.CHRONOLOG_TOKEN
  if (token !== undefined && token.length === 0) throw new Error('CHRONOLOG_TOKEN_INVALID')
  if (!isLoopbackHost(host) && token === undefined) throw new Error('CHRONOLOG_TOKEN_REQUIRED_FOR_REMOTE_HOST')
  const scope = environment.CHRONOLOG_SSB_SCOPE ?? 'device'
  if (scope !== 'device' && scope !== 'local' && scope !== 'public') throw new Error('CHRONOLOG_SSB_SCOPE_INVALID')
  const blobMaxInlineBytes = environment.CHRONOLOG_BLOB_MAX_INLINE_BYTES
  const blobPeers = parseBlobPeers(environment.CHRONOLOG_BLOB_PEERS)
  if (blobMaxInlineBytes === undefined && blobPeers.length > 0) throw new Error('CHRONOLOG_BLOB_MODE_REQUIRED')
  return {
    host,
    port: integer(environment.CHRONOLOG_PORT ?? '8787', 0, 65_535, 'CHRONOLOG_PORT'),
    ...(token === undefined ? {} : { token }),
    ssbHost,
    ssbPort: integer(environment.CHRONOLOG_SSB_PORT ?? '0', 0, 65_535, 'CHRONOLOG_SSB_PORT'),
    ssbScope: scope,
    peers: parsePeers(environment.CHRONOLOG_SSB_PEERS),
    ...(environment.CHRONOLOG_SSB_STALE_RECONNECT_MS === undefined ? {} : {
      staleReconnectMs: integer(environment.CHRONOLOG_SSB_STALE_RECONNECT_MS, 1, Number.MAX_SAFE_INTEGER, 'CHRONOLOG_SSB_STALE_RECONNECT_MS'),
    }),
    checkpointEvery: integer(environment.CHRONOLOG_CHECKPOINT_EVERY ?? '100', 1, Number.MAX_SAFE_INTEGER, 'CHRONOLOG_CHECKPOINT_EVERY'),
    cutoffLagMs: integer(environment.CHRONOLOG_CUTOFF_LAG_MS ?? '60000', 0, Number.MAX_SAFE_INTEGER, 'CHRONOLOG_CUTOFF_LAG_MS'),
    maxFutureSkewMs: integer(environment.CHRONOLOG_MAX_FUTURE_SKEW_MS ?? '30000', 0, Number.MAX_SAFE_INTEGER, 'CHRONOLOG_MAX_FUTURE_SKEW_MS'),
    heartbeatIntervalMs: integer(environment.CHRONOLOG_HEARTBEAT_INTERVAL_MS ?? '30000', 1, Number.MAX_SAFE_INTEGER, 'CHRONOLOG_HEARTBEAT_INTERVAL_MS'),
    ...(environment.CHRONOLOG_PUBLIC_SSB_ADDRESS === undefined ? {} : {
      publicSsbAddress: nonempty(environment.CHRONOLOG_PUBLIC_SSB_ADDRESS, 'CHRONOLOG_PUBLIC_SSB_ADDRESS'),
    }),
    ...(environment.CHRONOLOG_NAT_DISCOVERY_URL === undefined ? {} : {
      natDiscoveryUrl: validUrl(environment.CHRONOLOG_NAT_DISCOVERY_URL, 'CHRONOLOG_NAT_DISCOVERY_URL'),
    }),
    ...(environment.CHRONOLOG_NAT_VERIFICATION_URL === undefined ? {} : {
      natVerificationUrl: validUrl(environment.CHRONOLOG_NAT_VERIFICATION_URL, 'CHRONOLOG_NAT_VERIFICATION_URL'),
    }),
    natDiscoveryTimeoutMs: integer(environment.CHRONOLOG_NAT_DISCOVERY_TIMEOUT_MS ?? '3000', 1, 60_000, 'CHRONOLOG_NAT_DISCOVERY_TIMEOUT_MS'),
    ...(blobMaxInlineBytes === undefined ? {} : {
      blobMaxInlineBytes: integer(blobMaxInlineBytes, 0, 16 * 1024 * 1024, 'CHRONOLOG_BLOB_MAX_INLINE_BYTES'),
      blobChunkBytes: integer(environment.CHRONOLOG_BLOB_CHUNK_BYTES ?? '1048576', 1, 4 * 1024 * 1024, 'CHRONOLOG_BLOB_CHUNK_BYTES'),
    }),
    blobPeers,
  }
}

export async function loadOrCreateConfig(
  dataDirectory: string,
  secretStore?: DaemonSecretStore,
): Promise<LoadedDaemonConfig> {
  const path = join(dataDirectory, 'config.json')
  let document: DaemonConfigDocument
  try {
    document = parseConfigDocument(JSON.parse(await readFile(path, 'utf8')))
    await chmod(path, 0o600)
  } catch (error) {
    if (!isMissing(error)) throw error
    const identity = await generateEd25519KeyPair()
    const config: DaemonConfig = {
      format: 'chronolog-daemon',
      groupId: randomBase64(32),
      groupRoute: randomBase64(32),
      membershipRevision: randomBase64(32),
      validationPolicy: randomBase64(32),
      validatorCapability: randomBase64(32),
      epoch: '1',
      epochContentKey: randomBase64(32),
      publicKey: toBase64(identity.publicKeyBytes),
      privateKeyPkcs8: toBase64(await exportEd25519PrivateKey(identity.privateKey)),
    }
    document = secretStore === undefined ? config : await externalizeConfig(config, secretStore)
    await atomicWrite(path, JSON.stringify(document, null, 2))
    return { config, identity }
  }
  if (document.format === 'chronolog-daemon' && secretStore !== undefined) {
    document = await externalizeConfig(document, secretStore)
    await atomicWrite(path, JSON.stringify(document, null, 2))
  }
  const config = await resolveConfig(document, secretStore)
  const publicKeyBytes = decodeExact(config.publicKey, 32, 'publicKey')
  const publicKey = await importEd25519PublicKey(publicKeyBytes)
  const privateKey = await importEd25519PrivateKey(fromBase64(config.privateKeyPkcs8))
  const challenge = utf8('chronolog-daemon/config-key-match/v1')
  const signature = await signDomain(DOMAINS.transaction, challenge, privateKey)
  if (!await verifyDomain(DOMAINS.transaction, challenge, signature, publicKey)) {
    throw new Error('DAEMON_CONFIG_KEY_MISMATCH')
  }
  return {
    config,
    identity: {
      publicKeyBytes,
      publicKey,
      privateKey,
    },
  }
}

export function fromBase64(value: string): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw new Error('DAEMON_CONFIG_BASE64_INVALID')
  }
  const decoded = Uint8Array.from(Buffer.from(value, 'base64'))
  if (toBase64(decoded) !== value) throw new Error('DAEMON_CONFIG_BASE64_NON_CANONICAL')
  return decoded
}

function toBase64(value: Uint8Array): string { return Buffer.from(value).toString('base64') }
function randomBase64(length: number): string { return toBase64(globalThis.crypto.getRandomValues(new Uint8Array(length))) }

async function atomicWrite(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.tmp`
  await writeFile(temporary, contents, { encoding: 'utf8', mode: 0o600 })
  await chmod(temporary, 0o600)
  await syncPath(temporary)
  await rename(temporary, path)
  await syncPath(dirname(path))
}

function parseConfigDocument(value: unknown): DaemonConfigDocument {
  if (!isRecord(value)) throw new Error('DAEMON_CONFIG_INVALID')
  if (value.format !== 'chronolog-daemon' && value.format !== 'chronolog-daemon-v2') {
    throw new Error('DAEMON_CONFIG_UNSUPPORTED')
  }
  if (value.format === 'chronolog-daemon-v2') return parseExternalConfig(value)
  const fields = [
    'groupId', 'groupRoute', 'membershipRevision', 'validationPolicy', 'validatorCapability',
    'epoch', 'epochContentKey', 'publicKey', 'privateKeyPkcs8',
  ] as const
  const allowed = new Set<string>(['format', ...fields])
  if (Object.keys(value).some((field) => !allowed.has(field)) || fields.some((field) => typeof value[field] !== 'string')) {
    throw new Error('DAEMON_CONFIG_INVALID')
  }
  const config = value as unknown as DaemonConfig
  decodeExact(config.groupId, 32, 'groupId')
  decodeExact(config.groupRoute, 32, 'groupRoute')
  decodeExact(config.membershipRevision, 32, 'membershipRevision')
  decodeExact(config.validationPolicy, 32, 'validationPolicy')
  decodeExact(config.validatorCapability, 32, 'validatorCapability')
  decodeExact(config.epochContentKey, 32, 'epochContentKey')
  decodeExact(config.publicKey, 32, 'publicKey')
  if (fromBase64(config.privateKeyPkcs8).length === 0) throw new Error('DAEMON_CONFIG_PRIVATE_KEY_EMPTY')
  if (!/^[1-9][0-9]*$/u.test(config.epoch) || BigInt(config.epoch) > 0xffff_ffff_ffff_ffffn) {
    throw new Error('DAEMON_CONFIG_EPOCH_INVALID')
  }
  return config
}

function parseExternalConfig(value: Record<string, unknown>): DaemonConfigV2 {
  const fields = [
    'groupId', 'groupRoute', 'membershipRevision', 'validationPolicy', 'validatorCapability',
    'epoch', 'publicKey', 'epochContentKeyRef', 'privateKeyPkcs8Ref',
  ] as const
  const allowed = new Set<string>(['format', ...fields])
  if (Object.keys(value).some((field) => !allowed.has(field)) ||
      fields.some((field) => typeof value[field] !== 'string')) throw new Error('DAEMON_CONFIG_INVALID')
  const config = value as unknown as DaemonConfigV2
  validatePublicConfig(config)
  validateSecretReference(config.epochContentKeyRef)
  validateSecretReference(config.privateKeyPkcs8Ref)
  return config
}

function validatePublicConfig(config: Pick<DaemonConfig, 'groupId' | 'groupRoute' | 'membershipRevision' | 'validationPolicy' | 'validatorCapability' | 'epoch' | 'publicKey'>): void {
  decodeExact(config.groupId, 32, 'groupId')
  decodeExact(config.groupRoute, 32, 'groupRoute')
  decodeExact(config.membershipRevision, 32, 'membershipRevision')
  decodeExact(config.validationPolicy, 32, 'validationPolicy')
  decodeExact(config.validatorCapability, 32, 'validatorCapability')
  decodeExact(config.publicKey, 32, 'publicKey')
  if (!/^[1-9][0-9]*$/u.test(config.epoch) || BigInt(config.epoch) > 0xffff_ffff_ffff_ffffn) {
    throw new Error('DAEMON_CONFIG_EPOCH_INVALID')
  }
}

async function externalizeConfig(config: DaemonConfig, secretStore: DaemonSecretStore): Promise<DaemonConfigV2> {
  const suffix = Buffer.from(fromBase64(config.groupId)).toString('base64url')
  const epochContentKeyRef = `groups/${suffix}/epoch/${config.epoch}`
  const privateKeyPkcs8Ref = `groups/${suffix}/daemon-signing`
  await secretStore.set(epochContentKeyRef, config.epochContentKey)
  await secretStore.set(privateKeyPkcs8Ref, config.privateKeyPkcs8)
  const { epochContentKey: _epochKey, privateKeyPkcs8: _privateKey, format: _format, ...publicConfig } = config
  return { format: 'chronolog-daemon-v2', ...publicConfig, epochContentKeyRef, privateKeyPkcs8Ref }
}

async function resolveConfig(
  document: DaemonConfigDocument,
  secretStore: DaemonSecretStore | undefined,
): Promise<DaemonConfig> {
  if (document.format === 'chronolog-daemon') return document
  if (secretStore === undefined) throw new Error('DAEMON_SECRET_STORE_REQUIRED')
  return {
    format: 'chronolog-daemon',
    groupId: document.groupId,
    groupRoute: document.groupRoute,
    membershipRevision: document.membershipRevision,
    validationPolicy: document.validationPolicy,
    validatorCapability: document.validatorCapability,
    epoch: document.epoch,
    epochContentKey: await secretStore.get(document.epochContentKeyRef),
    publicKey: document.publicKey,
    privateKeyPkcs8: await secretStore.get(document.privateKeyPkcs8Ref),
  }
}

function validateSecretReference(reference: string): void {
  if (!/^[A-Za-z0-9._:/-]{1,256}$/u.test(reference)) throw new Error('DAEMON_CONFIG_SECRET_REFERENCE_INVALID')
}

function decodeExact(value: string, length: number, field: string): Uint8Array {
  const decoded = fromBase64(value)
  if (decoded.length !== length) throw new Error(`DAEMON_CONFIG_${field.toUpperCase()}_LENGTH_INVALID`)
  return decoded
}

async function syncPath(path: string): Promise<void> {
  const handle = await open(path, 'r')
  try { await handle.sync() } finally { await handle.close() }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parsePeers(value: string | undefined): readonly { readonly address: string; readonly feedId: string }[] {
  if (value === undefined) return []
  let parsed: unknown
  try { parsed = JSON.parse(value) } catch { throw new Error('CHRONOLOG_SSB_PEERS_JSON_INVALID') }
  if (!Array.isArray(parsed)) throw new Error('CHRONOLOG_SSB_PEERS_INVALID')
  const peers = parsed.map((peer) => {
    if (!isRecord(peer) || typeof peer.address !== 'string' || typeof peer.feedId !== 'string') {
      throw new Error('CHRONOLOG_SSB_PEER_INVALID')
    }
    if (Object.keys(peer).some((field) => field !== 'address' && field !== 'feedId')) {
      throw new Error('CHRONOLOG_SSB_PEER_INVALID')
    }
    if (peer.address.length === 0 || !peer.feedId.startsWith('@')) throw new Error('CHRONOLOG_SSB_PEER_INVALID')
    return { address: peer.address, feedId: peer.feedId }
  })
  if (new Set(peers.map((peer) => peer.feedId)).size !== peers.length) throw new Error('CHRONOLOG_SSB_PEER_DUPLICATE')
  return peers
}

function parseBlobPeers(value: string | undefined): readonly { readonly url: string; readonly token?: string }[] {
  if (value === undefined) return []
  let parsed: unknown
  try { parsed = JSON.parse(value) } catch { throw new Error('CHRONOLOG_BLOB_PEERS_JSON_INVALID') }
  if (!Array.isArray(parsed)) throw new Error('CHRONOLOG_BLOB_PEERS_INVALID')
  const peers = parsed.map((peer) => {
    if (!isRecord(peer) || typeof peer.url !== 'string' ||
        (peer.token !== undefined && (typeof peer.token !== 'string' || peer.token.length === 0)) ||
        Object.keys(peer).some((field) => field !== 'url' && field !== 'token')) throw new Error('CHRONOLOG_BLOB_PEER_INVALID')
    return { url: validUrl(peer.url, 'CHRONOLOG_BLOB_PEER_URL'), ...(peer.token === undefined ? {} : { token: peer.token }) }
  })
  if (new Set(peers.map((peer) => peer.url)).size !== peers.length) throw new Error('CHRONOLOG_BLOB_PEER_DUPLICATE')
  return peers
}

function integer(value: string, minimum: number, maximum: number, field: string): number {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) throw new Error(`${field}_INVALID`)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error(`${field}_INVALID`)
  return parsed
}

function nonempty(value: string, field: string): string {
  if (value.length === 0) throw new Error(`${field}_INVALID`)
  return value
}

function validUrl(value: string, field: string): string {
  let url: URL
  try { url = new URL(value) } catch { throw new Error(`${field}_INVALID`) }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackHost(url.hostname))) {
    throw new Error(`${field}_INVALID`)
  }
  return url.href
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase()
  return normalized === 'localhost' || normalized === '::1' || normalized === '[::1]' || /^127(?:\.[0-9]{1,3}){3}$/u.test(normalized)
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'ENOENT'
}
