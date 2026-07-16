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
  canonicalSqlValueToCbor,
  canonicalizeSqlResult,
  digestCanonicalSqlResult,
  encodeCanonicalSqlResult,
  encodeCanonicalCbor,
  equalBytes,
  numberToCanonicalReal,
  type AcceptedPreconditionResult,
  type AcceptedStatementResult,
  type CanonicalSqlResult,
  type CanonicalSchemaIdentity,
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
    readonly constraintIdentity: CanonicalSchemaIdentity | null = null,
    readonly triggerIdentity: CanonicalSchemaIdentity | null = null,
  ) {
    super(code)
    this.name = 'DeterministicSqlRejection'
  }
}

export interface SqlResultExecutionLimits {
  readonly maxColumnsPerStatement: number
  readonly maxRowsPerStatement: number
  readonly maxBytesPerStatement: number
  readonly maxTransactionRows: number
  readonly maxValueBytes: number
  readonly maxSortWork: number
  readonly maxOrderedMutationTargets: number
  readonly maxOrderedMutationIdentityBytes: number
  readonly maxOrderedMutationBindings: number
}

export interface SqlTransactionResultBudget { rows: number }

export async function evaluateSqlPrecondition(
  database: DatabaseLike,
  precondition: SqlPrecondition,
  index: number,
  maximumRows: number,
  maximumBytes: number,
  sqlLimits: Partial<SqlRuntimeLimits> = {},
  resultLimits?: SqlResultExecutionLimits,
  transactionBudget?: SqlTransactionResultBudget,
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
      resultLimits,
      transactionBudget,
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
  resultLimits?: SqlResultExecutionLimits,
  transactionBudget?: SqlTransactionResultBudget,
): AcceptedStatementResult {
  try {
    const compiled = compileSqlStatement(statement, 'body')
    if (compiled.orderedMutation !== null) {
      return executeOrderedMutation(
        database, compiled, index, maximumRows, maximumBytes, sqlLimits,
        resultLimits, transactionBudget,
      )
    }
    if (compiled.producesResult) {
      const result = executeSqlResult(
        database,
        compiled,
        compiled.resultMode ?? 'multiset',
        maximumRows,
        maximumBytes,
        'consensus_body',
        sqlLimits,
        resultLimits,
        transactionBudget,
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
  resultLimits?: SqlResultExecutionLimits,
  transactionBudget?: SqlTransactionResultBudget,
  bindingOverride?: readonly unknown[],
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
    const backendRows = statement.all(...(bindingOverride ?? bindingValues(compiled)))
    const rowLimit = resultLimits?.maxRowsPerStatement ?? maximumRows
    const byteLimit = resultLimits?.maxBytesPerStatement ?? maximumBytes
    if (backendRows.length > Math.min(maximumRows, rowLimit)) throw new SqlProfileError('SQL_RESULT_ROW_LIMIT')
    const columns = statement.columns().map((column, index) => ({
      nameUtf8: new TextEncoder().encode(column.name ?? `column_${index}`),
      type: { kind: 'dynamic' as const },
      nullable: 'unknown' as const,
    }))
    if (resultLimits !== undefined && columns.length > resultLimits.maxColumnsPerStatement) {
      throw new SqlProfileError('SQL_RESULT_COLUMN_LIMIT')
    }
    const rows = backendRows.map((row) => {
      const values = Array.isArray(row) ? row : columns.map((column) => row[new TextDecoder().decode(column.nameUtf8)])
      if (values.length !== columns.length) throw new Error('SQL_BACKEND_RESULT_WIDTH_MISMATCH')
      return values.map((value) => {
        const canonical = databaseValueToCanonicalSqlValue(value)
        if (
          resultLimits !== undefined &&
          encodeCanonicalCbor(canonicalSqlValueToCbor(canonical)).length > resultLimits.maxValueBytes
        ) throw new SqlProfileError('SQL_RESULT_VALUE_BYTE_LIMIT')
        return canonical
      })
    })
    if (transactionBudget !== undefined && resultLimits !== undefined) {
      transactionBudget.rows += rows.length
      if (transactionBudget.rows > resultLimits.maxTransactionRows) {
        throw new SqlProfileError('SQL_TRANSACTION_RESULT_ROW_LIMIT')
      }
    }
    if ((mode === 'multiset' || mode === 'set') && resultLimits !== undefined) {
      const rowBytes = rows.reduce((total, row) => total + encodeCanonicalCbor(row.map(canonicalSqlValueToCbor)).length, 0)
      const comparisonWork = rows.length * ceilLog2(Math.max(1, rows.length))
      if (rowBytes + comparisonWork > resultLimits.maxSortWork) throw new SqlProfileError('SQL_RESULT_SORT_WORK_LIMIT')
    }
    const result = canonicalizeSqlResult({ mode, columns, rows })
    if (encodeCanonicalSqlResult(result).length > Math.min(maximumBytes, byteLimit)) {
      throw new SqlProfileError('SQL_RESULT_BYTE_LIMIT')
    }
    return result
  }, sqlLimits)
}

function executeOrderedMutation(
  database: DatabaseLike,
  compiled: CompiledSqlSource,
  statementIndex: number,
  maximumRows: number,
  maximumBytes: number,
  sqlLimits: Partial<SqlRuntimeLimits>,
  resultLimits?: SqlResultExecutionLimits,
  transactionBudget?: SqlTransactionResultBudget,
): AcceptedStatementResult {
  const plan = compiled.orderedMutation!
  const identityPlan = assertOrderedMutationProof(database, compiled)
  const authoredBindings = bindingValues(compiled)
  const selectionSql = plan.selectionSqlTemplate
    .replace(plan.selectionColumnsToken, identityPlan.selectExpressions.join(', '))
    .replace(plan.identityOrderToken, identityPlan.orderExpressions.join(', '))
  const targetLimit = resultLimits?.maxOrderedMutationTargets ?? maximumRows
  const boundedSelectionSql = `SELECT * FROM (${selectionSql}) AS chronolog_ordered_targets LIMIT ${targetLimit + 1}`
  const identities = withProfiledStatement(database, boundedSelectionSql, 'consensus_body', (statement) => {
    statement.setReturnArrays?.(true)
    statement.setReadBigInts?.(true)
    const selectionBindings = authoredBindings.slice(0, plan.selectionMaximumParameterIndex)
    return statement.all(...selectionBindings).map((row) => {
      if (!Array.isArray(row) || row.length !== identityPlan.selectExpressions.length) {
        throw new Error('SQL_ORDERED_MUTATION_IDENTITY_WIDTH_INVALID')
      }
      return row.map((value) => {
        const canonical = databaseValueToCanonicalSqlValue(value)
        if (canonical.kind === 'null') throw new SqlProfileError('SQL_ORDERED_MUTATION_IDENTITY_INVALID')
        return { databaseValue: value, canonical }
      })
    })
  }, sqlLimits)
  const canonicalIdentityVector = identities.map((identity) => identity.map((component) => canonicalSqlValueToCbor(component.canonical)))
  const unique = new Set(canonicalIdentityVector.map((identity) => Buffer.from(encodeCanonicalCbor(identity)).toString('base64url')))
  if (unique.size !== identities.length) throw new SqlProfileError('SQL_ORDERED_MUTATION_IDENTITY_DUPLICATE')
  const identityComponents = identities.length * identityPlan.predicateColumns.length
  if (resultLimits !== undefined) {
    if (identities.length > resultLimits.maxOrderedMutationTargets) {
      throw new SqlProfileError('SQL_ORDERED_MUTATION_TARGET_LIMIT')
    }
    if (encodeCanonicalCbor(canonicalIdentityVector).length > resultLimits.maxOrderedMutationIdentityBytes) {
      throw new SqlProfileError('SQL_ORDERED_MUTATION_IDENTITY_BYTE_LIMIT')
    }
    if (compiled.maximumParameterIndex + identityComponents > resultLimits.maxOrderedMutationBindings) {
      throw new SqlProfileError('SQL_ORDERED_MUTATION_BINDING_LIMIT')
    }
  }
  if (compiled.maximumParameterIndex + identityComponents > 1_000) {
    throw new SqlProfileError('SQL_ORDERED_MUTATION_BINDING_LIMIT')
  }
  const predicate = renderIdentityPredicate(identityPlan.predicateColumns, identities.length, compiled.maximumParameterIndex)
  const mutationSql = plan.mutationSqlTemplate.replace(plan.identityPredicateToken, predicate)
  const allBindings = [...authoredBindings, ...identities.flatMap((identity) => identity.map((component) => component.databaseValue))]
  if (compiled.producesResult) {
    const result = executeSqlResult(
      database,
      { ...compiled, source: { ...compiled.source, sql: mutationSql }, orderedMutation: null },
      'multiset', maximumRows, maximumBytes, 'consensus_body', sqlLimits,
      resultLimits, transactionBudget, allBindings,
    )
    return {
      index: statementIndex,
      statementClass: compiled.statementClass,
      affectedRows: readChanges(database),
      result,
    }
  }
  const execution = withProfiledStatement(database, mutationSql, 'consensus_body', (statement) =>
    statement.run(...allBindings), sqlLimits)
  return {
    index: statementIndex,
    statementClass: compiled.statementClass,
    affectedRows: typeof execution.changes === 'bigint' ? execution.changes : BigInt(execution.changes),
    result: null,
  }
}

interface OrderedTableIdentityPlan {
  readonly selectExpressions: readonly string[]
  readonly orderExpressions: readonly string[]
  readonly predicateColumns: readonly string[]
}

function assertOrderedMutationProof(database: DatabaseLike, compiled: CompiledSqlSource): OrderedTableIdentityPlan {
  const plan = compiled.orderedMutation!
  const schema = database.prepare(`SELECT type, sql FROM sqlite_schema WHERE name = ? AND type IN ('table', 'view')`).get(plan.targetTable)
  if (schema === undefined || Array.isArray(schema) || schema.type !== 'table' || typeof schema.sql !== 'string') {
    throw new SqlProfileError('SQL_ORDERED_MUTATION_REAL_TABLE_REQUIRED')
  }
  const withoutRowid = /\bWITHOUT\s+ROWID\b/iu.test(schema.sql)
  if (/\bVIRTUAL\s+TABLE\b/iu.test(schema.sql)) throw new SqlProfileError('SQL_ORDERED_MUTATION_REAL_TABLE_REQUIRED')
  const triggers = database.prepare(`SELECT 1 AS present FROM sqlite_schema WHERE type = 'trigger' AND tbl_name = ? LIMIT 1`).get(plan.targetTable)
  if (triggers !== undefined) throw new SqlProfileError('SQL_ORDERED_MUTATION_TRIGGER_GATED')
  const quotedTarget = plan.targetTable.replaceAll('"', '""')
  const columns = database.prepare(`PRAGMA main.table_xinfo("${quotedTarget}")`).all()
  let integerPrimaryKey: string | null = null
  const primaryKeyNames: string[] = []
  for (const row of columns) {
    if (Array.isArray(row)) throw new Error('SQL_ORDERED_MUTATION_SCHEMA_ROW_INVALID')
    const hidden = Number(row.hidden ?? 0)
    if (hidden !== 0) throw new SqlProfileError('SQL_ORDERED_MUTATION_GENERATED_COLUMN_GATED')
    if (Number(row.pk ?? 0) === 1 && typeof row.type === 'string' && /^INTEGER$/iu.test(row.type) && typeof row.name === 'string') {
      integerPrimaryKey = row.name.toLowerCase()
    }
    if (Number(row.pk ?? 0) > 0 && typeof row.name === 'string') primaryKeyNames.push(row.name.toLowerCase())
  }
  if (plan.assignedColumns.some((column) =>
    column === 'rowid' || column === '_rowid_' || column === 'oid' ||
    column === integerPrimaryKey || primaryKeyNames.includes(column))) {
    throw new SqlProfileError('SQL_ORDERED_MUTATION_IDENTITY_UPDATE_GATED')
  }
  const indexes = database.prepare(`PRAGMA main.index_list("${quotedTarget}")`).all()
  if (indexes.some((row) => !Array.isArray(row) && Number(row.unique ?? 0) !== 0 && row.origin !== 'pk')) {
    throw new SqlProfileError('SQL_ORDERED_MUTATION_UNIQUE_KEY_GATED')
  }
  if (database.prepare(`PRAGMA main.foreign_key_list("${quotedTarget}")`).all().length > 0) {
    throw new SqlProfileError('SQL_ORDERED_MUTATION_FOREIGN_KEY_GATED')
  }
  const referencingTable = database.prepare(`SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND upper(sql) LIKE '%REFERENCES%' LIMIT 1`).get()
  if (referencingTable !== undefined) throw new SqlProfileError('SQL_ORDERED_MUTATION_FOREIGN_KEY_GATED')
  if (!withoutRowid) return { selectExpressions: ['rowid'], orderExpressions: ['rowid'], predicateColumns: ['rowid'] }
  const primaryIndex = indexes.find((row) => !Array.isArray(row) && row.origin === 'pk' && typeof row.name === 'string')
  if (primaryIndex === undefined || Array.isArray(primaryIndex) || typeof primaryIndex.name !== 'string') {
    throw new SqlProfileError('SQL_ORDERED_MUTATION_PRIMARY_KEY_GATED')
  }
  const quotedIndex = primaryIndex.name.replaceAll('"', '""')
  const primaryColumns = database.prepare(`PRAGMA main.index_xinfo("${quotedIndex}")`).all()
    .filter((row) => !Array.isArray(row) && Number(row.key ?? 0) === 1 && Number(row.cid ?? -1) >= 0)
    .sort((left, right) => Number((left as Record<string, unknown>).seqno) - Number((right as Record<string, unknown>).seqno))
  if (primaryColumns.length === 0) throw new SqlProfileError('SQL_ORDERED_MUTATION_PRIMARY_KEY_GATED')
  const selectExpressions: string[] = []
  const orderExpressions: string[] = []
  for (const row of primaryColumns) {
    if (Array.isArray(row) || typeof row.name !== 'string' || typeof row.coll !== 'string') {
      throw new SqlProfileError('SQL_ORDERED_MUTATION_PRIMARY_KEY_GATED')
    }
    const collation = row.coll.toUpperCase()
    if (collation !== 'BINARY' && collation !== 'NOCASE' && collation !== 'RTRIM') {
      throw new SqlProfileError('SQL_ORDERED_MUTATION_PRIMARY_KEY_COLLATION_GATED')
    }
    const column = `"${row.name.replaceAll('"', '""')}"`
    selectExpressions.push(column)
    orderExpressions.push(`${column} COLLATE "${collation}" ${Number(row.desc ?? 0) === 0 ? 'ASC' : 'DESC'}`)
  }
  return { selectExpressions, orderExpressions, predicateColumns: selectExpressions }
}

function renderIdentityPredicate(columns: readonly string[], rowCount: number, firstParameter: number): string {
  if (rowCount === 0) return firstParameter === 0
    ? '0'
    : `0 AND (?${firstParameter} IS NULL OR ?${firstParameter} IS NOT NULL)`
  let parameter = firstParameter
  const rows = Array.from({ length: rowCount }, () => {
    const values = columns.map(() => `?${++parameter}`)
    return columns.length === 1 ? values[0]! : `(${values.join(', ')})`
  })
  const left = columns.length === 1 ? columns[0]! : `(${columns.join(', ')})`
  return `${left} IN (${rows.join(', ')})`
}

function ceilLog2(value: number): number {
  if (value <= 1) return 0
  return Math.ceil(Math.log2(value))
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
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new SqlProfileError('SQL_NONFINITE_REAL_RESULT')
    return numberToCanonicalReal(value)
  }
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
