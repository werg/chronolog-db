import type {
  Assignment,
  Expr,
  InsertMutation,
  Mutation,
  Query,
  ResultColumn,
  SchemaColumn,
  SchemaTable,
  TransactionProgram,
  UpsertClause,
} from '@chronolog/ir'
import { sqliteIdentifierKey, validateTransactionProgram, walkExpr } from '@chronolog/ir'

import type { Catalog } from './catalog.js'
import { compileQuery } from './compile-query.js'
import { renderSchemaExpression } from './compile-schema.js'
import {
  inferExpressionType,
  isQueryAtMostOneRow,
  isTablePredicateAtMostOneRow,
  logicalValueTypeCompatible,
  quoteIdentifier,
  SqlRenderer,
  type CteScopes,
  type RelationScope,
} from './render.js'
import { CompilerError, type CompiledMutation, type CompiledPrecondition, type CompiledProgram } from './types.js'

export function compileProgram(program: TransactionProgram, catalog: Catalog): CompiledProgram {
  const validation = validateTransactionProgram(program, { schema: catalog.schema, manifest: catalog.manifest })
  if (!validation.ok) {
    const diagnostic = validation.diagnostics[0]!
    throw new CompilerError(diagnostic.code, diagnostic.nodeId ?? null)
  }
  if (program.preconditions.length === 0) throw new CompilerError('IR_PRECONDITION_REQUIRED')
  if (program.mutations.length === 0) throw new CompilerError('IR_MUTATION_REQUIRED')
  return {
    preconditions: program.preconditions.map((precondition): CompiledPrecondition => {
      try {
        return {
          id: precondition.id,
          kind: precondition.kind,
          query: compileQuery(precondition.query, catalog),
          ...(precondition.kind === 'expect' ? { expected: precondition.expected } : {}),
        }
      } catch (error) {
        if (error instanceof CompilerError) throw new CompilerError(error.code, precondition.id, 'precondition')
        throw error
      }
    }),
    mutations: program.mutations.map((mutation) => {
      try { return compileMutation(mutation, catalog) }
      catch (error) {
        if (error instanceof CompilerError) throw new CompilerError(error.code, mutation.id, 'command')
        throw error
      }
    }),
  }
}

export function compileMutation(mutation: Mutation, catalog: Catalog): CompiledMutation {
  if (mutation.returning !== undefined) throw new CompilerError('IR_RETURNING_UNSUPPORTED', mutation.id, 'command')
  if (mutation.kind === 'merge' || mutation.kind === 'stateful_call') {
    throw new CompilerError('IR_MUTATION_UNSUPPORTED', mutation.id, 'command')
  }
  const table = catalog.table(mutation.target)
  const renderer = new SqlRenderer(catalog)
  const renderedCtes = renderer.ctes(mutation.ctes ?? [], mutation.recursive === true)
  const ctes = renderedCtes.scopes
  const usesUpsertSyntax = mutation.kind === 'upsert' ||
    (mutation.kind === 'insert' && (mutation.upsertClauses?.length ?? 0) > 0)
  // SQLite's incoming-row pseudo-table is also named "excluded". If that is
  // the real target table name, introduce a compiler-owned alias so old/new
  // references remain unambiguous without imposing a naming restriction.
  const targetAlias = mutation.alias ??
    (usesUpsertSyntax && sqliteIdentifierKey(table.name) === 'excluded'
      ? `chronolog_upsert_target_${mutation.id}`
      : table.name)
  const targetScope: RelationScope = { alias: targetAlias, table }
  let sql: string
  if (mutation.kind === 'insert') {
    sql = renderInsertMutation(mutation, table, catalog, renderer, targetScope, ctes)
  } else if (mutation.kind === 'update') {
    if (mutation.assignments.length === 0) throw new CompilerError('IR_UPDATE_ASSIGNMENT_REQUIRED', mutation.id, 'command')
    const update = mutationKeyword('UPDATE', mutation.conflict ?? 'error', mutation.id)
    if (mutation.conflict !== undefined && mutation.conflict !== 'error' &&
        (mutation.where === undefined ||
          !isTablePredicateAtMostOneRow(mutation.where, targetAlias, table, catalog) ||
          (mutation.from !== undefined && !isQueryAtMostOneRow(mutation.from, catalog)))) {
      throw new CompilerError('IR_UPDATE_CONFLICT_ORDER_NOT_PROVEN', mutation.id, 'command')
    }
    const scopes: RelationScope[] = [targetScope]
    let from = ''
    if (mutation.from !== undefined || mutation.fromAlias !== undefined) {
      if (mutation.from === undefined || mutation.fromAlias === undefined) throw new CompilerError('IR_UPDATE_FROM_SHAPE_INVALID', mutation.id, 'command')
      if (sqliteIdentifierKey(mutation.fromAlias) === sqliteIdentifierKey(targetAlias)) throw new CompilerError('IR_UPDATE_FROM_ALIAS_CONFLICT', mutation.id, 'command')
      if (!isQueryAtMostOneRow(mutation.from, catalog) &&
          !isUpdateSourceUniquePerTarget(mutation.from, mutation.fromAlias, mutation.where, catalog)) {
        throw new CompilerError('IR_UPDATE_FROM_CARDINALITY_NOT_PROVEN', mutation.from.id, 'command')
      }
      const source = renderer.query({ ...mutation.from, resultMode: { kind: 'ordered' } }, [], ctes)
      scopes.push(derivedMutationScope(mutation.fromAlias, source.columns))
      from = ` FROM (${renderNamedSource(source, mutation.id)}) AS ${quoteIdentifier(mutation.fromAlias)}`
    }
    const assignments = renderAssignments(mutation.assignments, table, catalog, renderer, targetScope, false, scopes, ctes)
    const where = mutation.where === undefined ? '' : ` WHERE ${renderer.expression(mutation.where, scopes, targetScope, ctes)}`
    sql = `${update} ${quoteIdentifier(table.name)} AS ${quoteIdentifier(targetAlias)} SET ${assignments}${from}${where}`
  } else if (mutation.kind === 'delete') {
    const where = mutation.where === undefined ? '' : ` WHERE ${renderer.expression(mutation.where, [targetScope], targetScope, ctes)}`
    sql = `DELETE FROM ${quoteIdentifier(table.name)} AS ${quoteIdentifier(targetAlias)}${where}`
  } else {
    const constraint = catalog.namedUnique(table, mutation.constraint)
    const action = mutation.updates.length === 0 ? 'nothing' : 'update'
    const clause: UpsertClause = {
      id: mutation.id,
      target: { constraintId: constraint.id },
      action,
      assignments: mutation.updates,
      ...(action === 'update' && mutation.where !== undefined ? { where: mutation.where } : {}),
    }
    const insert: InsertMutation = {
      kind: 'insert', id: mutation.id, target: mutation.target,
      columns: mutation.columns, rows: mutation.source === undefined ? [mutation.row] : [],
      conflict: 'error', affectedRows: mutation.affectedRows, upsertClauses: [clause],
      alias: targetAlias,
      ...(mutation.source === undefined ? {} : { source: mutation.source }),
      ...(mutation.label === undefined ? {} : { label: mutation.label }),
    }
    sql = renderInsertMutation(insert, table, catalog, renderer, targetScope, ctes)
  }
  sql = `${renderedCtes.sql}${sql}`
  if (renderer.parameters.length > 1_000) throw new CompilerError('IR_PARAMETER_LIMIT', mutation.id, 'command')
  return { id: mutation.id, source: mutation, sql, parameters: renderer.parameters }
}

function renderInsertMutation(
  mutation: InsertMutation,
  table: SchemaTable,
  catalog: Catalog,
  renderer: SqlRenderer,
  targetScope: RelationScope,
  ctes: CteScopes,
): string {
  const clauses = mutation.upsertClauses ?? []
  const targetAlias = targetScope.alias
  if (mutation.alias !== undefined && sqliteIdentifierKey(targetAlias) === 'excluded' &&
      clauses.some((clause) =>
        clause.assignments.some((assignment) => containsNewReference(assignment.value)) ||
        (clause.where !== undefined && containsNewReference(clause.where)))) {
    throw new CompilerError('IR_UPSERT_ALIAS_RESERVED', mutation.id, 'command')
  }
  const columns = resolveColumns(table, mutation.columns, catalog)
  const insert = mutationKeyword('INSERT', mutation.conflict, mutation.id)
  const alias = mutation.alias === undefined && targetAlias === table.name
    ? ''
    : ` AS ${quoteIdentifier(targetAlias)}`
  const target = `${insert} INTO ${quoteIdentifier(table.name)}${alias}`
  const defaultValues = mutation.columns.length === 0 && mutation.rows.length === 1 && mutation.rows[0]!.length === 0
  let sql: string
  if (defaultValues) {
    if (mutation.source !== undefined) throw new CompilerError('IR_INSERT_SOURCE_CONFLICT', mutation.id, 'command')
    if (clauses.length > 0) throw new CompilerError('IR_UPSERT_DEFAULT_VALUES_INVALID', mutation.id, 'command')
    sql = `${target} DEFAULT VALUES`
  } else if (mutation.source !== undefined) {
    if (mutation.rows.length !== 0) throw new CompilerError('IR_INSERT_SOURCE_CONFLICT', mutation.id, 'command')
    // Conflict handling can make source visitation order observable. Preserve
    // authored order and let the renderer deterministically complete its ties
    // with the projected canonical row.
    const source = renderer.query({ ...mutation.source, resultMode: { kind: 'ordered' } }, [], ctes)
    if (source.columns.length !== columns.length) throw new CompilerError('IR_INSERT_SOURCE_ARITY', mutation.id, 'command')
    for (let index = 0; index < columns.length; index += 1) {
      if (!logicalValueTypeCompatible(source.columns[index]!.valueType, columns[index]!.valueType)) {
        throw new CompilerError('IR_INSERT_SOURCE_TYPE_MISMATCH', source.columns[index]!.id, 'command')
      }
    }
    const input = clauses.length === 0 ? source.sql : renderUpsertSource(source, mutation.id)
    sql = `${target} (${columns.map((column) => quoteIdentifier(column.name)).join(', ')}) ${input}`
  } else {
    if (mutation.rows.length === 0) throw new CompilerError('IR_INSERT_ROW_REQUIRED', mutation.id, 'command')
    const rows = mutation.rows.map((row) => {
      if (row.length !== columns.length) throw new CompilerError('IR_INSERT_ARITY', mutation.id, 'command')
      return `(${row.map((expression, index) => {
        assertExpressionAssignable(expression, columns[index]!, catalog, [], undefined, ctes)
        return renderer.expression(expression, [], undefined, ctes)
      }).join(', ')})`
    }).join(', ')
    sql = `${target} (${columns.map((column) => quoteIdentifier(column.name)).join(', ')}) VALUES ${rows}`
  }
  return `${sql}${renderUpsertClauses(clauses, table, catalog, renderer, targetScope, ctes)}`
}

function renderUpsertClauses(
  clauses: readonly UpsertClause[],
  table: SchemaTable,
  catalog: Catalog,
  renderer: SqlRenderer,
  targetScope: RelationScope,
  ctes: CteScopes,
): string {
  return clauses.map((clause, index) => {
    if (clause.target === undefined && index !== clauses.length - 1) {
      throw new CompilerError('IR_UPSERT_TARGET_REQUIRED', clause.id, 'command')
    }
    let target = ''
    if (clause.target !== undefined) {
      const hasConstraint = 'constraintId' in clause.target
      const hasIndex = 'indexId' in clause.target
      if (hasConstraint === hasIndex) {
        throw new CompilerError('IR_UPSERT_CONFLICT_TARGET_INVALID', clause.id, 'command')
      }
      if (hasConstraint) {
        const constraint = catalog.uniqueConstraintById(table, clause.target.constraintId)
        target = ` (${constraint.columnIds.map((id) =>
          quoteIdentifier(catalog.columnById(table, id).name)).join(', ')})`
      } else {
        const uniqueIndex = catalog.uniqueIndexById(table, clause.target.indexId)
        if (uniqueIndex.expressions.length === 0) {
          throw new CompilerError('IR_UPSERT_INDEX_EXPRESSION_REQUIRED', clause.id, 'command')
        }
        const expressions = uniqueIndex.expressions.map((expression) =>
          renderSchemaExpression(expression, table, catalog)).join(', ')
        const where = uniqueIndex.where === undefined
          ? ''
          : ` WHERE ${renderSchemaExpression(uniqueIndex.where, table, catalog)}`
        target = ` (${expressions})${where}`
      }
    }
    if (clause.action === 'nothing') {
      if (clause.assignments.length > 0 || clause.where !== undefined) {
        throw new CompilerError('IR_UPSERT_NOTHING_SHAPE_INVALID', clause.id, 'command')
      }
      return ` ON CONFLICT${target} DO NOTHING`
    }
    if (clause.action !== 'update') throw new CompilerError('IR_UPSERT_ACTION_INVALID', clause.id, 'command')
    if (clause.assignments.length === 0) {
      throw new CompilerError('IR_UPSERT_UPDATE_ASSIGNMENT_REQUIRED', clause.id, 'command')
    }
    const assignments = renderAssignments(
      clause.assignments,
      table,
      catalog,
      renderer,
      targetScope,
      true,
      [targetScope],
      ctes,
    )
    const where = clause.where === undefined
      ? ''
      : ` WHERE ${renderer.expression(clause.where, [targetScope], targetScope, ctes)}`
    return ` ON CONFLICT${target} DO UPDATE SET ${assignments}${where}`
  }).join('')
}

function resolveColumns(table: SchemaTable, names: readonly string[], catalog: Catalog): SchemaColumn[] {
  const seen = new Set<string>()
  return names.map((name) => {
    const key = sqliteIdentifierKey(name)
    if (seen.has(key)) throw new CompilerError('IR_DUPLICATE_MUTATION_COLUMN', table.id, 'command')
    seen.add(key)
    return catalog.column(table, name)
  })
}

function renderAssignments(
  assignments: readonly Assignment[],
  table: SchemaTable,
  catalog: Catalog,
  renderer: SqlRenderer,
  targetScope: RelationScope,
  allowNew: boolean,
  scopes: readonly RelationScope[] = [targetScope],
  ctes: CteScopes = new Map(),
): string {
  const lastAssignment = new Map<string, number>()
  assignments.forEach((assignment, index) => lastAssignment.set(sqliteIdentifierKey(assignment.column), index))
  return assignments.flatMap((assignment, index) => {
    const key = sqliteIdentifierKey(assignment.column)
    const column = catalog.column(table, assignment.column)
    if (!allowNew && containsNewReference(assignment.value)) {
      throw new CompilerError('IR_NEW_VALUE_UNSUPPORTED', assignment.value.id, 'command')
    }
    // SQLite evaluates only the rightmost assignment to a repeated target
    // column. Discarded RHS expressions are still resolved/prepared by SQLite,
    // so validate them with an isolated renderer without evaluating them or
    // allocating bindings in the executable statement.
    if (lastAssignment.get(key) !== index) {
      assertExpressionAssignable(assignment.value, column, catalog, scopes, targetScope, ctes)
      new SqlRenderer(catalog).expression(assignment.value, scopes, targetScope, ctes)
      return []
    }
    assertExpressionAssignable(assignment.value, column, catalog, scopes, targetScope, ctes)
    return [`${quoteIdentifier(column.name)} = ${renderer.expression(assignment.value, scopes, targetScope, ctes)}`]
  }).join(', ')
}

function mutationKeyword(statement: 'INSERT' | 'UPDATE', conflict: 'error' | 'ignore' | 'replace', nodeId: number): string {
  if (conflict === 'error') return statement
  if (conflict === 'ignore') return `${statement} OR IGNORE`
  if (conflict === 'replace') return `${statement} OR REPLACE`
  throw new CompilerError(`IR_${statement}_CONFLICT_INVALID`, nodeId, 'command')
}

function renderUpsertSource(
  source: { readonly sql: string; readonly columns: readonly ResultColumn[] },
  mutationId: number,
): string {
  const alias = `chronolog_upsert_source_${mutationId}`
  const values = source.columns.map((column) =>
    `${quoteIdentifier(alias)}.${quoteIdentifier(`chronolog_p_${column.id}`)}`,
  ).join(', ')
  const order = source.columns.map((column, index) => {
    const value = column.valueType.logical.kind === 'text' &&
        column.valueType.logical.collation !== 'binary' &&
        column.valueType.logical.collation !== 'unicode_codepoint'
      ? `${quoteIdentifier(alias)}.${quoteIdentifier(`chronolog_p_${column.id}`)} COLLATE BINARY`
      : `${index + 1}`
    return `${value} ASC NULLS FIRST`
  }).join(', ')
  // SQLite otherwise cannot always distinguish a SELECT join's ON from the
  // following UPSERT clause. The unconditional WHERE resolves that grammar
  // ambiguity; the full-row ORDER BY makes conflict visitation canonical.
  return `SELECT ${values} FROM (${source.sql}) AS ${quoteIdentifier(alias)} WHERE 1 ORDER BY ${order}`
}

function renderNamedSource(
  source: { readonly sql: string; readonly columns: readonly ResultColumn[] },
  mutationId: number,
): string {
  const alias = `chronolog_update_source_${mutationId}`
  const projection = source.columns.map((column) =>
    `${quoteIdentifier(alias)}.${quoteIdentifier(`chronolog_p_${column.id}`)} AS ${quoteIdentifier(column.name)}`,
  ).join(', ')
  return `SELECT ${projection} FROM (${source.sql}) AS ${quoteIdentifier(alias)}`
}

function derivedMutationScope(alias: string, columns: readonly ResultColumn[]): RelationScope {
  return {
    alias,
    primaryKeyColumns: null,
    table: {
      kind: 'table', id: -1, name: alias, declarationOrder: -1, withoutRowId: false,
      columns: columns.map((column, declarationOrder) => ({
        id: column.id, name: column.name, declarationOrder, valueType: column.valueType,
      })),
      constraints: [],
    },
  }
}

function isUpdateSourceUniquePerTarget(
  source: Query,
  sourceAlias: string,
  where: Expr | undefined,
  catalog: Catalog,
): boolean {
  if (where === undefined || source.from?.kind !== 'table' || source.joins.length > 0 ||
      source.compounds.length > 0 || source.groupBy.length > 0) return false
  const sourceTable = catalog.tableByName(source.from.name)
  const relationAlias = source.from.alias ?? sourceTable.name
  const projectedColumnNames = new Map<string, string>()
  for (const projection of source.projection) {
    const expression = projection.expression
    if (expression.kind !== 'column' ||
        (expression.relation !== undefined &&
          sqliteIdentifierKey(expression.relation) !== sqliteIdentifierKey(relationAlias))) continue
    const column = sourceTable.columns.find((candidate) =>
      sqliteIdentifierKey(candidate.name) === sqliteIdentifierKey(expression.name))
    if (column !== undefined) projectedColumnNames.set(sqliteIdentifierKey(column.name), projection.name)
  }
  const constrained = new Set<string>()
  for (const predicate of flattenMutationConjunction(where)) {
    if (predicate.kind !== 'binary' || predicate.operator !== 'eq') continue
    const left = updateSourceColumn(predicate.left, sourceAlias)
    const right = updateSourceColumn(predicate.right, sourceAlias)
    if (left !== null && !referencesUpdateSource(predicate.right, sourceAlias)) constrained.add(left)
    if (right !== null && !referencesUpdateSource(predicate.left, sourceAlias)) constrained.add(right)
  }
  return sourceTable.constraints.some((constraint) =>
    (constraint.kind === 'primary_key' || constraint.kind === 'unique') &&
    constraint.columnIds.every((columnId) => {
      const sourceColumn = catalog.columnById(sourceTable, columnId)
      const projectionName = projectedColumnNames.get(sqliteIdentifierKey(sourceColumn.name))
      return projectionName !== undefined && constrained.has(sqliteIdentifierKey(projectionName))
    }))
}

function flattenMutationConjunction(expression: Expr): readonly Expr[] {
  return expression.kind === 'binary' && expression.operator === 'and'
    ? [...flattenMutationConjunction(expression.left), ...flattenMutationConjunction(expression.right)]
    : [expression]
}

function updateSourceColumn(expression: Expr, sourceAlias: string): string | null {
  return expression.kind === 'column' && expression.relation !== undefined &&
      sqliteIdentifierKey(expression.relation) === sqliteIdentifierKey(sourceAlias)
    ? sqliteIdentifierKey(expression.name)
    : null
}

function referencesUpdateSource(expression: Expr, sourceAlias: string): boolean {
  let found = false
  walkExpr(expression, { expr: (candidate) => {
    if (candidate.kind === 'column' &&
        (candidate.relation === undefined || sqliteIdentifierKey(candidate.relation) === sqliteIdentifierKey(sourceAlias))) {
      found = true
    }
  } })
  return found
}

function assertExpressionAssignable(
  expression: Expr,
  column: SchemaColumn,
  catalog: Catalog,
  scopes: readonly RelationScope[] = [],
  mutationTarget?: RelationScope,
  ctes: CteScopes = new Map(),
): void {
  if (expression.kind === 'entropy') {
    if (column.valueType.logical.kind === 'uuid') {
      if (expression.length !== 16) throw new CompilerError('IR_ENTROPY_UUID_LENGTH', expression.id, 'command')
      return
    }
    if (column.valueType.logical.kind === 'blob') {
      if (column.valueType.logical.maxBytes !== undefined && expression.length > column.valueType.logical.maxBytes) {
        throw new CompilerError('IR_ENTROPY_BLOB_LENGTH', expression.id, 'command')
      }
      return
    }
    throw new CompilerError('IR_ENTROPY_TARGET_TYPE_MISMATCH', expression.id, 'command')
  }
  if (expression.kind === 'literal') {
    if (expression.value.kind === 'null') {
      return
    }
    if (expression.value.kind !== column.valueType.logical.kind) throw new CompilerError('IR_MUTATION_TYPE_MISMATCH', expression.id, 'command')
    if (expression.value.kind === 'decimal' && column.valueType.logical.kind === 'decimal') {
      if (expression.value.scale > column.valueType.logical.scale) throw new CompilerError('IR_DECIMAL_SCALE_MISMATCH', expression.id, 'command')
      const delta = column.valueType.logical.scale - expression.value.scale
      const coefficient = expression.value.coefficient * 10n ** BigInt(delta)
      const digits = (coefficient < 0n ? -coefficient : coefficient).toString(10).length
      if (digits > column.valueType.logical.precision) throw new CompilerError('IR_DECIMAL_PRECISION_OVERFLOW', expression.id, 'command')
    }
    if (expression.value.kind === 'vector' && column.valueType.logical.kind === 'vector') {
      const width = expression.value.element === 'i8' || expression.value.element === 'u8' ? 1 : expression.value.element === 'i16' ? 2 : expression.value.element === 'f64' ? 8 : 4
      if (expression.value.element !== column.valueType.logical.element ||
          expression.value.dimensions !== column.valueType.logical.dimensions ||
          expression.value.bytes.length !== width * expression.value.dimensions) {
        throw new CompilerError('IR_VECTOR_SHAPE_MISMATCH', expression.id, 'command')
      }
    }
    return
  }
  const actual = inferExpressionType(expression, scopes, catalog, ctes, mutationTarget)
  if (!logicalValueTypeCompatible(actual, column.valueType)) {
    throw new CompilerError('IR_MUTATION_TYPE_MISMATCH', expression.id, 'command')
  }
}

function containsNewReference(expression: Expr): boolean {
  switch (expression.kind) {
    case 'old_new': return expression.scope === 'new'
    case 'unary': return containsNewReference(expression.operand)
    case 'binary': return containsNewReference(expression.left) || containsNewReference(expression.right) ||
      (expression.escape !== undefined && containsNewReference(expression.escape))
    case 'conditional': return expression.branches.some((branch) => containsNewReference(branch.when) || containsNewReference(branch.then)) || containsNewReference(expression.otherwise)
    case 'builtin':
    case 'function': return expression.args.some(containsNewReference)
    case 'json': return expression.args.some(containsNewReference) ||
      (expression.pathExpression !== undefined && containsNewReference(expression.pathExpression))
    case 'row': return expression.items.some(containsNewReference)
    case 'collate': return containsNewReference(expression.expression)
    case 'window': return expression.args.some(containsNewReference) ||
      (expression.filter !== undefined && containsNewReference(expression.filter))
    case 'aggregate': return (expression.value !== undefined && containsNewReference(expression.value)) ||
      (expression.filter !== undefined && containsNewReference(expression.filter)) ||
      (expression.orderBy?.some((term) => containsNewReference(term.expression)) ?? false)
    case 'membership': return containsNewReference(expression.value) || expression.values?.some(containsNewReference) === true
    default: return false
  }
}
