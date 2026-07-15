import type {
  CanonicalQueryResult,
  IrDiagnostic,
  Mutation,
  Query,
} from '@chronolog/ir'
import type { TransactionOrderKey } from '@chronolog/protocol'

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
  readonly failingCommandId: number | null
  readonly failingRuleId: number | null
  readonly failingConstraintId: number | null
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
  readonly schemaDigest: Uint8Array
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

export interface MaterializedQueryContext {
  readonly groupId?: Uint8Array
  readonly membershipRevision?: Uint8Array
  readonly validationPolicy?: Uint8Array
  readonly authorId?: Uint8Array
  readonly authorTimestampMs?: bigint
  readonly transactionNonce?: Uint8Array
  readonly candidateDigest?: Uint8Array
  readonly transactionId?: Uint8Array
  readonly authorFeedSequence?: bigint
}

export interface MaterializedQueryOptions {
  readonly atRevision?: bigint
  readonly context?: MaterializedQueryContext
}

export interface MaterializedQueryResult {
  readonly revision: bigint
  readonly orderLength: number
  readonly schemaDigest: Uint8Array
  readonly executionManifestDigest: Uint8Array
  readonly result: CanonicalQueryResult
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
  readonly schemaDigest: Uint8Array
  readonly executionManifestDigest: Uint8Array
}

/** Reads one published immutable materialization and reports revision changes. */
export interface MaterializedQueryService {
  readonly revision: bigint
  readonly orderLength: number
  readonly schemaDigest: Uint8Array
  readonly executionManifestDigest: Uint8Array
  queryIr(query: Query, options?: MaterializedQueryOptions): Promise<MaterializedQueryResult>
  localSql(
    sql: string,
    parameters?: readonly MaterializedLocalSqlValue[],
    options?: { readonly atRevision?: bigint },
  ): MaterializedLocalSqlResult
  validateQuery(query: Query): readonly IrDiagnostic[]
  validateMutation(mutation: Mutation): readonly IrDiagnostic[]
  outcome(txId: Uint8Array): MaterializedTransactionOutcome | null
  subscribe(subscriber: (revision: MaterializedRevisionSnapshot) => void): () => void
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
    publicationKey: `legacy:${revision.contentHash}`,
    expectedRevision: revision.previousRevision,
    targetRevision: revision.revision,
    targetOrderLength: revision.orderLength,
    candidateIdentity: revision.contentHash,
  }
}
