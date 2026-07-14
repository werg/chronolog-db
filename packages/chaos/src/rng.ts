const MASK_64 = (1n << 64n) - 1n

/** Stable seeded PRNG used only for scenario generation and workload choices. */
export class SeededRandom {
  #state: bigint

  constructor(readonly seed: string) {
    this.#state = hashSeed(seed)
  }

  uint64(): bigint {
    this.#state = (this.#state + 0x9e3779b97f4a7c15n) & MASK_64
    let value = this.#state
    value = ((value ^ (value >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK_64
    value = ((value ^ (value >> 27n)) * 0x94d049bb133111ebn) & MASK_64
    return (value ^ (value >> 31n)) & MASK_64
  }

  float(): number {
    return Number(this.uint64() >> 11n) / 9_007_199_254_740_992
  }

  integer(minimum: number, maximum: number): number {
    if (!Number.isSafeInteger(minimum) || !Number.isSafeInteger(maximum) || maximum < minimum) {
      throw new RangeError('Invalid deterministic integer range')
    }
    return minimum + Math.floor(this.float() * (maximum - minimum + 1))
  }

  pick<T>(values: readonly T[]): T {
    if (values.length === 0) throw new RangeError('Cannot choose from an empty collection')
    return values[this.integer(0, values.length - 1)]!
  }

  bytes(length: number): Uint8Array {
    if (!Number.isSafeInteger(length) || length < 0) throw new RangeError('Invalid byte length')
    const result = new Uint8Array(length)
    for (let offset = 0; offset < length; offset += 8) {
      const value = this.uint64()
      for (let index = 0; index < Math.min(8, length - offset); index += 1) {
        result[offset + index] = Number((value >> BigInt(index * 8)) & 0xffn)
      }
    }
    return result
  }

  fork(label: string): SeededRandom {
    return new SeededRandom(`${this.seed}\u0000${label}\u0000${this.uint64().toString(16)}`)
  }
}

function hashSeed(seed: string): bigint {
  let value = 0xcbf29ce484222325n
  for (const byte of new TextEncoder().encode(seed)) {
    value ^= BigInt(byte)
    value = (value * 0x100000001b3n) & MASK_64
  }
  return value === 0n ? 1n : value
}
