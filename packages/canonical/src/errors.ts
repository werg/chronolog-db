export type CanonicalErrorCode =
  | 'CBOR_INVALID'
  | 'CBOR_NON_CANONICAL'
  | 'CBOR_LIMIT_EXCEEDED'
  | 'SCHEMA_INVALID'
  | 'INTEGER_OUT_OF_RANGE'
  | 'INVALID_UTF8'
  | 'DIGEST_MISMATCH'

export class CanonicalError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message)
    this.name = 'CanonicalError'
  }
}

export function canonicalInvariant(
  condition: unknown,
  code: CanonicalErrorCode | string,
  message: string,
  details?: Readonly<Record<string, unknown>>,
): asserts condition {
  if (!condition) throw new CanonicalError(code, message, details)
}
