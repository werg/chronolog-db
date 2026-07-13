export type ProtocolErrorCode =
  | 'CBOR_INVALID'
  | 'CBOR_NON_CANONICAL'
  | 'CBOR_LIMIT_EXCEEDED'
  | 'SCHEMA_INVALID'
  | 'UNSUPPORTED_VERSION'
  | 'INTEGER_OUT_OF_RANGE'
  | 'INVALID_UTF8'
  | 'INVALID_KEY'
  | 'INVALID_SIGNATURE'
  | 'DIGEST_MISMATCH'
  | 'WRONG_DOMAIN'
  | 'DUPLICATE_TRANSACTION'

export class ProtocolError extends Error {
  public readonly code: ProtocolErrorCode
  public readonly details: Readonly<Record<string, unknown>> | undefined

  public constructor(
    code: ProtocolErrorCode,
    message: string,
    details?: Readonly<Record<string, unknown>>,
  ) {
    super(message)
    this.name = 'ProtocolError'
    this.code = code
    this.details = details
  }

  public toJSON(): Readonly<Record<string, unknown>> {
    return this.details === undefined
      ? { name: this.name, code: this.code, message: this.message }
      : { name: this.name, code: this.code, message: this.message, details: this.details }
  }
}

export function protocolInvariant(
  condition: unknown,
  code: ProtocolErrorCode,
  message: string,
  details?: Readonly<Record<string, unknown>>,
): asserts condition {
  if (!condition) throw new ProtocolError(code, message, details)
}

