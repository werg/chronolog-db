export type RpcErrorCode =
  | 'cancelled'
  | 'deadline_exceeded'
  | 'transport_unavailable'
  | 'unauthenticated'
  | 'permission_denied'
  | 'invalid_argument'
  | 'not_found'
  | 'already_exists'
  | 'resource_exhausted'
  | 'failed_precondition'
  | 'revision_unavailable'
  | 'draft_expired'
  | 'node_starting'
  | 'node_replaying'
  | 'protocol_rejected'
  | 'internal'

const RETRYABLE_CODES = new Set<RpcErrorCode>([
  'deadline_exceeded',
  'transport_unavailable',
  'resource_exhausted',
  'node_starting',
  'node_replaying',
])

export class ChronologRpcError extends Error {
  readonly code: RpcErrorCode
  readonly retryable: boolean
  readonly details?: Readonly<Record<string, string>>

  constructor(
    code: RpcErrorCode,
    message: string,
    options: {
      readonly cause?: unknown
      readonly retryable?: boolean
      readonly details?: Readonly<Record<string, string>>
    } = {},
  ) {
    super(message, { cause: options.cause })
    this.name = 'ChronologRpcError'
    this.code = code
    this.retryable = options.retryable ?? RETRYABLE_CODES.has(code)
    if (options.details !== undefined) this.details = options.details
  }
}

export function isChronologRpcError(error: unknown): error is ChronologRpcError {
  return error instanceof ChronologRpcError
}

export function toChronologRpcError(error: unknown): ChronologRpcError {
  if (isChronologRpcError(error)) return error
  if (error instanceof DOMException && error.name === 'AbortError') {
    return new ChronologRpcError('cancelled', 'RPC call was cancelled', { cause: error })
  }
  return new ChronologRpcError(
    'internal',
    error instanceof Error ? error.message : 'Unknown RPC failure',
    { cause: error },
  )
}
