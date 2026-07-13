import {
  CanonicalError,
  bytesToHex as sharedBytesToHex,
  compareBytes,
  concatBytes,
  copyBytes,
  decodeUtf8 as sharedDecodeUtf8,
  equalBytes,
  hexToBytes as sharedHexToBytes,
  utf8 as sharedUtf8,
} from '@chronolog/canonical'

import { ProtocolError, protocolInvariant } from './errors.js'

export { compareBytes, concatBytes, copyBytes, equalBytes }

function wrap<T>(operation: () => T): T {
  try { return operation() } catch (error) {
    if (error instanceof ProtocolError) throw error
    if (error instanceof CanonicalError) throw new ProtocolError(error.code as never, error.message, error.details)
    throw error
  }
}

export function utf8(value: string): Uint8Array { return wrap(() => sharedUtf8(value)) }
export function decodeUtf8(value: Uint8Array): string { return wrap(() => sharedDecodeUtf8(value)) }
export function bytesToHex(value: Uint8Array): string { return sharedBytesToHex(value) }
export function hexToBytes(value: string): Uint8Array { return wrap(() => sharedHexToBytes(value)) }

export function assertByteLength(value: Uint8Array, length: number, field: string): Uint8Array {
  protocolInvariant(value.length === length, 'SCHEMA_INVALID', `${field} must contain exactly ${length} bytes`, { field, expected: length, actual: value.length })
  return value
}
