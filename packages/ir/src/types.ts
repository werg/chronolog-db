export type CollationId = 'binary' | 'unicode_codepoint' | `registered:${number}`
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
  | 'is' | 'is_not'

export interface LiteralExpr { readonly kind: 'literal'; readonly id: number; readonly value: LogicalValue }
export interface ParameterExpr { readonly kind: 'parameter'; readonly id: number; readonly name: string; readonly valueType: ValueType }
export interface ColumnExpr { readonly kind: 'column'; readonly id: number; readonly relation?: string; readonly name: string }
export interface ContextExpr { readonly kind: 'context'; readonly id: number; readonly field: ContextField }
export interface OldNewExpr { readonly kind: 'old_new'; readonly id: number; readonly scope: 'old' | 'new'; readonly column: string }
export interface UnaryExpr { readonly kind: 'unary'; readonly id: number; readonly operator: UnaryOperator; readonly operand: Expr }
export interface BinaryExpr { readonly kind: 'binary'; readonly id: number; readonly operator: BinaryOperator; readonly left: Expr; readonly right: Expr }
export interface ConditionalBranch { readonly when: Expr; readonly then: Expr }
export interface ConditionalExpr { readonly kind: 'conditional'; readonly id: number; readonly branches: readonly ConditionalBranch[]; readonly otherwise: Expr }
export interface CastExpr { readonly kind: 'cast'; readonly id: number; readonly value: Expr; readonly target: LogicalType }
export interface FunctionExpr { readonly kind: 'function'; readonly id: number; readonly functionId: number; readonly args: readonly Expr[] }
export interface JsonExpr { readonly kind: 'json'; readonly id: number; readonly operation: 'extract' | 'type' | 'array' | 'object' | 'merge'; readonly args: readonly Expr[]; readonly path?: string }
export interface ScalarSubqueryExpr { readonly kind: 'scalar_subquery'; readonly id: number; readonly query: Query }
export interface ExistsExpr { readonly kind: 'exists'; readonly id: number; readonly query: Query; readonly negated: boolean }
export interface MembershipExpr { readonly kind: 'membership'; readonly id: number; readonly value: Expr; readonly values?: readonly Expr[]; readonly query?: Query; readonly negated: boolean }
export interface EntropyExpr { readonly kind: 'entropy'; readonly id: number; readonly label: string; readonly index: number; readonly length: number }

export type Expr = LiteralExpr | ParameterExpr | ColumnExpr | ContextExpr | OldNewExpr | UnaryExpr | BinaryExpr
  | ConditionalExpr | CastExpr | FunctionExpr | JsonExpr | ScalarSubqueryExpr | ExistsExpr | MembershipExpr | EntropyExpr

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
export interface Join { readonly id: number; readonly kind: 'inner' | 'left' | 'cross'; readonly relation: Relation; readonly on?: Expr }
export interface Projection { readonly id: number; readonly name: string; readonly expression: Expr }
export interface OrderTerm { readonly id: number; readonly expression: Expr; readonly direction: 'asc' | 'desc'; readonly nulls: 'first' | 'last'; readonly canonicalRowTieBreaker?: boolean }
export interface PageClause { readonly limit: number; readonly offset?: number }
export type ResultMode = { readonly kind: 'scalar' } | { readonly kind: 'ordered' } | { readonly kind: 'multiset' } | { readonly kind: 'set' }
export interface WindowDefinition { readonly id: number; readonly name: string; readonly partitionBy: readonly Expr[]; readonly orderBy: readonly OrderTerm[] }
export interface CompoundTerm { readonly id: number; readonly operator: 'union_all' | 'union' | 'intersect' | 'except'; readonly query: Query }

export interface Query {
  readonly id: number
  readonly ctes: readonly Cte[]
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
export interface InsertMutation extends MutationBase { readonly kind: 'insert'; readonly target: ObjectReference; readonly columns: readonly string[]; readonly rows: readonly (readonly Expr[])[]; readonly conflict: ConflictPolicy }
export interface Assignment { readonly column: string; readonly value: Expr }
export interface UpdateMutation extends MutationBase { readonly kind: 'update'; readonly target: ObjectReference; readonly assignments: readonly Assignment[]; readonly where?: Expr }
export interface DeleteMutation extends MutationBase { readonly kind: 'delete'; readonly target: ObjectReference; readonly where?: Expr }
export interface UpsertMutation extends MutationBase { readonly kind: 'upsert'; readonly target: ObjectReference; readonly columns: readonly string[]; readonly row: readonly Expr[]; readonly constraint: string; readonly updates: readonly Assignment[] }
export interface MergeClause { readonly id: number; readonly when: 'matched' | 'not_matched'; readonly predicate?: Expr; readonly action: 'update' | 'insert' | 'delete'; readonly assignments: readonly Assignment[] }
export interface MergeMutation extends MutationBase { readonly kind: 'merge'; readonly target: ObjectReference; readonly source: Query; readonly on: Expr; readonly clauses: readonly MergeClause[] }
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
