import type { ControlStore, StoredAttestation, WatermarkPolicy } from '@chronolog/control-store'
import type {
  ChronologMaterializationRuntime,
  MaterializedObservationResult,
  MaterializedLocalSqlResult,
  MaterializedLocalSqlValue,
} from '@chronolog/materializer'
import type {
  Ed25519KeyPair,
  SqlStatement,
  SqlTransactionProgram,
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

export interface ValidatorAuthorityContext {
  readonly groupId: Uint8Array
  readonly membershipRevision: Uint8Array
  readonly validatorId: Uint8Array
  readonly validatorCapability: Uint8Array
}

export interface TransportAuthorContext {
  readonly groupId: Uint8Array
  readonly membershipRevision: Uint8Array
  readonly role: 'writer' | 'validator'
  readonly signingId: Uint8Array
  readonly transportAuthor: string
  readonly validatorCapability?: Uint8Array
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
  /** Authorizes revision-scoped validator heartbeat evidence. */
  canHeartbeat?(context: ValidatorAuthorityContext): boolean | Promise<boolean>
  /**
   * Binds an inner Chronolog signing key to an authenticated outer feed. When
   * omitted, node-core permits only records authored by the local transport
   * identity and signed by the local node identity.
   */
  canUseTransportAuthor?(context: TransportAuthorContext): boolean | Promise<boolean>
  /** Resolves the version committed by attestations for a pinned policy. */
  policyVersion?(
    context: Omit<CandidateAdmissionContext, 'validatorId' | 'validatorCapability'>,
  ): bigint | Promise<bigint>
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
  readonly materialization: ChronologMaterializationRuntime
  readonly membership: MembershipResolver
  readonly controlStore?: ControlStore
  readonly validator?: ValidatorOptions
  readonly clock?: Clock
  readonly random?: RandomSource
  readonly envelopeCipher?: EnvelopeCipher
  /** Maximum transiently failed records retained before history-backed recovery takes over. */
  readonly maximumRetryRecords?: number
}

export interface PublishTransactionInput {
  readonly program: SqlTransactionProgram
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
  readonly processedTransportRecords: number
  readonly materializationPending: boolean
  readonly materializedRevision: bigint
  readonly orderLength: number
  readonly executionManifestDigest: Uint8Array
  readonly validating: boolean
  readonly lastError?: string
  readonly transport: TransportStatus
}

export type NodeObservationResult = MaterializedObservationResult
export type NodeLocalSqlQueryResult = MaterializedLocalSqlResult
export type NodeSqlStatement = SqlStatement
export type NodeLocalSqlParameter = MaterializedLocalSqlValue
