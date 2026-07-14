import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { generateEd25519KeyPair } from '@chronolog/protocol'
import { afterEach, describe, expect, it } from 'vitest'

import { loadOrCreateConfig, parseDaemonRuntimeConfig } from './config.js'

const directories: string[] = []

afterEach(async () => {
  const { rm } = await import('node:fs/promises')
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'chronolog-config-'))
  directories.push(directory)
  return directory
}

describe('daemon configuration', () => {
  it('creates a strict, private configuration and verifies its key pair on reload', async () => {
    const directory = await temporaryDirectory()
    const created = await loadOrCreateConfig(directory)
    const path = join(directory, 'config.json')
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    const loaded = await loadOrCreateConfig(directory)
    expect(loaded.config).toEqual(created.config)
    expect(loaded.identity.publicKeyBytes).toEqual(created.identity.publicKeyBytes)
  })

  it('rejects a private key that does not match the configured public key', async () => {
    const directory = await temporaryDirectory()
    await loadOrCreateConfig(directory)
    const path = join(directory, 'config.json')
    const config = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
    const other = await generateEd25519KeyPair()
    config.publicKey = Buffer.from(other.publicKeyBytes).toString('base64')
    await writeFile(path, JSON.stringify(config), { mode: 0o600 })
    await expect(loadOrCreateConfig(directory)).rejects.toThrow('DAEMON_CONFIG_KEY_MISMATCH')
  })

  it('rejects malformed base64 and invalid fixed-width fields at startup', async () => {
    const directory = await temporaryDirectory()
    await loadOrCreateConfig(directory)
    const path = join(directory, 'config.json')
    const config = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
    config.groupId = 'not base64'
    await writeFile(path, JSON.stringify(config), { mode: 0o600 })
    await expect(loadOrCreateConfig(directory)).rejects.toThrow('DAEMON_CONFIG_BASE64_INVALID')
  })

  it('rejects unknown persistent and peer configuration fields', async () => {
    const directory = await temporaryDirectory()
    await loadOrCreateConfig(directory)
    const path = join(directory, 'config.json')
    const config = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
    config.unreviewedOption = true
    await writeFile(path, JSON.stringify(config), { mode: 0o600 })
    await expect(loadOrCreateConfig(directory)).rejects.toThrow('DAEMON_CONFIG_INVALID')

    expect(() => parseDaemonRuntimeConfig({
      CHRONOLOG_SSB_PEERS: '[{"address":"net:a","feedId":"@a","ambient":true}]',
    })).toThrow('CHRONOLOG_SSB_PEER_INVALID')
  })

  it('strictly validates numeric, scope, and peer environment settings', () => {
    expect(parseDaemonRuntimeConfig({ CHRONOLOG_PORT: '0' })).toMatchObject({ port: 0, ssbScope: 'device' })
    expect(() => parseDaemonRuntimeConfig({ CHRONOLOG_PORT: '12.5' })).toThrow('CHRONOLOG_PORT_INVALID')
    expect(() => parseDaemonRuntimeConfig({ CHRONOLOG_SSB_SCOPE: 'internet' })).toThrow('CHRONOLOG_SSB_SCOPE_INVALID')
    expect(() => parseDaemonRuntimeConfig({ CHRONOLOG_CHECKPOINT_EVERY: '0' })).toThrow('CHRONOLOG_CHECKPOINT_EVERY_INVALID')
    expect(() => parseDaemonRuntimeConfig({ CHRONOLOG_SSB_PEERS: '[{"address":"net:a","feedId":"@a"},{"address":"net:b","feedId":"@a"}]' })).toThrow('CHRONOLOG_SSB_PEER_DUPLICATE')
    expect(() => parseDaemonRuntimeConfig({ CHRONOLOG_HOST: '0.0.0.0' })).toThrow('CHRONOLOG_TOKEN_REQUIRED_FOR_REMOTE_HOST')
    expect(parseDaemonRuntimeConfig({ CHRONOLOG_HOST: '0.0.0.0', CHRONOLOG_TOKEN: 'secret' })).toMatchObject({
      host: '0.0.0.0', token: 'secret',
    })
    expect(() => parseDaemonRuntimeConfig({ CHRONOLOG_TOKEN: '' })).toThrow('CHRONOLOG_TOKEN_INVALID')
  })
})
