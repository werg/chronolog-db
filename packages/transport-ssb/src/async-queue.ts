export class AsyncQueue<T> implements AsyncIterable<T> {
  readonly #values: T[] = []
  readonly #waiters: Array<{
    resolve: (result: IteratorResult<T>) => void
    reject: (error: unknown) => void
  }> = []
  #closed = false
  #error: unknown

  constructor(readonly maximumBufferedValues = 1_024) {
    if (!Number.isSafeInteger(maximumBufferedValues) || maximumBufferedValues < 1) {
      throw new Error('ASYNC_QUEUE_INVALID_CAPACITY')
    }
  }

  push(value: T): boolean {
    if (this.#closed) return false
    const waiter = this.#waiters.shift()
    if (waiter) waiter.resolve({ value, done: false })
    else if (this.#values.length < this.maximumBufferedValues) this.#values.push(value)
    else {
      this.fail(new Error('ASYNC_QUEUE_OVERFLOW'))
      return false
    }
    return true
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    for (const waiter of this.#waiters.splice(0)) {
      waiter.resolve({ value: undefined, done: true })
    }
  }

  fail(error: unknown): void {
    if (this.#closed) return
    this.#closed = true
    this.#error = error
    this.#values.splice(0)
    for (const waiter of this.#waiters.splice(0)) waiter.reject(error)
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const value = this.#values.shift()
        if (value !== undefined) return Promise.resolve({ value, done: false })
        if (this.#closed) {
          return this.#error === undefined
            ? Promise.resolve({ value: undefined, done: true })
            : Promise.reject(this.#error)
        }
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
