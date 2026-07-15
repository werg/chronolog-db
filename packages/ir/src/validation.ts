import { CanonicalError, decodeUtf8, utf8 } from '@chronolog/canonical'

import {
  isReservedSchemaObjectName,
  isValidSqlIdentifier,
  sqliteIdentifierKey,
} from './identifiers.js'
import { BUILTIN_FUNCTION_NAMES } from './types.js'
import { collectRelationEffects, semanticComplexity, walkExpr, walkProgram, walkQuery } from './visitors.js'
import type {
  CanonicalJsonValue, CanonicalQueryResult, ExecutionManifest, Expr, IrDiagnostic, IrValidationResult,
  LogicalType, LogicalValue, Mutation, OrderingProof, Query, SchemaManifest, TransactionProgram,
  UpsertConflictTarget,
} from './types.js'

const ENTROPY_LABEL = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/u
const INT64_MIN = -(1n << 63n), INT64_MAX = (1n << 63n) - 1n
const BUILTIN_FUNCTIONS: ReadonlySet<string> = new Set(BUILTIN_FUNCTION_NAMES)

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
  if (Array.isArray(value)) { (value as readonly CanonicalJsonValue[]).forEach((item, index) => validateJson(item, d, `${path}[${index}]`, depth + 1)); return }
  if (value instanceof Map) { for (const [key, item] of value as ReadonlyMap<string, CanonicalJsonValue>) { try { utf8(key) } catch { d.add('JSON_KEY_INVALID', 'JSON key is invalid Unicode', undefined, path) }; validateJson(item, d, `${path}.${key}`, depth + 1) }; return }
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
  // The backend preserves authored ORDER BY terms and completes them with the
  // projected canonical row. Distinct physical rows with identical projections
  // are observationally interchangeable, so this is total for every result
  // Chronolog can encode. The legacy marker remains decodable but is no longer
  // a caller-supplied proof obligation.
  if (query.projection.length === 0) {
    return { total: false, reason: 'not_total', keyProjectionIds: [] }
  }
  return {
    total: true,
    reason: 'canonical_row',
    keyProjectionIds: query.projection.map((projection) => projection.id),
  }
}

export function validateQuery(query: Query, context: ProgramValidationContext = {}): IrValidationResult<Query> {
  const d = new Diagnostics(context.maxDiagnostics ?? 100)
  validateQueryInto(query, d, { ...context, allowParameters: context.allowParameters ?? true }, 'query')
  return { ok: d.values.length === 0, ...(d.values.length === 0 ? { value: query } : {}), diagnostics: d.values }
}

function validateQueryInto(query: Query, d: Diagnostics, context: ProgramValidationContext, path: string): void {
  validateId(query.id, d, path)
  if (query.projection.length === 0) d.add('QUERY_PROJECTION_EMPTY', 'Query must project at least one value', query.id, path)
  if (query.recursive === true && query.ctes.length === 0) {
    d.add('RECURSIVE_CTE_REQUIRED', 'WITH RECURSIVE requires at least one CTE', query.id, path)
  }
  if (query.resultMode.kind === 'scalar' && query.projection.length !== 1) d.add('SCALAR_WIDTH_INVALID', 'Scalar query must project exactly one value', query.id, path)
  const ordering = proveQueryOrdering(query)
  if (query.resultMode.kind === 'ordered' && !ordering.total) d.add('ORDER_NOT_TOTAL', 'Ordered query must expose a canonical row the compiler can order', query.id, path)
  if (query.page !== undefined && !ordering.total) d.add('PAGE_WITHOUT_TOTAL_ORDER', 'LIMIT/OFFSET requires a canonical result row', query.id, path)
  if (query.page !== undefined && (!Number.isSafeInteger(query.page.limit) || query.page.limit < 0 || (query.page.offset !== undefined && (!Number.isSafeInteger(query.page.offset) || query.page.offset < 0)))) d.add('PAGE_INVALID', 'Page bounds must be nonnegative safe integers', query.id, path)
  for (const projection of query.projection) validateIdentifier(projection.name, d, projection.id, `${path}.projection`)
  for (const join of query.joins) {
    if (join.on !== undefined && join.using !== undefined) {
      d.add('JOIN_CONSTRAINT_AMBIGUOUS', 'Join cannot contain both ON and USING', join.id, `${path}.join`)
    }
    if (join.kind === 'cross' && (join.on !== undefined || join.using !== undefined)) {
      d.add('CROSS_JOIN_CONSTRAINT', 'CROSS JOIN cannot contain ON or USING in canonical IR', join.id, `${path}.join`)
    }
    if (join.using !== undefined) {
      if (join.using.length === 0) d.add('JOIN_USING_EMPTY', 'USING must contain at least one column', join.id, `${path}.join`)
      const seen = new Set<string>()
      for (const column of join.using) {
        validateIdentifier(column, d, join.id, `${path}.join.using`)
        const key = sqliteIdentifierKey(column)
        if (seen.has(key)) d.add('JOIN_USING_DUPLICATE', `USING contains duplicate column ${column}`, join.id, `${path}.join.using`)
        seen.add(key)
      }
    }
  }
  if (query.from?.kind === 'table' || query.from?.kind === 'view') validateIdentifier(query.from.name, d, query.from.id, `${path}.from`)
  walkQuery(query, {
    expr: (expr) => validateExpr(expr, d, context, path),
    relation: (relation) => {
      validateId(relation.id, d, path)
      if ('name' in relation) validateIdentifier(relation.name, d, relation.id, `${path}.relation.name`)
      if ('alias' in relation && relation.alias !== undefined) validateIdentifier(relation.alias, d, relation.id, `${path}.relation.alias`)
      if (relation.kind === 'system_relation' && relation.relation !== 'transaction_log') d.add('SYSTEM_RELATION_INVALID', 'Unknown consensus system relation', relation.id, path)
    },
    cte: (cte) => validateIdentifier(cte.name, d, cte.id, `${path}.cte.name`),
    window: (window) => validateIdentifier(window.name, d, window.id, `${path}.window.name`),
  })
}

function validateExpr(expr: Expr, d: Diagnostics, context: ProgramValidationContext, path: string): void {
  validateId(expr.id, d, path)
  if (expr.kind === 'literal') validateValue(expr.value, d, `${path}.literal`, 0)
  if (expr.kind === 'parameter') {
    validateIdentifier(expr.name, d, expr.id, path)
    if (context.allowParameters !== true) d.add('DRAFT_PARAMETER_UNSUBSTITUTED', 'Signed transaction programs cannot contain parameter expressions', expr.id, path)
  }
  if (expr.kind === 'column') {
    validateIdentifier(expr.name, d, expr.id, path)
    if (expr.relation !== undefined) validateIdentifier(expr.relation, d, expr.id, path)
  }
  if (expr.kind === 'old_new') validateIdentifier(expr.column, d, expr.id, path)
  if (expr.kind === 'entropy' && (!ENTROPY_LABEL.test(expr.label) || !Number.isSafeInteger(expr.index) || expr.index < 0 || !Number.isSafeInteger(expr.length) || expr.length < 1)) d.add('ENTROPY_REQUEST_INVALID', 'Entropy request label/index/length is invalid', expr.id, path)
  if (expr.kind === 'function') {
    const fn = context.manifest?.functions.find((entry) => entry.id === expr.functionId)
    if (context.manifest !== undefined && fn === undefined) d.add('FUNCTION_UNREGISTERED', 'Expression references an unregistered function', expr.id, path)
    if (fn?.effect === 'stateful') d.add('FUNCTION_NOT_PURE', 'Stateful function cannot appear in an expression', expr.id, path)
  }
  if (expr.kind === 'builtin' && !BUILTIN_FUNCTIONS.has(expr.name)) {
    d.add('BUILTIN_FUNCTION_INVALID', 'Expression references an unknown compiler-owned builtin function', expr.id, path)
  }
  if (expr.kind === 'aggregate') {
    if (expr.operation !== 'count' && expr.operation !== 'min' && expr.operation !== 'max' &&
        expr.operation !== 'every' && expr.operation !== 'any') {
      d.add('AGGREGATE_OPERATION_INVALID', 'Aggregate operation is not part of the canonical core', expr.id, path)
    }
    if (typeof expr.distinct !== 'boolean') {
      d.add('AGGREGATE_DISTINCT_INVALID', 'Aggregate DISTINCT marker must be Boolean', expr.id, path)
    }
    if (expr.value === undefined && (expr.operation !== 'count' || expr.distinct === true)) {
      d.add('AGGREGATE_ARGUMENT_REQUIRED', 'Only non-distinct COUNT may omit its argument', expr.id, path)
    }
  }
  if (expr.kind === 'row' && expr.items.length < 2) {
    d.add('ROW_VALUE_WIDTH_INVALID', 'Row values must contain at least two items', expr.id, path)
  }
  if (expr.kind === 'window') {
    const operations = new Set(['count', 'min', 'max', 'every', 'any', 'row_number', 'rank', 'dense_rank', 'ntile', 'lag', 'lead'])
    if (!operations.has(expr.operation)) d.add('WINDOW_OPERATION_INVALID', 'Unknown window operation', expr.id, path)
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
    upsertClause: (clause) => record(clause.id, 'upsert_clause'),
  })
  const complexity = semanticComplexity(program)
  if (context.manifest !== undefined && complexity > context.manifest.resources.maxProgramNodes) d.add('PROGRAM_RESOURCE_EXCEEDED', 'Program exceeds manifest node limit')
  const effects = collectRelationEffects(program)
  for (const name of [...effects.reads, ...effects.writes]) if (isReservedSchemaObjectName(name)) d.add('RESERVED_OBJECT_ACCESS', `Program accesses reserved object ${name}`)
  if (context.schema !== undefined) {
    const names = new Set(context.schema.objects.flatMap((object) => isValidSqlIdentifier(object.name) ? [sqliteIdentifierKey(object.name)] : []))
    for (const name of [...effects.reads, ...effects.writes]) {
      if (isValidSqlIdentifier(name) && !names.has(sqliteIdentifierKey(name))) d.add('OBJECT_NOT_FOUND', `Object ${name} is not in the schema manifest`)
    }
  }
  return { ok: d.values.length === 0, ...(d.values.length === 0 ? { value: program } : {}), diagnostics: d.values }
}

function validateMutation(mutation: Mutation, d: Diagnostics, context: ProgramValidationContext, record: (id: number, path: string) => void): void {
  record(mutation.id, 'mutation')
  if ('target' in mutation && mutation.target.kind === 'name') validateIdentifier(mutation.target.name, d, mutation.id, 'mutation.target')
  if ('alias' in mutation && mutation.alias !== undefined) {
    validateIdentifier(mutation.alias, d, mutation.id, 'mutation.alias')
  }
  if ('ctes' in mutation) {
    const cteNames = new Set<string>()
    for (const cte of mutation.ctes ?? []) {
      validateIdentifier(cte.name, d, cte.id, 'mutation.cte.name')
      const key = sqliteIdentifierKey(cte.name)
      if (cteNames.has(key)) d.add('DUPLICATE_CTE', `Duplicate mutation CTE ${cte.name}`, cte.id)
      cteNames.add(key)
    }
  }
  if ('target' in mutation && mutation.recursive === true && (mutation.ctes?.length ?? 0) === 0) {
    d.add('RECURSIVE_CTE_REQUIRED', 'WITH RECURSIVE requires at least one mutation CTE', mutation.id)
  }
  if (mutation.kind === 'insert' || mutation.kind === 'upsert') {
    for (const column of mutation.columns) validateIdentifier(column, d, mutation.id, 'mutation.column')
  }
  if (mutation.kind === 'update') for (const assignment of mutation.assignments) validateIdentifier(assignment.column, d, mutation.id, 'mutation.assignment')
  if (mutation.kind === 'update' && mutation.fromAlias !== undefined) validateIdentifier(mutation.fromAlias, d, mutation.id, 'mutation.fromAlias')
  if (mutation.kind === 'upsert') for (const assignment of mutation.updates) validateIdentifier(assignment.column, d, mutation.id, 'mutation.assignment')
  if (mutation.kind === 'upsert') validateIdentifier(mutation.constraint, d, mutation.id, 'mutation.constraint')
  if (mutation.kind === 'merge') {
    for (const clause of mutation.clauses) for (const assignment of clause.assignments) validateIdentifier(assignment.column, d, clause.id, 'mutation.merge.assignment')
  }
  const affected = mutation.affectedRows
  if (affected.kind !== 'unconstrained') {
    const counts = affected.kind === 'range' ? [affected.minimum, affected.maximum] : [affected.count]
    if (counts.some((count) => count < 0n) || (affected.kind === 'range' && affected.minimum > affected.maximum)) d.add('AFFECTED_ROWS_INVALID', 'Affected-row expectation is invalid', mutation.id)
  }
  if (mutation.kind === 'insert') {
    const hasRows = mutation.rows.length > 0
    const hasSource = mutation.source !== undefined
    const defaultValues = mutation.columns.length === 0 && mutation.rows.length === 1 && mutation.rows[0]!.length === 0
    if (hasRows === hasSource ||
        (!defaultValues && (mutation.columns.length === 0 || mutation.rows.some((row) => row.length !== mutation.columns.length)))) {
      d.add('INSERT_SHAPE_INVALID', 'Insert requires values rows, a query source, or the canonical DEFAULT VALUES shape', mutation.id)
    }
    if (!['error', 'ignore', 'replace'].includes(mutation.conflict)) d.add('INSERT_CONFLICT_INVALID', 'Insert conflict policy is invalid', mutation.id)
    const clauses = mutation.upsertClauses ?? []
    if (defaultValues && clauses.length > 0) {
      d.add('UPSERT_DEFAULT_VALUES_INVALID', 'SQLite DEFAULT VALUES cannot carry UPSERT clauses', mutation.id)
    }
    clauses.forEach((clause, index) => {
      if (clause.target === undefined && index !== clauses.length - 1) {
        d.add('UPSERT_TARGET_REQUIRED', 'Only the final UPSERT clause may omit its conflict target', clause.id)
      }
      if (clause.target !== undefined) {
        const hasConstraint = 'constraintId' in clause.target
        const hasIndex = 'indexId' in clause.target
        if (hasConstraint === hasIndex) {
          d.add('UPSERT_CONFLICT_TARGET_INVALID', 'UPSERT target must identify exactly one unique constraint or index', clause.id)
        } else {
          const targetId = hasConstraint ? clause.target.constraintId : clause.target.indexId
          validateId(targetId, d, 'mutation.upsert.target')
          validateUpsertTarget(mutation, clause.target, context.schema, d, clause.id)
        }
      }
      for (const assignment of clause.assignments) {
        validateIdentifier(assignment.column, d, clause.id, 'mutation.upsert.assignment')
      }
      if (clause.action === 'nothing') {
        if (clause.assignments.length > 0 || clause.where !== undefined) {
          d.add('UPSERT_NOTHING_SHAPE_INVALID', 'DO NOTHING cannot contain assignments or a WHERE predicate', clause.id)
        }
      } else if (clause.action === 'update') {
        if (clause.assignments.length === 0) {
          d.add('UPSERT_UPDATE_ASSIGNMENTS_EMPTY', 'DO UPDATE requires at least one assignment', clause.id)
        }
      } else {
        d.add('UPSERT_ACTION_INVALID', 'UPSERT action is invalid', clause.id)
      }
    })
  }
  if (mutation.kind === 'upsert') {
    const hasRow = mutation.row.length > 0
    const hasSource = mutation.source !== undefined
    if (mutation.columns.length === 0 || hasRow === hasSource || (hasRow && mutation.row.length !== mutation.columns.length)) {
      d.add('UPSERT_SHAPE_INVALID', 'Upsert requires exactly one values row or query source matching explicit columns', mutation.id)
    }
  }
  if (mutation.kind === 'update') {
    if (mutation.assignments.length === 0) d.add('UPDATE_ASSIGNMENTS_EMPTY', 'Update requires assignments', mutation.id)
    if (mutation.conflict !== undefined && !['error', 'ignore', 'replace'].includes(mutation.conflict)) d.add('UPDATE_CONFLICT_INVALID', 'Update conflict policy is invalid', mutation.id)
    if ((mutation.from === undefined) !== (mutation.fromAlias === undefined)) d.add('UPDATE_FROM_SHAPE_INVALID', 'UPDATE FROM requires both a source query and alias', mutation.id)
  }
  if (mutation.kind === 'merge' && mutation.clauses.length === 0) d.add('MERGE_CLAUSES_EMPTY', 'Merge requires clauses', mutation.id)
  if (mutation.kind === 'stateful_call' && context.manifest !== undefined && !context.manifest.modules.some((module) => module.id === mutation.moduleId)) d.add('MODULE_UNREGISTERED', 'Stateful call references an unregistered module', mutation.id)
  walkMutationExpressions(mutation, d, context)
}

function validateUpsertTarget(
  mutation: Extract<Mutation, { readonly kind: 'insert' }>,
  target: UpsertConflictTarget,
  schema: SchemaManifest | undefined,
  d: Diagnostics,
  nodeId: number,
): void {
  if (schema === undefined) return
  const reference = mutation.target
  const object = reference.kind === 'id'
    ? schema.objects.find((candidate) => candidate.id === reference.objectId)
    : schema.objects.find((candidate) => sqliteIdentifierKey(candidate.name) === sqliteIdentifierKey(reference.name))
  if (object?.kind !== 'table') return
  if ('constraintId' in target) {
    const constraint = object.constraints.find((candidate) => candidate.id === target.constraintId)
    if (constraint?.kind !== 'primary_key' && constraint?.kind !== 'unique') {
      d.add('UPSERT_CONFLICT_TARGET_INVALID', 'UPSERT target must reference a unique constraint on the inserted table', nodeId)
    }
    return
  }
  const index = schema.objects.find((candidate) => candidate.id === target.indexId)
  if (index?.kind !== 'index' || !index.unique || index.tableId !== object.id) {
    d.add('UPSERT_CONFLICT_TARGET_INVALID', 'UPSERT target must reference a unique index on the inserted table', nodeId)
  }
}

function walkMutationExpressions(mutation: Mutation, d: Diagnostics, context: ProgramValidationContext): void {
  // The visitor is deliberately expression-only here; query structure is checked explicitly
  // so nested query visitors do not recursively validate the same tree without bound.
  const validate = (expr: Expr) => validateExpr(expr, d, context, 'mutation')
  if (mutation.returning !== undefined) validateQueryInto(mutation.returning, d, context, 'mutation.returning')
  if ('ctes' in mutation) {
    for (const cte of mutation.ctes ?? []) validateQueryInto(cte.query, d, context, 'mutation.cte')
  }
  switch (mutation.kind) {
    case 'insert':
      for (const row of mutation.rows) for (const expr of row) walkExpr(expr, { expr: validate })
      if (mutation.source !== undefined) validateQueryInto(mutation.source, d, context, 'mutation.source')
      for (const clause of mutation.upsertClauses ?? []) {
        for (const assignment of clause.assignments) walkExpr(assignment.value, { expr: validate })
        if (clause.where !== undefined) walkExpr(clause.where, { expr: validate })
      }
      return
    case 'update': for (const assignment of mutation.assignments) walkExpr(assignment.value, { expr: validate }); if (mutation.where !== undefined) walkExpr(mutation.where, { expr: validate }); if (mutation.from !== undefined) validateQueryInto(mutation.from, d, context, 'mutation.from'); return
    case 'delete': if (mutation.where !== undefined) walkExpr(mutation.where, { expr: validate }); return
    case 'upsert': for (const expr of mutation.row) walkExpr(expr, { expr: validate }); if (mutation.source !== undefined) validateQueryInto(mutation.source, d, context, 'mutation.source'); for (const assignment of mutation.updates) walkExpr(assignment.value, { expr: validate }); if (mutation.where !== undefined) walkExpr(mutation.where, { expr: validate }); return
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
  for (let row = 0; row < result.rows.length; row += 1) { if (result.rows[row]!.length !== result.columns.length) d.add('RESULT_WIDTH_INVALID', 'Result row width differs from output schema', ownerId, `rows[${row}]`); result.rows[row]!.forEach((value, column) => validateValue(value, d, `rows[${row}][${column}]`, 0)) }
  if (result.resultMode.kind === 'scalar' && (result.columns.length !== 1 || result.rows.length > 1)) d.add('SCALAR_RESULT_INVALID', 'Scalar result must have one column and at most one row', ownerId)
}

export function validateSchemaManifest(schema: SchemaManifest): IrValidationResult<SchemaManifest> {
  const d = new Diagnostics(200), ids = new Set<number>(), names = new Set<string>()
  if (schema.version !== 1) d.add('SCHEMA_VERSION_UNSUPPORTED', 'Schema manifest version must be 1')
  validateIdentifier(schema.name, d, undefined, 'schema.name')
  for (const object of schema.objects) {
    if (ids.has(object.id)) d.add('DUPLICATE_SCHEMA_ID', 'Duplicate schema object ID', object.id); ids.add(object.id)
    validateSchemaObjectIdentifier(object.name, d, object.id, 'schema.object')
    if (isValidSqlIdentifier(object.name)) {
      const objectNameKey = sqliteIdentifierKey(object.name)
      if (names.has(objectNameKey)) d.add('DUPLICATE_SCHEMA_NAME', 'Duplicate schema object name under SQLite identifier comparison', object.id)
      names.add(objectNameKey)
    }
    if (object.kind === 'table') {
      const columnIds = new Set<number>(), columnNames = new Set<string>()
      for (const column of object.columns) {
        if (columnIds.has(column.id) || ids.has(column.id)) d.add('DUPLICATE_SCHEMA_ID', 'Duplicate schema column ID', column.id)
        columnIds.add(column.id); ids.add(column.id)
        validateIdentifier(column.name, d, column.id, 'schema.column')
        if (isValidSqlIdentifier(column.name)) {
          const columnNameKey = sqliteIdentifierKey(column.name)
          if (columnNames.has(columnNameKey)) d.add('DUPLICATE_COLUMN_NAME', 'Duplicate column name under SQLite identifier comparison', column.id)
          columnNames.add(columnNameKey)
        }
        for (const diagnostic of validateLogicalType(column.valueType.logical)) d.add(diagnostic.code, diagnostic.message, column.id)
        if (column.defaultValue !== undefined) validateValue(column.defaultValue, d, 'schema.default', 0)
      }
      for (const constraint of object.constraints) {
        validateIdentifier(constraint.name, d, constraint.id, 'schema.constraint')
      }
    }
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
function validateIdentifier(name: string, d: Diagnostics, nodeId?: number, path?: string): void {
  if (!isValidSqlIdentifier(name)) d.add('IDENTIFIER_INVALID', 'Identifier must be nonempty, well-formed Unicode without NUL', nodeId, path)
}

function validateSchemaObjectIdentifier(name: string, d: Diagnostics, nodeId?: number, path?: string): void {
  validateIdentifier(name, d, nodeId, path)
  if (isReservedSchemaObjectName(name)) d.add('RESERVED_IDENTIFIER', `Schema object ${name} uses a reserved internal namespace`, nodeId, path)
}
