import { CanonicalError } from './errors.js'

const textEncoder = new TextEncoder()
const fatalTextDecoder = new TextDecoder('utf-8', { fatal: true })

export function utf8(value: string): Uint8Array {
  const encoded = textEncoder.encode(value)
  try {
    if (fatalTextDecoder.decode(encoded) !== value) throw new CanonicalError('INVALID_UTF8', 'Text contains an unpaired UTF-16 surrogate')
  } catch (error) {
    if (error instanceof CanonicalError) throw error
    throw new CanonicalError('INVALID_UTF8', 'Text cannot be represented as canonical UTF-8')
  }
  return encoded
}

export function decodeUtf8(value: Uint8Array): string {
  try {
    return fatalTextDecoder.decode(value)
  } catch {
    throw new CanonicalError('INVALID_UTF8', 'Bytes are not valid UTF-8')
  }
}

export function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  const size = parts.reduce((sum, part) => sum + part.length, 0)
  const result = new Uint8Array(size)
  let offset = 0
  for (const part of parts) {
    result.set(part, offset)
    offset += part.length
  }
  return result
}

export function compareBytes(left: Uint8Array, right: Uint8Array): number {
  const size = Math.min(left.length, right.length)
  for (let index = 0; index < size; index += 1) {
    const difference = left[index]! - right[index]!
    if (difference !== 0) return difference < 0 ? -1 : 1
  }
  return left.length === right.length ? 0 : left.length < right.length ? -1 : 1
}

export function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false
  let difference = 0
  for (let index = 0; index < left.length; index += 1) difference |= left[index]! ^ right[index]!
  return difference === 0
}

export function bytesToHex(value: Uint8Array): string {
  return [...value].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function hexToBytes(value: string): Uint8Array {
  if (!/^(?:[0-9a-fA-F]{2})*$/u.test(value)) throw new CanonicalError('SCHEMA_INVALID', 'Hex text is malformed')
  return Uint8Array.from({ length: value.length / 2 }, (_unused, index) => Number.parseInt(value.slice(index * 2, index * 2 + 2), 16))
}

export function copyBytes(value: Uint8Array): Uint8Array { return Uint8Array.from(value) }
