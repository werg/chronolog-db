import {
  canonicalJsonFromText,
  canonicalJsonToText,
  encodeCanonicalQueryResult,
  encodeLogicalValues,
  digestCanonicalQueryResult,
  type AffectedRowsExpectation,
  type CanonicalQueryResult,
  type LogicalValue,
  type ValueType,
} from '@chronolog/ir'
import { assertDecimalPrecision, decimalRescale, deriveEntropy, formatDecimal, parseDecimal } from '@chronolog/kernels'
import type {
  BackendParameter,
  CompiledMutation,
  CompiledPrecondition,
  CompiledQuery,
  TransactionContextValues,
} from '@chronolog/compiler-sqlite'

import { SqlProfileError, withProfiledStatement } from './sql-profile.js'
import type { DatabaseLike, SqlRuntimeLimits } from './types.js'

export class DeterministicIrRejection extends Error {
  constructor(
    readonly code: string,
    readonly failingPreconditionId: number | null = null,
    readonly failingCommandId: number | null = null,
    readonly failingConstraintId: number | null = null,
  ) {
    super(code)
    this.name = 'DeterministicIrRejection'
  }
}

export async function evaluateCompiledPrecondition(
  database: DatabaseLike,
  precondition: CompiledPrecondition,
  context: TransactionContextValues,
  maximumRows: number,
  maximumBytes: number,
  sqlLimits: Partial<SqlRuntimeLimits> = {},
): Promise<Uint8Array> {
  let actual: CanonicalQueryResult
  try {
    actual = executeCompiledQuery(database, precondition.query, context, maximumRows, maximumBytes, sqlLimits)
  } catch (error) {
    if (error instanceof DeterministicIrRejection) {
      throw new DeterministicIrRejection(
        error.code,
        error.failingPreconditionId ?? precondition.id,
        error.failingCommandId,
        error.failingConstraintId,
      )
    }
    throw error
  }
  if (precondition.kind === 'assert') {
    const value = actual.rows[0]?.[0]
    if (
      actual.columns.length !== 1 || actual.rows.length !== 1 ||
      value?.kind !== 'boolean' || !value.value
    ) {
      throw new DeterministicIrRejection('ASSERTION_FALSE', precondition.id)
    }
  } else {
    const expected = precondition.expected
    if (expected === undefined) throw new Error('COMPILER_EXPECTATION_MISSING')
    if (expected.kind === 'inline') {
      if (!bytesEqual(encodeCanonicalQueryResult(actual), encodeCanonicalQueryResult(expected.result))) {
        throw new DeterministicIrRejection('EXPECTATION_MISMATCH', precondition.id)
      }
    } else {
      const digest = await digestCanonicalQueryResult(actual)
      if (!bytesEqual(digest, expected.digest)) {
        throw new DeterministicIrRejection('EXPECTATION_MISMATCH', precondition.id)
      }
    }
  }
  return digestCanonicalQueryResult(actual)
}

export function executeCompiledQuery(
  database: DatabaseLike,
  query: CompiledQuery,
  context: Readonly<Partial<TransactionContextValues>>,
  maximumRows: number,
  maximumBytes: number,
  sqlLimits: Partial<SqlRuntimeLimits> = {},
  mode: 'consensus_precondition' | 'local_read' = 'consensus_precondition',
): CanonicalQueryResult {
  return withProfiledStatement(database, query.sql, mode, (statement) => {
    statement.setReturnArrays?.(true)
    statement.setReadBigInts?.(true)
    let backendRows: Array<Record<string, unknown> | unknown[]>
    try {
      backendRows = statement.all(...bindBackendParameters(query.parameters, context))
    } catch (error) {
      // Preparation and profile validation happen before this callback. Mapping
      // only step-time SQLITE_ERROR keeps backend/profile mismatches fatal while
      // giving deterministic expression failures a stable consensus outcome.
      if (mode === 'consensus_precondition' && primarySqliteCode(error) === 1) {
        throw new DeterministicIrRejection('SQL_EVALUATION_ERROR')
      }
      throw error
    }
    if (backendRows.length > maximumRows) throw new DeterministicIrRejection('RESULT_ROW_LIMIT')
    let rows = backendRows.map((backendRow) => {
      if (!Array.isArray(backendRow)) throw new Error('BACKEND_ARRAY_ROW_REQUIRED')
      if (backendRow.length !== query.columns.length) throw new Error('BACKEND_RESULT_WIDTH_MISMATCH')
      return backendRow.map((value, index) => decodeLogicalValue(value, query.columns[index]!.valueType))
    })
    if (query.resultMode.kind === 'scalar' && (query.columns.length !== 1 || rows.length > 1)) {
      throw new DeterministicIrRejection('SCALAR_RESULT_CARDINALITY')
    }
    if (query.resultMode.kind === 'multiset' || query.resultMode.kind === 'set') {
      rows = [...rows].sort(compareLogicalRows)
      if (query.resultMode.kind === 'set') {
        rows = rows.filter((row, index) => index === 0 || compareLogicalRows(rows[index - 1]!, row) !== 0)
      }
    }
    const result: CanonicalQueryResult = { resultMode: query.resultMode, columns: query.columns, rows }
    if (encodeCanonicalQueryResult(result).length > maximumBytes) {
      throw new DeterministicIrRejection('RESULT_BYTE_LIMIT')
    }
    return result
  }, sqlLimits)
}

export function executeCompiledMutation(
  database: DatabaseLike,
  mutation: CompiledMutation,
  context: TransactionContextValues,
  sqlLimits: Partial<SqlRuntimeLimits> = {},
): bigint {
  try {
    const result = withProfiledStatement(database, mutation.sql, 'consensus_mutation', (profiled) => {
      try {
        return profiled.run(...bindBackendParameters(mutation.parameters, context))
      } catch (error) {
        // As with queries, this catches execution only. Prepare/profile errors
        // remain operational failures and are never canonicalized as outcomes.
        if (primarySqliteCode(error) === 1) {
          throw new DeterministicIrRejection('SQL_EVALUATION_ERROR')
        }
        throw error
      }
    }, sqlLimits)
    const changes = typeof result.changes === 'bigint' ? result.changes : BigInt(result.changes)
    assertAffectedRows(mutation.source.affectedRows, changes, mutation.id)
    return changes
  } catch (error) {
    if (error instanceof DeterministicIrRejection) {
      throw new DeterministicIrRejection(
        error.code,
        error.failingPreconditionId,
        error.failingCommandId ?? mutation.id,
        error.failingConstraintId,
      )
    }
    const sqliteCode = primarySqliteCode(error)
    if (sqliteCode === 18) throw new DeterministicIrRejection('VALUE_TOO_LARGE', null, mutation.id)
    if (sqliteCode === 19) throw new DeterministicIrRejection('CONSTRAINT_VIOLATION', null, mutation.id)
    if (sqliteCode === 20 || sqliteCode === 25) throw new DeterministicIrRejection('BACKEND_TYPE_MISMATCH', null, mutation.id)
    if (error instanceof SqlProfileError) throw new Error(`COMPILER_BACKEND_PROFILE_MISMATCH:${error.code}`, { cause: error })
    throw error
  }
}

export function bindBackendParameters(
  parameters: readonly BackendParameter[],
  context: Readonly<Partial<TransactionContextValues>>,
): unknown[] {
  return parameters.map((parameter, index) => {
    if (parameter.ordinal !== index + 1) throw new Error('COMPILER_PARAMETER_ORDER_INVALID')
    const value = parameter.source.kind === 'literal'
      ? parameter.source.value
      : parameter.source.kind === 'context'
        ? contextValue(parameter.source.field, context)
        : entropyValue(parameter.source, context)
    return encodeBackendValue(value, parameter.valueType)
  })
}

function entropyValue(
  source: Extract<BackendParameter['source'], { kind: 'entropy' }>,
  context: Readonly<Partial<TransactionContextValues>>,
): LogicalValue {
  const groupId = requiredContextBytes(context.group_id, 32, 32)
  const nonce = requiredContextBytes(context.transaction_nonce, 16)
  try {
    return {
      kind: 'blob',
      bytes: deriveEntropy(groupId, nonce, source.label, BigInt(source.index), source.length),
    }
  } catch {
    throw new DeterministicIrRejection('ENTROPY_DERIVATION_INVALID')
  }
}

function requiredContextBytes(
  value: Uint8Array | undefined,
  minimumLength: number,
  exactLength?: number,
): Uint8Array {
  if (value === undefined) throw new DeterministicIrRejection('TRANSACTION_CONTEXT_UNAVAILABLE')
  if (!(value instanceof Uint8Array) || value.length < minimumLength ||
      (exactLength !== undefined && value.length !== exactLength)) {
    throw new DeterministicIrRejection('TRANSACTION_CONTEXT_INVALID')
  }
  return Uint8Array.from(value)
}

function contextValue(
  field: keyof TransactionContextValues,
  context: Readonly<Partial<TransactionContextValues>>,
): LogicalValue {
  const value = context[field]
  if (value === undefined) throw new DeterministicIrRejection('TRANSACTION_CONTEXT_UNAVAILABLE')
  if (field === 'author_timestamp_ms') return { kind: 'timestamp_ms', value: value as bigint }
  if (field === 'author_feed_sequence') return { kind: 'int64', value: value as bigint }
  return { kind: 'blob', bytes: Uint8Array.from(value as Uint8Array) }
}

function encodeBackendValue(value: LogicalValue, expected: ValueType): unknown {
  if (value.kind === 'null') {
    if (!expected.nullable) throw new DeterministicIrRejection('NULL_NOT_ALLOWED')
    return null
  }
  if (value.kind !== expected.logical.kind) throw new DeterministicIrRejection('VALUE_TYPE_MISMATCH')
  switch (value.kind) {
    case 'boolean': return value.value ? 1n : 0n
    case 'int64':
    case 'timestamp_ms':
    case 'duration_ms': return value.value
    case 'text': return decodeUtf8(value.utf8)
    case 'blob': return Uint8Array.from(value.bytes)
    case 'uuid':
      if (value.bytes.length !== 16) throw new DeterministicIrRejection('UUID_LENGTH')
      return Uint8Array.from(value.bytes)
    case 'decimal': {
      if (expected.logical.kind !== 'decimal' || value.scale > expected.logical.scale) {
        throw new DeterministicIrRejection('DECIMAL_SCALE_MISMATCH')
      }
      try {
        assertDecimalPrecision(decimalRescale(value, expected.logical.scale, 'exact'), expected.logical.precision)
        return formatDecimal(value)
      } catch {
        throw new DeterministicIrRejection('DECIMAL_PRECISION_OVERFLOW')
      }
    }
    case 'json': return canonicalJsonToText(value.value)
    case 'vector': {
      if (expected.logical.kind !== 'vector' || value.element !== expected.logical.element || value.dimensions !== expected.logical.dimensions) {
        throw new DeterministicIrRejection('VECTOR_SHAPE_MISMATCH')
      }
      const expectedBytes = vectorElementWidth(value.element) * value.dimensions
      if (value.bytes.length !== expectedBytes) throw new DeterministicIrRejection('VECTOR_SHAPE_MISMATCH')
      return Uint8Array.from(value.bytes)
    }
  }
}

function decodeLogicalValue(value: unknown, expected: ValueType): LogicalValue {
  if (value === null) {
    if (!expected.nullable) throw new Error('BACKEND_UNEXPECTED_NULL')
    return { kind: 'null' }
  }
  switch (expected.logical.kind) {
    case 'boolean':
      if (value === 0n) return { kind: 'boolean', value: false }
      if (value === 1n) return { kind: 'boolean', value: true }
      throw new Error('BACKEND_BOOLEAN_REPRESENTATION_INVALID')
    case 'int64': return { kind: 'int64', value: requireBigInt(value) }
    case 'timestamp_ms': return { kind: 'timestamp_ms', value: requireBigInt(value) }
    case 'duration_ms': return { kind: 'duration_ms', value: requireBigInt(value) }
    case 'text':
      if (typeof value !== 'string') throw new Error('BACKEND_TEXT_REPRESENTATION_INVALID')
      return { kind: 'text', utf8: encodeUtf8(value) }
    case 'blob': return { kind: 'blob', bytes: requireBytes(value) }
    case 'uuid': {
      const bytes = requireBytes(value)
      if (bytes.length !== 16) throw new Error('BACKEND_UUID_REPRESENTATION_INVALID')
      return { kind: 'uuid', bytes }
    }
    case 'decimal': {
      if (typeof value !== 'string') throw new Error('BACKEND_DECIMAL_REPRESENTATION_INVALID')
      try {
        const parsed = parseDecimal(value)
        if (parsed.scale > expected.logical.scale) throw new Error('scale')
        assertDecimalPrecision(decimalRescale(parsed, expected.logical.scale, 'exact'), expected.logical.precision)
        if (formatDecimal(parsed) !== value) throw new Error('noncanonical')
        return { kind: 'decimal', coefficient: parsed.coefficient, scale: parsed.scale }
      } catch { throw new Error('BACKEND_DECIMAL_REPRESENTATION_INVALID') }
    }
    case 'json': {
      if (typeof value !== 'string') throw new Error('BACKEND_JSON_REPRESENTATION_INVALID')
      try { return { kind: 'json', value: canonicalJsonFromText(value) } }
      catch { throw new Error('BACKEND_JSON_REPRESENTATION_INVALID') }
    }
    case 'vector': {
      const bytes = requireBytes(value)
      const length = vectorElementWidth(expected.logical.element) * expected.logical.dimensions
      if (bytes.length !== length) throw new Error('BACKEND_VECTOR_REPRESENTATION_INVALID')
      return { kind: 'vector', element: expected.logical.element, dimensions: expected.logical.dimensions, bytes }
    }
  }
}

function assertAffectedRows(expectation: AffectedRowsExpectation, actual: bigint, commandId: number): void {
  let passed: boolean
  switch (expectation.kind) {
    case 'unconstrained': passed = true; break
    case 'exactly': passed = actual === expectation.count; break
    case 'at_least': passed = actual >= expectation.count; break
    case 'at_most': passed = actual <= expectation.count; break
    case 'range': passed = actual >= expectation.minimum && actual <= expectation.maximum; break
  }
  if (!passed) throw new DeterministicIrRejection('AFFECTED_ROWS_MISMATCH', null, commandId)
}

function compareLogicalRows(left: readonly LogicalValue[], right: readonly LogicalValue[]): number {
  return compareBytes(encodeLogicalValues(left), encodeLogicalValues(right))
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  const length = Math.min(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    if (left[index] !== right[index]) return left[index]! - right[index]!
  }
  return left.length - right.length
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function primarySqliteCode(error: unknown): number | null {
  if (typeof error !== 'object' || error === null) return null
  for (const property of ['sqliteCode', 'sqliteExtendedCode'] as const) {
    const value = (error as Record<string, unknown>)[property]
    if (typeof value === 'number' && Number.isInteger(value)) return value & 0xff
  }
  return null
}

function requireBigInt(value: unknown): bigint {
  if (typeof value !== 'bigint') throw new Error('BACKEND_INTEGER_REPRESENTATION_INVALID')
  return value
}

function requireBytes(value: unknown): Uint8Array {
  if (!(value instanceof Uint8Array)) throw new Error('BACKEND_BLOB_REPRESENTATION_INVALID')
  return Uint8Array.from(value)
}

function encodeUtf8(value: string): Uint8Array {
  const encoded = new TextEncoder().encode(value)
  if (decodeUtf8(encoded) !== value) throw new Error('BACKEND_TEXT_UTF8_INVALID')
  return encoded
}

function decodeUtf8(value: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(value)
}

function vectorElementWidth(element: Extract<LogicalValue, { kind: 'vector' }>['element']): number {
  return element === 'i8' || element === 'u8' ? 1 : element === 'i16' ? 2 : element === 'f64' ? 8 : 4
}
