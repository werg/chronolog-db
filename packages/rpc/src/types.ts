/** Chronolog's local RPC API. Canonical consensus encodings are versioned separately. */
export const RPC_API_VERSION = 'chronolog.rpc' as const

export type RpcApiVersion = typeof RPC_API_VERSION
export type Revision = string
export type GroupId = string
export type TransactionId = string
export type DraftId = string
export type RequestId = string
/** Unpadded base64url canonical bytes. */
export type CanonicalBytes = string

/** Backend values returned only by the explicitly non-consensus local SQL API. */
export type LocalSqlValue =
  | { readonly kind: 'null' }
  | { readonly kind: 'integer'; readonly value: string }
  | { readonly kind: 'real'; readonly value: number }
  | { readonly kind: 'text'; readonly value: string }
  | { readonly kind: 'blob'; readonly value: Uint8Array }

export interface LocalSqlColumn {
  readonly name: string
  readonly declaredType?: string
}

export interface LocalSqlResult {
  readonly columns: readonly LocalSqlColumn[]
  readonly rows: readonly (readonly LocalSqlValue[])[]
  readonly truncated: boolean
  /** This result is backend-oriented local data and MUST NOT enter a transaction draft. */
  readonly consensusSafe: false
}

export type ResultModeName = 'scalar' | 'ordered' | 'multiset' | 'set'

export type LogicalTypeName =
  | 'boolean'
  | 'int64'
  | 'decimal'
  | 'text'
  | 'blob'
  | 'uuid'
  | 'timestamp_ms'
  | 'duration_ms'
  | 'json'
  | 'vector'

export interface LogicalResultColumn {
  readonly id: number
  readonly name: string
  readonly logicalType: LogicalTypeName
  readonly nullable: boolean
  readonly precision?: number
  readonly scale?: number
  readonly vectorElement?: 'i8' | 'u8' | 'i16' | 'i32' | 'f32' | 'f64'
  readonly vectorDimensions?: number
}

/** JSON-safe presentation of a decoded logical value. Exact bytes remain in canonicalResult. */
export type DisplayValue =
  | { readonly kind: 'null' }
  | { readonly kind: 'boolean'; readonly value: boolean }
  | { readonly kind: 'int64'; readonly value: string }
  | { readonly kind: 'decimal'; readonly coefficient: string; readonly scale: number }
  | { readonly kind: 'text'; readonly value: string }
  | { readonly kind: 'blob'; readonly value: CanonicalBytes }
  | { readonly kind: 'uuid'; readonly value: CanonicalBytes }
  | { readonly kind: 'timestamp_ms'; readonly value: string }
  | { readonly kind: 'duration_ms'; readonly value: string }
  | { readonly kind: 'json'; readonly canonicalJson: string }
  | {
      readonly kind: 'vector'
      readonly element: 'i8' | 'u8' | 'i16' | 'i32' | 'f32' | 'f64'
      readonly dimensions: number
      readonly value: CanonicalBytes
    }

/** Event cursors and database snapshots are deliberately separate domains. */
export interface RevisionMetadata {
  readonly groupId: GroupId
  readonly eventSetRevision: Revision
  readonly materializedRevision: Revision
  readonly publishedOrderLength: string
  readonly schemaDigest: string
  readonly executionManifestDigest: string
  readonly replaying: boolean
}

export interface CanonicalQueryResult {
  readonly schema: readonly LogicalResultColumn[]
  readonly resultMode: ResultModeName
  readonly canonicalResult: CanonicalBytes
  readonly resultDigest: string
  readonly displayRows: readonly (readonly DisplayValue[])[]
  readonly displayTruncated: boolean
}

export interface ExecuteIrRequest {
  readonly groupId: GroupId
  readonly requestId: RequestId
  readonly queryIr: CanonicalBytes
  readonly parameters: CanonicalBytes
  readonly parameterNames: readonly string[]
  readonly maxDisplayRows?: number
  readonly atRevision?: Revision
}

export interface ExecuteIrResponse {
  readonly revision: RevisionMetadata
  readonly queryDigest: string
  readonly result: CanonicalQueryResult
}

export interface LiveIrRequest extends Omit<ExecuteIrRequest, 'atRevision'> {
  readonly resume?: LiveQueryCursor
}

export interface LiveQueryCursor {
  readonly groupId: GroupId
  readonly queryDigest: string
  readonly eventSetRevision: Revision
}

export type LiveIrEvent =
  | {
      readonly type: 'snapshot' | 'change'
      readonly revision: RevisionMetadata
      readonly queryDigest: string
      readonly result: CanonicalQueryResult
      readonly previousMaterializedRevision?: Revision
    }
  | {
      readonly type: 'reset'
      readonly revision: RevisionMetadata
      readonly queryDigest: string
      readonly result: CanonicalQueryResult
      readonly reason: 'history_unavailable' | 'server_restart' | 'subscription_rebuilt' | 'schema_changed' | 'manifest_changed'
    }

export interface LocalSqlRequest {
  readonly groupId: GroupId
  readonly requestId: RequestId
  readonly sql: string
  readonly parameters: readonly LocalSqlValue[]
  readonly maxRows?: number
  readonly atRevision?: Revision
}

export interface LocalSqlResponse {
  readonly revision: RevisionMetadata
  readonly result: LocalSqlResult
}

export type NodeLifecycleState = 'starting' | 'ready' | 'replaying' | 'degraded' | 'stopping'

export interface NodeStatus {
  readonly apiVersion: RpcApiVersion
  readonly state: NodeLifecycleState
  readonly nodeId: string
  readonly revision?: RevisionMetadata
  readonly writable: boolean
  readonly validating: boolean
  readonly lastErrorCode?: string
}

export interface GetStatusRequest {
  readonly groupId?: GroupId
  readonly requestId: RequestId
}

export interface StreamStatusRequest extends GetStatusRequest {
  readonly resumeAfterEventSetRevision?: Revision
}

export interface BeginDraftRequest {
  readonly groupId: GroupId
  readonly requestId: RequestId
  readonly atRevision?: Revision
  readonly ttlMs?: number
}

export interface BeginDraftResponse {
  readonly draftId: DraftId
  readonly pinnedRevision: RevisionMetadata
  readonly schemaDigest: string
  readonly executionManifestDigest: string
  readonly reservedAuthorTimestampMs: string
  readonly transactionNonce: CanonicalBytes
  readonly expiresAt: string
}

export interface DraftCommandBase {
  readonly groupId: GroupId
  readonly draftId: DraftId
  readonly requestId: RequestId
}

export interface ObserveIrRequest extends DraftCommandBase {
  readonly queryIr: CanonicalBytes
  readonly parameters: CanonicalBytes
  readonly parameterNames: readonly string[]
  readonly maxDisplayRows?: number
  readonly applicationLabel?: string
}

export interface ObservationResult extends CanonicalQueryResult {
  readonly observationId: string
  readonly observationToken: string
  readonly revision: RevisionMetadata
  readonly queryDigest: string
  readonly dependsOnContext: readonly string[]
}

export type ObserveIrResponse = ObservationResult

export interface AddAssertionIrRequest extends DraftCommandBase {
  readonly queryIr: CanonicalBytes
  readonly parameters: CanonicalBytes
  readonly parameterNames: readonly string[]
  readonly applicationLabel?: string
}

export type ExpectationSource =
  | {
      readonly kind: 'observation'
      readonly observationId: string
      readonly observationToken: string
    }
  | {
      readonly kind: 'canonical_result'
      readonly queryIr: CanonicalBytes
      readonly parameters: CanonicalBytes
      readonly parameterNames: readonly string[]
      readonly canonicalResult: CanonicalBytes
    }

export interface AddExpectationRequest extends DraftCommandBase {
  readonly source: ExpectationSource
  readonly applicationLabel?: string
}

export interface AddMutationIrRequest extends DraftCommandBase {
  readonly mutationIr: CanonicalBytes
  readonly applicationLabel?: string
}

export interface IrDiagnostic {
  readonly nodeId: number
  readonly code: string
  readonly severity: 'error' | 'warning'
  readonly message: string
  readonly applicationLabel?: string
}

export interface DraftMutationResponse {
  readonly draftId: DraftId
  readonly draftRevision: string
  readonly preconditionCount: number
  readonly mutationCount: number
  readonly diagnostics: readonly IrDiagnostic[]
  readonly expiresAt: string
}

export type ValidateDraftRequest = DraftCommandBase
export type ValidateDraftResponse = DraftMutationResponse

export interface RebaseDraftRequest extends DraftCommandBase {
  readonly toRevision?: Revision
  readonly refreshObservations: boolean
  readonly renewContext: boolean
}

export interface RefreshedObservation extends ObservationResult {
  readonly changed: boolean
}

export interface RebaseDraftResponse extends DraftMutationResponse {
  readonly pinnedRevision: RevisionMetadata
  readonly schemaDigest: string
  readonly executionManifestDigest: string
  readonly reservedAuthorTimestampMs: string
  readonly transactionNonce: CanonicalBytes
  readonly refreshedObservations: readonly RefreshedObservation[]
  readonly invalidatedObservationIds: readonly string[]
}

export type CancelDraftRequest = DraftCommandBase

export interface CancelDraftResponse {
  readonly draftId: DraftId
  readonly cancelled: boolean
}

export interface PublishDraftRequest extends DraftCommandBase {
  /** Makes a retry resolve to the original publication, never a second candidate. */
  readonly idempotencyKey: string
}

export interface PublishDraftResponse {
  readonly transactionId: TransactionId
  readonly candidateDigest: string
  readonly authorTimestampMs: string
  readonly transactionNonce: CanonicalBytes
  readonly schemaDigest: string
  readonly executionManifestDigest: string
  readonly durableLocalAppend: true
  readonly publishedAt: string
}

export type TransactionPhase =
  | 'candidate_published'
  | 'collecting_attestations'
  | 'validation_threshold_met'
  | 'admissible'
  | 'replicated'
  | 'accepted'
  | 'rejected'

export interface RejectionAttribution {
  readonly code: string
  readonly preconditionId?: number
  readonly commandId?: number
  readonly ruleId?: number
  readonly constraintId?: number
  readonly applicationLabel?: string
}

export type TransactionResult =
  | { readonly type: 'pending' }
  | { readonly type: 'accepted'; readonly stateDigest?: string }
  | { readonly type: 'rejected'; readonly attribution: RejectionAttribution; readonly message: string }

export interface TransactionOutcome {
  readonly transactionId: TransactionId
  readonly phase: TransactionPhase
  readonly outcome: TransactionResult
  readonly eventSetRevision: Revision
  readonly materializedRevision: Revision
  readonly orderKey?: string
  readonly changedByReplay: boolean
  readonly admissible: boolean
  readonly observedAt: string
}

export interface GetOutcomeRequest {
  readonly groupId: GroupId
  readonly transactionId: TransactionId
  readonly requestId: RequestId
}

export interface StreamOutcomeRequest extends GetOutcomeRequest {
  readonly resumeAfterEventSetRevision?: Revision
}

export type SettlementConfidence = 'insufficient' | 'provisional' | 'policy_watermark_reached' | 'history_reopened'

export interface EvidenceReference {
  readonly kind: 'candidate' | 'attestation' | 'heartbeat' | 'membership' | 'epoch'
  readonly reference: string
}

export interface HistoryReopeningEvent {
  readonly eventId: string
  readonly type: 'recovery' | 'membership_change' | 'epoch_change'
  readonly effectiveFromTimestamp: string
  readonly membershipRevision: string
}

export interface SettlementEvidence {
  readonly transactionId: TransactionId
  readonly outcome: TransactionOutcome
  readonly evidenceRevision: Revision
  readonly orderKey: string
  readonly authorTimestamp: string
  readonly validationPolicyId: string
  readonly membershipRevision: string
  readonly policyWatermarkTimestamp?: string
  readonly blockingHeartbeats: readonly string[]
  readonly unresolvedReferences: readonly EvidenceReference[]
  readonly historyReopeningEvents: readonly HistoryReopeningEvent[]
  readonly confidence: SettlementConfidence
  readonly calculatedAt: string
}

export type GetSettlementEvidenceRequest = GetOutcomeRequest

export interface StreamSettlementEvidenceRequest extends GetSettlementEvidenceRequest {
  readonly resumeAfterEventSetRevision?: Revision
}

export interface ValidatorWatermark {
  readonly groupId: GroupId
  readonly revision: Revision
  readonly policyId: string
  readonly membershipRevision: string
  readonly timestamp?: string
  readonly supportingValidators: readonly string[]
  readonly blockedBy: readonly string[]
}

export interface GetValidatorWatermarkRequest {
  readonly groupId: GroupId
  readonly requestId: RequestId
}

export type ReplicationState = 'offline' | 'connecting' | 'syncing' | 'current' | 'degraded'

export interface ReplicationStatus {
  readonly groupId: GroupId
  readonly revision: Revision
  readonly connectedPeers: number
  readonly knownPeers: number
  readonly feedsWithGaps: number
  readonly pendingPayloads: number
  /** Durable transport records waiting to be reduced into the control store. */
  readonly ingestionBacklog: number
  /** True while the authoritative admitted order is ahead of DoltLite. */
  readonly materializationPending: boolean
  readonly state: ReplicationState
}

export interface GetReplicationStatusRequest {
  readonly groupId: GroupId
  readonly requestId: RequestId
}

export interface StreamReplicationStatusRequest extends GetReplicationStatusRequest {
  readonly resumeAfterEventSetRevision?: Revision
}
