import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import {
  exportEd25519PrivateKey,
  generateEd25519KeyPair,
  importEd25519PrivateKey,
  importEd25519PublicKey,
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

export async function loadOrCreateConfig(dataDirectory: string): Promise<LoadedDaemonConfig> {
  const path = join(dataDirectory, 'config.json')
  let config: DaemonConfig
  try {
    config = JSON.parse(await readFile(path, 'utf8')) as DaemonConfig
    if (config.format !== 'chronolog-daemon') throw new Error('DAEMON_CONFIG_UNSUPPORTED')
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
  const publicKeyBytes = fromBase64(config.publicKey)
  return {
    config,
    identity: {
      publicKeyBytes,
      publicKey: await importEd25519PublicKey(publicKeyBytes),
      privateKey: await importEd25519PrivateKey(fromBase64(config.privateKeyPkcs8)),
    },
  }
}

export function fromBase64(value: string): Uint8Array {
  return Uint8Array.from(Buffer.from(value, 'base64'))
}

function toBase64(value: Uint8Array): string { return Buffer.from(value).toString('base64') }
function randomBase64(length: number): string { return toBase64(globalThis.crypto.getRandomValues(new Uint8Array(length))) }

async function atomicWrite(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.tmp`
  await writeFile(temporary, contents, { encoding: 'utf8', mode: 0o600 })
  await rename(temporary, path)
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'ENOENT'
}
