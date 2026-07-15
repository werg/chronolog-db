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
import { ChronologRpcError, toChronologRpcError } from './errors.js'

type AnyRequest = UnaryRequest<UnaryRpcMethod> | StreamRequest<StreamRpcMethod>

export type RpcInterceptor = <T>(
  request: AnyRequest,
  context: RpcCallContext,
  next: () => Promise<T>,
) => Promise<T>

const unaryDispatch: {
  [M in UnaryRpcMethod]: keyof ChronologRpcService
} = {
  'node.getStatus': 'getStatus',
  'query.localSql': 'localSql',
  'transaction.beginDraft': 'beginDraft',
  'transaction.observeSql': 'observeSql',
  'transaction.addPrecondition': 'addPrecondition',
  'transaction.addStatements': 'addStatements',
  'transaction.replaceStatements': 'replaceStatements',
  'transaction.validateDraft': 'validateDraft',
  'transaction.rebaseDraft': 'rebaseDraft',
  'transaction.cancelDraft': 'cancelDraft',
  'transaction.publishDraft': 'publishDraft',
  'transaction.getOutcome': 'getOutcome',
  'transaction.getResult': 'getTransactionResult',
  'evidence.getSettlement': 'getSettlementEvidence',
  'evidence.getValidatorWatermark': 'getValidatorWatermark',
  'node.getReplicationStatus': 'getReplicationStatus',
}

const streamDispatch: {
  [M in StreamRpcMethod]: keyof ChronologRpcService
} = {
  'node.streamStatus': 'streamStatus',
  'query.liveSql': 'liveSql',
  'transaction.streamOutcome': 'streamOutcome',
  'evidence.streamSettlement': 'streamSettlementEvidence',
  'node.streamReplicationStatus': 'streamReplicationStatus',
}

function contextFor(method: UnaryRpcMethod | StreamRpcMethod, options: RpcCallOptions): RpcCallContext {
  return { ...options, method, peer: 'in-process' }
}

function assertOpen(closed: boolean): void {
  if (closed) throw new ChronologRpcError('transport_unavailable', 'RPC transport is closed')
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) {
    throw new ChronologRpcError('cancelled', 'RPC call was cancelled', { cause: signal.reason })
  }
}

/** A zero-serialization adapter used by an embedded daemon and deterministic tests. */
export class InProcessRpcTransport implements RpcTransport {
  readonly #service: ChronologRpcService
  readonly #interceptors: readonly RpcInterceptor[]
  #closed = false

  constructor(service: ChronologRpcService, interceptors: readonly RpcInterceptor[] = []) {
    this.#service = service
    this.#interceptors = interceptors
  }

  async unary<M extends UnaryRpcMethod>(
    method: M,
    request: UnaryRequest<M>,
    options: RpcCallOptions = {},
  ): Promise<UnaryResponse<M>> {
    assertOpen(this.#closed)
    throwIfAborted(options.signal)
    const input = copyRpcValue(request)
    const context = contextFor(method, options)
    const invoke = async (): Promise<UnaryResponse<M>> => {
      const service = this.#service as unknown as Record<
        string,
        (request: UnaryRequest<M>, context: RpcCallContext) => Promise<UnaryResponse<M>>
      >
      const name = unaryDispatch[method]
      const handler = service[name]
      if (handler === undefined) {
        throw new ChronologRpcError('internal', `Missing RPC handler ${String(name)}`)
      }
      return copyRpcValue(await handler.call(this.#service, input, context))
    }

    let chain = invoke
    for (const interceptor of [...this.#interceptors].reverse()) {
      const next = chain
      chain = () => interceptor(input, context, next)
    }

    try {
      return await withDeadline(chain(), options.timeoutMs, options.signal)
    } catch (error) {
      throw toChronologRpcError(error)
    }
  }

  stream<M extends StreamRpcMethod>(
    method: M,
    request: StreamRequest<M>,
    options: RpcCallOptions = {},
  ): AsyncIterable<StreamResponse<M>> {
    const self = this
    return {
      async *[Symbol.asyncIterator]() {
        assertOpen(self.#closed)
        throwIfAborted(options.signal)
        const input = copyRpcValue(request)
        const context = contextFor(method, options)
        const service = self.#service as unknown as Record<
          string,
          (
            request: StreamRequest<M>,
            context: RpcCallContext,
          ) => AsyncIterable<StreamResponse<M>>
        >
        const name = streamDispatch[method]
        const handler = service[name]
        if (handler === undefined) {
          throw new ChronologRpcError('internal', `Missing RPC handler ${String(name)}`)
        }
        try {
          const invoke = async () => handler.call(self.#service, input, context)
          let chain = invoke
          for (const interceptor of [...self.#interceptors].reverse()) {
            const next = chain
          chain = () => interceptor(input, context, next)
          }
          const source = await chain()
          const iterator = source[Symbol.asyncIterator]()
          try {
            while (true) {
              const result = await nextOrAbort(iterator, options.signal)
              if (result.done) break
              yield copyRpcValue(result.value)
            }
          } finally {
            void iterator.return?.().catch(() => undefined)
          }
        } catch (error) {
          throw toChronologRpcError(error)
        }
      },
    }
  }

  async close(): Promise<void> {
    this.#closed = true
  }
}

function copyRpcValue<T>(value: T): T {
  if (value instanceof Uint8Array) return Uint8Array.from(value) as T
  if (Array.isArray(value)) return value.map(copyRpcValue) as T
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, copyRpcValue(item)]),
    ) as T
  }
  return value
}

async function nextOrAbort<T>(
  iterator: AsyncIterator<T>,
  signal: AbortSignal | undefined,
): Promise<IteratorResult<T>> {
  if (signal === undefined) return iterator.next()
  throwIfAborted(signal)
  return new Promise<IteratorResult<T>>((resolve, reject) => {
    const abort = () => reject(new ChronologRpcError('cancelled', 'RPC stream was cancelled'))
    signal.addEventListener('abort', abort, { once: true })
    iterator.next().then(
      (result) => {
        signal.removeEventListener('abort', abort)
        resolve(result)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort)
        reject(error)
      },
    )
  })
}

async function withDeadline<T>(
  promise: Promise<T>,
  timeoutMs: number | undefined,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (timeoutMs === undefined && signal === undefined) return promise

  const controller = new AbortController()
  const abort = () => controller.abort(signal?.reason)
  signal?.addEventListener('abort', abort, { once: true })
  let timeout: ReturnType<typeof setTimeout> | undefined
  if (timeoutMs !== undefined) timeout = setTimeout(() => controller.abort('deadline'), timeoutMs)

  const aborted = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener(
      'abort',
      () => {
        const deadline = controller.signal.reason === 'deadline'
        reject(
          new ChronologRpcError(
            deadline ? 'deadline_exceeded' : 'cancelled',
            deadline ? 'RPC deadline exceeded' : 'RPC call was cancelled',
          ),
        )
      },
      { once: true },
    )
  })

  try {
    return await Promise.race([promise, aborted])
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
    signal?.removeEventListener('abort', abort)
  }
}
