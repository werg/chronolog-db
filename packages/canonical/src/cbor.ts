import { compareBytes, concatBytes, decodeUtf8, equalBytes, utf8 } from './bytes.js'
import { CanonicalError, canonicalInvariant } from './errors.js'

export type CborMapKey = bigint | string | Uint8Array
export type CborValue = null | boolean | bigint | string | Uint8Array | readonly CborValue[] | ReadonlyMap<CborMapKey, CborValue>

export interface DecodeLimits {
  readonly maxBytes: number
  readonly maxDepth: number
  readonly maxArrayItems: number
  readonly maxMapItems: number
  readonly maxTextBytes: number
  readonly maxBlobBytes: number
}

export const DEFAULT_DECODE_LIMITS: Readonly<DecodeLimits> = Object.freeze({
  maxBytes: 16 * 1024 * 1024,
  maxDepth: 64,
  maxArrayItems: 1_000_000,
  maxMapItems: 100_000,
  maxTextBytes: 4 * 1024 * 1024,
  maxBlobBytes: 16 * 1024 * 1024,
})

const MAX_UINT64 = (1n << 64n) - 1n

function encodeHead(major: number, value: bigint): Uint8Array {
  canonicalInvariant(value >= 0n && value <= MAX_UINT64, 'INTEGER_OUT_OF_RANGE', 'CBOR integer is outside uint64 range')
  if (value < 24n) return Uint8Array.of((major << 5) | Number(value))
  if (value <= 0xffn) return Uint8Array.of((major << 5) | 24, Number(value))
  if (value <= 0xffffn) return Uint8Array.of((major << 5) | 25, Number(value >> 8n), Number(value & 0xffn))
  if (value <= 0xffff_ffffn) {
    const bytes = new Uint8Array(5); bytes[0] = (major << 5) | 26
    new DataView(bytes.buffer).setUint32(1, Number(value), false); return bytes
  }
  const bytes = new Uint8Array(9); bytes[0] = (major << 5) | 27
  new DataView(bytes.buffer).setBigUint64(1, value, false); return bytes
}

function isMap(value: CborValue): value is ReadonlyMap<CborMapKey, CborValue> { return value instanceof Map }

export function encodeCanonicalCbor(value: CborValue): Uint8Array {
  if (value === null) return Uint8Array.of(0xf6)
  if (value === false) return Uint8Array.of(0xf4)
  if (value === true) return Uint8Array.of(0xf5)
  if (typeof value === 'bigint') return value >= 0n ? encodeHead(0, value) : encodeHead(1, -1n - value)
  if (typeof value === 'string') { const bytes = utf8(value); return concatBytes(encodeHead(3, BigInt(bytes.length)), bytes) }
  if (value instanceof Uint8Array) return concatBytes(encodeHead(2, BigInt(value.length)), value)
  if (Array.isArray(value)) return concatBytes(encodeHead(4, BigInt(value.length)), ...value.map(encodeCanonicalCbor))
  if (isMap(value)) {
    const entries = [...value].map(([key, item]) => ({ key: encodeCanonicalCbor(key), value: encodeCanonicalCbor(item) }))
      .sort((a, b) => a.key.length === b.key.length ? compareBytes(a.key, b.key) : a.key.length - b.key.length)
    for (let index = 1; index < entries.length; index += 1) canonicalInvariant(!equalBytes(entries[index - 1]!.key, entries[index]!.key), 'CBOR_NON_CANONICAL', 'Duplicate canonical CBOR map key')
    return concatBytes(encodeHead(5, BigInt(entries.length)), ...entries.flatMap((entry) => [entry.key, entry.value]))
  }
  throw new CanonicalError('SCHEMA_INVALID', 'Value is not supported by the deterministic CBOR profile')
}

class Decoder {
  private offset = 0
  constructor(private readonly input: Uint8Array, private readonly limits: DecodeLimits) {
    canonicalInvariant(input.length <= limits.maxBytes, 'CBOR_LIMIT_EXCEEDED', 'CBOR input exceeds byte limit')
  }
  decode(): CborValue {
    const value = this.value(0)
    canonicalInvariant(this.offset === this.input.length, 'CBOR_INVALID', 'Trailing bytes after CBOR value')
    return value
  }
  private byte(): number { canonicalInvariant(this.offset < this.input.length, 'CBOR_INVALID', 'Unexpected end of CBOR input'); return this.input[this.offset++]! }
  private bytes(size: number): Uint8Array {
    canonicalInvariant(Number.isSafeInteger(size) && size >= 0 && this.offset + size <= this.input.length, 'CBOR_INVALID', 'Invalid or truncated CBOR byte range')
    const value = this.input.slice(this.offset, this.offset + size); this.offset += size; return value
  }
  private argument(additional: number): bigint {
    if (additional < 24) return BigInt(additional)
    const read = (size: number): bigint => { const bytes = this.bytes(size); const view = new DataView(bytes.buffer, bytes.byteOffset, size); return size === 1 ? BigInt(bytes[0]!) : size === 2 ? BigInt(view.getUint16(0, false)) : size === 4 ? BigInt(view.getUint32(0, false)) : view.getBigUint64(0, false) }
    if (additional === 24) { const v = read(1); canonicalInvariant(v >= 24n, 'CBOR_NON_CANONICAL', 'Non-shortest CBOR integer'); return v }
    if (additional === 25) { const v = read(2); canonicalInvariant(v > 0xffn, 'CBOR_NON_CANONICAL', 'Non-shortest CBOR integer'); return v }
    if (additional === 26) { const v = read(4); canonicalInvariant(v > 0xffffn, 'CBOR_NON_CANONICAL', 'Non-shortest CBOR integer'); return v }
    if (additional === 27) { const v = read(8); canonicalInvariant(v > 0xffff_ffffn, 'CBOR_NON_CANONICAL', 'Non-shortest CBOR integer'); return v }
    if (additional === 31) throw new CanonicalError('CBOR_NON_CANONICAL', 'Indefinite-length CBOR is prohibited')
    throw new CanonicalError('CBOR_INVALID', 'Reserved CBOR additional information')
  }
  private value(depth: number): CborValue {
    canonicalInvariant(depth <= this.limits.maxDepth, 'CBOR_LIMIT_EXCEEDED', 'CBOR nesting exceeds limit')
    const initial = this.byte(), major = initial >> 5, additional = initial & 31
    if (major === 7) {
      if (additional === 20) return false; if (additional === 21) return true; if (additional === 22) return null
      throw new CanonicalError('CBOR_INVALID', 'Floating point and unsupported simple CBOR values are prohibited')
    }
    canonicalInvariant(major !== 6, 'CBOR_INVALID', 'CBOR tags are prohibited')
    const argument = this.argument(additional)
    if (major === 0) return argument
    if (major === 1) return -1n - argument
    canonicalInvariant(argument <= BigInt(Number.MAX_SAFE_INTEGER), 'CBOR_LIMIT_EXCEEDED', 'CBOR collection is too large')
    const size = Number(argument)
    if (major === 2) { canonicalInvariant(size <= this.limits.maxBlobBytes, 'CBOR_LIMIT_EXCEEDED', 'CBOR blob exceeds limit'); return this.bytes(size) }
    if (major === 3) { canonicalInvariant(size <= this.limits.maxTextBytes, 'CBOR_LIMIT_EXCEEDED', 'CBOR text exceeds limit'); return decodeUtf8(this.bytes(size)) }
    if (major === 4) {
      canonicalInvariant(size <= this.limits.maxArrayItems, 'CBOR_LIMIT_EXCEEDED', 'CBOR array exceeds item limit')
      return Array.from({ length: size }, () => this.value(depth + 1))
    }
    if (major === 5) {
      canonicalInvariant(size <= this.limits.maxMapItems, 'CBOR_LIMIT_EXCEEDED', 'CBOR map exceeds item limit')
      const map = new Map<CborMapKey, CborValue>(); let previous: Uint8Array | undefined
      for (let index = 0; index < size; index += 1) {
        const start = this.offset, key = this.value(depth + 1)
        canonicalInvariant(typeof key === 'bigint' || typeof key === 'string' || key instanceof Uint8Array, 'CBOR_INVALID', 'Unsupported CBOR map key')
        const encoded = this.input.slice(start, this.offset)
        if (previous !== undefined) canonicalInvariant(previous.length === encoded.length ? compareBytes(previous, encoded) < 0 : previous.length < encoded.length, 'CBOR_NON_CANONICAL', 'CBOR map keys are duplicate or incorrectly ordered')
        previous = encoded; map.set(key, this.value(depth + 1))
      }
      return map
    }
    throw new CanonicalError('CBOR_INVALID', `Unsupported CBOR major type ${major}`)
  }
}

export function decodeCanonicalCbor(input: Uint8Array, limits: DecodeLimits): CborValue { return new Decoder(input, limits).decode() }
export function assertCanonicalCbor(input: Uint8Array, limits: DecodeLimits): CborValue {
  const value = decodeCanonicalCbor(input, limits)
  canonicalInvariant(equalBytes(encodeCanonicalCbor(value), input), 'CBOR_NON_CANONICAL', 'CBOR bytes are not canonical')
  return value
}
