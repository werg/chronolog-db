import { StrictMode, createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it } from 'vitest'
import { StreamResource, type StreamSnapshot } from '@chronolog/client'
import { useStreamResource } from './hooks.js'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let count = 0; count < 100; count += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  throw new Error('Timed out waiting for condition')
}

describe('useStreamResource', () => {
  it('shares one stream across React Strict Mode subscribe cycles and stops on unmount', async () => {
    let opens = 0
    let closes = 0
    const resource = new StreamResource<string>({
      open: async function* (_cursor, signal) {
        opens += 1
        try {
          yield 'ready'
          await new Promise<void>((resolve) => {
            signal.addEventListener('abort', () => resolve(), { once: true })
          })
        } finally {
          closes += 1
        }
      },
      cursor: (value) => value,
      retryDelayMs: () => 0,
    })
    const observed: StreamSnapshot<string>[] = []
    function Probe() {
      observed.push(useStreamResource(resource))
      return null
    }

    let renderer: ReactTestRenderer | undefined
    await act(async () => {
      renderer = create(createElement(StrictMode, null, createElement(Probe)))
      await Promise.resolve()
    })
    await waitFor(() => resource.getSnapshot().status === 'ready')

    expect(opens).toBe(1)
    expect(observed.some((snapshot) => snapshot.value === 'ready')).toBe(true)

    await act(async () => {
      renderer?.unmount()
      await Promise.resolve()
    })
    await waitFor(() => closes === 1)
    expect(closes).toBe(1)
  })
})
