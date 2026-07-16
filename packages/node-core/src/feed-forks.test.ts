import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { FeedForkRegistry, JsonFeedForkPersistence } from './feed-forks.js'

const directories: string[] = []
afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })))

describe('feed fork quarantine and repair', () => {
  it('persists quarantine when one author sequence has divergent identities', () => {
    const directory = mkdtempSync(join(tmpdir(), 'chronolog-feed-fork-'))
    directories.push(directory)
    const path = join(directory, 'continuity.json')
    const registry = new FeedForkRegistry(new JsonFeedForkPersistence(path))
    expect(registry.observe(record(1n, 'first'))).toBe('accepted')
    expect(registry.observe(record(2n, 'left', 'first'))).toBe('accepted')
    expect(registry.observe(record(2n, 'right', 'first'))).toBe('quarantined')
    expect(registry.quarantined('@writer.ed25519')).toBe(true)
    expect(registry.quarantineEvidence()).toMatchObject([{
      feedId: '@writer.ed25519', sequence: '2', acceptedId: 'left', conflictingId: 'right',
    }])
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ format: 'chronolog-feed-continuity-v1' })
    expect(new FeedForkRegistry(new JsonFeedForkPersistence(path)).quarantined()).toBe(true)
  })

  it('requires a complete trusted prefix before clearing quarantine', () => {
    const registry = new FeedForkRegistry()
    registry.observe(record(1n, 'first'))
    registry.observe(record(2n, 'left', 'first'))
    registry.observe(record(2n, 'right', 'first'))
    expect(() => registry.createRepairPlan('@writer.ed25519', [record(2n, 'right', 'first')], 'right'))
      .toThrow('FEED_REPAIR_PREFIX_INCOMPLETE')
    const trusted = [record(1n, 'first'), record(2n, 'right', 'first')]
    registry.applyRepair(registry.createRepairPlan('@writer.ed25519', trusted, 'right'))
    expect(registry.quarantined()).toBe(false)
    expect(registry.observe(record(2n, 'left', 'first'))).toBe('discarded')
    expect(registry.observe(record(3n, 'third', 'right'))).toBe('accepted')
  })
})

function record(sequence: bigint, id: string, previous?: string) {
  return {
    author: '@writer.ed25519',
    sequence,
    id,
    ...(previous === undefined ? {} : { previous }),
    receivedAtMs: 100,
    payload: new Uint8Array(),
  }
}
