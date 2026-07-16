import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { loadOrCreateConfig } from './config.js'
import {
  LinuxSecretServiceStore,
  MemoryDaemonSecretStore,
  daemonSecretStoreFromEnvironment,
  type SecretCommandRunner,
} from './secret-store.js'

const directories: string[] = []
afterEach(async () => Promise.all(
  directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
))

describe('daemon OS secret storage', () => {
  it('creates and reloads a reference-only config', async () => {
    const directory = await temporaryDirectory()
    const secrets = new MemoryDaemonSecretStore()
    const created = await loadOrCreateConfig(directory, secrets)
    const document = JSON.parse(await readFile(join(directory, 'config.json'), 'utf8')) as Record<string, unknown>
    expect(document.format).toBe('chronolog-daemon-v2')
    expect(document).not.toHaveProperty('epochContentKey')
    expect(document).not.toHaveProperty('privateKeyPkcs8')
    expect(await secrets.get(String(document.epochContentKeyRef))).toBe(created.config.epochContentKey)
    expect(await secrets.get(String(document.privateKeyPkcs8Ref))).toBe(created.config.privateKeyPkcs8)

    const loaded = await loadOrCreateConfig(directory, secrets)
    expect(loaded.config).toEqual(created.config)
    await expect(loadOrCreateConfig(directory)).rejects.toThrow('DAEMON_SECRET_STORE_REQUIRED')
  })

  it('atomically migrates an existing inline config when a store is enabled', async () => {
    const directory = await temporaryDirectory()
    const inline = await loadOrCreateConfig(directory)
    const secrets = new MemoryDaemonSecretStore()
    const migrated = await loadOrCreateConfig(directory, secrets)
    expect(migrated.config).toEqual(inline.config)
    const document = JSON.parse(await readFile(join(directory, 'config.json'), 'utf8')) as Record<string, unknown>
    expect(document.format).toBe('chronolog-daemon-v2')
    expect(document).not.toHaveProperty('privateKeyPkcs8')
  })

  it('passes secret values over stdin rather than process arguments', async () => {
    const run = vi.fn<SecretCommandRunner>().mockResolvedValue('stored\n')
    const store = new LinuxSecretServiceStore('chronolog-test', run)
    await store.set('groups/example/signing', 'private-value')
    const [command, arguments_, standardInput] = run.mock.calls[0]!
    expect(command).toBe('secret-tool')
    expect(arguments_).not.toContain('private-value')
    expect(standardInput).toBe('private-value')
  })

  it('selects the Secret Service provider only on Linux', () => {
    expect(daemonSecretStoreFromEnvironment({})).toBeUndefined()
    expect(daemonSecretStoreFromEnvironment({ CHRONOLOG_SECRET_STORE: 'secret-service' }, 'linux'))
      .toBeInstanceOf(LinuxSecretServiceStore)
    expect(() => daemonSecretStoreFromEnvironment(
      { CHRONOLOG_SECRET_STORE: 'secret-service' },
      'darwin',
    )).toThrow('CHRONOLOG_SECRET_STORE_PLATFORM_UNSUPPORTED')
  })
})

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'chronolog-secret-store-'))
  directories.push(directory)
  return directory
}
