import { isReservedSchemaObjectName } from '@chronolog/ir'
import {
  encodeSqlBindingValue,
  equalBytes,
  type SqlBinding,
  type SqlBindingValue,
  type SqlResultMode,
  type SqlStatement,
  type SqlStatementClass,
  type SqlTransactionProgram,
} from '@chronolog/protocol'
import {
  parse,
  traverse,
  type AstNode,
  type FunctionCallExpr,
  type FunctionCallStarExpr,
  type PragmaStmt,
  type QualifiedName,
  type Select,
  type Stmt,
  type VariableExpr,
} from 'sqlite3-parser/sqlite-3.53.0'

import { DETERMINISTIC_SQLITE_COMPILER_FUNCTIONS } from './deterministic-functions.js'

/** Exact parser identity used by the consensus SQL compiler. */
export const SQLITE_PARSER_BASELINE = Object.freeze({
  package: 'sqlite3-parser@0.7.1',
  grammar: 'SQLite 3.53.0',
})

export type SqlCompilationMode = 'precondition' | 'body'

export interface SqlSourceSpan {
  readonly startByte: number
  readonly endByte: number
}

export interface CompiledSqlParameter {
  readonly index: number
  readonly names: readonly string[]
  readonly referenced: boolean
}

export interface CompiledSqlSource {
  readonly source: SqlStatement
  readonly ast: Stmt
  readonly statementClass: SqlStatementClass
  readonly effectCapable: boolean
  readonly readOnly: boolean
  readonly changesSchema: boolean
  readonly producesResult: boolean
  readonly resultMode: Exclude<SqlResultMode, 'scalar' | 'set'> | null
  readonly parameters: readonly CompiledSqlParameter[]
  readonly maximumParameterIndex: number
  readonly sourceSpan: SqlSourceSpan
  readonly orderedMutation: OrderedMutationPlan | null
}

export interface OrderedMutationPlan {
  readonly targetTable: string
  readonly selectionSqlTemplate: string
  readonly selectionMaximumParameterIndex: number
  readonly selectionColumnsToken: string
  readonly identityOrderToken: string
  readonly mutationSqlTemplate: string
  readonly assignedColumns: readonly string[]
  readonly identityPredicateToken: string
}

export interface CompiledSqlProgram {
  readonly source: SqlTransactionProgram
  readonly preconditions: readonly CompiledSqlSource[]
  readonly body: readonly CompiledSqlSource[]
}

export class SqlCompilerError extends Error {
  constructor(
    readonly code: string,
    readonly span: SqlSourceSpan | null = null,
  ) {
    super(code)
    this.name = 'SqlCompilerError'
  }
}

const PROHIBITED_STATEMENTS: ReadonlySet<Stmt['type']> = new Set([
  'AttachStmt', 'BeginStmt', 'CommitStmt', 'DetachStmt', 'ReleaseStmt',
  'RollbackStmt', 'SavepointStmt', 'VacuumStmt', 'ExplainStmt',
])

const SCHEMA_STATEMENTS: ReadonlySet<Stmt['type']> = new Set([
  'AlterTableStmt', 'CreateIndexStmt', 'CreateTableStmt', 'CreateTriggerStmt',
  'CreateViewStmt', 'DropIndexStmt', 'DropTableStmt', 'DropTriggerStmt', 'DropViewStmt',
])

const EFFECT_STATEMENTS: ReadonlySet<Stmt['type']> = new Set([
  ...SCHEMA_STATEMENTS,
  'InsertStmt', 'UpdateStmt', 'DeleteStmt', 'ReindexStmt',
])

export const DETERMINISTIC_READ_ONLY_PRAGMAS: ReadonlySet<string> = new Set([
  'collation_list', 'compile_options', 'database_list', 'foreign_key_list',
  'function_list', 'index_info', 'index_list', 'index_xinfo', 'module_list',
  'pragma_list', 'table_info', 'table_list', 'table_xinfo',
])

const ARGUMENT_CONDITIONAL_TIME_FUNCTIONS: ReadonlySet<string> = new Set([
  'date', 'time', 'datetime', 'julianday', 'strftime', 'unixepoch', 'timediff',
])

const TEMPORARILY_GATED_FUNCTIONS: ReadonlySet<string> = new Set([
  'avg', 'changes', 'group_concat', 'last_insert_rowid', 'printf', 'random',
  'randomblob', 'soundex', 'sqlite_offset', 'sum', 'total', 'total_changes',
])

export function compileSqlProgram(program: SqlTransactionProgram): CompiledSqlProgram {
  if (program.version !== 1 || program.preconditions.length === 0 || program.body.length === 0) {
    throw new SqlCompilerError('SQL_PROGRAM_SHAPE_INVALID')
  }
  const preconditions = program.preconditions.map((precondition) =>
    compileSqlStatement(precondition.query, 'precondition'))
  const body = program.body.map((statement) => compileSqlStatement(statement, 'body'))
  if (!body.some((statement) => statement.effectCapable)) {
    throw new SqlCompilerError('SQL_EFFECT_CAPABLE_STATEMENT_REQUIRED')
  }
  return { source: program, preconditions, body }
}

export function compileSqlStatement(
  statement: SqlStatement,
  mode: SqlCompilationMode,
): CompiledSqlSource {
  const orderedMutationSyntax = parseOrderedMutationSyntax(statement.sql)
  const ast = parseOne(orderedMutationSyntax?.parserSql ?? statement.sql)
  if (PROHIBITED_STATEMENTS.has(ast.type)) throw compilerError('SQL_STATEMENT_PROHIBITED', statement.sql, ast)
  if (ast.type === 'AnalyzeStmt') throw compilerError('SQL_ANALYZE_TEMPORARILY_GATED', statement.sql, ast)
  if (ast.type === 'CreateVirtualTableStmt') throw compilerError('SQL_VIRTUAL_TABLE_TEMPORARILY_GATED', statement.sql, ast)
  if (ast.type === 'ReindexStmt') throw compilerError('SQL_REINDEX_TEMPORARILY_GATED', statement.sql, ast)
  if (mode === 'precondition' && ast.type !== 'SelectStmt' && ast.type !== 'PragmaStmt') {
    throw compilerError('SQL_PRECONDITION_NOT_READ_ONLY', statement.sql, ast)
  }
  if (ast.type === 'PragmaStmt') validatePragma(ast, statement.sql)
  validateTemporaryObjects(ast, statement.sql)
  validateObjectNames(ast, statement.sql)
  validateDeterministicExpressions(ast, statement.sql)
  validateOrderSensitiveMutation(ast, statement.sql, orderedMutationSyntax !== null)

  const parameterPlan = orderedMutationSyntax === null
    ? parameterPlanFor(ast, statement.sql)
    : parameterPlanFromSource(statement.sql)
  validateBindings(statement.bindings, parameterPlan.parameters, parameterPlan.maximumParameterIndex)
  const statementClass = classifyStatement(ast)
  const producesResult = ast.type === 'SelectStmt' || ast.type === 'PragmaStmt' || (
    (ast.type === 'InsertStmt' || ast.type === 'UpdateStmt' || ast.type === 'DeleteStmt') &&
    ast.returning !== undefined
  )
  const resultMode = producesResult
    ? ast.type === 'SelectStmt' && ast.body.orderBy !== undefined ? 'ordered' : 'multiset'
    : null
  const orderedMutation = orderedMutationSyntax === null ? null : buildOrderedMutationPlan(ast, statement.sql, orderedMutationSyntax)
  if (orderedMutation !== null) {
    const validationSql = orderedMutation.selectionSqlTemplate
      .replace(orderedMutation.selectionColumnsToken, 'rowid')
      .replace(orderedMutation.identityOrderToken, 'rowid')
    const selectionAst = parseOne(validationSql)
    validateDeterministicExpressions(selectionAst, validationSql)
  }
  return {
    source: statement,
    ast,
    statementClass,
    effectCapable: EFFECT_STATEMENTS.has(ast.type),
    readOnly: ast.type === 'SelectStmt' || ast.type === 'PragmaStmt',
    changesSchema: SCHEMA_STATEMENTS.has(ast.type),
    producesResult,
    resultMode,
    parameters: parameterPlan.parameters,
    maximumParameterIndex: parameterPlan.maximumParameterIndex,
    sourceSpan: sourceSpan(statement.sql, ast),
    orderedMutation,
  }
}

export function orderedSqlBindingValues(compiled: CompiledSqlSource): readonly SqlBindingValue[] {
  const values: Array<SqlBindingValue | undefined> = Array.from(
    { length: compiled.maximumParameterIndex },
    () => undefined,
  )
  const byName = new Map<string, number>()
  for (const parameter of compiled.parameters) {
    for (const name of parameter.names) byName.set(name, parameter.index)
  }
  for (const binding of compiled.source.bindings) {
    const index = binding.parameter.kind === 'index'
      ? binding.parameter.index
      : byName.get(binding.parameter.name)
    if (index === undefined || index < 1 || index > compiled.maximumParameterIndex) {
      throw new SqlCompilerError('SQL_BINDING_PARAMETER_NOT_FOUND')
    }
    const known = values[index - 1]
    if (known !== undefined && !equalBytes(encodeSqlBindingValue(known), encodeSqlBindingValue(binding.value))) {
      throw new SqlCompilerError('SQL_BINDING_CONFLICT')
    }
    values[index - 1] = binding.value
  }
  const referenced = new Set(compiled.parameters.filter((parameter) => parameter.referenced).map((parameter) => parameter.index))
  for (const index of referenced) if (values[index - 1] === undefined) {
    throw new SqlCompilerError('SQL_BINDING_MISSING')
  }
  // Holes below a numbered parameter are not referenced SQLite parameters.
  // The native variadic binding API still needs a placeholder for each slot.
  return values.map((value) => value ?? ({ kind: 'null' } as const))
}

/**
 * Complete an authored outer ORDER BY with the returned columns under BINARY
 * collation. Rows that remain tied are byte-identical in the result envelope,
 * so their physical order cannot affect the ordered-result digest.
 */
export function completeOrderedResultSql(
  compiled: CompiledSqlSource,
  resultColumnCount: number,
): string {
  if (
    compiled.ast.type !== 'SelectStmt' || compiled.ast.body.orderBy === undefined ||
    compiled.ast.body.orderBy.length === 0
  ) throw new SqlCompilerError('SQL_ORDERED_RESULT_REQUIRES_ORDER_BY')
  if (!Number.isSafeInteger(resultColumnCount) || resultColumnCount < 1) {
    throw new SqlCompilerError('SQL_RESULT_COLUMN_COUNT_INVALID')
  }
  const lastTerm = compiled.ast.body.orderBy.at(-1)!
  const insertionOffset = lastTerm.span.offset + lastTerm.span.length
  const tieTerms = Array.from(
    { length: resultColumnCount },
    (_value, index) => `${index + 1} COLLATE BINARY`,
  ).join(', ')
  return `${compiled.source.sql.slice(0, insertionOffset)}, ${tieTerms}${compiled.source.sql.slice(insertionOffset)}`
}

function parseOne(sql: string): Stmt {
  if (typeof sql !== 'string' || sql.length === 0 || sql.includes('\0')) {
    throw new SqlCompilerError('SQL_INVALID_SOURCE')
  }
  let parsed: ReturnType<typeof parse>
  try { parsed = parse(sql) } catch { throw new SqlCompilerError('SQL_PARSE_ERROR') }
  if (parsed.status === 'error') {
    const first = parsed.errors[0]?.token?.span
    throw new SqlCompilerError('SQL_PARSE_ERROR', first === undefined ? null : byteSpan(sql, first.offset, first.length))
  }
  if (parsed.root.cmds.length !== 1) throw new SqlCompilerError('SQL_MULTIPLE_STATEMENTS')
  return parsed.root.cmds[0]!
}

function validatePragma(ast: PragmaStmt, sql: string): void {
  if (ast.name.dbName !== undefined && asciiLower(ast.name.dbName.text) !== 'main') {
    throw compilerError('SQL_ATTACHED_DATABASE_PROHIBITED', sql, ast.name)
  }
  const name = asciiLower(ast.name.objName.text)
  if (!DETERMINISTIC_READ_ONLY_PRAGMAS.has(name) || ast.body !== undefined) {
    throw compilerError('SQL_PRAGMA_STATE_PROHIBITED', sql, ast)
  }
}

function validateTemporaryObjects(ast: Stmt, sql: string): void {
  if (
    (ast.type === 'CreateTableStmt' || ast.type === 'CreateTriggerStmt' || ast.type === 'CreateViewStmt') &&
    ast.temporary
  ) throw compilerError('SQL_TEMP_OBJECT_PROHIBITED', sql, ast)
}

function validateObjectNames(ast: Stmt, sql: string): void {
  traverse(ast, {
    nodes: {
      QualifiedName(node) {
        if (node.dbName !== undefined && asciiLower(node.dbName.text) !== 'main') {
          throw compilerError('SQL_ATTACHED_DATABASE_PROHIBITED', sql, node)
        }
        const name = asciiLower(node.objName.text)
        if (isReservedSchemaObjectName(name) && !isAllowedConsensusReadName(name)) {
          throw compilerError('SQL_PROTECTED_OBJECT_READ', sql, node)
        }
      },
      InsertStmt(node) { validateMutationTarget(node.tblName.objName.text, sql, node) },
      UpdateStmt(node) { validateMutationTarget(node.tblName.objName.text, sql, node) },
      DeleteStmt(node) { validateMutationTarget(node.tblName.objName.text, sql, node) },
      InsertTriggerCmd(node) { validateMutationTarget(node.tblName.objName.text, sql, node) },
      UpdateTriggerCmd(node) { validateMutationTarget(node.tblName.objName.text, sql, node) },
      DeleteTriggerCmd(node) { validateMutationTarget(node.tblName.objName.text, sql, node) },
      ForeignKeyClause(node) {
        if (isReservedSchemaObjectName(node.tblName.text)) {
          throw compilerError('SQL_PROTECTED_OBJECT_READ', sql, node)
        }
      },
    },
  })
  const writeTarget = mutationTarget(ast)
  if (writeTarget !== null && (
    isReservedSchemaObjectName(writeTarget) || asciiLower(writeTarget).startsWith('sqlite_')
  )) throw compilerError('SQL_PROTECTED_OBJECT_WRITE', sql, ast)
  const created = schemaTarget(ast)
  if (created !== null && (
    isReservedSchemaObjectName(created) || asciiLower(created).startsWith('sqlite_') || asciiLower(created).startsWith('dolt_')
  )) throw compilerError('SQL_PROTECTED_OBJECT_NAME', sql, ast)
  if (ast.type === 'CreateIndexStmt') validateMutationTarget(ast.tblName.text, sql, ast)
  if (ast.type === 'CreateTriggerStmt') validateMutationTarget(ast.tblName.objName.text, sql, ast)
}

function validateMutationTarget(name: string, sql: string, node: AstNode): void {
  if (isReservedSchemaObjectName(name) || asciiLower(name).startsWith('sqlite_')) {
    throw compilerError('SQL_PROTECTED_OBJECT_WRITE', sql, node)
  }
}

function isAllowedConsensusReadName(name: string): boolean {
  return name === 'chronolog_transactions' || name === 'sqlite_schema' || name === 'sqlite_master' ||
    (name.startsWith('pragma_') && DETERMINISTIC_READ_ONLY_PRAGMAS.has(name.slice('pragma_'.length)))
}

function validateDeterministicExpressions(ast: Stmt, sql: string): void {
  traverse(ast, {
    enter(node) {
      if (
        node.type === 'CurrentDateLiteral' || node.type === 'CurrentTimeLiteral' ||
        node.type === 'CurrentTimestampLiteral'
      ) throw compilerError('SQL_SIGNED_TIME_TEMPORARILY_GATED', sql, node)
    },
    nodes: {
      FunctionCallExpr(node) { validateFunction(node, sql) },
      FunctionCallStarExpr(node) { validateStarFunction(node, sql) },
      BinaryExpr(node) {
        if (node.op === 'ArrowRight' || node.op === 'ArrowRightShift') {
          throw compilerError('SQL_JSON_OPERATOR_TEMPORARILY_GATED', sql, node)
        }
      },
      LikeExpr(node) {
        if (node.op === 'Match' || node.op === 'Regexp') {
          throw compilerError('SQL_REGISTERED_OPERATOR_REQUIRED', sql, node)
        }
      },
      Select(node) {
        const topLevelResult = ast.type === 'SelectStmt' && node === ast.body
        if (node.limit !== undefined && !isProvablyAtMostOneRow(node) && (!topLevelResult || node.orderBy === undefined)) {
          throw compilerError('SQL_UNORDERED_LIMIT_TEMPORARILY_GATED', sql, node.limit)
        }
        if (node.select.type === 'SelectFrom' && (
          node.select.distinctness === 'Distinct' || node.select.groupBy !== undefined
        )) throw compilerError('SQL_CANONICAL_REPRESENTATIVE_TEMPORARILY_GATED', sql, node.select)
        if (node.compounds?.some((compound) => compound.operator !== 'UnionAll') === true) {
          throw compilerError('SQL_CANONICAL_REPRESENTATIVE_TEMPORARILY_GATED', sql, node)
        }
      },
      SubqueryExpr(node) {
        if (!isProvablyAtMostOneRow(node.select)) {
          throw compilerError('SQL_SCALAR_SUBQUERY_TEMPORARILY_GATED', sql, node)
        }
      },
      TableCallSelectTable(node) {
        const name = asciiLower(node.tblName.objName.text)
        if (!name.startsWith('pragma_') || !DETERMINISTIC_READ_ONLY_PRAGMAS.has(name.slice('pragma_'.length))) {
          throw compilerError('SQL_TABLE_FUNCTION_NOT_REGISTERED', sql, node)
        }
      },
      RaiseExpr(node) { throw compilerError('SQL_RAISE_TEMPORARILY_GATED', sql, node) },
    },
  })
}

function validateFunction(node: FunctionCallExpr, sql: string): void {
  const name = asciiLower(node.name.name)
  if (TEMPORARILY_GATED_FUNCTIONS.has(name)) {
    throw compilerError('SQL_FUNCTION_TEMPORARILY_GATED', sql, node)
  }
  if (ARGUMENT_CONDITIONAL_TIME_FUNCTIONS.has(name)) {
    if (hasUnsafeTimeArgument(node)) throw compilerError('SQL_AMBIENT_TIME_PROHIBITED', sql, node)
    return
  }
  if (name.startsWith('pragma_')) {
    if (!DETERMINISTIC_READ_ONLY_PRAGMAS.has(name.slice('pragma_'.length))) {
      throw compilerError('SQL_PRAGMA_STATE_PROHIBITED', sql, node)
    }
    return
  }
  if (!DETERMINISTIC_SQLITE_COMPILER_FUNCTIONS.has(name)) {
    throw compilerError('SQL_FUNCTION_NOT_REGISTERED', sql, node)
  }
  if ((name === 'min' || name === 'max') && node.args?.length === 1) {
    throw compilerError('SQL_CANONICAL_REPRESENTATIVE_TEMPORARILY_GATED', sql, node)
  }
  if (node.filterOver?.overClause !== undefined) {
    throw compilerError('SQL_WINDOW_TEMPORARILY_GATED', sql, node)
  }
}

function validateStarFunction(node: FunctionCallStarExpr, sql: string): void {
  if (asciiLower(node.name.name) !== 'count') throw compilerError('SQL_FUNCTION_NOT_REGISTERED', sql, node)
  if (node.filterOver?.overClause !== undefined) throw compilerError('SQL_WINDOW_TEMPORARILY_GATED', sql, node)
}

function hasUnsafeTimeArgument(node: FunctionCallExpr): boolean {
  if (node.args === undefined || node.args.length === 0) return true
  return node.args.some((argument) => {
    if (argument.type === 'NumericLiteral' || argument.type === 'NullLiteral') return false
    if (argument.type !== 'StringLiteral') return true
    const value = asciiLower(argument.value)
    return value === 'now' || value === 'localtime' || value === 'utc' ||
      value === 'subsec' || value === 'subsecond'
  })
}

function validateOrderSensitiveMutation(ast: Stmt, sql: string, hasPrivatePlan: boolean): void {
  if ((ast.type === 'UpdateStmt' || ast.type === 'DeleteStmt') && (
    ast.orderBy !== undefined || ast.limit !== undefined
  ) && !hasPrivatePlan) throw compilerError('SQL_ORDERED_MUTATION_TEMPORARILY_GATED', sql, ast)
  if (ast.type === 'UpdateStmt' && (
    (ast.from !== undefined && !isProvablySingletonFrom(ast.from)) ||
    (ast.orConflict !== undefined && ast.orConflict !== 'Abort')
  )) {
    throw compilerError('SQL_ORDER_SENSITIVE_UPDATE_TEMPORARILY_GATED', sql, ast)
  }
  if (ast.type === 'InsertStmt' && ast.body.type === 'SelectInsertBody' &&
      ast.body.select.select.type !== 'SelectValues' && !isProvablyAtMostOneRow(ast.body.select)) {
    throw compilerError('SQL_INSERT_SELECT_TEMPORARILY_GATED', sql, ast.body)
  }
  if (ast.type === 'CreateTableStmt' && ast.body.type === 'AsSelectCreateTableBody' &&
      !isProvablyAtMostOneRow(ast.body.select)) {
    throw compilerError('SQL_CREATE_TABLE_AS_SELECT_TEMPORARILY_GATED', sql, ast.body)
  }
}

/**
 * Syntactic cardinality proof used where SQLite otherwise chooses an arbitrary
 * row. A SELECT without FROM and a single VALUES row can produce at most one
 * row regardless of WHERE, LIMIT, or OFFSET. Broader proofs require catalog
 * uniqueness and remain gated.
 */
function isProvablyAtMostOneRow(select: Select): boolean {
  if (select.compounds !== undefined && select.compounds.length > 0) return false
  if (select.select.type === 'SelectValues') return select.select.values.length <= 1
  return select.select.type === 'SelectFrom' && select.select.from === undefined
}

function isProvablySingletonFrom(from: NonNullable<Extract<Stmt, { type: 'UpdateStmt' }>['from']>): boolean {
  const source = from.select
  return from.joins === undefined && source?.type === 'SelectSelectTable' &&
    isProvablyAtMostOneRow(source.select)
}

interface OrderedMutationSyntax {
  readonly parserSql: string
  readonly cutoff: number
  readonly whereKeyword: number | null
  readonly returningKeyword: number | null
  readonly orderExpressionStart: number | null
  readonly limitKeyword: number
  readonly limitExpressionStart: number
}

const IDENTITY_PREDICATE_TOKEN = '__chronolog_ordered_target_predicate__'
const IDENTITY_SELECT_TOKEN = '__chronolog_ordered_identity_columns__'
const IDENTITY_ORDER_TOKEN = '__chronolog_ordered_identity_order__'

function parseOrderedMutationSyntax(sql: string): OrderedMutationSyntax | null {
  const words = topLevelWords(sql)
  const first = words[0]?.word
  if (first !== 'update' && first !== 'delete') return null
  const limit = words.find((item) => item.word === 'limit')
  if (limit === undefined) return null
  const orderIndex = words.findIndex((item) => item.word === 'order')
  const order = orderIndex < 0 ? undefined : words[orderIndex]
  const by = orderIndex < 0 ? undefined : words[orderIndex + 1]
  if (order !== undefined && by?.word !== 'by') throw new SqlCompilerError('SQL_PARSE_ERROR')
  if (order !== undefined && order.start > limit.start) throw new SqlCompilerError('SQL_PARSE_ERROR')
  const cutoff = order?.start ?? limit.start
  const suffix = sql.slice(0, cutoff).trimEnd()
  const parserSql = `${suffix}${suffix.endsWith(';') ? '' : ';'}`
  const where = words.find((item) => item.word === 'where')
  const returning = words.find((item) => item.word === 'returning')
  if (returning !== undefined && returning.start > cutoff) throw new SqlCompilerError('SQL_ORDERED_MUTATION_RETURNING_POSITION_INVALID')
  return {
    parserSql,
    cutoff,
    whereKeyword: where !== undefined && where.start < cutoff ? where.start : null,
    returningKeyword: returning !== undefined && returning.start < cutoff ? returning.start : null,
    orderExpressionStart: by === undefined ? null : by.end,
    limitKeyword: limit.start,
    limitExpressionStart: limit.end,
  }
}

function buildOrderedMutationPlan(ast: Stmt, sql: string, syntax: OrderedMutationSyntax): OrderedMutationPlan {
  if (ast.type !== 'UpdateStmt' && ast.type !== 'DeleteStmt') throw new SqlCompilerError('SQL_ORDERED_MUTATION_PARSE_MISMATCH')
  if (ast.type === 'UpdateStmt' && (ast.orConflict !== undefined || ast.from !== undefined)) {
    throw new SqlCompilerError('SQL_ORDERED_MUTATION_SET_STABILITY_UNPROVEN')
  }
  if (ast.tblName.alias !== undefined || ast.tblName.dbName !== undefined) {
    throw new SqlCompilerError('SQL_ORDERED_MUTATION_TARGET_ALIAS_GATED')
  }
  const parameters = parameterOccurrences(sql)
  const targetTable = ast.tblName.objName.text
  const targetSql = quoteSqlIdentifier(targetTable)
  const whereExpression = ast.whereClause === undefined
    ? '1'
    : rewriteSourceSegment(sql, ast.whereClause.span.offset, ast.whereClause.span.offset + ast.whereClause.span.length, parameters)
  const orderExpression = syntax.orderExpressionStart === null
    ? ''
    : rewriteSourceSegment(sql, syntax.orderExpressionStart, syntax.limitKeyword, parameters).trim()
  const limitExpression = rewriteSourceSegment(sql, syntax.limitExpressionStart, sql.length, parameters).replace(/;\s*$/u, '').trim()
  if (limitExpression.length === 0) throw new SqlCompilerError('SQL_ORDERED_MUTATION_LIMIT_REQUIRED')
  const selectionSqlTemplate = `SELECT ${IDENTITY_SELECT_TOKEN} FROM ${targetSql} WHERE ${whereExpression} ORDER BY ${orderExpression.length === 0 ? '' : `${orderExpression}, `}${IDENTITY_ORDER_TOKEN} LIMIT ${limitExpression}`
  const selectionMaximumParameterIndex = parameterOccurrences(selectionSqlTemplate)
    .reduce((maximum, parameter) => Math.max(maximum, parameter.index), 0)
  const mutationPrefixEnd = syntax.whereKeyword ?? syntax.returningKeyword ?? syntax.cutoff
  const mutationPrefix = rewriteSourceSegment(sql, 0, mutationPrefixEnd, parameters).trimEnd()
  const returning = syntax.returningKeyword === null
    ? ''
    : ` ${rewriteSourceSegment(sql, syntax.returningKeyword, syntax.cutoff, parameters).trim()}`
  return {
    targetTable,
    selectionSqlTemplate,
    selectionMaximumParameterIndex,
    selectionColumnsToken: IDENTITY_SELECT_TOKEN,
    identityOrderToken: IDENTITY_ORDER_TOKEN,
    mutationSqlTemplate: `${mutationPrefix} WHERE ${IDENTITY_PREDICATE_TOKEN}${returning}`,
    assignedColumns: ast.type === 'UpdateStmt'
      ? ast.sets.flatMap((assignment) => assignment.colNames.map((column) => asciiLower(column.text)))
      : [],
    identityPredicateToken: IDENTITY_PREDICATE_TOKEN,
  }
}

interface ParameterOccurrence { readonly start: number; readonly end: number; readonly index: number; readonly name: string | null }

function parameterPlanFromSource(sql: string): {
  readonly parameters: readonly CompiledSqlParameter[]
  readonly maximumParameterIndex: number
} {
  const occurrences = parameterOccurrences(sql)
  const grouped = new Map<number, Set<string>>()
  for (const item of occurrences) {
    const names = grouped.get(item.index) ?? new Set<string>()
    if (item.name !== null) names.add(item.name)
    grouped.set(item.index, names)
  }
  return {
    maximumParameterIndex: occurrences.reduce((maximum, item) => Math.max(maximum, item.index), 0),
    parameters: [...grouped].sort(([left], [right]) => left - right).map(([index, names]) => ({
      index, names: [...names], referenced: true,
    })),
  }
}

function parameterOccurrences(sql: string): ParameterOccurrence[] {
  const occurrences: ParameterOccurrence[] = []
  const names = new Map<string, number>()
  let maximum = 0
  scanSql(sql, (start, end, token) => {
    if (!token.startsWith('?') && !token.startsWith(':') && !token.startsWith('@') && !token.startsWith('$')) return
    let index: number
    let name: string | null = null
    if (token === '?') index = maximum + 1
    else if (token[0] === '?' && /^\?[0-9]+$/u.test(token)) index = Number(token.slice(1))
    else {
      name = token
      index = names.get(token) ?? maximum + 1
      names.set(token, index)
    }
    if (!Number.isSafeInteger(index) || index < 1 || index > 32_766) throw new SqlCompilerError('SQL_PARAMETER_INDEX_INVALID')
    maximum = Math.max(maximum, index)
    occurrences.push({ start, end, index, name })
  })
  return occurrences
}

function rewriteSourceSegment(sql: string, start: number, end: number, parameters: readonly ParameterOccurrence[]): string {
  let cursor = start
  let rewritten = ''
  for (const parameter of parameters) {
    if (parameter.start < start || parameter.end > end) continue
    rewritten += sql.slice(cursor, parameter.start)
    rewritten += `?${parameter.index}`
    cursor = parameter.end
  }
  return rewritten + sql.slice(cursor, end)
}

interface TopLevelWord { readonly word: string; readonly start: number; readonly end: number }

function topLevelWords(sql: string): TopLevelWord[] {
  const words: TopLevelWord[] = []
  scanSql(sql, (start, end, token, depth) => {
    if (depth === 0 && /^[A-Za-z_][A-Za-z0-9_]*$/u.test(token)) words.push({ word: asciiLower(token), start, end })
  })
  return words
}

function scanSql(
  sql: string,
  visit: (start: number, end: number, token: string, depth: number) => void,
): void {
  let index = 0
  let depth = 0
  while (index < sql.length) {
    const character = sql[index]!
    if (character === "'" || character === '"' || character === '`' || character === '[') {
      const close = character === '[' ? ']' : character
      index += 1
      while (index < sql.length) {
        if (sql[index] === close) {
          if (close !== ']' && sql[index + 1] === close) { index += 2; continue }
          index += 1
          break
        }
        index += 1
      }
      continue
    }
    if (character === '-' && sql[index + 1] === '-') {
      index = sql.indexOf('\n', index + 2)
      if (index < 0) return
      continue
    }
    if (character === '/' && sql[index + 1] === '*') {
      const close = sql.indexOf('*/', index + 2)
      if (close < 0) return
      index = close + 2
      continue
    }
    if (character === '(') { depth += 1; index += 1; continue }
    if (character === ')') { depth = Math.max(0, depth - 1); index += 1; continue }
    if (/[A-Za-z_]/u.test(character)) {
      const start = index++
      while (index < sql.length && /[A-Za-z0-9_]/u.test(sql[index]!)) index += 1
      visit(start, index, sql.slice(start, index), depth)
      continue
    }
    if (character === '?' || character === ':' || character === '@' || character === '$') {
      const start = index++
      if (character === '?') {
        while (index < sql.length && /[0-9]/u.test(sql[index]!)) index += 1
      } else {
        while (isSqliteParameterNameCharacter(sql[index])) index += 1
        if (character === '$' && index > start + 1) {
          while (sql[index] === ':' && sql[index + 1] === ':' && isSqliteParameterNameCharacter(sql[index + 2])) {
            index += 2
            while (isSqliteParameterNameCharacter(sql[index])) index += 1
          }
          if (sql[index] === '(') {
            const close = sql.indexOf(')', index + 1)
            if (close >= 0) index = close + 1
          }
        }
        if (index === start + 1) continue
      }
      visit(start, index, sql.slice(start, index), depth)
      continue
    }
    index += 1
  }
}

function isSqliteParameterNameCharacter(character: string | undefined): boolean {
  if (character === undefined) return false
  const code = character.charCodeAt(0)
  return /[A-Za-z0-9_]/u.test(character) || code >= 0x80
}

function quoteSqlIdentifier(value: string): string { return `"${value.replaceAll('"', '""')}"` }

function classifyStatement(ast: Stmt): SqlStatementClass {
  switch (ast.type) {
    case 'SelectStmt': return 'read'
    case 'InsertStmt': return 'insert'
    case 'UpdateStmt': return 'update'
    case 'DeleteStmt': return 'delete'
    case 'PragmaStmt': return 'pragma'
    case 'CreateVirtualTableStmt': return 'registered_effect'
    default: return SCHEMA_STATEMENTS.has(ast.type) || ast.type === 'ReindexStmt' ? 'schema' : 'registered_effect'
  }
}

function parameterPlanFor(ast: Stmt, sql: string): {
  readonly parameters: readonly CompiledSqlParameter[]
  readonly maximumParameterIndex: number
} {
  const variables: VariableExpr[] = []
  traverse(ast, { nodes: { VariableExpr(node) { variables.push(node) } } })
  variables.sort((left, right) => left.span.offset - right.span.offset)
  const byName = new Map<string, number>()
  const parameters = new Map<number, { names: Set<string>; referenced: boolean }>()
  let maximum = 0
  for (const variable of variables) {
    const token = variable.name
    let index: number
    if (token === '?') {
      index = maximum + 1
    } else if (/^\?[0-9]+$/u.test(token)) {
      index = Number(token.slice(1))
      if (!Number.isSafeInteger(index) || index < 1 || index > 32_766) {
        throw compilerError('SQL_PARAMETER_INDEX_INVALID', sql, variable)
      }
    } else {
      const known = byName.get(token)
      index = known ?? maximum + 1
      if (known === undefined) byName.set(token, index)
    }
    maximum = Math.max(maximum, index)
    const entry = parameters.get(index) ?? { names: new Set<string>(), referenced: true }
    if (token !== '?') entry.names.add(token)
    parameters.set(index, entry)
  }
  return {
    maximumParameterIndex: maximum,
    parameters: [...parameters].sort(([left], [right]) => left - right).map(([index, parameter]) => ({
      index,
      names: [...parameter.names],
      referenced: parameter.referenced,
    })),
  }
}

function validateBindings(
  bindings: readonly SqlBinding[],
  parameters: readonly CompiledSqlParameter[],
  maximumParameterIndex: number,
): void {
  const names = new Map(parameters.flatMap((parameter) => parameter.names.map((name) => [name, parameter.index] as const)))
  const values = new Map<number, SqlBindingValue>()
  for (const binding of bindings) {
    const index = binding.parameter.kind === 'index'
      ? binding.parameter.index
      : names.get(binding.parameter.name)
    if (index === undefined || index < 1 || index > maximumParameterIndex || !parameters.some((parameter) => parameter.index === index)) {
      throw new SqlCompilerError('SQL_BINDING_PARAMETER_NOT_FOUND')
    }
    const previous = values.get(index)
    if (previous !== undefined && !equalBytes(encodeSqlBindingValue(previous), encodeSqlBindingValue(binding.value))) {
      throw new SqlCompilerError('SQL_BINDING_CONFLICT')
    }
    values.set(index, binding.value)
  }
  for (const parameter of parameters) if (parameter.referenced && !values.has(parameter.index)) {
    throw new SqlCompilerError('SQL_BINDING_MISSING')
  }
}

function mutationTarget(ast: Stmt): string | null {
  switch (ast.type) {
    case 'InsertStmt': case 'UpdateStmt': case 'DeleteStmt': return ast.tblName.objName.text
    default: return null
  }
}

function schemaTarget(ast: Stmt): string | null {
  switch (ast.type) {
    case 'AlterTableStmt': return ast.tblName.objName.text
    case 'CreateIndexStmt': return ast.idxName.objName.text
    case 'CreateTableStmt': return ast.tblName.objName.text
    case 'CreateTriggerStmt': return ast.triggerName.objName.text
    case 'CreateViewStmt': return ast.viewName.objName.text
    case 'CreateVirtualTableStmt': return ast.tblName.objName.text
    case 'DropIndexStmt': return ast.idxName.objName.text
    case 'DropTableStmt': return ast.tblName.objName.text
    case 'DropTriggerStmt': return ast.triggerName.objName.text
    case 'DropViewStmt': return ast.viewName.objName.text
    default: return null
  }
}

function sourceSpan(sql: string, node: AstNode): SqlSourceSpan {
  return byteSpan(sql, node.span.offset, node.span.length)
}

function byteSpan(sql: string, offset: number, length: number): SqlSourceSpan {
  return {
    startByte: Buffer.byteLength(sql.slice(0, offset), 'utf8'),
    endByte: Buffer.byteLength(sql.slice(0, offset + length), 'utf8'),
  }
}

function compilerError(code: string, sql: string, node: AstNode): SqlCompilerError {
  return new SqlCompilerError(code, sourceSpan(sql, node))
}

function asciiLower(value: string): string {
  return value.replace(/[A-Z]/gu, (character) => character.toLowerCase())
}

export function selectHasAuthoredOrder(select: Select): boolean {
  return select.orderBy !== undefined
}

export function qualifiedObjectName(name: QualifiedName): string {
  return name.objName.text
}
