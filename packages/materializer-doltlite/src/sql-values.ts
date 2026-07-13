import { SqlProfileError, withProfiledStatement } from './sql-profile.js'
import type { DatabaseLike, LocalSqlValue, SqlRuntimeLimits } from './types.js'

/**
 * Execute explicitly local, non-consensus SQL against an immutable reader.
 * These tagged values deliberately have no canonical transaction encoding.
 */
export function executeLocalSql(
  database: DatabaseLike,
  sql: string,
  parameters: readonly LocalSqlValue[] = [],
  inputLimits: Partial<SqlRuntimeLimits> = {},
): {
  readonly columns: readonly { readonly name: string; readonly declaredType?: string }[]
  readonly rows: readonly (readonly LocalSqlValue[])[]
} {
  return withProfiledStatement(database, sql, 'local_read', (statement) => {
    statement.setReturnArrays?.(true)
    statement.setReadBigInts?.(true)
    const rows = statement.all(...parameters.map(localValueToDatabaseValue))
    const maximumRows = inputLimits.maxResultRows ?? 10_000
    const maximumBytes = inputLimits.maxResultBytes ?? 16 * 1024 * 1024
    if (rows.length > maximumRows) throw new SqlProfileError('SQL_RESULT_LIMIT')
    const columns = statement.columns().map((column, index) => ({
      name: column.name ?? `column_${index}`,
    }))
    const resultRows = rows.map((row) => {
      const values = Array.isArray(row) ? row : columns.map((column) => row[column.name])
      return values.map(databaseValueToLocalValue)
    })
    if (approximateResultBytes(columns, resultRows) > maximumBytes) {
      throw new SqlProfileError('SQL_RESULT_LIMIT')
    }
    return { columns, rows: resultRows }
  }, inputLimits)
}

function localValueToDatabaseValue(value: LocalSqlValue): unknown {
  switch (value.kind) {
    case 'null': return null
    case 'integer': {
      if (!/^-?(0|[1-9][0-9]*)$/u.test(value.value)) throw new SqlProfileError('SQL_INVALID_INTEGER_PARAMETER')
      const parsed = BigInt(value.value)
      if (parsed < -(1n << 63n) || parsed > (1n << 63n) - 1n) {
        throw new SqlProfileError('SQL_INVALID_INTEGER_PARAMETER')
      }
      return parsed
    }
    case 'real':
      if (!Number.isFinite(value.value)) throw new SqlProfileError('SQL_INVALID_REAL_PARAMETER')
      return value.value
    case 'text': return value.value
    case 'blob': return Uint8Array.from(value.value)
  }
}

function databaseValueToLocalValue(value: unknown): LocalSqlValue {
  if (value === null) return { kind: 'null' }
  if (typeof value === 'bigint') return { kind: 'integer', value: value.toString(10) }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('SQL_UNSUPPORTED_RESULT_TYPE')
    if (Number.isSafeInteger(value)) return { kind: 'integer', value: String(value) }
    return { kind: 'real', value }
  }
  if (typeof value === 'string') return { kind: 'text', value }
  if (value instanceof Uint8Array || Buffer.isBuffer(value)) {
    return { kind: 'blob', value: Uint8Array.from(value) }
  }
  throw new Error('SQL_UNSUPPORTED_RESULT_TYPE')
}

function approximateResultBytes(
  columns: readonly { readonly name: string }[],
  rows: readonly (readonly LocalSqlValue[])[],
): number {
  let total = columns.reduce((sum, column) => sum + Buffer.byteLength(column.name), 0)
  for (const row of rows) for (const value of row) {
    switch (value.kind) {
      case 'null': total += 1; break
      case 'integer': total += Buffer.byteLength(value.value); break
      case 'real': total += 8; break
      case 'text': total += Buffer.byteLength(value.value); break
      case 'blob': total += value.value.length; break
    }
    if (!Number.isSafeInteger(total)) return Number.MAX_SAFE_INTEGER
  }
  return total
}
