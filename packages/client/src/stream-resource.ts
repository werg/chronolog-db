import { ChronologRpcError, isChronologRpcError } from '@chronolog/rpc'

export type StreamResourceStatus =
  | 'idle'
  | 'connecting'
  | 'ready'
  | 'disconnected'
  | 'error'
  | 'closed'

export interface StreamSnapshot<T> {
  readonly status: StreamResourceStatus
  readonly value?: T
  readonly error?: unknown
  readonly reconnectAttempt: number
}

export interface StreamResourceOptions<T> {
  readonly open: (cursor: string | undefined, signal: AbortSignal) => AsyncIterable<T>
  readonly cursor: (value: T) => string | undefined
  readonly initial?: T
  readonly retry?: (error: unknown, attempt: number) => boolean
  readonly retryDelayMs?: (attempt: number) => number
}

export type StreamListener = () => void

const defaultRetry = (error: unknown): boolean =>
  isChronologRpcError(error) ? error.retryable : false

const defaultDelay = (attempt: number): number => Math.min(250 * 2 ** Math.min(attempt, 5), 5_000)

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timeout)
      reject(signal.reason)
    }
    const timeout = setTimeout(() => {
      signal.removeEventListener('abort', abort)
      resolve()
    }, milliseconds)
    signal.addEventListener('abort', abort, { once: true })
  })
}

/**
 * A lazy, shared external store over a resumable RPC stream. It is usable from
 * plain TypeScript, async iteration, and React's useSyncExternalStore.
 */
export class StreamResource<T> implements AsyncIterable<T> {
  readonly #options: StreamResourceOptions<T>
  readonly #listeners = new Set<StreamListener>()
  readonly #valueListeners = new Set<(value: T) => void>()
  readonly #disposeListeners = new Set<() => void>()
  #snapshot: StreamSnapshot<T>
  #controller: AbortController | undefined
  #run: Promise<void> | undefined
  #cursor: string | undefined
  #disposed = false
  #terminal = false

  constructor(options: StreamResourceOptions<T>) {
    this.#options = options
    this.#snapshot =
      options.initial === undefined
        ? { status: 'idle', reconnectAttempt: 0 }
        : { status: 'idle', value: options.initial, reconnectAttempt: 0 }
  }

  getSnapshot = (): StreamSnapshot<T> => this.#snapshot

  subscribe = (listener: StreamListener): (() => void) => {
    if (this.#disposed) return () => undefined
    this.#listeners.add(listener)
    this.#start()
    return () => {
      this.#listeners.delete(listener)
      this.#scheduleStopWhenUnused()
    }
  }

  restart(): void {
    if (this.#disposed) return
    this.#terminal = false
    this.#controller?.abort('manual restart')
    this.#controller = undefined
    this.#run = undefined
    this.#publish(this.#withPrevious('connecting', 0))
    this.#start()
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#controller?.abort('resource disposed')
    this.#publish(this.#withPrevious('closed', 0))
    this.#listeners.clear()
    this.#valueListeners.clear()
    for (const listener of this.#disposeListeners) listener()
    this.#disposeListeners.clear()
  }

  onDispose(listener: () => void): () => void {
    if (this.#disposed) { listener(); return () => undefined }
    this.#disposeListeners.add(listener)
    return () => this.#disposeListeners.delete(listener)
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    let pending: { readonly value: T } | undefined
    let wake: (() => void) | undefined
    let finished = false
    const onValue = (value: T) => {
      // Streams represent revision snapshots, so a slow iterator only needs the
      // newest value. Coalescing here prevents an unbounded per-iterator queue.
      pending = { value }
      wake?.()
      wake = undefined
    }
    const onState = () => {
      const state = this.#snapshot
      if (state.status === 'error' || state.status === 'closed') {
        finished = true
        wake?.()
        wake = undefined
      }
    }
    this.#valueListeners.add(onValue)
    const unsubscribe = this.subscribe(onState)
    // subscribe() is intentionally a no-op for an already disposed resource.
    // Inspect the current snapshot so an iterator created after disposal ends
    // immediately instead of waiting for an event that can never arrive.
    onState()
    try {
      while (!finished || pending !== undefined) {
        const next = pending
        pending = undefined
        if (next !== undefined) {
          yield next.value
          continue
        }
        await new Promise<void>((next) => {
          wake = next
          if (finished || pending !== undefined) {
            wake = undefined
            next()
          }
        })
      }
      if (this.#snapshot.status === 'error') throw this.#snapshot.error
    } finally {
      this.#valueListeners.delete(onValue)
      unsubscribe()
    }
  }

  #start(): void {
    if (this.#disposed || this.#terminal || this.#run !== undefined) return
    if (this.#listeners.size === 0 && this.#valueListeners.size === 0) return
    const controller = new AbortController()
    this.#controller = controller
    const run = this.#consume(controller.signal).finally(() => {
      // A manual restart may already have installed a replacement consumer.
      // Completion of the aborted run must not clear or duplicate that run.
      if (this.#run !== run) return
      if (this.#controller === controller) this.#controller = undefined
      this.#run = undefined
      if (!this.#disposed && !this.#terminal && (this.#listeners.size > 0 || this.#valueListeners.size > 0)) {
        queueMicrotask(() => this.#start())
      }
    })
    this.#run = run
  }

  async #consume(signal: AbortSignal): Promise<void> {
    let attempt = 0
    while (!signal.aborted && !this.#disposed) {
      this.#publish(this.#withPrevious(attempt === 0 ? 'connecting' : 'disconnected', attempt))
      try {
        for await (const value of this.#options.open(this.#cursor, signal)) {
          if (signal.aborted) return
          const cursor = this.#options.cursor(value)
          if (cursor !== undefined) this.#cursor = cursor
          attempt = 0
          this.#publish({ status: 'ready', value, reconnectAttempt: 0 })
          for (const listener of this.#valueListeners) listener(value)
        }
        if (signal.aborted) return
        throw new ChronologRpcError('transport_unavailable', 'RPC stream ended')
      } catch (error) {
        if (signal.aborted) return
        attempt += 1
        const retry = (this.#options.retry ?? defaultRetry)(error, attempt)
        if (!retry) {
          this.#terminal = true
          this.#publish(this.#withPrevious('error', attempt, error))
          return
        }
        this.#publish(this.#withPrevious('disconnected', attempt, error))
        try {
          await abortableDelay((this.#options.retryDelayMs ?? defaultDelay)(attempt), signal)
        } catch {
          return
        }
      }
    }
  }

  #withPrevious(
    status: StreamResourceStatus,
    reconnectAttempt: number,
    error?: unknown,
  ): StreamSnapshot<T> {
    const previous = this.#snapshot.value
    if (previous === undefined) {
      return error === undefined ? { status, reconnectAttempt } : { status, error, reconnectAttempt }
    }
    return error === undefined
      ? { status, value: previous, reconnectAttempt }
      : { status, value: previous, error, reconnectAttempt }
  }

  #publish(snapshot: StreamSnapshot<T>): void {
    this.#snapshot = snapshot
    for (const listener of this.#listeners) listener()
  }

  #scheduleStopWhenUnused(): void {
    queueMicrotask(() => {
      if (this.#listeners.size === 0 && this.#valueListeners.size === 0) {
        this.#controller?.abort('resource unused')
      }
    })
  }
}
