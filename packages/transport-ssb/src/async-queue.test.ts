import { describe, expect, it } from 'vitest'

import { AsyncQueue } from './async-queue.js'

describe('AsyncQueue', () => {
  it('fails loudly instead of growing beyond its configured capacity', async () => {
    const queue = new AsyncQueue<number>(2)
    expect(queue.push(1)).toBe(true)
    expect(queue.push(2)).toBe(true)
    expect(queue.push(3)).toBe(false)

    const iterator = queue[Symbol.asyncIterator]()
    await expect(iterator.next()).rejects.toThrow('ASYNC_QUEUE_OVERFLOW')
  })
})
