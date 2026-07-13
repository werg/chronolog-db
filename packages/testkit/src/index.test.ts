import { describe, expect, it } from 'vitest'

import { ManualClock, permutations, waitFor } from './index.js'

describe('testkit', () => {
  it('provides a monotonic manual clock', () => {
    const clock = new ManualClock(10)
    expect(clock.advance(5)).toBe(15n)
    expect(() => clock.set(14)).toThrow(/backwards/)
  })

  it('generates delivery permutations', () => {
    expect(permutations([1, 2, 3])).toHaveLength(6)
  })

  it('waits for asynchronous state', async () => {
    let ready = false
    queueMicrotask(() => { ready = true })
    await waitFor(() => ready)
  })
})
