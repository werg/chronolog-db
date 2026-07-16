import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { generateEd25519KeyPair } from '@chronolog/protocol'
import { afterEach, describe, expect, it } from 'vitest'

import { loadOrCreateGovernanceBootstrap } from './governance-config.js'

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
    expect(second.recoveryPrivateKeysPkcs8.every((key) => key.length > 0)).toBe(true)
  })
})

function bytes32(seed: number): Uint8Array {
  return Uint8Array.from({ length: 32 }, (_value, index) => (seed + index) & 0xff)
}
