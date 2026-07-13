import {
  DEFAULT_DECODE_LIMITS,
  CanonicalError,
  assertCanonicalCbor as assertSharedCanonicalCbor,
  decodeCanonicalCbor as decodeSharedCanonicalCbor,
  encodeCanonicalCbor,
  type CborMapKey,
  type CborValue,
  type DecodeLimits,
} from '@chronolog/canonical'

import { ProtocolError } from './errors.js'

export type { CborMapKey, CborValue }
export { encodeCanonicalCbor }

/** Backward-compatible protocol limit names over the shared bounded decoder. */
export interface CborDecodeLimits {
  readonly maxBytes?: number
  readonly maxDepth?: number
  readonly maxItems?: number
  readonly maxTextBytes?: number
  readonly maxByteStringBytes?: number
}

function sharedLimits(limits: CborDecodeLimits): DecodeLimits {
  return {
    maxBytes: limits.maxBytes ?? DEFAULT_DECODE_LIMITS.maxBytes,
    maxDepth: limits.maxDepth ?? DEFAULT_DECODE_LIMITS.maxDepth,
    maxArrayItems: limits.maxItems ?? DEFAULT_DECODE_LIMITS.maxArrayItems,
    maxMapItems: limits.maxItems ?? DEFAULT_DECODE_LIMITS.maxMapItems,
    maxTextBytes: limits.maxTextBytes ?? DEFAULT_DECODE_LIMITS.maxTextBytes,
    maxBlobBytes: limits.maxByteStringBytes ?? DEFAULT_DECODE_LIMITS.maxBlobBytes,
  }
}

function protocolError(error: unknown): never {
  if (error instanceof ProtocolError) throw error
  if (error instanceof CanonicalError) throw new ProtocolError(error.code as never, error.message, error.details)
  throw error
}

export function decodeCanonicalCbor(input: Uint8Array, limits: CborDecodeLimits = {}): CborValue {
  try { return decodeSharedCanonicalCbor(input, sharedLimits(limits)) } catch (error) { return protocolError(error) }
}

export function assertCanonicalCbor(input: Uint8Array, limits: CborDecodeLimits = {}): CborValue {
  try { return assertSharedCanonicalCbor(input, sharedLimits(limits)) } catch (error) { return protocolError(error) }
}
