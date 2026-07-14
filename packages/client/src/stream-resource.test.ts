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
})
