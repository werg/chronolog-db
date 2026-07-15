import {
  logicalTypeFromCanonicalCbor,
  logicalTypeToCanonicalCbor,
  logicalValueFromCanonicalCbor,
  logicalValueToCanonicalCbor,
  type LogicalType,
  type LogicalValue,
} from '@chronolog/ir'
import { encodeCanonicalCbor as encodeSharedCanonicalCbor, sha256 } from '@chronolog/canonical'

import { compareBytes, concatBytes, utf8 } from './bytes.js'
import { assertCanonicalCbor, encodeCanonicalCbor, type CborValue } from './cbor.js'
import { protocolInvariant } from './errors.js'
import {
  assertKnownIntegerKeys,
  expectArray,
  expectBigint,
  expectBytes,
  expectMap,
  expectString,
  expectUint64,
  expectVersion,
  integerMap,
  optional,
  required,
} from './schema.js'

export type SqlResultMode = 'scalar' | 'ordered' | 'multiset' | 'set'

export interface SqlStatement {
  readonly sql: string
  readonly bindings: readonly SqlBinding[]
}

export interface SqlBinding {
  readonly parameter:
    | { readonly kind: 'index'; readonly index: number }
    | { readonly kind: 'name'; readonly name: string }
  readonly value: LogicalValue
}

export interface SqlPrecondition {
  readonly id: number
  readonly query: SqlStatement
  readonly resultMode: SqlResultMode
  readonly expectation:
    | { readonly kind: 'assert_true' }
    | { readonly kind: 'inline'; readonly result: CanonicalSqlResult }
    | { readonly kind: 'digest'; readonly digest: Uint8Array }
  readonly label?: string
}

export interface SqlTransactionProgram {
  readonly version: 1
  readonly preconditions: readonly SqlPrecondition[]
  readonly body: readonly SqlStatement[]
}

export type CanonicalSqlStorageType = 'integer' | 'real' | 'text' | 'blob'

export type CanonicalSqlColumnType =
  | { readonly kind: 'dynamic' }
  | { readonly kind: 'storage'; readonly storage: CanonicalSqlStorageType }
  | { readonly kind: 'logical'; readonly logicalType: LogicalType }
  | {
      readonly kind: 'registered'
      readonly typeId: number
      readonly implementationDigest: Uint8Array
    }

export interface CanonicalSqlColumn {
  readonly nameUtf8: Uint8Array
  readonly type: CanonicalSqlColumnType
  readonly nullable: boolean | 'unknown'
}

/**
 * SQLite storage values are tagged per value because a non-STRICT result
 * column can contain several storage classes. Rich logical values are used
 * only when the active compiler/profile proves that interpretation.
 */
export type CanonicalSqlValue =
  | { readonly kind: 'null' }
  | { readonly kind: 'integer'; readonly value: bigint }
  | { readonly kind: 'real'; readonly bits: Uint8Array }
  | { readonly kind: 'text'; readonly utf8: Uint8Array }
  | { readonly kind: 'blob'; readonly bytes: Uint8Array }
  | { readonly kind: 'logical'; readonly value: LogicalValue }

export interface CanonicalSqlResult {
  readonly mode: SqlResultMode
  readonly columns: readonly CanonicalSqlColumn[]
  readonly rows: readonly (readonly CanonicalSqlValue[])[]
}

export type SqlStatementClass =
  | 'read'
  | 'insert'
  | 'update'
  | 'delete'
  | 'schema'
  | 'pragma'
  | 'registered_effect'

export interface AcceptedPreconditionResult {
  readonly index: number
  readonly id: number
  readonly resultDigest: Uint8Array
}

export interface AcceptedStatementResult {
  readonly index: number
  readonly statementClass: SqlStatementClass
  readonly affectedRows: bigint | null
  readonly result: CanonicalSqlResult | null
}

export interface TransactionResultEnvelopeV1 {
  readonly version: 1
  readonly preconditions: readonly AcceptedPreconditionResult[]
  readonly statements: readonly AcceptedStatementResult[]
}

const RESULT_MODES: readonly SqlResultMode[] = ['scalar', 'ordered', 'multiset', 'set']
const STORAGE_TYPES: readonly CanonicalSqlStorageType[] = ['integer', 'real', 'text', 'blob']
const STATEMENT_CLASSES: readonly SqlStatementClass[] = [
  'read', 'insert', 'update', 'delete', 'schema', 'pragma', 'registered_effect',
]

function safeIndex(value: number, name: string): number {
  protocolInvariant(Number.isSafeInteger(value) && value >= 0, 'INTEGER_OUT_OF_RANGE', `${name} must be a nonnegative safe integer`)
  return value
}

function positiveIndex(value: number, name: string): number {
  protocolInvariant(Number.isSafeInteger(value) && value >= 1, 'INTEGER_OUT_OF_RANGE', `${name} must be a positive safe integer`)
  return value
}

function modeCode(mode: SqlResultMode): bigint {
  const index = RESULT_MODES.indexOf(mode)
  protocolInvariant(index >= 0, 'SCHEMA_INVALID', 'Unknown SQL result mode')
  return BigInt(index)
}

function modeFromCbor(value: CborValue, name: string): SqlResultMode {
  const mode = RESULT_MODES[Number(expectUint64(value, name))]
  protocolInvariant(mode !== undefined, 'SCHEMA_INVALID', `${name} is unknown`)
  return mode
}

function logicalBindingToCbor(binding: SqlBinding): CborValue {
  const parameter = binding.parameter.kind === 'index'
    ? [0n, BigInt(positiveIndex(binding.parameter.index, 'binding.parameter.index'))]
    : [1n, binding.parameter.name]
  if (binding.parameter.kind === 'name') {
    protocolInvariant(/^[:@$].+/u.test(binding.parameter.name), 'SCHEMA_INVALID', 'Named SQL bindings must retain their SQLite prefix')
  }
  return [parameter, logicalValueToCanonicalCbor(binding.value)]
}

function logicalBindingFromCbor(value: CborValue, name: string): SqlBinding {
  const tuple = expectArray(value, name)
  protocolInvariant(tuple.length === 2, 'SCHEMA_INVALID', `${name} has invalid arity`)
  const parameter = expectArray(tuple[0] ?? null, `${name}.parameter`)
  protocolInvariant(parameter.length === 2, 'SCHEMA_INVALID', `${name}.parameter has invalid arity`)
  const kind = expectUint64(parameter[0] ?? null, `${name}.parameter.kind`)
  const decoded = kind === 0n
    ? { kind: 'index' as const, index: positiveIndex(Number(expectUint64(parameter[1] ?? null, `${name}.parameter.index`)), `${name}.parameter.index`) }
    : kind === 1n
      ? { kind: 'name' as const, name: expectString(parameter[1] ?? null, `${name}.parameter.name`) }
      : null
  protocolInvariant(decoded !== null, 'SCHEMA_INVALID', `${name}.parameter has unknown kind`)
  if (decoded.kind === 'name') protocolInvariant(/^[:@$].+/u.test(decoded.name), 'SCHEMA_INVALID', `${name}.parameter.name is not an exact SQLite parameter token`)
  return { parameter: decoded, value: logicalValueFromCanonicalCbor(tuple[1] ?? null) }
}

export function sqlStatementToCanonicalCbor(value: SqlStatement): CborValue {
  protocolInvariant(typeof value.sql === 'string' && value.sql.length > 0, 'SCHEMA_INVALID', 'SQL statement source cannot be empty')
  protocolInvariant(!value.sql.includes('\0'), 'SCHEMA_INVALID', 'SQL statement source cannot contain U+0000')
  utf8(value.sql)
  return integerMap([[0, value.sql], [1, value.bindings.map(logicalBindingToCbor)]])
}

export function sqlStatementFromCanonicalCbor(value: CborValue, name = 'sql_statement'): SqlStatement {
  const map = expectMap(value, name)
  assertKnownIntegerKeys(map, [0, 1], name)
  const sql = expectString(required(map, 0, `${name}.sql`), `${name}.sql`)
  protocolInvariant(sql.length > 0 && !sql.includes('\0'), 'SCHEMA_INVALID', `${name}.sql is invalid`)
  utf8(sql)
  return {
    sql,
    bindings: expectArray(required(map, 1, `${name}.bindings`), `${name}.bindings`).map(
      (binding, index) => logicalBindingFromCbor(binding, `${name}.bindings[${index}]`),
    ),
  }
}

function preconditionToCbor(value: SqlPrecondition): CborValue {
  safeIndex(value.id, 'precondition.id')
  if (value.expectation.kind === 'assert_true') {
    protocolInvariant(value.resultMode === 'scalar', 'SCHEMA_INVALID', 'assert_true requires scalar result mode')
  } else if (value.expectation.kind === 'inline') {
    protocolInvariant(value.expectation.result.mode === value.resultMode, 'SCHEMA_INVALID', 'Inline expectation result mode does not match its precondition')
  }
  const expectation = value.expectation.kind === 'assert_true'
    ? [0n]
    : value.expectation.kind === 'inline'
      ? [1n, canonicalSqlResultToCbor(value.expectation.result)]
      : [2n, requireDigest(value.expectation.digest, 'precondition.expectation.digest')]
  return integerMap([
    [0, BigInt(value.id)],
    [1, sqlStatementToCanonicalCbor(value.query)],
    [2, modeCode(value.resultMode)],
    [3, expectation],
    [4, value.label],
  ])
}

function preconditionFromCbor(value: CborValue, name: string): SqlPrecondition {
  const map = expectMap(value, name)
  assertKnownIntegerKeys(map, [0, 1, 2, 3, 4], name)
  const expectationValue = expectArray(required(map, 3, `${name}.expectation`), `${name}.expectation`)
  protocolInvariant(expectationValue.length >= 1 && expectationValue.length <= 2, 'SCHEMA_INVALID', `${name}.expectation has invalid arity`)
  const kind = expectUint64(expectationValue[0] ?? null, `${name}.expectation.kind`)
  const expectation = kind === 0n && expectationValue.length === 1
    ? { kind: 'assert_true' as const }
    : kind === 1n && expectationValue.length === 2
      ? { kind: 'inline' as const, result: canonicalSqlResultFromCbor(expectationValue[1] ?? null) }
      : kind === 2n && expectationValue.length === 2
        ? { kind: 'digest' as const, digest: expectBytes(expectationValue[1] ?? null, `${name}.expectation.digest`, 32) }
        : null
  protocolInvariant(expectation !== null, 'SCHEMA_INVALID', `${name}.expectation is invalid`)
  const label = optional(map, 4)
  const resultMode = modeFromCbor(required(map, 2, `${name}.result_mode`), `${name}.result_mode`)
  protocolInvariant(expectation.kind !== 'assert_true' || resultMode === 'scalar', 'SCHEMA_INVALID', `${name}.assert_true requires scalar mode`)
  protocolInvariant(expectation.kind !== 'inline' || expectation.result.mode === resultMode, 'SCHEMA_INVALID', `${name}.inline result mode mismatch`)
  return {
    id: safeIndex(Number(expectUint64(required(map, 0, `${name}.id`), `${name}.id`)), `${name}.id`),
    query: sqlStatementFromCanonicalCbor(required(map, 1, `${name}.query`), `${name}.query`),
    resultMode,
    expectation,
    ...(label === undefined ? {} : { label: expectString(label, `${name}.label`) }),
  }
}

export function assertValidSqlTransactionProgram(value: SqlTransactionProgram): void {
  protocolInvariant(value.version === 1, 'UNSUPPORTED_VERSION', 'Unsupported SQL transaction program version')
  protocolInvariant(value.preconditions.length > 0, 'SCHEMA_INVALID', 'SQL transaction program requires a precondition')
  protocolInvariant(value.body.length > 0, 'SCHEMA_INVALID', 'SQL transaction program requires a body statement')
  const ids = new Set<number>()
  for (const precondition of value.preconditions) {
    protocolInvariant(!ids.has(precondition.id), 'SCHEMA_INVALID', 'SQL precondition IDs must be unique')
    ids.add(precondition.id)
    preconditionToCbor(precondition)
  }
  for (const statement of value.body) sqlStatementToCanonicalCbor(statement)
}

export function sqlTransactionProgramToCanonicalCbor(value: SqlTransactionProgram): CborValue {
  assertValidSqlTransactionProgram(value)
  return integerMap([
    [0, 1n],
    [1, value.preconditions.map(preconditionToCbor)],
    [2, value.body.map(sqlStatementToCanonicalCbor)],
  ])
}

export function sqlTransactionProgramFromCanonicalCbor(value: CborValue): SqlTransactionProgram {
  const map = expectMap(value, 'sql_transaction_program')
  assertKnownIntegerKeys(map, [0, 1, 2], 'sql_transaction_program')
  expectVersion(map, 1n, 'sql_transaction_program')
  const program: SqlTransactionProgram = {
    version: 1,
    preconditions: expectArray(required(map, 1, 'sql_transaction_program.preconditions'), 'sql_transaction_program.preconditions').map(
      (precondition, index) => preconditionFromCbor(precondition, `sql_transaction_program.preconditions[${index}]`),
    ),
    body: expectArray(required(map, 2, 'sql_transaction_program.body'), 'sql_transaction_program.body').map(
      (statement, index) => sqlStatementFromCanonicalCbor(statement, `sql_transaction_program.body[${index}]`),
    ),
  }
  assertValidSqlTransactionProgram(program)
  return program
}

export function encodeSqlTransactionProgram(value: SqlTransactionProgram): Uint8Array {
  return encodeCanonicalCbor(sqlTransactionProgramToCanonicalCbor(value))
}

export function decodeSqlTransactionProgram(bytes: Uint8Array): SqlTransactionProgram {
  return sqlTransactionProgramFromCanonicalCbor(assertCanonicalCbor(bytes))
}

function columnTypeToCbor(value: CanonicalSqlColumnType): CborValue {
  switch (value.kind) {
    case 'dynamic': return [0n]
    case 'storage': {
      const index = STORAGE_TYPES.indexOf(value.storage)
      protocolInvariant(index >= 0, 'SCHEMA_INVALID', 'Unknown SQL storage type')
      return [1n, BigInt(index)]
    }
    case 'logical': return [2n, logicalTypeToCanonicalCbor(value.logicalType)]
    case 'registered':
      safeIndex(value.typeId, 'column.type.typeId')
      return [3n, BigInt(value.typeId), requireDigest(value.implementationDigest, 'column.type.implementationDigest')]
  }
}

function columnTypeFromCbor(value: CborValue, name: string): CanonicalSqlColumnType {
  const tuple = expectArray(value, name)
  protocolInvariant(tuple.length >= 1, 'SCHEMA_INVALID', `${name} is empty`)
  const kind = expectUint64(tuple[0] ?? null, `${name}.kind`)
  if (kind === 0n && tuple.length === 1) return { kind: 'dynamic' }
  if (kind === 1n && tuple.length === 2) {
    const storage = STORAGE_TYPES[Number(expectUint64(tuple[1] ?? null, `${name}.storage`))]
    protocolInvariant(storage !== undefined, 'SCHEMA_INVALID', `${name}.storage is unknown`)
    return { kind: 'storage', storage }
  }
  if (kind === 2n && tuple.length === 2) return { kind: 'logical', logicalType: logicalTypeFromCanonicalCbor(tuple[1] ?? null) }
  if (kind === 3n && tuple.length === 3) return {
    kind: 'registered',
    typeId: safeIndex(Number(expectUint64(tuple[1] ?? null, `${name}.type_id`)), `${name}.type_id`),
    implementationDigest: expectBytes(tuple[2] ?? null, `${name}.implementation_digest`, 32),
  }
  protocolInvariant(false, 'SCHEMA_INVALID', `${name} is invalid`)
}

function columnToCbor(value: CanonicalSqlColumn): CborValue {
  const nullable = value.nullable === false ? 0n : value.nullable === true ? 1n : 2n
  utf8(new TextDecoder('utf-8', { fatal: true }).decode(value.nameUtf8))
  return [value.nameUtf8, columnTypeToCbor(value.type), nullable]
}

function columnFromCbor(value: CborValue, name: string): CanonicalSqlColumn {
  const tuple = expectArray(value, name)
  protocolInvariant(tuple.length === 3, 'SCHEMA_INVALID', `${name} has invalid arity`)
  const nullableCode = expectUint64(tuple[2] ?? null, `${name}.nullable`)
  protocolInvariant(nullableCode <= 2n, 'SCHEMA_INVALID', `${name}.nullable is invalid`)
  const nameUtf8 = expectBytes(tuple[0] ?? null, `${name}.name_utf8`)
  try { new TextDecoder('utf-8', { fatal: true }).decode(nameUtf8) } catch { protocolInvariant(false, 'SCHEMA_INVALID', `${name}.name_utf8 is invalid UTF-8`) }
  return {
    nameUtf8,
    type: columnTypeFromCbor(tuple[1] ?? null, `${name}.type`),
    nullable: nullableCode === 0n ? false : nullableCode === 1n ? true : 'unknown',
  }
}

export function canonicalSqlValueToCbor(value: CanonicalSqlValue): CborValue {
  switch (value.kind) {
    case 'null': return [0n]
    case 'integer':
      protocolInvariant(value.value >= -(1n << 63n) && value.value <= (1n << 63n) - 1n, 'INTEGER_OUT_OF_RANGE', 'SQL integer is outside int64')
      return [1n, value.value]
    case 'real': return [2n, expectEightBytes(value.bits, 'SQL real bits')]
    case 'text': {
      try { new TextDecoder('utf-8', { fatal: true }).decode(value.utf8) } catch { protocolInvariant(false, 'SCHEMA_INVALID', 'SQL text is invalid UTF-8') }
      return [3n, value.utf8]
    }
    case 'blob': return [4n, value.bytes]
    case 'logical': return [5n, logicalValueToCanonicalCbor(value.value)]
  }
}

export function canonicalSqlValueFromCbor(value: CborValue, name = 'sql_value'): CanonicalSqlValue {
  const tuple = expectArray(value, name)
  protocolInvariant(tuple.length >= 1 && tuple.length <= 2, 'SCHEMA_INVALID', `${name} has invalid arity`)
  const kind = expectUint64(tuple[0] ?? null, `${name}.kind`)
  if (kind === 0n && tuple.length === 1) return { kind: 'null' }
  if (kind === 1n && tuple.length === 2) {
    const integer = expectBigint(tuple[1] ?? null, `${name}.integer`)
    protocolInvariant(integer >= -(1n << 63n) && integer <= (1n << 63n) - 1n, 'INTEGER_OUT_OF_RANGE', `${name}.integer is outside int64`)
    return { kind: 'integer', value: integer }
  }
  if (kind === 2n && tuple.length === 2) return { kind: 'real', bits: expectBytes(tuple[1] ?? null, `${name}.real`, 8) }
  if (kind === 3n && tuple.length === 2) {
    const text = expectBytes(tuple[1] ?? null, `${name}.text`)
    try { new TextDecoder('utf-8', { fatal: true }).decode(text) } catch { protocolInvariant(false, 'SCHEMA_INVALID', `${name}.text is invalid UTF-8`) }
    return { kind: 'text', utf8: text }
  }
  if (kind === 4n && tuple.length === 2) return { kind: 'blob', bytes: expectBytes(tuple[1] ?? null, `${name}.blob`) }
  if (kind === 5n && tuple.length === 2) return { kind: 'logical', value: logicalValueFromCanonicalCbor(tuple[1] ?? null) }
  protocolInvariant(false, 'SCHEMA_INVALID', `${name} is invalid`)
}

function rowToCbor(row: readonly CanonicalSqlValue[]): CborValue {
  return row.map(canonicalSqlValueToCbor)
}

function compareRows(left: readonly CanonicalSqlValue[], right: readonly CanonicalSqlValue[]): number {
  return compareBytes(encodeSharedCanonicalCbor(rowToCbor(left)), encodeSharedCanonicalCbor(rowToCbor(right)))
}

export function canonicalizeSqlResult(value: CanonicalSqlResult): CanonicalSqlResult {
  protocolInvariant(RESULT_MODES.includes(value.mode), 'SCHEMA_INVALID', 'Unknown SQL result mode')
  for (const [rowIndex, row] of value.rows.entries()) {
    protocolInvariant(row.length === value.columns.length, 'SCHEMA_INVALID', `SQL result row ${rowIndex} has the wrong width`)
    for (const item of row) canonicalSqlValueToCbor(item)
  }
  if (value.mode === 'scalar') {
    protocolInvariant(value.columns.length === 1 && value.rows.length <= 1, 'SCHEMA_INVALID', 'Scalar SQL result has invalid shape')
  }
  const rows = value.mode === 'multiset' || value.mode === 'set'
    ? [...value.rows].sort(compareRows)
    : [...value.rows]
  const normalizedRows = value.mode === 'set'
    ? rows.filter((row, index) => index === 0 || compareRows(rows[index - 1]!, row) !== 0)
    : rows
  return {
    mode: value.mode,
    columns: value.columns.map((column) => ({
      nameUtf8: Uint8Array.from(column.nameUtf8),
      type: column.type.kind === 'registered'
        ? { ...column.type, implementationDigest: Uint8Array.from(column.type.implementationDigest) }
        : column.type,
      nullable: column.nullable,
    })),
    rows: normalizedRows.map((row) => row.map(copySqlValue)),
  }
}

export function canonicalSqlResultToCbor(value: CanonicalSqlResult): CborValue {
  const canonical = canonicalizeSqlResult(value)
  return [
    modeCode(canonical.mode),
    canonical.columns.map(columnToCbor),
    canonical.rows.map(rowToCbor),
  ]
}

export function canonicalSqlResultFromCbor(value: CborValue): CanonicalSqlResult {
  const tuple = expectArray(value, 'canonical_sql_result')
  protocolInvariant(tuple.length === 3, 'SCHEMA_INVALID', 'Canonical SQL result has invalid arity')
  const decoded: CanonicalSqlResult = {
    mode: modeFromCbor(tuple[0] ?? null, 'canonical_sql_result.mode'),
    columns: expectArray(tuple[1] ?? null, 'canonical_sql_result.columns').map(
      (column, index) => columnFromCbor(column, `canonical_sql_result.columns[${index}]`),
    ),
    rows: expectArray(tuple[2] ?? null, 'canonical_sql_result.rows').map((row, rowIndex) =>
      expectArray(row, `canonical_sql_result.rows[${rowIndex}]`).map(
        (item, columnIndex) => canonicalSqlValueFromCbor(item, `canonical_sql_result.rows[${rowIndex}][${columnIndex}]`),
      )),
  }
  const canonical = canonicalizeSqlResult(decoded)
  if (decoded.mode === 'multiset' || decoded.mode === 'set') {
    protocolInvariant(decoded.rows.length === canonical.rows.length, 'SCHEMA_INVALID', 'Canonical SQL set contains duplicate rows')
    for (let index = 0; index < decoded.rows.length; index += 1) {
      protocolInvariant(compareRows(decoded.rows[index]!, canonical.rows[index]!) === 0, 'SCHEMA_INVALID', 'Canonical SQL rows are not sorted')
    }
  }
  return canonical
}

export function encodeCanonicalSqlResult(value: CanonicalSqlResult): Uint8Array {
  return encodeCanonicalCbor(canonicalSqlResultToCbor(value))
}

export function decodeCanonicalSqlResult(bytes: Uint8Array): CanonicalSqlResult {
  return canonicalSqlResultFromCbor(assertCanonicalCbor(bytes))
}

export async function digestCanonicalSqlResult(value: CanonicalSqlResult): Promise<Uint8Array> {
  return sha256(concatBytes(utf8('chronolog-canonical-sql-result-v1'), Uint8Array.of(0), encodeCanonicalSqlResult(value)))
}

export function transactionResultEnvelopeToCanonicalCbor(value: TransactionResultEnvelopeV1): CborValue {
  protocolInvariant(value.version === 1, 'UNSUPPORTED_VERSION', 'Unsupported transaction result envelope version')
  const preconditions = value.preconditions.map((entry, index): CborValue => {
    protocolInvariant(entry.index === index, 'SCHEMA_INVALID', 'Precondition result indices must be contiguous')
    return [BigInt(index), BigInt(safeIndex(entry.id, 'precondition result id')), requireDigest(entry.resultDigest, 'precondition result digest')]
  })
  const statements = value.statements.map((entry, index): CborValue => {
    protocolInvariant(entry.index === index, 'SCHEMA_INVALID', 'Statement result indices must be contiguous')
    const statementClass = STATEMENT_CLASSES.indexOf(entry.statementClass)
    protocolInvariant(statementClass >= 0, 'SCHEMA_INVALID', 'Unknown SQL statement class')
    if (entry.affectedRows !== null) {
      protocolInvariant(entry.affectedRows >= 0n && entry.affectedRows <= (1n << 63n) - 1n, 'INTEGER_OUT_OF_RANGE', 'Affected row count is outside nonnegative int64')
    }
    return [
      BigInt(index),
      BigInt(statementClass),
      entry.affectedRows,
      entry.result === null ? null : canonicalSqlResultToCbor(entry.result),
    ]
  })
  return [1n, preconditions, statements]
}

export function transactionResultEnvelopeFromCanonicalCbor(value: CborValue): TransactionResultEnvelopeV1 {
  const tuple = expectArray(value, 'transaction_result_envelope')
  protocolInvariant(tuple.length === 3 && tuple[0] === 1n, 'UNSUPPORTED_VERSION', 'Unsupported transaction result envelope')
  const preconditions = expectArray(tuple[1] ?? null, 'transaction_result_envelope.preconditions').map((entry, index) => {
    const fields = expectArray(entry, `transaction_result_envelope.preconditions[${index}]`)
    protocolInvariant(fields.length === 3 && fields[0] === BigInt(index), 'SCHEMA_INVALID', 'Precondition result index is not contiguous')
    return {
      index,
      id: safeIndex(Number(expectUint64(fields[1] ?? null, 'precondition_result.id')), 'precondition_result.id'),
      resultDigest: expectBytes(fields[2] ?? null, 'precondition_result.digest', 32),
    }
  })
  const statements = expectArray(tuple[2] ?? null, 'transaction_result_envelope.statements').map((entry, index) => {
    const fields = expectArray(entry, `transaction_result_envelope.statements[${index}]`)
    protocolInvariant(fields.length === 4 && fields[0] === BigInt(index), 'SCHEMA_INVALID', 'Statement result index is not contiguous')
    const statementClass = STATEMENT_CLASSES[Number(expectUint64(fields[1] ?? null, 'statement_result.class'))]
    protocolInvariant(statementClass !== undefined, 'SCHEMA_INVALID', 'Statement result class is unknown')
    const affectedValue = fields[2]
    const affectedRows = affectedValue === null ? null : expectBigint(affectedValue ?? null, 'statement_result.affected_rows')
    if (affectedRows !== null) protocolInvariant(affectedRows >= 0n && affectedRows <= (1n << 63n) - 1n, 'INTEGER_OUT_OF_RANGE', 'Affected row count is outside nonnegative int64')
    const result = fields[3]
    return {
      index,
      statementClass,
      affectedRows,
      result: result === null ? null : canonicalSqlResultFromCbor(result ?? null),
    }
  })
  return { version: 1, preconditions, statements }
}

export function encodeTransactionResultEnvelope(value: TransactionResultEnvelopeV1): Uint8Array {
  return encodeCanonicalCbor(transactionResultEnvelopeToCanonicalCbor(value))
}

export function decodeTransactionResultEnvelope(bytes: Uint8Array): TransactionResultEnvelopeV1 {
  return transactionResultEnvelopeFromCanonicalCbor(assertCanonicalCbor(bytes))
}

export async function digestTransactionResultEnvelope(value: TransactionResultEnvelopeV1 | Uint8Array): Promise<Uint8Array> {
  const bytes = value instanceof Uint8Array ? value : encodeTransactionResultEnvelope(value)
  return sha256(concatBytes(utf8('chronolog-transaction-result-envelope-v1'), Uint8Array.of(0), bytes))
}

export function numberToCanonicalReal(value: number): CanonicalSqlValue {
  protocolInvariant(Number.isFinite(value), 'SCHEMA_INVALID', 'Canonical SQL real must be finite')
  const bits = new Uint8Array(8)
  new DataView(bits.buffer).setFloat64(0, value, false)
  return { kind: 'real', bits }
}

export function canonicalRealToNumber(value: Extract<CanonicalSqlValue, { readonly kind: 'real' }>): number {
  const number = new DataView(value.bits.buffer, value.bits.byteOffset, 8).getFloat64(0, false)
  protocolInvariant(Number.isFinite(number), 'SCHEMA_INVALID', 'Canonical SQL real must be finite')
  return number
}

function requireDigest(value: Uint8Array, name: string): Uint8Array {
  protocolInvariant(value.length === 32, 'SCHEMA_INVALID', `${name} must contain 32 bytes`)
  return value
}

function expectEightBytes(value: Uint8Array, name: string): Uint8Array {
  protocolInvariant(value.length === 8, 'SCHEMA_INVALID', `${name} must contain 8 bytes`)
  return value
}

function copySqlValue(value: CanonicalSqlValue): CanonicalSqlValue {
  switch (value.kind) {
    case 'real': return { kind: 'real', bits: Uint8Array.from(value.bits) }
    case 'text': return { kind: 'text', utf8: Uint8Array.from(value.utf8) }
    case 'blob': return { kind: 'blob', bytes: Uint8Array.from(value.bytes) }
    case 'logical': return { kind: 'logical', value: structuredClone(value.value) }
    default: return value
  }
}
