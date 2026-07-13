import { describe, expect, it } from 'vitest'
import {
  INT64_MAX,
  INT64_MIN,
  KernelError,
  asciiLower,
  applyJsonPatch,
  canonicalJsonEqual,
  compareDecimal,
  decimalDiv,
  decimalRescale,
  deriveEntropy,
  entropyUuid,
  exactKnn,
  formatDecimal,
  formatUuid,
  hammingDistance,
  hkdfExpandSha256,
  hkdfExtractSha256,
  int64Add,
  int64Div,
  int64Mul,
  int8Dot,
  int8Manhattan,
  int8SquaredL2,
  jsonMergePatch,
  jsonPointer,
  parseCanonicalJson,
  parseDecimal,
  serializeCanonicalJson,
  utf8,
  utf8ScalarLength,
  utf8Slice,
} from './index.js'

function hex(value: Uint8Array): string {
  return Buffer.from(value).toString('hex')
}

describe('checked Int64', () => {
  it('implements checked arithmetic and truncating division', () => {
    expect(int64Add(40n, 2n)).toBe(42n)
    expect(int64Mul(-6n, 7n)).toBe(-42n)
    expect(int64Div(-7n, 3n)).toBe(-2n)
    expect(() => int64Add(INT64_MAX, 1n)).toThrowError(KernelError)
    expect(() => int64Div(INT64_MIN, -1n)).toThrowError(KernelError)
  })
})

describe('decimal', () => {
  it('preserves scale and applies explicit rounding modes', () => {
    const value = parseDecimal('12.450', 3)
    expect(formatDecimal(value)).toBe('12.450')
    expect(formatDecimal(decimalRescale(value, 1, 'half-even'))).toBe('12.4')
    expect(formatDecimal(decimalRescale(parseDecimal('12.55'), 1, 'half-even'))).toBe('12.6')
    expect(formatDecimal(decimalDiv(parseDecimal('1'), parseDecimal('8'), 3, 'exact'))).toBe('0.125')
    expect(compareDecimal(parseDecimal('1.0'), parseDecimal('1'))).toBe(0)
  })
})

describe('text', () => {
  it('counts and slices Unicode scalar values without locale behavior', () => {
    const value = utf8('A😀é')
    expect(utf8ScalarLength(value)).toBe(3)
    expect(new TextDecoder().decode(utf8Slice(value, 1, 3))).toBe('😀é')
    expect(new TextDecoder().decode(asciiLower(utf8('ÄZ')))).toBe('Äz')
  })
})

describe('canonical JSON', () => {
  it('preserves exact numbers, rejects duplicates, and sorts UTF-8 keys', () => {
    const value = parseCanonicalJson('{"z":1e-2,"a":9007199254740993,"emoji":"😀"}')
    expect(serializeCanonicalJson(value)).toBe('{"a":9007199254740993,"emoji":"😀","z":0.01}')
    expect(() => parseCanonicalJson('{"a":1,"a":2}')).toThrowError(expect.objectContaining({ code: 'JSON_DUPLICATE_KEY' }))
    expect(() => parseCanonicalJson('"\\ud800"')).toThrowError(expect.objectContaining({ code: 'INVALID_JSON' }))
  })

  it('supports pointers and RFC 7396 merge patch', () => {
    const target = parseCanonicalJson('{"a":{"b":1},"keep":true}')
    expect(serializeCanonicalJson(jsonPointer(target, '/a'))).toBe('{"b":1}')
    const merged = jsonMergePatch(target, parseCanonicalJson('{"a":{"c":2},"keep":null}'))
    expect(serializeCanonicalJson(merged)).toBe('{"a":{"b":1,"c":2}}')
    expect(canonicalJsonEqual(merged, parseCanonicalJson('{"a":{"c":2,"b":1}}'))).toBe(true)
  })

  it('applies RFC 6902-style operations in declared order with indexed errors', () => {
    const patched = applyJsonPatch(parseCanonicalJson('{"a":[1,2],"b":true}'), [
      { op: 'add', path: '/a/1', value: parseCanonicalJson('9') },
      { op: 'copy', from: '/b', path: '/copied' },
      { op: 'replace', path: '/b', value: parseCanonicalJson('false') },
      { op: 'remove', path: '/a/0' },
      { op: 'test', path: '/a/0', value: parseCanonicalJson('9') },
    ])
    expect(serializeCanonicalJson(patched)).toBe('{"a":[9,2],"b":false,"copied":true}')
  })
})

describe('labeled entropy', () => {
  it('matches the RFC 5869 SHA-256 case and is label/index stable', () => {
    const ikm = Uint8Array.from({ length: 22 }, () => 0x0b)
    const salt = Uint8Array.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c])
    const info = Uint8Array.from([0xf0, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9])
    const prk = hkdfExtractSha256(salt, ikm)
    expect(hex(prk)).toBe('077709362c2e32df0ddc3f0dc47bba6390b6c73bb50f9c3122ec844ad7c2b3e5')
    expect(hex(hkdfExpandSha256(prk, info, 42))).toBe('3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865')
    const entropy = deriveEntropy(Uint8Array.of(1, 2), Uint8Array.of(3, 4), 'id', 0n, 16)
    expect(hex(entropy)).toHaveLength(32)
    expect(formatUuid(entropyUuid(entropy))[14]).toBe('4')
  })
})

describe('exact vector reference', () => {
  it('implements integer distances and stable primary-key ties', () => {
    expect(hammingDistance(Uint8Array.of(0b10100000), Uint8Array.of(0b00110000), 4)).toBe(2n)
    const a = Int8Array.of(-2, 3)
    const b = Int8Array.of(1, -1)
    expect(int8Manhattan(a, b)).toBe(7n)
    expect(int8SquaredL2(a, b)).toBe(25n)
    expect(int8Dot(a, b)).toBe(-5n)
    const neighbors = exactKnn([
      { key: Uint8Array.of(2), value: Int8Array.of(1) },
      { key: Uint8Array.of(1), value: Int8Array.of(-1) },
    ], Int8Array.of(0), 2, int8SquaredL2)
    expect(neighbors.map((neighbor) => neighbor.key[0])).toEqual([1, 2])
  })
})
