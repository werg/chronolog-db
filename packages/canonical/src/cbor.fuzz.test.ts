import { describe, expect, it } from 'vitest'

import {
  assertCanonicalCbor,
  encodeCanonicalCbor,
  type CborValue,
  type DecodeLimits,
} from './cbor.js'

const limits: DecodeLimits = {
  maxBytes: 512,
  maxDepth: 12,
  maxArrayItems: 64,
  maxMapItems: 64,
  maxTextBytes: 256,
  maxBlobBytes: 256,
}

describe('canonical CBOR deterministic fuzz corpus', () => {
  it('round-trips generated bounded values', () => {
    const random = new FuzzRandom(0x43424f52)
    for (let index = 0; index < 2_000; index += 1) {
      const value = generatedValue(random, 0)
      const encoded = encodeCanonicalCbor(value)
      expect(assertCanonicalCbor(encoded, limits)).toEqual(value)
    }
  })

  it('fails closed or returns exactly canonical bytes for arbitrary inputs', () => {
    const random = new FuzzRandom(0xdec0de01)
    for (let index = 0; index < 5_000; index += 1) {
      const bytes = random.bytes(random.integer(0, 512))
      try {
        const decoded = assertCanonicalCbor(bytes, limits)
        expect(encodeCanonicalCbor(decoded)).toEqual(bytes)
      } catch (error) {
        expect(error).toBeInstanceOf(Error)
      }
    }
  })
})

function generatedValue(random: FuzzRandom, depth: number): CborValue {
  const variants = depth >= 4 ? 5 : 7
  switch (random.integer(0, variants - 1)) {
    case 0: return null
    case 1: return random.boolean()
    case 2: return BigInt(random.integer(-1_000_000, 1_000_000))
    case 3: return random.text(random.integer(0, 24))
    case 4: return random.bytes(random.integer(0, 24))
    case 5: return Array.from(
      { length: random.integer(0, 8) },
      () => generatedValue(random, depth + 1),
    )
    default: {
      const result = new Map<bigint, CborValue>()
      for (let index = 0; index < random.integer(0, 8); index += 1) {
        result.set(BigInt(index), generatedValue(random, depth + 1))
      }
      return result
    }
  }
}

class FuzzRandom {
  constructor(private state: number) {}
  next(): number {
    let value = this.state | 0
    value ^= value << 13
    value ^= value >>> 17
    value ^= value << 5
    this.state = value >>> 0
    return this.state
  }
  integer(minimum: number, maximum: number): number {
    return minimum + (this.next() % (maximum - minimum + 1))
  }
  boolean(): boolean { return (this.next() & 1) === 1 }
  bytes(length: number): Uint8Array {
    return Uint8Array.from({ length }, () => this.next() & 0xff)
  }
  text(length: number): string {
    return Array.from({ length }, () => String.fromCodePoint(32 + (this.next() % 95))).join('')
  }
}
