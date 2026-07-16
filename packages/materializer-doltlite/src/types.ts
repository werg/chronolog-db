import type { TransactionCore, TransactionOrderKey } from '@chronolog/protocol'
import type {
  ExecutionManifest,
} from '@chronolog/ir'
import type {
  CanonicalSqlResult,
  SqlResultMode,
  SqlStatement,
  TransactionResultEnvelopeV1,
} from '@chronolog/protocol'

export interface AdmittedTransaction {
  readonly txId: Uint8Array
  readonly authorFeedSequence: bigint
  readonly candidateDigest: Uint8Array
  readonly canonicalCandidate: Uint8Array
  readonly core: TransactionCore
}

export type TransactionOutcomeKind =
  | 'accepted'
  | 'rejected_precondition'
  | 'rejected_execution'

export interface TransactionOutcome {
  readonly txId: Uint8Array
  readonly orderKey: TransactionOrderKey
  readonly orderIndex: number
  readonly outcome: TransactionOutcomeKind
  readonly rejectionCode: string | null
  readonly failingPreconditionId: number | null
  readonly failingPreconditionIndex: number | null
  readonly failingStatementIndex: number | null
  readonly failurePhase: 'precondition' | 'statement' | 'finalize' | null
  readonly failingConstraintIdentity: Uint8Array | null
  readonly failingTriggerIdentity: Uint8Array | null
  readonly resultEnvelopeVersion: 1 | null
  readonly resultEnvelope: Uint8Array | null
  readonly resultDigest: Uint8Array | null
}

export interface TransactionLogRow extends TransactionOutcome {
  readonly authorId: Uint8Array
  readonly authorTimestampMs: bigint
  readonly authorFeedSequence: bigint
  readonly candidateDigest: Uint8Array
  readonly canonicalCandidate: Uint8Array
}

export interface OutcomeChange {
  readonly txId: Uint8Array
  readonly previous: TransactionOutcomeKind | null
  readonly current: TransactionOutcomeKind
  readonly previousRejectionCode: string | null
  readonly currentRejectionCode: string | null
}

export interface MaterializedRevision {
  readonly revision: bigint
  readonly previousRevision: bigint
  readonly orderLength: number
  readonly replayFromIndex: number
  readonly replayedTransactions: number
  readonly checkpointPrefix: number
  readonly contentHash: string
  readonly manifestDigest: Uint8Array
  readonly earliestChangedOrderIndex: number
  readonly outcomeChanges: readonly OutcomeChange[]
}

export interface MaterializerCheckpointInfo {
  readonly prefixLength: number
  readonly branchRef: string
  readonly doltCommitHash: string
  readonly contentHash: string
  readonly createdAtRevision: bigint
}

export interface MaterializerBackendInfo {
  readonly engine: 'doltlite'
  readonly version: string
  readonly sqliteVersion: string
  readonly vecVersion: string | null
  readonly nativeManifest: NativeEngineManifest
  readonly engineDigest: Uint8Array
  readonly securityConfigured: boolean
}

export interface NativeEngineManifest {
  readonly doltliteVersion: string
  readonly doltliteSourceSha256: string
  readonly sqliteVecVersion: string
  readonly sqliteVecSourceSha256: string
  readonly chronologPatchProfile: string
  readonly fts5: boolean
  readonly json1: boolean
  readonly rtree: boolean
  readonly dynamicExtensions: boolean
}

export interface SqlRuntimeLimits {
  /** Maximum signed SQL source size in UTF-8 bytes. */
  readonly maxSqlBytes: number
  /** Approximate SQLite virtual-machine operations per prepare or execution. */
  readonly maxVmSteps: number
  /** Number of VM operations between progress callbacks. */
  readonly progressGranularity: number
  /** Maximum rows returned by one query or precondition. */
  readonly maxResultRows: number
  /** Maximum canonical result bytes returned by one query or precondition. */
  readonly maxResultBytes: number
}

export interface NativeSecurityConfiguration {
  /** Each returned boolean is a native success flag; configureSecurity throws on mismatch. */
  readonly defensive: boolean
  readonly trustedSchema: boolean
  readonly loadExtension: boolean
  readonly dqsDml: boolean
  readonly dqsDdl: boolean
  readonly qpsg: boolean
  readonly ftsTokenizer: boolean
  readonly writableSchema: boolean
  readonly extendedResultCodes: boolean
  readonly attachCreate?: boolean
  readonly attachWrite?: boolean
  readonly reverseScanOrder?: boolean
  readonly fpDigits?: boolean
}

export type SecurityConfiguration = NativeSecurityConfiguration

export interface DoltBranchInfoLike {
  readonly name: string
  readonly hash: string
}

export interface MaterializedSqlQueryResult {
  readonly revision: bigint
  readonly orderLength: number
  readonly executionManifestDigest: Uint8Array
  readonly statement: SqlStatement
  readonly result: CanonicalSqlResult
  readonly resultDigest: Uint8Array
}

export type LocalSqlValue =
  | { readonly kind: 'null' }
  | { readonly kind: 'integer'; readonly value: string }
  | { readonly kind: 'real'; readonly value: number }
  | { readonly kind: 'text'; readonly value: string }
  | { readonly kind: 'blob'; readonly value: Uint8Array }

export interface LocalSqlQueryResult {
  readonly revision: bigint
  readonly orderLength: number
  readonly columns: readonly { readonly name: string; readonly declaredType?: string }[]
  readonly rows: readonly (readonly LocalSqlValue[])[]
}

export interface ObserveSqlOptions {
  readonly atRevision?: bigint
  readonly resultMode: SqlResultMode
}

export interface LocalSqlOptions {
  readonly atRevision?: bigint
}

export interface MaterializerSqlBackend {
  readonly revision: bigint
  readonly orderLength: number
  readonly executionManifestDigest: Uint8Array
  observe(statement: SqlStatement, options: ObserveSqlOptions): Promise<MaterializedSqlQueryResult>
  localQuery(sql: string, parameters?: readonly LocalSqlValue[], options?: LocalSqlOptions): LocalSqlQueryResult
  validateStatement(statement: SqlStatement, mode: 'precondition' | 'body'): readonly SqlDiagnostic[]
  transactionResult(txId: Uint8Array): TransactionResultEnvelopeV1 | null
}

export interface SqlDiagnostic {
  readonly code: string
  readonly startByte?: number
  readonly endByte?: number
}

export interface StatementLike {
  run(...parameters: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint }
  get(...parameters: unknown[]): Record<string, unknown> | unknown[] | undefined
  all(...parameters: unknown[]): Array<Record<string, unknown> | unknown[]>
  columns(): Array<{ name: string | null }>
  setReturnArrays?(enabled: boolean): void
  setReadBigInts?(enabled: boolean): void
  readonly sourceSQL: string
  /** UTF-8 byte offset immediately after the prepared statement. */
  readonly tailOffset: number
}

export interface DatabaseLike {
  readonly inTransaction: boolean
  exec(sql: string): void
  prepare(sql: string): StatementLike
  close(): void
  configureSecurity(): NativeSecurityConfiguration
  setAuthorizer(
    callback:
      | ((
          actionCode: number,
          arg1: string | null,
          arg2: string | null,
          databaseName: string | null,
          triggerOrView: string | null,
        ) => number)
      | null,
  ): void
  setProgressHandler(steps: number, callback: (() => boolean) | null): void
  /** Returns the previous value, matching sqlite3_limit(). */
  setLimit(category: number, value: number): number
  interrupt(): void
  doltCommit(message: string): string
  doltBranch(name: string, from?: string): void
  doltCheckout(branch: string): void
  doltResetHard(ref: string): void
  doltForceBranch(name: string, ref: string): void
  doltDeleteBranch(name: string): void
  doltHashOf(ref?: string): string
  doltVersion(): string
  doltBranches(): DoltBranchInfoLike[]
  doltActiveBranch(): string
}

export interface MaterializerOptions {
  readonly path?: string
  readonly executionManifest: ExecutionManifest
  readonly checkpointEvery?: number
  readonly retainCheckpoints?: number
  /**
   * Test and operator-diagnostic seam for reproducible process termination at
   * durable publication boundaries. Production callers normally omit it.
   */
  readonly publicationFaultInjector?: (point: MaterializerPublicationFaultPoint) => void
}

export type MaterializerPublicationFaultPoint =
  | 'after_candidate_commit'
  | 'after_revision_ref_created'
  | 'before_head_publish'
  | 'after_head_publish'
  | 'after_reader_swap'

export interface StoredExecutionManifest {
  readonly manifestDigest: Uint8Array
  readonly canonicalManifest: Uint8Array
}

export type RevisionSubscriber = (revision: MaterializedRevision) => void
