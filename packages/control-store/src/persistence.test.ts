import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { ControlStore } from './control-store.js'
import { JsonFileControlStorePersistence, MemoryControlStorePersistence } from './persistence.js'

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

  it('persists validator cutoff signing state synchronously', () => {
    const directory = mkdtempSync(join(tmpdir(), 'chronolog-cutoff-persistence-'))
    directories.push(directory)
    const path = join(directory, 'control.json')
    const store = new ControlStore(new JsonFileControlStorePersistence(path))

    store.persistValidatorCutoff(Uint8Array.of(7), 123n)

    expect(existsSync(path)).toBe(false)
    expect(existsSync(`${path}.validator-cutoffs`)).toBe(true)
    const restored = new ControlStore(new JsonFileControlStorePersistence(path))
    expect(restored.validatorCutoff(Uint8Array.of(7))).toBe(123n)
  })

  it('preserves a persisted but unpublished cutoff when the rebuildable snapshot is corrupt', () => {
    const directory = mkdtempSync(join(tmpdir(), 'chronolog-cutoff-recovery-'))
    directories.push(directory)
    const path = join(directory, 'control.json')
    const validatorId = Uint8Array.of(7)
    const store = new ControlStore(new JsonFileControlStorePersistence(path))
    store.persistValidatorCutoff(validatorId, 500n)
    // Simulate a crash after the cutoff journal commit but before publishing
    // an attestation/heartbeat, followed by damage to the rebuildable index.
    writeFileSync(path, '{corrupt rebuildable snapshot', 'utf8')

    const restored = new ControlStore(new JsonFileControlStorePersistence(path))

    expect(restored.validatorCutoff(validatorId)).toBe(500n)
    expect(restored.sequence).toBe(0n)
    expect(readdirSync(directory).some((name) => name.startsWith('control.json.corrupt-'))).toBe(true)
  })

  it('migrates a higher legacy snapshot cutoff into the independent journal', () => {
    const directory = mkdtempSync(join(tmpdir(), 'chronolog-cutoff-migration-'))
    directories.push(directory)
    const path = join(directory, 'control.json')
    const validatorId = Uint8Array.of(8)
    const persistence = new JsonFileControlStorePersistence(path)
    new ControlStore(persistence) // establishes an empty v1 cutoff journal
    const legacy = new ControlStore()
    legacy.persistValidatorCutoff(validatorId, 700n)
    persistence.save(legacy.snapshot())

    expect(new ControlStore(new JsonFileControlStorePersistence(path)).validatorCutoff(validatorId)).toBe(700n)
    writeFileSync(path, '{corrupt after migration', 'utf8')
    expect(new ControlStore(new JsonFileControlStorePersistence(path)).validatorCutoff(validatorId)).toBe(700n)
  })

  it('rolls back an in-memory cutoff when its durable write fails so it can be retried', () => {
    const delegate = new MemoryControlStorePersistence()
    let fail = true
    const store = new ControlStore({
      load: () => delegate.load(),
      save: (snapshot) => {
        if (fail) throw new Error('DISK_TEMPORARILY_UNAVAILABLE')
        delegate.save(snapshot)
      },
    })

    expect(() => store.persistValidatorCutoff(Uint8Array.of(7), 123n)).toThrow(
      'DISK_TEMPORARILY_UNAVAILABLE',
    )
    expect(store.validatorCutoff(Uint8Array.of(7))).toBeNull()
    fail = false
    store.persistValidatorCutoff(Uint8Array.of(7), 123n)
    expect(new ControlStore(delegate).validatorCutoff(Uint8Array.of(7))).toBe(123n)
  })

  it('quarantines corrupt rebuildable snapshots and starts from an empty index', () => {
    const directory = mkdtempSync(join(tmpdir(), 'chronolog-corrupt-persistence-'))
    directories.push(directory)
    const path = join(directory, 'control.json')
    new ControlStore(new JsonFileControlStorePersistence(path))
    writeFileSync(path, '{invalid json', 'utf8')

    const store = new ControlStore(new JsonFileControlStorePersistence(path))

    expect(store.sequence).toBe(0n)
    expect(existsSync(path)).toBe(false)
    expect(readdirSync(directory).some((name) => name.startsWith('control.json.corrupt-'))).toBe(true)
  })

  it('quarantines structurally invalid snapshots discovered during restoration', () => {
    const directory = mkdtempSync(join(tmpdir(), 'chronolog-structural-persistence-'))
    directories.push(directory)
    const path = join(directory, 'control.json')
    new ControlStore(new JsonFileControlStorePersistence(path))
    writeFileSync(path, JSON.stringify({ format: 'chronolog-control-store/v1' }), 'utf8')

    const store = new ControlStore(new JsonFileControlStorePersistence(path))

    expect(store.listCandidates()).toEqual([])
    expect(readdirSync(directory).some((name) => name.startsWith('control.json.corrupt-'))).toBe(true)
  })

  it('fails closed when a corrupt legacy snapshot has no cutoff journal', () => {
    const directory = mkdtempSync(join(tmpdir(), 'chronolog-missing-cutoff-journal-'))
    directories.push(directory)
    const path = join(directory, 'control.json')
    writeFileSync(path, '{invalid json', 'utf8')

    expect(() => new ControlStore(new JsonFileControlStorePersistence(path))).toThrow(
      'CONTROL_STORE_CUTOFF_JOURNAL_MISSING',
    )
    expect(existsSync(path)).toBe(true)
  })
})
