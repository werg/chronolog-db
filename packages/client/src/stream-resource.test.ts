import { ChronologRpcError } from '@chronolog/rpc'
import { describe, expect, it } from 'vitest'

import { StreamResource } from './stream-resource.js'

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let count = 0; count < 100; count += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  throw new Error('Timed out waiting for condition')
}

describe('StreamResource retry lifecycle', () => {
  it('notifies an owner exactly once when disposed', () => {
    const resource = new StreamResource<number>({ open: async function* () {}, cursor: String })
    let disposals = 0
    resource.onDispose(() => { disposals += 1 })
    resource.dispose()
    resource.dispose()
    expect(disposals).toBe(1)
  })

  it('latches non-retryable errors until explicitly restarted', async () => {
    let opens = 0
    const resource = new StreamResource<string>({
      open: async function* () {
        opens += 1
        throw new ChronologRpcError('permission_denied', 'denied')
      },
      cursor: (value) => value,
      retryDelayMs: () => 0,
    })
    const unsubscribe = resource.subscribe(() => undefined)
    await waitFor(() => resource.getSnapshot().status === 'error')
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(opens).toBe(1)
    resource.restart()
    await waitFor(() => opens === 2 && resource.getSnapshot().status === 'error')
    unsubscribe()
    resource.dispose()
  })

  it('does not let an aborted run clear and duplicate its manual replacement', async () => {
    let opens = 0
    let active = 0
    const resource = new StreamResource<number>({
      open: async function* (_cursor, signal) {
        opens += 1
        active += 1
        try {
          await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
        } finally {
          active -= 1
        }
      },
      cursor: String,
    })
    const unsubscribe = resource.subscribe(() => undefined)
    await waitFor(() => opens === 1 && active === 1)
    resource.restart()
    await waitFor(() => opens === 2 && active === 1)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(opens).toBe(2)
    unsubscribe()
    resource.dispose()
  })

  it('ends iteration immediately when already disposed', async () => {
    const resource = new StreamResource<number>({ open: async function* () {}, cursor: String })
    resource.dispose()
    await expect(resource[Symbol.asyncIterator]().next()).resolves.toEqual({ done: true, value: undefined })
  })

  it('coalesces pending iterator values to the latest stream revision', async () => {
    const waiting: Array<(value: number) => void> = []
    const resource = new StreamResource<number>({
      open: async function* (_cursor, signal) {
        while (!signal.aborted) {
          const value = await new Promise<number>((resolve) => waiting.push(resolve))
          if (!signal.aborted) yield value
        }
      },
      cursor: String,
    })
    const iterator = resource[Symbol.asyncIterator]()
    const first = iterator.next()
    await waitFor(() => waiting.length === 1)
    waiting.shift()?.(1)
    await expect(first).resolves.toMatchObject({ done: false, value: 1 })

    await waitFor(() => waiting.length === 1)
    waiting.shift()?.(2)
    await waitFor(() => resource.getSnapshot().value === 2 && waiting.length === 1)
    waiting.shift()?.(3)
    await waitFor(() => resource.getSnapshot().value === 3)
    await expect(iterator.next()).resolves.toMatchObject({ done: false, value: 3 })

    resource.dispose()
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined })
  })
})
