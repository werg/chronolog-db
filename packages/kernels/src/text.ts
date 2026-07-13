import { compareBytes } from './vector.js'
import { KernelError, kernelAssert } from './errors.js'

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

export function validateUtf8(bytes: Uint8Array): string {
  try { return decoder.decode(bytes) }
  catch { throw new KernelError('INVALID_UTF8', 'invalid UTF-8') }
}

export function utf8(value: string): Uint8Array {
  const bytes = encoder.encode(value)
  validateUtf8(bytes)
  return bytes
}

export function utf8ScalarLength(bytes: Uint8Array): number {
  return Array.from(validateUtf8(bytes)).length
}

export function utf8Slice(bytes: Uint8Array, start: number, end: number): Uint8Array {
  kernelAssert(Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && end >= start, 'INVALID_ARGUMENT_ENCODING', 'invalid scalar slice')
  const scalars = Array.from(validateUtf8(bytes))
  kernelAssert(end <= scalars.length, 'INVALID_ARGUMENT_ENCODING', 'scalar slice out of bounds')
  return encoder.encode(scalars.slice(start, end).join(''))
}

export function utf8Concat(parts: readonly Uint8Array[], maxBytes: number): Uint8Array {
  let length = 0
  for (const part of parts) { validateUtf8(part); length += part.length }
  kernelAssert(length <= maxBytes, 'SEMANTIC_RESOURCE_LIMIT', 'text byte limit exceeded')
  const result = new Uint8Array(length)
  let offset = 0
  for (const part of parts) { result.set(part, offset); offset += part.length }
  return result
}

export function asciiLower(bytes: Uint8Array): Uint8Array {
  validateUtf8(bytes)
  return Uint8Array.from(bytes, (byte) => byte >= 0x41 && byte <= 0x5a ? byte + 0x20 : byte)
}

export function asciiUpper(bytes: Uint8Array): Uint8Array {
  validateUtf8(bytes)
  return Uint8Array.from(bytes, (byte) => byte >= 0x61 && byte <= 0x7a ? byte - 0x20 : byte)
}

export const compareUtf8Binary = compareBytes
