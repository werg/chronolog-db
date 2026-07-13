export class Mutex {
  #tail: Promise<void> = Promise.resolve()

  async run<T>(operation: () => Promise<T> | T): Promise<T> {
    let release!: () => void
    const previous = this.#tail
    this.#tail = new Promise<void>((resolve) => { release = resolve })
    await previous
    try {
      return await operation()
    } finally {
      release()
    }
  }
}

interface QueueWaiter<T> {
  readonly resolve: (result: IteratorResult<T>) => void
  readonly reject: (error: unknown) => void
}

class Subscription<T> implements AsyncIterable<T> {
  readonly #values: T[] = []
  readonly #waiters: QueueWaiter<T>[] = []
  readonly #onClose: () => void
  #closed = false

  constructor(onClose: () => void, initial?: T) {
    this.#onClose = onClose
    if (initial !== undefined) this.#values.push(initial)
  }

  emit(value: T): void {
    if (this.#closed) return
    const waiter = this.#waiters.shift()
    if (waiter) waiter.resolve({ value, done: false })
    else this.#values.push(value)
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    this.#onClose()
    for (const waiter of this.#waiters.splice(0)) waiter.resolve({ value: undefined, done: true })
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const value = this.#values.shift()
        if (value !== undefined) return Promise.resolve({ value, done: false })
        if (this.#closed) return Promise.resolve({ value: undefined, done: true })
        return new Promise<IteratorResult<T>>((resolve, reject) => {
          this.#waiters.push({ resolve, reject })
        })
      },
      return: async () => {
        this.close()
        return { value: undefined, done: true }
      },
    }
  }
}

export class RevisionBroadcaster<T> {
  readonly #subscriptions = new Set<Subscription<T>>()
  #latest: T | undefined
  #closed = false

  constructor(initial?: T) {
    this.#latest = initial
  }

  get latest(): T | undefined {
    return this.#latest
  }

  emit(value: T): void {
    if (this.#closed) throw new Error('broadcaster is closed')
    this.#latest = value
    for (const subscription of this.#subscriptions) subscription.emit(value)
  }

  subscribe(options: { readonly replayLatest?: boolean; readonly signal?: AbortSignal } = {}): AsyncIterable<T> {
    const subscription = new Subscription<T>(
      () => this.#subscriptions.delete(subscription),
      options.replayLatest === false ? undefined : this.#latest,
    )
    if (this.#closed) subscription.close()
    else this.#subscriptions.add(subscription)
    const abort = () => subscription.close()
    if (options.signal?.aborted) abort()
    else options.signal?.addEventListener('abort', abort, { once: true })
    return subscription
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    for (const subscription of [...this.#subscriptions]) subscription.close()
  }
}

export class IdempotencyMap<T> {
  readonly #values = new Map<string, T>()

  get(key: string): T | undefined {
    return this.#values.get(key)
  }

  getOrCreate(key: string, create: () => T): T {
    const existing = this.#values.get(key)
    if (existing !== undefined) return existing
    const value = create()
    this.#values.set(key, value)
    return value
  }

  delete(key: string): boolean {
    return this.#values.delete(key)
  }
}
