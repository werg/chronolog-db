import type {
  CanonicalSqlResult,
  SqlResultMode,
  SqlStatement,
  TransactionOrderKey,
  TransactionResultEnvelopeV1,
} from '@chronolog/protocol'

import type { AdmittedTransaction } from './types.js'

export type MaterializedTransactionOutcomeKind =
  | 'accepted'
  | 'rejected_precondition'
  | 'rejected_execution'

export interface MaterializedTransactionOutcome {
  readonly txId: Uint8Array
  readonly orderKey: TransactionOrderKey
  readonly orderIndex: number
  readonly outcome: MaterializedTransactionOutcomeKind
  readonly rejectionCode: string | null
  readonly failingPreconditionId: number | null
  readonly failingPreconditionIndex: number | null
  readonly failingStatementIndex: number | null
  readonly failurePhase: 'precondition' | 'statement' | 'finalize' | null
  readonly failingConstraintId: number | null
  readonly resultEnvelopeVersion: 1 | null
  readonly resultEnvelope: Uint8Array | null
  readonly resultDigest: Uint8Array | null
}

export interface MaterializationOutcomeChange {
  readonly txId: Uint8Array
  readonly previous: MaterializedTransactionOutcomeKind | null
  readonly current: MaterializedTransactionOutcomeKind
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
  readonly outcomeChanges: readonly MaterializationOutcomeChange[]
}

export interface MaterializationPublicationRequest {
  readonly publicationKey: string
  readonly expectedRevision: bigint
  readonly targetRevision: bigint
  readonly targetOrderLength: number
  readonly candidateIdentity: string
}

export interface CoordinatedMaterialization {
  readonly revision: MaterializedRevision
  readonly publication: MaterializationPublicationRequest
}

/** Calculates or follows one immutable materialization candidate. */
export interface MaterializationCoordinator {
  materialize(
    orderedTransactions: readonly AdmittedTransaction[],
  ): Promise<CoordinatedMaterialization | null>
}

export type MaterializedLocalSqlValue =
  | { readonly kind: 'null' }
  | { readonly kind: 'integer'; readonly value: string }
  | { readonly kind: 'real'; readonly value: number }
  | { readonly kind: 'text'; readonly value: string }
  | { readonly kind: 'blob'; readonly value: Uint8Array }

export interface MaterializedObserveOptions {
  readonly atRevision?: bigint
  readonly resultMode: SqlResultMode
}

export interface MaterializedObservationResult {
  readonly revision: bigint
  readonly orderLength: number
  readonly executionManifestDigest: Uint8Array
  readonly statement: SqlStatement
  readonly result: CanonicalSqlResult
  readonly resultDigest: Uint8Array
}

export interface MaterializedLocalSqlResult {
  readonly revision: bigint
  readonly orderLength: number
  readonly columns: readonly { readonly name: string; readonly declaredType?: string }[]
  readonly rows: readonly (readonly MaterializedLocalSqlValue[])[]
}

export interface MaterializedRevisionSnapshot {
  readonly revision: bigint
  readonly orderLength: number
  readonly executionManifestDigest: Uint8Array
}

/** Reads one published immutable materialization and reports revision changes. */
export interface MaterializedQueryService {
  readonly revision: bigint
  readonly orderLength: number
  readonly executionManifestDigest: Uint8Array
  observe(statement: SqlStatement, options: MaterializedObserveOptions): Promise<MaterializedObservationResult>
  localSql(
    sql: string,
    parameters?: readonly MaterializedLocalSqlValue[],
    options?: { readonly atRevision?: bigint },
  ): MaterializedLocalSqlResult
  validateStatement(statement: SqlStatement, mode: 'precondition' | 'body'): readonly MaterializedSqlDiagnostic[]
  outcome(txId: Uint8Array): MaterializedTransactionOutcome | null
  transactionResult(txId: Uint8Array): TransactionResultEnvelopeV1 | null
  subscribe(subscriber: (revision: MaterializedRevisionSnapshot) => void): () => void
}

export interface MaterializedSqlDiagnostic {
  readonly code: string
  readonly startByte?: number
  readonly endByte?: number
}

export interface MaterializationPublicationResult extends MaterializedRevisionSnapshot {
  readonly status: 'published' | 'already_current' | 'reconciled'
  readonly publicationKey: string | null
}

/** Owns mutable publication; reducers and query services do not. */
export interface MaterializationPublicationStore {
  publish(request: MaterializationPublicationRequest): Promise<MaterializationPublicationResult>
  reconcile(expectation: {
    readonly targetOrderLength: number
    readonly targetRevision?: bigint
  }): Promise<MaterializationPublicationResult>
}

export interface ChronologMaterializationRuntime {
  readonly coordinator: MaterializationCoordinator
  readonly queries: MaterializedQueryService
  readonly publications: MaterializationPublicationStore
  close(): void | Promise<void>
}

export function publicationRequestForRevision(
  revision: MaterializedRevision,
): MaterializationPublicationRequest {
  return {
    publicationKey: `revision:${revision.contentHash}`,
    expectedRevision: revision.previousRevision,
    targetRevision: revision.revision,
    targetOrderLength: revision.orderLength,
    candidateIdentity: revision.contentHash,
  }
}
