import type { LocalSqlResult, LocalSqlValue } from '@chronolog/rpc'

export type LocalSqlInput = null | bigint | number | string | Uint8Array | LocalSqlValue
export type DecodedLocalSqlValue = null | bigint | number | string | Uint8Array

const MIN_INT64 = -(2n ** 63n)
const MAX_INT64 = 2n ** 63n - 1n

function isLocalSqlValue(value: LocalSqlInput): value is LocalSqlValue {
  return typeof value === 'object' && value !== null && !ArrayBuffer.isView(value) && 'kind' in value
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
