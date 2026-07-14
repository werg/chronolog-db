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
}

export function parseDaemonRuntimeConfig(environment: NodeJS.ProcessEnv): DaemonRuntimeConfig {
  const host = nonempty(environment.CHRONOLOG_HOST ?? '127.0.0.1', 'CHRONOLOG_HOST')
  const ssbHost = nonempty(environment.CHRONOLOG_SSB_HOST ?? '127.0.0.1', 'CHRONOLOG_SSB_HOST')
  const token = environment.CHRONOLOG_TOKEN
  if (token !== undefined && token.length === 0) throw new Error('CHRONOLOG_TOKEN_INVALID')
  if (!isLoopbackHost(host) && token === undefined) throw new Error('CHRONOLOG_TOKEN_REQUIRED_FOR_REMOTE_HOST')
  const scope = environment.CHRONOLOG_SSB_SCOPE ?? 'device'
  if (scope !== 'device' && scope !== 'local' && scope !== 'public') throw new Error('CHRONOLOG_SSB_SCOPE_INVALID')
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
  }
}

export async function loadOrCreateConfig(dataDirectory: string): Promise<LoadedDaemonConfig> {
  const path = join(dataDirectory, 'config.json')
  let config: DaemonConfig
  try {
    config = parseConfig(JSON.parse(await readFile(path, 'utf8')))
    await chmod(path, 0o600)
  } catch (error) {
    if (!isMissing(error)) throw error
    const identity = await generateEd25519KeyPair()
    config = {
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
    await atomicWrite(path, JSON.stringify(config, null, 2))
    return { config, identity }
  }
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

function parseConfig(value: unknown): DaemonConfig {
  if (!isRecord(value)) throw new Error('DAEMON_CONFIG_INVALID')
  if (value.format !== 'chronolog-daemon') throw new Error('DAEMON_CONFIG_UNSUPPORTED')
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

function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase()
  return normalized === 'localhost' || normalized === '::1' || normalized === '[::1]' || /^127(?:\.[0-9]{1,3}){3}$/u.test(normalized)
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'ENOENT'
}
