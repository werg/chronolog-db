export type KernelErrorCode =
  | 'INVALID_ARGUMENT_ENCODING'
  | 'TYPE_MISMATCH'
  | 'NUMERIC_OVERFLOW'
  | 'DIVISION_BY_ZERO'
  | 'DECIMAL_RESCALE_REQUIRED'
  | 'INVALID_UTF8'
  | 'INVALID_JSON'
  | 'JSON_DUPLICATE_KEY'
  | 'JSON_DEPTH_LIMIT'
  | 'JSON_PATH_ERROR'
  | 'VECTOR_DIMENSION_MISMATCH'
  | 'VECTOR_VALUE_INVALID'
  | 'SEMANTIC_RESOURCE_LIMIT'
  | 'UNSUPPORTED_OPERATION'

export class KernelError extends Error {
  readonly code: KernelErrorCode
  readonly position: number | undefined

  constructor(code: KernelErrorCode, message: string, position?: number) {
    super(message)
    this.name = 'KernelError'
    this.code = code
    this.position = position
  }
}

export function kernelAssert(
  condition: unknown,
  code: KernelErrorCode,
  message: string,
  position?: number,
): asserts condition {
  if (!condition) throw new KernelError(code, message, position)
}
