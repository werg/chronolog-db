import type {
  ColumnExpr,
  Expr,
  LogicalType,
  LogicalValue,
  Query,
  Relation,
  ResultColumn,
  SchemaTable,
  ValueType,
} from '@chronolog/ir'

import type { Catalog } from './catalog.js'
import { CompilerError, type BackendParameter, type BindingSource } from './types.js'

export interface RelationScope {
  readonly alias: string
  readonly table: SchemaTable
}

export class SqlRenderer {
  readonly #catalog: Catalog
  readonly #parameters: BackendParameter[] = []

  constructor(catalog: Catalog) {
    this.#catalog = catalog
  }

  get parameters(): readonly BackendParameter[] {
    return this.#parameters
  }

  expression(expression: Expr, scopes: readonly RelationScope[], mutationTarget?: RelationScope): string {
    switch (expression.kind) {
      case 'literal':
        assertLiteralEnabled(expression.value, this.#catalog, expression.id)
        return this.#bind({ kind: 'literal', value: expression.value }, valueTypeOf(expression.value))
      case 'context': return this.#bind(
        { kind: 'context', field: expression.field },
        contextValueType(expression.field),
      )
      case 'entropy': {
        assertEntropyRequest(expression)
        return this.#bind(
          { kind: 'entropy', label: expression.label, index: expression.index, length: expression.length },
          { logical: { kind: 'blob', maxBytes: expression.length }, nullable: false },
        )
      }
      case 'column': return this.#column(expression, scopes)
      case 'old_new': {
        if (mutationTarget === undefined) throw new CompilerError('IR_OLD_NEW_OUTSIDE_MUTATION', expression.id)
        const column = this.#catalog.column(mutationTarget.table, expression.column)
        const qualifier = expression.scope === 'new' ? 'excluded' : mutationTarget.alias
        return `${quoteIdentifier(qualifier)}.${quoteIdentifier(column.name)}`
      }
      case 'unary': {
        const value = this.expression(expression.operand, scopes, mutationTarget)
        switch (expression.operator) {
          case 'not': return `(NOT ${value})`
          case 'is_null': return `(${value} IS NULL)`
          case 'is_not_null': return `(${value} IS NOT NULL)`
          default: throw new CompilerError('IR_UNARY_OPERATOR_UNSUPPORTED', expression.id)
        }
      }
      case 'binary': {
        assertBinaryTypes(expression, scopes, this.#catalog)
        const left = this.expression(expression.left, scopes, mutationTarget)
        const right = this.expression(expression.right, scopes, mutationTarget)
        const operator = BINARY_OPERATORS[expression.operator]
        if (operator === undefined) throw new CompilerError('IR_BINARY_OPERATOR_UNSUPPORTED', expression.id)
        return `(${left} ${operator} ${right})`
      }
      case 'conditional': {
        const branches = expression.branches.map((branch) =>
          `WHEN ${this.expression(branch.when, scopes, mutationTarget)} THEN ${this.expression(branch.then, scopes, mutationTarget)}`,
        ).join(' ')
        return `(CASE ${branches} ELSE ${this.expression(expression.otherwise, scopes, mutationTarget)} END)`
      }
      case 'exists': return `(${expression.negated ? 'NOT ' : ''}EXISTS (${this.query(expression.query).sql}))`
      case 'membership': {
        const value = this.expression(expression.value, scopes, mutationTarget)
        if (expression.values !== undefined) {
          if (expression.values.length === 0) return expression.negated ? '(1 = 1)' : '(1 = 0)'
          const values = expression.values.map((item) => this.expression(item, scopes, mutationTarget)).join(', ')
          return `(${value} ${expression.negated ? 'NOT ' : ''}IN (${values}))`
        }
        if (expression.query !== undefined) {
          return `(${value} ${expression.negated ? 'NOT ' : ''}IN (${this.query(expression.query).sql}))`
        }
        throw new CompilerError('IR_MEMBERSHIP_SOURCE_REQUIRED', expression.id)
      }
      case 'scalar_subquery': return `(${this.query(expression.query).sql})`
      case 'parameter': throw new CompilerError('IR_UNBOUND_PARAMETER', expression.id)
      case 'cast':
      case 'function':
      case 'json':
        throw new CompilerError('IR_EXPRESSION_UNSUPPORTED', expression.id)
    }
  }

  query(query: Query): { readonly sql: string; readonly columns: readonly ResultColumn[]; readonly scopes: readonly RelationScope[] } {
    if (query.ctes.length > 0 || query.windows.length > 0 || query.compounds.length > 0) {
      throw new CompilerError('IR_QUERY_FEATURE_UNSUPPORTED', query.id)
    }
    const scopes: RelationScope[] = []
    let fromSql = ''
    if (query.from !== undefined) {
      const rendered = this.#relation(query.from)
      scopes.push(rendered.scope)
      fromSql = ` FROM ${rendered.sql}`
    }
    for (const join of query.joins) {
      const rendered = this.#relation(join.relation)
      scopes.push(rendered.scope)
      const keyword = join.kind === 'inner' ? 'INNER JOIN' : join.kind === 'left' ? 'LEFT JOIN' : 'CROSS JOIN'
      if (join.kind === 'cross' && join.on !== undefined) throw new CompilerError('IR_CROSS_JOIN_ON', join.id)
      const on = join.on === undefined ? '' : ` ON ${this.expression(join.on, scopes)}`
      fromSql += ` ${keyword} ${rendered.sql}${on}`
    }
    if (query.projection.length === 0) throw new CompilerError('IR_QUERY_PROJECTION_REQUIRED', query.id)
    const columns = query.projection.map((projection) => ({
      id: projection.id,
      name: projection.name,
      valueType: inferExpressionType(projection.expression, scopes, this.#catalog),
    }))
    const projection = query.projection.map((item) =>
      `${this.expression(item.expression, scopes)} AS ${quoteIdentifier(`chronolog_p_${item.id}`)}`,
    ).join(', ')
    const where = query.where === undefined ? '' : ` WHERE ${this.expression(query.where, scopes)}`
    const group = query.groupBy.length === 0 ? '' : ` GROUP BY ${query.groupBy.map((item) => this.expression(item, scopes)).join(', ')}`
    const having = query.having === undefined ? '' : ` HAVING ${this.expression(query.having, scopes)}`
    if ((query.resultMode.kind === 'ordered' || query.page !== undefined) && !hasTotalPrimaryKeyOrder(query, scopes, this.#catalog)) {
      throw new CompilerError('IR_TOTAL_ORDER_NOT_PROVEN', query.id)
    }
    const order = query.orderBy.length === 0 ? '' : ` ORDER BY ${query.orderBy.map((term) =>
      `${this.expression(term.expression, scopes)} ${term.direction.toUpperCase()} NULLS ${term.nulls.toUpperCase()}`,
    ).join(', ')}`
    const page = query.page === undefined ? '' : ` LIMIT ${safeUnsigned(query.page.limit, 'IR_PAGE_LIMIT_INVALID')}${
      query.page.offset === undefined ? '' : ` OFFSET ${safeUnsigned(query.page.offset, 'IR_PAGE_OFFSET_INVALID')}`
    }`
    if (query.resultMode.kind === 'ordered' && query.orderBy.length === 0) {
      throw new CompilerError('IR_TOTAL_ORDER_REQUIRED', query.id)
    }
    return { sql: `SELECT ${projection}${fromSql}${where}${group}${having}${order}${page}`, columns, scopes }
  }

  #relation(relation: Relation): { readonly sql: string; readonly scope: RelationScope } {
    if (relation.kind !== 'table' && relation.kind !== 'system_relation') {
      throw new CompilerError('IR_RELATION_UNSUPPORTED', relation.id)
    }
    const table = relation.kind === 'system_relation'
      ? this.#catalog.systemRelation(relation.relation)
      : this.#catalog.tableByName(relation.name)
    const alias = relation.alias ?? `chronolog_r_${relation.id}`
    return {
      sql: `${quoteIdentifier(table.name)} AS ${quoteIdentifier(alias)}`,
      scope: { alias, table },
    }
  }

  #column(expression: ColumnExpr, scopes: readonly RelationScope[]): string {
    const matching = expression.relation === undefined
      ? scopes.filter((scope) => scope.table.columns.some((column) => column.name === expression.name))
      : scopes.filter((scope) => scope.alias === expression.relation || scope.table.name === expression.relation)
    if (matching.length !== 1) throw new CompilerError(
      matching.length === 0 ? 'IR_UNKNOWN_COLUMN' : 'IR_AMBIGUOUS_COLUMN',
      expression.id,
    )
    const scope = matching[0]!
    this.#catalog.column(scope.table, expression.name)
    return `${quoteIdentifier(scope.alias)}.${quoteIdentifier(expression.name)}`
  }

  #bind(source: BindingSource, valueType: ValueType): string {
    const ordinal = this.#parameters.length + 1
    this.#parameters.push({ ordinal, valueType, source })
    return `?${ordinal}`
  }
}

function hasTotalPrimaryKeyOrder(
  query: Query,
  scopes: readonly RelationScope[],
  catalog: Catalog,
): boolean {
  if (scopes.length === 0) return true
  const orderedColumns = new Set(query.orderBy.flatMap((term) => {
    const expression = term.expression
    if (expression.kind !== 'column') return []
    const matches = scopes.filter((scope) =>
      (expression.relation === undefined || expression.relation === scope.alias || expression.relation === scope.table.name) &&
      scope.table.columns.some((column) => column.name === expression.name),
    )
    return matches.length === 1 ? [`${matches[0]!.alias}.${expression.name}`] : []
  }))
  return scopes.every((scope) => catalog.primaryKey(scope.table).columnIds.every((columnId) => {
    const column = catalog.columnById(scope.table, columnId)
    return orderedColumns.has(`${scope.alias}.${column.name}`)
  }))
}

function assertLiteralEnabled(value: LogicalValue, catalog: Catalog, nodeId: number): void {
  if (value.kind === 'decimal' && !catalog.manifest.features.decimal) throw new CompilerError('DECIMAL_FEATURE_DISABLED', nodeId)
  if (value.kind === 'json') {
    if (!catalog.manifest.features.json) throw new CompilerError('JSON_FEATURE_DISABLED', nodeId)
    if (jsonDepth(value.value) > catalog.manifest.resources.maxJsonDepth) throw new CompilerError('JSON_RESOURCE_EXCEEDED', nodeId)
  }
  if (value.kind === 'vector') {
    if (!catalog.manifest.features.vector) throw new CompilerError('VECTOR_FEATURE_DISABLED', nodeId)
    if (value.dimensions > catalog.manifest.resources.maxVectorDimensions) throw new CompilerError('VECTOR_RESOURCE_EXCEEDED', nodeId)
  }
}

const ENTROPY_LABEL = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/u
const MAX_ENTROPY_BYTES = 255 * 32

function assertEntropyRequest(expression: Extract<Expr, { kind: 'entropy' }>): void {
  if (!ENTROPY_LABEL.test(expression.label) ||
      !Number.isSafeInteger(expression.index) || expression.index < 0 ||
      !Number.isSafeInteger(expression.length) || expression.length < 1 ||
      expression.length > MAX_ENTROPY_BYTES) {
    throw new CompilerError('IR_ENTROPY_REQUEST_INVALID', expression.id)
  }
}

function jsonDepth(value: Extract<LogicalValue, { kind: 'json' }>['value']): number {
  if (value === null || typeof value === 'boolean' || typeof value === 'bigint' || typeof value === 'string') return 0
  if (Array.isArray(value)) return 1 + value.reduce((maximum, item) => Math.max(maximum, jsonDepth(item)), 0)
  if (value instanceof Map) return 1 + [...value.values()].reduce((maximum, item) => Math.max(maximum, jsonDepth(item)), 0)
  return 0
}

const BINARY_OPERATORS: Partial<Record<Extract<Expr, { kind: 'binary' }>['operator'], string>> = {
  and: 'AND', or: 'OR', eq: '=', ne: '<>', lt: '<', lte: '<=', gt: '>', gte: '>=',
  concat: '||', is: 'IS', is_not: 'IS NOT',
}

export function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`
}

export function valueTypeOf(value: LogicalValue): ValueType {
  if (value.kind === 'null') return { logical: { kind: 'blob' }, nullable: true }
  if (value.kind === 'text') return { logical: { kind: 'text', collation: 'binary' }, nullable: false }
  if (value.kind === 'blob') return { logical: { kind: 'blob' }, nullable: false }
  if (value.kind === 'uuid') return { logical: { kind: 'uuid' }, nullable: false }
  if (value.kind === 'decimal') return { logical: { kind: 'decimal', precision: decimalDigits(value.coefficient), scale: value.scale }, nullable: false }
  if (value.kind === 'vector') return { logical: { kind: 'vector', element: value.element, dimensions: value.dimensions }, nullable: false }
  if (value.kind === 'json') return { logical: { kind: 'json' }, nullable: false }
  return { logical: { kind: value.kind }, nullable: false }
}

export function contextValueType(field: Extract<Expr, { kind: 'context' }>['field']): ValueType {
  switch (field) {
    case 'author_timestamp_ms': return { logical: { kind: 'timestamp_ms' }, nullable: false }
    case 'author_feed_sequence': return { logical: { kind: 'int64' }, nullable: false }
    default: return { logical: { kind: 'blob' }, nullable: false }
  }
}

export function inferExpressionType(expression: Expr, scopes: readonly RelationScope[], catalog: Catalog): ValueType {
  switch (expression.kind) {
    case 'literal': return valueTypeOf(expression.value)
    case 'context': return contextValueType(expression.field)
    case 'entropy':
      assertEntropyRequest(expression)
      return { logical: { kind: 'blob', maxBytes: expression.length }, nullable: false }
    case 'column': {
      const candidates = scopes.filter((scope) =>
        (expression.relation === undefined || expression.relation === scope.alias || expression.relation === scope.table.name) &&
        scope.table.columns.some((column) => column.name === expression.name),
      )
      if (candidates.length !== 1) throw new CompilerError(candidates.length === 0 ? 'IR_UNKNOWN_COLUMN' : 'IR_AMBIGUOUS_COLUMN', expression.id)
      return catalog.column(candidates[0]!.table, expression.name).valueType
    }
    case 'unary':
      if (expression.operator === 'not' || expression.operator === 'is_null' || expression.operator === 'is_not_null') {
        return { logical: { kind: 'boolean' }, nullable: false }
      }
      throw new CompilerError('IR_UNARY_OPERATOR_UNSUPPORTED', expression.id)
    case 'binary':
      if (['and', 'or', 'eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'is', 'is_not'].includes(expression.operator)) {
        const left = inferExpressionType(expression.left, scopes, catalog)
        const right = inferExpressionType(expression.right, scopes, catalog)
        const nullable = expression.operator === 'is' || expression.operator === 'is_not'
          ? false
          : expression.operator === 'and' || expression.operator === 'or' || left.nullable || right.nullable
        return { logical: { kind: 'boolean' }, nullable }
      }
      if (expression.operator === 'concat') return { logical: { kind: 'text', collation: 'binary' }, nullable: true }
      throw new CompilerError('IR_BINARY_OPERATOR_UNSUPPORTED', expression.id)
    case 'conditional': return inferExpressionType(expression.otherwise, scopes, catalog)
    case 'old_new': throw new CompilerError('IR_OLD_NEW_RESULT_TYPE_REQUIRES_TARGET', expression.id)
    case 'scalar_subquery': {
      const nested = new SqlRenderer(catalog).query(expression.query)
      if (nested.columns.length !== 1) throw new CompilerError('IR_SCALAR_SUBQUERY_WIDTH', expression.id)
      return { ...nested.columns[0]!.valueType, nullable: true }
    }
    case 'exists':
    case 'membership': return { logical: { kind: 'boolean' }, nullable: false }
    default: throw new CompilerError('IR_EXPRESSION_UNSUPPORTED', expression.id)
  }
}

function assertBinaryTypes(
  expression: Extract<Expr, { kind: 'binary' }>,
  scopes: readonly RelationScope[],
  catalog: Catalog,
): void {
  const left = inferExpressionType(expression.left, scopes, catalog).logical.kind
  const right = inferExpressionType(expression.right, scopes, catalog).logical.kind
  if (expression.operator === 'and' || expression.operator === 'or') {
    if (left !== 'boolean' || right !== 'boolean') throw new CompilerError('IR_BOOLEAN_OPERAND_REQUIRED', expression.id)
    return
  }
  if (expression.operator === 'concat') {
    if (left !== 'text' || right !== 'text') throw new CompilerError('IR_TEXT_OPERAND_REQUIRED', expression.id)
    return
  }
  if (expression.operator !== 'is' && expression.operator !== 'is_not' && left !== right) {
    throw new CompilerError('IR_COMPARISON_TYPE_MISMATCH', expression.id)
  }
  if (['lt', 'lte', 'gt', 'gte'].includes(expression.operator) &&
      !['boolean', 'int64', 'timestamp_ms', 'duration_ms', 'text'].includes(left)) {
    throw new CompilerError('IR_ORDER_COMPARISON_UNSUPPORTED', expression.id)
  }
}

export function storageType(type: LogicalType): string {
  switch (type.kind) {
    case 'boolean':
    case 'int64':
    case 'timestamp_ms':
    case 'duration_ms': return 'INTEGER'
    case 'text': return 'TEXT'
    case 'blob':
    case 'uuid': return 'BLOB'
    case 'decimal':
    case 'json': return 'TEXT'
    case 'vector': return 'BLOB'
  }
}

function decimalDigits(value: bigint): number {
  return (value < 0n ? -value : value).toString(10).length
}

function safeUnsigned(value: number, code: string): string {
  if (!Number.isSafeInteger(value) || value < 0) throw new CompilerError(code)
  return value.toString(10)
}
