import type { ExecutionManifest } from '@chronolog/ir'
import type { TransactionCore } from '@chronolog/protocol'

export type ContentHashAlgorithm = 'sha2-256' | 'blake3-256' | 'dolt-blake3-160'

export interface ContentId {
  readonly algorithm: ContentHashAlgorithm
  readonly digest: Uint8Array
}

export interface CodecId {
  readonly number: number
  readonly version: number
}

/** An exact, non-enumerating CAS read capability. */
export interface ExactObjectRef {
  readonly storeId: Uint8Array
  readonly codec: CodecId
  readonly contentId: ContentId
}

export interface DoltChunkId {
  readonly doltFormatVersion: number
  readonly contentId: ContentId
}

export interface DatabaseStateDigest {
  readonly stateFormatVersion: number
  readonly contentId: ContentId
}

/** Portable shape of the immutable database identity exposed by reducer workerd. */
export interface ExactDatabaseRef {
  readonly storeId: Uint8Array
  readonly doltFormatVersion: number
  readonly canonicalGenesisCommit: DoltChunkId
  readonly commitHash: DoltChunkId
  readonly stateDigest: DatabaseStateDigest
}

export type ChronologArtifactKind =
  | 'admitted-suffix'
  | 'execution-manifest'
  | 'continuation'
  | 'materialization-manifest'
  | 'outcome-changes'

/**
 * Chronolog's typed interpretation of a generic exact CAS object. The runtime
 * owns ObjectRef; Chronolog owns these artifact kinds and their codecs.
 */
export interface ExactArtifactRef {
  readonly kind: ChronologArtifactKind
  readonly formatVersion: number
  readonly object: ExactObjectRef
}

export interface MaterializationInput {
  readonly manifest: ExactArtifactRef
  readonly database: ExactDatabaseRef
}

/**
 * Pure materialization has no ambient time or randomness. Version 1 requires
 * the two optional values to be null, making any future semantic use an
 * explicit contract-version change instead of an accidental host dependency.
 */
export interface ChronologMaterializationContext {
  readonly groupId: Uint8Array
  readonly logicalTimeMs: bigint | null
  readonly entropySeed: Uint8Array | null
}

export interface ChronologMaterializationInvocation {
  readonly version: 1
  readonly profile: 'pure'
  readonly context: ChronologMaterializationContext
  readonly previous: MaterializationInput | null
  readonly replayBase: MaterializationInput
  readonly admittedSuffix: ExactArtifactRef
  readonly executionManifest: ExactArtifactRef
  readonly continuation: ExactArtifactRef | null
  readonly expectedEngineDigest: Uint8Array
  readonly expectedExecutionManifestDigest: Uint8Array
  readonly expectedPreviousOrderDigest: Uint8Array
  readonly replayFromIndex: number
  readonly targetOrderLength: number
  readonly targetOrderDigest: Uint8Array
}

export interface AdmittedTransaction {
  readonly txId: Uint8Array
  readonly authorFeedSequence: bigint
  readonly candidateDigest: Uint8Array
  readonly canonicalCandidate: Uint8Array
  readonly core: TransactionCore
}

export interface ChronologAdmittedSuffix {
  readonly version: 1
  readonly groupId: Uint8Array
  readonly replayFromIndex: number
  readonly targetOrderLength: number
  readonly targetOrderDigest: Uint8Array
  readonly transactions: readonly AdmittedTransaction[]
}

export interface ChronologMaterializationContinuation {
  readonly version: 1
  readonly invocationDigest: Uint8Array
  readonly partialDatabase: ExactDatabaseRef
  readonly nextOrderIndex: number
  readonly prefixOrderDigest: Uint8Array
}

export interface OutcomeChangeSummary {
  readonly txId: Uint8Array
  readonly previous: string | null
  readonly current: string
  readonly previousRejectionCode: string | null
  readonly currentRejectionCode: string | null
}

export interface ChronologCompletedMaterialization {
  readonly kind: 'completed'
  readonly outputDatabase: ExactDatabaseRef
  readonly materializationManifest: ExactArtifactRef
  readonly outcomeChanges: ExactArtifactRef
  readonly orderLength: number
  readonly orderDigest: Uint8Array
  readonly replayFromIndex: number
  readonly stateDigest: ContentId
}

export interface ChronologUnchangedMaterialization {
  readonly kind: 'unchanged'
  readonly outputDatabase: ExactDatabaseRef
  readonly materializationManifest: ExactArtifactRef
  readonly orderLength: number
  readonly orderDigest: Uint8Array
  readonly stateDigest: ContentId
}

export interface ChronologCheckpointedMaterialization {
  readonly kind: 'checkpointed'
  readonly partialDatabase: ExactDatabaseRef
  readonly continuation: ExactArtifactRef
  readonly nextOrderIndex: number
  readonly prefixOrderDigest: Uint8Array
}

export type ChronologMaterializationOutcome =
  | ChronologCompletedMaterialization
  | ChronologUnchangedMaterialization
  | ChronologCheckpointedMaterialization

export interface ResolvedMaterializationInvocation {
  readonly invocation: ChronologMaterializationInvocation
  readonly executionManifest: ExecutionManifest
  readonly admittedSuffix: ChronologAdmittedSuffix
  readonly continuation: ChronologMaterializationContinuation | null
  /** Exact objects read while resolving the invocation, sorted by canonical identity. */
  readonly exactReadSet: readonly ExactObjectRef[]
}

/** The host must return the bytes for exactly the supplied ref or reject. */
export interface ExactObjectReader {
  readExact(ref: ExactObjectRef): Promise<Uint8Array>
}

export interface ChronologMaterializerKernel {
  materialize(input: ResolvedMaterializationInvocation): Promise<ChronologMaterializationOutcome>
}

export interface DifferentialObservation {
  readonly version: 1
  readonly orderLength: number
  readonly orderDigest: Uint8Array
  readonly stateDigest: ContentId
  readonly protectedLogDigest: Uint8Array
  readonly outcomeSetDigest: Uint8Array
  readonly queryResultDigest: Uint8Array
  readonly rejectionAttributionDigest: Uint8Array
}

export interface DifferentialFixtureObject {
  readonly ref: ExactObjectRef
  readonly bytes: Uint8Array
}

/** Canonical, self-contained input that can be sent to Node or workerd. */
export interface DifferentialMaterializationFixture {
  readonly version: 1
  readonly name: string
  readonly invocation: Uint8Array
  readonly objects: readonly DifferentialFixtureObject[]
}

export interface DifferentialMaterializerBackend {
  readonly name: string
  run(fixture: Uint8Array): Promise<Uint8Array>
}

export type DifferentialObservationProjector = (
  outcome: ChronologMaterializationOutcome,
  resolved: ResolvedMaterializationInvocation,
) => DifferentialObservation | Promise<DifferentialObservation>

export type ExactObjectVerifier = (ref: ExactObjectRef, bytes: Uint8Array) => boolean | Promise<boolean>
