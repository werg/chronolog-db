export class ManualClock {
  #nowMs: bigint

  constructor(initialMs: bigint | number = 0n) {
    this.#nowMs = BigInt(initialMs)
  }

  now = (): bigint => this.#nowMs

  set(value: bigint | number): void {
    const next = BigInt(value)
    if (next < this.#nowMs) throw new Error('ManualClock cannot move backwards')
    this.#nowMs = next
  }

  advance(deltaMs: bigint | number): bigint {
    const delta = BigInt(deltaMs)
    if (delta < 0n) throw new Error('ManualClock delta must be non-negative')
    this.#nowMs += delta
    return this.#nowMs
  }
}

export async function collect<T>(
  source: AsyncIterable<T>,
  count: number,
  timeoutMs = 5_000,
): Promise<readonly T[]> {
  if (count < 0) throw new Error('count must be non-negative')
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  const values: T[] = []
  try {
    for await (const value of source) {
      values.push(value)
      if (values.length >= count) break
      if (controller.signal.aborted) throw new Error(`timed out collecting ${count} values`)
    }
  } finally {
    clearTimeout(timeout)
  }
  return values
}

export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  options: { readonly timeoutMs?: number; readonly intervalMs?: number } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 5_000
  const intervalMs = options.intervalMs ?? 10
  const deadline = Date.now() + timeoutMs
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error(`condition not met within ${timeoutMs}ms`)
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}

export function permutations<T>(values: readonly T[]): readonly (readonly T[])[] {
  if (values.length <= 1) return [values.slice()]
  const result: T[][] = []
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]
    if (value === undefined) continue
    const rest = [...values.slice(0, index), ...values.slice(index + 1)]
    for (const tail of permutations(rest)) result.push([value, ...tail])
  }
  return result
}
