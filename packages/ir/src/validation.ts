import { CanonicalError, decodeUtf8, equalBytes, utf8 } from '@chronolog/canonical'

import { collectRelationEffects, semanticComplexity, walkExpr, walkProgram, walkQuery } from './visitors.js'
import type {
  CanonicalJsonValue, CanonicalQueryResult, ExecutionManifest, Expr, IrDiagnostic, IrValidationResult,
  LogicalType, LogicalValue, Mutation, OrderingProof, Query, SchemaManifest, TransactionProgram, ValueType,
} from './types.js'

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/u
const ENTROPY_LABEL = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/u
const INT64_MIN = -(1n << 63n), INT64_MAX = (1n << 63n) - 1n

export interface ProgramValidationContext {
  readonly schema?: SchemaManifest
  readonly manifest?: ExecutionManifest
  readonly maxDiagnostics?: number
  /** Client query templates may retain parameters; signed programs never may. */
  readonly allowParameters?: boolean
}

class Diagnostics {
  readonly values: IrDiagnostic[] = []
  constructor(private readonly maximum: number) {}
  add(code: string, message: string, nodeId?: number, path?: string): void { if (this.values.length < this.maximum) this.values.push({ code, message, ...(nodeId === undefined ? {} : { nodeId }), ...(path === undefined ? {} : { path }) }) }
}

export function validateLogicalValue(value: LogicalValue): readonly IrDiagnostic[] {
  const diagnostics = new Diagnostics(100)
  validateValue(value, diagnostics, 'value', 0)
  return diagnostics.values
}

function validateValue(value: LogicalValue, d: Diagnostics, path: string, jsonDepth: number): void {
  switch (value.kind) {
    case 'null': case 'boolean': return
    case 'int64': case 'duration_ms': if (value.value < INT64_MIN || value.value > INT64_MAX) d.add('INTEGER_OUT_OF_RANGE', `${value.kind} is outside int64`, undefined, path); return
    case 'timestamp_ms': if (value.value < 0n || value.value > INT64_MAX) d.add('INTEGER_OUT_OF_RANGE', 'Timestamp is outside nonnegative int64', undefined, path); return
    case 'decimal': if (!Number.isSafeInteger(value.scale) || value.scale < 0 || value.scale > 38) d.add('DECIMAL_SCALE_INVALID', 'Decimal scale must be 0..38', undefined, path); if (value.scale > 0 && value.coefficient % 10n === 0n) d.add('DECIMAL_NOT_NORMALIZED', 'Decimal has a removable trailing zero', undefined, path); return
    case 'text': try { decodeUtf8(value.utf8) } catch { d.add('TEXT_INVALID_UTF8', 'Text bytes are invalid UTF-8', undefined, path) }; return
    case 'blob': return
    case 'uuid': if (value.bytes.length !== 16) d.add('UUID_LENGTH_INVALID', 'UUID must contain 16 bytes', undefined, path); return
    case 'json': validateJson(value.value, d, path, jsonDepth); return
    case 'vector': { const widths = { i8: 1, u8: 1, i16: 2, i32: 4, f32: 4, f64: 8 } as const; if (!Number.isSafeInteger(value.dimensions) || value.dimensions < 1 || value.bytes.length !== value.dimensions * widths[value.element]) d.add('VECTOR_SHAPE_INVALID', 'Vector byte width does not match dimensions', undefined, path); return }
  }
}

function validateJson(value: CanonicalJsonValue, d: Diagnostics, path: string, depth: number): void {
  if (depth > 64) { d.add('JSON_DEPTH_EXCEEDED', 'JSON nesting exceeds portable limit', undefined, path); return }
  if (value === null || typeof value === 'boolean' || typeof value === 'bigint') return
  if (typeof value === 'string') { try { utf8(value) } catch { d.add('JSON_TEXT_INVALID', 'JSON string is invalid Unicode', undefined, path) }; return }
  if (Array.isArray(value)) { value.forEach((item, index) => validateJson(item, d, `${path}[${index}]`, depth + 1)); return }
  if (value instanceof Map) { for (const [key, item] of value) { try { utf8(key) } catch { d.add('JSON_KEY_INVALID', 'JSON key is invalid Unicode', undefined, path) }; validateJson(item, d, `${path}.${key}`, depth + 1) }; return }
  const decimal = value as { readonly kind: 'decimal'; readonly coefficient: bigint; readonly scale: number }
  if (decimal.scale < 0 || decimal.scale > 38 || (decimal.scale > 0 && decimal.coefficient % 10n === 0n)) d.add('JSON_DECIMAL_INVALID', 'JSON decimal is not normalized', undefined, path)
}

export function validateLogicalType(type: LogicalType): readonly IrDiagnostic[] {
  const d = new Diagnostics(100)
  if (type.kind === 'decimal' && (!Number.isSafeInteger(type.precision) || type.precision < 1 || type.precision > 38 || !Number.isSafeInteger(type.scale) || type.scale < 0 || type.scale > type.precision)) d.add('DECIMAL_TYPE_INVALID', 'Decimal precision/scale is invalid')
  if (type.kind === 'blob' && type.maxBytes !== undefined && (!Number.isSafeInteger(type.maxBytes) || type.maxBytes < 0)) d.add('BLOB_TYPE_INVALID', 'Blob maximum is invalid')
  if (type.kind === 'vector' && (!Number.isSafeInteger(type.dimensions) || type.dimensions < 1)) d.add('VECTOR_TYPE_INVALID', 'Vector dimensions must be positive')
  return d.values
}

export function proveQueryOrdering(query: Query): OrderingProof {
  if (query.resultMode.kind !== 'ordered') return { total: true, reason: 'canonical_row', keyProjectionIds: [] }
  const canonical = query.orderBy.some((term) => term.canonicalRowTieBreaker === true)
  return canonical
    ? { total: true, reason: 'canonical_row', keyProjectionIds: query.projection.map((projection) => projection.id) }
    : { total: false, reason: 'not_total', keyProjectionIds: [] }
}

export function validateQuery(query: Query, context: ProgramValidationContext = {}): IrValidationResult<Query> {
  const d = new Diagnostics(context.maxDiagnostics ?? 100)
  validateQueryInto(query, d, { ...context, allowParameters: context.allowParameters ?? true }, 'query')
  return { ok: d.values.length === 0, ...(d.values.length === 0 ? { value: query } : {}), diagnostics: d.values }
}

function validateQueryInto(query: Query, d: Diagnostics, context: ProgramValidationContext, path: string): void {
  validateId(query.id, d, path)
  if (query.projection.length === 0) d.add('QUERY_PROJECTION_EMPTY', 'Query must project at least one value', query.id, path)
  if (query.resultMode.kind === 'scalar' && query.projection.length !== 1) d.add('SCALAR_WIDTH_INVALID', 'Scalar query must project exactly one value', query.id, path)
  const ordering = proveQueryOrdering(query)
  if (query.resultMode.kind === 'ordered' && !ordering.total) d.add('ORDER_NOT_TOTAL', 'Ordered query requires an explicit canonical-row tie breaker or resolved unique key', query.id, path)
  if (query.page !== undefined && !ordering.total) d.add('PAGE_WITHOUT_TOTAL_ORDER', 'LIMIT/OFFSET requires a total order', query.id, path)
  if (query.page !== undefined && (!Number.isSafeInteger(query.page.limit) || query.page.limit < 0 || (query.page.offset !== undefined && (!Number.isSafeInteger(query.page.offset) || query.page.offset < 0)))) d.add('PAGE_INVALID', 'Page bounds must be nonnegative safe integers', query.id, path)
  for (const projection of query.projection) validateIdentifier(projection.name, d, projection.id, `${path}.projection`)
  if (query.from?.kind === 'table' || query.from?.kind === 'view') validateIdentifier(query.from.name, d, query.from.id, `${path}.from`)
  walkQuery(query, {
    expr: (expr) => validateExpr(expr, d, context, path),
    relation: (relation) => {
      validateId(relation.id, d, path)
      if (relation.kind === 'system_relation' && relation.relation !== 'transaction_log') d.add('SYSTEM_RELATION_INVALID', 'Unknown consensus system relation', relation.id, path)
    },
  })
}

function validateExpr(expr: Expr, d: Diagnostics, context: ProgramValidationContext, path: string): void {
  validateId(expr.id, d, path)
  if (expr.kind === 'literal') validateValue(expr.value, d, `${path}.literal`, 0)
  if (expr.kind === 'parameter') {
    validateIdentifier(expr.name, d, expr.id, path)
    if (context.allowParameters !== true) d.add('DRAFT_PARAMETER_UNSUBSTITUTED', 'Signed transaction programs cannot contain parameter expressions', expr.id, path)
  }
  if (expr.kind === 'column') validateIdentifier(expr.name, d, expr.id, path)
  if (expr.kind === 'entropy' && (!ENTROPY_LABEL.test(expr.label) || !Number.isSafeInteger(expr.index) || expr.index < 0 || !Number.isSafeInteger(expr.length) || expr.length < 1)) d.add('ENTROPY_REQUEST_INVALID', 'Entropy request label/index/length is invalid', expr.id, path)
  if (expr.kind === 'function') {
    const fn = context.manifest?.functions.find((entry) => entry.id === expr.functionId)
    if (context.manifest !== undefined && fn === undefined) d.add('FUNCTION_UNREGISTERED', 'Expression references an unregistered function', expr.id, path)
    if (fn?.effect === 'stateful') d.add('FUNCTION_NOT_PURE', 'Stateful function cannot appear in an expression', expr.id, path)
  }
}

export function validateTransactionProgram(program: TransactionProgram, context: ProgramValidationContext = {}): IrValidationResult<TransactionProgram> {
  const d = new Diagnostics(context.maxDiagnostics ?? 100)
  const signedContext = { ...context, allowParameters: false }
  if (program.preconditions.length === 0) d.add('PRECONDITION_REQUIRED', 'Transaction program requires at least one precondition')
  if (program.mutations.length === 0) d.add('MUTATION_REQUIRED', 'Transaction program requires at least one mutation')
  const ids = new Set<number>()
  const record = (id: number, path: string) => { validateId(id, d, path); if (ids.has(id)) d.add('DUPLICATE_NODE_ID', `Duplicate signed node ID ${id}`, id, path); ids.add(id) }
  for (const precondition of program.preconditions) {
    record(precondition.id, 'precondition')
    validateQueryInto(precondition.query, d, signedContext, 'precondition.query')
    if (precondition.kind === 'assert' && precondition.unknownIsFailure !== true) d.add('ASSERT_UNKNOWN_POLICY_INVALID', 'Assert must fail on unknown', precondition.id)
    if (precondition.kind === 'expect') {
      if (precondition.expected.kind === 'inline') appendResultDiagnostics(precondition.expected.result, d, precondition.id)
      else {
        if (precondition.expected.digest.length !== 32) d.add('EXPECTATION_DIGEST_INVALID', 'Expected-result digest must contain 32 bytes', precondition.id)
        if (precondition.expected.columns.length === 0) d.add('EXPECTATION_SCHEMA_EMPTY', 'Expected-result schema must contain a column', precondition.id)
      }
    }
  }
  for (const mutation of program.mutations) validateMutation(mutation, d, signedContext, record)
  walkProgram(program, {
    expr: (expr) => record(expr.id, 'expr'), query: (query) => record(query.id, 'query'),
    relation: (relation) => record(relation.id, 'relation'), cte: (cte) => record(cte.id, 'cte'),
    join: (join) => record(join.id, 'join'), projection: (projection) => record(projection.id, 'projection'),
    orderTerm: (term) => record(term.id, 'order_term'), window: (window) => record(window.id, 'window'),
    compound: (compound) => record(compound.id, 'compound'), mergeClause: (clause) => record(clause.id, 'merge_clause'),
  })
  const complexity = semanticComplexity(program)
  if (context.manifest !== undefined && complexity > context.manifest.resources.maxProgramNodes) d.add('PROGRAM_RESOURCE_EXCEEDED', 'Program exceeds manifest node limit')
  const effects = collectRelationEffects(program)
  for (const name of [...effects.reads, ...effects.writes]) if (isReserved(name)) d.add('RESERVED_OBJECT_ACCESS', `Program accesses reserved object ${name}`)
  if (context.schema !== undefined) {
    const names = new Set(context.schema.objects.map((object) => object.name))
    for (const name of [...effects.reads, ...effects.writes]) if (!names.has(name)) d.add('OBJECT_NOT_FOUND', `Object ${name} is not in the schema manifest`)
  }
  return { ok: d.values.length === 0, ...(d.values.length === 0 ? { value: program } : {}), diagnostics: d.values }
}

function validateMutation(mutation: Mutation, d: Diagnostics, context: ProgramValidationContext, record: (id: number, path: string) => void): void {
  record(mutation.id, 'mutation')
  if ('target' in mutation && mutation.target.kind === 'name') validateIdentifier(mutation.target.name, d, mutation.id, 'mutation.target')
  const affected = mutation.affectedRows
  if (affected.kind !== 'unconstrained') {
    const counts = affected.kind === 'range' ? [affected.minimum, affected.maximum] : [affected.count]
    if (counts.some((count) => count < 0n) || (affected.kind === 'range' && affected.minimum > affected.maximum)) d.add('AFFECTED_ROWS_INVALID', 'Affected-row expectation is invalid', mutation.id)
  }
  if (mutation.kind === 'insert' && (mutation.columns.length === 0 || mutation.rows.length === 0 || mutation.rows.some((row) => row.length !== mutation.columns.length))) d.add('INSERT_SHAPE_INVALID', 'Insert rows must match explicit columns', mutation.id)
  if (mutation.kind === 'upsert' && mutation.row.length !== mutation.columns.length) d.add('UPSERT_SHAPE_INVALID', 'Upsert row must match explicit columns', mutation.id)
  if (mutation.kind === 'update' && mutation.assignments.length === 0) d.add('UPDATE_ASSIGNMENTS_EMPTY', 'Update requires assignments', mutation.id)
  if (mutation.kind === 'merge' && mutation.clauses.length === 0) d.add('MERGE_CLAUSES_EMPTY', 'Merge requires clauses', mutation.id)
  if (mutation.kind === 'stateful_call' && context.manifest !== undefined && !context.manifest.modules.some((module) => module.id === mutation.moduleId)) d.add('MODULE_UNREGISTERED', 'Stateful call references an unregistered module', mutation.id)
  walkMutationExpressions(mutation, d, context)
}

function walkMutationExpressions(mutation: Mutation, d: Diagnostics, context: ProgramValidationContext): void {
  // The visitor is deliberately expression-only here; query structure is checked explicitly
  // so nested query visitors do not recursively validate the same tree without bound.
  const validate = (expr: Expr) => validateExpr(expr, d, context, 'mutation')
  if (mutation.returning !== undefined) validateQueryInto(mutation.returning, d, context, 'mutation.returning')
  switch (mutation.kind) {
    case 'insert': for (const row of mutation.rows) for (const expr of row) walkExpr(expr, { expr: validate }); return
    case 'update': for (const assignment of mutation.assignments) walkExpr(assignment.value, { expr: validate }); if (mutation.where !== undefined) walkExpr(mutation.where, { expr: validate }); return
    case 'delete': if (mutation.where !== undefined) walkExpr(mutation.where, { expr: validate }); return
    case 'upsert': for (const expr of mutation.row) walkExpr(expr, { expr: validate }); for (const assignment of mutation.updates) walkExpr(assignment.value, { expr: validate }); return
    case 'merge': validateQueryInto(mutation.source, d, context, 'mutation.source'); walkExpr(mutation.on, { expr: validate }); for (const clause of mutation.clauses) { if (clause.predicate !== undefined) walkExpr(clause.predicate, { expr: validate }); for (const assignment of clause.assignments) walkExpr(assignment.value, { expr: validate }) }; return
    case 'stateful_call': for (const expr of mutation.args) walkExpr(expr, { expr: validate }); return
  }
}

export function validateCanonicalQueryResult(result: CanonicalQueryResult): IrValidationResult<CanonicalQueryResult> {
  const d = new Diagnostics(100)
  appendResultDiagnostics(result, d)
  return { ok: d.values.length === 0, ...(d.values.length === 0 ? { value: result } : {}), diagnostics: d.values }
}

function appendResultDiagnostics(result: CanonicalQueryResult, d: Diagnostics, ownerId?: number): void {
  const ids = new Set<number>()
  for (const column of result.columns) { if (ids.has(column.id)) d.add('DUPLICATE_PROJECTION_ID', 'Result contains duplicate projection IDs', column.id); ids.add(column.id); validateIdentifier(column.name, d, column.id, 'result.column'); for (const diagnostic of validateLogicalType(column.valueType.logical)) d.add(diagnostic.code, diagnostic.message, column.id) }
  for (let row = 0; row < result.rows.length; row += 1) { if (result.rows[row]!.length !== result.columns.length) d.add('RESULT_WIDTH_INVALID', 'Result row width differs from output schema', undefined, `rows[${row}]`); result.rows[row]!.forEach((value, column) => validateValue(value, d, `rows[${row}][${column}]`, 0)) }
  if (result.resultMode.kind === 'scalar' && (result.columns.length !== 1 || result.rows.length > 1)) d.add('SCALAR_RESULT_INVALID', 'Scalar result must have one column and at most one row')
}

export function validateSchemaManifest(schema: SchemaManifest): IrValidationResult<SchemaManifest> {
  const d = new Diagnostics(200), ids = new Set<number>(), names = new Set<string>()
  if (schema.version !== 1) d.add('SCHEMA_VERSION_UNSUPPORTED', 'Schema manifest version must be 1')
  validateIdentifier(schema.name, d, undefined, 'schema.name')
  for (const object of schema.objects) {
    if (ids.has(object.id)) d.add('DUPLICATE_SCHEMA_ID', 'Duplicate schema object ID', object.id); ids.add(object.id)
    if (names.has(object.name)) d.add('DUPLICATE_SCHEMA_NAME', 'Duplicate schema object name', object.id); names.add(object.name)
    validateIdentifier(object.name, d, object.id, 'schema.object')
    if (object.kind === 'table') { const columnIds = new Set<number>(), columnNames = new Set<string>(); for (const column of object.columns) { if (columnIds.has(column.id) || ids.has(column.id)) d.add('DUPLICATE_SCHEMA_ID', 'Duplicate schema column ID', column.id); columnIds.add(column.id); ids.add(column.id); if (columnNames.has(column.name)) d.add('DUPLICATE_COLUMN_NAME', 'Duplicate column name', column.id); columnNames.add(column.name); validateIdentifier(column.name, d, column.id, 'schema.column'); for (const diagnostic of validateLogicalType(column.valueType.logical)) d.add(diagnostic.code, diagnostic.message, column.id); if (column.defaultValue !== undefined) validateValue(column.defaultValue, d, 'schema.default', 0) } }
  }
  for (const row of schema.seedRows) if (!schema.objects.some((object) => object.kind === 'table' && object.id === row.tableId)) d.add('SEED_TABLE_NOT_FOUND', 'Seed row references an unknown table')
  return { ok: d.values.length === 0, ...(d.values.length === 0 ? { value: schema } : {}), diagnostics: d.values }
}

export function validateExecutionManifest(manifest: ExecutionManifest): IrValidationResult<ExecutionManifest> {
  const d = new Diagnostics(200), ids = new Set<number>()
  if (manifest.version !== 1) d.add('MANIFEST_VERSION_UNSUPPORTED', 'Execution manifest version must be 1')
  if (manifest.engineDigest.length !== 32) d.add('ENGINE_DIGEST_INVALID', 'Engine digest must contain 32 bytes')
  for (const item of [...manifest.functions, ...manifest.collations, ...manifest.modules]) { if (ids.has(item.id)) d.add('DUPLICATE_REGISTRY_ID', 'Duplicate execution registry ID', item.id); ids.add(item.id); if (item.implementationDigest.length !== 32) d.add('IMPLEMENTATION_DIGEST_INVALID', 'Implementation digest must contain 32 bytes', item.id) }
  for (const [key, value] of Object.entries(manifest.resources)) if (typeof value === 'bigint' ? value < 0n : !Number.isSafeInteger(value) || value < 0) d.add('RESOURCE_LIMIT_INVALID', `Resource limit ${key} is invalid`)
  return { ok: d.values.length === 0, ...(d.values.length === 0 ? { value: manifest } : {}), diagnostics: d.values }
}

export function assertValidTransactionProgram(program: TransactionProgram, context: ProgramValidationContext = {}): TransactionProgram { const result = validateTransactionProgram(program, context); if (!result.ok) throw new CanonicalError('SCHEMA_INVALID', result.diagnostics[0]?.message ?? 'Invalid transaction program', { diagnostics: result.diagnostics }); return program }
export function assertValidSchemaManifest(schema: SchemaManifest): SchemaManifest { const result = validateSchemaManifest(schema); if (!result.ok) throw new CanonicalError('SCHEMA_INVALID', result.diagnostics[0]?.message ?? 'Invalid schema manifest', { diagnostics: result.diagnostics }); return schema }
export function assertValidExecutionManifest(manifest: ExecutionManifest): ExecutionManifest { const result = validateExecutionManifest(manifest); if (!result.ok) throw new CanonicalError('SCHEMA_INVALID', result.diagnostics[0]?.message ?? 'Invalid execution manifest', { diagnostics: result.diagnostics }); return manifest }

function validateId(id: number, d: Diagnostics, path: string): void { if (!Number.isSafeInteger(id) || id < 0) d.add('NODE_ID_INVALID', 'Node ID must be an unsigned safe integer', undefined, path) }
function validateIdentifier(name: string, d: Diagnostics, nodeId?: number, path?: string): void { if (!IDENTIFIER.test(name)) d.add('IDENTIFIER_INVALID', `Identifier ${name} is not portable`, nodeId, path); if (isReserved(name)) d.add('RESERVED_IDENTIFIER', `Identifier ${name} uses a reserved prefix`, nodeId, path) }
function isReserved(name: string): boolean { const normalized = name.toLowerCase(); return normalized.startsWith('chronolog_') || normalized.startsWith('sqlite_') || normalized.startsWith('dolt_') }
