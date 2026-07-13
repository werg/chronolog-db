import { describe, expect, it } from 'vitest'

import { IdempotencyMap, Mutex, RevisionBroadcaster } from './async.js'

describe('node async primitives', () => {
  it('serializes critical sections', async () => {
    const mutex = new Mutex()
    const trace: number[] = []
    await Promise.all([
      mutex.run(async () => {
        trace.push(1)
        await Promise.resolve()
        trace.push(2)
      }),
      mutex.run(() => { trace.push(3) }),
    ])
    expect(trace).toEqual([1, 2, 3])
  })

  it('replays and broadcasts revisions', async () => {
    const broadcaster = new RevisionBroadcaster('r1')
    const iterator = broadcaster.subscribe()[Symbol.asyncIterator]()
    expect((await iterator.next()).value).toBe('r1')
    broadcaster.emit('r2')
    expect((await iterator.next()).value).toBe('r2')
    await iterator.return?.()
  })

  it('deduplicates idempotent values', () => {
    const map = new IdempotencyMap<object>()
    const first = map.getOrCreate('request', () => ({}))
    expect(map.getOrCreate('request', () => ({}))).toBe(first)
  })
})
