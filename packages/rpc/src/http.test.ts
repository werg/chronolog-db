import { describe, expect, it } from 'vitest'

import type { ChronologRpcService, RpcCallContext } from './contract.js'
import { HttpRpcServer } from './http.js'

function serviceWithStatusStream(
  stream: (context: RpcCallContext) => AsyncIterable<unknown>,
): ChronologRpcService {
  return {
    streamStatus(_request: unknown, context: RpcCallContext) { return stream(context) },
  } as unknown as ChronologRpcService
}

async function openStatusStream(url: string): Promise<Response> {
  return fetch(`${url}/rpc/stream/node.streamStatus`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
}

describe('HttpRpcServer lifecycle', () => {
  it('serves detailed health and authenticated Prometheus metrics', async () => {
    const server = new HttpRpcServer({
      service: {} as ChronologRpcService,
      port: 0,
      token: 'metrics-secret',
      health: () => ({ ok: false, state: 'degraded' }),
      metrics: () => 'chronolog_up 0\n',
    })
    const address = await server.listen()
    try {
      const health = await fetch(`${address.url}/health`)
      expect(health.status).toBe(503)
      await expect(health.json()).resolves.toEqual({ ok: false, state: 'degraded' })
      expect((await fetch(`${address.url}/metrics`)).status).toBe(401)
      const metrics = await fetch(`${address.url}/metrics`, {
        headers: { authorization: 'Bearer metrics-secret' },
      })
      expect(metrics.status).toBe(200)
      await expect(metrics.text()).resolves.toBe('chronolog_up 0\n')
    } finally {
      await server.close()
    }
  })

  it('aborts active streams before waiting for graceful shutdown', async () => {
    let aborted = false
    const service = serviceWithStatusStream(async function* (context) {
      yield { revision: '1' }
      await new Promise<void>((resolve) => context.signal?.addEventListener('abort', () => {
        aborted = true
        resolve()
      }, { once: true }))
    })
    const server = new HttpRpcServer({ service, port: 0, shutdownTimeoutMs: 100 })
    const address = await server.listen()
    const response = await openStatusStream(address.url)
    const reader = response.body!.getReader()
    await reader.read()

    await server.close()

    expect(aborted).toBe(true)
    expect(server.address).toBeNull()
    reader.releaseLock()
  })

  it('aborts a call when the peer cancels the response body', async () => {
    let resolveAbort: (() => void) | undefined
    const aborted = new Promise<void>((resolve) => { resolveAbort = resolve })
    const service = serviceWithStatusStream(async function* (context) {
      context.signal?.addEventListener('abort', () => resolveAbort?.(), { once: true })
      yield { revision: '1' }
      await new Promise<void>((resolve) => context.signal?.addEventListener('abort', () => resolve(), { once: true }))
    })
    const server = new HttpRpcServer({ service, port: 0, shutdownTimeoutMs: 100 })
    const address = await server.listen()
    const response = await openStatusStream(address.url)
    const reader = response.body!.getReader()
    await reader.read()
    await reader.cancel()

    await expect(aborted).resolves.toBeUndefined()
    await server.close()
  })

  it('bounds shutdown even when a stream handler ignores cancellation', async () => {
    let release: (() => void) | undefined
    const blocked = new Promise<void>((resolve) => { release = resolve })
    const service = serviceWithStatusStream(async function* () {
      yield { revision: '1' }
      await blocked
    })
    const server = new HttpRpcServer({ service, port: 0, shutdownTimeoutMs: 10 })
    const address = await server.listen()
    const response = await openStatusStream(address.url)
    const reader = response.body!.getReader()
    await reader.read()

    const started = performance.now()
    await server.close()
    expect(performance.now() - started).toBeLessThan(250)

    release?.()
    reader.releaseLock()
  })
})
