import type { CanonicalSchemaIdentity } from '@chronolog/protocol'

/** Chronolog's local RPC API. Consensus codecs are versioned separately. */
export const RPC_API_VERSION = 'chronolog.rpc' as const

export type RpcApiVersion = typeof RPC_API_VERSION
export type Revision = string
export type GroupId = string
export type TransactionId = string
export type DraftId = string
export type RequestId = string
export type CanonicalBytes = string
export type ResultModeName = 'scalar' | 'ordered' | 'multiset' | 'set'

export type LocalSqlValue =
  | { readonly kind: 'null' }
  | { readonly kind: 'integer'; readonly value: string }
  | { readonly kind: 'real'; readonly value: number }
  | { readonly kind: 'text'; readonly value: string }
  | { readonly kind: 'blob'; readonly value: Uint8Array }

export interface LocalSqlResult {
  readonly columns: readonly { readonly name: string; readonly declaredType?: string }[]
  readonly rows: readonly (readonly LocalSqlValue[])[]
  readonly truncated: boolean
  readonly consensusSafe: false
}

export interface RpcSqlBinding {
  readonly parameter:
    | { readonly kind: 'index'; readonly index: number }
    | { readonly kind: 'name'; readonly name: string }
  /** Canonical SqlBindingValue CBOR, base64url encoded. */
  readonly canonicalValue: CanonicalBytes
}

export interface RpcSqlStatement {
  readonly sql: string
  readonly bindings: readonly RpcSqlBinding[]
}

export interface RevisionMetadata {
  readonly groupId: GroupId
  readonly eventSetRevision: Revision
  readonly materializedRevision: Revision
  readonly publishedOrderLength: string
  readonly executionManifestDigest: string
  readonly replaying: boolean
}

export interface CanonicalSqlResultResponse {
  readonly resultMode: ResultModeName
  readonly canonicalResult: CanonicalBytes
  readonly resultDigest: string
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

export interface LiveSqlCursor {
  readonly groupId: GroupId
  readonly queryDigest: string
  readonly eventSetRevision: Revision
}

export interface LiveSqlRequest extends Omit<LocalSqlRequest, 'atRevision'> {
  readonly resume?: LiveSqlCursor
}

export type LiveSqlEvent =
  | { readonly type: 'snapshot' | 'change'; readonly revision: RevisionMetadata; readonly queryDigest: string; readonly result: LocalSqlResult; readonly previousMaterializedRevision?: Revision }
  | { readonly type: 'reset'; readonly revision: RevisionMetadata; readonly queryDigest: string; readonly result?: LocalSqlResult; readonly reason: 'history_unavailable' | 'server_restart' | 'subscription_rebuilt' | 'schema_changed' | 'manifest_changed' | 'query_invalid' }

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
export interface GetStatusRequest { readonly groupId?: GroupId; readonly requestId: RequestId }
export interface StreamStatusRequest extends GetStatusRequest { readonly resumeAfterEventSetRevision?: Revision }

export interface BeginDraftRequest {
  readonly groupId: GroupId
  readonly requestId: RequestId
  readonly atRevision?: Revision
  readonly ttlMs?: number
}

export interface BeginDraftResponse {
  readonly draftId: DraftId
  readonly pinnedRevision: RevisionMetadata
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

export interface ObserveSqlRequest extends DraftCommandBase {
  readonly statement: RpcSqlStatement
  readonly resultMode: ResultModeName
  readonly applicationLabel?: string
}

export interface ObserveSqlResponse extends CanonicalSqlResultResponse {
  readonly observationId: string
  readonly observationToken: string
  readonly revision: RevisionMetadata
  readonly statement: RpcSqlStatement
}

export type SqlPreconditionSource =
  | { readonly kind: 'observation'; readonly observationId: string; readonly observationToken: string }
  | {
      readonly kind: 'inline'
      readonly id: number
      readonly statement: RpcSqlStatement
      readonly resultMode: ResultModeName
      readonly canonicalResult: CanonicalBytes
    }
  | {
      readonly kind: 'digest'
      readonly id: number
      readonly statement: RpcSqlStatement
      readonly resultMode: ResultModeName
      readonly digest: string
    }
  | { readonly kind: 'assert_true'; readonly id: number; readonly statement: RpcSqlStatement }

export interface AddPreconditionRequest extends DraftCommandBase {
  readonly source: SqlPreconditionSource
  readonly applicationLabel?: string
}

export interface AddStatementsRequest extends DraftCommandBase {
  readonly statements: readonly RpcSqlStatement[]
}

export interface ReplaceStatementsRequest extends DraftCommandBase {
  readonly statements: readonly RpcSqlStatement[]
}

export interface SqlDiagnostic {
  readonly code: string
  readonly severity: 'error' | 'warning'
  readonly preconditionIndex?: number
  readonly statementIndex?: number
  readonly startByte?: number
  readonly endByte?: number
  readonly applicationLabel?: string
}

export interface DraftMutationResponse {
  readonly draftId: DraftId
  readonly draftRevision: string
  readonly preconditionCount: number
  readonly statementCount: number
  readonly diagnostics: readonly SqlDiagnostic[]
  readonly expiresAt: string
}

export type ValidateDraftRequest = DraftCommandBase
export type ValidateDraftResponse = DraftMutationResponse
export interface RebaseDraftRequest extends DraftCommandBase {
  readonly toRevision?: Revision
  readonly refreshObservations: boolean
  readonly renewContext: boolean
}
export interface RefreshedObservation extends ObserveSqlResponse { readonly changed: boolean }
export interface RebaseDraftResponse extends DraftMutationResponse {
  readonly pinnedRevision: RevisionMetadata
  readonly executionManifestDigest: string
  readonly reservedAuthorTimestampMs: string
  readonly transactionNonce: CanonicalBytes
  readonly refreshedObservations: readonly RefreshedObservation[]
  readonly invalidatedObservationIds: readonly string[]
}
export type CancelDraftRequest = DraftCommandBase
export interface CancelDraftResponse { readonly draftId: DraftId; readonly cancelled: boolean }
export interface PublishDraftRequest extends DraftCommandBase { readonly idempotencyKey: string }
export interface PublishDraftResponse {
  readonly transactionId: TransactionId
  readonly candidateDigest: string
  readonly authorTimestampMs: string
  readonly transactionNonce: CanonicalBytes
  readonly executionManifestDigest: string
  readonly durableLocalAppend: true
  readonly publishedAt: string
}

export interface AcceptedResultReference {
  readonly envelopeVersion: 1
  readonly digest: string
  readonly byteLength: number
}

export interface GetTransactionResultRequest {
  readonly groupId: GroupId
  readonly transactionId: TransactionId
  readonly requestId: RequestId
  readonly atMaterializedRevision?: Revision
}
export interface GetTransactionResultResponse {
  readonly revision: RevisionMetadata
  readonly transactionId: TransactionId
  readonly reference: AcceptedResultReference
  readonly canonicalEnvelope: CanonicalBytes
}

export type TransactionPhase = 'candidate_published' | 'collecting_attestations' | 'validation_threshold_met' | 'admissible' | 'replicated' | 'accepted' | 'rejected'
export interface RejectionAttribution {
  readonly phase: 'precondition' | 'statement' | 'finalize'
  readonly code: string
  readonly preconditionId: number | null
  readonly preconditionIndex: number | null
  readonly statementIndex: number | null
  readonly constraintIdentity: CanonicalSchemaIdentity | null
  readonly triggerIdentity: CanonicalSchemaIdentity | null
  readonly applicationLabel?: string
}
export type TransactionResult =
  | { readonly type: 'pending' }
  | { readonly type: 'accepted'; readonly result: AcceptedResultReference }
  | { readonly type: 'rejected'; readonly attribution: RejectionAttribution }
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
export interface GetOutcomeRequest { readonly groupId: GroupId; readonly transactionId: TransactionId; readonly requestId: RequestId }
export interface StreamOutcomeRequest extends GetOutcomeRequest { readonly resumeAfterEventSetRevision?: Revision }

export type SettlementConfidence = 'insufficient' | 'provisional' | 'policy_watermark_reached' | 'history_reopened'
export interface EvidenceReference { readonly kind: 'candidate' | 'attestation' | 'heartbeat' | 'membership' | 'epoch'; readonly reference: string }
export interface HistoryReopeningEvent { readonly eventId: string; readonly type: 'recovery' | 'membership_change' | 'epoch_change'; readonly effectiveFromTimestamp: string; readonly membershipRevision: string }
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
export interface StreamSettlementEvidenceRequest extends GetSettlementEvidenceRequest { readonly resumeAfterEventSetRevision?: Revision }
export interface ValidatorWatermark { readonly groupId: GroupId; readonly revision: Revision; readonly policyId: string; readonly membershipRevision: string; readonly timestamp?: string; readonly supportingValidators: readonly string[]; readonly blockedBy: readonly string[] }
export interface GetValidatorWatermarkRequest { readonly groupId: GroupId; readonly requestId: RequestId }
export type ReplicationState = 'offline' | 'connecting' | 'syncing' | 'current' | 'degraded'
export interface ReplicationStatus { readonly groupId: GroupId; readonly revision: Revision; readonly connectedPeers: number; readonly knownPeers: number; readonly feedsWithGaps: number; readonly quarantinedFeeds: readonly string[]; readonly pendingPayloads: number; readonly ingestionBacklog: number; readonly materializationPending: boolean; readonly state: ReplicationState }
export interface GetReplicationStatusRequest { readonly groupId: GroupId; readonly requestId: RequestId }
export interface StreamReplicationStatusRequest extends GetReplicationStatusRequest { readonly resumeAfterEventSetRevision?: Revision }

export type GovernanceCapabilityRole =
  | 'reader'
  | 'writer'
  | 'validator'
  | 'administrator'
  | 'schema-administrator'

export interface GovernanceCapabilityStatus {
  readonly capabilityId: string
  readonly subjectId: string
  readonly signingPublicKey: string
  readonly transportAuthor?: string
  readonly role: GovernanceCapabilityRole
  readonly validFromRevision: string
  readonly validUntilRevision?: string
  readonly revokedAtRevision?: string
  readonly active: boolean
  readonly organization?: string
  readonly validatorClass?: string
  readonly readerScope?: 'snapshot' | 'audit'
  readonly hpkePublicKey?: string
}

export interface GetGovernanceStatusRequest { readonly groupId: GroupId; readonly requestId: RequestId }
export interface GovernanceStatus {
  readonly groupId: GroupId
  readonly revision: string
  readonly revisionDigest: string
  readonly rootAdminPublicKey: string
  readonly capabilityLogFeed: string
  readonly currentEpoch: string | null
  readonly historyReopened: boolean
  readonly capabilities: readonly GovernanceCapabilityStatus[]
}

export interface GrantCapabilityRequest extends GetGovernanceStatusRequest {
  readonly subjectId: string
  readonly signingPublicKey: string
  readonly transportAuthor?: string
  readonly role: GovernanceCapabilityRole
  readonly validUntilRevision?: string
  readonly organization?: string
  readonly validatorClass?: string
  readonly minimumAuthorTimestampMs?: string
  readonly readerScope?: 'snapshot' | 'audit'
  readonly hpkePublicKey?: string
}
export interface GrantCapabilityResponse { readonly revision: string; readonly capabilityId: string }
export interface RevokeCapabilitiesRequest extends GetGovernanceStatusRequest { readonly capabilityIds: readonly string[] }
export interface RevokeCapabilitiesResponse { readonly revision: string; readonly revokedCapabilityIds: readonly string[] }
export type RotateEpochRequest = GetGovernanceStatusRequest
export interface RotateEpochResponse { readonly epoch: string }
export interface GrantHistoricalAccessRequest extends GetGovernanceStatusRequest { readonly subjectId: string }
export interface GrantHistoricalAccessResponse { readonly epochManifestsPublished: number }
export interface PublishRecoveryRequest extends GetGovernanceStatusRequest { readonly canonicalRecoveryRecord: string }
export interface PublishRecoveryResponse { readonly published: true }
