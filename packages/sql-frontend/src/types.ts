import type {
  AffectedRowsExpectation,
  ExecutionManifest,
  LogicalValue,
  Mutation,
  Precondition,
  Query,
  ResultMode,
  SchemaManifest,
  TransactionProgram,
} from '@chronolog/ir'

/** The structural output shared by Kysely, Drizzle, Knex, and similar builders. */
export interface CompiledSql {
  readonly sql: string
  readonly parameters?: SqlParameters
}

export type SqlParameterValue = LogicalValue | null | boolean | bigint | number | string | Uint8Array
export type SqlParameters = readonly SqlParameterValue[] | Readonly<Record<string, SqlParameterValue>>

export interface SqlQueryOptions {
  /** Defaults to `ordered` when SQL has ORDER BY, otherwise `multiset`. */
  readonly resultMode?: ResultMode
}

export interface SqlCommandOptions {
  readonly affectedRows?: AffectedRowsExpectation
  readonly label?: string
}

export interface SqliteConsensusFrontendOptions {
  readonly schema: SchemaManifest
  readonly executionManifest: ExecutionManifest
  /** The allocator is monotonic so all values emitted by one frontend compose safely. */
  readonly startId?: number
}

/**
 * Pluggable boundary for SQL parsers or established query-builder AST adapters.
 * Implementations lower locally; SQL text is never part of a signed program.
 */
export interface ConsensusSqlFrontend<Input = CompiledSql> {
  lowerQuery(input: Input, options?: SqlQueryOptions): Query
  lowerAssertion(input: Input): Precondition
  lowerCommand(input: Input, options?: SqlCommandOptions): Mutation
  program(
    preconditions: readonly Precondition[],
    mutations: readonly Mutation[],
    metadata?: ReadonlyMap<string, Uint8Array>,
  ): TransactionProgram
}

export type SqlFrontendErrorCode =
  | 'SQL_PARSE_ERROR'
  | 'SQL_MULTIPLE_STATEMENTS'
  | 'SQL_STATEMENT_UNSUPPORTED'
  | 'SQL_FEATURE_UNSUPPORTED'
  | 'SQL_AST_UNSUPPORTED'
  | 'SQL_SCHEMA_OBJECT_NOT_FOUND'
  | 'SQL_PARAMETER_MODE_MISMATCH'
  | 'SQL_PARAMETER_MISSING'
  | 'SQL_PARAMETER_UNUSED'
  | 'SQL_PARAMETER_VALUE_INVALID'
  | 'SQL_TOTAL_ORDER_REQUIRED'
  | 'SQL_PRECONDITION_REQUIRED'
  | 'SQL_MUTATION_REQUIRED'
  | 'SQL_IR_INVALID'

export class SqlFrontendError extends Error {
  readonly code: SqlFrontendErrorCode
  readonly feature?: string

  public constructor(code: SqlFrontendErrorCode, message: string, feature?: string) {
    super(message)
    this.name = 'SqlFrontendError'
    this.code = code
    if (feature !== undefined) this.feature = feature
  }
}
