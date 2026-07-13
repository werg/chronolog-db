import { describe, expect, it } from 'vitest'
import {
  ProtocolError,
  assertCanonicalCbor,
  decodeCanonicalCbor,
  encodeCanonicalCbor,
  integerMap,
  type CborMapKey,
  type CborValue,
  type ProtocolErrorCode,
} from './index.js'

describe('deterministic CBOR', () => {
  it('uses preferred integer and deterministic map ordering', () => {
    const value = new Map<CborMapKey, CborValue>([
      [10n, 'ten'],
      [1n, 'one'],
      ['z', new Uint8Array([3, 2, 1])],
    ])
    const encoded = encodeCanonicalCbor(value)
    expect(encoded[0]).toBe(0xa3)
    expect(encoded[1]).toBe(0x01)
    expect(encodeCanonicalCbor(decodeCanonicalCbor(encoded))).toEqual(encoded)
  })

  it.each([
    { bytes: [0x18, 0x01], code: 'CBOR_NON_CANONICAL' },
    { bytes: [0x9f, 0x01, 0xff], code: 'CBOR_NON_CANONICAL' },
    { bytes: [0xa2, 0x02, 0x00, 0x01, 0x00], code: 'CBOR_NON_CANONICAL' },
    { bytes: [0xf9, 0x00, 0x00], code: 'CBOR_INVALID' },
    { bytes: [0x01, 0x00], code: 'CBOR_INVALID' },
  ] as const)('rejects malformed or non-canonical bytes %#', ({ bytes, code }) => {
    expect(() => assertCanonicalCbor(Uint8Array.from(bytes))).toThrowError(
      expect.objectContaining<Partial<ProtocolError>>({ code: code as ProtocolErrorCode }),
    )
  })

  it('enforces bounds before allocation', () => {
    const encoded = encodeCanonicalCbor([1n, 2n, 3n])
    expect(() => decodeCanonicalCbor(encoded, { maxItems: 2 })).toThrowError(
      expect.objectContaining<Partial<ProtocolError>>({ code: 'CBOR_LIMIT_EXCEEDED' }),
    )
  })

  it('handles uint64 and the supported negative range exactly', () => {
    const value = [(1n << 64n) - 1n, -(1n << 64n)] as const
    expect(decodeCanonicalCbor(encodeCanonicalCbor(value))).toEqual(value)
  })

  it('rejects duplicate canonical keys during encoding', () => {
    const map = new Map<bigint | string, bigint>([[1n, 1n]])
    map.set(1n, 2n)
    // JavaScript Maps already coalesce equal scalar keys.
    expect(encodeCanonicalCbor(map)).toEqual(Uint8Array.of(0xa1, 0x01, 0x02))
    expect(encodeCanonicalCbor(integerMap([[0, 1n], [1, 2n]]))).toEqual(Uint8Array.of(0xa2, 0x00, 0x01, 0x01, 0x02))
  })
})
