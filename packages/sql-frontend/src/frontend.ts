import {
  affectedRows,
  assertValidTransactionProgram,
  BUILTIN_FUNCTION_NAMES,
  IrBuilder,
  sqliteIdentifierEquals,
  sqliteIdentifierKey,
  validateLogicalValue,
  values,
} from '@chronolog/ir'
import {
  compileMutation,
  compileProgram,
  compileQuery,
  compileSchema,
  CompilerError,
  type Catalog,
} from '@chronolog/compiler-sqlite'
import type {
  AffectedRowsExpectation,
  Assignment,
  BinaryOperator,
  BuiltinFunctionName,
  CollationId,
  Cte,
  ExecutionManifest,
  Expr,
  Join,
  LogicalType,
  LogicalValue,
  Mutation,
  OrderTerm,
  Precondition,
  Projection,
  Query,
  Relation,
  ResultMode,
  SchemaManifest,
  SchemaIndex,
  SchemaTable,
  TransactionProgram,
  UnaryOperator,
  UpsertConflictTarget,
  WindowFrame,
  WindowFrameBound,
  WindowOperation,
  WindowSpecification,
} from '@chronolog/ir'
import {
  parse,
  traverse,
  type As,
  type CommonTableExpr,
  type DeleteStmt,
  type Expr as SqlExpr,
  type FrameBound as SqlFrameBound,
  type FromClause,
  type FunctionCallExpr,
  type FunctionCallStarExpr,
  type InsertStmt,
  type Limit,
  type OneSelect,
  type Over,
  type ParenthesizedExpr,
  type QualifiedName,
  type ResultColumn as SqlResultColumn,
  type Select,
  type SelectFrom,
  type SelectTable,
  type SetAssignment,
  type SortedColumn,
  type Stmt,
  type Upsert,
  type UpdateStmt,
  type VariableExpr,
  type With,
  type Window as SqlWindow,
} from 'sqlite3-parser/sqlite-3.53.0'

import type {
  CompiledSql,
  ConsensusSqlFrontend,
  SqlCommandOptions,
  SqliteConsensusFrontendOptions,
  SqlParameterValue,
  SqlParameters,
  SqlQueryOptions,
} from './types.js'
import { SqlFrontendError } from './types.js'

interface RelationBinding {
  readonly relation: Relation
  readonly alias: string
  readonly columns: readonly string[]
  readonly table?: SchemaTable
  /** Overrides physical output when a private derived relation preserves source names. */
  readonly outputColumns?: readonly OutputColumnBinding[]
  /** Source qualifiers and stars preserved across a private derived join boundary. */
  readonly qualifiedStars?: readonly QualifiedStarBinding[]
  /** Qualified-column visibility can differ from SQLite's table-star visibility. */
  readonly qualifiedColumns?: readonly QualifiedStarBinding[]
}

interface OutputColumnBinding {
  readonly name: string
  readonly expression: () => Expr
  readonly target?: QualifiedColumnBinding
}

interface QueryContext {
  readonly ctes: ReadonlyMap<string, Query>
  /** All relations visible from enclosing query levels, nearest level last. */
  readonly outerRelations: readonly RelationBinding[]
  /** Joined-output columns for enclosing levels, nearest level last. */
  readonly outerOutputs: readonly (readonly OutputColumnBinding[])[]
  readonly qualifiedColumns?: ReadonlyMap<string, QualifiedColumnBinding>
}

interface ExpressionContext extends QueryContext {
  /** Includes this query's local relations after the enclosing relations. */
  readonly outerRelations: readonly RelationBinding[]
  /** Includes this query's joined output as the final scope. */
  readonly outerOutputs: readonly (readonly OutputColumnBinding[])[]
  /** Rebinds source-qualified UPDATE FROM columns to the compiler-owned derived source. */
  readonly qualifiedColumns?: ReadonlyMap<string, QualifiedColumnBinding>
  /** SQLite's UPSERT pseudo-table is represented by canonical new-value references. */
  readonly excludedIsNew?: boolean
  /** Comparison-only lowering for compound ORDER BY expression identity. */
  readonly preserveParameterSlots?: boolean
}

interface QualifiedColumnBinding {
  readonly name: string
  readonly relation: string
  readonly ambiguous?: boolean
}

interface QualifiedStarBinding {
  readonly qualifier: string
  readonly columns: readonly OutputColumnBinding[]
}

interface LoweredQuery {
  readonly query: Query
  readonly relations: readonly RelationBinding[]
  readonly outputColumns: readonly OutputColumnBinding[]
}

interface ProjectionBinding {
  readonly projection: Projection
  readonly expressionAst: SqlExpr
}

interface ResultAliasBinding {
  readonly name: string
  readonly expressionAst: SqlExpr
}

interface LoweredCore extends LoweredQuery {
  readonly projectionBindings: readonly ProjectionBinding[]
  readonly resultAliases: readonly ResultAliasBinding[]
  readonly expressionContext: ExpressionContext
}

interface LoweredFrom {
  readonly relations: readonly RelationBinding[]
  readonly joins: readonly Join[]
  readonly outputColumns: readonly OutputColumnBinding[]
}

interface MutationTableBinding {
  readonly table: SchemaTable
  readonly alias: string
}

interface LoweredWith {
  readonly ctes: readonly Cte[]
  readonly bindings: Map<string, Query>
  readonly recursive: boolean
}

interface LoweredUpdateSource {
  readonly query: Query
  readonly alias: string
  readonly outputColumns: readonly OutputColumnBinding[]
  readonly qualifiedColumns: ReadonlyMap<string, QualifiedColumnBinding>
}

const maximumSqliteParameter = 32_766
const joinInner = 1
const joinCross = 2
const joinNatural = 4
const joinLeft = 8
const joinRight = 16

const compilerBuiltinByName: ReadonlyMap<string, BuiltinFunctionName> = new Map(
  BUILTIN_FUNCTION_NAMES.map((name): readonly [string, BuiltinFunctionName] => [
    sqliteIdentifierKey(name),
    name,
  ]),
)

export class SqliteConsensusFrontend implements ConsensusSqlFrontend {
  readonly #schema: SchemaManifest
  readonly #manifest: ExecutionManifest
  readonly #catalog: Catalog
  readonly #builder: IrBuilder
  readonly #tables: ReadonlyMap<string, SchemaTable>

  public constructor(options: SqliteConsensusFrontendOptions) {
    this.#schema = options.schema
    this.#manifest = options.executionManifest
    this.#builder = new IrBuilder(options.startId ?? 1)
    this.#tables = new Map(
      options.schema.objects
        .filter((object): object is SchemaTable => object.kind === 'table')
        .map((table) => [sqliteIdentifierKey(table.name), table]),
    )
    try {
      this.#catalog = compileSchema(this.#schema, this.#manifest).catalog
    } catch (error) {
      throw compilerFrontendError(error, 'schema')
    }
  }

  public lowerQuery(input: CompiledSql, options: SqlQueryOptions = {}): Query {
    const statement = parseOne(input.sql)
    const parameters = new ParameterBinder(input.sql, input.parameters, statement)
    if (statement.type !== 'SelectStmt') {
      throw new SqlFrontendError(
        'SQL_STATEMENT_UNSUPPORTED',
        'Expected one SELECT statement',
        statement.type,
      )
    }
    const lowered = this.#query(statement.body, parameters, emptyQueryContext(), options.resultMode)
    parameters.finish()
    try {
      compileQuery(lowered.query, this.#catalog)
    } catch (error) {
      throw compilerFrontendError(error, 'query')
    }
    return lowered.query
  }

  public lowerAssertion(input: CompiledSql): Precondition {
    return this.#builder.assertion(this.lowerQuery(input, { resultMode: { kind: 'scalar' } }))
  }

  public lowerCommand(input: CompiledSql, options: SqlCommandOptions = {}): Mutation {
    const statement = parseOne(input.sql)
    const parameters = new ParameterBinder(input.sql, input.parameters, statement)
    const expectation = options.affectedRows ?? affectedRows.unconstrained()
    let mutation: Mutation
    switch (statement.type) {
      case 'InsertStmt':
        mutation = this.#insert(statement, parameters, expectation, options.label)
        break
      case 'UpdateStmt':
        mutation = this.#update(statement, parameters, expectation, options.label)
        break
      case 'DeleteStmt':
        mutation = this.#delete(statement, parameters, expectation, options.label)
        break
      default:
        throw new SqlFrontendError(
          'SQL_STATEMENT_UNSUPPORTED',
          'Consensus commands support INSERT, UPDATE, and DELETE',
          statement.type,
        )
    }
    parameters.finish()
    try {
      compileMutation(mutation, this.#catalog)
    } catch (error) {
      throw compilerFrontendError(error, 'command')
    }
    return mutation
  }

  public program(
    preconditions: readonly Precondition[],
    mutations: readonly Mutation[],
    metadata?: ReadonlyMap<string, Uint8Array>,
  ): TransactionProgram {
    if (preconditions.length === 0) {
      throw new SqlFrontendError('SQL_PRECONDITION_REQUIRED', 'Every transaction requires a precondition')
    }
    if (mutations.length === 0) {
      throw new SqlFrontendError('SQL_MUTATION_REQUIRED', 'Every transaction requires a mutation')
    }
    const program = this.#builder.program(preconditions, mutations, metadata)
    try {
      assertValidTransactionProgram(program, {
        schema: this.#schema,
        manifest: this.#manifest,
      })
      compileProgram(program, this.#catalog)
    } catch (error) {
      throw new SqlFrontendError(
        'SQL_IR_INVALID',
        `Lowered SQL did not produce a valid transaction program: ${errorMessage(error)}`,
      )
    }
    return program
  }

  #query(
    select: Select,
    parameters: ParameterBinder,
    context: QueryContext,
    requestedMode?: ResultMode,
  ): LoweredQuery {
    const withClause = this.#with(select.with, parameters, context)
    const ctes = withClause.bindings

    const core = this.#core(select.select, parameters, { ...context, ctes })
    const compounds = [...core.query.compounds]
    const compoundCores: LoweredCore[] = [core]
    for (const compound of select.compounds ?? []) {
      const arm = this.#core(compound.select, parameters, {
        ctes,
        outerRelations: context.outerRelations,
        outerOutputs: context.outerOutputs,
      })
      const operator = compound.operator === 'UnionAll'
        ? 'union_all'
        : compound.operator.toLowerCase() as 'union' | 'intersect' | 'except'
      compounds.push(this.#builder.compound(operator, arm.query))
      compoundCores.push(arm)
    }
    const compoundQuery = compounds.length > 0
    const orderBy = this.#orderBy(
      select.orderBy,
      core.projectionBindings,
      compoundQuery ? compoundCores : undefined,
      parameters,
      core.expressionContext,
      core.resultAliases,
    )
    const page = this.#page(select.limit, parameters)
    const mode = requestedMode ?? (orderBy.length > 0 ? { kind: 'ordered' } : { kind: 'multiset' })
    const query: Query = {
      ...core.query,
      ctes: withClause.ctes,
      compounds,
      orderBy,
      resultMode: mode,
      ...(page === undefined ? {} : { page }),
      ...(withClause.recursive ? { recursive: true } : {}),
    }
    return { query, relations: core.relations, outputColumns: core.outputColumns }
  }

  #with(
    withClause: With | undefined,
    parameters: ParameterBinder,
    context: QueryContext,
  ): LoweredWith {
    const bindings = new Map(context.ctes)
    let recursive = withClause?.recursive ?? false
    const definitions = new Map<string, CommonTableExpr>()
    for (const cte of withClause?.ctes ?? []) {
      const key = sqliteIdentifierKey(cte.tblName.text)
      if (definitions.has(key)) unsupported(`duplicate CTE name ${cte.tblName.text}`)
      definitions.set(key, cte)
    }
    const lowered = new Map<string, { readonly cte: Cte; readonly recursive: boolean }>()
    const visiting = new Set<string>()
    const lowerDefinition = (key: string): void => {
      if (lowered.has(key)) return
      const definition = definitions.get(key)
      if (definition === undefined) return
      if (visiting.has(key)) unsupported(`circular CTE reference involving ${definition.tblName.text}`)
      visiting.add(key)
      for (const dependency of selectCteDependencies(definition.select, definitions.keys())) {
        if (dependency !== key) lowerDefinition(dependency)
      }
      const result = this.#cte(
        definition,
        parameters,
        { ...context, ctes: bindings },
        withClause?.recursive ?? false,
      )
      lowered.set(key, result)
      bindings.set(key, result.cte.query)
      recursive ||= result.recursive
      visiting.delete(key)
    }
    for (const key of definitions.keys()) lowerDefinition(key)
    // Canonical IR emits dependencies first because its CTE scopes are
    // deliberately sequential. CTE queries are pure, so this topological
    // order preserves SQLite's all-names-visible semantics.
    const ctes = [...lowered.values()].map((result) => result.cte)
    return { ctes, bindings, recursive }
  }

  #cte(
    cte: CommonTableExpr,
    parameters: ParameterBinder,
    context: QueryContext & { readonly ctes: Map<string, Query> },
    recursiveKeyword: boolean,
  ): { readonly cte: Cte; readonly recursive: boolean } {
    const name = cte.tblName.text
    const columnNames = (cte.columns ?? []).map((column) => column.colName.text)
    const selfRecursive = selectReferencesTable(cte.select, name)
    if (recursiveKeyword || selfRecursive) {
      const anchor = this.#core(cte.select.select, parameters, {
        ctes: context.ctes,
        outerRelations: context.outerRelations,
        outerOutputs: context.outerOutputs,
      })
      if (columnNames.length > 0 && columnNames.length !== anchor.query.projection.length) {
        cteColumnMismatch(name, columnNames.length, anchor.query.projection.length)
      }
      const placeholderNames = sqliteRelationColumnNames(
        columnNames.length === 0
          ? anchor.query.projection.map((projection) => projection.name)
          : columnNames,
      )
      const placeholderProjection = anchor.query.projection.map((projection, index) => ({
        ...projection,
        name: placeholderNames[index]!,
      }))
      context.ctes.set(
        sqliteIdentifierKey(name),
        this.#builder.query(placeholderProjection, { resultMode: { kind: 'multiset' } }),
      )
    }
    const lowered = this.#query(cte.select, parameters, {
      ctes: context.ctes,
      outerRelations: context.outerRelations,
      outerOutputs: context.outerOutputs,
    }, { kind: 'multiset' })
    if (columnNames.length > 0 && columnNames.length !== lowered.query.projection.length) {
      cteColumnMismatch(name, columnNames.length, lowered.query.projection.length)
    }
    const resultNames = sqliteRelationColumnNames(
      columnNames.length === 0
        ? lowered.query.projection.map((projection) => projection.name)
        : columnNames,
    )
    const query: Query = {
      ...lowered.query,
      projection: lowered.query.projection.map((projection, index) => ({
        ...projection,
        name: resultNames[index]!,
      })),
    }
    const materialized = cte.materialized === 'Yes'
      ? 'materialized'
      : cte.materialized === 'No' ? 'not_materialized' : 'default'
    return {
      cte: this.#builder.cte(name, query, materialized),
      recursive: selfRecursive,
    }
  }

  #core(one: OneSelect, parameters: ParameterBinder, context: QueryContext): LoweredCore {
    if (one.type === 'SelectValues') return this.#valuesCore(one.values, parameters, context)
    return this.#selectCore(one, parameters, context)
  }

  #selectCore(select: SelectFrom, parameters: ParameterBinder, context: QueryContext): LoweredCore {
    const resultAliases = select.columns.flatMap((column): readonly ResultAliasBinding[] => {
      if (column.type !== 'ExprResultColumn') return []
      const name = aliasName(column.alias)
      return name === undefined ? [] : [{ name, expressionAst: column.expr }]
    })
    const from = this.#from(select.from, context.ctes, parameters, context, resultAliases)
    const expressionContext: ExpressionContext = {
      ctes: context.ctes,
      outerRelations: [...context.outerRelations, ...from.relations],
      outerOutputs: [...context.outerOutputs, from.outputColumns],
      qualifiedColumns: qualifiedColumnsForRelations(context.qualifiedColumns, from.relations, this.#builder),
    }
    const projectionBindings = this.#projections(
      select.columns,
      from.relations,
      from.outputColumns,
      parameters,
      expressionContext,
    )
    const aliasExpressionContext = this.#resultAliasContext(
      expressionContext,
      resultAliases,
      parameters,
    )
    const windows = (select.windowClause ?? []).map((definition) => {
      const specification = this.#windowSpecification(definition.window, parameters, expressionContext)
      return this.#builder.window(
        definition.name.text,
        specification.partitionBy,
        specification.orderBy,
        windowOptions(specification),
      )
    })
    const query = this.#builder.query(
      projectionBindings.map((binding) => binding.projection),
      {
        ...(from.relations[0] === undefined ? {} : { from: from.relations[0].relation }),
        joins: from.joins,
        ...(select.whereClause === undefined
          ? {}
          : { where: this.#expression(select.whereClause, parameters, aliasExpressionContext) }),
        groupBy: this.#groupBy(
          select.groupBy,
          projectionBindings,
          resultAliases,
          parameters,
          expressionContext,
        ),
        windows,
        ...(select.having === undefined
          ? {}
          : { having: this.#expression(select.having, parameters, aliasExpressionContext) }),
        resultMode: { kind: 'multiset' },
        ...(select.distinctness === 'Distinct' ? { distinct: true } : {}),
      },
    )
    return {
      query,
      relations: from.relations,
      outputColumns: from.outputColumns,
      projectionBindings,
      resultAliases,
      expressionContext,
    }
  }

  #valuesCore(
    rows: readonly { readonly values: readonly SqlExpr[] }[],
    parameters: ParameterBinder,
    context: QueryContext,
  ): LoweredCore {
    if (rows.length === 0) unsupported('empty VALUES query')
    const expressionContext: ExpressionContext = {
      ...context,
      outerOutputs: [...context.outerOutputs, []],
    }
    const projectionsFor = (row: { readonly values: readonly SqlExpr[] }): ProjectionBinding[] =>
      row.values.map((expression, index) => ({
        projection: this.#builder.projection(
          `column${index + 1}`,
          this.#expression(expression, parameters, expressionContext),
        ),
        expressionAst: expression,
      }))
    const projectionBindings = projectionsFor(rows[0]!)
    const compounds = rows.slice(1).map((row) => this.#builder.compound(
      'union_all',
      this.#builder.query(projectionsFor(row).map((binding) => binding.projection), {
        resultMode: { kind: 'multiset' },
      }),
    ))
    const query = this.#builder.query(projectionBindings.map((binding) => binding.projection), {
      compounds,
      resultMode: { kind: 'multiset' },
    })
    return {
      query,
      relations: [],
      outputColumns: [],
      projectionBindings,
      resultAliases: [],
      expressionContext,
    }
  }

  #from(
    clause: FromClause | undefined,
    ctes: ReadonlyMap<string, Query>,
    parameters: ParameterBinder,
    context: QueryContext,
    resultAliases: readonly ResultAliasBinding[] = [],
  ): LoweredFrom {
    if (clause?.select === undefined) return { relations: [], joins: [], outputColumns: [] }
    const first = this.#relation(clause.select, ctes, parameters, context, 0, resultAliases)
    const relations: RelationBinding[] = [first]
    const joins: Join[] = []
    let outputColumns = physicalOutput(first, this.#builder)
    for (const [index, joined] of (clause.joins ?? []).entries()) {
      const right = this.#relation(
        joined.table,
        ctes,
        parameters,
        context,
        index + 1,
        resultAliases,
      )
      const flags = joined.operator.type === 'CommaJoinOperator'
        ? joinCross
        : joined.operator.joinType ?? joinInner
      const natural = (flags & joinNatural) !== 0
      const kind: Join['kind'] = (flags & joinRight) !== 0 && (flags & joinLeft) !== 0
        ? 'full'
        : (flags & joinRight) !== 0
          ? 'right'
          : (flags & joinLeft) !== 0
            ? 'left'
            : (flags & joinCross) !== 0 ? 'cross' : 'inner'
      let using: readonly string[] | undefined
      let on: Expr | undefined
      if (natural) {
        if (joined.constraint !== undefined) unsupported('NATURAL JOIN with ON or USING')
        using = naturalColumns(outputColumns, right.columns)
      } else if (joined.constraint?.type === 'UsingJoinConstraint') {
        using = joined.constraint.columns.map((column) => column.text)
      } else if (joined.constraint?.type === 'OnJoinConstraint') {
        const onOutputs = [...outputColumns, ...physicalOutput(right, this.#builder)]
        const onContext: ExpressionContext = {
          ctes,
          outerRelations: [...context.outerRelations, ...relations, right],
          outerOutputs: [...context.outerOutputs, onOutputs],
          qualifiedColumns: qualifiedColumnsForRelations(
            context.qualifiedColumns,
            [...relations, right],
            this.#builder,
          ),
        }
        on = this.#expression(
          joined.constraint.expr,
          parameters,
          this.#resultAliasContext(onContext, resultAliases, parameters),
        )
      }
      if (using !== undefined) validateUsingColumns(using, outputColumns, right, kind)
      joins.push(this.#builder.join(
        kind,
        right.relation,
        on,
        using === undefined || using.length === 0 ? undefined : using,
      ))
      outputColumns = joinOutput(outputColumns, right, using ?? [], kind, this.#builder)
      relations.push(right)
    }
    return { relations, joins, outputColumns }
  }

  #relation(
    table: SelectTable,
    ctes: ReadonlyMap<string, Query>,
    parameters: ParameterBinder,
    context: QueryContext,
    index: number,
    resultAliases: readonly ResultAliasBinding[] = [],
  ): RelationBinding {
    switch (table.type) {
      case 'SelectSelectTable': {
        const nested = sqliteRelationBoundaryQuery(
          this.#query(table.select, parameters, context, { kind: 'multiset' }).query,
        )
        const alias = aliasName(table.alias) ?? `__chronolog_derived_${index + 1}`
        return {
          relation: this.#builder.subquery(nested, alias),
          alias,
          columns: nested.projection.map((projection) => projection.name),
        }
      }
      case 'TableSelectTable': {
        if (table.indexed !== undefined) unsupported('INDEXED BY / NOT INDEXED')
        return this.#namedRelation(table.tblName, aliasName(table.alias), ctes)
      }
      case 'TableCallSelectTable':
        return unsupported('table-valued function in FROM')
      case 'SubSelectTable':
        return this.#joinedTable(table, ctes, parameters, context, index, resultAliases)
    }
  }

  #joinedTable(
    table: Extract<SelectTable, { readonly type: 'SubSelectTable' }>,
    ctes: ReadonlyMap<string, Query>,
    parameters: ParameterBinder,
    context: QueryContext,
    index: number,
    resultAliases: readonly ResultAliasBinding[],
  ): RelationBinding {
    const inner = this.#from(table.from, ctes, parameters, context, resultAliases)
    if (inner.relations.length === 0) unsupported('empty parenthesized joined table')

    const alias = aliasName(table.alias) ?? `__chronolog_join_group_${index + 1}`
    const rawNames = inner.outputColumns.map((column) => column.name)
    const visibleNames = sqliteRelationColumnNames(rawNames)
    const projections = inner.outputColumns.map((column, columnIndex) =>
      this.#builder.projection(visibleNames[columnIndex]!, column.expression()))
    const outputColumns = inner.outputColumns.map((column, columnIndex): OutputColumnBinding => ({
      name: column.name,
      expression: () => this.#builder.column(visibleNames[columnIndex]!, alias),
      target: { name: visibleNames[columnIndex]!, relation: alias },
    }))

    const rebind = (
      stars: readonly QualifiedStarBinding[],
      prefix: string,
    ): readonly QualifiedStarBinding[] => stars.map((star, starIndex): QualifiedStarBinding => ({
      qualifier: star.qualifier,
      columns: star.columns.map((column, columnIndex): OutputColumnBinding => {
        const name = `__chronolog_${prefix}_${starIndex + 1}_${columnIndex + 1}`
        projections.push(this.#builder.projection(name, column.expression()))
        return {
          name: column.name,
          expression: () => this.#builder.column(name, alias),
          target: { name, relation: alias },
        }
      }),
    }))
    const reboundColumns = rebind(
      inner.relations.flatMap((relation) => qualifiedColumnsForRelation(relation, this.#builder)),
      'qualified',
    )
    const reboundStars = rebind(
      inner.relations.flatMap((relation) => qualifiedStarsForRelation(relation, this.#builder)),
      'star',
    )
    const query = this.#builder.query(projections, {
      from: inner.relations[0]!.relation,
      joins: inner.joins,
      resultMode: { kind: 'multiset' },
    })
    return {
      relation: this.#builder.subquery(query, alias),
      alias,
      columns: rawNames,
      outputColumns,
      qualifiedStars: table.alias === undefined
        ? reboundStars
        : [],
      qualifiedColumns: table.alias === undefined
        ? reboundColumns
        : [{ qualifier: alias, columns: outputColumns }],
    }
  }

  #namedRelation(
    qualified: QualifiedName,
    explicitAlias: string | undefined,
    ctes: ReadonlyMap<string, Query>,
  ): RelationBinding {
    requireMainDatabase(qualified)
    const name = qualified.objName.text
    const alias = explicitAlias ?? qualified.alias?.text ?? name
    const cte = qualified.dbName === undefined ? ctes.get(sqliteIdentifierKey(name)) : undefined
    if (cte !== undefined) {
      return {
        relation: this.#builder.cteReference(name, alias),
        alias,
        columns: cte.projection.map((projection) => projection.name),
      }
    }
    const table = this.#tables.get(sqliteIdentifierKey(name))
    if (table === undefined) {
      throw new SqlFrontendError('SQL_SCHEMA_OBJECT_NOT_FOUND', `Table ${name} is not in the schema manifest`, name)
    }
    return {
      relation: this.#builder.table(table.name, alias),
      alias,
      columns: table.columns.map((column) => column.name),
      table,
    }
  }

  #projections(
    columns: readonly SqlResultColumn[],
    relations: readonly RelationBinding[],
    outputColumns: readonly OutputColumnBinding[],
    parameters: ParameterBinder,
    context: ExpressionContext,
  ): ProjectionBinding[] {
    return columns.flatMap((column): readonly ProjectionBinding[] => {
      if (column.type === 'StarResultColumn') {
        if (outputColumns.length === 0) unsupported('star projection without a FROM source')
        return outputColumns.map((binding) => {
          const expression = binding.expression()
          return {
            projection: this.#builder.projection(binding.name, expression),
            expressionAst: syntheticColumnAst(binding.name),
          }
        })
      }
      if (column.type === 'TableStarResultColumn') {
        const selected = relations.flatMap((relation) =>
          qualifiedStarsForRelation(relation, this.#builder).filter((star) =>
            sqliteIdentifierEquals(star.qualifier, column.table.text)))
        if (selected.length !== 1) unsupported(`unknown star qualifier ${column.table.text}`)
        return selected[0]!.columns.map((binding) => ({
          projection: this.#builder.projection(
            binding.name,
            binding.expression(),
          ),
          expressionAst: syntheticColumnAst(binding.name),
        }))
      }
      const lowered = this.#expression(column.expr, parameters, context)
      const name = aliasName(column.alias) ?? this.#projectionName(column.expr, lowered, parameters, context)
      return [{
        projection: this.#builder.projection(name, lowered),
        expressionAst: column.expr,
      }]
    })
  }

  #projectionName(
    expression: SqlExpr,
    lowered: Expr,
    parameters: ParameterBinder,
    context: ExpressionContext,
  ): string {
    if (isDirectColumnSyntax(expression) && lowered.kind === 'column') {
      if (lowered.relation === undefined) return lowered.name
      for (let index = context.outerRelations.length - 1; index >= 0; index -= 1) {
        const relation = context.outerRelations[index]!
        if (!sqliteIdentifierEquals(relation.alias, lowered.relation)) continue
        const column = relation.columns.find((name) => sqliteIdentifierEquals(name, lowered.name))
        if (column !== undefined) return column
      }
      return lowered.name
    }
    return parameters.sourceText(expression)
  }

  #orderBy(
    terms: readonly SortedColumn[] | undefined,
    projections: readonly ProjectionBinding[],
    compoundCores: readonly LoweredCore[] | undefined,
    parameters: ParameterBinder,
    context: ExpressionContext,
    resultAliases: readonly ResultAliasBinding[],
  ): OrderTerm[] {
    return (terms ?? []).map((term) => {
      const direction = term.order === 'Desc' ? 'desc' : 'asc'
      const ordinalIndex = projectionOrdinalIndex(term.expr, projections.length, 'ORDER BY')
      let expression: Expr
      if (compoundCores !== undefined) {
        const projectionIndex = ordinalIndex ??
          this.#compoundProjectionIndex(term.expr, compoundCores, parameters)
        expression = this.#builder.literal(values.int64(BigInt(projectionIndex + 1)))
      } else {
        const projectionIndex = ordinalIndex ?? projectionAliasIndex(term.expr, projections)
        expression = projectionIndex === undefined
          ? this.#expression(
            term.expr,
            parameters,
            this.#resultAliasContext(context, resultAliases, parameters),
          )
          : this.#expression(projections[projectionIndex]!.expressionAst, parameters, context)
      }
      return this.#builder.order(
        expression,
        direction,
        term.nulls === 'First' ? 'first' : term.nulls === 'Last' ? 'last' : direction === 'asc' ? 'first' : 'last',
      )
    })
  }

  #compoundProjectionIndex(
    expression: SqlExpr,
    cores: readonly LoweredCore[],
    parameters: ParameterBinder,
  ): number {
    for (const core of cores) {
      const aliasIndex = projectionAliasIndex(expression, core.projectionBindings)
      if (aliasIndex !== undefined) return aliasIndex
      const comparisonContext: ExpressionContext = {
        ...core.expressionContext,
        preserveParameterSlots: true,
      }
      const lowered = this.#expression(expression, parameters, comparisonContext)
      const expressionIndex = core.projectionBindings.findIndex((binding) =>
        sameSchemaExpression(
          lowered,
          this.#expression(binding.expressionAst, parameters, comparisonContext),
          new Set(),
        ))
      if (expressionIndex >= 0) return expressionIndex
    }
    unsupported('compound ORDER BY term that does not match any result column')
  }

  #groupBy(
    expressions: readonly SqlExpr[] | undefined,
    projections: readonly ProjectionBinding[],
    resultAliases: readonly ResultAliasBinding[],
    parameters: ParameterBinder,
    context: ExpressionContext,
  ): Expr[] {
    const aliasContext = this.#resultAliasContext(context, resultAliases, parameters)
    return (expressions ?? []).map((expression) => {
      const ordinalIndex = projectionOrdinalIndex(expression, projections.length, 'GROUP BY')
      const projectionIndex = ordinalIndex ?? (
        expression.type === 'Id' && !this.#inputIdentifierExists(expression.name, context)
          ? projectionAliasIndex(expression, projections)
          : undefined
      )
      return this.#expression(
        projectionIndex === undefined ? expression : projections[projectionIndex]!.expressionAst,
        parameters,
        projectionIndex === undefined ? aliasContext : context,
      )
    })
  }

  #resultAliasContext(
    context: ExpressionContext,
    aliases: readonly ResultAliasBinding[],
    parameters: ParameterBinder,
  ): ExpressionContext {
    if (aliases.length === 0) return context
    const seen = new Set<string>()
    const fallback = aliases.flatMap((alias): readonly OutputColumnBinding[] => {
      const key = sqliteIdentifierKey(alias.name)
      if (seen.has(key)) return []
      seen.add(key)
      return [{
        name: alias.name,
        expression: () => this.#expression(alias.expressionAst, parameters, context),
      }]
    })
    const local = context.outerOutputs[context.outerOutputs.length - 1] ?? []
    return {
      ...context,
      outerOutputs: [
        ...context.outerOutputs.slice(0, -1),
        fallback,
        local,
      ],
    }
  }

  #inputIdentifierExists(name: string, context: ExpressionContext): boolean {
    const localOutput = context.outerOutputs[context.outerOutputs.length - 1] ?? []
    return localOutput.some((column) => sqliteIdentifierEquals(column.name, name))
  }

  #page(limit: Limit | undefined, parameters: ParameterBinder): { readonly limit: number; readonly offset?: number } | undefined {
    if (limit === undefined) return undefined
    const value = pageValue(limit.expr, parameters)
    const offset = limit.offset === undefined ? undefined : pageValue(limit.offset, parameters)
    return { limit: value, ...(offset === undefined ? {} : { offset }) }
  }

  #expression(ast: SqlExpr, parameters: ParameterBinder, context: ExpressionContext): Expr {
    switch (ast.type) {
      case 'Id': return this.#identifier(ast.name, context)
      case 'QualifiedExpr': {
        if (ast.schema !== undefined && !sqliteIdentifierEquals(ast.schema.text, 'main')) {
          unsupported(`qualified database ${ast.schema.text}`)
        }
        if (ast.schema === undefined && context.excludedIsNew &&
            sqliteIdentifierEquals(ast.table.text, 'excluded')) {
          return this.#builder.oldNew('new', ast.column.text)
        }
        const rebound = context.qualifiedColumns?.get(
          qualifiedColumnKey(ast.table.text, ast.column.text),
        )
        if (rebound?.ambiguous === true) {
          return unsupported(`ambiguous column ${ast.table.text}.${ast.column.text}`)
        }
        if (rebound !== undefined) return this.#builder.column(rebound.name, rebound.relation)
        return this.#builder.column(ast.column.text, ast.table.text)
      }
      case 'VariableExpr': return context.preserveParameterSlots
        ? this.#builder.parameter(`sqlite_slot_${parameters.slot(ast)}`, {
          logical: { kind: 'blob' },
          nullable: true,
        })
        : this.#builder.literal(parameters.value(ast))
      case 'NumericLiteral': return this.#builder.literal(numericValue(ast.value))
      case 'StringLiteral': return this.#builder.literal(values.text(ast.value))
      case 'BlobLiteral': return this.#builder.literal(values.blob(ast.bytes))
      case 'NullLiteral': return this.#builder.literal(values.null())
      case 'KeywordLiteral': return this.#keywordLiteral(ast.value)
      case 'CurrentDateLiteral': return unsupported('CURRENT_DATE')
      case 'CurrentTimeLiteral': return unsupported('CURRENT_TIME')
      case 'CurrentTimestampLiteral': return unsupported('CURRENT_TIMESTAMP')
      case 'UnaryExpr': return this.#unary(ast.op, ast.expr, parameters, context)
      case 'BinaryExpr': return this.#binary(ast, parameters, context)
      case 'BetweenExpr': {
        const lower = this.#builder.binary(
          'gte',
          this.#expression(ast.lhs, parameters, context),
          this.#expression(ast.start, parameters, context),
        )
        const upper = this.#builder.binary(
          'lte',
          this.#expression(ast.lhs, parameters, context),
          this.#expression(ast.end, parameters, context),
        )
        const between = this.#builder.binary('and', lower, upper)
        return ast.not ? this.#builder.unary('not', between) : between
      }
      case 'LikeExpr': {
        if (ast.op === 'Match' || ast.op === 'Regexp') unsupported(ast.op.toUpperCase())
        const operator: BinaryOperator = ast.op === 'Glob'
          ? ast.not ? 'not_glob' : 'glob'
          : ast.not ? 'not_like' : 'like'
        return this.#builder.binary(
          operator,
          this.#expression(ast.lhs, parameters, context),
          this.#expression(ast.rhs, parameters, context),
          ast.escape === undefined ? undefined : this.#expression(ast.escape, parameters, context),
        )
      }
      case 'IsNullExpr':
        return this.#builder.unary('is_null', this.#expression(ast.expr, parameters, context))
      case 'NotNullExpr':
        return this.#builder.unary('is_not_null', this.#expression(ast.expr, parameters, context))
      case 'InListExpr':
        return this.#builder.membership(
          this.#expression(ast.lhs, parameters, context),
          (ast.rhs ?? []).map((item) => this.#expression(item, parameters, context)),
          ast.not,
        )
      case 'InSelectExpr':
        return this.#builder.membership(
          this.#expression(ast.lhs, parameters, context),
          this.#query(ast.rhs, parameters, context, { kind: 'multiset' }).query,
          ast.not,
        )
      case 'InTableExpr': {
        if (ast.args !== undefined) unsupported('table-valued function in IN expression')
        const relation = this.#namedRelation(ast.rhs, undefined, context.ctes)
        if (relation.columns.length !== 1) {
          unsupported(`IN table ${ast.rhs.objName.text} with ${relation.columns.length} columns`)
        }
        const column = relation.columns[0]!
        const query = this.#builder.query([
          this.#builder.projection(column, this.#builder.column(column, relation.alias)),
        ], { from: relation.relation, resultMode: { kind: 'multiset' } })
        return this.#builder.membership(
          this.#expression(ast.lhs, parameters, context),
          query,
          ast.not,
        )
      }
      case 'ParenthesizedExpr': return this.#parenthesized(ast, parameters, context)
      case 'SubqueryExpr':
        return this.#builder.scalarSubquery(this.#query(ast.select, parameters, context, { kind: 'scalar' }).query)
      case 'ExistsExpr':
        return this.#builder.exists(this.#query(ast.select, parameters, context, { kind: 'multiset' }).query)
      case 'CaseExpr': {
        const branches = ast.whenThenPairs.map((pair) => this.#builder.branch(
          ast.base === undefined
            ? this.#expression(pair.when, parameters, context)
            : this.#builder.binary(
              'eq',
              this.#expression(ast.base, parameters, context),
              this.#expression(pair.when, parameters, context),
            ),
          this.#expression(pair.then, parameters, context),
        ))
        if (branches.length === 0) unsupported('CASE without WHEN')
        return this.#builder.conditional(
          branches,
          ast.elseExpr === undefined
            ? this.#builder.literal(values.null())
            : this.#expression(ast.elseExpr, parameters, context),
        )
      }
      case 'CastExpr': return this.#cast(ast.expr, ast.typeName?.name, parameters, context)
      case 'CollateExpr': {
        return this.#builder.collate(
          this.#expression(ast.expr, parameters, context),
          this.#collation(ast.collation),
        )
      }
      case 'FunctionCallExpr': return this.#function(ast, parameters, context)
      case 'FunctionCallStarExpr': return this.#starFunction(ast, parameters, context)
      case 'NameExpr': return unsupported(`name expression ${ast.name.text}`)
      case 'RaiseExpr': return unsupported('RAISE expression')
    }
  }

  #identifier(name: string, context: ExpressionContext): Expr {
    for (let index = context.outerOutputs.length - 1; index >= 0; index -= 1) {
      const matches = context.outerOutputs[index]!.filter((column) => sqliteIdentifierEquals(column.name, name))
      if (matches.length === 1) return matches[0]!.expression()
      if (matches.length > 1) unsupported(`ambiguous column ${name}`)
    }
    if (sqliteIdentifierEquals(name, 'true')) return this.#builder.literal(values.boolean(true))
    if (sqliteIdentifierEquals(name, 'false')) return this.#builder.literal(values.boolean(false))
    return this.#builder.column(name)
  }

  #keywordLiteral(value: string): Expr {
    if (sqliteIdentifierEquals(value, 'true') || sqliteIdentifierEquals(value, 'on')) {
      return this.#builder.literal(values.boolean(true))
    }
    if (sqliteIdentifierEquals(value, 'false') || sqliteIdentifierEquals(value, 'off')) {
      return this.#builder.literal(values.boolean(false))
    }
    return unsupported(`keyword literal ${value}`)
  }

  #parenthesized(ast: ParenthesizedExpr, parameters: ParameterBinder, context: ExpressionContext): Expr {
    if (ast.exprs.length === 1) return this.#expression(ast.exprs[0]!, parameters, context)
    if (ast.exprs.length < 2) unsupported('empty parenthesized expression')
    return this.#builder.row(ast.exprs.map((expression) => this.#expression(expression, parameters, context)))
  }

  #unary(
    operator: 'BitwiseNot' | 'Negative' | 'Not' | 'Positive',
    operand: SqlExpr,
    parameters: ParameterBinder,
    context: ExpressionContext,
  ): Expr {
    if (operator === 'Positive') return this.#expression(operand, parameters, context)
    const lowered: UnaryOperator = operator === 'Not' ? 'not' : operator === 'Negative' ? 'negate' : 'bit_not'
    return this.#builder.unary(lowered, this.#expression(operand, parameters, context))
  }

  #binary(
    ast: Extract<SqlExpr, { readonly type: 'BinaryExpr' }>,
    parameters: ParameterBinder,
    context: ExpressionContext,
  ): Expr {
    if (ast.op === 'ArrowRight' || ast.op === 'ArrowRightShift') {
      if (ast.op === 'ArrowRightShift') unsupported('JSON ->> dynamic scalar result')
      return this.#builder.jsonOperation(
        'extract',
        [this.#expression(ast.left, parameters, context)],
        jsonPath(ast.right) ?? this.#expression(ast.right, parameters, context),
      )
    }
    const operators: Readonly<Record<typeof ast.op, BinaryOperator | undefined>> = {
      Add: 'add', And: 'and',
      BitwiseAnd: 'bit_and', BitwiseOr: 'bit_or', Concat: 'concat', Divide: 'divide',
      Equals: 'eq', Greater: 'gt', GreaterEquals: 'gte', Is: 'is', IsNot: 'is_not',
      LeftShift: 'shift_left', Less: 'lt', LessEquals: 'lte', Modulus: 'modulo',
      Multiply: 'multiply', NotEquals: 'ne', Or: 'or', RightShift: 'shift_right',
      Subtract: 'subtract',
    }
    const operator = operators[ast.op]
    if (operator === undefined) unsupported(`binary operator ${ast.op}`)
    if ((operator === 'is' || operator === 'is_not') && ast.right.type === 'NullLiteral') {
      return this.#builder.unary(
        operator === 'is' ? 'is_null' : 'is_not_null',
        this.#expression(ast.left, parameters, context),
      )
    }
    return this.#builder.binary(
      operator,
      this.#expression(ast.left, parameters, context),
      this.#expression(ast.right, parameters, context),
    )
  }

  #cast(
    expression: SqlExpr,
    rawTarget: string | undefined,
    parameters: ParameterBinder,
    context: ExpressionContext,
  ): Expr {
    if (rawTarget === undefined) unsupported('CAST without a target type')
    const target = rawTarget.toUpperCase()
    const logical: LogicalType = ['INTEGER', 'INT', 'BIGINT', 'SMALLINT', 'TINYINT'].includes(target)
      ? { kind: 'int64' }
      : ['TEXT', 'VARCHAR', 'CHAR', 'LONGTEXT', 'MEDIUMTEXT', 'TINYTEXT'].includes(target)
        ? { kind: 'text', collation: 'binary' }
        : ['BLOB', 'LONGBLOB', 'MEDIUMBLOB', 'TINYBLOB'].includes(target)
          ? { kind: 'blob' }
          : unsupported(`CAST target ${target}`)
    return this.#builder.cast(this.#expression(expression, parameters, context), logical)
  }

  #function(ast: FunctionCallExpr, parameters: ParameterBinder, context: ExpressionContext): Expr {
    const name = ast.name.name
    const args = ast.args ?? []
    const key = sqliteIdentifierKey(name)
    const aggregateOperation = key === sqliteIdentifierKey('every') || key === sqliteIdentifierKey('bool_and')
      ? 'every'
      : key === sqliteIdentifierKey('any') || key === sqliteIdentifierKey('some') || key === sqliteIdentifierKey('bool_or')
        ? 'any'
        : key === sqliteIdentifierKey('count')
          ? 'count'
          : (key === sqliteIdentifierKey('min') || key === sqliteIdentifierKey('max')) && args.length === 1
            ? key as 'min' | 'max'
            : undefined
    let aggregateOrderBy: OrderTerm[] | undefined
    if (ast.orderBy !== undefined) {
      if (ast.orderBy.type === 'WithinGroupFunctionCallOrder') {
        unsupported('WITHIN GROUP aggregate ordering')
      }
      if (aggregateOperation === undefined) unsupported(`ORDER BY on non-aggregate function ${name}`)
      aggregateOrderBy = ast.orderBy.columns.map((term) => {
        const direction = term.order === 'Desc' ? 'desc' : 'asc'
        return this.#builder.order(
          this.#expression(term.expr, parameters, context),
          direction,
          term.nulls === 'First'
            ? 'first'
            : term.nulls === 'Last' ? 'last' : direction === 'asc' ? 'first' : 'last',
        )
      })
    }
    const loweredArgs = args.map((argument) => this.#expression(argument, parameters, context))
    const filter = ast.filterOver?.filterClause === undefined
      ? undefined
      : this.#expression(ast.filterOver.filterClause, parameters, context)
    if (ast.filterOver?.overClause !== undefined) {
      if ((aggregateOrderBy?.length ?? 0) > 0) {
        // SQLite parses this shape but rejects it during preparation.
        unsupported('aggregate argument ORDER BY in a window function')
      }
      const operation = windowOperation(name, aggregateOperation, args.length)
      if (ast.distinctness === 'Distinct') unsupported('DISTINCT window function')
      if (filter !== undefined && aggregateOperation === undefined) {
        unsupported(`FILTER on built-in window function ${name}`)
      }
      return this.#builder.windowCall(
        operation,
        loweredArgs,
        this.#windowOver(ast.filterOver.overClause, parameters, context),
        filter,
      )
    }
    if (aggregateOperation !== undefined) {
      if (aggregateOperation === 'count' ? args.length > 1 : args.length !== 1) {
        unsupported(`${name} arity`)
      }
      return this.#builder.aggregate(
        aggregateOperation,
        loweredArgs[0],
        ast.distinctness === 'Distinct',
        filter,
        aggregateOrderBy,
      )
    }
    if (filter !== undefined) unsupported(`FILTER on non-aggregate function ${name}`)
    if (ast.distinctness === 'Distinct') unsupported(`DISTINCT on non-aggregate function ${name}`)
    if (sqliteIdentifierEquals(name, 'json_extract') || sqliteIdentifierEquals(name, 'json_type')) {
      const isExtract = sqliteIdentifierEquals(name, 'json_extract')
      if ((isExtract && args.length !== 2) || (!isExtract && args.length !== 1 && args.length !== 2)) {
        unsupported(`${name} arity`)
      }
      const path = args[1] === undefined
        ? undefined
        : jsonPath(args[1]) ?? loweredArgs[1]
      return this.#builder.jsonOperation(
        isExtract ? 'extract' : 'type',
        [loweredArgs[0]!],
        path,
      )
    }
    if (sqliteIdentifierEquals(name, 'json_array')) return this.#builder.jsonOperation('array', loweredArgs)
    if (sqliteIdentifierEquals(name, 'json_object')) return this.#builder.jsonOperation('object', loweredArgs)
    if (sqliteIdentifierEquals(name, 'json_patch')) return this.#builder.jsonOperation('merge', loweredArgs)
    const builtinName = compilerBuiltinByName.get(key)
    if (builtinName !== undefined) return this.#builder.builtin(builtinName, loweredArgs)
    return this.#registeredFunctionByName(name, loweredArgs)
  }

  #starFunction(ast: FunctionCallStarExpr, parameters: ParameterBinder, context: ExpressionContext): Expr {
    if (!sqliteIdentifierEquals(ast.name.name, 'count')) unsupported(`${ast.name.name}(*)`)
    const filter = ast.filterOver?.filterClause === undefined
      ? undefined
      : this.#expression(ast.filterOver.filterClause, parameters, context)
    return ast.filterOver?.overClause === undefined
      ? this.#builder.aggregate('count', undefined, false, filter)
      : this.#builder.windowCall(
        'count',
        [],
        this.#windowOver(ast.filterOver.overClause, parameters, context),
        filter,
      )
  }

  #windowOver(over: Over, parameters: ParameterBinder, context: ExpressionContext): string | WindowSpecification {
    return over.type === 'NameOver'
      ? over.name.text
      : this.#windowSpecification(over.window, parameters, context)
  }

  #windowSpecification(
    window: SqlWindow,
    parameters: ParameterBinder,
    context: ExpressionContext,
  ): WindowSpecification {
    return {
      ...(window.base === undefined ? {} : { base: window.base.text }),
      partitionBy: (window.partitionBy ?? []).map((expression) =>
        this.#expression(expression, parameters, context)),
      orderBy: (window.orderBy ?? []).map((term) => {
        const direction = term.order === 'Desc' ? 'desc' : 'asc'
        return this.#builder.order(
          this.#expression(term.expr, parameters, context),
          direction,
          term.nulls === 'First' ? 'first' : term.nulls === 'Last' ? 'last' : direction === 'asc' ? 'first' : 'last',
        )
      }),
      ...(window.frameClause === undefined
        ? {}
        : {
          frame: {
            mode: window.frameClause.mode.toLowerCase() as WindowFrame['mode'],
            start: this.#windowBound(window.frameClause.start, parameters, context),
            ...(window.frameClause.end === undefined
              ? {}
              : { end: this.#windowBound(window.frameClause.end, parameters, context) }),
            ...(window.frameClause.exclude === undefined
              ? {}
              : { exclude: window.frameClause.exclude.replace(/([a-z])([A-Z])/gu, '$1_$2').toLowerCase() as NonNullable<WindowFrame['exclude']> }),
          },
        }),
    }
  }

  #windowBound(
    bound: SqlFrameBound,
    parameters: ParameterBinder,
    context: ExpressionContext,
  ): WindowFrameBound {
    switch (bound.type) {
      case 'CurrentRowFrameBound': return { type: 'current_row' }
      case 'UnboundedPrecedingFrameBound': return { type: 'unbounded_preceding' }
      case 'UnboundedFollowingFrameBound': return { type: 'unbounded_following' }
      case 'PrecedingFrameBound':
        return { type: 'preceding', offset: this.#expression(bound.expr, parameters, context) }
      case 'FollowingFrameBound':
        return { type: 'following', offset: this.#expression(bound.expr, parameters, context) }
    }
  }

  #registeredFunctionByName(name: string, args: readonly Expr[]): Expr {
    const matches = this.#manifest.functions.filter((fn) => sqliteIdentifierEquals(fn.name, name))
    if (matches.length !== 1 || matches[0]!.effect !== 'pure') {
      unsupported(`unregistered or non-pure function ${name}`)
    }
    return this.#builder.functionCall(matches[0]!.id, args)
  }

  #collation(name: string): CollationId {
    if (sqliteIdentifierEquals(name, 'binary')) return 'binary'
    if (sqliteIdentifierEquals(name, 'nocase')) return 'nocase'
    if (sqliteIdentifierEquals(name, 'rtrim')) return 'rtrim'
    if (sqliteIdentifierEquals(name, 'unicode_codepoint')) return 'unicode_codepoint'
    const matches = this.#manifest.collations.filter((collation) =>
      sqliteIdentifierEquals(collation.name, name))
    if (matches.length !== 1) unsupported(`unknown or ambiguous COLLATE ${name}`)
    return `registered:${matches[0]!.id}`
  }

  #insert(
    statement: InsertStmt,
    parameters: ParameterBinder,
    expectation: AffectedRowsExpectation,
    label?: string,
  ): Mutation {
    if (statement.returning !== undefined) unsupported('INSERT RETURNING')
    const target = this.#mutationTable(statement.tblName)
    const withClause = this.#with(statement.with, parameters, emptyQueryContext())
    const columns = statement.columns === undefined
      ? target.table.columns.filter((column) => column.generated === undefined).map((column) => column.name)
      : statement.columns.map((column) => column.text)
    const conflict = conflictPolicy(statement.orConflict)
    const upsertClauses = statement.body.type === 'SelectInsertBody'
      ? this.#upsertClauses(statement.body.upsert, target, parameters, withClause.bindings)
      : []
    const common = {
      affectedRows: expectation,
      conflict,
      ctes: withClause.ctes,
      ...(withClause.recursive ? { recursive: true } : {}),
      ...(upsertClauses.length === 0 ? {} : { upsertClauses }),
      ...(sqliteIdentifierEquals(target.alias, target.table.name) ? {} : { alias: target.alias }),
      ...(label === undefined ? {} : { label }),
    }
    if (statement.body.type === 'DefaultValuesInsertBody') {
      if (statement.columns !== undefined) unsupported('INSERT DEFAULT VALUES with a column list')
      return this.#builder.insertDefault(target.table.name, common)
    }
    const source = statement.body.select
    if (source.with === undefined && source.compounds === undefined && source.orderBy === undefined && source.limit === undefined && source.select.type === 'SelectValues') {
      const expressionContext: ExpressionContext = {
        ctes: withClause.bindings,
        outerRelations: [],
        outerOutputs: [[]],
      }
      const rows = source.select.values.map((row) => row.values.map((value) =>
        this.#expression(value, parameters, expressionContext)))
      return this.#builder.insert(target.table.name, columns, rows, common)
    }
    return this.#builder.insertSelect(
      target.table.name,
      columns,
      this.#query(source, parameters, {
        ctes: withClause.bindings,
        outerRelations: [],
        outerOutputs: [],
      }, { kind: 'multiset' }).query,
      common,
    )
  }

  #update(
    statement: UpdateStmt,
    parameters: ParameterBinder,
    expectation: AffectedRowsExpectation,
    label?: string,
  ): Mutation {
    if (statement.returning !== undefined) unsupported('UPDATE RETURNING')
    if (statement.orderBy !== undefined || statement.limit !== undefined) unsupported('UPDATE ORDER BY / LIMIT')
    if (statement.indexed !== undefined) unsupported('UPDATE INDEXED BY / NOT INDEXED')
    const target = this.#mutationTable(statement.tblName)
    const withClause = this.#with(statement.with, parameters, emptyQueryContext())
    const relation: RelationBinding = {
      relation: this.#builder.table(target.table.name, target.alias),
      alias: target.alias,
      columns: target.table.columns.map((column) => column.name),
      table: target.table,
    }
    const source = statement.from === undefined
      ? undefined
      : this.#updateSource(statement.from, target, parameters, withClause.bindings)
    const context: ExpressionContext = {
      ctes: withClause.bindings,
      outerRelations: [relation],
      outerOutputs: [[
        ...physicalOutput(relation, this.#builder),
        ...(source?.outputColumns ?? []),
      ]],
      ...(source === undefined ? {} : { qualifiedColumns: source.qualifiedColumns }),
    }
    const assignments = this.#assignments(statement.sets, parameters, context)
    return this.#builder.update(target.table.name, assignments, {
      affectedRows: expectation,
      conflict: conflictPolicy(statement.orConflict),
      ctes: withClause.ctes,
      ...(withClause.recursive ? { recursive: true } : {}),
      ...(source === undefined ? {} : { from: source.query, fromAlias: source.alias }),
      ...(statement.whereClause === undefined
        ? {}
        : { where: this.#expression(statement.whereClause, parameters, context) }),
      ...(sqliteIdentifierEquals(target.alias, target.table.name) ? {} : { alias: target.alias }),
      ...(label === undefined ? {} : { label }),
    })
  }

  #delete(
    statement: DeleteStmt,
    parameters: ParameterBinder,
    expectation: AffectedRowsExpectation,
    label?: string,
  ): Mutation {
    if (statement.returning !== undefined) unsupported('DELETE RETURNING')
    if (statement.orderBy !== undefined || statement.limit !== undefined) unsupported('DELETE ORDER BY / LIMIT')
    if (statement.indexed !== undefined) unsupported('DELETE INDEXED BY / NOT INDEXED')
    const target = this.#mutationTable(statement.tblName)
    const withClause = this.#with(statement.with, parameters, emptyQueryContext())
    const relation: RelationBinding = {
      relation: this.#builder.table(target.table.name, target.alias),
      alias: target.alias,
      columns: target.table.columns.map((column) => column.name),
      table: target.table,
    }
    const context: ExpressionContext = {
      ctes: withClause.bindings,
      outerRelations: [relation],
      outerOutputs: [physicalOutput(relation, this.#builder)],
    }
    return this.#builder.delete(target.table.name, {
      affectedRows: expectation,
      ctes: withClause.ctes,
      ...(withClause.recursive ? { recursive: true } : {}),
      ...(statement.whereClause === undefined
        ? {}
        : { where: this.#expression(statement.whereClause, parameters, context) }),
      ...(sqliteIdentifierEquals(target.alias, target.table.name) ? {} : { alias: target.alias }),
      ...(label === undefined ? {} : { label }),
    })
  }

  #upsertClauses(
    first: Upsert | undefined,
    target: MutationTableBinding,
    parameters: ParameterBinder,
    ctes: ReadonlyMap<string, Query>,
  ): ReturnType<IrBuilder['upsertDoNothing']>[] {
    const relation: RelationBinding = {
      relation: this.#builder.table(target.table.name, target.alias),
      alias: target.alias,
      columns: target.table.columns.map((column) => column.name),
      table: target.table,
    }
    const context: ExpressionContext = {
      ctes,
      outerRelations: [relation],
      outerOutputs: [physicalOutput(relation, this.#builder)],
      excludedIsNew: true,
    }
    const clauses: ReturnType<IrBuilder['upsertDoNothing']>[] = []
    let current = first
    while (current !== undefined) {
      const conflictTarget = current.index === undefined
        ? undefined
        : this.#upsertConflictTarget(current.index.targets, current.index.whereClause, target, parameters, context)
      if (current.doClause.type === 'NothingUpsertDo') {
        clauses.push(this.#builder.upsertDoNothing(conflictTarget))
      } else {
        const assignments = this.#assignments(current.doClause.sets, parameters, context)
        const where = current.doClause.whereClause === undefined
          ? undefined
          : this.#expression(current.doClause.whereClause, parameters, context)
        clauses.push(this.#builder.upsertDoUpdate(assignments, conflictTarget, where))
      }
      current = current.next
    }
    return clauses
  }

  #upsertConflictTarget(
    targets: readonly SortedColumn[],
    whereClause: SqlExpr | undefined,
    target: MutationTableBinding,
    parameters: ParameterBinder,
    context: ExpressionContext,
  ): UpsertConflictTarget {
    const expressions = targets.map((term) => this.#expression(term.expr, parameters, context))
    const where = whereClause === undefined
      ? undefined
      : this.#expression(whereClause, parameters, context)
    const aliases = new Set([
      sqliteIdentifierKey(target.table.name),
      sqliteIdentifierKey(target.alias),
    ])

    if (where === undefined) {
      const columnIds = expressions.map((expression) =>
        upsertConstraintColumnId(expression, target.table, aliases))
      if (columnIds.every((id): id is number => id !== undefined)) {
        const constraint = target.table.constraints.find((candidate) =>
          (candidate.kind === 'primary_key' || candidate.kind === 'unique') &&
          sameNumberList(candidate.columnIds, columnIds))
        if (constraint !== undefined) return this.#builder.upsertConstraintTarget(constraint.id)
      }
    }

    const indexes = this.#schema.objects
      .filter((object): object is SchemaIndex =>
        object.kind === 'index' && object.tableId === target.table.id && object.unique)
      .filter((index) =>
        index.expressions.length === expressions.length &&
        index.expressions.every((expression, indexPosition) =>
          sameSchemaExpression(expression, expressions[indexPosition]!, aliases)) &&
        ((index.where === undefined && where === undefined) ||
          (index.where !== undefined && where !== undefined &&
            sameSchemaExpression(index.where, where, aliases))))
      .sort((left, right) => left.declarationOrder - right.declarationOrder || left.id - right.id)
    if (indexes[0] !== undefined) return this.#builder.upsertIndexTarget(indexes[0].id)
    unsupported('UPSERT conflict target that does not match a manifest UNIQUE constraint or index')
  }

  #assignments(
    sets: readonly SetAssignment[],
    parameters: ParameterBinder,
    context: ExpressionContext,
  ): Assignment[] {
    return sets.flatMap((assignment, assignmentIndex): readonly Assignment[] => {
      const names = assignment.colNames.map((column) => column.text)
      if (names.length === 1) {
        return [this.#builder.assignment(
          names[0]!,
          this.#expression(assignment.expr, parameters, context),
        )]
      }
      if (assignment.expr.type === 'ParenthesizedExpr') {
        const expressions = assignment.expr.exprs
        if (expressions.length !== names.length) {
          unsupported(`row-value UPDATE assignment of width ${expressions.length} to ${names.length} columns`)
        }
        return names.map((name, index) => this.#builder.assignment(
          name,
          this.#expression(expressions[index]!, parameters, context),
        ))
      }
      if (assignment.expr.type === 'SubqueryExpr') {
        const select = assignment.expr.select
        return names.map((name, columnIndex) => {
          const source = this.#query(
            select,
            parameters,
            context,
            { kind: 'multiset' },
          ).query
          if (source.projection.length !== names.length) {
            unsupported(`row-value UPDATE subquery of width ${source.projection.length} to ${names.length} columns`)
          }
          const projectionNames = source.projection.map((_, index) =>
            `__chronolog_row_column_${index + 1}`)
          const renamedSource: Query = {
            ...source,
            // A SQLite row-valued scalar subquery chooses one tuple, then
            // assigns every component from that same tuple. Each scalar IR
            // projection therefore embeds the same one-row tuple source:
            // authored ORDER BY terms remain leading and ordered-mode
            // compilation completes ties with the full projected tuple.
            resultMode: { kind: 'ordered' },
            page: {
              limit: source.page?.limit === 0 ? 0 : 1,
              ...(source.page?.offset === undefined ? {} : { offset: source.page.offset }),
            },
            projection: source.projection.map((projection, index) => ({
              ...projection,
              name: projectionNames[index]!,
            })),
          }
          const alias = `__chronolog_row_assignment_${assignmentIndex + 1}_${columnIndex + 1}`
          const scalar = this.#builder.query([
            this.#builder.projection(
              projectionNames[columnIndex]!,
              this.#builder.column(projectionNames[columnIndex]!, alias),
            ),
          ], {
            from: this.#builder.subquery(renamedSource, alias),
            resultMode: { kind: 'scalar' },
          })
          return this.#builder.assignment(name, this.#builder.scalarSubquery(scalar))
        })
      }
      unsupported(`row-value UPDATE assignment from ${assignment.expr.type}`)
    })
  }

  #updateSource(
    clause: FromClause,
    target: MutationTableBinding,
    parameters: ParameterBinder,
    ctes: ReadonlyMap<string, Query>,
  ): LoweredUpdateSource {
    const queryContext: QueryContext = { ctes, outerRelations: [], outerOutputs: [] }
    const from = this.#from(clause, ctes, parameters, queryContext)
    if (from.relations.length === 0) unsupported('UPDATE FROM without a source relation')
    let alias = '__chronolog_update_from'
    while (sqliteIdentifierEquals(alias, target.alias)) alias = `_${alias}`

    const projections: Projection[] = []
    const outputColumns: OutputColumnBinding[] = []
    for (const [index, output] of from.outputColumns.entries()) {
      const name = `__chronolog_unqualified_${index + 1}`
      projections.push(this.#builder.projection(name, output.expression()))
      outputColumns.push({
        name: output.name,
        expression: () => this.#builder.column(name, alias),
      })
    }

    const qualifiedColumns = new Map<string, QualifiedColumnBinding>()
    for (const [relationIndex, relation] of from.relations.entries()) {
      for (const [starIndex, star] of qualifiedColumnsForRelation(relation, this.#builder).entries()) {
        for (const [columnIndex, column] of star.columns.entries()) {
          const name = `__chronolog_qualified_${relationIndex + 1}_${starIndex + 1}_${columnIndex + 1}`
          projections.push(this.#builder.projection(name, column.expression()))
          const key = qualifiedColumnKey(star.qualifier, column.name)
          qualifiedColumns.set(key, qualifiedColumns.has(key)
            ? { name, relation: alias, ambiguous: true }
            : { name, relation: alias })
        }
      }
    }
    const query = this.#builder.query(projections, {
      from: from.relations[0]!.relation,
      joins: from.joins,
      resultMode: { kind: 'multiset' },
    })
    return { query, alias, outputColumns, qualifiedColumns }
  }

  #mutationTable(qualified: QualifiedName): MutationTableBinding {
    requireMainDatabase(qualified)
    const name = qualified.objName.text
    const table = this.#tables.get(sqliteIdentifierKey(name))
    if (table === undefined) {
      throw new SqlFrontendError('SQL_SCHEMA_OBJECT_NOT_FOUND', `Table ${name} is not in the schema manifest`, name)
    }
    return { table, alias: qualified.alias?.text ?? table.name }
  }
}

class ParameterBinder {
  readonly #sql: string
  readonly #parameters: SqlParameters
  readonly #slotsByOffset = new Map<number, { readonly name: string; readonly slot: number }>()
  readonly #sqlNamesByBareName = new Map<string, Set<string>>()
  readonly #usedNames = new Set<string>()
  readonly #usedPositions = new Set<number>()

  public constructor(sql: string, parameters: SqlParameters | undefined, statement: Stmt) {
    this.#sql = sql
    this.#parameters = parameters ?? []
    const variables: VariableExpr[] = []
    traverse(statement, {
      nodes: {
        VariableExpr: (node) => { variables.push(node) },
      },
    })
    variables.sort((left, right) => left.span.offset - right.span.offset)
    let maximumSlot = 0
    const namedSlots = new Map<string, number>()
    for (const variable of variables) {
      let slot: number
      if (variable.name === '?') {
        slot = maximumSlot + 1
      } else if (variable.name.startsWith('?')) {
        const digits = variable.name.slice(1)
        slot = Number(digits)
        if (!/^\d+$/u.test(digits) || !Number.isSafeInteger(slot) || slot < 1 || slot > maximumSqliteParameter) {
          throw new SqlFrontendError(
            'SQL_PARAMETER_VALUE_INVALID',
            `Numbered SQLite parameter ${variable.name} must be between ?1 and ?${maximumSqliteParameter}`,
          )
        }
      } else {
        const existing = namedSlots.get(variable.name)
        slot = existing ?? maximumSlot + 1
        namedSlots.set(variable.name, slot)
        const bare = variable.name.slice(1)
        const sqlNames = this.#sqlNamesByBareName.get(bare) ?? new Set<string>()
        sqlNames.add(variable.name)
        this.#sqlNamesByBareName.set(bare, sqlNames)
      }
      maximumSlot = Math.max(maximumSlot, slot)
      if (maximumSlot > maximumSqliteParameter) {
        throw new SqlFrontendError(
          'SQL_PARAMETER_VALUE_INVALID',
          `SQLite statements may use at most ${maximumSqliteParameter} parameter slots`,
        )
      }
      this.#slotsByOffset.set(variable.span.offset, { name: variable.name, slot })
    }
  }

  public value(variable: VariableExpr): LogicalValue {
    const binding = this.#slotsByOffset.get(variable.span.offset)
    if (binding === undefined) {
      throw new SqlFrontendError('SQL_AST_UNSUPPORTED', 'SQLite parameter is missing its lexical slot')
    }
    if (binding.name.startsWith('?')) return this.#positional(binding.slot)
    return this.#named(binding.name)
  }

  public slot(variable: VariableExpr): number {
    const binding = this.#slotsByOffset.get(variable.span.offset)
    if (binding === undefined) {
      throw new SqlFrontendError('SQL_AST_UNSUPPORTED', 'SQLite parameter is missing its lexical slot')
    }
    return binding.slot
  }

  public sourceText(expression: SqlExpr): string {
    return this.#sql.slice(expression.span.offset, expression.span.offset + expression.span.length)
  }

  #positional(position: number): LogicalValue {
    if (!isPositionalParameters(this.#parameters)) {
      throw new SqlFrontendError('SQL_PARAMETER_MODE_MISMATCH', 'Positional ? requires an array of parameters')
    }
    const value = this.#parameters[position - 1]
    if (value === undefined) {
      throw new SqlFrontendError('SQL_PARAMETER_MISSING', `Missing positional parameter ${position}`)
    }
    this.#usedPositions.add(position)
    return logicalValue(value)
  }

  #named(sqlName: string): LogicalValue {
    if (isPositionalParameters(this.#parameters)) {
      throw new SqlFrontendError('SQL_PARAMETER_MODE_MISMATCH', `Named parameter ${sqlName} requires an object`)
    }
    const name = sqlName.slice(1)
    const exact = Object.prototype.hasOwnProperty.call(this.#parameters, sqlName)
    const bare = Object.prototype.hasOwnProperty.call(this.#parameters, name)
    if (!exact && bare && (this.#sqlNamesByBareName.get(name)?.size ?? 0) > 1) {
      throw new SqlFrontendError(
        'SQL_PARAMETER_MODE_MISMATCH',
        `Bare named parameter ${name} is ambiguous; bind exact keys such as ${[...(this.#sqlNamesByBareName.get(name) ?? [])].join(', ')}`,
        name,
      )
    }
    const objectKey = exact ? sqlName : name
    if (!Object.prototype.hasOwnProperty.call(this.#parameters, objectKey)) {
      throw new SqlFrontendError('SQL_PARAMETER_MISSING', `Missing named parameter ${name}`, name)
    }
    this.#usedNames.add(objectKey)
    return logicalValue(this.#parameters[objectKey]!)
  }

  public finish(): void {
    if (isPositionalParameters(this.#parameters)) {
      const highestReferenced = this.#usedPositions.size === 0 ? 0 : Math.max(...this.#usedPositions)
      if (this.#parameters.length > highestReferenced) {
        throw new SqlFrontendError(
          'SQL_PARAMETER_UNUSED',
          `Received ${this.#parameters.length - highestReferenced} trailing positional parameter(s)`,
        )
      }
      return
    }
    const unused = Object.keys(this.#parameters).filter((name) => !this.#usedNames.has(name))
    if (unused.length > 0) {
      throw new SqlFrontendError('SQL_PARAMETER_UNUSED', `Unused named parameter(s): ${unused.join(', ')}`)
    }
  }
}

function parseOne(sql: string): Stmt {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    throw new SqlFrontendError('SQL_PARSE_ERROR', 'SQL must be a non-empty string')
  }
  const result = parse(sql)
  if (result.status === 'error') {
    const rlike = result.errors.find((error) => error.token?.text.toUpperCase() === 'RLIKE')
    if (rlike !== undefined) unsupported('RLIKE')
    throw new SqlFrontendError(
      'SQL_PARSE_ERROR',
      `SQLite SQL parse failed: ${result.errors.map((error) => error.format()).join('\n')}`,
    )
  }
  if (result.root.cmds.length !== 1) {
    throw new SqlFrontendError('SQL_MULTIPLE_STATEMENTS', 'Exactly one SQL statement is allowed')
  }
  return result.root.cmds[0]!
}

function emptyQueryContext(): QueryContext {
  return { ctes: new Map(), outerRelations: [], outerOutputs: [] }
}

function physicalOutput(relation: RelationBinding, builder: IrBuilder): OutputColumnBinding[] {
  if (relation.outputColumns !== undefined) return [...relation.outputColumns]
  return relation.columns.map((name) => ({
    name,
    expression: () => builder.column(name, relation.alias),
    target: { name, relation: relation.alias },
  }))
}

function qualifiedStarsForRelation(
  relation: RelationBinding,
  builder: IrBuilder,
): readonly QualifiedStarBinding[] {
  return relation.qualifiedStars ?? [{
    qualifier: relation.alias,
    columns: physicalOutput(relation, builder),
  }]
}

function qualifiedColumnsForRelation(
  relation: RelationBinding,
  builder: IrBuilder,
): readonly QualifiedStarBinding[] {
  return relation.qualifiedColumns ?? qualifiedStarsForRelation(relation, builder)
}

function qualifiedColumnsForRelations(
  outer: ReadonlyMap<string, QualifiedColumnBinding> | undefined,
  relations: readonly RelationBinding[],
  builder: IrBuilder,
): ReadonlyMap<string, QualifiedColumnBinding> {
  const result = new Map(outer)
  const localKeys = new Set<string>()
  for (const relation of relations) {
    for (const star of qualifiedColumnsForRelation(relation, builder)) {
      for (const column of star.columns) {
        const key = qualifiedColumnKey(star.qualifier, column.name)
        if (localKeys.has(key) || column.target === undefined) {
          result.set(key, { name: column.name, relation: relation.alias, ambiguous: true })
        } else {
          result.set(key, column.target)
        }
        localKeys.add(key)
      }
    }
  }
  return result
}

function sqliteRelationBoundaryQuery(query: Query): Query {
  const names = sqliteRelationColumnNames(query.projection.map((projection) => projection.name))
  return {
    ...query,
    projection: query.projection.map((projection, index) => ({
      ...projection,
      name: names[index]!,
    })),
  }
}

function sqliteRelationColumnNames(rawNames: readonly string[]): string[] {
  const used = new Set<string>()
  return rawNames.map((rawName) => {
    let name = rawName
    if (used.has(sqliteIdentifierKey(name))) {
      const base = rawName.replace(/:\d+$/u, '')
      let suffix = 1
      do {
        name = `${base}:${suffix}`
        suffix += 1
      } while (used.has(sqliteIdentifierKey(name)))
    }
    used.add(sqliteIdentifierKey(name))
    return name
  })
}

function qualifiedColumnKey(relation: string, column: string): string {
  return `${sqliteIdentifierKey(relation)}\u0000${sqliteIdentifierKey(column)}`
}

function sameNumberList(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function upsertConstraintColumnId(
  expression: Expr,
  table: SchemaTable,
  targetAliases: ReadonlySet<string>,
): number | undefined {
  const columnExpression = expression.kind === 'collate' ? expression.expression : expression
  if (columnExpression.kind !== 'column') return undefined
  if (columnExpression.relation !== undefined &&
      !targetAliases.has(sqliteIdentifierKey(columnExpression.relation))) return undefined
  const column = table.columns.find((candidate) =>
    sqliteIdentifierEquals(candidate.name, columnExpression.name))
  if (column === undefined) return undefined
  if (expression.kind !== 'collate') return column.id
  return column.valueType.logical.kind === 'text' &&
      column.valueType.logical.collation === expression.collation
    ? column.id
    : undefined
}

function sameSchemaExpression(
  left: Expr,
  right: Expr,
  targetAliases: ReadonlySet<string>,
): boolean {
  return comparableExpression(left, targetAliases) === comparableExpression(right, targetAliases)
}

function comparableExpression(value: unknown, targetAliases: ReadonlySet<string>): string {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (typeof value === 'bigint') return `bigint:${value.toString(10)}`
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return JSON.stringify(value)
  }
  if (value instanceof Uint8Array) {
    return `bytes:${Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join('')}`
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => comparableExpression(item, targetAliases)).join(',')}]`
  }
  if (value instanceof Map) {
    return comparableExpression(
      [...value.entries()].sort(([leftKey], [rightKey]) => String(leftKey).localeCompare(String(rightKey))),
      targetAliases,
    )
  }
  if (typeof value === 'symbol') return `symbol:${value.description ?? ''}`
  if (typeof value !== 'object') return `unsupported:${typeof value}`
  const object = value as Readonly<Record<string, unknown>>
  if (object.kind === 'column') {
    const rawRelation = typeof object.relation === 'string'
      ? sqliteIdentifierKey(object.relation)
      : undefined
    const relation = rawRelation === undefined || targetAliases.has(rawRelation)
      ? '@target'
      : rawRelation
    return `column:${relation}:${sqliteIdentifierKey(String(object.name))}`
  }
  const keys = Object.keys(object).filter((key) => key !== 'id').sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${comparableExpression(object[key], targetAliases)}`).join(',')}}`
}

function naturalColumns(
  left: readonly OutputColumnBinding[],
  rightColumns: readonly string[],
): readonly string[] {
  return left
    .filter((column, index) => left.findIndex((candidate) => sqliteIdentifierEquals(candidate.name, column.name)) === index)
    .filter((column) => rightColumns.some((name) => sqliteIdentifierEquals(name, column.name)))
    .map((column) => column.name)
}

function validateUsingColumns(
  using: readonly string[],
  left: readonly OutputColumnBinding[],
  right: RelationBinding,
  kind: Join['kind'],
): void {
  const seen = new Set<string>()
  for (const name of using) {
    const key = sqliteIdentifierKey(name)
    if (seen.has(key)) unsupported(`duplicate JOIN USING column ${name}`)
    seen.add(key)
    const leftMatches = left.filter((column) => sqliteIdentifierEquals(column.name, name))
    const rightMatches = right.columns.filter((column) => sqliteIdentifierEquals(column, name))
    if (leftMatches.length === 0 || rightMatches.length !== 1) {
      unsupported(`JOIN USING column ${name} must exist on each side`)
    }
    if (leftMatches.length > 1 && (kind === 'right' || kind === 'full')) {
      unsupported(`ambiguous reference to ${name} in ${kind.toUpperCase()} JOIN USING`)
    }
  }
}

function joinOutput(
  left: readonly OutputColumnBinding[],
  right: RelationBinding,
  using: readonly string[],
  kind: Join['kind'],
  builder: IrBuilder,
): OutputColumnBinding[] {
  const rightColumns = physicalOutput(right, builder)
  if (using.length === 0) return [...left, ...rightColumns]
  const output = left.map((column): OutputColumnBinding => {
    const usingName = using.find((name) => sqliteIdentifierEquals(name, column.name))
    if (usingName === undefined) return column
    const rightColumn = rightColumns.find((candidate) => sqliteIdentifierEquals(candidate.name, usingName))!
    if (kind === 'right') return { name: column.name, expression: rightColumn.expression }
    if (kind === 'full') {
      return {
        name: column.name,
        expression: () => builder.builtin('coalesce', [column.expression(), rightColumn.expression()]),
      }
    }
    return column
  })
  output.push(...rightColumns.filter((column) =>
    !using.some((name) => sqliteIdentifierEquals(name, column.name))))
  return output
}

function selectReferencesTable(select: Select, name: string): boolean {
  const key = sqliteIdentifierKey(name)
  return selectCteDependencies(select, [key]).has(key)
}

function selectCteDependencies(
  select: Select,
  availableNames: Iterable<string>,
): ReadonlySet<string> {
  const available = new Set(availableNames)
  const dependencies = new Set<string>()
  const shadowed: Set<string>[] = []
  traverse(select, {
    enter: (node) => {
      if (node.type === 'Select') {
        shadowed.push(new Set((node.with?.ctes ?? []).map((cte) =>
          sqliteIdentifierKey(cte.tblName.text))))
      }
    },
    leave: (node) => {
      if (node.type === 'Select') shadowed.pop()
    },
    nodes: {
      InTableExpr: (node) => {
        if (node.rhs.dbName !== undefined || node.args !== undefined) return
        const key = sqliteIdentifierKey(node.rhs.objName.text)
        if (available.has(key) && !shadowed.some((scope) => scope.has(key))) dependencies.add(key)
      },
      TableSelectTable: (node) => {
        if (node.tblName.dbName !== undefined) return
        const key = sqliteIdentifierKey(node.tblName.objName.text)
        if (available.has(key) && !shadowed.some((scope) => scope.has(key))) dependencies.add(key)
      },
    },
  })
  return dependencies
}

function aliasName(alias: As | undefined): string | undefined {
  return alias?.name.text
}

function requireMainDatabase(name: QualifiedName): void {
  if (name.dbName !== undefined && !sqliteIdentifierEquals(name.dbName.text, 'main')) {
    unsupported(`qualified database ${name.dbName.text}`)
  }
}

function projectionOrdinalIndex(
  expression: SqlExpr,
  projectionCount: number,
  clause: 'ORDER BY' | 'GROUP BY',
): number | undefined {
  const ordinal = sqliteOrdinal(expression)
  if (ordinal !== undefined) {
    if (ordinal < 1n || ordinal > BigInt(projectionCount)) {
      unsupported(`${clause} ordinal ${ordinal.toString(10)} outside 1..${projectionCount}`)
    }
    return Number(ordinal - 1n)
  }
  return undefined
}

function sqliteOrdinal(expression: SqlExpr): bigint | undefined {
  if (expression.type === 'ParenthesizedExpr' && expression.exprs.length === 1) {
    return sqliteOrdinal(expression.exprs[0]!)
  }
  if (expression.type === 'UnaryExpr' &&
      (expression.op === 'Positive' || expression.op === 'Negative')) {
    const operand = sqliteOrdinal(expression.expr)
    if (operand === undefined) return undefined
    return expression.op === 'Negative' ? -operand : operand
  }
  if (expression.type !== 'NumericLiteral') return undefined
  if (/^\d+$/u.test(expression.value)) return BigInt(expression.value)
  if (/^0x[0-9a-f]+$/iu.test(expression.value)) return sqliteHexInteger(expression.value)
  return undefined
}

function projectionAliasIndex(
  expression: SqlExpr,
  projections: readonly ProjectionBinding[],
): number | undefined {
  if (expression.type !== 'Id') return undefined
  const index = projections.findIndex((binding) =>
    sqliteIdentifierEquals(binding.projection.name, expression.name))
  return index < 0 ? undefined : index
}

function isDirectColumnSyntax(expression: SqlExpr): boolean {
  if (expression.type === 'Id' || expression.type === 'QualifiedExpr') return true
  return expression.type === 'ParenthesizedExpr' && expression.exprs.length === 1
    ? isDirectColumnSyntax(expression.exprs[0]!)
    : false
}

function syntheticColumnAst(name: string): SqlExpr {
  return {
    type: 'Id',
    name,
    span: { offset: 0, length: 0, line: 1, col: 0 },
  }
}

function pageValue(expression: SqlExpr, parameters: ParameterBinder): number {
  const value = expression.type === 'VariableExpr'
    ? parameters.value(expression)
    : expression.type === 'NumericLiteral'
      ? numericValue(expression.value)
      : unsupported('non-integral LIMIT/OFFSET')
  if (value.kind !== 'int64' || value.value < 0n || value.value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new SqlFrontendError(
      'SQL_PARAMETER_VALUE_INVALID',
      'LIMIT/OFFSET must be a canonical nonnegative int64 within the JavaScript safe-integer range',
    )
  }
  return Number(value.value)
}

function jsonPath(expression: SqlExpr): string | undefined {
  return expression.type === 'StringLiteral' ? expression.value : undefined
}

function windowOptions(
  specification: WindowSpecification,
): { readonly base?: string; readonly frame?: WindowFrame } {
  return {
    ...(specification.base === undefined ? {} : { base: specification.base }),
    ...(specification.frame === undefined ? {} : { frame: specification.frame }),
  }
}

function windowOperation(
  name: string,
  aggregate: 'count' | 'min' | 'max' | 'every' | 'any' | undefined,
  arity: number,
): WindowOperation {
  if (aggregate !== undefined) {
    if (aggregate !== 'count' && arity !== 1) unsupported(`${name} window arity`)
    if (aggregate === 'count' && arity > 1) unsupported(`${name} window arity`)
    return aggregate
  }
  const key = sqliteIdentifierKey(name)
  if (key === sqliteIdentifierKey('row_number') || key === sqliteIdentifierKey('rank') ||
      key === sqliteIdentifierKey('dense_rank')) {
    if (arity !== 0) unsupported(`${name} window arity`)
    return key as 'row_number' | 'rank' | 'dense_rank'
  }
  if (key === sqliteIdentifierKey('ntile')) {
    if (arity !== 1) unsupported('ntile window arity')
    return 'ntile'
  }
  if (key === sqliteIdentifierKey('lag') || key === sqliteIdentifierKey('lead')) {
    if (arity < 1 || arity > 3) unsupported(`${name} window arity`)
    return key as 'lag' | 'lead'
  }
  if (key === sqliteIdentifierKey('percent_rank') || key === sqliteIdentifierKey('cume_dist')) {
    unsupported(`${name} requires a canonical floating-point result profile`)
  }
  if (key === sqliteIdentifierKey('first_value') || key === sqliteIdentifierKey('last_value') ||
      key === sqliteIdentifierKey('nth_value')) {
    unsupported(`${name} requires peer-preserving value-window lowering`)
  }
  return unsupported(`window function ${name}`)
}

function numericValue(raw: string): LogicalValue {
  if (/^0x[0-9a-f]+$/iu.test(raw)) return values.int64(sqliteHexInteger(raw))
  if (/^\d+$/u.test(raw)) {
    const value = BigInt(raw)
    if (value > 9_223_372_036_854_775_807n) {
      throw new SqlFrontendError('SQL_PARAMETER_VALUE_INVALID', 'SQL integer literal is outside signed int64')
    }
    return values.int64(value)
  }
  const match = /^(\d+)(?:\.(\d*))?(?:e([+-]?\d+))?$/iu.exec(raw)
  if (match === null) unsupported(`non-exact numeric literal ${raw}`)
  const fraction = match[2] ?? ''
  const exponent = Number(match[3] ?? '0')
  if (!Number.isSafeInteger(exponent)) unsupported(`numeric exponent ${raw}`)
  let coefficient = BigInt(`${match[1]!}${fraction}`)
  let scale = fraction.length - exponent
  if (scale < 0) {
    coefficient *= 10n ** BigInt(-scale)
    scale = 0
  }
  if (scale > 38 || coefficient.toString().length > 38) unsupported(`decimal literal precision ${raw}`)
  return values.decimal(coefficient, scale)
}

function sqliteHexInteger(raw: string): bigint {
  const digits = raw.slice(2)
  if (digits.length > 16) unsupported('hexadecimal integer wider than 64 bits')
  const unsigned = BigInt(`0x${digits}`)
  return unsigned > 9_223_372_036_854_775_807n ? unsigned - 18_446_744_073_709_551_616n : unsigned
}

function conflictPolicy(raw: 'Rollback' | 'Abort' | 'Fail' | 'Ignore' | 'Replace' | undefined): 'error' | 'ignore' | 'replace' {
  return raw === 'Ignore' ? 'ignore' : raw === 'Replace' ? 'replace' : 'error'
}

function cteColumnMismatch(name: string, declared: number, actual: number): never {
  throw new SqlFrontendError(
    'SQL_AST_UNSUPPORTED',
    `CTE ${name} declares ${declared} columns for a ${actual}-column query`,
    'CTE column-name list',
  )
}

function isPositionalParameters(parameters: SqlParameters): parameters is readonly SqlParameterValue[] {
  return Array.isArray(parameters)
}

function logicalValue(value: SqlParameterValue): LogicalValue {
  let result: LogicalValue
  if (value === null) result = values.null()
  else if (typeof value === 'boolean') result = values.boolean(value)
  else if (typeof value === 'bigint') result = values.int64(value)
  else if (typeof value === 'number') result = integerParameterValue(value)
  else if (typeof value === 'string') result = values.text(value)
  else if (value instanceof Uint8Array) result = values.blob(value)
  else if (isLogicalValue(value)) result = value
  else throw new SqlFrontendError('SQL_PARAMETER_VALUE_INVALID', 'Unsupported SQL parameter value')
  const diagnostics = validateLogicalValue(result)
  if (diagnostics.length > 0) {
    throw new SqlFrontendError('SQL_PARAMETER_VALUE_INVALID', diagnostics.map((item) => item.message).join('; '))
  }
  return result
}

function integerParameterValue(value: number): LogicalValue {
  if (!Number.isSafeInteger(value)) {
    throw new SqlFrontendError(
      'SQL_PARAMETER_VALUE_INVALID',
      'SQL parameter must be an exact safe integer; use an explicit decimal LogicalValue for decimals',
    )
  }
  return values.int64(BigInt(value))
}

function isLogicalValue(value: unknown): value is LogicalValue {
  if (typeof value !== 'object' || value === null || !('kind' in value) || typeof value.kind !== 'string') return false
  return ['null', 'boolean', 'int64', 'decimal', 'text', 'blob', 'uuid', 'timestamp_ms', 'duration_ms', 'json', 'vector']
    .includes(value.kind)
}

function unsupported(feature: string): never {
  throw new SqlFrontendError('SQL_FEATURE_UNSUPPORTED', `SQLite SQL feature is not lowered yet: ${feature}`, feature)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function compilerFrontendError(error: unknown, feature: string): SqlFrontendError {
  if (error instanceof CompilerError) {
    return new SqlFrontendError(
      'SQL_FEATURE_UNSUPPORTED',
      `Lowered SQLite SQL is not executable by the selected consensus profile: ${error.code}`,
      error.code,
    )
  }
  return new SqlFrontendError('SQL_IR_INVALID', `Failed to validate lowered ${feature}: ${errorMessage(error)}`)
}
