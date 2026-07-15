export type CollationId = 'binary' | 'nocase' | 'rtrim' | 'unicode_codepoint' | `registered:${number}`
export type VectorElementType = 'i8' | 'u8' | 'i16' | 'i32' | 'f32' | 'f64'

export type CanonicalJsonValue =
  | null
  | boolean
  | bigint
  | { readonly kind: 'decimal'; readonly coefficient: bigint; readonly scale: number }
  | string
  | readonly CanonicalJsonValue[]
  | ReadonlyMap<string, CanonicalJsonValue>

export type LogicalValue =
  | { readonly kind: 'null' }
  | { readonly kind: 'boolean'; readonly value: boolean }
  | { readonly kind: 'int64'; readonly value: bigint }
  | { readonly kind: 'decimal'; readonly coefficient: bigint; readonly scale: number }
  | { readonly kind: 'text'; readonly utf8: Uint8Array }
  | { readonly kind: 'blob'; readonly bytes: Uint8Array }
  | { readonly kind: 'uuid'; readonly bytes: Uint8Array }
  | { readonly kind: 'timestamp_ms'; readonly value: bigint }
  | { readonly kind: 'duration_ms'; readonly value: bigint }
  | { readonly kind: 'json'; readonly value: CanonicalJsonValue }
  | { readonly kind: 'vector'; readonly element: VectorElementType; readonly dimensions: number; readonly bytes: Uint8Array }

export type LogicalType =
  | { readonly kind: 'boolean' }
  | { readonly kind: 'int64' }
  | { readonly kind: 'decimal'; readonly precision: number; readonly scale: number }
  | { readonly kind: 'text'; readonly collation: CollationId }
  | { readonly kind: 'blob'; readonly maxBytes?: number }
  | { readonly kind: 'uuid' }
  | { readonly kind: 'timestamp_ms' }
  | { readonly kind: 'duration_ms' }
  | { readonly kind: 'json' }
  | { readonly kind: 'vector'; readonly element: VectorElementType; readonly dimensions: number }

export interface ValueType { readonly logical: LogicalType; readonly nullable: boolean }
export interface IrDiagnosticLocation { readonly file?: string; readonly startOffset?: number; readonly endOffset?: number; readonly builderLabel?: string }

export type ContextField =
  | 'group_id' | 'membership_revision' | 'validation_policy' | 'author_id'
  | 'author_timestamp_ms' | 'transaction_nonce' | 'candidate_digest'
  | 'transaction_id' | 'author_feed_sequence'

export type UnaryOperator = 'not' | 'negate' | 'is_null' | 'is_not_null' | 'bit_not'
export type BinaryOperator =
  | 'and' | 'or' | 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte'
  | 'add' | 'subtract' | 'multiply' | 'divide' | 'modulo'
  | 'concat' | 'bit_and' | 'bit_or' | 'bit_xor' | 'shift_left' | 'shift_right'
  | 'is' | 'is_not' | 'like' | 'not_like' | 'glob' | 'not_glob'

export interface LiteralExpr { readonly kind: 'literal'; readonly id: number; readonly value: LogicalValue }
export interface ParameterExpr { readonly kind: 'parameter'; readonly id: number; readonly name: string; readonly valueType: ValueType }
export interface ColumnExpr { readonly kind: 'column'; readonly id: number; readonly relation?: string; readonly name: string }
export interface ContextExpr { readonly kind: 'context'; readonly id: number; readonly field: ContextField }
export interface OldNewExpr { readonly kind: 'old_new'; readonly id: number; readonly scope: 'old' | 'new'; readonly column: string }
export interface UnaryExpr { readonly kind: 'unary'; readonly id: number; readonly operator: UnaryOperator; readonly operand: Expr }
export interface BinaryExpr { readonly kind: 'binary'; readonly id: number; readonly operator: BinaryOperator; readonly left: Expr; readonly right: Expr; readonly escape?: Expr }
export interface ConditionalBranch { readonly when: Expr; readonly then: Expr }
export interface ConditionalExpr { readonly kind: 'conditional'; readonly id: number; readonly branches: readonly ConditionalBranch[]; readonly otherwise: Expr }
export interface CastExpr { readonly kind: 'cast'; readonly id: number; readonly value: Expr; readonly target: LogicalType }
export const BUILTIN_FUNCTION_NAMES = [
  'char', 'concat', 'concat_ws',
  'length', 'octet_length',
  'lower', 'upper', 'trim', 'ltrim', 'rtrim', 'replace',
  'instr', 'substr', 'substring', 'hex',
  'coalesce', 'ifnull', 'nullif',
  'if', 'iif', 'likelihood', 'likely', 'unlikely',
  'glob', 'like', 'min', 'max',
  'quote', 'typeof', 'unhex', 'unicode', 'unistr', 'unistr_quote', 'zeroblob',
  'abs', 'sign',
] as const
export type BuiltinFunctionName = typeof BUILTIN_FUNCTION_NAMES[number]
/** Pinned SQLite core function with compiler-owned typing; never manifest-defined. */
export interface BuiltinFunctionExpr {
  readonly kind: 'builtin'
  readonly id: number
  readonly name: BuiltinFunctionName
  readonly args: readonly Expr[]
}
export interface FunctionExpr { readonly kind: 'function'; readonly id: number; readonly functionId: number; readonly args: readonly Expr[] }
export type AggregateOperation = 'count' | 'min' | 'max' | 'every' | 'any'
export interface AggregateExpr {
  readonly kind: 'aggregate'
  readonly id: number
  readonly operation: AggregateOperation
  /** Omitted only for COUNT(*). */
  readonly value?: Expr
  readonly distinct: boolean
  /** Standard SQL FILTER (WHERE ...), evaluated over aggregate input rows. */
  readonly filter?: Expr
  /** SQLite aggregate-argument order, retained even when result-insensitive. */
  readonly orderBy?: readonly OrderTerm[]
}
export interface JsonExpr {
  readonly kind: 'json'
  readonly id: number
  readonly operation: 'extract' | 'type' | 'array' | 'object' | 'merge'
  readonly args: readonly Expr[]
  /** Constant JSON path retained for compact backwards-compatible encoding. */
  readonly path?: string
  /** SQLite permits a runtime text expression as a JSON path. */
  readonly pathExpression?: Expr
}
export interface ScalarSubqueryExpr { readonly kind: 'scalar_subquery'; readonly id: number; readonly query: Query }
export interface ExistsExpr { readonly kind: 'exists'; readonly id: number; readonly query: Query; readonly negated: boolean }
export interface MembershipExpr { readonly kind: 'membership'; readonly id: number; readonly value: Expr; readonly values?: readonly Expr[]; readonly query?: Query; readonly negated: boolean }
export interface EntropyExpr { readonly kind: 'entropy'; readonly id: number; readonly label: string; readonly index: number; readonly length: number }
/** SQLite row value. It is valid only in row-aware comparison, membership, and mutation contexts. */
export interface RowExpr { readonly kind: 'row'; readonly id: number; readonly items: readonly Expr[] }
export interface CollateExpr { readonly kind: 'collate'; readonly id: number; readonly expression: Expr; readonly collation: CollationId }
export type WindowOperation = AggregateOperation | 'row_number' | 'rank' | 'dense_rank' | 'ntile' | 'lag' | 'lead'
export type WindowFrameBound =
  | { readonly type: 'unbounded_preceding' }
  | { readonly type: 'current_row' }
  | { readonly type: 'unbounded_following' }
  | { readonly type: 'preceding' | 'following'; readonly offset: Expr }
export interface WindowFrame {
  readonly mode: 'rows' | 'range' | 'groups'
  readonly start: WindowFrameBound
  readonly end?: WindowFrameBound
  readonly exclude?: 'no_others' | 'current_row' | 'group' | 'ties'
}
export interface WindowSpecification {
  readonly base?: string
  readonly partitionBy: readonly Expr[]
  readonly orderBy: readonly OrderTerm[]
  readonly frame?: WindowFrame
}
export interface WindowExpr {
  readonly kind: 'window'
  readonly id: number
  readonly operation: WindowOperation
  readonly args: readonly Expr[]
  readonly filter?: Expr
  readonly window: string | WindowSpecification
}

export type Expr = LiteralExpr | ParameterExpr | ColumnExpr | ContextExpr | OldNewExpr | UnaryExpr | BinaryExpr
  | ConditionalExpr | CastExpr | BuiltinFunctionExpr | FunctionExpr | AggregateExpr | JsonExpr | ScalarSubqueryExpr | ExistsExpr | MembershipExpr | EntropyExpr | RowExpr | WindowExpr | CollateExpr

export interface TableRelation { readonly kind: 'table'; readonly id: number; readonly name: string; readonly alias?: string }
export interface ViewRelation { readonly kind: 'view'; readonly id: number; readonly name: string; readonly alias?: string }
export interface SubqueryRelation { readonly kind: 'subquery'; readonly id: number; readonly query: Query; readonly alias: string }
export interface CteRelation { readonly kind: 'cte'; readonly id: number; readonly name: string; readonly alias?: string }
export interface TableFunctionRelation { readonly kind: 'table_function'; readonly id: number; readonly functionId: number; readonly args: readonly Expr[]; readonly alias: string }
export interface FtsRelation { readonly kind: 'fts'; readonly id: number; readonly indexId: number; readonly query: Expr; readonly alias: string }
export interface VectorSearchRelation { readonly kind: 'vector_search'; readonly id: number; readonly indexId: number; readonly vector: Expr; readonly limit: number; readonly alias: string }
export interface SpatialSearchRelation { readonly kind: 'spatial_search'; readonly id: number; readonly indexId: number; readonly predicate: Expr; readonly alias: string }
/** Consensus-visible, read-only system data. Never represented as a reserved table name. */
export interface SystemRelation { readonly kind: 'system_relation'; readonly id: number; readonly relation: 'transaction_log'; readonly alias?: string }
export type Relation = TableRelation | ViewRelation | SubqueryRelation | CteRelation | TableFunctionRelation | FtsRelation | VectorSearchRelation | SpatialSearchRelation | SystemRelation

export interface Cte { readonly id: number; readonly name: string; readonly query: Query; readonly materialized: 'default' | 'materialized' | 'not_materialized' }
export interface Join {
  readonly id: number
  readonly kind: 'inner' | 'left' | 'right' | 'full' | 'cross'
  readonly relation: Relation
  readonly on?: Expr
  /** SQLite USING columns after NATURAL joins have been catalog-expanded. */
  readonly using?: readonly string[]
}
export interface Projection { readonly id: number; readonly name: string; readonly expression: Expr }
export interface OrderTerm { readonly id: number; readonly expression: Expr; readonly direction: 'asc' | 'desc'; readonly nulls: 'first' | 'last'; readonly canonicalRowTieBreaker?: boolean }
export interface PageClause { readonly limit: number; readonly offset?: number }
export type ResultMode = { readonly kind: 'scalar' } | { readonly kind: 'ordered' } | { readonly kind: 'multiset' } | { readonly kind: 'set' }
export interface WindowDefinition extends WindowSpecification { readonly id: number; readonly name: string }
export interface CompoundTerm { readonly id: number; readonly operator: 'union_all' | 'union' | 'intersect' | 'except'; readonly query: Query }

export interface Query {
  readonly id: number
  readonly ctes: readonly Cte[]
  /** Emit SQLite WITH RECURSIVE and permit a CTE compound arm to reference itself. */
  readonly recursive?: boolean
  readonly from?: Relation
  readonly joins: readonly Join[]
  readonly where?: Expr
  readonly groupBy: readonly Expr[]
  readonly having?: Expr
  readonly projection: readonly Projection[]
  readonly windows: readonly WindowDefinition[]
  readonly compounds: readonly CompoundTerm[]
  readonly orderBy: readonly OrderTerm[]
  readonly page?: PageClause
  readonly resultMode: ResultMode
  /** Apply SQL DISTINCT before ordering and pagination. */
  readonly distinct?: boolean
}

export type ObjectReference = { readonly kind: 'name'; readonly name: string } | { readonly kind: 'id'; readonly objectId: number }
export type AffectedRowsExpectation =
  | { readonly kind: 'unconstrained' }
  | { readonly kind: 'exactly'; readonly count: bigint }
  | { readonly kind: 'at_least'; readonly count: bigint }
  | { readonly kind: 'at_most'; readonly count: bigint }
  | { readonly kind: 'range'; readonly minimum: bigint; readonly maximum: bigint }
export type ConflictPolicy = 'error' | 'ignore' | 'replace'
export interface MutationBase { readonly id: number; readonly affectedRows: AffectedRowsExpectation; readonly returning?: Query; readonly label?: string }
export interface TargetMutationBase extends MutationBase {
  readonly alias?: string
  readonly ctes?: readonly Cte[]
  /** Emit SQLite WITH RECURSIVE and permit a mutation CTE to reference itself. */
  readonly recursive?: boolean
}
export interface Assignment { readonly column: string; readonly value: Expr }
/** Stable schema references resolved from a standard SQLite conflict target. */
export type UpsertConflictTarget =
  | { readonly constraintId: number }
  | { readonly indexId: number }
export interface UpsertClause {
  readonly id: number
  /** May be omitted only by the final catch-all clause. */
  readonly target?: UpsertConflictTarget
  readonly action: 'nothing' | 'update'
  readonly assignments: readonly Assignment[]
  readonly where?: Expr
}
export interface InsertMutation extends TargetMutationBase { readonly kind: 'insert'; readonly target: ObjectReference; readonly columns: readonly string[]; readonly rows: readonly (readonly Expr[])[]; readonly source?: Query; readonly conflict: ConflictPolicy; readonly upsertClauses?: readonly UpsertClause[] }
export interface UpdateMutation extends TargetMutationBase { readonly kind: 'update'; readonly target: ObjectReference; readonly assignments: readonly Assignment[]; readonly where?: Expr; readonly conflict?: ConflictPolicy; readonly from?: Query; readonly fromAlias?: string }
export interface DeleteMutation extends TargetMutationBase { readonly kind: 'delete'; readonly target: ObjectReference; readonly where?: Expr }
export interface UpsertMutation extends TargetMutationBase { readonly kind: 'upsert'; readonly target: ObjectReference; readonly columns: readonly string[]; readonly row: readonly Expr[]; readonly constraint: string; readonly updates: readonly Assignment[]; readonly where?: Expr; readonly source?: Query }
export interface MergeClause { readonly id: number; readonly when: 'matched' | 'not_matched'; readonly predicate?: Expr; readonly action: 'update' | 'insert' | 'delete'; readonly assignments: readonly Assignment[] }
export interface MergeMutation extends TargetMutationBase { readonly kind: 'merge'; readonly target: ObjectReference; readonly source: Query; readonly on: Expr; readonly clauses: readonly MergeClause[] }
export interface RegisteredStatefulCall extends MutationBase { readonly kind: 'stateful_call'; readonly moduleId: number; readonly operationId: number; readonly args: readonly Expr[] }
export type Mutation = InsertMutation | UpdateMutation | DeleteMutation | UpsertMutation | MergeMutation | RegisteredStatefulCall

export interface ResultColumn { readonly id: number; readonly name: string; readonly valueType: ValueType }
export interface CanonicalQueryResult { readonly resultMode: ResultMode; readonly columns: readonly ResultColumn[]; readonly rows: readonly (readonly LogicalValue[])[] }
export interface InlineResult { readonly kind: 'inline'; readonly result: CanonicalQueryResult }
export interface ResultDigest { readonly kind: 'digest'; readonly digest: Uint8Array; readonly resultMode: ResultMode; readonly columns: readonly ResultColumn[] }
export type ExpectedResult = InlineResult | ResultDigest
export type Precondition =
  | { readonly kind: 'assert'; readonly id: number; readonly query: Query; readonly unknownIsFailure: true }
  | { readonly kind: 'expect'; readonly id: number; readonly query: Query; readonly expected: ExpectedResult }

export interface TransactionProgram { readonly preconditions: readonly Precondition[]; readonly mutations: readonly Mutation[]; readonly metadata?: ReadonlyMap<string, Uint8Array> }
export interface DraftObservation { readonly observationId: string; readonly query: Query; readonly revision: bigint; readonly schemaDigest: Uint8Array; readonly result: CanonicalQueryResult; readonly dependsOnContext: readonly ContextField[] }

export interface SchemaColumn { readonly id: number; readonly name: string; readonly declarationOrder: number; readonly valueType: ValueType; readonly defaultValue?: LogicalValue; readonly generated?: Expr }
export type SchemaConstraint =
  | { readonly kind: 'primary_key'; readonly id: number; readonly name: string; readonly columnIds: readonly number[] }
  | { readonly kind: 'unique'; readonly id: number; readonly name: string; readonly columnIds: readonly number[] }
  | { readonly kind: 'check'; readonly id: number; readonly name: string; readonly expression: Expr }
  | { readonly kind: 'foreign_key'; readonly id: number; readonly name: string; readonly columnIds: readonly number[]; readonly targetTableId: number; readonly targetColumnIds: readonly number[]; readonly onDelete: 'restrict' | 'cascade' | 'set_null'; readonly onUpdate: 'restrict' | 'cascade' }
export interface SchemaTable { readonly kind: 'table'; readonly id: number; readonly name: string; readonly declarationOrder: number; readonly columns: readonly SchemaColumn[]; readonly constraints: readonly SchemaConstraint[]; readonly withoutRowId: boolean }
export interface SchemaIndex { readonly kind: 'index'; readonly id: number; readonly name: string; readonly declarationOrder: number; readonly tableId: number; readonly expressions: readonly Expr[]; readonly unique: boolean; readonly where?: Expr }
export interface SchemaView { readonly kind: 'view'; readonly id: number; readonly name: string; readonly declarationOrder: number; readonly query: Query }
export interface SchemaRule { readonly kind: 'rule'; readonly id: number; readonly name: string; readonly declarationOrder: number; readonly tableId: number; readonly event: 'insert' | 'update' | 'delete'; readonly when?: Expr; readonly mutations: readonly Mutation[]; readonly effectObjectIds: readonly number[] }
export interface DerivedIndex { readonly kind: 'fts_index' | 'vector_index' | 'spatial_index'; readonly id: number; readonly name: string; readonly declarationOrder: number; readonly tableId: number; readonly columnIds: readonly number[]; readonly moduleId: number }
export type SchemaObject = SchemaTable | SchemaIndex | SchemaView | SchemaRule | DerivedIndex
export interface SeedRow { readonly tableId: number; readonly values: ReadonlyMap<number, LogicalValue> }
export interface SchemaManifest { readonly version: 1; readonly name: string; readonly objects: readonly SchemaObject[]; readonly seedRows: readonly SeedRow[]; readonly functionIds: readonly number[]; readonly collationIds: readonly number[]; readonly moduleIds: readonly number[] }

export type FunctionEffect = 'pure' | 'stable_context' | 'stateful'
export interface RegisteredFunction { readonly id: number; readonly name: string; readonly arguments: readonly ValueType[]; readonly result: ValueType; readonly effect: FunctionEffect; readonly implementationDigest: Uint8Array }
export interface RegisteredCollation { readonly id: number; readonly name: string; readonly implementationDigest: Uint8Array }
export interface RegisteredModule { readonly id: number; readonly name: string; readonly kind: 'native' | 'wasm' | 'builtin'; readonly implementationDigest: Uint8Array; readonly effectObjectIds: readonly number[] }
export interface SemanticResourceLimits { readonly maxProgramNodes: number; readonly maxExpressionDepth: number; readonly maxQueryRows: number; readonly maxResultBytes: number; readonly maxJsonDepth: number; readonly maxVectorDimensions: number; readonly maxRuleDepth: number; readonly maxWasmFuel: bigint }
export interface ExecutionFeatures { readonly decimal: boolean; readonly json: boolean; readonly vector: boolean; readonly fts: boolean; readonly spatial: boolean; readonly wasm: boolean }
export interface ExecutionManifest { readonly version: 1; readonly profile: string; readonly engine: string; readonly engineDigest: Uint8Array; readonly functions: readonly RegisteredFunction[]; readonly collations: readonly RegisteredCollation[]; readonly modules: readonly RegisteredModule[]; readonly features: ExecutionFeatures; readonly resources: SemanticResourceLimits }

export interface IrDiagnostic { readonly code: string; readonly message: string; readonly nodeId?: number; readonly path?: string; readonly location?: IrDiagnosticLocation }
export interface IrValidationResult<T> { readonly ok: boolean; readonly value?: T; readonly diagnostics: readonly IrDiagnostic[] }
export interface OrderingProof { readonly total: boolean; readonly reason: 'unique_key' | 'canonical_row' | 'not_total'; readonly keyProjectionIds: readonly number[] }
