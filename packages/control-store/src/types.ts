import type { TransactionOrderKey } from '@chronolog/protocol'

export type CandidateState =
  | 'waiting_for_payload'
  | 'pending_validation'
  | 'admissible'
  | 'invalid_protocol'
  | 'unauthorized'
  | 'quarantined'

export interface StoredCandidate {
  readonly txId: Uint8Array
  readonly groupId: Uint8Array
  readonly candidateDigest: Uint8Array
  readonly validationPolicy: Uint8Array
  readonly orderKey: TransactionOrderKey
  readonly canonicalPayload?: Uint8Array
  readonly state: CandidateState
  readonly stateReason?: string
  readonly proofAttestationIds: readonly Uint8Array[]
}

export interface PutCandidateInput extends Omit<StoredCandidate, 'proofAttestationIds'> {
  readonly proofAttestationIds?: readonly Uint8Array[]
}

export interface StoredAttestation {
  readonly attestationId: Uint8Array
  readonly txId: Uint8Array
  readonly validatorId: Uint8Array
  readonly validatorCapability: Uint8Array
  readonly membershipRevision: Uint8Array
  readonly candidateDigest: Uint8Array
  readonly validatorFeedSequence: bigint
  readonly authorTimestampMs: bigint
  readonly acceptedAboveMs: bigint
}

export interface ValidatorHeartbeat {
  readonly heartbeatId: Uint8Array
  readonly validatorId: Uint8Array
  readonly validatorCapability: Uint8Array
  readonly membershipRevision: Uint8Array
  readonly validatorFeedSequence: bigint
  readonly acceptanceCutoffMs: bigint
  /** True only if the validator feed is known contiguous through this message. */
  readonly feedContiguous: boolean
}

export type WatermarkPolicy =
  | {
      readonly kind: 'threshold'
      readonly policyId: string
      readonly validatorIds: readonly Uint8Array[]
      readonly threshold: number
    }
  | {
      readonly kind: 'proof-alternatives'
      readonly policyId: string
      /** Every entry is a minimal validator set that could satisfy the policy. */
      readonly minimalProofs: readonly (readonly Uint8Array[])[]
    }

export interface WatermarkEvidence {
  readonly policyId: string
  readonly cutoffMs: bigint | null
  readonly blockingValidatorIds: readonly Uint8Array[]
  readonly heartbeatIds: readonly Uint8Array[]
  readonly explanation:
    | 'established'
    | 'insufficient_contiguous_heartbeats'
    | 'invalid_policy'
}

export interface SettlementEvidence {
  readonly txId: Uint8Array
  readonly candidateState: CandidateState
  readonly orderKey: TransactionOrderKey
  readonly proofAttestationIds: readonly Uint8Array[]
  readonly watermark: WatermarkEvidence
  readonly belowWatermark: boolean
  readonly unresolvedAttestationIds: readonly Uint8Array[]
  readonly historyReopeningIds: readonly string[]
}

export interface MaterializedHead {
  readonly localRevision: bigint
  readonly headRef: string
  readonly orderLength: number
  readonly orderDigest: Uint8Array
}

export interface StoredCheckpoint {
  readonly prefixLength: number
  readonly checkpointRef: string
  readonly prefixDigest: Uint8Array
  readonly pinned: boolean
}

export interface HistoryReopening {
  readonly id: string
  readonly floorMs: bigint
  readonly membershipRevision: Uint8Array
  readonly reason: string
}

export type ControlStoreDelta =
  | {
      readonly sequence: bigint
      readonly kind: 'candidate_added'
      readonly txId: Uint8Array
      readonly state: CandidateState
    }
  | {
      readonly sequence: bigint
      readonly kind: 'candidate_state_changed'
      readonly txId: Uint8Array
      readonly previousState: CandidateState
      readonly state: CandidateState
      readonly reason?: string
    }
  | {
      readonly sequence: bigint
      readonly kind: 'attestation_added'
      readonly attestationId: Uint8Array
      readonly txId: Uint8Array
      readonly unresolvedCandidate: boolean
    }
  | {
      readonly sequence: bigint
      readonly kind: 'order_append' | 'order_insert'
      readonly txId: Uint8Array
      readonly index: number
      readonly previousLength: number
    }
  | {
      readonly sequence: bigint
      readonly kind: 'heartbeat_advanced'
      readonly heartbeatId: Uint8Array
      readonly validatorId: Uint8Array
      readonly cutoffMs: bigint
      readonly feedContiguous: boolean
    }
  | {
      readonly sequence: bigint
      readonly kind: 'materialized_head_published'
      readonly head: MaterializedHead
    }
  | {
      readonly sequence: bigint
      readonly kind: 'checkpoint_stored'
      readonly checkpoint: StoredCheckpoint
    }
  | {
      readonly sequence: bigint
      readonly kind: 'history_reopened'
      readonly reopening: HistoryReopening
    }

export interface ControlStoreSnapshot {
  readonly format: 'chronolog-control-store/v1'
  readonly sequence: bigint
  readonly candidates: readonly StoredCandidate[]
  readonly attestations: readonly StoredAttestation[]
  readonly heartbeats: readonly ValidatorHeartbeat[]
  readonly orderedTxIds: readonly Uint8Array[]
  readonly deltas: readonly ControlStoreDelta[]
  readonly materializedHead: MaterializedHead | null
  readonly checkpoints: readonly StoredCheckpoint[]
  readonly historyReopenings: readonly HistoryReopening[]
}

export interface ControlStorePersistence {
  load(): ControlStoreSnapshot | null
  save(snapshot: ControlStoreSnapshot): void
  /** Optional coalescing hook for rebuildable persistence implementations. */
  requestSave?(snapshot: () => ControlStoreSnapshot): void
  flush?(): void
}

export interface AdmissionEvaluation {
  readonly state: Extract<CandidateState, 'pending_validation' | 'admissible'>
  readonly proofAttestationIds?: readonly Uint8Array[]
  readonly reason?: string
}

export type AdmissionEvaluator = (
  candidate: StoredCandidate,
  attestations: readonly StoredAttestation[],
) => AdmissionEvaluation
