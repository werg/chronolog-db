import { describe, expect, it } from 'vitest'

import {
  DEFAULT_DECODE_LIMITS, HASH_DOMAINS, assertCanonicalCbor, bytesToHex, bytesToInt64,
  bytesToUint32, bytesToUint64, decodeCanonicalCbor, domainSeparatedBytes, encodeCanonicalCbor,
  hashDomain, int64Bytes, uint32Bytes, uint64Bytes, utf8,
} from './index.js'

describe('canonical primitives', () => {
  it('has stable deterministic CBOR golden bytes', () => {
    const value = new Map([[2n, 'b'], [1n, 'a']])
    expect(bytesToHex(encodeCanonicalCbor(value))).toBe('a2016161026162')
    expect(decodeCanonicalCbor(encodeCanonicalCbor(value), DEFAULT_DECODE_LIMITS)).toEqual(new Map([[1n, 'a'], [2n, 'b']]))
  })

  it.each([
    Uint8Array.of(0x18, 0x17),
    Uint8Array.of(0x9f, 0xff),
    Uint8Array.of(0xa2, 0x01, 0x00, 0x01, 0x00),
    Uint8Array.of(0x00, 0x00),
    Uint8Array.of(0xf9, 0x00, 0x00),
  ])('rejects malformed or noncanonical CBOR %#', (bytes) => {
    expect(() => assertCanonicalCbor(bytes, DEFAULT_DECODE_LIMITS)).toThrow()
  })

  it('enforces each decoder allocation limit while consuming', () => {
    const tiny = { ...DEFAULT_DECODE_LIMITS, maxArrayItems: 1, maxMapItems: 1, maxTextBytes: 1, maxBlobBytes: 1 }
    expect(() => decodeCanonicalCbor(encodeCanonicalCbor([1n, 2n]), tiny)).toThrow(/array/i)
    expect(() => decodeCanonicalCbor(encodeCanonicalCbor(new Map([[1n, 1n], [2n, 2n]])), tiny)).toThrow(/map/i)
    expect(() => decodeCanonicalCbor(encodeCanonicalCbor('ab'), tiny)).toThrow(/text/i)
    expect(() => decodeCanonicalCbor(encodeCanonicalCbor(Uint8Array.of(1, 2)), tiny)).toThrow(/blob/i)
  })

  it('rejects unpaired UTF-16 surrogates', () => {
    expect(() => utf8('\ud800')).toThrow(/surrogate|UTF-8/i)
  })

  it('round-trips fixed-width integer boundaries', () => {
    expect(bytesToUint32(uint32Bytes(0xffff_ffff))).toBe(0xffff_ffff)
    expect(bytesToUint64(uint64Bytes((1n << 64n) - 1n))).toBe((1n << 64n) - 1n)
    expect(bytesToInt64(int64Bytes(-(1n << 63n)))).toBe(-(1n << 63n))
  })

  it('uses a unique typed, length-prefixed hash domain registry', async () => {
    expect(new Set(Object.values(HASH_DOMAINS)).size).toBe(Object.keys(HASH_DOMAINS).length)
    const framed = domainSeparatedBytes('schema', Uint8Array.of(7))
    expect(new DataView(framed.buffer).getUint32(0, false)).toBe(utf8(HASH_DOMAINS.schema).length)
    expect(await hashDomain('schema', Uint8Array.of(1))).not.toEqual(await hashDomain('schema', Uint8Array.of(2)))
    expect(await hashDomain('schema', Uint8Array.of(1))).not.toEqual(await hashDomain('transaction', Uint8Array.of(1)))
  })
})
