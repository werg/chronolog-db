import { describe, expect, it } from 'vitest'

import {
  decodeTransactionResultEnvelope,
  encodeTransactionResultEnvelope,
  type TransactionResultEnvelopeV1,
} from './sql.js'

const fixture: TransactionResultEnvelopeV1 = {
  version: 1,
  preconditions: [{ index: 0, id: 7, resultDigest: bytes(32, 1) }],
  statements: [{
    index: 0,
    statementClass: 'read',
    affectedRows: null,
    result: {
      mode: 'ordered',
      columns: [{ nameUtf8: new TextEncoder().encode('value'), type: { kind: 'dynamic' }, nullable: 'unknown' }],
      rows: [[{ kind: 'integer', value: 42n }]],
    },
  }],
}

describe('transaction result mutation fuzz corpus', () => {
  it('accepts only canonical mutated envelopes', () => {
    const original = encodeTransactionResultEnvelope(fixture)
    let state = 0x52534c54
    for (let index = 0; index < 4_000; index += 1) {
      state = next(state)
      const candidate = mutate(original, state)
      try {
        const decoded = decodeTransactionResultEnvelope(candidate)
        expect(encodeTransactionResultEnvelope(decoded)).toEqual(candidate)
      } catch (error) {
        expect(error).toBeInstanceOf(Error)
      }
    }
  })
})

function mutate(original: Uint8Array, seed: number): Uint8Array {
  const mode = seed % 4
  if (mode === 0) return original.slice(0, seed % original.length)
  if (mode === 1) {
    const result = original.slice()
    const offset = seed % result.length
    result[offset] = result[offset]! ^ (1 << ((seed >>> 8) % 8))
    return result
  }
  if (mode === 2) {
    const result = new Uint8Array(original.length + 1)
    result.set(original)
    result[result.length - 1] = seed & 0xff
    return result
  }
  const result = original.slice()
  const first = seed % result.length
  const second = (seed >>> 8) % result.length
  ;[result[first], result[second]] = [result[second]!, result[first]!]
  return result
}

function next(state: number): number {
  let value = state | 0
  value ^= value << 13
  value ^= value >>> 17
  value ^= value << 5
  return value >>> 0
}

function bytes(length: number, seed: number): Uint8Array {
  return Uint8Array.from({ length }, (_value, index) => (seed + index) & 0xff)
}
