import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import type { Socket } from 'node:net'
import { timingSafeEqual } from 'node:crypto'

import type {
  ChronologRpcService,
  RpcCallContext,
  RpcCallOptions,
  RpcTransport,
  StreamRequest,
  StreamResponse,
  StreamRpcMethod,
  UnaryRequest,
  UnaryResponse,
  UnaryRpcMethod,
} from './contract.js'
import { ChronologRpcError, toChronologRpcError, type RpcErrorCode } from './errors.js'

const unaryDispatch: Record<UnaryRpcMethod, keyof ChronologRpcService> = {
  'node.getStatus': 'getStatus',
  'query.executeIr': 'executeIr',
  'query.localSql': 'localSql',
  'transaction.beginDraft': 'beginDraft',
  'transaction.observeIr': 'observeIr',
  'transaction.addAssertionIr': 'addAssertionIr',
  'transaction.addExpectation': 'addExpectation',
  'transaction.addMutationIr': 'addMutationIr',
  'transaction.validateDraft': 'validateDraft',
  'transaction.rebaseDraft': 'rebaseDraft',
  'transaction.cancelDraft': 'cancelDraft',
  'transaction.publishDraft': 'publishDraft',
  'transaction.getOutcome': 'getOutcome',
  'evidence.getSettlement': 'getSettlementEvidence',
  'evidence.getValidatorWatermark': 'getValidatorWatermark',
  'node.getReplicationStatus': 'getReplicationStatus',
}

const streamDispatch: Record<StreamRpcMethod, keyof ChronologRpcService> = {
  'node.streamStatus': 'streamStatus',
  'query.liveIr': 'liveIr',
  'transaction.streamOutcome': 'streamOutcome',
  'evidence.streamSettlement': 'streamSettlementEvidence',
  'node.streamReplicationStatus': 'streamReplicationStatus',
}

const unaryMethods = new Set<string>(Object.keys(unaryDispatch))
const streamMethods = new Set<string>(Object.keys(streamDispatch))

export interface HttpRpcServerOptions {
  readonly service: ChronologRpcService
  readonly host?: string
  readonly port?: number
  readonly token?: string
  readonly maxBodyBytes?: number
  /** Maximum wait for graceful connection drain before sockets are destroyed. */
  readonly shutdownTimeoutMs?: number
}

export interface HttpRpcServerAddress {
  readonly host: string
  readonly port: number
  readonly url: string
}

export class HttpRpcServer {
  readonly #options: HttpRpcServerOptions
  readonly #server: Server
  readonly #calls = new Set<AbortController>()
  readonly #sockets = new Set<Socket>()
  readonly #shutdownTimeoutMs: number
  #address: HttpRpcServerAddress | null = null
  #closing = false
  #closePromise: Promise<void> | undefined

  constructor(options: HttpRpcServerOptions) {
    this.#options = options
    this.#shutdownTimeoutMs = options.shutdownTimeoutMs ?? 5_000
    if (!Number.isSafeInteger(this.#shutdownTimeoutMs) || this.#shutdownTimeoutMs < 0) {
      throw new TypeError('shutdownTimeoutMs must be a non-negative safe integer')
    }
    this.#server = createServer((request, response) => {
      void this.#handle(request, response).catch((error) => writeError(response, error))
    })
    this.#server.on('connection', (socket) => {
      this.#sockets.add(socket)
      socket.once('close', () => this.#sockets.delete(socket))
    })
  }

  get address(): HttpRpcServerAddress | null { return this.#address }

  async listen(): Promise<HttpRpcServerAddress> {
    if (this.#address) return this.#address
    if (this.#closing) throw new ChronologRpcError('transport_unavailable', 'RPC server is closed')
    const host = this.#options.host ?? '127.0.0.1'
    const port = this.#options.port ?? 8787
    this.#server.listen(port, host)
    await once(this.#server, 'listening')
    const actual = this.#server.address()
    if (!actual || typeof actual === 'string') throw new Error('HTTP_RPC_ADDRESS_UNAVAILABLE')
    this.#address = { host, port: actual.port, url: `http://${host}:${actual.port}` }
    return this.#address
  }

  async close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise
    this.#closing = true
    for (const controller of this.#calls) controller.abort('RPC server is shutting down')
    if (!this.#server.listening) {
      this.#address = null
      return
    }
    this.#closePromise = this.#close()
    return this.#closePromise
  }

  async #close(): Promise<void> {
    const closed = once(this.#server, 'close').then(() => undefined)
    this.#server.close()
    this.#server.closeIdleConnections?.()
    const timeout = this.#shutdownTimeoutMs
    if (!await settlesWithin(closed, timeout)) {
      for (const socket of this.#sockets) socket.destroy()
      // Destroyed sockets normally close synchronously on the next turn. Do not
      // let a broken peer or handler make shutdown unbounded if they do not.
      await settlesWithin(closed, timeout)
    }
    this.#address = null
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (this.#closing) throw new ChronologRpcError('transport_unavailable', 'RPC server is shutting down', { retryable: true })
    if (request.method === 'GET' && request.url === '/health') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{"ok":true}')
      return
    }
    if (request.method !== 'POST' || request.url === undefined) throw new ChronologRpcError('not_found', 'RPC route not found')
    this.#authorize(request)
    const match = /^\/rpc\/(unary|stream)\/([^/?]+)$/u.exec(new URL(request.url, 'http://localhost').pathname)
    if (!match) throw new ChronologRpcError('not_found', 'RPC route not found')
    const mode = match[1]
    const method = decodeURIComponent(match[2] ?? '')
    const controller = new AbortController()
    const abortPeer = () => controller.abort('peer disconnected')
    const abortClosedResponse = () => {
      if (!response.writableFinished) abortPeer()
    }
    request.once('aborted', abortPeer)
    response.once('close', abortClosedResponse)
    request.socket.once('close', abortPeer)
    this.#calls.add(controller)
    try {
      const requestValue = decodeJson(await readBody(request, this.#options.maxBodyBytes ?? 4 * 1024 * 1024))
      const context: RpcCallContext = {
        method: method as UnaryRpcMethod,
        signal: controller.signal,
        ...(request.socket.remoteAddress === undefined ? {} : { peer: request.socket.remoteAddress }),
        ...(request.headers.authorization === undefined ? {} : { token: request.headers.authorization.replace(/^Bearer\s+/iu, '') }),
      }
      if (mode === 'unary') {
        if (!unaryMethods.has(method)) throw new ChronologRpcError('not_found', 'Unknown RPC method')
        const name = unaryDispatch[method as UnaryRpcMethod]
        const handler = this.#options.service[name] as unknown as (input: unknown, context: RpcCallContext) => Promise<unknown>
        const value = await handler.call(this.#options.service, requestValue, context)
        if (controller.signal.aborted || response.destroyed) return
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(encodeJson({ ok: true, value }))
        return
      }
      if (!streamMethods.has(method)) throw new ChronologRpcError('not_found', 'Unknown RPC method')
      const name = streamDispatch[method as StreamRpcMethod]
      const handler = this.#options.service[name] as unknown as (input: unknown, context: RpcCallContext) => AsyncIterable<unknown>
      const stream = handler.call(this.#options.service, requestValue, context)
      response.writeHead(200, {
        'content-type': 'application/x-ndjson',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      })
      for await (const value of stream) {
        if (controller.signal.aborted || response.destroyed) break
        if (!response.write(`${encodeJson({ ok: true, value })}\n`)) await waitForDrain(response, controller.signal)
      }
      if (!response.writableEnded && !response.destroyed) response.end()
    } catch (error) {
      if (!response.headersSent && !controller.signal.aborted) throw error
      if (!controller.signal.aborted && !response.writableEnded && !response.destroyed) {
        response.end(`${encodeJson(errorPayload(error))}\n`)
      }
    } finally {
      this.#calls.delete(controller)
      request.removeListener('aborted', abortPeer)
      response.removeListener('close', abortClosedResponse)
      request.socket.removeListener('close', abortPeer)
    }
  }

  #authorize(request: IncomingMessage): void {
    if (this.#options.token === undefined) return
    const provided = Buffer.from(request.headers.authorization ?? '')
    const expected = Buffer.from(`Bearer ${this.#options.token}`)
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      throw new ChronologRpcError('unauthenticated', 'Invalid RPC bearer token')
    }
  }
}

export interface HttpRpcTransportOptions {
  readonly baseUrl: string
  readonly token?: string
  readonly fetch?: typeof fetch
}

export class HttpRpcTransport implements RpcTransport {
  readonly #baseUrl: string
  readonly #token?: string
  readonly #fetch: typeof fetch
  #closed = false

  constructor(options: HttpRpcTransportOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/$/u, '')
    if (options.token !== undefined) this.#token = options.token
    this.#fetch = options.fetch ?? globalThis.fetch
  }

  async unary<M extends UnaryRpcMethod>(method: M, request: UnaryRequest<M>, options: RpcCallOptions = {}): Promise<UnaryResponse<M>> {
    this.#assertOpen()
    const { signal, cancel } = combinedSignal(options)
    try {
      const response = await this.#fetch(`${this.#baseUrl}/rpc/unary/${encodeURIComponent(method)}`, {
        method: 'POST',
        headers: this.#headers(options),
        body: encodeJson(request),
        signal,
      })
      const payload = decodeJson(await response.text()) as RpcPayload<UnaryResponse<M>>
      if (!payload.ok) throw fromErrorPayload(payload)
      return payload.value
    } catch (error) {
      throw networkError(error)
    } finally {
      cancel()
    }
  }

  stream<M extends StreamRpcMethod>(method: M, request: StreamRequest<M>, options: RpcCallOptions = {}): AsyncIterable<StreamResponse<M>> {
    const self = this
    return {
      async *[Symbol.asyncIterator]() {
        self.#assertOpen()
        const { signal, cancel } = combinedSignal(options)
        try {
          const response = await self.#fetch(`${self.#baseUrl}/rpc/stream/${encodeURIComponent(method)}`, {
            method: 'POST',
            headers: self.#headers(options),
            body: encodeJson(request),
            signal,
          })
          if (!response.body) throw new ChronologRpcError('transport_unavailable', 'RPC stream has no response body')
          if (!response.ok) {
            const payload = decodeJson(await response.text()) as RpcPayload<never>
            throw payload.ok ? new ChronologRpcError('internal', 'Invalid RPC error response') : fromErrorPayload(payload)
          }
          for await (const line of lines(response.body)) {
            if (line.length === 0) continue
            const payload = decodeJson(line) as RpcPayload<StreamResponse<M>>
            if (!payload.ok) throw fromErrorPayload(payload)
            yield payload.value
          }
        } catch (error) {
          throw networkError(error)
        } finally {
          cancel()
        }
      },
    }
  }

  async close(): Promise<void> { this.#closed = true }

  #headers(options: RpcCallOptions): Record<string, string> {
    const token = options.token ?? this.#token
    return {
      'content-type': 'application/json',
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new ChronologRpcError('transport_unavailable', 'RPC transport is closed')
  }
}

type RpcPayload<T> = { readonly ok: true; readonly value: T } | {
  readonly ok: false
  readonly error: { readonly code: RpcErrorCode; readonly message: string; readonly retryable: boolean; readonly details?: Readonly<Record<string, string>> }
}

function errorPayload(error: unknown): RpcPayload<never> {
  const normalized = toChronologRpcError(error)
  return {
    ok: false,
    error: {
      code: normalized.code,
      message: normalized.message,
      retryable: normalized.retryable,
      ...(normalized.details === undefined ? {} : { details: normalized.details }),
    },
  }
}

function fromErrorPayload(payload: Extract<RpcPayload<never>, { ok: false }>): ChronologRpcError {
  return new ChronologRpcError(payload.error.code, payload.error.message, {
    retryable: payload.error.retryable,
    ...(payload.error.details === undefined ? {} : { details: payload.error.details }),
  })
}

function writeError(response: ServerResponse, error: unknown): void {
  if (response.writableEnded || response.destroyed) return
  const normalized = toChronologRpcError(error)
  const status = normalized.code === 'unauthenticated' ? 401 : normalized.code === 'not_found' ? 404 : 400
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(encodeJson(errorPayload(normalized)))
}

function waitForDrain(response: ServerResponse, signal: AbortSignal): Promise<void> {
  if (signal.aborted || response.destroyed) return Promise.reject(signal.reason)
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      response.removeListener('drain', drained)
      response.removeListener('close', closed)
      response.removeListener('error', failed)
      signal.removeEventListener('abort', aborted)
    }
    const drained = () => { cleanup(); resolve() }
    const closed = () => { cleanup(); reject(new ChronologRpcError('cancelled', 'RPC peer disconnected')) }
    const failed = (error: Error) => { cleanup(); reject(error) }
    const aborted = () => { cleanup(); reject(signal.reason) }
    response.once('drain', drained)
    response.once('close', closed)
    response.once('error', failed)
    signal.addEventListener('abort', aborted, { once: true })
  })
}

async function settlesWithin(promise: Promise<void>, milliseconds: number): Promise<boolean> {
  if (milliseconds === 0) return false
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<false>((resolve) => { timeout = setTimeout(() => resolve(false), milliseconds) }),
    ])
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
  }
}

async function readBody(request: IncomingMessage, maximum: number): Promise<string> {
  const chunks: Buffer[] = []
  let length = 0
  for await (const value of request) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array)
    length += chunk.length
    if (length > maximum) throw new ChronologRpcError('resource_exhausted', 'RPC request body is too large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function encodeJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item instanceof Uint8Array ? { $chronologBytes: Buffer.from(item).toString('base64') } : item)
}

function decodeJson(value: string): unknown {
  return JSON.parse(value, (_key, item: unknown) => {
    if (
      typeof item === 'object' && item !== null &&
      Object.keys(item).length === 1 && '$chronologBytes' in item &&
      typeof (item as { $chronologBytes?: unknown }).$chronologBytes === 'string'
    ) return Uint8Array.from(Buffer.from((item as { $chronologBytes: string }).$chronologBytes, 'base64'))
    return item
  })
}

async function* lines(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffered = ''
  try {
    while (true) {
      const result = await reader.read()
      if (result.done) break
      buffered += decoder.decode(result.value, { stream: true })
      let newline: number
      while ((newline = buffered.indexOf('\n')) >= 0) {
        yield buffered.slice(0, newline)
        buffered = buffered.slice(newline + 1)
      }
    }
    buffered += decoder.decode()
    if (buffered.length > 0) yield buffered
  } finally {
    reader.releaseLock()
  }
}

function combinedSignal(options: RpcCallOptions): { readonly signal: AbortSignal; readonly cancel: () => void } {
  const controller = new AbortController()
  const abort = () => controller.abort(options.signal?.reason)
  options.signal?.addEventListener('abort', abort, { once: true })
  const timeout = options.timeoutMs === undefined ? undefined : setTimeout(() => controller.abort('deadline'), options.timeoutMs)
  return {
    signal: controller.signal,
    cancel: () => {
      if (timeout !== undefined) clearTimeout(timeout)
      options.signal?.removeEventListener('abort', abort)
    },
  }
}

function networkError(error: unknown): ChronologRpcError {
  if (error instanceof ChronologRpcError) return error
  if (error instanceof DOMException && error.name === 'AbortError') return new ChronologRpcError('cancelled', 'RPC request was cancelled', { cause: error })
  return new ChronologRpcError('transport_unavailable', error instanceof Error ? error.message : 'RPC network error', { cause: error })
}
