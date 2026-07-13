import { createHmac } from 'node:crypto'
import { kernelAssert } from './errors.js'

function hmac(key: Uint8Array, ...parts: readonly Uint8Array[]): Uint8Array {
  const mac = createHmac('sha256', key)
  for (const part of parts) mac.update(part)
  return new Uint8Array(mac.digest())
}

function uint16be(value: number): Uint8Array {
  return Uint8Array.of(value >>> 8, value & 0xff)
}

function uint64be(value: bigint): Uint8Array {
  kernelAssert(value >= 0n && value <= 0xffff_ffff_ffff_ffffn, 'INVALID_ARGUMENT_ENCODING', 'entropy index out of range')
  const result = new Uint8Array(8)
  let remaining = value
  for (let i = 7; i >= 0; i -= 1) {
    result[i] = Number(remaining & 0xffn)
    remaining >>= 8n
  }
  return result
}

export function hkdfExtractSha256(salt: Uint8Array, inputKeyMaterial: Uint8Array): Uint8Array {
  return hmac(salt, inputKeyMaterial)
}

export function hkdfExpandSha256(prk: Uint8Array, info: Uint8Array, length: number): Uint8Array {
  kernelAssert(Number.isSafeInteger(length) && length >= 0 && length <= 255 * 32, 'SEMANTIC_RESOURCE_LIMIT', 'HKDF output length out of range')
  const output = new Uint8Array(length)
  let previous: Uint8Array<ArrayBufferLike> = new Uint8Array()
  let offset = 0
  for (let block = 1; offset < length; block += 1) {
    previous = hmac(prk, previous, info, Uint8Array.of(block))
    const take = Math.min(previous.length, length - offset)
    output.set(previous.subarray(0, take), offset)
    offset += take
  }
  return output
}

export function deriveEntropy(
  groupId: Uint8Array,
  transactionNonce: Uint8Array,
  label: string,
  index: bigint,
  length: number,
): Uint8Array {
  kernelAssert(/^[\x20-\x7e]{1,128}$/.test(label), 'INVALID_ARGUMENT_ENCODING', 'entropy label must be non-empty printable ASCII')
  const labelBytes = new TextEncoder().encode(label)
  const prefix = new TextEncoder().encode('chronolog/entropy/v1')
  const info = new Uint8Array(prefix.length + 1 + 2 + labelBytes.length + 8)
  let offset = 0
  info.set(prefix, offset); offset += prefix.length
  info[offset] = 0; offset += 1
  info.set(uint16be(labelBytes.length), offset); offset += 2
  info.set(labelBytes, offset); offset += labelBytes.length
  info.set(uint64be(index), offset)
  return hkdfExpandSha256(hkdfExtractSha256(groupId, transactionNonce), info, length)
}

export function entropyUuid(bytes: Uint8Array): Uint8Array {
  kernelAssert(bytes.length >= 16, 'INVALID_ARGUMENT_ENCODING', 'UUID entropy requires 16 bytes')
  const result = bytes.slice(0, 16)
  result[6] = (result[6]! & 0x0f) | 0x40
  result[8] = (result[8]! & 0x3f) | 0x80
  return result
}

export function formatUuid(bytes: Uint8Array): string {
  kernelAssert(bytes.length === 16, 'INVALID_ARGUMENT_ENCODING', 'UUID must contain 16 bytes')
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export function entropyBoundedInt(
  groupId: Uint8Array,
  nonce: Uint8Array,
  label: string,
  index: bigint,
  upperExclusive: bigint,
): bigint {
  kernelAssert(upperExclusive > 0n && upperExclusive <= (1n << 64n), 'INVALID_ARGUMENT_ENCODING', 'invalid entropy integer bound')
  const range = 1n << 64n
  const ceiling = range - (range % upperExclusive)
  for (let attempt = 0n; attempt < 1_000_000n; attempt += 1n) {
    const bytes = deriveEntropy(groupId, nonce, `${label}/bounded`, (index << 20n) | attempt, 8)
    let candidate = 0n
    for (const byte of bytes) candidate = (candidate << 8n) | BigInt(byte)
    if (candidate < ceiling) return candidate % upperExclusive
  }
  throw new Error('unreachable entropy rejection limit')
}
