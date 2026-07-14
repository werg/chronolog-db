import { StrictMode, createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it } from 'vitest'
import { StreamResource, type ChronologClient, type NodeStatus, type StreamSnapshot } from '@chronolog/client'
import { useChronologStatus, useStreamResource } from './hooks.js'

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

  it('disposes hook-owned resources when replaced or unmounted', async () => {
    const resources: StreamResource<NodeStatus>[] = []
    const snapshots: StreamSnapshot<NodeStatus>[] = []
    const client = {
      status() {
        const resource = new StreamResource<NodeStatus>({
          open: async function* () {},
          cursor: () => undefined,
          initial: {
            apiVersion: 'chronolog.rpc', state: 'ready', nodeId: `node-${resources.length}`,
            writable: true, validating: false,
          },
        })
        resources.push(resource)
        return resource
      },
    } as unknown as ChronologClient
    function Probe({ enabled }: { readonly enabled: boolean }) {
      snapshots.push(useChronologStatus({ client, enabled }))
      return null
    }

    let renderer: ReactTestRenderer | undefined
    await act(async () => { renderer = create(createElement(StrictMode, null, createElement(Probe, { enabled: true }))) })
    expect(resources.filter((resource) => resource.getSnapshot().status !== 'closed')).toHaveLength(1)
    await act(async () => { renderer?.update(createElement(StrictMode, null, createElement(Probe, { enabled: false }))) })
    expect(resources.every((resource) => resource.getSnapshot().status === 'closed')).toBe(true)
    expect(snapshots.at(-1)?.value).toBeUndefined()
    await act(async () => { renderer?.update(createElement(StrictMode, null, createElement(Probe, { enabled: true }))) })
    expect(resources.filter((resource) => resource.getSnapshot().status !== 'closed')).toHaveLength(1)
    await act(async () => { renderer?.unmount() })
    expect(resources.every((resource) => resource.getSnapshot().status === 'closed')).toBe(true)
  })
})
