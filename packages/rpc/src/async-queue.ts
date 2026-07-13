/** A small bounded-independent queue for service implementations and tests. */
export class AsyncQueue<T> implements AsyncIterable<T> {
  readonly #values: T[] = []
  readonly #waiters: Array<{
    resolve: (result: IteratorResult<T>) => void
    reject: (error: unknown) => void
  }> = []
  #closed = false
  #failure: unknown

  push(value: T): void {
    if (this.#closed) throw new Error('Cannot push to a closed AsyncQueue')
    const waiter = this.#waiters.shift()
    if (waiter !== undefined) waiter.resolve({ done: false, value })
    else this.#values.push(value)
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    for (const waiter of this.#waiters.splice(0)) waiter.resolve({ done: true, value: undefined })
  }

  fail(error: unknown): void {
    if (this.#closed) return
    this.#closed = true
    this.#failure = error
    for (const waiter of this.#waiters.splice(0)) waiter.reject(error)
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const value = this.#values.shift()
        if (value !== undefined) return Promise.resolve({ done: false, value })
        if (this.#failure !== undefined) return Promise.reject(this.#failure)
        if (this.#closed) return Promise.resolve({ done: true, value: undefined })
        return new Promise<IteratorResult<T>>((resolve, reject) => {
          this.#waiters.push({ resolve, reject })
        })
      },
    }
  }
}
