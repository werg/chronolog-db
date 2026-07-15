import { canonicalJsonToText, type LogicalValue } from '@chronolog/ir'
import { formatDecimal } from '@chronolog/kernels'
import {
  compileSqlStatement,
  completeOrderedResultSql,
  orderedSqlBindingValues,
  SqlCompilerError,
  type CompiledSqlSource,
} from '@chronolog/compiler-sqlite'
import {
  canonicalRealToNumber,
  canonicalizeSqlResult,
  digestCanonicalSqlResult,
  encodeCanonicalSqlResult,
  equalBytes,
  numberToCanonicalReal,
  type AcceptedPreconditionResult,
  type AcceptedStatementResult,
  type CanonicalSqlResult,
  type CanonicalSqlValue,
  type SqlPrecondition,
  type SqlResultMode,
  type SqlStatement,
} from '@chronolog/protocol'

import { SqlProfileError, sqlitePrimaryCode, withProfiledStatement } from './sql-profile.js'
import type { DatabaseLike, SqlRuntimeLimits } from './types.js'

export class DeterministicSqlRejection extends Error {
  constructor(
    readonly code: string,
    readonly phase: 'precondition' | 'statement' | 'finalize',
    readonly preconditionId: number | null = null,
    readonly preconditionIndex: number | null = null,
    readonly statementIndex: number | null = null,
    readonly failingConstraintId: number | null = null,
  ) {
    super(code)
    this.name = 'DeterministicSqlRejection'
  }
}

export async function evaluateSqlPrecondition(
  database: DatabaseLike,
  precondition: SqlPrecondition,
  index: number,
  maximumRows: number,
  maximumBytes: number,
  sqlLimits: Partial<SqlRuntimeLimits> = {},
): Promise<AcceptedPreconditionResult> {
  try {
    const compiled = compileSqlStatement(precondition.query, 'precondition')
    const result = executeSqlResult(
      database,
      compiled,
      precondition.resultMode,
      maximumRows,
      maximumBytes,
      'consensus_precondition',
      sqlLimits,
    )
    if (precondition.expectation.kind === 'assert_true') {
      if (!isTrueScalar(result)) throw new DeterministicSqlRejection(
        'SQL_ASSERTION_FALSE', 'precondition', precondition.id, index,
      )
    } else if (precondition.expectation.kind === 'inline') {
      if (!equalBytes(encodeCanonicalSqlResult(result), encodeCanonicalSqlResult(precondition.expectation.result))) {
        throw new DeterministicSqlRejection(
          'SQL_EXPECTATION_MISMATCH', 'precondition', precondition.id, index,
        )
      }
    } else if (!equalBytes(await digestCanonicalSqlResult(result), precondition.expectation.digest)) {
      throw new DeterministicSqlRejection(
        'SQL_EXPECTATION_MISMATCH', 'precondition', precondition.id, index,
      )
    }
    return { index, id: precondition.id, resultDigest: await digestCanonicalSqlResult(result) }
  } catch (error) {
    if (error instanceof DeterministicSqlRejection) throw error
    if (error instanceof SqlCompilerError || error instanceof SqlProfileError) {
      throw new DeterministicSqlRejection(error.code, 'precondition', precondition.id, index)
    }
    throw mapSqliteRejection(error, 'precondition', precondition.id, index, null)
  }
}

export function executeSqlBodyStatement(
  database: DatabaseLike,
  statement: SqlStatement,
  index: number,
  maximumRows: number,
  maximumBytes: number,
  sqlLimits: Partial<SqlRuntimeLimits> = {},
): AcceptedStatementResult {
  try {
    const compiled = compileSqlStatement(statement, 'body')
    if (compiled.producesResult) {
      const result = executeSqlResult(
        database,
        compiled,
        compiled.resultMode ?? 'multiset',
        maximumRows,
        maximumBytes,
        'consensus_body',
        sqlLimits,
      )
      return {
        index,
        statementClass: compiled.statementClass,
        affectedRows: isDml(compiled) ? readChanges(database) : null,
        result,
      }
    }
    const execution = withProfiledStatement(database, statement.sql, 'consensus_body', (prepared) => {
      try { return prepared.run(...bindingValues(compiled)) }
      catch (error) { throw mapSqliteRejection(error, 'statement', null, null, index) }
    }, sqlLimits)
    return {
      index,
      statementClass: compiled.statementClass,
      affectedRows: isDml(compiled)
        ? typeof execution.changes === 'bigint' ? execution.changes : BigInt(execution.changes)
        : null,
      result: null,
    }
  } catch (error) {
    if (error instanceof DeterministicSqlRejection) throw error
    if (error instanceof SqlCompilerError || error instanceof SqlProfileError) {
      throw new DeterministicSqlRejection(error.code, 'statement', null, null, index)
    }
    throw mapSqliteRejection(error, 'statement', null, null, index)
  }
}

export function executeSqlObservation(
  database: DatabaseLike,
  statement: SqlStatement,
  resultMode: SqlResultMode,
  maximumRows: number,
  maximumBytes: number,
  sqlLimits: Partial<SqlRuntimeLimits> = {},
): CanonicalSqlResult {
  const compiled = compileSqlStatement(statement, 'precondition')
  return executeSqlResult(
    database, compiled, resultMode, maximumRows, maximumBytes,
    'consensus_precondition', sqlLimits,
  )
}

function executeSqlResult(
  database: DatabaseLike,
  compiled: CompiledSqlSource,
  mode: SqlResultMode,
  maximumRows: number,
  maximumBytes: number,
  authorizationMode: 'consensus_precondition' | 'consensus_body',
  sqlLimits: Partial<SqlRuntimeLimits>,
): CanonicalSqlResult {
  if (mode === 'ordered' && compiled.resultMode !== 'ordered') {
    throw new SqlProfileError('SQL_ORDERED_RESULT_REQUIRES_ORDER_BY')
  }
  const executionSql = compiled.resultMode === 'ordered'
    ? completeOrderedResultSql(compiled, withProfiledStatement(
      database,
      compiled.source.sql,
      authorizationMode,
      (statement) => statement.columns().length,
      sqlLimits,
    ))
    : compiled.source.sql
  return withProfiledStatement(database, executionSql, authorizationMode, (statement) => {
    statement.setReturnArrays?.(true)
    statement.setReadBigInts?.(true)
    const backendRows = statement.all(...bindingValues(compiled))
    if (backendRows.length > maximumRows) throw new SqlProfileError('SQL_RESULT_ROW_LIMIT')
    const columns = statement.columns().map((column, index) => ({
      nameUtf8: new TextEncoder().encode(column.name ?? `column_${index}`),
      type: { kind: 'dynamic' as const },
      nullable: 'unknown' as const,
    }))
    const rows = backendRows.map((row) => {
      const values = Array.isArray(row) ? row : columns.map((column) => row[new TextDecoder().decode(column.nameUtf8)])
      if (values.length !== columns.length) throw new Error('SQL_BACKEND_RESULT_WIDTH_MISMATCH')
      return values.map(databaseValueToCanonicalSqlValue)
    })
    const result = canonicalizeSqlResult({ mode, columns, rows })
    if (encodeCanonicalSqlResult(result).length > maximumBytes) {
      throw new SqlProfileError('SQL_RESULT_BYTE_LIMIT')
    }
    return result
  }, sqlLimits)
}

function bindingValues(compiled: CompiledSqlSource): unknown[] {
  return orderedSqlBindingValues(compiled).map(logicalValueToDatabaseValue)
}

function logicalValueToDatabaseValue(value: LogicalValue): unknown {
  switch (value.kind) {
    case 'null': return null
    case 'boolean': return value.value ? 1n : 0n
    case 'int64': case 'timestamp_ms': case 'duration_ms': return value.value
    case 'decimal': return formatDecimal(value)
    case 'text': return new TextDecoder('utf-8', { fatal: true }).decode(value.utf8)
    case 'blob': case 'uuid': return Uint8Array.from(value.bytes)
    case 'json': return canonicalJsonToText(value.value)
    case 'vector': return Uint8Array.from(value.bytes)
  }
}

function databaseValueToCanonicalSqlValue(value: unknown): CanonicalSqlValue {
  if (value === null) return { kind: 'null' }
  if (typeof value === 'bigint') {
    if (value < -(1n << 63n) || value > (1n << 63n) - 1n) throw new Error('SQL_BACKEND_INTEGER_OUT_OF_RANGE')
    return { kind: 'integer', value }
  }
  if (typeof value === 'number') return numberToCanonicalReal(value)
  if (typeof value === 'string') return { kind: 'text', utf8: new TextEncoder().encode(value) }
  if (value instanceof Uint8Array || Buffer.isBuffer(value)) {
    return { kind: 'blob', bytes: Uint8Array.from(value) }
  }
  throw new Error('SQL_BACKEND_VALUE_UNSUPPORTED')
}

function isTrueScalar(result: CanonicalSqlResult): boolean {
  if (result.mode !== 'scalar' || result.columns.length !== 1 || result.rows.length !== 1) return false
  const value = result.rows[0]?.[0]
  if (value?.kind === 'integer') return value.value !== 0n
  if (value?.kind === 'real') return canonicalRealToNumber(value) !== 0
  return value?.kind === 'logical' && value.value.kind === 'boolean' && value.value.value
}

function readChanges(database: DatabaseLike): bigint {
  const statement = database.prepare('SELECT changes() AS direct_changes')
  statement.setReadBigInts?.(true)
  const row = statement.get()
  if (row === undefined || Array.isArray(row)) throw new Error('SQL_CHANGES_UNAVAILABLE')
  const value = row.direct_changes
  if (typeof value === 'bigint') return value
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value)
  throw new Error('SQL_CHANGES_INVALID')
}

function isDml(compiled: CompiledSqlSource): boolean {
  return compiled.statementClass === 'insert' || compiled.statementClass === 'update' || compiled.statementClass === 'delete'
}

function mapSqliteRejection(
  error: unknown,
  phase: 'precondition' | 'statement',
  preconditionId: number | null,
  preconditionIndex: number | null,
  statementIndex: number | null,
): Error {
  const code = sqlitePrimaryCode(error)
  if (code === 18) return new DeterministicSqlRejection('SQL_VALUE_TOO_LARGE', phase, preconditionId, preconditionIndex, statementIndex)
  if (code === 19) return new DeterministicSqlRejection('SQL_CONSTRAINT_VIOLATION', phase, preconditionId, preconditionIndex, statementIndex)
  if (code === 20 || code === 25) return new DeterministicSqlRejection('SQL_TYPE_MISMATCH', phase, preconditionId, preconditionIndex, statementIndex)
  if (code === 1) return new DeterministicSqlRejection('SQL_EVALUATION_ERROR', phase, preconditionId, preconditionIndex, statementIndex)
  return error instanceof Error ? error : new Error('SQL_EXECUTION_FAILED', { cause: error })
}
