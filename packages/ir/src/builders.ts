import { decodeUtf8, utf8 } from '@chronolog/canonical'

import { assertValidSchemaManifest, assertValidTransactionProgram, type ProgramValidationContext } from './validation.js'
import type {
  AffectedRowsExpectation, Assignment, BinaryOperator, CanonicalJsonValue, CanonicalQueryResult,
  CompoundTerm, ConditionalBranch, ConflictPolicy, ContextField, Cte, CteRelation, DeleteMutation, ExpectedResult,
  Expr, FtsRelation, InlineResult, InsertMutation, Join, LogicalType, LogicalValue, MergeClause,
  MergeMutation, Mutation, ObjectReference, OrderTerm, PageClause, Precondition, Projection, Query,
  RegisteredStatefulCall, Relation, ResultColumn, ResultDigest, ResultMode, SchemaColumn,
  SchemaConstraint, SchemaIndex, SchemaManifest, SchemaObject, SchemaTable, SeedRow,
  SpatialSearchRelation, SubqueryRelation, SystemRelation, TableFunctionRelation, TableRelation,
  TransactionProgram, UnaryOperator, UpdateMutation, UpsertMutation, ValueType, VectorElementType,
  VectorSearchRelation, ViewRelation, WindowDefinition,
} from './types.js'

export const values = Object.freeze({
  null: (): LogicalValue => Object.freeze({ kind: 'null' }),
  boolean: (value: boolean): LogicalValue => Object.freeze({ kind: 'boolean', value }),
  int64: (value: bigint): LogicalValue => Object.freeze({ kind: 'int64', value }),
  decimal: (coefficient: bigint, scale: number): LogicalValue => { let c = coefficient, s = scale; while (s > 0 && c % 10n === 0n) { c /= 10n; s -= 1 }; return Object.freeze({ kind: 'decimal', coefficient: c, scale: s }) },
  text: (value: string | Uint8Array): LogicalValue => Object.freeze({ kind: 'text', utf8: value instanceof Uint8Array ? utf8(decodeUtf8(value)) : utf8(value) }),
  blob: (value: Uint8Array): LogicalValue => Object.freeze({ kind: 'blob', bytes: Uint8Array.from(value) }),
  uuid: (value: Uint8Array): LogicalValue => Object.freeze({ kind: 'uuid', bytes: Uint8Array.from(value) }),
  timestampMs: (value: bigint): LogicalValue => Object.freeze({ kind: 'timestamp_ms', value }),
  durationMs: (value: bigint): LogicalValue => Object.freeze({ kind: 'duration_ms', value }),
  json: (value: CanonicalJsonValue): LogicalValue => Object.freeze({ kind: 'json', value: copy(value) }),
  vector: (element: VectorElementType, dimensions: number, value: Uint8Array): LogicalValue => Object.freeze({ kind: 'vector', element, dimensions, bytes: Uint8Array.from(value) }),
})

export const logicalTypes = Object.freeze({
  boolean: (): LogicalType => Object.freeze({ kind: 'boolean' }),
  int64: (): LogicalType => Object.freeze({ kind: 'int64' }),
  decimal: (precision: number, scale: number): LogicalType => Object.freeze({ kind: 'decimal', precision, scale }),
  text: (collation: 'binary' | 'unicode_codepoint' | `registered:${number}` = 'binary'): LogicalType => Object.freeze({ kind: 'text', collation }),
  blob: (maxBytes?: number): LogicalType => Object.freeze({ kind: 'blob', ...(maxBytes === undefined ? {} : { maxBytes }) }),
  uuid: (): LogicalType => Object.freeze({ kind: 'uuid' }),
  timestampMs: (): LogicalType => Object.freeze({ kind: 'timestamp_ms' }),
  durationMs: (): LogicalType => Object.freeze({ kind: 'duration_ms' }),
  json: (): LogicalType => Object.freeze({ kind: 'json' }),
  vector: (element: VectorElementType, dimensions: number): LogicalType => Object.freeze({ kind: 'vector', element, dimensions }),
})

export const affectedRows = Object.freeze({
  unconstrained: (): AffectedRowsExpectation => Object.freeze({ kind: 'unconstrained' }),
  exactly: (count: bigint): AffectedRowsExpectation => Object.freeze({ kind: 'exactly', count }),
  atLeast: (count: bigint): AffectedRowsExpectation => Object.freeze({ kind: 'at_least', count }),
  atMost: (count: bigint): AffectedRowsExpectation => Object.freeze({ kind: 'at_most', count }),
  range: (minimum: bigint, maximum: bigint): AffectedRowsExpectation => Object.freeze({ kind: 'range', minimum, maximum }),
})

export const resultModes = Object.freeze({
  scalar: (): ResultMode => Object.freeze({ kind: 'scalar' }),
  ordered: (): ResultMode => Object.freeze({ kind: 'ordered' }),
  multiset: (): ResultMode => Object.freeze({ kind: 'multiset' }),
  set: (): ResultMode => Object.freeze({ kind: 'set' }),
})

export type MutationTarget = string | number | ObjectReference

export interface QueryOptions {
  readonly ctes?: readonly Cte[]
  readonly from?: Relation
  readonly joins?: readonly Join[]
  readonly where?: Expr
  readonly groupBy?: readonly Expr[]
  readonly having?: Expr
  readonly windows?: readonly WindowDefinition[]
  readonly compounds?: readonly CompoundTerm[]
  readonly orderBy?: readonly OrderTerm[]
  readonly page?: PageClause
  readonly resultMode?: ResultMode
}

export interface MutationOptions {
  readonly affectedRows?: AffectedRowsExpectation
  readonly returning?: Query
  readonly label?: string
}

export interface InsertOptions extends MutationOptions { readonly conflict?: ConflictPolicy }
export interface UpdateOptions extends MutationOptions { readonly where?: Expr }
export interface DeleteOptions extends MutationOptions { readonly where?: Expr }
export type UpsertOptions = MutationOptions
export type MergeOptions = MutationOptions

export class IrBuilder {
  private nextId: number
  constructor(startId = 1) { this.nextId = startId }
  id(): number { return this.nextId++ }
  literal(value: LogicalValue): Expr { return immutable({ kind: 'literal', id: this.id(), value }) }
  parameter(name: string, valueType: ValueType): Expr { return immutable({ kind: 'parameter', id: this.id(), name, valueType }) }
  column(name: string, relation?: string): Expr { return immutable({ kind: 'column', id: this.id(), name, ...(relation === undefined ? {} : { relation }) }) }
  context(field: ContextField): Expr { return immutable({ kind: 'context', id: this.id(), field }) }
  oldNew(scope: 'old' | 'new', column: string): Expr { return immutable({ kind: 'old_new', id: this.id(), scope, column }) }
  unary(operator: UnaryOperator, operand: Expr): Expr { return immutable({ kind: 'unary', id: this.id(), operator, operand }) }
  binary(operator: BinaryOperator, left: Expr, right: Expr): Expr { return immutable({ kind: 'binary', id: this.id(), operator, left, right }) }
  branch(when: Expr, then: Expr): ConditionalBranch { return immutable({ when, then }) }
  conditional(branches: readonly ConditionalBranch[], otherwise: Expr): Expr { return immutable({ kind: 'conditional', id: this.id(), branches: [...branches], otherwise }) }
  cast(value: Expr, target: LogicalType): Expr { return immutable({ kind: 'cast', id: this.id(), value, target }) }
  functionCall(functionId: number, args: readonly Expr[]): Expr { return immutable({ kind: 'function', id: this.id(), functionId, args: [...args] }) }
  jsonOperation(operation: 'extract' | 'type' | 'array' | 'object' | 'merge', args: readonly Expr[], path?: string): Expr { return immutable({ kind: 'json', id: this.id(), operation, args: [...args], ...(path === undefined ? {} : { path }) }) }
  scalarSubquery(query: Query): Expr { return immutable({ kind: 'scalar_subquery', id: this.id(), query }) }
  exists(query: Query, negated = false): Expr { return immutable({ kind: 'exists', id: this.id(), query, negated }) }
  membership(value: Expr, members: readonly Expr[] | Query, negated = false): Expr {
    return immutable(Array.isArray(members)
      ? { kind: 'membership', id: this.id(), value, values: [...members as readonly Expr[]], negated }
      : { kind: 'membership', id: this.id(), value, query: members as Query, negated })
  }
  entropy(label: string, index: number, length: number): Expr { return immutable({ kind: 'entropy', id: this.id(), label, index, length }) }

  table(name: string, alias?: string): TableRelation { return immutable({ kind: 'table', id: this.id(), name, ...(alias === undefined ? {} : { alias }) }) }
  view(name: string, alias?: string): ViewRelation { return immutable({ kind: 'view', id: this.id(), name, ...(alias === undefined ? {} : { alias }) }) }
  subquery(query: Query, alias: string): SubqueryRelation { return immutable({ kind: 'subquery', id: this.id(), query, alias }) }
  cteReference(name: string, alias?: string): CteRelation { return immutable({ kind: 'cte', id: this.id(), name, ...(alias === undefined ? {} : { alias }) }) }
  tableFunction(functionId: number, args: readonly Expr[], alias: string): TableFunctionRelation { return immutable({ kind: 'table_function', id: this.id(), functionId, args: [...args], alias }) }
  fts(indexId: number, query: Expr, alias: string): FtsRelation { return immutable({ kind: 'fts', id: this.id(), indexId, query, alias }) }
  vectorSearch(indexId: number, vector: Expr, limit: number, alias: string): VectorSearchRelation { return immutable({ kind: 'vector_search', id: this.id(), indexId, vector, limit, alias }) }
  spatialSearch(indexId: number, predicate: Expr, alias: string): SpatialSearchRelation { return immutable({ kind: 'spatial_search', id: this.id(), indexId, predicate, alias }) }
  transactionLog(alias?: string): SystemRelation { return immutable({ kind: 'system_relation', id: this.id(), relation: 'transaction_log', ...(alias === undefined ? {} : { alias }) }) }

  cte(name: string, query: Query, materialized: Cte['materialized'] = 'default'): Cte { return immutable({ id: this.id(), name, query, materialized }) }
  join(kind: Join['kind'], relation: Relation, on?: Expr): Join { return immutable({ id: this.id(), kind, relation, ...(on === undefined ? {} : { on }) }) }
  projection(name: string, expression: Expr): Projection { return immutable({ id: this.id(), name, expression }) }
  order(expression: Expr, direction: OrderTerm['direction'] = 'asc', nulls: OrderTerm['nulls'] = direction === 'asc' ? 'last' : 'first', canonicalRowTieBreaker = false): OrderTerm {
    return immutable({ id: this.id(), expression, direction, nulls, ...(canonicalRowTieBreaker ? { canonicalRowTieBreaker: true } : {}) })
  }
  page(limit: number, offset?: number): PageClause { return immutable({ limit, ...(offset === undefined ? {} : { offset }) }) }
  window(name: string, partitionBy: readonly Expr[] = [], orderBy: readonly OrderTerm[] = []): WindowDefinition { return immutable({ id: this.id(), name, partitionBy: [...partitionBy], orderBy: [...orderBy] }) }
  compound(operator: CompoundTerm['operator'], query: Query): CompoundTerm { return immutable({ id: this.id(), operator, query }) }
  query(projection: readonly Projection[], options: QueryOptions = {}): Query {
    return immutable({
      id: this.id(), ctes: [...(options.ctes ?? [])], joins: [...(options.joins ?? [])],
      groupBy: [...(options.groupBy ?? [])], projection: [...projection], windows: [...(options.windows ?? [])],
      compounds: [...(options.compounds ?? [])], orderBy: [...(options.orderBy ?? [])],
      resultMode: options.resultMode ?? resultModes.multiset(),
      ...(options.from === undefined ? {} : { from: options.from }),
      ...(options.where === undefined ? {} : { where: options.where }),
      ...(options.having === undefined ? {} : { having: options.having }),
      ...(options.page === undefined ? {} : { page: options.page }),
    })
  }

  assignment(column: string, value: Expr): Assignment { return immutable({ column, value }) }
  mergeClause(when: MergeClause['when'], action: MergeClause['action'], assignments: readonly Assignment[] = [], predicate?: Expr): MergeClause {
    return immutable({ id: this.id(), when, action, assignments: [...assignments], ...(predicate === undefined ? {} : { predicate }) })
  }
  insert(target: MutationTarget, columns: readonly string[], rows: readonly (readonly Expr[])[], expectationOrOptions: AffectedRowsExpectation | InsertOptions = affectedRows.unconstrained()): InsertMutation {
    const options = isAffectedRows(expectationOrOptions) ? { affectedRows: expectationOrOptions } : expectationOrOptions
    return immutable({ kind: 'insert', id: this.id(), target: targetReference(target), columns: [...columns], rows: rows.map((row) => [...row]), conflict: options.conflict ?? 'error', ...mutationFields(options) })
  }
  update(target: MutationTarget, assignments: readonly Assignment[], options: UpdateOptions = {}): UpdateMutation {
    return immutable({ kind: 'update', id: this.id(), target: targetReference(target), assignments: [...assignments], ...(options.where === undefined ? {} : { where: options.where }), ...mutationFields(options) })
  }
  delete(target: MutationTarget, options: DeleteOptions = {}): DeleteMutation {
    return immutable({ kind: 'delete', id: this.id(), target: targetReference(target), ...(options.where === undefined ? {} : { where: options.where }), ...mutationFields(options) })
  }
  upsert(target: MutationTarget, columns: readonly string[], row: readonly Expr[], constraint: string, updates: readonly Assignment[], options: UpsertOptions = {}): UpsertMutation {
    return immutable({ kind: 'upsert', id: this.id(), target: targetReference(target), columns: [...columns], row: [...row], constraint, updates: [...updates], ...mutationFields(options) })
  }
  merge(target: MutationTarget, source: Query, on: Expr, clauses: readonly MergeClause[], options: MergeOptions = {}): MergeMutation {
    return immutable({ kind: 'merge', id: this.id(), target: targetReference(target), source, on, clauses: [...clauses], ...mutationFields(options) })
  }
  statefulCall(moduleId: number, operationId: number, args: readonly Expr[], options: MutationOptions = {}): RegisteredStatefulCall {
    return immutable({ kind: 'stateful_call', id: this.id(), moduleId, operationId, args: [...args], ...mutationFields(options) })
  }

  resultColumn(name: string, valueType: ValueType): ResultColumn { return immutable({ id: this.id(), name, valueType }) }
  queryResult(resultMode: ResultMode, columns: readonly ResultColumn[], rows: readonly (readonly LogicalValue[])[]): CanonicalQueryResult { return immutable({ resultMode, columns: [...columns], rows: rows.map((row) => [...row]) }) }
  inlineResult(result: CanonicalQueryResult): InlineResult { return immutable({ kind: 'inline', result }) }
  resultDigest(digest: Uint8Array, resultMode: ResultMode, columns: readonly ResultColumn[]): ResultDigest { return immutable({ kind: 'digest', digest: Uint8Array.from(digest), resultMode, columns: [...columns] }) }
  assertion(query: Query): Precondition { return immutable({ kind: 'assert', id: this.id(), query, unknownIsFailure: true }) }
  expect(query: Query, expected: ExpectedResult): Precondition { return immutable({ kind: 'expect', id: this.id(), query, expected }) }
  expectInline(query: Query, result: CanonicalQueryResult): Precondition { return this.expect(query, this.inlineResult(result)) }
  expectResultDigest(query: Query, digest: Uint8Array, resultMode: ResultMode, columns: readonly ResultColumn[]): Precondition { return this.expect(query, this.resultDigest(digest, resultMode, columns)) }
  program(preconditions: readonly Precondition[], mutations: readonly Mutation[], metadata?: ReadonlyMap<string, Uint8Array>): TransactionProgram { return immutable({ preconditions: [...preconditions], mutations: [...mutations], ...(metadata === undefined ? {} : { metadata: new Map([...metadata].map(([key, value]) => [key, Uint8Array.from(value)])) }) }) }
  build(program: TransactionProgram, context: ProgramValidationContext = {}): { readonly program: TransactionProgram; readonly diagnostics: ReadonlyMap<number, never> } { assertValidTransactionProgram(program, context); return { program: deepFreeze(copy(program)), diagnostics: new Map<number, never>() } }
}

function isAffectedRows(value: AffectedRowsExpectation | InsertOptions): value is AffectedRowsExpectation { return 'kind' in value }
function targetReference(target: MutationTarget): ObjectReference { return typeof target === 'string' ? { kind: 'name', name: target } : typeof target === 'number' ? { kind: 'id', objectId: target } : target }
function mutationFields(options: MutationOptions): Pick<InsertMutation, 'affectedRows' | 'returning' | 'label'> {
  return {
    affectedRows: options.affectedRows ?? affectedRows.unconstrained(),
    ...(options.returning === undefined ? {} : { returning: options.returning }),
    ...(options.label === undefined ? {} : { label: options.label }),
  }
}

/** Schema-independent manifest builder with one deterministic, monotonic ID allocator. */
export class SchemaBuilder {
  private nextId: number
  private declarationOrder = 0
  public constructor(startId = 1) { this.nextId = startId }
  public id(): number { return this.nextId++ }
  public type(logical: LogicalType, nullable = false): ValueType { return { logical, nullable } }
  public column(name: string, valueType: ValueType, options: { readonly defaultValue?: LogicalValue; readonly generated?: Expr } = {}): SchemaColumn {
    return { id: this.id(), name, declarationOrder: this.declarationOrder++, valueType, ...options }
  }
  public primaryKey(name: string, columns: readonly (number | SchemaColumn)[]): SchemaConstraint {
    return { kind: 'primary_key', id: this.id(), name, columnIds: columns.map(schemaId) }
  }
  public unique(name: string, columns: readonly (number | SchemaColumn)[]): SchemaConstraint {
    return { kind: 'unique', id: this.id(), name, columnIds: columns.map(schemaId) }
  }
  public table(name: string, columns: readonly SchemaColumn[], constraints: readonly SchemaConstraint[] = [], withoutRowId = false): SchemaTable {
    return { kind: 'table', id: this.id(), name, declarationOrder: this.declarationOrder++, columns: [...columns], constraints: [...constraints], withoutRowId }
  }
  public index(name: string, table: number | SchemaTable, expressions: readonly Expr[], unique = false, where?: Expr): SchemaIndex {
    return { kind: 'index', id: this.id(), name, declarationOrder: this.declarationOrder++, tableId: schemaId(table), expressions: [...expressions], unique, ...(where === undefined ? {} : { where }) }
  }
  public seed(table: number | SchemaTable, valuesByColumn: ReadonlyMap<number | SchemaColumn, LogicalValue>): SeedRow {
    return { tableId: schemaId(table), values: new Map([...valuesByColumn].map(([column, value]) => [schemaId(column), copy(value)])) }
  }
  public schema(name: string, objects: readonly SchemaObject[], seedRows: readonly SeedRow[] = [], registries: { readonly functionIds?: readonly number[]; readonly collationIds?: readonly number[]; readonly moduleIds?: readonly number[] } = {}): SchemaManifest {
    const manifest: SchemaManifest = {
      version: 1, name, objects: [...objects], seedRows: seedRows.map(copy),
      functionIds: [...(registries.functionIds ?? [])], collationIds: [...(registries.collationIds ?? [])], moduleIds: [...(registries.moduleIds ?? [])],
    }
    assertValidSchemaManifest(manifest)
    return deepFreeze(copy(manifest))
  }
}

function schemaId(value: number | { readonly id: number }): number { return typeof value === 'number' ? value : value.id }

function immutable<T>(value: T): T { return deepFreeze(copy(value)) }

function copy<T>(value: T): T {
  if (value instanceof Uint8Array) return Uint8Array.from(value) as T
  if (Array.isArray(value)) return value.map(copy) as T
  if (value instanceof Map) return new Map([...value].map(([key, item]) => [key, copy(item)])) as T
  if (typeof value === 'object' && value !== null) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, copy(item)])) as T
  return value
}
function deepFreeze<T>(value: T): T { if (Array.isArray(value)) { value.forEach(deepFreeze); Object.freeze(value) } else if (value instanceof Map) { for (const item of value.values()) deepFreeze(item); Object.freeze(value) } else if (typeof value === 'object' && value !== null && !(value instanceof Uint8Array)) { Object.values(value).forEach(deepFreeze); Object.freeze(value) }; return value }
