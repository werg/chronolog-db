import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { generateEd25519KeyPair } from '@chronolog/protocol'
import { afterEach, describe, expect, it } from 'vitest'

import {
  exportRecoveryCustody,
  loadOrCreateGovernanceBootstrap,
  purgeExportedRecoveryCustody,
} from './governance-config.js'
import { MemoryDaemonSecretStore } from './secret-store.js'

const directories: string[] = []
afterEach(async () => Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))))

describe('daemon governance bootstrap', () => {
  it('persists one private bootstrap and reloads its signed genesis exactly', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'chronolog-governance-config-'))
    directories.push(dataDirectory)
    const identity = await generateEd25519KeyPair()
    const options = {
      dataDirectory,
      groupId: bytes32(1),
      schemaId: bytes32(2),
      identity,
      transportAuthor: '@root.ed25519',
      now: () => 100,
    }
    const first = await loadOrCreateGovernanceBootstrap(options)
    const second = await loadOrCreateGovernanceBootstrap(options)
    expect((await stat(join(dataDirectory, 'governance.json'))).mode & 0o777).toBe(0o600)
    expect(second.genesis).toEqual(first.genesis)
    expect(second.validationPolicyId).toEqual(first.validationPolicyId)
    expect(second.recipientId).toEqual(identity.publicKeyBytes)
    expect(second.recoveryPrivateKeysPkcs8!.every((key) => key.length > 0)).toBe(true)
  })

  it('keeps recipient and recovery private keys out of the governance document', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'chronolog-governance-secrets-'))
    directories.push(dataDirectory)
    const secretStore = new MemoryDaemonSecretStore()
    const options = {
      dataDirectory,
      groupId: bytes32(11),
      schemaId: bytes32(12),
      identity: await generateEd25519KeyPair(),
      transportAuthor: '@root.ed25519',
      secretStore,
      now: () => 100,
    }
    const first = await loadOrCreateGovernanceBootstrap(options)
    const document = JSON.parse(await readFile(join(dataDirectory, 'governance.json'), 'utf8')) as Record<string, unknown>
    expect(document.format).toBe('chronolog-governance-bootstrap-v2')
    expect(document).not.toHaveProperty('recipientPrivateKeyPkcs8')
    expect(document).not.toHaveProperty('recoveryPrivateKeysPkcs8')
    const second = await loadOrCreateGovernanceBootstrap(options)
    expect(second.genesis).toEqual(first.genesis)
    expect(second.recoveryPrivateKeysPkcs8).toEqual(first.recoveryPrivateKeysPkcs8)
    const { secretStore: _secretStore, ...withoutSecretStore } = options
    await expect(loadOrCreateGovernanceBootstrap(withoutSecretStore))
      .rejects.toThrow('DAEMON_SECRET_STORE_REQUIRED')
  })

  it('exports verified shares and removes their online references only after confirmation', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'chronolog-governance-custody-'))
    directories.push(dataDirectory)
    const custodyDirectory = join(dataDirectory, 'offline-handoff')
    const secretStore = new MemoryDaemonSecretStore()
    const options = {
      dataDirectory,
      groupId: bytes32(21),
      schemaId: bytes32(22),
      identity: await generateEd25519KeyPair(),
      transportAuthor: '@root.ed25519',
      secretStore,
      now: () => 100,
    }
    const bootstrap = await loadOrCreateGovernanceBootstrap(options)
    const manifest = await exportRecoveryCustody({ dataDirectory, outputDirectory: custodyDirectory, secretStore })
    expect(manifest.recoveryThreshold).toBe('2')
    expect((await stat(join(custodyDirectory, 'recovery-share-0.pkcs8.base64'))).mode & 0o777).toBe(0o600)
    await expect(purgeExportedRecoveryCustody({
      dataDirectory, custodyDirectory, secretStore, confirmExternalCustody: false,
    })).rejects.toThrow('RECOVERY_CUSTODY_CONFIRMATION_REQUIRED')
    await purgeExportedRecoveryCustody({
      dataDirectory, custodyDirectory, secretStore, confirmExternalCustody: true,
    })
    const document = JSON.parse(await readFile(join(dataDirectory, 'governance.json'), 'utf8')) as Record<string, unknown>
    expect(document).toMatchObject({ format: 'chronolog-governance-bootstrap-v3', recoveryCustody: 'external' })
    expect(document).not.toHaveProperty('recoveryPrivateKeyRefs')
    const reloaded = await loadOrCreateGovernanceBootstrap(options)
    expect(reloaded.genesis).toEqual(bootstrap.genesis)
    expect(reloaded.recoveryPrivateKeysPkcs8).toBeUndefined()
    for (let index = 0; index < 3; index += 1) {
      await expect(secretStore.get(`groups/${Buffer.from(options.groupId).toString('base64url')}/recovery/${index}`))
        .rejects.toThrow('DAEMON_SECRET_NOT_FOUND')
    }
  })
})

function bytes32(seed: number): Uint8Array {
  return Uint8Array.from({ length: 32 }, (_value, index) => (seed + index) & 0xff)
}
