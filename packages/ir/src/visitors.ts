import type {
  CompoundTerm,
  ContextField,
  Cte,
  Expr,
  Join,
  MergeClause,
  Mutation,
  OrderTerm,
  Projection,
  Query,
  Relation,
  TransactionProgram,
  WindowDefinition,
} from './types.js'

export interface IrVisitor {
  readonly expr?: (expr: Expr) => void
  readonly query?: (query: Query) => void
  readonly relation?: (relation: Relation) => void
  readonly mutation?: (mutation: Mutation) => void
  readonly cte?: (cte: Cte) => void
  readonly join?: (join: Join) => void
  readonly projection?: (projection: Projection) => void
  readonly orderTerm?: (term: OrderTerm) => void
  readonly window?: (window: WindowDefinition) => void
  readonly compound?: (compound: CompoundTerm) => void
  readonly mergeClause?: (clause: MergeClause) => void
}

export function walkExpr(expr: Expr, visitor: IrVisitor): void {
  visitor.expr?.(expr)
  switch (expr.kind) {
    case 'literal': case 'parameter': case 'column': case 'context': case 'old_new': case 'entropy': return
    case 'unary': walkExpr(expr.operand, visitor); return
    case 'binary': walkExpr(expr.left, visitor); walkExpr(expr.right, visitor); return
    case 'conditional': for (const branch of expr.branches) { walkExpr(branch.when, visitor); walkExpr(branch.then, visitor) }; walkExpr(expr.otherwise, visitor); return
    case 'cast': walkExpr(expr.value, visitor); return
    case 'function': for (const arg of expr.args) walkExpr(arg, visitor); return
    case 'json': for (const arg of expr.args) walkExpr(arg, visitor); return
    case 'scalar_subquery': walkQuery(expr.query, visitor); return
    case 'exists': walkQuery(expr.query, visitor); return
    case 'membership': walkExpr(expr.value, visitor); for (const value of expr.values ?? []) walkExpr(value, visitor); if (expr.query !== undefined) walkQuery(expr.query, visitor); return
    default: return assertNever(expr)
  }
}

export function walkRelation(relation: Relation, visitor: IrVisitor): void {
  visitor.relation?.(relation)
  switch (relation.kind) {
    case 'table': case 'view': case 'cte': case 'system_relation': return
    case 'subquery': walkQuery(relation.query, visitor); return
    case 'table_function': for (const arg of relation.args) walkExpr(arg, visitor); return
    case 'fts': walkExpr(relation.query, visitor); return
    case 'vector_search': walkExpr(relation.vector, visitor); return
    case 'spatial_search': walkExpr(relation.predicate, visitor); return
    default: return assertNever(relation)
  }
}

export function walkQuery(query: Query, visitor: IrVisitor): void {
  visitor.query?.(query)
  for (const cte of query.ctes) { visitor.cte?.(cte); walkQuery(cte.query, visitor) }
  if (query.from !== undefined) walkRelation(query.from, visitor)
  for (const join of query.joins) { visitor.join?.(join); walkRelation(join.relation, visitor); if (join.on !== undefined) walkExpr(join.on, visitor) }
  if (query.where !== undefined) walkExpr(query.where, visitor)
  for (const expr of query.groupBy) walkExpr(expr, visitor)
  if (query.having !== undefined) walkExpr(query.having, visitor)
  for (const projection of query.projection) { visitor.projection?.(projection); walkExpr(projection.expression, visitor) }
  for (const window of query.windows) { visitor.window?.(window); for (const expr of window.partitionBy) walkExpr(expr, visitor); for (const term of window.orderBy) { visitor.orderTerm?.(term); walkExpr(term.expression, visitor) } }
  for (const compound of query.compounds) { visitor.compound?.(compound); walkQuery(compound.query, visitor) }
  for (const term of query.orderBy) { visitor.orderTerm?.(term); walkExpr(term.expression, visitor) }
}

export function walkMutation(mutation: Mutation, visitor: IrVisitor): void {
  visitor.mutation?.(mutation)
  if (mutation.returning !== undefined) walkQuery(mutation.returning, visitor)
  switch (mutation.kind) {
    case 'insert': for (const row of mutation.rows) for (const expr of row) walkExpr(expr, visitor); return
    case 'update': for (const assignment of mutation.assignments) walkExpr(assignment.value, visitor); if (mutation.where !== undefined) walkExpr(mutation.where, visitor); return
    case 'delete': if (mutation.where !== undefined) walkExpr(mutation.where, visitor); return
    case 'upsert': for (const expr of mutation.row) walkExpr(expr, visitor); for (const assignment of mutation.updates) walkExpr(assignment.value, visitor); return
    case 'merge': walkQuery(mutation.source, visitor); walkExpr(mutation.on, visitor); for (const clause of mutation.clauses) { visitor.mergeClause?.(clause); if (clause.predicate !== undefined) walkExpr(clause.predicate, visitor); for (const assignment of clause.assignments) walkExpr(assignment.value, visitor) }; return
    case 'stateful_call': for (const expr of mutation.args) walkExpr(expr, visitor); return
    default: return assertNever(mutation)
  }
}

export function walkProgram(program: TransactionProgram, visitor: IrVisitor): void {
  for (const precondition of program.preconditions) walkQuery(precondition.query, visitor)
  for (const mutation of program.mutations) walkMutation(mutation, visitor)
}

export function collectContextDependencies(value: Expr | Query | Mutation | TransactionProgram): readonly ContextField[] {
  const fields = new Set<ContextField>()
  const visitor: IrVisitor = { expr: (expr) => { if (expr.kind === 'context') fields.add(expr.field); if (expr.kind === 'entropy') fields.add('transaction_nonce') } }
  if ('preconditions' in value) walkProgram(value, visitor)
  else if ('projection' in value) walkQuery(value, visitor)
  else if ('affectedRows' in value) walkMutation(value, visitor)
  else walkExpr(value, visitor)
  return [...fields].sort()
}

export function collectRelationEffects(program: TransactionProgram): { readonly reads: readonly string[]; readonly writes: readonly string[] } {
  const reads = new Set<string>(), writes = new Set<string>()
  walkProgram(program, {
    relation: (relation) => { if (relation.kind === 'table' || relation.kind === 'view') reads.add(relation.name) },
    mutation: (mutation) => { if ('target' in mutation && mutation.target.kind === 'name') writes.add(mutation.target.name) },
  })
  return { reads: [...reads].sort(), writes: [...writes].sort() }
}

export function semanticComplexity(program: TransactionProgram): number {
  let nodes = program.preconditions.length + program.mutations.length
  walkProgram(program, {
    expr: () => { nodes += 1 }, query: () => { nodes += 1 }, relation: () => { nodes += 1 },
    cte: () => { nodes += 1 }, join: () => { nodes += 1 }, projection: () => { nodes += 1 },
    orderTerm: () => { nodes += 1 }, window: () => { nodes += 1 }, compound: () => { nodes += 1 },
    mergeClause: () => { nodes += 1 },
  })
  return nodes
}

function assertNever(value: never): never { throw new Error(`IR_VISITOR_MISSING_VARIANT:${String(value)}`) }
