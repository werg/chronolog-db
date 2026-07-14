import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { ControlStore } from './control-store.js'
import { JsonFileControlStorePersistence } from './persistence.js'

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('JsonFileControlStorePersistence', () => {
  it('coalesces rebuildable snapshots and flushes the latest state on demand', () => {
    const directory = mkdtempSync(join(tmpdir(), 'chronolog-control-persistence-'))
    directories.push(directory)
    const path = join(directory, 'control.json')
    const store = new ControlStore(new JsonFileControlStorePersistence(path))
    for (let id = 1; id <= 20; id += 1) {
      store.putCandidate({
        txId: Uint8Array.of(id),
        groupId: Uint8Array.of(1),
        candidateDigest: Uint8Array.of(100 + id),
        validationPolicy: Uint8Array.of(2),
        orderKey: {
          authorTimestampMs: BigInt(id),
          authorId: Uint8Array.of(3),
          authorFeedSequence: BigInt(id),
          txId: Uint8Array.of(id),
        },
        canonicalPayload: Uint8Array.of(4, id),
        state: 'pending_validation',
      })
    }
    expect(existsSync(path)).toBe(false)

    store.flush()
    const restored = new ControlStore(new JsonFileControlStorePersistence(path))
    expect(restored.listCandidates()).toHaveLength(20)
    expect(restored.sequence).toBe(store.sequence)
  })
})
