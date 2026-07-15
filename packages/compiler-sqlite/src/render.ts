import {
  canonicalJsonFromText,
  canonicalJsonToText,
  sqliteIdentifierEquals,
  sqliteIdentifierKey,
} from '@chronolog/ir'
import type {
  ColumnExpr,
  CollationId,
  CompoundTerm,
  Cte,
  Expr,
  LogicalType,
  LogicalValue,
  Query,
  Relation,
  ResultColumn,
  SchemaTable,
  ValueType,
  WindowFrameBound,
  WindowSpecification,
} from '@chronolog/ir'
import { jsonMergePatch, parseCanonicalJson, serializeCanonicalJson } from '@chronolog/kernels'

import type { Catalog } from './catalog.js'
import {
  isDeterministicSqliteBuiltinFunction,
  isDeterministicSqliteScalarFunction,
} from './deterministic-functions.js'
import { CompilerError, type BackendParameter, type BindingSource } from './types.js'

export interface RelationScope {
  readonly alias: string
  readonly table: SchemaTable
  /** True when an outer join can synthesize NULL for every column in this scope. */
  readonly nullExtended?: boolean
  /** Zero is the current query; larger values are progressively outer queries. */
  readonly lexicalDepth?: number
  /** `null` means this derived relation does not expose a proven unique key. */
  readonly primaryKeyColumns?: readonly string[] | null
}

export type CteScopes = ReadonlyMap<string, RelationScope>

export interface RenderedCtes {
  /** Empty when no definitions were supplied; otherwise includes the trailing space. */
  readonly sql: string
  readonly scopes: CteScopes
}

export class SqlRenderer {
  readonly #catalog: Catalog
  readonly #parameters: BackendParameter[] = []
  #aggregatesAllowed = false
  #windowsAllowed = false
  #windows: Query['windows'] = []
  /** Null for source rows; otherwise the expressions identifying grouped rows. */
  #windowGroupTieBreakers: readonly Expr[] | null = null

  constructor(catalog: Catalog) {
    this.#catalog = catalog
  }

  get parameters(): readonly BackendParameter[] {
    return this.#parameters
  }

  expression(
    expression: Expr,
    scopes: readonly RelationScope[],
    mutationTarget?: RelationScope,
    ctes: CteScopes = new Map(),
  ): string {
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
        const expressionId = expression.id
        const value = this.expression(expression.operand, scopes, mutationTarget, ctes)
        switch (expression.operator) {
          case 'not': return `(NOT ${value})`
          case 'negate': return checkedIntegerUnarySql(value, '-')
          case 'is_null': return `(${value} IS NULL)`
          case 'is_not_null': return `(${value} IS NOT NULL)`
          case 'bit_not': return `(~${value})`
          default: throw new CompilerError('IR_UNARY_OPERATOR_UNSUPPORTED', expressionId)
        }
      }
      case 'binary': {
        assertBinaryTypes(expression, scopes, this.#catalog, ctes, mutationTarget)
        const left = this.expression(expression.left, scopes, mutationTarget, ctes)
        const right = this.expression(expression.right, scopes, mutationTarget, ctes)
        if (isCheckedIntegerArithmetic(expression.operator)) {
          return checkedIntegerBinarySql(left, right, expression.operator)
        }
        if (expression.operator === 'bit_xor') {
          return `(((~${left}) & ${right}) | (${left} & (~${right})))`
        }
        if (expression.operator === 'shift_left' || expression.operator === 'shift_right') {
          return checkedIntegerShiftSql(left, right, expression.operator)
        }
        const operator = BINARY_OPERATORS[expression.operator]
        if (operator === undefined) throw new CompilerError('IR_BINARY_OPERATOR_UNSUPPORTED', expression.id)
        const escape = expression.escape === undefined
          ? ''
          : ` ESCAPE ${this.expression(expression.escape, scopes, mutationTarget, ctes)}`
        return `(${left} ${operator} ${right}${escape})`
      }
      case 'conditional': {
        const branches = expression.branches.map((branch) =>
          `WHEN ${this.expression(branch.when, scopes, mutationTarget, ctes)} THEN ${this.expression(branch.then, scopes, mutationTarget, ctes)}`,
        ).join(' ')
        return `(CASE ${branches} ELSE ${this.expression(expression.otherwise, scopes, mutationTarget, ctes)} END)`
      }
      case 'exists': return `(${expression.negated ? 'NOT ' : ''}EXISTS (${this.query(expression.query, scopes, ctes).sql}))`
      case 'membership': {
        if ((expression.values === undefined) === (expression.query === undefined)) {
          throw new CompilerError('IR_MEMBERSHIP_SOURCE_REQUIRED', expression.id)
        }
        const value = this.expression(expression.value, scopes, mutationTarget, ctes)
        if (expression.values !== undefined) {
          if (expression.values.length === 0) return expression.negated ? '(1 = 1)' : '(1 = 0)'
          assertMembershipValues(expression, scopes, this.#catalog, ctes, mutationTarget)
          const values = expression.values.map((item) => this.expression(item, scopes, mutationTarget, ctes)).join(', ')
          return `(${value} ${expression.negated ? 'NOT ' : ''}IN (${values}))`
        }
        if (expression.query !== undefined) {
          const rendered = this.query(expression.query, scopes, ctes)
          assertMembershipQuery(expression, rendered.columns, scopes, this.#catalog, ctes, mutationTarget)
          return `(${value} ${expression.negated ? 'NOT ' : ''}IN (${rendered.sql}))`
        }
        throw new CompilerError('IR_MEMBERSHIP_SOURCE_REQUIRED', expression.id)
      }
      case 'row': {
        if (expression.items.length < 2) throw new CompilerError('IR_ROW_VALUE_WIDTH', expression.id)
        return `(${expression.items.map((item) => this.expression(item, scopes, mutationTarget, ctes)).join(', ')})`
      }
      case 'scalar_subquery': {
        const rendered = this.query(deterministicScalarSubquery(expression.query), scopes, ctes)
        if (rendered.columns.length !== 1) throw new CompilerError('IR_SCALAR_SUBQUERY_WIDTH', expression.id)
        return `(${rendered.sql})`
      }
      case 'parameter': throw new CompilerError('IR_UNBOUND_PARAMETER', expression.id)
      case 'cast': return this.#cast(expression, scopes, mutationTarget, ctes)
      case 'collate': {
        inferExpressionType(expression, scopes, this.#catalog, ctes, mutationTarget)
        return `(${this.expression(expression.expression, scopes, mutationTarget, ctes)} COLLATE ${collationSql(expression.collation, this.#catalog)})`
      }
      case 'builtin': return this.#builtin(expression, scopes, mutationTarget, ctes)
      case 'function': return this.#function(expression, scopes, mutationTarget, ctes)
      case 'aggregate': return this.#aggregate(expression, scopes, mutationTarget, ctes)
      case 'json': return this.#json(expression, scopes, mutationTarget, ctes)
      case 'window':
        if (!this.#windowsAllowed) throw new CompilerError('IR_WINDOW_CONTEXT_INVALID', expression.id)
        return this.#window(expression, scopes, mutationTarget, ctes)
    }
  }

  query(
    query: Query,
    outerScopes: readonly RelationScope[] = [],
    inheritedCtes: CteScopes = new Map(),
    directCompoundArms = false,
  ): { readonly sql: string; readonly columns: readonly ResultColumn[]; readonly scopes: readonly RelationScope[] } {
    const previousWindows = this.#windows
    const previousWindowGroupTieBreakers = this.#windowGroupTieBreakers
    this.#windows = query.windows
    this.#windowGroupTieBreakers = query.groupBy.length > 0 || queryHasAggregate(query)
      ? query.groupBy
      : null
    try {
      return this.#query(query, outerScopes, inheritedCtes, directCompoundArms)
    } finally {
      this.#windows = previousWindows
      this.#windowGroupTieBreakers = previousWindowGroupTieBreakers
    }
  }

  /**
   * Render a WITH clause for either a query or a mutation. Keeping this on the
   * renderer preserves lexical parameter order and uses query() for every CTE,
   * which also preserves the per-query named-window stack.
   */
  ctes(
    definitions: readonly Cte[],
    recursive = false,
    inheritedCtes: CteScopes = new Map(),
    outerScopes: readonly RelationScope[] = [],
  ): RenderedCtes {
    if (recursive && definitions.length === 0) {
      throw new CompilerError('IR_RECURSIVE_CTE_REQUIRED')
    }
    const scopes = new Map(inheritedCtes)
    const definitionsSql: string[] = []
    const localNames = new Set<string>()
    for (const cte of definitions) {
      const cteKey = sqliteIdentifierKey(cte.name)
      if (localNames.has(cteKey)) throw new CompilerError('IR_DUPLICATE_CTE', cte.id)
      localNames.add(cteKey)
      const selfRecursive = recursive && queryReferencesCte(cte.query, cte.name)
      if (selfRecursive) {
        validateRecursiveCte(cte.query, cte.name, cte.id)
        const anchor = {
          ...cte.query,
          compounds: recursiveAnchorCompounds(cte.query, cte.name),
          orderBy: [],
          resultMode: { kind: 'multiset' as const },
        }
        delete (anchor as { page?: Query['page'] }).page
        const anchorColumns = new SqlRenderer(this.#catalog).query(anchor, outerScopes, scopes).columns
        scopes.set(cteKey, derivedScope(cte.name, anchorColumns))
      }
      // SQLite requires a recursive-table reference to occur directly in a
      // recursive SELECT core. The normal compound lowering wraps right-hand
      // terms to normalize their generated projection names, which would turn
      // that reference into a forbidden derived-table reference.
      // Recursive-row visitation affects the frontier and resource boundary,
      // so complete the queue order with the CTE's canonical projected row
      // even when the enclosing consumer treats the CTE as a multiset.
      const query = selfRecursive
        ? { ...cte.query, resultMode: { kind: 'ordered' as const } }
        : cte.query
      const rendered = this.query(query, outerScopes, scopes, selfRecursive)
      scopes.set(cteKey, derivedScope(cte.name, rendered.columns))
      const materialized = cte.materialized === 'default'
        ? ''
        : cte.materialized === 'materialized' ? ' MATERIALIZED' : ' NOT MATERIALIZED'
      definitionsSql.push(
        `${quoteIdentifier(cte.name)} (${rendered.columns.map((column) => quoteIdentifier(column.name)).join(', ')}) AS${materialized} (${rendered.sql})`,
      )
    }
    const sql = definitionsSql.length === 0
      ? ''
      : `WITH${recursive ? ' RECURSIVE' : ''} ${definitionsSql.join(', ')} `
    return { sql, scopes }
  }

  #query(
    query: Query,
    outerScopes: readonly RelationScope[] = [],
    inheritedCtes: CteScopes = new Map(),
    directCompoundArms = false,
  ): { readonly sql: string; readonly columns: readonly ResultColumn[]; readonly scopes: readonly RelationScope[] } {
    const renderedCtes = this.ctes(query.ctes, query.recursive === true, inheritedCtes, outerScopes)
    const ctes = renderedCtes.scopes
    const localScopes: RelationScope[] = []
    const visibleScopes: RelationScope[] = outerScopes.map((scope) => ({
      ...scope,
      lexicalDepth: (scope.lexicalDepth ?? 0) + 1,
    }))
    let fromSql = ''
    if (query.from !== undefined) {
      const rendered = this.#relation(query.from, ctes)
      localScopes.push(rendered.scope)
      visibleScopes.push(rendered.scope)
      fromSql = ` FROM ${rendered.sql}`
    }
    for (const join of query.joins) {
      const rendered = this.#relation(join.relation, ctes)
      const keyword = join.kind === 'inner' ? 'INNER JOIN'
        : join.kind === 'left' ? 'LEFT JOIN'
          : join.kind === 'right' ? 'RIGHT JOIN'
            : join.kind === 'full' ? 'FULL JOIN'
              : 'CROSS JOIN'
      if (join.on !== undefined && join.using !== undefined) throw new CompilerError('IR_JOIN_CONSTRAINT_AMBIGUOUS', join.id)
      const onScopes = [...visibleScopes, rendered.scope]
      const on = join.on === undefined ? '' : ` ON ${this.#queryExpression(join.on, onScopes, ctes, false)}`
      const using = join.using === undefined
        ? ''
        : ` USING (${join.using.map((column) => quoteIdentifier(column)).join(', ')})`
      if (join.kind === 'right' || join.kind === 'full') {
        for (let index = 0; index < localScopes.length; index += 1) {
          const nullExtended = { ...localScopes[index]!, nullExtended: true }
          localScopes[index] = nullExtended
          visibleScopes[outerScopes.length + index] = nullExtended
        }
      }
      const resultScope = join.kind === 'left' || join.kind === 'full'
        ? { ...rendered.scope, nullExtended: true }
        : rendered.scope
      localScopes.push(resultScope)
      visibleScopes.push(resultScope)
      fromSql += ` ${keyword} ${rendered.sql}${on}${using}`
    }
    if (query.projection.length === 0) throw new CompilerError('IR_QUERY_PROJECTION_REQUIRED', query.id)
    assertAggregateQueryShape(query, visibleScopes, this.#catalog)
    let columns = query.projection.map((projection) => ({
      id: projection.id,
      name: projection.name,
      valueType: inferExpressionType(projection.expression, visibleScopes, this.#catalog, ctes),
    }))
    let untypedNullColumns = query.projection.map((projection) =>
      isStaticallyUntypedNull(projection.expression))
    if (query.distinct === true && columns.some((column) => hasNonbinaryTextCollation(column.valueType))) {
      // SQLite may retain any byte-distinct representative from a collation-
      // equal DISTINCT class. A future lowering can choose the canonical byte
      // minimum within each equality class; accepting the native operation
      // directly would make the returned logical value plan-dependent.
      throw new CompilerError('IR_DISTINCT_COLLATION_REPRESENTATIVE_REQUIRED', query.id)
    }
    const projection = query.projection.map((item) =>
      `${this.#queryExpression(item.expression, visibleScopes, ctes, true, true)} AS ${quoteIdentifier(`chronolog_p_${item.id}`)}`,
    ).join(', ')
    const where = query.where === undefined ? '' : ` WHERE ${this.#queryExpression(query.where, visibleScopes, ctes, false)}`
    const group = query.groupBy.length === 0 ? '' : ` GROUP BY ${query.groupBy.map((item) => this.#queryExpression(item, visibleScopes, ctes, false)).join(', ')}`
    const having = query.having === undefined ? '' : ` HAVING ${this.#booleanQueryExpression(query.having, visibleScopes, ctes, true, 'IR_HAVING_BOOLEAN_REQUIRED')}`
    const stableOrderRequired = query.resultMode.kind === 'ordered' || query.page !== undefined
    const groupingContext = { scopes: visibleScopes, catalog: this.#catalog }
    const orderProjectionOrdinals = query.orderBy.map((term) =>
      query.projection.findIndex((item) =>
        sameGroupingExpression(term.expression, item.expression, groupingContext)))
    if (query.distinct === true && query.compounds.length === 0 &&
        orderProjectionOrdinals.some((index) => index < 0)) {
      // SQLite permits this extension, but an ORDER expression that is not a
      // function of the DISTINCT row can come from any discarded source row.
      // Until the compiler lowers a deterministic representative-row choice,
      // accepting it would make result order plan-dependent.
      throw new CompilerError('IR_DISTINCT_ORDER_TERM_NOT_RESULT', query.id)
    }
    const coveredProjectionOrdinals = new Set(orderProjectionOrdinals.flatMap((index) =>
      index < 0 ? [] : [index + 1]))
    const canonicalTieBreakers = stableOrderRequired
      ? columns.flatMap((column, index) => {
          const needsBinaryTextTie = hasNonbinaryTextCollation(column.valueType)
          if (coveredProjectionOrdinals.has(index + 1) && !needsBinaryTextTie) return []
          const value = needsBinaryTextTie
            ? `${quoteIdentifier(`chronolog_p_${column.id}`)} COLLATE BINARY`
            : `${index + 1}`
          return [`${value} ASC NULLS FIRST`]
        })
      : []
    const page = query.page === undefined ? '' : ` LIMIT ${safeUnsigned(query.page.limit, 'IR_PAGE_LIMIT_INVALID')}${
      query.page.offset === undefined ? '' : ` OFFSET ${safeUnsigned(query.page.offset, 'IR_PAGE_OFFSET_INVALID')}`
    }`
    for (const window of query.windows) {
      const resolved = this.#resolvedWindow(window)
      this.#validateWindowSpecification(resolved, visibleScopes, ctes, window.id)
    }
    const windows = query.windows.length === 0 ? '' : ` WINDOW ${query.windows.map((window) =>
      `${quoteIdentifier(window.name)} AS (${this.#windowSpecification(window, visibleScopes, ctes, false)})`,
    ).join(', ')}`
    let sql = `SELECT ${query.distinct === true ? 'DISTINCT ' : ''}${projection}${fromSql}${where}${group}${having}${windows}`
    if (query.compounds.length > 0) {
      for (const compound of query.compounds) {
        const rendered = this.query(compound.query, outerScopes, ctes, directCompoundArms)
        const rightUntypedNullColumns = compound.query.projection.map((_, index) =>
          isQueryColumnStaticallyUntypedNull(compound.query, index))
        assertCompoundColumns(
          columns,
          rendered.columns,
          untypedNullColumns,
          rightUntypedNullColumns,
          compound.operator,
          compound.id,
        )
        if (compound.operator !== 'union_all' &&
            columns.some((column) => hasNonbinaryTextCollation(column.valueType))) {
          throw new CompilerError('IR_COMPOUND_COLLATION_REPRESENTATIVE_REQUIRED', compound.id)
        }
        columns = columns.map((column, index) => ({
          ...column,
          valueType: {
            logical: untypedNullColumns[index]!
              ? rendered.columns[index]!.valueType.logical
              : column.valueType.logical,
            nullable: column.valueType.nullable || rendered.columns[index]!.valueType.nullable,
          },
        }))
        untypedNullColumns = untypedNullColumns.map((left, index) =>
          left && rightUntypedNullColumns[index]!)
        if (directCompoundArms) {
          sql += ` ${COMPOUND_OPERATORS[compound.operator]} ${rendered.sql}`
        } else {
          const alias = `chronolog_compound_${compound.id}`
          const selected = rendered.columns.map((column) =>
            `${quoteIdentifier(alias)}.${quoteIdentifier(`chronolog_p_${column.id}`)}`,
          ).join(', ')
          sql += ` ${COMPOUND_OPERATORS[compound.operator]} SELECT ${selected} FROM (${rendered.sql}) AS ${quoteIdentifier(alias)}`
        }
      }
      const compoundOrder = query.orderBy.map((term) => {
        const ordinal = compoundOrderOrdinal(term.expression, query)
        return `${ordinal} ${term.direction.toUpperCase()} NULLS ${term.nulls.toUpperCase()}`
      })
      const compoundCoveredOrdinals = new Set(query.orderBy.map((term) =>
        compoundOrderOrdinal(term.expression, query)))
      const compoundTieBreakers = stableOrderRequired
        ? columns.flatMap((column, index) => {
            const needsBinaryTextTie = hasNonbinaryTextCollation(column.valueType)
            if (compoundCoveredOrdinals.has(index + 1) && !needsBinaryTextTie) return []
            const value = needsBinaryTextTie
              ? `${quoteIdentifier(`chronolog_p_${query.projection[index]!.id}`)} COLLATE BINARY`
              : `${index + 1}`
            return [`${value} ASC NULLS FIRST`]
          })
        : []
      const compoundOrderTerms = [...compoundOrder, ...compoundTieBreakers]
      if (compoundOrderTerms.length > 0) sql += ` ORDER BY ${compoundOrderTerms.join(', ')}`
      sql += page
    } else {
      // Compound ORDER BY is rendered from output ordinals above. Rendering
      // these expressions eagerly would allocate parameters that never appear
      // in the final compound SQL.
      const explicitOrder = query.orderBy.map((term) =>
        `${this.#queryExpression(term.expression, visibleScopes, ctes, true, true)} ${term.direction.toUpperCase()} NULLS ${term.nulls.toUpperCase()}`,
      )
      const orderTerms = [...explicitOrder, ...canonicalTieBreakers]
      const order = orderTerms.length === 0 ? '' : ` ORDER BY ${orderTerms.join(', ')}`
      sql += `${order}${page}`
    }
    return { sql: `${renderedCtes.sql}${sql}`, columns, scopes: localScopes }
  }

  #queryExpression(
    expression: Expr,
    scopes: readonly RelationScope[],
    ctes: CteScopes,
    aggregatesAllowed: boolean,
    windowsAllowed = false,
  ): string {
    const previous = this.#aggregatesAllowed
    const previousWindowsAllowed = this.#windowsAllowed
    this.#aggregatesAllowed = aggregatesAllowed
    this.#windowsAllowed = windowsAllowed
    try {
      return this.expression(expression, scopes, undefined, ctes)
    } finally {
      this.#aggregatesAllowed = previous
      this.#windowsAllowed = previousWindowsAllowed
    }
  }

  #booleanQueryExpression(
    expression: Expr,
    scopes: readonly RelationScope[],
    ctes: CteScopes,
    aggregatesAllowed: boolean,
    code: string,
  ): string {
    const type = inferExpressionType(expression, scopes, this.#catalog, ctes)
    if (type.logical.kind !== 'boolean') throw new CompilerError(code, expression.id)
    return this.#queryExpression(expression, scopes, ctes, aggregatesAllowed)
  }

  #relation(relation: Relation, ctes: CteScopes): { readonly sql: string; readonly scope: RelationScope } {
    if (relation.kind === 'table' || relation.kind === 'system_relation') {
      const table = relation.kind === 'system_relation'
        ? this.#catalog.systemRelation(relation.relation)
        : this.#catalog.tableByName(relation.name)
      const alias = relation.alias ?? table.name
      return {
        sql: `${quoteIdentifier(table.name)} AS ${quoteIdentifier(alias)}`,
        scope: { alias, table },
      }
    }
    if (relation.kind === 'subquery') {
      const rendered = this.query(relation.query, [], ctes)
      const scope = derivedScope(relation.alias, rendered.columns)
      const sourceAlias = `chronolog_subquery_${relation.id}`
      const projected = rendered.columns.map((column) =>
        `${quoteIdentifier(sourceAlias)}.${quoteIdentifier(`chronolog_p_${column.id}`)} AS ${quoteIdentifier(column.name)}`,
      ).join(', ')
      return {
        sql: `(SELECT ${projected} FROM (${rendered.sql}) AS ${quoteIdentifier(sourceAlias)}) AS ${quoteIdentifier(relation.alias)}`,
        scope,
      }
    }
    if (relation.kind === 'cte') {
      const definition = ctes.get(sqliteIdentifierKey(relation.name))
      if (definition === undefined) throw new CompilerError('IR_UNKNOWN_CTE', relation.id)
      const alias = relation.alias ?? relation.name
      return {
        sql: `${quoteIdentifier(relation.name)} AS ${quoteIdentifier(alias)}`,
        scope: { ...definition, alias },
      }
    }
    throw new CompilerError('IR_RELATION_UNSUPPORTED', relation.id)
  }

  #cast(
    expression: Extract<Expr, { kind: 'cast' }>,
    scopes: readonly RelationScope[],
    mutationTarget: RelationScope | undefined,
    ctes: CteScopes,
  ): string {
    const source = inferExpressionType(expression.value, scopes, this.#catalog, ctes, mutationTarget)
    assertCastSupported(source, expression.target, expression.id)
    const value = this.expression(expression.value, scopes, mutationTarget, ctes)
    if (sameLogicalType(source.logical, expression.target)) return value
    return `CAST(${value} AS ${storageType(expression.target)})`
  }

  #function(
    expression: Extract<Expr, { kind: 'function' }>,
    scopes: readonly RelationScope[],
    mutationTarget: RelationScope | undefined,
    ctes: CteScopes,
  ): string {
    const fn = this.#catalog.functionById(expression.functionId)
    if (fn.effect !== 'pure') throw new CompilerError('IR_FUNCTION_NOT_PURE', expression.id)
    if (!isDeterministicSqliteScalarFunction(fn.name, expression.args.length)) {
      throw new CompilerError('IR_FUNCTION_UNSUPPORTED_BY_ENGINE', expression.id)
    }
    if (fn.arguments.length !== expression.args.length) throw new CompilerError('IR_FUNCTION_ARITY', expression.id)
    expression.args.forEach((argument, index) => {
      const actual = inferExpressionType(argument, scopes, this.#catalog, ctes, mutationTarget)
      if (!valueTypeAssignable(actual, fn.arguments[index]!, argument)) {
        throw new CompilerError('IR_FUNCTION_ARGUMENT_TYPE', argument.id)
      }
    })
    const args = expression.args.map((argument) =>
      this.expression(argument, scopes, mutationTarget, ctes),
    ).join(', ')
    return `${quoteIdentifier(fn.name)}(${args})`
  }

  #builtin(
    expression: Extract<Expr, { kind: 'builtin' }>,
    scopes: readonly RelationScope[],
    mutationTarget: RelationScope | undefined,
    ctes: CteScopes,
  ): string {
    inferBuiltinType(expression, scopes, this.#catalog, ctes, mutationTarget)
    if (!isDeterministicSqliteBuiltinFunction(expression.name)) {
      throw new CompilerError('IR_BUILTIN_FUNCTION_UNSUPPORTED', expression.id)
    }
    if (expression.name === 'likelihood') {
      const value = this.expression(expression.args[0]!, scopes, mutationTarget, ctes)
      const probability = likelihoodProbabilitySql(expression.args[1], expression.id)
      return `${quoteIdentifier(expression.name)}(${value}, ${probability})`
    }
    const args = expression.args.map((argument) =>
      this.expression(argument, scopes, mutationTarget, ctes)).join(', ')
    return `${quoteIdentifier(expression.name)}(${args})`
  }

  #aggregate(
    expression: Extract<Expr, { kind: 'aggregate' }>,
    scopes: readonly RelationScope[],
    mutationTarget: RelationScope | undefined,
    ctes: CteScopes,
  ): string {
    if (!this.#aggregatesAllowed) throw new CompilerError('IR_AGGREGATE_CONTEXT_INVALID', expression.id)
    inferAggregateType(expression, scopes, this.#catalog, ctes)
    const order = (expression.orderBy ?? []).map((term) =>
      `${this.#queryExpression(term.expression, scopes, ctes, false)} ${term.direction.toUpperCase()} NULLS ${term.nulls.toUpperCase()}`,
    ).join(', ')
    const orderedArguments = order.length === 0 ? '' : ` ORDER BY ${order}`
    let call: string
    if (expression.value === undefined) {
      if (expression.operation !== 'count' || expression.distinct) {
        throw new CompilerError('IR_AGGREGATE_ARGUMENT_REQUIRED', expression.id)
      }
      // SQLite accepts count(ORDER BY ...) as the zero-argument spelling and
      // still resolves/evaluates its (semantically inert) order expressions.
      // count(* ORDER BY ...) is a different, invalid grammar production.
      call = order.length === 0 ? 'COUNT(*)' : `COUNT(ORDER BY ${order})`
    } else {
      if (containsAggregate(expression.value)) {
        throw new CompilerError('IR_NESTED_AGGREGATE', expression.id)
      }
      const value = this.expression(expression.value, scopes, mutationTarget, ctes)
      const sqlOperation = expression.operation === 'every'
        ? 'MIN'
        : expression.operation === 'any' ? 'MAX' : expression.operation.toUpperCase()
      call = `${sqlOperation}(${expression.distinct ? 'DISTINCT ' : ''}${value}${orderedArguments})`
    }
    if (expression.filter === undefined) return call
    if (containsAggregate(expression.filter)) throw new CompilerError('IR_NESTED_AGGREGATE', expression.filter.id)
    return `${call} FILTER (WHERE ${this.expression(expression.filter, scopes, mutationTarget, ctes)})`
  }

  #window(
    expression: Extract<Expr, { kind: 'window' }>,
    scopes: readonly RelationScope[],
    mutationTarget: RelationScope | undefined,
    ctes: CteScopes,
  ): string {
    inferWindowType(expression, scopes, this.#catalog, ctes, mutationTarget)
    const aggregate = ['count', 'min', 'max', 'every', 'any'].includes(expression.operation)
    const resolvedWindow = this.#resolvedWindow(expression.window)
    this.#validateWindowSpecification(resolvedWindow, scopes, ctes, expression.id)
    if (aggregate && resolvedWindow.frame?.mode === 'rows' &&
        (resolvedWindow.frame.exclude === 'group' || resolvedWindow.frame.exclude === 'ties')) {
      // Completing the physical order would redefine peer membership for
      // EXCLUDE GROUP/TIES. This needs a two-key lowering (peer key plus
      // canonical intra-peer key), not a silent rewrite of the window order.
      throw new CompilerError('IR_WINDOW_PEER_ORDER_LOWERING_REQUIRED', expression.id)
    }
    const sqlOperation = expression.operation === 'every' ? 'MIN'
      : expression.operation === 'any' ? 'MAX'
        : expression.operation.toUpperCase()
    const args = expression.operation === 'count' && expression.args.length === 0
      ? '*'
      : expression.args.map((argument) => this.expression(argument, scopes, mutationTarget, ctes)).join(', ')
    const filter = expression.filter === undefined
      ? ''
      : ` FILTER (WHERE ${this.expression(expression.filter, scopes, mutationTarget, ctes)})`
    if (!aggregate && filter.length > 0) throw new CompilerError('IR_WINDOW_FILTER_UNSUPPORTED', expression.id)
    const orderSensitive = ['row_number', 'ntile', 'lag', 'lead'].includes(expression.operation) ||
      (aggregate && resolvedWindow.frame?.mode === 'rows')
    // SQLite's built-in ranking/offset functions ignore frame clauses. Drop
    // the inert frame when inlining a deterministic tie-completed order so a
    // valid single-term RANGE offset is not turned into an invalid multi-term
    // RANGE specification.
    const renderedWindow = aggregate || resolvedWindow.frame === undefined
      ? resolvedWindow
      : withoutWindowFrame(resolvedWindow)
    const over = typeof expression.window === 'string' && !orderSensitive
      ? quoteIdentifier(expression.window)
      : `(${this.#windowSpecification(
          renderedWindow, scopes, ctes, orderSensitive,
        )})`
    return `${sqlOperation}(${args})${filter} OVER ${over}`
  }

  #resolvedWindow(window: string | WindowSpecification, seen: ReadonlySet<string> = new Set()): WindowSpecification {
    const specification = typeof window === 'string'
      ? (() => {
          const found = this.#windows.find((candidate) => sqliteIdentifierEquals(candidate.name, window))
          if (found === undefined) throw new CompilerError('IR_WINDOW_NOT_FOUND')
          return found
        })()
      : window
    if (specification.base === undefined) return specification
    const key = sqliteIdentifierKey(specification.base)
    if (seen.has(key)) throw new CompilerError('IR_WINDOW_BASE_CYCLE')
    const parent = this.#resolvedWindow(specification.base, new Set([...seen, key]))
    if (specification.partitionBy.length > 0) {
      throw new CompilerError('IR_WINDOW_BASE_PARTITION_OVERRIDE')
    }
    if (parent.orderBy.length > 0 && specification.orderBy.length > 0) {
      throw new CompilerError('IR_WINDOW_BASE_ORDER_OVERRIDE')
    }
    if (parent.frame !== undefined) throw new CompilerError('IR_WINDOW_BASE_FRAME_INVALID')
    return {
      partitionBy: parent.partitionBy,
      orderBy: specification.orderBy.length === 0 ? parent.orderBy : specification.orderBy,
      ...(specification.frame === undefined ? {} : { frame: specification.frame }),
    }
  }

  #windowSpecification(
    window: WindowSpecification,
    scopes: readonly RelationScope[],
    ctes: CteScopes,
    completeTies: boolean,
  ): string {
    const specification = window
    const base = specification.base === undefined ? '' : quoteIdentifier(specification.base)
    const partition = specification.partitionBy.length === 0
      ? ''
      : `PARTITION BY ${specification.partitionBy.map((item) =>
          this.#queryExpression(item, scopes, ctes, true)).join(', ')}`
    const authoredOrder = specification.orderBy.map((term) =>
      `${this.#queryExpression(term.expression, scopes, ctes, true)} ${term.direction.toUpperCase()} NULLS ${term.nulls.toUpperCase()}`)
    const tieBreakers = !completeTies
      ? []
      : this.#windowGroupTieBreakers === null
        ? canonicalWindowTieBreakers(scopes)
        : this.#windowGroupTieBreakers.map((expression) => {
            const value = this.#queryExpression(expression, scopes, ctes, false)
            const type = inferExpressionType(expression, scopes, this.#catalog, ctes)
            return `${hasNonbinaryTextCollation(type) ? `${value} COLLATE BINARY` : value} ASC NULLS FIRST`
          })
    const orderTerms = [...authoredOrder, ...tieBreakers]
    const order = orderTerms.length === 0 ? '' : `ORDER BY ${orderTerms.join(', ')}`
    const frame = specification.frame === undefined
      ? ''
      : this.#windowFrame(specification.frame, scopes, ctes)
    return [base, partition, order, frame].filter(Boolean).join(' ')
  }

  #windowFrame(
    frame: NonNullable<WindowSpecification['frame']>,
    scopes: readonly RelationScope[],
    ctes: CteScopes,
  ): string {
    const start = this.#windowFrameBound(frame.start, scopes, ctes)
    const bounds = frame.end === undefined
      ? start
      : `BETWEEN ${start} AND ${this.#windowFrameBound(frame.end, scopes, ctes)}`
    const exclude = frame.exclude === undefined || frame.exclude === 'no_others'
      ? frame.exclude === 'no_others' ? ' EXCLUDE NO OTHERS' : ''
      : ` EXCLUDE ${frame.exclude === 'current_row' ? 'CURRENT ROW' : frame.exclude.toUpperCase()}`
    return `${frame.mode.toUpperCase()} ${bounds}${exclude}`
  }

  #windowFrameBound(bound: WindowFrameBound, scopes: readonly RelationScope[], ctes: CteScopes): string {
    if (bound.type === 'current_row') return 'CURRENT ROW'
    if (bound.type === 'unbounded_preceding') return 'UNBOUNDED PRECEDING'
    if (bound.type === 'unbounded_following') return 'UNBOUNDED FOLLOWING'
    const folded = staticInt64Value(bound.offset)
    const offset = folded === undefined
      ? bound.offset
      : { kind: 'literal' as const, id: bound.offset.id, value: { kind: 'int64' as const, value: folded } }
    return `${this.#queryExpression(offset, scopes, ctes, false)} ${bound.type.toUpperCase()}`
  }

  #validateWindowSpecification(
    window: WindowSpecification,
    scopes: readonly RelationScope[],
    ctes: CteScopes,
    nodeId: number,
  ): void {
    const frame = window.frame
    if (frame === undefined) return
    const end = frame.end ?? { type: 'current_row' as const }
    if (frame.start.type === 'unbounded_following' || end.type === 'unbounded_preceding' ||
        windowBoundRank(end) < windowBoundRank(frame.start)) {
      throw new CompilerError('IR_WINDOW_FRAME_BOUNDS_INVALID', nodeId)
    }
    const offsetBounds = [frame.start, frame.end].flatMap((bound) =>
      bound?.type === 'preceding' || bound?.type === 'following' ? [bound] : [])
    for (const bound of offsetBounds) {
      const type = inferExpressionType(bound.offset, scopes, this.#catalog, ctes)
      const folded = staticInt64Value(bound.offset)
      if (type.logical.kind !== 'int64' || type.nullable ||
          !isStatementConstantFrameOffset(bound.offset) ||
          (folded !== undefined && folded < 0n)) {
        throw new CompilerError('IR_WINDOW_FRAME_OFFSET_INVALID', bound.offset.id)
      }
    }
    if (frame.mode === 'range' && offsetBounds.length > 0 && window.orderBy.length !== 1) {
      throw new CompilerError('IR_WINDOW_RANGE_ORDER_REQUIRED', nodeId)
    }
  }

  #json(
    expression: Extract<Expr, { kind: 'json' }>,
    scopes: readonly RelationScope[],
    mutationTarget: RelationScope | undefined,
    ctes: CteScopes,
  ): string {
    if (!this.#catalog.manifest.features.json) throw new CompilerError('JSON_FEATURE_DISABLED', expression.id)
    if (expression.path !== undefined && expression.pathExpression !== undefined) {
      throw new CompilerError('IR_JSON_PATH_AMBIGUOUS', expression.id)
    }
    if (expression.operation === 'extract' || expression.operation === 'type') {
      if (expression.args.length !== 1) throw new CompilerError('IR_JSON_ARITY', expression.id)
      const argumentType = inferExpressionType(expression.args[0]!, scopes, this.#catalog, ctes, mutationTarget)
      if (argumentType.logical.kind !== 'json') throw new CompilerError('IR_JSON_ARGUMENT_TYPE', expression.args[0]!.id)
      const argument = this.expression(expression.args[0]!, scopes, mutationTarget, ctes)
      const path = expression.path !== undefined
        ? quoteString(expression.path)
        : expression.pathExpression === undefined
          ? undefined
          : this.#jsonPath(expression.pathExpression, scopes, mutationTarget, ctes)
      if (expression.operation === 'extract') {
        if (path === undefined) throw new CompilerError('IR_JSON_PATH_REQUIRED', expression.id)
        return `(${argument} -> ${path})`
      }
      return path === undefined
        ? `json_type(${argument})`
        : `json_type(${argument}, ${path})`
    }
    if (expression.path !== undefined || expression.pathExpression !== undefined) {
      throw new CompilerError('IR_JSON_PATH_UNSUPPORTED', expression.id)
    }
    if (expression.operation === 'array') {
      const args = expression.args.map((argument) =>
        this.#jsonConstructorArgument(argument, scopes, mutationTarget, ctes),
      ).join(', ')
      return `json_array(${args})`
    }
    if (expression.operation === 'object') {
      if (expression.args.length % 2 !== 0) throw new CompilerError('IR_JSON_OBJECT_ARITY', expression.id)
      const entries: { readonly key: string; readonly keyExpression: Expr; readonly valueExpression: Expr }[] = []
      for (let index = 0; index < expression.args.length; index += 2) {
        const keyExpression = expression.args[index]!
        if (keyExpression.kind !== 'literal' || keyExpression.value.kind !== 'text') {
          throw new CompilerError('IR_JSON_OBJECT_KEY_LITERAL_REQUIRED', keyExpression.id)
        }
        entries.push({
          key: new TextDecoder('utf-8', { fatal: true }).decode(keyExpression.value.utf8),
          keyExpression,
          valueExpression: expression.args[index + 1]!,
        })
      }
      entries.sort((left, right) => compareUtf8(left.key, right.key))
      for (let index = 1; index < entries.length; index += 1) {
        if (entries[index - 1]!.key === entries[index]!.key) {
          throw new CompilerError('IR_JSON_OBJECT_DUPLICATE_KEY', expression.id)
        }
      }
      const args = entries.flatMap((entry) => [
        this.expression(entry.keyExpression, scopes, mutationTarget, ctes),
        this.#jsonConstructorArgument(entry.valueExpression, scopes, mutationTarget, ctes),
      ]).join(', ')
      return `json_object(${args})`
    }
    if (expression.operation === 'merge') {
      if (expression.args.length !== 2) throw new CompilerError('IR_JSON_ARITY', expression.id)
      const values = expression.args.map((argument) => {
        if (argument.kind !== 'literal' || argument.value.kind !== 'json') {
          throw new CompilerError('IR_JSON_DYNAMIC_MERGE_REQUIRES_KERNEL', argument.id)
        }
        return parseCanonicalJson(canonicalJsonToText(argument.value.value))
      })
      const result = canonicalJsonFromText(serializeCanonicalJson(jsonMergePatch(values[0]!, values[1]!)))
      return this.#bind(
        { kind: 'literal', value: { kind: 'json', value: result } },
        { logical: { kind: 'json' }, nullable: false },
      )
    }
    throw new CompilerError('IR_JSON_OPERATION_UNSUPPORTED', expression.id)
  }

  #jsonPath(
    expression: Expr,
    scopes: readonly RelationScope[],
    mutationTarget: RelationScope | undefined,
    ctes: CteScopes,
  ): string {
    const type = inferExpressionType(expression, scopes, this.#catalog, ctes, mutationTarget)
    if (type.logical.kind !== 'text') throw new CompilerError('IR_JSON_PATH_TYPE', expression.id)
    return this.expression(expression, scopes, mutationTarget, ctes)
  }

  #jsonConstructorArgument(
    expression: Expr,
    scopes: readonly RelationScope[],
    mutationTarget: RelationScope | undefined,
    ctes: CteScopes,
  ): string {
    const sql = this.expression(expression, scopes, mutationTarget, ctes)
    if (expression.kind === 'literal' && expression.value.kind === 'null') return sql
    const type = inferExpressionType(expression, scopes, this.#catalog, ctes, mutationTarget).logical.kind
    if (type === 'json' || type === 'decimal') return `json(${sql})`
    if (type === 'boolean') return `json(CASE ${sql} WHEN 0 THEN 'false' WHEN 1 THEN 'true' ELSE NULL END)`
    if (type === 'int64' || type === 'timestamp_ms' || type === 'duration_ms' || type === 'text') return sql
    throw new CompilerError('IR_JSON_ARGUMENT_TYPE', expression.id)
  }

  #column(expression: ColumnExpr, scopes: readonly RelationScope[]): string {
    const candidates = expression.relation === undefined
      ? scopes.filter((scope) => scope.table.columns.some((column) => sqliteIdentifierEquals(column.name, expression.name)))
      : scopes.filter((scope) => sqliteIdentifierEquals(scope.alias, expression.relation!))
    const matching = nearestLexicalScopes(candidates)
    if (matching.length !== 1) throw new CompilerError(
      matching.length === 0 ? 'IR_UNKNOWN_COLUMN' : 'IR_AMBIGUOUS_COLUMN',
      expression.id,
    )
    const scope = matching[0]!
    const column = resolvedColumn(scope, expression.name, this.#catalog, expression.id)
    return `${quoteIdentifier(scope.alias)}.${quoteIdentifier(column.name)}`
  }

  #bind(source: BindingSource, valueType: ValueType): string {
    const ordinal = this.#parameters.length + 1
    this.#parameters.push({ ordinal, valueType, source })
    return `?${ordinal}`
  }
}

function deterministicScalarSubquery(query: Query): Query {
  const page = {
    limit: query.page?.limit === 0 ? 0 : 1,
    ...(query.page?.offset === undefined ? {} : { offset: query.page.offset }),
  }
  return { ...query, resultMode: { kind: 'ordered' }, page }
}

function compoundOrderOrdinal(expression: Expr, query: Query): number {
  if (expression.kind === 'literal' && expression.value.kind === 'int64' &&
      expression.value.value >= 1n && expression.value.value <= BigInt(query.projection.length)) {
    return Number(expression.value.value)
  }
  const index = query.projection.findIndex((projection) =>
    sameGroupingExpression(expression, projection.expression) ||
    (expression.kind === 'column' && expression.relation === undefined &&
      sqliteIdentifierEquals(expression.name, projection.name)))
  if (index < 0) throw new CompilerError('IR_COMPOUND_ORDER_TERM_NOT_RESULT', expression.id)
  return index + 1
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
  if (Array.isArray(value)) return 1 + (value as readonly (Extract<LogicalValue, { kind: 'json' }>['value'])[])
    .reduce((maximum, item) => Math.max(maximum, jsonDepth(item)), 0)
  if (value instanceof Map) return 1 + [...(value as ReadonlyMap<string, Extract<LogicalValue, { kind: 'json' }>['value']>).values()]
    .reduce((maximum, item) => Math.max(maximum, jsonDepth(item)), 0)
  return 0
}

const BINARY_OPERATORS: Partial<Record<Extract<Expr, { kind: 'binary' }>['operator'], string>> = {
  and: 'AND', or: 'OR', eq: '=', ne: '<>', lt: '<', lte: '<=', gt: '>', gte: '>=',
  concat: '||', bit_and: '&', bit_or: '|', shift_left: '<<', shift_right: '>>',
  is: 'IS', is_not: 'IS NOT', like: 'LIKE', not_like: 'NOT LIKE', glob: 'GLOB', not_glob: 'NOT GLOB',
}

const CHECKED_INTEGER_ARITHMETIC = new Set<Extract<Expr, { kind: 'binary' }>['operator']>([
  'add', 'subtract', 'multiply', 'divide', 'modulo',
])

function isCheckedIntegerArithmetic(
  operator: Extract<Expr, { kind: 'binary' }>['operator'],
): operator is 'add' | 'subtract' | 'multiply' | 'divide' | 'modulo' {
  return CHECKED_INTEGER_ARITHMETIC.has(operator)
}

function checkedArithmeticLogicalType(
  expression: Extract<Expr, { kind: 'binary' }>,
  left: ValueType,
  right: ValueType,
): LogicalType {
  const leftKind = isNullLiteral(expression.left) ? 'null' : left.logical.kind
  const rightKind = isNullLiteral(expression.right) ? 'null' : right.logical.kind
  if (leftKind === 'null' || rightKind === 'null') {
    const concrete = leftKind === 'null' ? rightKind : leftKind
    if (concrete === 'null' || concrete === 'int64') return { kind: 'int64' }
    throw new CompilerError('IR_ARITHMETIC_OPERAND_TYPE', expression.id)
  }
  switch (expression.operator) {
    case 'add':
      if (leftKind === 'int64' && rightKind === 'int64') return { kind: 'int64' }
      if (leftKind === 'duration_ms' && rightKind === 'duration_ms') return { kind: 'duration_ms' }
      if ((leftKind === 'timestamp_ms' && rightKind === 'duration_ms') ||
          (leftKind === 'duration_ms' && rightKind === 'timestamp_ms')) return { kind: 'timestamp_ms' }
      break
    case 'subtract':
      if (leftKind === 'int64' && rightKind === 'int64') return { kind: 'int64' }
      if (leftKind === 'duration_ms' && rightKind === 'duration_ms') return { kind: 'duration_ms' }
      if (leftKind === 'timestamp_ms' && rightKind === 'duration_ms') return { kind: 'timestamp_ms' }
      if (leftKind === 'timestamp_ms' && rightKind === 'timestamp_ms') return { kind: 'duration_ms' }
      break
    case 'multiply':
      if (leftKind === 'int64' && rightKind === 'int64') return { kind: 'int64' }
      if ((leftKind === 'duration_ms' && rightKind === 'int64') ||
          (leftKind === 'int64' && rightKind === 'duration_ms')) return { kind: 'duration_ms' }
      break
    case 'divide':
      if (leftKind === 'int64' && rightKind === 'int64') return { kind: 'int64' }
      if (leftKind === 'duration_ms' && rightKind === 'int64') return { kind: 'duration_ms' }
      break
    case 'modulo':
      if (leftKind === 'int64' && rightKind === 'int64') return { kind: 'int64' }
      break
  }
  throw new CompilerError('IR_ARITHMETIC_OPERAND_TYPE', expression.id)
}

const INTEGER_EVALUATION_ERROR = '"abs"(-9223372036854775808)'

/**
 * SQLite promotes overflowing integer arithmetic to REAL and returns NULL for
 * division/remainder by zero. Chronolog never exposes either fallback: typeof
 * observes only the storage class, then a pinned core-function overflow raises
 * the statement-time error normalized by the consensus executor.
 */
function checkedIntegerBinarySql(
  left: string,
  right: string,
  operator: 'add' | 'subtract' | 'multiply' | 'divide' | 'modulo',
): string {
  const symbol = {
    add: '+', subtract: '-', multiply: '*', divide: '/', modulo: '%',
  }[operator]
  const raw = `(${left} ${symbol} ${right})`
  return `(CASE WHEN ${left} IS NULL OR ${right} IS NULL THEN NULL WHEN typeof(${raw}) <> 'integer' THEN ${INTEGER_EVALUATION_ERROR} ELSE ${raw} END)`
}

function checkedIntegerUnarySql(value: string, operator: '-'): string {
  const raw = `(${operator}${value})`
  return `(CASE WHEN ${value} IS NULL THEN NULL WHEN typeof(${raw}) <> 'integer' THEN ${INTEGER_EVALUATION_ERROR} ELSE ${raw} END)`
}

function checkedIntegerShiftSql(
  left: string,
  right: string,
  operator: 'shift_left' | 'shift_right',
): string {
  const symbol = operator === 'shift_left' ? '<<' : '>>'
  const raw = `(${left} ${symbol} ${right})`
  const invalid = `${right} < 0 OR ${right} > 63`
  const overflow = operator === 'shift_left' ? ` OR ((${raw} >> ${right}) <> ${left})` : ''
  return `(CASE WHEN ${left} IS NULL OR ${right} IS NULL THEN NULL WHEN ${invalid}${overflow} THEN ${INTEGER_EVALUATION_ERROR} ELSE ${raw} END)`
}

const COMPOUND_OPERATORS = {
  union_all: 'UNION ALL',
  union: 'UNION',
  intersect: 'INTERSECT',
  except: 'EXCEPT',
} as const

export function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`
}

export function collationSql(collation: CollationId, catalog: Catalog): string {
  if (collation === 'binary' || collation === 'unicode_codepoint') return 'BINARY'
  if (collation === 'nocase') return 'NOCASE'
  if (collation === 'rtrim') return 'RTRIM'
  const id = Number(collation.slice('registered:'.length))
  if (!Number.isSafeInteger(id)) throw new CompilerError('IR_COLLATION_INVALID')
  return quoteIdentifier(catalog.collationById(id).name)
}

function canonicalWindowTieBreakers(scopes: readonly RelationScope[]): readonly string[] {
  return scopes
    .filter((scope) => (scope.lexicalDepth ?? 0) === 0)
    .flatMap((scope) => scope.table.columns.map((column) => {
      const value = `${quoteIdentifier(scope.alias)}.${quoteIdentifier(column.name)}`
      return `${hasNonbinaryTextCollation(column.valueType) ? `${value} COLLATE BINARY` : value} ASC NULLS FIRST`
    }))
}

function hasNonbinaryTextCollation(type: ValueType): boolean {
  return type.logical.kind === 'text' && type.logical.collation !== 'binary' &&
    type.logical.collation !== 'unicode_codepoint'
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

export function inferExpressionType(
  expression: Expr,
  scopes: readonly RelationScope[],
  catalog: Catalog,
  ctes: CteScopes = new Map(),
  mutationTarget?: RelationScope,
): ValueType {
  switch (expression.kind) {
    case 'literal': return valueTypeOf(expression.value)
    case 'context': return contextValueType(expression.field)
    case 'entropy':
      assertEntropyRequest(expression)
      return { logical: { kind: 'blob', maxBytes: expression.length }, nullable: false }
    case 'column': {
      const candidates = nearestLexicalScopes(scopes.filter((scope) =>
        (expression.relation === undefined || sqliteIdentifierEquals(expression.relation, scope.alias)) &&
        scope.table.columns.some((column) => sqliteIdentifierEquals(column.name, expression.name)),
      ))
      if (candidates.length !== 1) throw new CompilerError(candidates.length === 0 ? 'IR_UNKNOWN_COLUMN' : 'IR_AMBIGUOUS_COLUMN', expression.id)
      return resolvedColumn(candidates[0]!, expression.name, catalog, expression.id).valueType
    }
    case 'unary':
      if (expression.operator === 'is_null' || expression.operator === 'is_not_null') {
        return { logical: { kind: 'boolean' }, nullable: false }
      }
      if (expression.operator === 'not') {
        const operand = inferExpressionType(expression.operand, scopes, catalog, ctes, mutationTarget)
        if (!isNullLiteral(expression.operand) && operand.logical.kind !== 'boolean') {
          throw new CompilerError('IR_BOOLEAN_OPERAND_REQUIRED', expression.id)
        }
        return { logical: { kind: 'boolean' }, nullable: operand.nullable }
      }
      if (expression.operator === 'bit_not') {
        const operand = inferExpressionType(expression.operand, scopes, catalog, ctes, mutationTarget)
        if (!isNullLiteral(expression.operand) && operand.logical.kind !== 'int64') {
          throw new CompilerError('IR_INTEGER_OPERAND_REQUIRED', expression.id)
        }
        return { logical: { kind: 'int64' }, nullable: operand.nullable }
      }
      if (expression.operator === 'negate') {
        const operand = inferExpressionType(expression.operand, scopes, catalog, ctes, mutationTarget)
        if (!isNullLiteral(expression.operand) &&
            operand.logical.kind !== 'int64' && operand.logical.kind !== 'duration_ms') {
          throw new CompilerError('IR_INTEGER_OPERAND_REQUIRED', expression.id)
        }
        return {
          logical: operand.logical.kind === 'duration_ms' ? operand.logical : { kind: 'int64' },
          nullable: operand.nullable,
        }
      }
      throw new CompilerError('IR_UNARY_OPERATOR_UNSUPPORTED', expression.id)
    case 'binary':
      if (expression.left.kind === 'row' || expression.right.kind === 'row') {
        return inferRowComparisonType(expression, scopes, catalog, ctes, mutationTarget)
      }
      if (['and', 'or', 'eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'is', 'is_not', 'like', 'not_like', 'glob', 'not_glob'].includes(expression.operator)) {
        const left = inferExpressionType(expression.left, scopes, catalog, ctes, mutationTarget)
        const right = inferExpressionType(expression.right, scopes, catalog, ctes, mutationTarget)
        const escape = expression.escape === undefined
          ? undefined
          : inferExpressionType(expression.escape, scopes, catalog, ctes, mutationTarget)
        const nullable = expression.operator === 'is' || expression.operator === 'is_not'
          ? false
          : expression.operator === 'and' || expression.operator === 'or' || left.nullable || right.nullable || escape?.nullable === true
        return { logical: { kind: 'boolean' }, nullable }
      }
      if (expression.operator === 'concat') {
        return {
          logical: { kind: 'text', collation: firstExplicitCollation(expression) ?? 'binary' },
          nullable: true,
        }
      }
      if (isCheckedIntegerArithmetic(expression.operator)) {
        const left = inferExpressionType(expression.left, scopes, catalog, ctes, mutationTarget)
        const right = inferExpressionType(expression.right, scopes, catalog, ctes, mutationTarget)
        return {
          logical: checkedArithmeticLogicalType(expression, left, right),
          nullable: left.nullable || right.nullable,
        }
      }
      if (['bit_and', 'bit_or', 'bit_xor', 'shift_left', 'shift_right'].includes(expression.operator)) {
        const left = inferExpressionType(expression.left, scopes, catalog, ctes, mutationTarget)
        const right = inferExpressionType(expression.right, scopes, catalog, ctes, mutationTarget)
        if ((!isNullLiteral(expression.left) && left.logical.kind !== 'int64') ||
            (!isNullLiteral(expression.right) && right.logical.kind !== 'int64')) {
          throw new CompilerError('IR_INTEGER_OPERAND_REQUIRED', expression.id)
        }
        return { logical: { kind: 'int64' }, nullable: left.nullable || right.nullable }
      }
      throw new CompilerError('IR_BINARY_OPERATOR_UNSUPPORTED', expression.id)
    case 'conditional': {
      const resultExpressions = [
        ...expression.branches.map((branch) => branch.then),
        expression.otherwise,
      ]
      const resultTypes = resultExpressions.map((result) =>
        inferExpressionType(result, scopes, catalog, ctes, mutationTarget))
      for (const branch of expression.branches) {
        const when = inferExpressionType(branch.when, scopes, catalog, ctes, mutationTarget)
        if (!isNullLiteral(branch.when) && when.logical.kind !== 'boolean') {
          throw new CompilerError('IR_BOOLEAN_OPERAND_REQUIRED', expression.id)
        }
      }
      return {
        logical: commonPolymorphicLogicalType(
          resultExpressions,
          resultTypes,
          expression.id,
          'IR_CONDITIONAL_TYPE_MISMATCH',
          expression,
        ),
        nullable: resultExpressions.some((result, index) =>
          isNullLiteral(result) || resultTypes[index]!.nullable),
      }
    }
    case 'cast': {
      const source = inferExpressionType(expression.value, scopes, catalog, ctes, mutationTarget)
      assertCastSupported(source, expression.target, expression.id)
      if (expression.target.kind === 'text') {
        const explicit = firstExplicitCollation(expression.value)
        return {
          logical: {
            kind: 'text',
            collation: explicit ?? (source.logical.kind === 'text' ? source.logical.collation : 'binary'),
          },
          nullable: source.nullable,
        }
      }
      return { logical: expression.target, nullable: source.nullable }
    }
    case 'collate': {
      const source = inferExpressionType(expression.expression, scopes, catalog, ctes, mutationTarget)
      // Resolve registration even when the operand is not text so invalid
      // profile references never disappear as semantic no-ops.
      collationSql(expression.collation, catalog)
      return source.logical.kind === 'text'
        ? { logical: { ...source.logical, collation: expression.collation }, nullable: source.nullable }
        : source
    }
    case 'builtin': return inferBuiltinType(expression, scopes, catalog, ctes, mutationTarget)
    case 'function': {
      const fn = catalog.functionById(expression.functionId)
      if (fn.effect !== 'pure') throw new CompilerError('IR_FUNCTION_NOT_PURE', expression.id)
      if (!isDeterministicSqliteScalarFunction(fn.name, expression.args.length)) {
        throw new CompilerError('IR_FUNCTION_UNSUPPORTED_BY_ENGINE', expression.id)
      }
      if (fn.arguments.length !== expression.args.length) throw new CompilerError('IR_FUNCTION_ARITY', expression.id)
      expression.args.forEach((argument, index) => {
        if (!valueTypeAssignable(
          inferExpressionType(argument, scopes, catalog, ctes, mutationTarget),
          fn.arguments[index]!,
          argument,
        )) {
          throw new CompilerError('IR_FUNCTION_ARGUMENT_TYPE', argument.id)
        }
      })
      return fn.result.logical.kind === 'text'
        ? {
            ...fn.result,
            logical: {
              kind: 'text',
              collation: firstExplicitCollation(expression) ?? fn.result.logical.collation,
            },
          }
        : fn.result
    }
    case 'aggregate': return inferAggregateType(expression, scopes, catalog, ctes)
    case 'json': return inferJsonType(expression, scopes, catalog, ctes, mutationTarget)
    case 'window': return inferWindowType(expression, scopes, catalog, ctes, mutationTarget)
    case 'old_new': {
      if (mutationTarget === undefined) throw new CompilerError('IR_OLD_NEW_RESULT_TYPE_REQUIRES_TARGET', expression.id)
      return catalog.column(mutationTarget.table, expression.column).valueType
    }
    case 'scalar_subquery': {
      const nested = new SqlRenderer(catalog).query(deterministicScalarSubquery(expression.query), scopes, ctes)
      if (nested.columns.length !== 1) throw new CompilerError('IR_SCALAR_SUBQUERY_WIDTH', expression.id)
      return { ...nested.columns[0]!.valueType, nullable: true }
    }
    case 'exists': return { logical: { kind: 'boolean' }, nullable: false }
    case 'membership': return inferMembershipType(expression, scopes, catalog, ctes, mutationTarget)
    case 'row': throw new CompilerError('IR_ROW_VALUE_CONTEXT', expression.id)
    default: throw new CompilerError('IR_EXPRESSION_UNSUPPORTED', expression.id)
  }
}

function inferBuiltinType(
  expression: Extract<Expr, { kind: 'builtin' }>,
  scopes: readonly RelationScope[],
  catalog: Catalog,
  ctes: CteScopes,
  mutationTarget?: RelationScope,
): ValueType {
  if (!isDeterministicSqliteBuiltinFunction(expression.name)) {
    throw new CompilerError('IR_BUILTIN_FUNCTION_UNSUPPORTED', expression.id)
  }
  const types = expression.args.map((argument) =>
    inferExpressionType(argument, scopes, catalog, ctes, mutationTarget))
  const nullable = types.some((type) => type.nullable)
  const text = (resultNullable: boolean): ValueType => ({
    logical: { kind: 'text', collation: firstExplicitCollation(expression) ?? 'binary' },
    nullable: resultNullable,
  })
  const integer = (resultNullable: boolean): ValueType => ({
    logical: { kind: 'int64' }, nullable: resultNullable,
  })
  const blob = (resultNullable: boolean): ValueType => ({
    logical: { kind: 'blob' }, nullable: resultNullable,
  })

  switch (expression.name) {
    case 'char':
      assertBuiltinArity(expression, 0, 64)
      expression.args.forEach((argument, index) =>
        assertBuiltinArgument(argument, types[index]!, ['int64']))
      // SQLite maps NULL arguments to code point zero, so the result itself is
      // never NULL.
      return text(false)
    case 'concat':
    case 'concat_ws': {
      assertBuiltinArity(expression, expression.name === 'concat' ? 1 : 2, 64)
      expression.args.forEach((argument, index) =>
        assertBuiltinArgument(argument, types[index]!, [
          'boolean', 'int64', 'timestamp_ms', 'duration_ms', 'decimal', 'text', 'json',
        ]))
      // concat() skips NULL values. concat_ws() only returns NULL when its
      // separator (the first argument) is NULL.
      return text(expression.name === 'concat_ws' && types[0]!.nullable)
    }
    case 'length':
    case 'octet_length':
      assertBuiltinArity(expression, 1)
      assertBuiltinArgument(expression.args[0]!, types[0]!, ['text', 'blob', 'uuid'])
      return integer(nullable)
    case 'lower':
    case 'upper':
      assertBuiltinArity(expression, 1)
      assertBuiltinArgument(expression.args[0]!, types[0]!, ['text'])
      return text(nullable)
    case 'trim':
    case 'ltrim':
    case 'rtrim':
      assertBuiltinArity(expression, 1, 2)
      expression.args.forEach((argument, index) =>
        assertBuiltinArgument(argument, types[index]!, ['text']))
      return text(nullable)
    case 'replace':
      assertBuiltinArity(expression, 3)
      expression.args.forEach((argument, index) =>
        assertBuiltinArgument(argument, types[index]!, ['text']))
      return text(nullable)
    case 'instr': {
      assertBuiltinArity(expression, 2)
      const concrete = expression.args.flatMap((argument, index) =>
        isNullLiteral(argument) ? [] : [types[index]!.logical.kind])
      if (concrete.some((kind) => kind !== 'text' && kind !== 'blob' && kind !== 'uuid') ||
          (concrete.includes('text') && concrete.some((kind) => kind !== 'text'))) {
        throw new CompilerError('IR_BUILTIN_ARGUMENT_TYPE', expression.id)
      }
      return integer(nullable)
    }
    case 'substr':
    case 'substring': {
      assertBuiltinArity(expression, 2, 3)
      assertBuiltinArgument(expression.args[0]!, types[0]!, ['text', 'blob', 'uuid'])
      assertBuiltinArgument(expression.args[1]!, types[1]!, ['int64'])
      if (expression.args[2] !== undefined) {
        assertBuiltinArgument(expression.args[2], types[2]!, ['int64'])
      }
      if (isNullLiteral(expression.args[0]!)) return { logical: { kind: 'blob' }, nullable: true }
      const source = types[0]!.logical
      return source.kind === 'text'
        ? text(nullable)
        : {
            logical: {
              kind: 'blob',
              ...(source.kind === 'blob' && source.maxBytes !== undefined
                ? { maxBytes: source.maxBytes }
                : source.kind === 'uuid' ? { maxBytes: 16 } : {}),
            },
            nullable,
          }
    }
    case 'hex':
      assertBuiltinArity(expression, 1)
      assertBuiltinArgument(expression.args[0]!, types[0]!, [
        'boolean', 'int64', 'timestamp_ms', 'duration_ms', 'text', 'blob', 'uuid',
      ])
      // SQLite defines hex(NULL) as the empty text value.
      return text(false)
    case 'coalesce':
      assertBuiltinArity(expression, 2, Number.MAX_SAFE_INTEGER)
      return inferCoalesceType(expression, types)
    case 'ifnull':
      assertBuiltinArity(expression, 2)
      return inferCoalesceType(expression, types)
    case 'nullif': {
      assertBuiltinArity(expression, 2)
      const logical = commonPolymorphicLogicalType(expression.args, types, expression.id, undefined, expression)
      return { logical, nullable: true }
    }
    case 'if':
    case 'iif': {
      assertBuiltinArity(expression, 2, 64)
      const pairedLength = expression.args.length % 2 === 0
        ? expression.args.length
        : expression.args.length - 1
      const resultExpressions: Expr[] = []
      const resultTypes: ValueType[] = []
      for (let index = 0; index < pairedLength; index += 2) {
        assertBuiltinArgument(expression.args[index]!, types[index]!, ['boolean', 'int64'])
        resultExpressions.push(expression.args[index + 1]!)
        resultTypes.push(types[index + 1]!)
      }
      if (pairedLength !== expression.args.length) {
        resultExpressions.push(expression.args.at(-1)!)
        resultTypes.push(types.at(-1)!)
      }
      return {
        logical: commonPolymorphicLogicalType(
          resultExpressions, resultTypes, expression.id, undefined, expression,
        ),
        nullable: pairedLength === expression.args.length || resultTypes.some((type) => type.nullable),
      }
    }
    case 'likelihood':
      assertBuiltinArity(expression, 2)
      likelihoodProbabilitySql(expression.args[1], expression.id)
      return builtinHintResultType(expression, types[0]!)
    case 'likely':
    case 'unlikely': {
      assertBuiltinArity(expression, 1)
      return builtinHintResultType(expression, types[0]!)
    }
    case 'glob':
    case 'like':
      assertBuiltinArity(expression, 2, expression.name === 'like' ? 3 : 2)
      expression.args.forEach((argument, index) =>
        assertBuiltinArgument(argument, types[index]!, ['text']))
      return { logical: { kind: 'boolean' }, nullable }
    case 'min':
    case 'max': {
      assertBuiltinArity(expression, 2, 64)
      expression.args.forEach((argument, index) =>
        assertBuiltinArgument(argument, types[index]!, [
          'boolean', 'int64', 'timestamp_ms', 'duration_ms', 'text', 'blob', 'uuid',
        ]))
      return {
        logical: commonPolymorphicLogicalType(expression.args, types, expression.id, undefined, expression),
        nullable,
      }
    }
    case 'quote':
    case 'unistr_quote':
      assertBuiltinArity(expression, 1)
      return text(false)
    case 'typeof':
      assertBuiltinArity(expression, 1)
      return text(false)
    case 'unhex':
      assertBuiltinArity(expression, 1, 2)
      expression.args.forEach((argument, index) =>
        assertBuiltinArgument(argument, types[index]!, ['text']))
      // Invalid or odd-length input is reported as NULL rather than an error.
      return blob(true)
    case 'unicode':
      assertBuiltinArity(expression, 1)
      assertBuiltinArgument(expression.args[0]!, types[0]!, ['text'])
      // The empty string has no first code point and returns NULL.
      return integer(true)
    case 'unistr':
      assertBuiltinArity(expression, 1)
      assertBuiltinArgument(expression.args[0]!, types[0]!, ['text'])
      return text(nullable)
    case 'zeroblob':
      assertBuiltinArity(expression, 1)
      assertBuiltinArgument(expression.args[0]!, types[0]!, ['int64'])
      // NULL and negative sizes produce an empty BLOB.
      return blob(false)
    case 'abs':
    case 'sign':
      assertBuiltinArity(expression, 1)
      assertBuiltinArgument(expression.args[0]!, types[0]!, ['int64'])
      return integer(nullable)
  }
}

function builtinHintResultType(
  expression: Extract<Expr, { kind: 'builtin' }>,
  result: ValueType,
): ValueType {
  return result.logical.kind === 'text'
    ? {
        ...result,
        logical: {
          kind: 'text', collation: firstExplicitCollation(expression) ?? 'binary',
        },
      }
    : result
}

/**
 * SQLite requires likelihood()'s second argument to be a floating-point
 * literal, not a bound parameter. Canonical IR stores the exact authored
 * decimal value, so render it as a canonical decimal literal while keeping all
 * application values parameter-bound. This planner-only operand is valid even
 * when application Decimal values are disabled by the execution profile.
 */
function likelihoodProbabilitySql(expression: Expr | undefined, nodeId: number): string {
  if (expression?.kind !== 'literal' || expression.value.kind !== 'decimal') {
    throw new CompilerError('IR_BUILTIN_ARGUMENT_TYPE', nodeId)
  }
  const { coefficient, scale } = expression.value
  if (!Number.isSafeInteger(scale) || scale < 0 || coefficient < 0n ||
      coefficient > 10n ** BigInt(scale)) {
    throw new CompilerError('IR_BUILTIN_ARGUMENT_TYPE', nodeId)
  }
  if (scale === 0) return `${coefficient.toString(10)}.0`
  const digits = coefficient.toString(10).padStart(scale + 1, '0')
  return `${digits.slice(0, -scale)}.${digits.slice(-scale)}`
}

function inferCoalesceType(
  expression: Extract<Expr, { kind: 'builtin' }>,
  types: readonly ValueType[],
): ValueType {
  const logical = commonPolymorphicLogicalType(
    expression.args, types, expression.id, undefined, expression,
  )
  return {
    logical,
    nullable: expression.args.every((argument, index) =>
      isNullLiteral(argument) || types[index]!.nullable),
  }
}

function commonPolymorphicLogicalType(
  expressions: readonly Expr[],
  types: readonly ValueType[],
  nodeId: number,
  mismatchCode = 'IR_BUILTIN_ARGUMENT_TYPE',
  collationExpression?: Expr,
): LogicalType {
  let result: LogicalType | undefined
  expressions.forEach((expression, index) => {
    if (isNullLiteral(expression)) return
    const logical = types[index]!.logical
    if (result === undefined) result = logical
    else if (result.kind === 'text' && logical.kind === 'text') {
      // Collation is comparison metadata, not a different stored value type.
      // SQLite accepts mixed text collations in CASE and polymorphic built-ins.
    } else if (!sameLogicalType(result, logical)) throw new CompilerError(mismatchCode, nodeId)
  })
  if (result?.kind === 'text') {
    return {
      kind: 'text',
      // CASE and function results do not inherit an argument/branch column's
      // implicit collation. An explicit COLLATE anywhere in the expression
      // does propagate, with the syntactically leftmost occurrence winning.
      collation: collationExpression === undefined
        ? 'binary'
        : firstExplicitCollation(collationExpression) ?? 'binary',
    }
  }
  return result ?? { kind: 'blob' }
}

/**
 * SQLite propagates the syntactically leftmost explicit COLLATE through an
 * expression tree, even through an unchosen CASE branch or unused function
 * argument. Implicit column collations do not propagate through those
 * wrappers. Subquery clauses that do not produce the scalar value are a
 * separate expression context and intentionally are not searched here.
 */
function firstExplicitCollation(expression: Expr): CollationId | undefined {
  const first = (expressions: readonly (Expr | undefined)[]): CollationId | undefined => {
    for (const candidate of expressions) {
      if (candidate === undefined) continue
      const collation = firstExplicitCollation(candidate)
      if (collation !== undefined) return collation
    }
    return undefined
  }

  switch (expression.kind) {
    case 'collate': return expression.collation
    case 'unary': return firstExplicitCollation(expression.operand)
    case 'binary': return first([expression.left, expression.right, expression.escape])
    case 'conditional': return first([
      ...expression.branches.flatMap((branch) => [branch.when, branch.then]),
      expression.otherwise,
    ])
    case 'cast': return firstExplicitCollation(expression.value)
    case 'builtin':
    case 'function': return first(expression.args)
    case 'aggregate': return expression.value === undefined
      ? undefined
      : firstExplicitCollation(expression.value)
    case 'json': return first([
      ...expression.args,
      expression.pathExpression,
    ])
    case 'window': return first(expression.args)
    case 'row': return first(expression.items)
    case 'membership': return first([
      expression.value,
      ...(expression.values ?? []),
      expression.query?.projection[0]?.expression,
    ])
    case 'scalar_subquery': return expression.query.projection[0] === undefined
      ? undefined
      : firstExplicitCollation(expression.query.projection[0].expression)
    case 'exists': return undefined
    case 'literal':
    case 'parameter':
    case 'column':
    case 'context':
    case 'old_new':
    case 'entropy': return undefined
  }
}

/** SQLite frame offsets may be bound or computed, but may not vary by row. */
function isStatementConstantFrameOffset(expression: Expr): boolean {
  switch (expression.kind) {
    case 'literal':
    case 'context':
    case 'entropy': return true
    case 'unary': return isStatementConstantFrameOffset(expression.operand)
    case 'binary': return isStatementConstantFrameOffset(expression.left) &&
      isStatementConstantFrameOffset(expression.right) &&
      (expression.escape === undefined || isStatementConstantFrameOffset(expression.escape))
    case 'conditional': return expression.branches.every((branch) =>
      isStatementConstantFrameOffset(branch.when) &&
      isStatementConstantFrameOffset(branch.then)) &&
      isStatementConstantFrameOffset(expression.otherwise)
    case 'cast': return isStatementConstantFrameOffset(expression.value)
    case 'collate': return isStatementConstantFrameOffset(expression.expression)
    case 'builtin':
    case 'function': return expression.args.every(isStatementConstantFrameOffset)
    case 'json': return expression.args.every(isStatementConstantFrameOffset) &&
      (expression.pathExpression === undefined ||
        isStatementConstantFrameOffset(expression.pathExpression))
    case 'parameter':
    case 'column':
    case 'aggregate':
    case 'window':
    case 'row':
    case 'membership':
    case 'scalar_subquery':
    case 'exists':
    case 'old_new': return false
  }
}

const INT64_MIN = -9223372036854775808n
const INT64_MAX = 9223372036854775807n

/** Fold the exact integer subset so SQLite sees a simple constant frame bound. */
function staticInt64Value(expression: Expr): bigint | undefined {
  const inRange = (value: bigint): bigint | undefined =>
    value < INT64_MIN || value > INT64_MAX ? undefined : value
  if (expression.kind === 'literal') {
    return expression.value.kind === 'int64' ? expression.value.value : undefined
  }
  if (expression.kind === 'cast' || expression.kind === 'collate') {
    return staticInt64Value(expression.kind === 'cast' ? expression.value : expression.expression)
  }
  if (expression.kind === 'unary') {
    const value = staticInt64Value(expression.operand)
    if (value === undefined) return undefined
    if (expression.operator === 'negate') return inRange(-value)
    if (expression.operator === 'bit_not') return inRange(~value)
    return undefined
  }
  if (expression.kind !== 'binary') return undefined
  const left = staticInt64Value(expression.left)
  const right = staticInt64Value(expression.right)
  if (left === undefined || right === undefined) return undefined
  switch (expression.operator) {
    case 'add': return inRange(left + right)
    case 'subtract': return inRange(left - right)
    case 'multiply': return inRange(left * right)
    case 'divide': return right === 0n ? undefined : inRange(left / right)
    case 'modulo': return right === 0n ? undefined : inRange(left % right)
    case 'bit_and': return inRange(left & right)
    case 'bit_or': return inRange(left | right)
    case 'bit_xor': return inRange(left ^ right)
    case 'shift_left': {
      if (right < 0n || right > 63n) return undefined
      return inRange(left << right)
    }
    case 'shift_right': {
      if (right < 0n || right > 63n) return undefined
      return inRange(left >> right)
    }
    default: return undefined
  }
}

function assertBuiltinArity(
  expression: Extract<Expr, { kind: 'builtin' }>,
  minimum: number,
  maximum = minimum,
): void {
  if (expression.args.length < minimum || expression.args.length > maximum) {
    throw new CompilerError('IR_BUILTIN_ARITY', expression.id)
  }
}

function assertBuiltinArgument(
  expression: Expr,
  type: ValueType,
  expected: readonly LogicalType['kind'][],
): void {
  if (!isNullLiteral(expression) && !expected.includes(type.logical.kind)) {
    throw new CompilerError('IR_BUILTIN_ARGUMENT_TYPE', expression.id)
  }
}

function assertBinaryTypes(
  expression: Extract<Expr, { kind: 'binary' }>,
  scopes: readonly RelationScope[],
  catalog: Catalog,
  ctes: CteScopes,
  mutationTarget?: RelationScope,
): void {
  if (expression.left.kind === 'row' || expression.right.kind === 'row') {
    inferRowComparisonType(expression, scopes, catalog, ctes, mutationTarget)
    return
  }
  const operandType = (operand: Expr): ValueType =>
    inferExpressionType(operand, scopes, catalog, ctes, mutationTarget)
  const left = operandType(expression.left).logical.kind
  const right = operandType(expression.right).logical.kind
  const leftNull = isNullLiteral(expression.left)
  const rightNull = isNullLiteral(expression.right)
  if (expression.escape !== undefined && expression.operator !== 'like' && expression.operator !== 'not_like') {
    throw new CompilerError('IR_LIKE_ESCAPE_CONTEXT_INVALID', expression.escape.id)
  }
  if (expression.operator === 'and' || expression.operator === 'or') {
    if ((!leftNull && left !== 'boolean') || (!rightNull && right !== 'boolean')) {
      throw new CompilerError('IR_BOOLEAN_OPERAND_REQUIRED', expression.id)
    }
    return
  }
  if (expression.operator === 'concat') {
    if ((!leftNull && left !== 'text') || (!rightNull && right !== 'text')) {
      throw new CompilerError('IR_TEXT_OPERAND_REQUIRED', expression.id)
    }
    return
  }
  if (expression.operator === 'like' || expression.operator === 'not_like' ||
      expression.operator === 'glob' || expression.operator === 'not_glob') {
    if ((!leftNull && left !== 'text') || (!rightNull && right !== 'text')) {
      throw new CompilerError('IR_TEXT_OPERAND_REQUIRED', expression.id)
    }
    if (expression.escape !== undefined && !isNullLiteral(expression.escape) &&
        operandType(expression.escape).logical.kind !== 'text') {
      throw new CompilerError('IR_TEXT_OPERAND_REQUIRED', expression.escape.id)
    }
    return
  }
  if (isCheckedIntegerArithmetic(expression.operator)) {
    checkedArithmeticLogicalType(expression, operandType(expression.left), operandType(expression.right))
    return
  }
  if (['bit_and', 'bit_or', 'bit_xor', 'shift_left', 'shift_right'].includes(expression.operator)) {
    if ((!leftNull && left !== 'int64') || (!rightNull && right !== 'int64')) {
      throw new CompilerError('IR_INTEGER_OPERAND_REQUIRED', expression.id)
    }
    return
  }
  if (expression.operator !== 'is' && expression.operator !== 'is_not' &&
      !leftNull && !rightNull && left !== right) {
    throw new CompilerError('IR_COMPARISON_TYPE_MISMATCH', expression.id)
  }
  if (leftNull || rightNull) return
  if (['lt', 'lte', 'gt', 'gte'].includes(expression.operator) &&
      !['boolean', 'int64', 'timestamp_ms', 'duration_ms', 'text'].includes(left)) {
    throw new CompilerError('IR_ORDER_COMPARISON_UNSUPPORTED', expression.id)
  }
}

function derivedScope(alias: string, columns: readonly ResultColumn[]): RelationScope {
  return {
    alias,
    primaryKeyColumns: null,
    table: {
      kind: 'table',
      id: -1,
      name: alias,
      declarationOrder: -1,
      columns: columns.map((column, declarationOrder) => ({
        id: column.id,
        name: column.name,
        declarationOrder,
        valueType: column.valueType,
      })),
      constraints: [],
      withoutRowId: false,
    },
  }
}

function resolvedColumn(
  scope: RelationScope,
  name: string,
  catalog: Catalog,
  nodeId: number,
): SchemaTable['columns'][number] {
  const column = scope.primaryKeyColumns !== null
    ? catalog.column(scope.table, name)
    : (() => {
        const columns = scope.table.columns.filter((candidate) => sqliteIdentifierEquals(candidate.name, name))
        if (columns.length !== 1) throw new CompilerError(
          columns.length === 0 ? 'IR_UNKNOWN_COLUMN' : 'IR_AMBIGUOUS_COLUMN',
          nodeId,
        )
        return columns[0]!
      })()
  if (scope.nullExtended !== true || column.valueType.nullable) return column
  return { ...column, valueType: { ...column.valueType, nullable: true } }
}

function nearestLexicalScopes(scopes: readonly RelationScope[]): readonly RelationScope[] {
  if (scopes.length < 2) return scopes
  const minimumDepth = scopes.reduce(
    (minimum, scope) => Math.min(minimum, scope.lexicalDepth ?? 0),
    Number.MAX_SAFE_INTEGER,
  )
  return scopes.filter((scope) => (scope.lexicalDepth ?? 0) === minimumDepth)
}

function inferMembershipType(
  expression: Extract<Expr, { kind: 'membership' }>,
  scopes: readonly RelationScope[],
  catalog: Catalog,
  ctes: CteScopes,
  mutationTarget?: RelationScope,
): ValueType {
  if ((expression.values === undefined) === (expression.query === undefined)) {
    throw new CompilerError('IR_MEMBERSHIP_SOURCE_REQUIRED', expression.id)
  }
  const valueTypes = rowValueTypes(expression.value, scopes, catalog, ctes, mutationTarget)
  if (expression.values !== undefined) {
    if (expression.values.length === 0) return { logical: { kind: 'boolean' }, nullable: false }
    assertMembershipValues(expression, scopes, catalog, ctes, mutationTarget)
    return {
      logical: { kind: 'boolean' },
      nullable: valueTypes.some((type) => type.nullable) || expression.values.some((item) =>
        rowValueTypes(item, scopes, catalog, ctes, mutationTarget).some((type) => type.nullable)),
    }
  }
  const rendered = new SqlRenderer(catalog).query(expression.query!, scopes, ctes)
  assertMembershipQuery(expression, rendered.columns, scopes, catalog, ctes, mutationTarget)
  return {
    logical: { kind: 'boolean' },
    nullable: valueTypes.some((type) => type.nullable) || rendered.columns.some((column) => column.valueType.nullable),
  }
}

function assertMembershipValues(
  expression: Extract<Expr, { kind: 'membership' }>,
  scopes: readonly RelationScope[],
  catalog: Catalog,
  ctes: CteScopes,
  mutationTarget?: RelationScope,
): void {
  const expected = rowValueTypes(expression.value, scopes, catalog, ctes, mutationTarget)
  for (const item of expression.values ?? []) {
    const actual = rowValueTypes(item, scopes, catalog, ctes, mutationTarget)
    if (expected.length !== actual.length || expected.some((type, index) =>
      !membershipTypesComparable(type, actual[index]!, rowValueItems(expression.value)[index]!, rowValueItems(item)[index]))) {
      throw new CompilerError('IR_MEMBERSHIP_TYPE_MISMATCH', item.id)
    }
  }
}

function assertMembershipQuery(
  expression: Extract<Expr, { kind: 'membership' }>,
  columns: readonly ResultColumn[],
  scopes: readonly RelationScope[],
  catalog: Catalog,
  ctes: CteScopes,
  mutationTarget?: RelationScope,
): void {
  const expected = rowValueTypes(expression.value, scopes, catalog, ctes, mutationTarget)
  if (columns.length !== expected.length) throw new CompilerError('IR_MEMBERSHIP_QUERY_WIDTH', expression.id)
  if (expected.some((type, index) =>
    !membershipTypesComparable(type, columns[index]!.valueType, rowValueItems(expression.value)[index]!))) {
    throw new CompilerError('IR_MEMBERSHIP_TYPE_MISMATCH', expression.id)
  }
}

function rowValueItems(expression: Expr): readonly Expr[] {
  return expression.kind === 'row' ? expression.items : [expression]
}

function rowValueTypes(
  expression: Expr,
  scopes: readonly RelationScope[],
  catalog: Catalog,
  ctes: CteScopes,
  mutationTarget?: RelationScope,
): readonly ValueType[] {
  const items = rowValueItems(expression)
  if (expression.kind === 'row' && items.length < 2) throw new CompilerError('IR_ROW_VALUE_WIDTH', expression.id)
  return items.map((item) => inferExpressionType(item, scopes, catalog, ctes, mutationTarget))
}

function inferRowComparisonType(
  expression: Extract<Expr, { kind: 'binary' }>,
  scopes: readonly RelationScope[],
  catalog: Catalog,
  ctes: CteScopes,
  mutationTarget?: RelationScope,
): ValueType {
  if (!['eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'is', 'is_not'].includes(expression.operator)) {
    throw new CompilerError('IR_ROW_OPERATOR_UNSUPPORTED', expression.id)
  }
  if (expression.left.kind !== 'row' || expression.right.kind !== 'row') {
    throw new CompilerError('IR_ROW_VALUE_WIDTH', expression.id)
  }
  if (expression.left.items.length !== expression.right.items.length || expression.left.items.length < 2) {
    throw new CompilerError('IR_ROW_VALUE_WIDTH', expression.id)
  }
  const left = rowValueTypes(expression.left, scopes, catalog, ctes, mutationTarget)
  const right = rowValueTypes(expression.right, scopes, catalog, ctes, mutationTarget)
  for (let index = 0; index < left.length; index += 1) {
    const leftExpression = expression.left.items[index]!
    const rightExpression = expression.right.items[index]!
    if (!membershipTypesComparable(left[index]!, right[index]!, leftExpression, rightExpression)) {
      throw new CompilerError('IR_COMPARISON_TYPE_MISMATCH', expression.id)
    }
    if (['lt', 'lte', 'gt', 'gte'].includes(expression.operator) &&
        !isNullLiteral(leftExpression) && !isNullLiteral(rightExpression) &&
        !['boolean', 'int64', 'timestamp_ms', 'duration_ms', 'text'].includes(left[index]!.logical.kind)) {
      throw new CompilerError('IR_ORDER_COMPARISON_UNSUPPORTED', expression.id)
    }
  }
  return {
    logical: { kind: 'boolean' },
    nullable: expression.operator !== 'is' && expression.operator !== 'is_not' &&
      [...left, ...right].some((type) => type.nullable),
  }
}

function membershipTypesComparable(
  left: ValueType,
  right: ValueType,
  leftExpression: Expr,
  rightExpression?: Expr,
): boolean {
  if (leftExpression.kind === 'literal' && leftExpression.value.kind === 'null') return true
  if (rightExpression?.kind === 'literal' && rightExpression.value.kind === 'null') return true
  // SQLite chooses a comparison collation by expression precedence; differing
  // text collations do not make the operands incomparable. Scalar comparison
  // validation likewise uses the logical kind rather than collation identity.
  return left.logical.kind === right.logical.kind
}

/**
 * SQLite scalar subqueries silently discard every row after the first. That
 * behavior cannot be allowed to hide an IR cardinality error. Only shapes
 * which the compiler can prove return at most one row are lowered.
 */
export function isQueryAtMostOneRow(query: Query, catalog: Catalog): boolean {
  if (query.page !== undefined && query.page.limit <= 1) return true
  if (query.compounds.length > 0 || query.joins.length > 0) return false
  if (query.groupBy.length === 0 && queryHasAggregate(query)) return true
  if (query.from === undefined) return true
  if (query.groupBy.length > 0 || query.where === undefined) return false
  if (query.from.kind !== 'table' && query.from.kind !== 'system_relation') return false

  const table = query.from.kind === 'table'
    ? catalog.tableByName(query.from.name)
    : catalog.systemRelation(query.from.relation)
  const alias = query.from.alias ?? table.name
  return isTablePredicateAtMostOneRow(query.where, alias, table, catalog)
}

export function isTablePredicateAtMostOneRow(
  where: Expr,
  alias: string,
  table: SchemaTable,
  catalog: Catalog,
): boolean {
  const constrained = equalityConstrainedColumns(where, alias, table)
  return table.constraints.some((constraint) =>
    (constraint.kind === 'primary_key' || constraint.kind === 'unique') &&
    constraint.columnIds.every((columnId) =>
      constrained.has(sqliteIdentifierKey(catalog.columnById(table, columnId).name))),
  )
}

function equalityConstrainedColumns(
  expression: Expr,
  alias: string,
  table: SchemaTable,
): ReadonlySet<string> {
  const result = new Set<string>()
  for (const predicate of flattenConjunction(expression)) {
    if (predicate.kind !== 'binary' || predicate.operator !== 'eq') continue
    const left = localColumnName(predicate.left, alias, table)
    const right = localColumnName(predicate.right, alias, table)
    if (left !== null && !referencesLocalRelation(predicate.right, alias, table)) result.add(left)
    if (right !== null && !referencesLocalRelation(predicate.left, alias, table)) result.add(right)
  }
  return result
}

function flattenConjunction(expression: Expr): readonly Expr[] {
  if (expression.kind === 'binary' && expression.operator === 'and') {
    return [...flattenConjunction(expression.left), ...flattenConjunction(expression.right)]
  }
  return [expression]
}

function localColumnName(expression: Expr, alias: string, table: SchemaTable): string | null {
  if (expression.kind !== 'column') return null
  if (expression.relation !== undefined && !sqliteIdentifierEquals(expression.relation, alias)) return null
  const column = table.columns.find((candidate) => sqliteIdentifierEquals(candidate.name, expression.name))
  return column === undefined ? null : sqliteIdentifierKey(column.name)
}

function referencesLocalRelation(expression: Expr, alias: string, table: SchemaTable): boolean {
  switch (expression.kind) {
    case 'column':
      return expression.relation === undefined ||
        sqliteIdentifierEquals(expression.relation, alias)
    case 'unary': return referencesLocalRelation(expression.operand, alias, table)
    case 'binary': return referencesLocalRelation(expression.left, alias, table) ||
      referencesLocalRelation(expression.right, alias, table) ||
      (expression.escape !== undefined && referencesLocalRelation(expression.escape, alias, table))
    case 'conditional': return expression.branches.some((branch) =>
      referencesLocalRelation(branch.when, alias, table) ||
      referencesLocalRelation(branch.then, alias, table)) ||
      referencesLocalRelation(expression.otherwise, alias, table)
    case 'cast': return referencesLocalRelation(expression.value, alias, table)
    case 'collate': return referencesLocalRelation(expression.expression, alias, table)
    case 'builtin':
    case 'function': return expression.args.some((argument) => referencesLocalRelation(argument, alias, table))
    case 'aggregate': return (expression.value !== undefined && referencesLocalRelation(expression.value, alias, table)) ||
      (expression.filter !== undefined && referencesLocalRelation(expression.filter, alias, table)) ||
      (expression.orderBy?.some((term) => referencesLocalRelation(term.expression, alias, table)) ?? false)
    case 'json': return expression.args.some((argument) => referencesLocalRelation(argument, alias, table)) ||
      (expression.pathExpression !== undefined && referencesLocalRelation(expression.pathExpression, alias, table))
    case 'row': return expression.items.some((item) => referencesLocalRelation(item, alias, table))
    case 'window': return expression.args.some((item) => referencesLocalRelation(item, alias, table)) ||
      (expression.filter !== undefined && referencesLocalRelation(expression.filter, alias, table)) ||
      (typeof expression.window !== 'string' && windowExpressions(expression.window)
        .some((item) => referencesLocalRelation(item, alias, table)))
    case 'membership': return referencesLocalRelation(expression.value, alias, table) ||
      (expression.values?.some((item) => referencesLocalRelation(item, alias, table)) ?? false) ||
      expression.query !== undefined
    case 'scalar_subquery':
    case 'exists': return true
    case 'old_new': return true
    case 'literal':
    case 'parameter':
    case 'context':
    case 'entropy': return false
  }
}

function inferAggregateType(
  expression: Extract<Expr, { kind: 'aggregate' }>,
  scopes: readonly RelationScope[],
  catalog: Catalog,
  ctes: CteScopes,
): ValueType {
  for (const term of expression.orderBy ?? []) {
    if (containsAggregate(term.expression) || containsWindow(term.expression)) {
      throw new CompilerError('IR_AGGREGATE_ORDER_CONTEXT_INVALID', term.id)
    }
    inferExpressionType(term.expression, scopes, catalog, ctes)
  }
  if (expression.filter !== undefined) {
    if (containsAggregate(expression.filter)) throw new CompilerError('IR_NESTED_AGGREGATE', expression.filter.id)
    const filter = inferExpressionType(expression.filter, scopes, catalog, ctes)
    if (!isNullLiteral(expression.filter) && filter.logical.kind !== 'boolean') {
      throw new CompilerError('IR_AGGREGATE_FILTER_BOOLEAN_REQUIRED', expression.filter.id)
    }
  }
  if (expression.value === undefined) {
    if (expression.operation !== 'count' || expression.distinct) {
      throw new CompilerError('IR_AGGREGATE_ARGUMENT_REQUIRED', expression.id)
    }
    return { logical: { kind: 'int64' }, nullable: false }
  }
  if (containsAggregate(expression.value)) throw new CompilerError('IR_NESTED_AGGREGATE', expression.id)
  const input = inferExpressionType(expression.value, scopes, catalog, ctes)
  if (expression.operation === 'count') {
    if (expression.distinct && input.logical.kind === 'text' && input.logical.collation.startsWith('registered:')) {
      throw new CompilerError('IR_AGGREGATE_COLLATION_UNSUPPORTED', expression.id)
    }
    return { logical: { kind: 'int64' }, nullable: false }
  }
  if (expression.operation === 'every' || expression.operation === 'any') {
    if (!isNullLiteral(expression.value) && input.logical.kind !== 'boolean') {
      throw new CompilerError('IR_AGGREGATE_TYPE_UNSUPPORTED', expression.id)
    }
    return { logical: { kind: 'boolean' }, nullable: true }
  }
  if (expression.operation !== 'min' && expression.operation !== 'max') {
    throw new CompilerError('IR_AGGREGATE_UNSUPPORTED', expression.id)
  }
  if (hasNonbinaryTextCollation(input)) {
    throw new CompilerError('IR_AGGREGATE_COLLATION_REPRESENTATIVE_REQUIRED', expression.id)
  }
  const supported = input.logical.kind === 'boolean' || input.logical.kind === 'int64' ||
    input.logical.kind === 'timestamp_ms' || input.logical.kind === 'duration_ms' ||
    input.logical.kind === 'blob' || input.logical.kind === 'uuid' ||
    (input.logical.kind === 'text' && !input.logical.collation.startsWith('registered:'))
  if (!supported) throw new CompilerError('IR_AGGREGATE_TYPE_UNSUPPORTED', expression.id)
  return {
    logical: input.logical.kind === 'text'
      ? { kind: 'text', collation: firstExplicitCollation(expression) ?? 'binary' }
      : input.logical,
    nullable: true,
  }
}

function inferWindowType(
  expression: Extract<Expr, { kind: 'window' }>,
  scopes: readonly RelationScope[],
  catalog: Catalog,
  ctes: CteScopes,
  mutationTarget?: RelationScope,
): ValueType {
  const types = expression.args.map((argument) =>
    inferExpressionType(argument, scopes, catalog, ctes, mutationTarget))
  if (expression.filter !== undefined) {
    const filter = inferExpressionType(expression.filter, scopes, catalog, ctes, mutationTarget)
    if (!isNullLiteral(expression.filter) && filter.logical.kind !== 'boolean') {
      throw new CompilerError('IR_WINDOW_FILTER_BOOLEAN_REQUIRED', expression.filter.id)
    }
  }
  if (expression.operation === 'row_number' || expression.operation === 'rank' ||
      expression.operation === 'dense_rank') {
    if (expression.args.length !== 0 || expression.filter !== undefined) {
      throw new CompilerError('IR_WINDOW_ARITY', expression.id)
    }
    return { logical: { kind: 'int64' }, nullable: false }
  }
  if (expression.operation === 'ntile') {
    if (expression.args.length !== 1 || types[0]!.logical.kind !== 'int64') {
      throw new CompilerError('IR_WINDOW_ARITY', expression.id)
    }
    return { logical: { kind: 'int64' }, nullable: false }
  }
  if (expression.operation === 'lag' || expression.operation === 'lead') {
    if (expression.args.length < 1 || expression.args.length > 3) {
      throw new CompilerError('IR_WINDOW_ARITY', expression.id)
    }
    if (types[1] !== undefined && types[1].logical.kind !== 'int64') {
      throw new CompilerError('IR_WINDOW_OFFSET_TYPE', expression.args[1]!.id)
    }
    if (types[2] !== undefined && !logicalValueTypeCompatible(types[2], types[0]!)) {
      throw new CompilerError('IR_WINDOW_DEFAULT_TYPE', expression.args[2]!.id)
    }
    if (expression.filter !== undefined) throw new CompilerError('IR_WINDOW_FILTER_UNSUPPORTED', expression.id)
    const result = types[0]!.logical
    return {
      logical: result.kind === 'text'
        ? { kind: 'text', collation: firstExplicitCollation(expression) ?? 'binary' }
        : result,
      nullable: expression.args.length < 3 || types[0]!.nullable || types[2]!.nullable,
    }
  }
  const aggregate: Extract<Expr, { kind: 'aggregate' }> = {
    kind: 'aggregate', id: expression.id, operation: expression.operation,
    distinct: false,
    ...(expression.args[0] === undefined ? {} : { value: expression.args[0] }),
    ...(expression.filter === undefined ? {} : { filter: expression.filter }),
  }
  if (expression.args.length > 1) throw new CompilerError('IR_WINDOW_ARITY', expression.id)
  return inferAggregateType(aggregate, scopes, catalog, ctes)
}

interface GroupingContext {
  readonly scopes: readonly RelationScope[]
  readonly catalog: Catalog
  readonly windows?: Query['windows']
}

function assertAggregateQueryShape(
  query: Query,
  scopes: readonly RelationScope[],
  catalog: Catalog,
): void {
  for (const join of query.joins) {
    if (join.on !== undefined && containsWindow(join.on)) {
      throw new CompilerError('IR_WINDOW_CONTEXT_INVALID', join.on.id)
    }
  }
  for (const expression of [query.where, query.having, ...query.groupBy]) {
    if (expression !== undefined && containsWindow(expression)) {
      throw new CompilerError('IR_WINDOW_CONTEXT_INVALID', expression.id)
    }
  }
  for (const window of query.windows) {
    for (const expression of windowExpressions(window)) {
      if (containsWindow(expression)) throw new CompilerError('IR_NESTED_WINDOW', expression.id)
    }
  }
  for (const projection of query.projection) assertWindowNesting(projection.expression)
  for (const term of query.orderBy) assertWindowNesting(term.expression)

  if (query.where !== undefined && containsAggregate(query.where)) {
    throw new CompilerError('IR_AGGREGATE_CONTEXT_INVALID', query.where.id)
  }
  for (const join of query.joins) {
    if (join.on !== undefined && containsAggregate(join.on)) {
      throw new CompilerError('IR_AGGREGATE_CONTEXT_INVALID', join.on.id)
    }
  }
  for (const expression of query.groupBy) {
    if (containsAggregate(expression)) throw new CompilerError('IR_AGGREGATE_CONTEXT_INVALID', expression.id)
  }

  const grouped = query.groupBy.length > 0 || queryHasAggregate(query)
  if (query.having !== undefined && !grouped) {
    throw new CompilerError('IR_HAVING_WITHOUT_GROUP', query.having.id)
  }
  if (!grouped) return
  const context = { scopes, catalog, windows: query.windows }
  for (const expression of query.groupBy) {
    if (hasNonbinaryTextCollation(inferExpressionType(expression, scopes, catalog))) {
      throw new CompilerError('IR_GROUP_COLLATION_REPRESENTATIVE_REQUIRED', expression.id)
    }
  }
  for (const projection of query.projection) {
    if (!isGroupCompatible(projection.expression, query.groupBy, context)) {
      throw new CompilerError('IR_BARE_COLUMN_OUTSIDE_GROUP', projection.expression.id)
    }
  }
  if (query.having !== undefined && !isGroupCompatible(query.having, query.groupBy, context)) {
    throw new CompilerError('IR_BARE_COLUMN_OUTSIDE_GROUP', query.having.id)
  }
  for (const term of query.orderBy) {
    if (!isGroupCompatible(term.expression, query.groupBy, context)) {
      throw new CompilerError('IR_BARE_COLUMN_OUTSIDE_GROUP', term.expression.id)
    }
  }
}

function queryHasAggregate(query: Query): boolean {
  return query.projection.some((projection) => containsAggregate(projection.expression)) ||
    (query.having !== undefined && containsAggregate(query.having)) ||
    query.orderBy.some((term) => containsAggregate(term.expression)) ||
    query.windows.some((window) => windowExpressions(window).some(containsAggregate))
}

/** Aggregate calls in nested queries belong to that nested query, not this expression level. */
function containsAggregate(expression: Expr): boolean {
  switch (expression.kind) {
    case 'aggregate': return true
    case 'unary': return containsAggregate(expression.operand)
    case 'binary': return containsAggregate(expression.left) || containsAggregate(expression.right) ||
      (expression.escape !== undefined && containsAggregate(expression.escape))
    case 'conditional': return expression.branches.some((branch) =>
      containsAggregate(branch.when) || containsAggregate(branch.then)) || containsAggregate(expression.otherwise)
    case 'cast': return containsAggregate(expression.value)
    case 'collate': return containsAggregate(expression.expression)
    case 'builtin':
    case 'function': return expression.args.some(containsAggregate)
    case 'json': return expression.args.some(containsAggregate) ||
      (expression.pathExpression !== undefined && containsAggregate(expression.pathExpression))
    case 'row': return expression.items.some(containsAggregate)
    case 'window': return expression.args.some(containsAggregate) ||
      (expression.filter !== undefined && containsAggregate(expression.filter)) ||
      (typeof expression.window !== 'string' && windowExpressions(expression.window).some(containsAggregate))
    case 'membership': return containsAggregate(expression.value) ||
      (expression.values?.some(containsAggregate) ?? false)
    case 'scalar_subquery':
    case 'exists':
    case 'literal':
    case 'parameter':
    case 'column':
    case 'context':
    case 'old_new':
    case 'entropy': return false
  }
}

/** Window calls in nested SELECTs belong to that nested query level. */
function containsWindow(expression: Expr): boolean {
  switch (expression.kind) {
    case 'window': return true
    case 'unary': return containsWindow(expression.operand)
    case 'binary': return containsWindow(expression.left) || containsWindow(expression.right) ||
      (expression.escape !== undefined && containsWindow(expression.escape))
    case 'conditional': return expression.branches.some((branch) =>
      containsWindow(branch.when) || containsWindow(branch.then)) || containsWindow(expression.otherwise)
    case 'cast': return containsWindow(expression.value)
    case 'collate': return containsWindow(expression.expression)
    case 'builtin':
    case 'function': return expression.args.some(containsWindow)
    case 'aggregate': return (expression.value !== undefined && containsWindow(expression.value)) ||
      (expression.filter !== undefined && containsWindow(expression.filter)) ||
      (expression.orderBy?.some((term) => containsWindow(term.expression)) ?? false)
    case 'json': return expression.args.some(containsWindow) ||
      (expression.pathExpression !== undefined && containsWindow(expression.pathExpression))
    case 'row': return expression.items.some(containsWindow)
    case 'membership': return containsWindow(expression.value) ||
      (expression.values?.some(containsWindow) ?? false)
    case 'scalar_subquery':
    case 'exists':
    case 'literal':
    case 'parameter':
    case 'column':
    case 'context':
    case 'old_new':
    case 'entropy': return false
  }
}

function assertWindowNesting(expression: Expr, windowProhibited = false): void {
  switch (expression.kind) {
    case 'window':
      if (windowProhibited) throw new CompilerError('IR_NESTED_WINDOW', expression.id)
      for (const argument of expression.args) assertWindowNesting(argument, true)
      if (expression.filter !== undefined) assertWindowNesting(expression.filter, true)
      if (typeof expression.window !== 'string') {
        for (const item of windowExpressions(expression.window)) assertWindowNesting(item, true)
      }
      return
    case 'aggregate':
      if (expression.value !== undefined) assertWindowNesting(expression.value, true)
      if (expression.filter !== undefined) assertWindowNesting(expression.filter, true)
      for (const term of expression.orderBy ?? []) assertWindowNesting(term.expression, true)
      return
    case 'unary': assertWindowNesting(expression.operand, windowProhibited); return
    case 'binary':
      assertWindowNesting(expression.left, windowProhibited)
      assertWindowNesting(expression.right, windowProhibited)
      if (expression.escape !== undefined) assertWindowNesting(expression.escape, windowProhibited)
      return
    case 'conditional':
      for (const branch of expression.branches) {
        assertWindowNesting(branch.when, windowProhibited)
        assertWindowNesting(branch.then, windowProhibited)
      }
      assertWindowNesting(expression.otherwise, windowProhibited)
      return
    case 'cast': assertWindowNesting(expression.value, windowProhibited); return
    case 'collate': assertWindowNesting(expression.expression, windowProhibited); return
    case 'builtin':
    case 'function': for (const argument of expression.args) assertWindowNesting(argument, windowProhibited); return
    case 'json':
      for (const argument of expression.args) assertWindowNesting(argument, windowProhibited)
      if (expression.pathExpression !== undefined) assertWindowNesting(expression.pathExpression, windowProhibited)
      return
    case 'row': for (const item of expression.items) assertWindowNesting(item, windowProhibited); return
    case 'membership':
      assertWindowNesting(expression.value, windowProhibited)
      for (const value of expression.values ?? []) assertWindowNesting(value, windowProhibited)
      return
    case 'scalar_subquery':
    case 'exists':
    case 'literal':
    case 'parameter':
    case 'column':
    case 'context':
    case 'old_new':
    case 'entropy': return
  }
}

function isGroupCompatible(
  expression: Expr,
  groupBy: readonly Expr[],
  context: GroupingContext,
): boolean {
  if (groupBy.some((group) => sameGroupingExpression(expression, group, context))) return true
  switch (expression.kind) {
    case 'aggregate': return true
    case 'literal':
    case 'parameter':
    case 'context':
    case 'entropy': return true
    case 'unary': return isGroupCompatible(expression.operand, groupBy, context)
    case 'binary': return isGroupCompatible(expression.left, groupBy, context) &&
      isGroupCompatible(expression.right, groupBy, context) &&
      (expression.escape === undefined || isGroupCompatible(expression.escape, groupBy, context))
    case 'conditional': return expression.branches.every((branch) =>
      isGroupCompatible(branch.when, groupBy, context) && isGroupCompatible(branch.then, groupBy, context)) &&
      isGroupCompatible(expression.otherwise, groupBy, context)
    case 'cast': return isGroupCompatible(expression.value, groupBy, context)
    case 'collate': return isGroupCompatible(expression.expression, groupBy, context)
    case 'builtin':
    case 'function': return expression.args.every((argument) => isGroupCompatible(argument, groupBy, context))
    case 'json': return expression.args.every((argument) => isGroupCompatible(argument, groupBy, context)) &&
      (expression.pathExpression === undefined || isGroupCompatible(expression.pathExpression, groupBy, context))
    case 'row': return expression.items.every((item) => isGroupCompatible(item, groupBy, context))
    case 'window': return expression.args.every((item) => isGroupCompatible(item, groupBy, context)) &&
      (expression.filter === undefined || isGroupCompatible(expression.filter, groupBy, context)) &&
      groupingWindowExpressions(expression.window, context.windows ?? [])
        .every((item) => isGroupCompatible(item, groupBy, context))
    case 'membership': return expression.query === undefined &&
      isGroupCompatible(expression.value, groupBy, context) &&
      (expression.values?.every((value) => isGroupCompatible(value, groupBy, context)) ?? false)
    case 'column': return isFunctionallyGrouped(expression, groupBy, context)
    case 'old_new':
    case 'scalar_subquery':
    case 'exists': return false
  }
}

function isFunctionallyGrouped(
  expression: Extract<Expr, { kind: 'column' }>,
  groupBy: readonly Expr[],
  context: GroupingContext,
): boolean {
  const resolved = resolveGroupingColumn(expression, context)
  if (resolved === null || resolved.scope.primaryKeyColumns === null) return false

  const candidateKeys: readonly (readonly SchemaTable['columns'][number][])[] =
    resolved.scope.primaryKeyColumns === undefined
      ? resolved.scope.table.constraints.flatMap((constraint) => {
          if (constraint.kind !== 'primary_key' && constraint.kind !== 'unique') return []
          const columns = constraint.columnIds.map((columnId) =>
            context.catalog.columnById(resolved.scope.table, columnId))
          return columns.every((column) => !column.valueType.nullable) ? [columns] : []
        })
      : [resolved.scope.primaryKeyColumns.map((name) =>
          resolved.scope.table.columns.find((column) => sqliteIdentifierEquals(column.name, name)))
          .filter((column): column is SchemaTable['columns'][number] => column !== undefined)]

  return candidateKeys.some((key) => key.length > 0 && key.every((keyColumn) =>
    groupBy.some((group) => {
      if (group.kind !== 'column') return false
      const grouped = resolveGroupingColumn(group, context)
      return grouped !== null && grouped.scope === resolved.scope && grouped.column === keyColumn
    })))
}

function resolveGroupingColumn(
  expression: Extract<Expr, { kind: 'column' }>,
  context: GroupingContext,
): { readonly scope: RelationScope; readonly column: SchemaTable['columns'][number] } | null {
  const candidates = nearestLexicalScopes(context.scopes.filter((scope) =>
    (expression.relation === undefined || sqliteIdentifierEquals(expression.relation, scope.alias)) &&
    scope.table.columns.some((column) => sqliteIdentifierEquals(column.name, expression.name))))
  if (candidates.length !== 1) return null
  const scope = candidates[0]!
  return { scope, column: resolvedColumn(scope, expression.name, context.catalog, expression.id) }
}

function sameGroupingExpression(left: Expr, right: Expr, context?: GroupingContext): boolean {
  if (left.kind !== right.kind) return false
  switch (left.kind) {
    case 'column': {
      const candidate = right as Extract<Expr, { kind: 'column' }>
      if (context !== undefined) {
        const resolvedLeft = resolveGroupingColumn(left, context)
        const resolvedRight = resolveGroupingColumn(candidate, context)
        if (resolvedLeft !== null && resolvedRight !== null) {
          return resolvedLeft.scope === resolvedRight.scope && resolvedLeft.column === resolvedRight.column
        }
      }
      return sqliteIdentifierEquals(left.name, candidate.name) &&
        ((left.relation === undefined && candidate.relation === undefined) ||
          (left.relation !== undefined && candidate.relation !== undefined && sqliteIdentifierEquals(left.relation, candidate.relation)))
    }
    case 'context': return left.field === (right as typeof left).field
    case 'parameter': return left.name === (right as typeof left).name
    case 'entropy': {
      const candidate = right as typeof left
      return left.label === candidate.label && left.index === candidate.index && left.length === candidate.length
    }
    case 'unary': {
      const candidate = right as typeof left
      return left.operator === candidate.operator && sameGroupingExpression(left.operand, candidate.operand, context)
    }
    case 'binary': {
      const candidate = right as typeof left
      return left.operator === candidate.operator && sameGroupingExpression(left.left, candidate.left, context) &&
        sameGroupingExpression(left.right, candidate.right, context) &&
        ((left.escape === undefined && candidate.escape === undefined) ||
          (left.escape !== undefined && candidate.escape !== undefined &&
            sameGroupingExpression(left.escape, candidate.escape, context)))
    }
    case 'cast': {
      const candidate = right as typeof left
      return sameLogicalType(left.target, candidate.target) && sameGroupingExpression(left.value, candidate.value, context)
    }
    case 'collate': {
      const candidate = right as typeof left
      return left.collation === candidate.collation &&
        sameGroupingExpression(left.expression, candidate.expression, context)
    }
    case 'builtin': {
      const candidate = right as typeof left
      return left.name === candidate.name && sameExpressionList(left.args, candidate.args, context)
    }
    case 'function': {
      const candidate = right as typeof left
      return left.functionId === candidate.functionId && sameExpressionList(left.args, candidate.args, context)
    }
    case 'json': {
      const candidate = right as typeof left
      return left.operation === candidate.operation && left.path === candidate.path &&
        ((left.pathExpression === undefined && candidate.pathExpression === undefined) ||
          (left.pathExpression !== undefined && candidate.pathExpression !== undefined &&
            sameGroupingExpression(left.pathExpression, candidate.pathExpression, context))) &&
        sameExpressionList(left.args, candidate.args, context)
    }
    case 'conditional': {
      const candidate = right as typeof left
      return left.branches.length === candidate.branches.length && left.branches.every((branch, index) =>
        sameGroupingExpression(branch.when, candidate.branches[index]!.when, context) &&
        sameGroupingExpression(branch.then, candidate.branches[index]!.then, context)) &&
        sameGroupingExpression(left.otherwise, candidate.otherwise, context)
    }
    case 'membership': {
      const candidate = right as typeof left
      return left.negated === candidate.negated && left.query === undefined && candidate.query === undefined &&
        sameGroupingExpression(left.value, candidate.value, context) &&
        sameExpressionList(left.values ?? [], candidate.values ?? [], context)
    }
    case 'row': return sameExpressionList(left.items, (right as typeof left).items, context)
    case 'window': {
      const candidate = right as typeof left
      if (left.operation !== candidate.operation ||
          !sameExpressionList(left.args, candidate.args, context) ||
          !sameOptionalExpression(left.filter, candidate.filter, context)) return false
      if (typeof left.window === 'string' || typeof candidate.window === 'string') {
        return typeof left.window === 'string' && typeof candidate.window === 'string' &&
          sqliteIdentifierEquals(left.window, candidate.window)
      }
      return sameWindowSpecification(left.window, candidate.window, context)
    }
    case 'literal': return false
    case 'aggregate':
    case 'scalar_subquery':
    case 'exists':
    case 'old_new': return false
  }
}

function sameExpressionList(
  left: readonly Expr[],
  right: readonly Expr[],
  context?: GroupingContext,
): boolean {
  return left.length === right.length && left.every((expression, index) =>
    sameGroupingExpression(expression, right[index]!, context))
}

function sameOptionalExpression(
  left: Expr | undefined,
  right: Expr | undefined,
  context?: GroupingContext,
): boolean {
  return left === undefined
    ? right === undefined
    : right !== undefined && sameGroupingExpression(left, right, context)
}

function windowExpressions(window: WindowSpecification): readonly Expr[] {
  const offsets = [window.frame?.start, window.frame?.end].flatMap((bound) =>
    bound?.type === 'preceding' || bound?.type === 'following' ? [bound.offset] : [])
  return [...window.partitionBy, ...window.orderBy.map((term) => term.expression), ...offsets]
}

function groupingWindowExpressions(
  window: string | WindowSpecification,
  definitions: Query['windows'],
  seen: ReadonlySet<string> = new Set(),
): readonly Expr[] {
  const specification = typeof window === 'string'
    ? definitions.find((candidate) => sqliteIdentifierEquals(candidate.name, window))
    : window
  if (specification === undefined) throw new CompilerError('IR_WINDOW_NOT_FOUND')
  const local = windowExpressions(specification)
  if (specification.base === undefined) return local
  const key = sqliteIdentifierKey(specification.base)
  if (seen.has(key)) throw new CompilerError('IR_WINDOW_BASE_CYCLE')
  return [
    ...groupingWindowExpressions(specification.base, definitions, new Set([...seen, key])),
    ...local,
  ]
}

function windowBoundRank(bound: WindowFrameBound): number {
  if (bound.type === 'unbounded_preceding') return 0
  if (bound.type === 'preceding') return 1
  if (bound.type === 'current_row') return 2
  if (bound.type === 'following') return 3
  return 4
}

function withoutWindowFrame(window: WindowSpecification): WindowSpecification {
  const { frame: _frame, ...specification } = window
  return specification
}

function sameWindowSpecification(
  left: WindowSpecification,
  right: WindowSpecification,
  context?: GroupingContext,
): boolean {
  if ((left.base === undefined) !== (right.base === undefined) ||
      (left.base !== undefined && right.base !== undefined && !sqliteIdentifierEquals(left.base, right.base)) ||
      !sameExpressionList(left.partitionBy, right.partitionBy, context) ||
      left.orderBy.length !== right.orderBy.length ||
      !left.orderBy.every((term, index) => {
        const candidate = right.orderBy[index]!
        return term.direction === candidate.direction && term.nulls === candidate.nulls &&
          sameGroupingExpression(term.expression, candidate.expression, context)
      })) return false
  if (left.frame === undefined || right.frame === undefined) return left.frame === right.frame
  return left.frame.mode === right.frame.mode && left.frame.exclude === right.frame.exclude &&
    sameWindowBound(left.frame.start, right.frame.start, context) &&
    (left.frame.end === undefined
      ? right.frame.end === undefined
      : right.frame.end !== undefined && sameWindowBound(left.frame.end, right.frame.end, context))
}

function sameWindowBound(
  left: WindowFrameBound,
  right: WindowFrameBound,
  context?: GroupingContext,
): boolean {
  if (left.type !== right.type) return false
  return left.type !== 'preceding' && left.type !== 'following'
    ? true
    : (right.type === 'preceding' || right.type === 'following') &&
      sameGroupingExpression(left.offset, right.offset, context)
}

function inferJsonType(
  expression: Extract<Expr, { kind: 'json' }>,
  scopes: readonly RelationScope[],
  catalog: Catalog,
  ctes: CteScopes,
  mutationTarget?: RelationScope,
): ValueType {
  if (!catalog.manifest.features.json) throw new CompilerError('JSON_FEATURE_DISABLED', expression.id)
  if (expression.path !== undefined && expression.pathExpression !== undefined) {
    throw new CompilerError('IR_JSON_PATH_AMBIGUOUS', expression.id)
  }
  if (expression.pathExpression !== undefined) {
    const path = inferExpressionType(expression.pathExpression, scopes, catalog, ctes, mutationTarget)
    if (path.logical.kind !== 'text') throw new CompilerError('IR_JSON_PATH_TYPE', expression.pathExpression.id)
  }
  if (expression.operation === 'type') {
    if (expression.args.length !== 1) throw new CompilerError('IR_JSON_ARITY', expression.id)
    const input = inferExpressionType(expression.args[0]!, scopes, catalog, ctes, mutationTarget)
    if (input.logical.kind !== 'json') throw new CompilerError('IR_JSON_ARGUMENT_TYPE', expression.args[0]!.id)
    return {
      logical: { kind: 'text', collation: firstExplicitCollation(expression) ?? 'binary' },
      nullable: true,
    }
  }
  if (expression.operation === 'extract') {
    if (expression.args.length !== 1) throw new CompilerError('IR_JSON_ARITY', expression.id)
    const input = inferExpressionType(expression.args[0]!, scopes, catalog, ctes, mutationTarget)
    if (input.logical.kind !== 'json') throw new CompilerError('IR_JSON_ARGUMENT_TYPE', expression.args[0]!.id)
    if (expression.path === undefined && expression.pathExpression === undefined) {
      throw new CompilerError('IR_JSON_PATH_REQUIRED', expression.id)
    }
    return { logical: { kind: 'json' }, nullable: true }
  }
  if (expression.operation === 'object' && expression.args.length % 2 !== 0) {
    throw new CompilerError('IR_JSON_OBJECT_ARITY', expression.id)
  }
  if (expression.operation === 'merge' && expression.args.length !== 2) {
    throw new CompilerError('IR_JSON_ARITY', expression.id)
  }
  return { logical: { kind: 'json' }, nullable: false }
}

function assertCompoundColumns(
  left: readonly ResultColumn[],
  right: readonly ResultColumn[],
  leftUntypedNull: readonly boolean[],
  rightUntypedNull: readonly boolean[],
  operator: CompoundTerm['operator'],
  nodeId: number,
): void {
  if (left.length !== right.length) throw new CompilerError('IR_COMPOUND_WIDTH_MISMATCH', nodeId)
  for (let index = 0; index < left.length; index += 1) {
    const leftLogical = left[index]!.valueType.logical
    const rightLogical = right[index]!.valueType.logical
    const unionAllTextCollationDifference = operator === 'union_all' &&
      leftLogical.kind === 'text' && rightLogical.kind === 'text'
    if (!leftUntypedNull[index] && !rightUntypedNull[index] &&
        !sameLogicalType(leftLogical, rightLogical) && !unionAllTextCollationDifference) {
      throw new CompilerError('IR_COMPOUND_TYPE_MISMATCH', nodeId)
    }
  }
}

function isQueryColumnStaticallyUntypedNull(query: Query, index: number): boolean {
  const projection = query.projection[index]
  return projection !== undefined && isStaticallyUntypedNull(projection.expression) &&
    query.compounds.every((compound) => isQueryColumnStaticallyUntypedNull(compound.query, index))
}

function isStaticallyUntypedNull(expression: Expr): boolean {
  if (isNullLiteral(expression)) return true
  if (expression.kind === 'conditional') {
    return expression.branches.every((branch) => isStaticallyUntypedNull(branch.then)) &&
      isStaticallyUntypedNull(expression.otherwise)
  }
  return expression.kind === 'builtin' &&
    (expression.name === 'coalesce' || expression.name === 'ifnull') &&
    expression.args.every(isStaticallyUntypedNull)
}

function isNullLiteral(expression: Expr): boolean {
  return expression.kind === 'literal' && expression.value.kind === 'null'
}

export function valueTypeAssignable(actual: ValueType, expected: ValueType, expression?: Expr): boolean {
  if (expression !== undefined && isNullLiteral(expression)) return expected.nullable
  return logicalValueTypeCompatible(actual, expected) && (!actual.nullable || expected.nullable)
}

/** Logical assignment compatibility when runtime constraints own nullability. */
export function logicalValueTypeCompatible(actual: ValueType, expected: ValueType): boolean {
  if (actual.logical.kind === 'text' && expected.logical.kind === 'text') return true
  return sameLogicalType(actual.logical, expected.logical)
}

function sameLogicalType(left: LogicalType, right: LogicalType): boolean {
  if (left.kind !== right.kind) return false
  switch (left.kind) {
    case 'decimal': return right.kind === 'decimal' && left.precision === right.precision && left.scale === right.scale
    case 'text': return right.kind === 'text' && left.collation === right.collation
    case 'blob': return right.kind === 'blob' && left.maxBytes === right.maxBytes
    case 'vector': return right.kind === 'vector' && left.element === right.element && left.dimensions === right.dimensions
    default: return true
  }
}

function assertCastSupported(source: ValueType, target: LogicalType, nodeId: number): void {
  if (sameLogicalType(source.logical, target)) return
  if (source.logical.kind === 'text' && target.kind === 'text') return
  if (source.logical.kind === 'uuid' && target.kind === 'blob') return
  if ((source.logical.kind === 'boolean' || source.logical.kind === 'int64' ||
      source.logical.kind === 'timestamp_ms' || source.logical.kind === 'duration_ms') &&
      target.kind === 'text') return
  if (source.logical.kind === 'boolean' && target.kind === 'int64') return
  if ((source.logical.kind === 'timestamp_ms' || source.logical.kind === 'duration_ms') && target.kind === 'int64') return
  if (source.logical.kind === 'int64' && target.kind === 'duration_ms') return
  if (source.logical.kind === 'text' && target.kind === 'blob') return
  throw new CompilerError('IR_CAST_UNSUPPORTED', nodeId)
}

function quoteString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

function compareUtf8(left: string, right: string): number {
  const encoder = new TextEncoder()
  const leftBytes = encoder.encode(left)
  const rightBytes = encoder.encode(right)
  const length = Math.min(leftBytes.length, rightBytes.length)
  for (let index = 0; index < length; index += 1) {
    if (leftBytes[index] !== rightBytes[index]) return leftBytes[index]! - rightBytes[index]!
  }
  return leftBytes.length - rightBytes.length
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

function queryReferencesCte(query: Query, name: string): boolean {
  return countQueryCteReferences(query, name) > 0
}

function recursiveAnchorCompounds(query: Query, name: string): Query['compounds'] {
  const anchors = []
  for (const compound of query.compounds) {
    if (queryReferencesCte(compound.query, name)) break
    anchors.push(compound)
  }
  return anchors
}

function validateRecursiveCte(query: Query, name: string, nodeId: number): void {
  const anchorReferences = recursiveCoreReferences(query, name)
  if (anchorReferences.total !== 0) {
    throw new CompilerError('IR_RECURSIVE_CTE_ANCHOR_REFERENCE', nodeId)
  }
  let recursiveOperator: 'union' | 'union_all' | undefined
  for (const compound of query.compounds) {
    if (compound.query.compounds.length > 0 || compound.query.ctes.length > 0 ||
        compound.query.orderBy.length > 0 || compound.query.page !== undefined) {
      throw new CompilerError('IR_RECURSIVE_CTE_ARM_SHAPE', compound.id)
    }
    const references = recursiveCoreReferences(compound.query, name)
    if (references.total === 0) {
      if (recursiveOperator !== undefined) {
        throw new CompilerError('IR_RECURSIVE_CTE_ANCHOR_AFTER_RECURSION', compound.id)
      }
      continue
    }
    if (references.direct !== 1 || references.total !== 1) {
      throw new CompilerError('IR_RECURSIVE_CTE_REFERENCE_SHAPE', compound.id)
    }
    if (compound.operator !== 'union' && compound.operator !== 'union_all') {
      throw new CompilerError('IR_RECURSIVE_CTE_OPERATOR', compound.id)
    }
    if (recursiveOperator === undefined) recursiveOperator = compound.operator
    else if (recursiveOperator !== compound.operator) {
      throw new CompilerError('IR_RECURSIVE_CTE_OPERATOR_MISMATCH', compound.id)
    }
    if (recursiveCoreUsesAggregateOrWindow(compound.query)) {
      throw new CompilerError('IR_RECURSIVE_CTE_AGGREGATE_WINDOW', compound.id)
    }
  }
  if (recursiveOperator === undefined) throw new CompilerError('IR_RECURSIVE_CTE_ARM_REQUIRED', nodeId)
}

function recursiveCoreReferences(query: Query, name: string): { readonly direct: number; readonly total: number } {
  let direct = 0
  for (const relation of [query.from, ...query.joins.map((join) => join.relation)]) {
    if (relation?.kind === 'cte' && sqliteIdentifierEquals(relation.name, name)) direct += 1
  }
  const total = countQueryCteReferences({ ...query, compounds: [] }, name)
  return { direct, total }
}

function countQueryCteReferences(query: Query, name: string): number {
  // A nested WITH name shadows the outer CTE across all definitions and the
  // nested query body, including forward references.
  if (query.ctes.some((cte) => sqliteIdentifierEquals(cte.name, name))) return 0
  let count = query.ctes.reduce((sum, cte) => sum + countQueryCteReferences(cte.query, name), 0)
  if (query.from !== undefined) count += countRelationCteReferences(query.from, name)
  for (const join of query.joins) {
    count += countRelationCteReferences(join.relation, name)
    if (join.on !== undefined) count += countExpressionCteReferences(join.on, name)
  }
  if (query.where !== undefined) count += countExpressionCteReferences(query.where, name)
  for (const expression of query.groupBy) count += countExpressionCteReferences(expression, name)
  if (query.having !== undefined) count += countExpressionCteReferences(query.having, name)
  for (const projection of query.projection) count += countExpressionCteReferences(projection.expression, name)
  for (const window of query.windows) {
    for (const expression of windowExpressions(window)) count += countExpressionCteReferences(expression, name)
  }
  for (const compound of query.compounds) count += countQueryCteReferences(compound.query, name)
  for (const term of query.orderBy) count += countExpressionCteReferences(term.expression, name)
  return count
}

function countRelationCteReferences(relation: Relation, name: string): number {
  if (relation.kind === 'cte') return sqliteIdentifierEquals(relation.name, name) ? 1 : 0
  if (relation.kind === 'subquery') return countQueryCteReferences(relation.query, name)
  if (relation.kind === 'table_function') {
    return relation.args.reduce((sum, expression) => sum + countExpressionCteReferences(expression, name), 0)
  }
  if (relation.kind === 'fts') return countExpressionCteReferences(relation.query, name)
  if (relation.kind === 'vector_search') return countExpressionCteReferences(relation.vector, name)
  if (relation.kind === 'spatial_search') return countExpressionCteReferences(relation.predicate, name)
  return 0
}

function countExpressionCteReferences(expression: Expr, name: string): number {
  switch (expression.kind) {
    case 'unary': return countExpressionCteReferences(expression.operand, name)
    case 'binary': return countExpressionCteReferences(expression.left, name) +
      countExpressionCteReferences(expression.right, name) +
      (expression.escape === undefined ? 0 : countExpressionCteReferences(expression.escape, name))
    case 'conditional': return expression.branches.reduce((sum, branch) => sum +
      countExpressionCteReferences(branch.when, name) + countExpressionCteReferences(branch.then, name), 0) +
      countExpressionCteReferences(expression.otherwise, name)
    case 'cast': return countExpressionCteReferences(expression.value, name)
    case 'collate': return countExpressionCteReferences(expression.expression, name)
    case 'builtin':
    case 'function': return expression.args.reduce((sum, argument) =>
      sum + countExpressionCteReferences(argument, name), 0)
    case 'aggregate': return (expression.value === undefined ? 0 : countExpressionCteReferences(expression.value, name)) +
      (expression.filter === undefined ? 0 : countExpressionCteReferences(expression.filter, name)) +
      (expression.orderBy?.reduce((sum, term) => sum + countExpressionCteReferences(term.expression, name), 0) ?? 0)
    case 'json': return expression.args.reduce((sum, argument) =>
      sum + countExpressionCteReferences(argument, name), 0) +
      (expression.pathExpression === undefined ? 0 : countExpressionCteReferences(expression.pathExpression, name))
    case 'row': return expression.items.reduce((sum, item) => sum + countExpressionCteReferences(item, name), 0)
    case 'window': return expression.args.reduce((sum, argument) =>
      sum + countExpressionCteReferences(argument, name), 0) +
      (expression.filter === undefined ? 0 : countExpressionCteReferences(expression.filter, name)) +
      (typeof expression.window === 'string' ? 0 : windowExpressions(expression.window).reduce((sum, item) =>
        sum + countExpressionCteReferences(item, name), 0))
    case 'scalar_subquery':
    case 'exists': return countQueryCteReferences(expression.query, name)
    case 'membership': return countExpressionCteReferences(expression.value, name) +
      (expression.values?.reduce((sum, item) => sum + countExpressionCteReferences(item, name), 0) ?? 0) +
      (expression.query === undefined ? 0 : countQueryCteReferences(expression.query, name))
    case 'literal':
    case 'parameter':
    case 'column':
    case 'context':
    case 'old_new':
    case 'entropy': return 0
  }
}

function recursiveCoreUsesAggregateOrWindow(query: Query): boolean {
  const expressions = [
    query.where,
    query.having,
    ...query.joins.map((join) => join.on),
    ...query.groupBy,
    ...query.projection.map((projection) => projection.expression),
    ...query.orderBy.map((term) => term.expression),
    ...query.windows.flatMap(windowExpressions),
  ].filter((expression): expression is Expr => expression !== undefined)
  return query.groupBy.length > 0 || query.having !== undefined || query.windows.length > 0 ||
    expressions.some((expression) => containsAggregate(expression) || containsWindow(expression))
}

function safeUnsigned(value: number, code: string): string {
  if (!Number.isSafeInteger(value) || value < 0) throw new CompilerError(code)
  return value.toString(10)
}
