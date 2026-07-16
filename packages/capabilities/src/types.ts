export type CapabilityRole =
  | 'reader'
  | 'writer'
  | 'validator'
  | 'administrator'
  | 'schema-administrator'

export type ReaderHistoryScope = 'snapshot' | 'audit'

export interface CapabilityGrant {
  readonly subjectId: Uint8Array
  readonly signingPublicKey: Uint8Array
  /** Authenticated outer replication feed authorized for this capability. */
  readonly transportAuthor?: string
  readonly role: CapabilityRole
  readonly validFromRevision: bigint
  readonly validUntilRevision?: bigint
  readonly organization?: string
  readonly validatorClass?: string
  readonly minimumAuthorTimestampMs?: bigint
  readonly readerScope?: ReaderHistoryScope
  readonly hpkePublicKey?: Uint8Array
}

export interface ValidationPolicy {
  readonly version: bigint
  readonly minimumValidators: bigint
  readonly classMinimums: ReadonlyMap<string, bigint>
  readonly requiredOrganizations: readonly string[]
}

export interface ClockPolicy {
  readonly maxFutureSkewMs: bigint
  readonly cutoffLagMs: bigint
  readonly heartbeatIntervalMs: bigint
}

export interface ResourcePolicy {
  readonly maxCandidateBytes: bigint
  readonly maxProgramNodes: bigint
  readonly maxPreconditions: bigint
  readonly maxMutations: bigint
}

export interface GenesisManifest {
  readonly groupId: Uint8Array
  readonly schemaId: Uint8Array
  readonly rootAdminPublicKey: Uint8Array
  readonly capabilityLogFeed: Uint8Array
  readonly recoveryPublicKeys: readonly [Uint8Array, Uint8Array, Uint8Array]
  readonly recoveryThreshold: bigint
  readonly initialCapabilities: readonly CapabilityGrant[]
  readonly validationPolicies: readonly ValidationPolicy[]
  readonly clockPolicy: ClockPolicy
  readonly resourcePolicy: ResourcePolicy
  readonly encryptionSuite: string
  readonly createdAtMs: bigint
}

export interface SignedGenesis {
  readonly manifest: GenesisManifest
  readonly signature: Uint8Array
}

export interface CapabilityRevision {
  readonly groupId: Uint8Array
  readonly revision: bigint
  readonly previousRevisionDigest: Uint8Array
  readonly issuerRootPublicKey: Uint8Array
  readonly grants: readonly CapabilityGrant[]
  readonly revocations: readonly Uint8Array[]
  readonly validationPolicies: readonly ValidationPolicy[]
  readonly successorRootPublicKey?: Uint8Array
  readonly successorCapabilityLogFeed?: Uint8Array
}

export interface SignedCapabilityRevision {
  readonly revision: CapabilityRevision
  readonly signature: Uint8Array
}

export interface EffectiveCapability {
  readonly id: Uint8Array
  readonly grant: CapabilityGrant
  readonly grantedAtRevision: bigint
  readonly revokedAtRevision?: bigint
}

export interface EffectivePolicy {
  readonly id: Uint8Array
  readonly policy: ValidationPolicy
  readonly installedAtRevision: bigint
}

export interface CapabilitySnapshot {
  readonly groupId: Uint8Array
  readonly revision: bigint
  readonly revisionDigest: Uint8Array
  readonly rootAdminPublicKey: Uint8Array
  readonly capabilityLogFeed: Uint8Array
  readonly capabilities: ReadonlyMap<string, EffectiveCapability>
  readonly policies: ReadonlyMap<string, EffectivePolicy>
  readonly recoveryPublicKeys: readonly [Uint8Array, Uint8Array, Uint8Array]
  readonly recoveryThreshold: bigint
  readonly historyReopened: boolean
  readonly recoveryEventDigest?: Uint8Array
}

export interface ValidatorEvidence {
  readonly capabilityId: Uint8Array
  readonly validatorId: Uint8Array
  readonly organization?: string
  readonly validatorClass?: string
}

export interface PolicyEvaluation {
  readonly satisfied: boolean
  readonly selected: readonly ValidatorEvidence[]
  readonly missing: readonly string[]
}

export interface RecoveryPayload {
  readonly groupId: Uint8Array
  readonly lastRevision: bigint
  readonly lastRevisionDigest: Uint8Array
  readonly newRevision: bigint
  readonly newRootPublicKey: Uint8Array
  readonly newCapabilityLogFeed: Uint8Array
  readonly validatorGrants: readonly CapabilityGrant[]
  readonly reopenHistory: boolean
  readonly reopeningReason?: string
}

export interface RecoverySignature {
  readonly recoveryKeyIndex: bigint
  readonly signature: Uint8Array
}

export interface RecoveryRecord {
  readonly payload: RecoveryPayload
  readonly signatures: readonly RecoverySignature[]
}
