import type { LocalSqlResult, LocalSqlValue } from '@chronolog/rpc'

export type LocalSqlInput = null | bigint | number | string | Uint8Array | LocalSqlValue
export type DecodedLocalSqlValue = null | bigint | number | string | Uint8Array

/**
 * Structural shape emitted by common SQL builders and ORMs after compilation.
 * Chronolog intentionally does not depend on any one query-building library.
 */
export interface CompiledLocalSqlQuery {
  readonly sql: string
  readonly parameters?: readonly unknown[]
}

const MIN_INT64 = -(2n ** 63n)
const MAX_INT64 = 2n ** 63n - 1n

function isLocalSqlValue(value: unknown): value is LocalSqlValue {
  if (typeof value !== 'object' || value === null || ArrayBuffer.isView(value) || !('kind' in value)) return false
  const tagged = value as { readonly kind?: unknown; readonly value?: unknown }
  switch (tagged.kind) {
    case 'null': return true
    case 'integer': return typeof tagged.value === 'string'
    case 'real': return typeof tagged.value === 'number'
    case 'text': return typeof tagged.value === 'string'
    case 'blob': return tagged.value instanceof Uint8Array
    default: return false
  }
}

function encodeUnknownLocalSqlValue(value: unknown): LocalSqlValue {
  if (
    value === null ||
    typeof value === 'bigint' ||
    typeof value === 'number' ||
    typeof value === 'string' ||
    value instanceof Uint8Array ||
    isLocalSqlValue(value)
  ) return encodeLocalSqlValue(value)
  throw new TypeError('Local SQL parameters must be null, bigint, number, string, Uint8Array, or LocalSqlValue')
}

function integerValue(value: bigint | string): string {
  const parsed = typeof value === 'bigint' ? value : BigInt(value)
  if (parsed < MIN_INT64 || parsed > MAX_INT64) throw new RangeError('Local SQL integer is outside signed 64-bit range')
  return parsed.toString(10)
}

export function encodeLocalSqlValue(value: LocalSqlInput): LocalSqlValue {
  if (isLocalSqlValue(value)) {
    switch (value.kind) {
      case 'null': return localSqlValue.null()
      case 'integer': return localSqlValue.integer(value.value)
      case 'real': return localSqlValue.real(value.value)
      case 'text': return localSqlValue.text(value.value)
      case 'blob': return localSqlValue.blob(value.value)
    }
  }
  if (value === null) return localSqlValue.null()
  if (typeof value === 'bigint') return localSqlValue.integer(value)
  if (typeof value === 'string') return localSqlValue.text(value)
  if (value instanceof Uint8Array) return localSqlValue.blob(value)
  if (!Number.isFinite(value)) throw new TypeError('Local SQL numbers must be finite')
  if (Number.isSafeInteger(value)) return localSqlValue.integer(BigInt(value))
  return localSqlValue.real(value)
}

export function encodeLocalSqlParameters(parameters: readonly LocalSqlInput[] = []): readonly LocalSqlValue[] {
  return parameters.map(encodeLocalSqlValue)
}

/** Normalizes an ORM/query-builder compiled query without introducing an ORM dependency. */
export function encodeCompiledLocalSqlQuery(query: CompiledLocalSqlQuery): {
  readonly sql: string
  readonly parameters: readonly LocalSqlValue[]
} {
  if (typeof query.sql !== 'string') throw new TypeError('Compiled local SQL must contain a SQL string')
  if (query.parameters !== undefined && !Array.isArray(query.parameters)) {
    throw new TypeError('Compiled local SQL parameters must be an array')
  }
  return Object.freeze({
    sql: query.sql,
    parameters: Object.freeze((query.parameters ?? []).map(encodeUnknownLocalSqlValue)),
  })
}

export function decodeLocalSqlValue(value: LocalSqlValue): DecodedLocalSqlValue {
  switch (value.kind) {
    case 'null': return null
    case 'integer': return BigInt(value.value)
    case 'real': return value.value
    case 'text': return value.value
    case 'blob': return Uint8Array.from(value.value)
  }
}

export interface DecodedLocalSqlResult {
  readonly columns: LocalSqlResult['columns']
  readonly rows: readonly (readonly DecodedLocalSqlValue[])[]
  readonly truncated: boolean
  readonly consensusSafe: false
  readonly raw: LocalSqlResult
}

export function decodeLocalSqlResult(result: LocalSqlResult): DecodedLocalSqlResult {
  return Object.freeze({
    columns: result.columns.map((column) => Object.freeze({ ...column })),
    rows: result.rows.map((row) => Object.freeze(row.map(decodeLocalSqlValue))),
    truncated: result.truncated,
    consensusSafe: false as const,
    raw: result,
  })
}

export function localSqlRowsAsObjects(
  result: DecodedLocalSqlResult,
): readonly Readonly<Record<string, DecodedLocalSqlValue>>[] {
  return result.rows.map((row) => {
    const object: Record<string, DecodedLocalSqlValue> = {}
    for (let index = 0; index < result.columns.length; index += 1) {
      const column = result.columns[index]
      const value = row[index]
      if (column !== undefined && value !== undefined) object[column.name] = value
    }
    return Object.freeze(object)
  })
}

export const localSqlValue = {
  null: (): LocalSqlValue => ({ kind: 'null' }),
  integer: (value: bigint | string): LocalSqlValue => ({ kind: 'integer', value: integerValue(value) }),
  real: (value: number): LocalSqlValue => {
    if (!Number.isFinite(value)) throw new TypeError('Local SQL real values must be finite')
    return { kind: 'real', value }
  },
  text: (value: string): LocalSqlValue => ({ kind: 'text', value }),
  blob: (value: Uint8Array): LocalSqlValue => ({ kind: 'blob', value: Uint8Array.from(value) }),
} as const
