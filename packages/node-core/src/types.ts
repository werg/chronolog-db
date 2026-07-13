import type { ControlStore, StoredAttestation, WatermarkPolicy } from '@chronolog/control-store'
import type {
  AdmittedTransaction,
  DeterministicMaterializer,
  LocalSqlQueryResult,
  LocalSqlValue,
  MaterializedIrQueryResult,
  TransactionOutcome,
} from '@chronolog/materializer-doltlite'
import type { Query, TransactionProgram } from '@chronolog/ir'
import type {
  Ed25519KeyPair,
  TransactionCore,
} from '@chronolog/protocol'
import type { ChronologTransport, TransportStatus } from '@chronolog/transport-ssb'

export interface Clock {
  now(): number
}

export interface RandomSource {
  bytes(length: number): Uint8Array
}

export interface EnvelopeCipher {
  readonly epochId: Uint8Array
  seal(plaintext: Uint8Array, associatedData: Uint8Array): Promise<Uint8Array>
  open(ciphertext: Uint8Array, associatedData: Uint8Array): Promise<Uint8Array>
}

export interface CandidateAdmissionContext {
  readonly groupId: Uint8Array
  readonly membershipRevision: Uint8Array
  readonly validationPolicy: Uint8Array
  readonly writerId: Uint8Array
  readonly validatorId: Uint8Array
  readonly validatorCapability: Uint8Array
}

/**
 * Resolves authority at the transaction's pinned membership revision. It can be
 * backed by the in-log capability system, a central service, a chain, or a
 * recovery-controlled out-of-band source. No fixed validator set is assumed.
 */
export interface MembershipResolver {
  canWrite(context: Omit<CandidateAdmissionContext, 'validatorId' | 'validatorCapability'>): boolean | Promise<boolean>
  canValidate(context: CandidateAdmissionContext): boolean | Promise<boolean>
  threshold(context: Omit<CandidateAdmissionContext, 'validatorId' | 'validatorCapability'>): number | Promise<number>
  selectAdmission?(
    context: Omit<CandidateAdmissionContext, 'validatorId' | 'validatorCapability'>,
    attestations: readonly StoredAttestation[],
  ): readonly StoredAttestation[] | Promise<readonly StoredAttestation[]>
  watermarkPolicy?(core: TransactionCore): WatermarkPolicy | null | Promise<WatermarkPolicy | null>
}

export interface ValidatorOptions {
  readonly capabilityId: Uint8Array
  readonly policyVersion?: bigint
  readonly cutoffLagMs?: number
  readonly maxFutureSkewMs?: number
  readonly heartbeatIntervalMs?: number
  readonly initialAcceptedAboveMs?: bigint
}

export interface ChronologNodeOptions {
  readonly groupId: Uint8Array
  readonly groupRoute?: Uint8Array
  readonly membershipRevision: Uint8Array
  readonly validationPolicy: Uint8Array
  readonly identity: Ed25519KeyPair
  readonly transport: ChronologTransport
  readonly materializer: DeterministicMaterializer
  readonly membership: MembershipResolver
  readonly controlStore?: ControlStore
  readonly validator?: ValidatorOptions
  readonly clock?: Clock
  readonly random?: RandomSource
  readonly envelopeCipher?: EnvelopeCipher
}

export interface PublishTransactionInput {
  readonly program: TransactionProgram
  readonly authorTimestampMs?: bigint
  readonly nonce?: Uint8Array
  readonly metadata?: ReadonlyMap<string, Uint8Array>
  readonly membershipRevision?: Uint8Array
  readonly validationPolicy?: Uint8Array
}

export interface PublishedTransaction {
  readonly txId: Uint8Array
  readonly txIdText: string
  readonly candidateDigest: Uint8Array
  readonly core: TransactionCore
}

export interface ReservedTransactionContext {
  readonly authorTimestampMs: bigint
  readonly nonce: Uint8Array
}

export interface NodeRevisionEvent {
  readonly revision: bigint
  readonly reason: 'candidate' | 'attestation' | 'heartbeat' | 'materialized' | 'error'
  readonly txId?: Uint8Array
  readonly error?: Error
}

export interface NodeStatus {
  readonly started: boolean
  readonly closed: boolean
  readonly eventSetRevision: bigint
  readonly candidates: number
  readonly admitted: number
  readonly materializedRevision: bigint
  readonly orderLength: number
  readonly schemaDigest: Uint8Array
  readonly executionManifestDigest: Uint8Array
  readonly validating: boolean
  readonly lastError?: string
  readonly transport: TransportStatus
}

export type NodeIrQueryResult = MaterializedIrQueryResult
export type NodeLocalSqlQueryResult = LocalSqlQueryResult
export type NodeQuery = Query
export type NodeLocalSqlParameter = LocalSqlValue
