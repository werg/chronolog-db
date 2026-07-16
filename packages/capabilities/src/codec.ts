import {
  DOMAINS,
  assertCanonicalCbor,
  assertKnownIntegerKeys,
  encodeCanonicalCbor,
  expectArray,
  expectBytes,
  expectMap,
  expectString,
  expectUint64,
  expectVersion,
  integerMap,
  optional,
  protocolInvariant,
  required,
  type CborValue,
} from '@chronolog/protocol'
import type {
  CapabilityGrant,
  CapabilityRevision,
  ClockPolicy,
  GenesisManifest,
  ReaderHistoryScope,
  RecoveryPayload,
  RecoveryRecord,
  ResourcePolicy,
  SignedCapabilityRevision,
  SignedGenesis,
  ValidationPolicy,
} from './types.js'

const ROLES = ['reader', 'writer', 'validator', 'administrator', 'schema-administrator'] as const
const SCOPES = ['snapshot', 'audit'] as const

function roleIndex(role: CapabilityGrant['role']): bigint {
  const index = ROLES.indexOf(role)
  protocolInvariant(index >= 0, 'SCHEMA_INVALID', 'Unknown capability role')
  return BigInt(index)
}

function grantToCbor(grant: CapabilityGrant): CborValue {
  protocolInvariant(grant.signingPublicKey.length === 32, 'SCHEMA_INVALID', 'Capability signing key must contain 32 bytes')
  protocolInvariant(grant.validFromRevision >= 0n, 'INTEGER_OUT_OF_RANGE', 'Capability revision cannot be negative')
  if (grant.validUntilRevision !== undefined) {
    protocolInvariant(grant.validUntilRevision >= grant.validFromRevision, 'SCHEMA_INVALID', 'Capability validity interval is inverted')
  }
  if (grant.role === 'validator') {
    protocolInvariant(grant.minimumAuthorTimestampMs !== undefined, 'SCHEMA_INVALID', 'Validator capability requires a timestamp floor')
  } else {
    protocolInvariant(grant.validatorClass === undefined && grant.minimumAuthorTimestampMs === undefined, 'SCHEMA_INVALID', 'Only validators may carry validator fields')
  }
  if (grant.role === 'reader') {
    protocolInvariant(grant.readerScope !== undefined && grant.hpkePublicKey !== undefined, 'SCHEMA_INVALID', 'Reader capability requires scope and HPKE key')
    protocolInvariant(grant.hpkePublicKey.length === 32, 'SCHEMA_INVALID', 'Reader HPKE key must contain 32 bytes')
  } else {
    protocolInvariant(grant.readerScope === undefined && grant.hpkePublicKey === undefined, 'SCHEMA_INVALID', 'Only readers may carry reader fields')
  }
  if (grant.transportAuthor !== undefined) {
    protocolInvariant(grant.transportAuthor.length > 0, 'SCHEMA_INVALID', 'Capability transport author must not be empty')
  }
  const scope = grant.readerScope === undefined ? undefined : BigInt(SCOPES.indexOf(grant.readerScope))
  return integerMap([
    [0, grant.subjectId], [1, grant.signingPublicKey], [2, roleIndex(grant.role)],
    [3, grant.validFromRevision], [4, grant.validUntilRevision], [5, grant.organization],
    [6, grant.validatorClass], [7, grant.minimumAuthorTimestampMs], [8, scope], [9, grant.hpkePublicKey],
    [10, grant.transportAuthor],
  ])
}

function grantFromCbor(value: CborValue, field: string): CapabilityGrant {
  const map = expectMap(value, field)
  assertKnownIntegerKeys(map, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10], field)
  const roleValue = expectUint64(required(map, 2, `${field}.role`), `${field}.role`)
  protocolInvariant(roleValue < BigInt(ROLES.length), 'SCHEMA_INVALID', `${field}.role is unknown`)
  const role = ROLES[Number(roleValue)]
  protocolInvariant(role !== undefined, 'SCHEMA_INVALID', `${field}.role is unknown`)
  const until = optional(map, 4)
  const organization = optional(map, 5)
  const validatorClass = optional(map, 6)
  const floor = optional(map, 7)
  const scopeValue = optional(map, 8)
  const hpkeKey = optional(map, 9)
  const transportAuthor = optional(map, 10)
  const grant: CapabilityGrant = {
    subjectId: expectBytes(required(map, 0, `${field}.subject_id`), `${field}.subject_id`),
    signingPublicKey: expectBytes(required(map, 1, `${field}.signing_key`), `${field}.signing_key`, 32),
    role,
    validFromRevision: expectUint64(required(map, 3, `${field}.valid_from`), `${field}.valid_from`),
    ...(until === undefined ? {} : { validUntilRevision: expectUint64(until, `${field}.valid_until`) }),
    ...(organization === undefined ? {} : { organization: expectString(organization, `${field}.organization`) }),
    ...(validatorClass === undefined ? {} : { validatorClass: expectString(validatorClass, `${field}.validator_class`) }),
    ...(floor === undefined ? {} : { minimumAuthorTimestampMs: expectUint64(floor, `${field}.minimum_timestamp`) }),
    ...(scopeValue === undefined ? {} : {
      readerScope: (() => {
        const index = expectUint64(scopeValue, `${field}.reader_scope`)
        protocolInvariant(index < BigInt(SCOPES.length), 'SCHEMA_INVALID', `${field}.reader_scope is unknown`)
        return SCOPES[Number(index)] as ReaderHistoryScope
      })(),
    }),
    ...(hpkeKey === undefined ? {} : { hpkePublicKey: expectBytes(hpkeKey, `${field}.hpke_key`, 32) }),
    ...(transportAuthor === undefined ? {} : { transportAuthor: expectString(transportAuthor, `${field}.transport_author`) }),
  }
  grantToCbor(grant)
  return grant
}

function policyToCbor(policy: ValidationPolicy): CborValue {
  protocolInvariant(policy.minimumValidators > 0n, 'SCHEMA_INVALID', 'Validation threshold must be positive')
  const classes = new Map<string, CborValue>()
  for (const [name, minimum] of policy.classMinimums) {
    protocolInvariant(name.length > 0 && minimum > 0n, 'SCHEMA_INVALID', 'Class requirements must be named and positive')
    classes.set(name, minimum)
  }
  const organizations = [...new Set(policy.requiredOrganizations)]
  protocolInvariant(organizations.length === policy.requiredOrganizations.length, 'SCHEMA_INVALID', 'Required organizations must be unique')
  protocolInvariant(organizations.every((organization) => organization.length > 0), 'SCHEMA_INVALID', 'Required organizations must not be empty')
  return integerMap([[0, policy.version], [1, policy.minimumValidators], [2, classes], [3, organizations]])
}

function policyFromCbor(value: CborValue, field: string): ValidationPolicy {
  const map = expectMap(value, field)
  assertKnownIntegerKeys(map, [0, 1, 2, 3], field)
  const encodedClasses = expectMap(required(map, 2, `${field}.classes`), `${field}.classes`)
  const classes = new Map<string, bigint>()
  for (const [name, minimum] of encodedClasses) {
    protocolInvariant(typeof name === 'string', 'SCHEMA_INVALID', `${field}.classes keys must be text`)
    classes.set(name, expectUint64(minimum, `${field}.classes.${name}`))
  }
  const policy = {
    version: expectUint64(required(map, 0, `${field}.version`), `${field}.version`),
    minimumValidators: expectUint64(required(map, 1, `${field}.minimum`), `${field}.minimum`),
    classMinimums: classes,
    requiredOrganizations: expectArray(required(map, 3, `${field}.organizations`), `${field}.organizations`)
      .map((item, index) => expectString(item, `${field}.organizations[${index}]`)),
  }
  policyToCbor(policy)
  return policy
}

function clockToCbor(policy: ClockPolicy): CborValue {
  return integerMap([[0, policy.maxFutureSkewMs], [1, policy.cutoffLagMs], [2, policy.heartbeatIntervalMs]])
}

function clockFromCbor(value: CborValue): ClockPolicy {
  const map = expectMap(value, 'genesis.clock_policy')
  assertKnownIntegerKeys(map, [0, 1, 2], 'genesis.clock_policy')
  return {
    maxFutureSkewMs: expectUint64(required(map, 0, 'clock.max_future_skew'), 'clock.max_future_skew'),
    cutoffLagMs: expectUint64(required(map, 1, 'clock.cutoff_lag'), 'clock.cutoff_lag'),
    heartbeatIntervalMs: expectUint64(required(map, 2, 'clock.heartbeat_interval'), 'clock.heartbeat_interval'),
  }
}

function resourceToCbor(policy: ResourcePolicy): CborValue {
  return integerMap([[0, policy.maxCandidateBytes], [1, policy.maxProgramNodes], [2, policy.maxPreconditions], [3, policy.maxMutations]])
}

function resourceFromCbor(value: CborValue): ResourcePolicy {
  const map = expectMap(value, 'genesis.resource_policy')
  assertKnownIntegerKeys(map, [0, 1, 2, 3], 'genesis.resource_policy')
  return {
    maxCandidateBytes: expectUint64(required(map, 0, 'resource.max_candidate_bytes'), 'resource.max_candidate_bytes'),
    maxProgramNodes: expectUint64(required(map, 1, 'resource.max_program_nodes'), 'resource.max_program_nodes'),
    maxPreconditions: expectUint64(required(map, 2, 'resource.max_preconditions'), 'resource.max_preconditions'),
    maxMutations: expectUint64(required(map, 3, 'resource.max_mutations'), 'resource.max_mutations'),
  }
}

function genesisToCbor(value: GenesisManifest): CborValue {
  protocolInvariant(value.rootAdminPublicKey.length === 32, 'SCHEMA_INVALID', 'Genesis root key must contain 32 bytes')
  protocolInvariant(value.recoveryPublicKeys.length === 3 && value.recoveryPublicKeys.every((key) => key.length === 32), 'SCHEMA_INVALID', 'Genesis requires exactly three 32-byte recovery keys')
  protocolInvariant(value.recoveryThreshold === 2n, 'SCHEMA_INVALID', 'V0.1 recovery threshold must be two of three')
  protocolInvariant(value.validationPolicies.length > 0, 'SCHEMA_INVALID', 'Genesis requires at least one validation policy')
  return integerMap([
    [0, 1n], [1, value.groupId], [2, value.schemaId], [3, value.rootAdminPublicKey],
    [4, value.capabilityLogFeed], [5, value.recoveryPublicKeys], [6, value.recoveryThreshold],
    [7, value.initialCapabilities.map(grantToCbor)], [8, value.validationPolicies.map(policyToCbor)],
    [9, clockToCbor(value.clockPolicy)], [10, resourceToCbor(value.resourcePolicy)],
    [11, value.encryptionSuite], [12, value.createdAtMs],
  ])
}

export function encodeGenesisManifest(value: GenesisManifest): Uint8Array {
  return encodeCanonicalCbor(genesisToCbor(value))
}

export function decodeGenesisManifest(bytes: Uint8Array): GenesisManifest {
  const map = expectMap(assertCanonicalCbor(bytes), 'genesis')
  assertKnownIntegerKeys(map, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], 'genesis')
  expectVersion(map, 1n, 'genesis')
  const recovery = expectArray(required(map, 5, 'genesis.recovery_keys'), 'genesis.recovery_keys')
  protocolInvariant(recovery.length === 3, 'SCHEMA_INVALID', 'Genesis requires exactly three recovery keys')
  const manifest: GenesisManifest = {
    groupId: expectBytes(required(map, 1, 'genesis.group_id'), 'genesis.group_id'),
    schemaId: expectBytes(required(map, 2, 'genesis.schema_id'), 'genesis.schema_id'),
    rootAdminPublicKey: expectBytes(required(map, 3, 'genesis.root_key'), 'genesis.root_key', 32),
    capabilityLogFeed: expectBytes(required(map, 4, 'genesis.capability_feed'), 'genesis.capability_feed'),
    recoveryPublicKeys: [
      expectBytes(recovery[0] ?? null, 'genesis.recovery_keys[0]', 32),
      expectBytes(recovery[1] ?? null, 'genesis.recovery_keys[1]', 32),
      expectBytes(recovery[2] ?? null, 'genesis.recovery_keys[2]', 32),
    ],
    recoveryThreshold: expectUint64(required(map, 6, 'genesis.recovery_threshold'), 'genesis.recovery_threshold'),
    initialCapabilities: expectArray(required(map, 7, 'genesis.capabilities'), 'genesis.capabilities').map((item, index) => grantFromCbor(item, `genesis.capabilities[${index}]`)),
    validationPolicies: expectArray(required(map, 8, 'genesis.policies'), 'genesis.policies').map((item, index) => policyFromCbor(item, `genesis.policies[${index}]`)),
    clockPolicy: clockFromCbor(required(map, 9, 'genesis.clock_policy')),
    resourcePolicy: resourceFromCbor(required(map, 10, 'genesis.resource_policy')),
    encryptionSuite: expectString(required(map, 11, 'genesis.encryption_suite'), 'genesis.encryption_suite'),
    createdAtMs: expectUint64(required(map, 12, 'genesis.created_at'), 'genesis.created_at'),
  }
  genesisToCbor(manifest)
  return manifest
}

export function encodeSignedGenesis(value: SignedGenesis): Uint8Array {
  return encodeCanonicalCbor(integerMap([
    [0, 1n],
    [1, encodeGenesisManifest(value.manifest)],
    [2, value.signature],
  ]))
}

export function decodeSignedGenesis(bytes: Uint8Array): SignedGenesis {
  const map = expectMap(assertCanonicalCbor(bytes), 'signed_genesis')
  assertKnownIntegerKeys(map, [0, 1, 2], 'signed_genesis')
  expectVersion(map, 1n, 'signed_genesis')
  return {
    manifest: decodeGenesisManifest(expectBytes(required(map, 1, 'signed_genesis.manifest'), 'signed_genesis.manifest')),
    signature: expectBytes(required(map, 2, 'signed_genesis.signature'), 'signed_genesis.signature', 64),
  }
}

function revisionToCbor(value: CapabilityRevision): CborValue {
  protocolInvariant(value.revision > 0n, 'SCHEMA_INVALID', 'Capability revision must be positive')
  protocolInvariant(value.issuerRootPublicKey.length === 32, 'SCHEMA_INVALID', 'Revision issuer key must contain 32 bytes')
  protocolInvariant((value.successorRootPublicKey === undefined) === (value.successorCapabilityLogFeed === undefined), 'SCHEMA_INVALID', 'Root and feed succession must be declared together')
  return integerMap([
    [0, 1n], [1, value.groupId], [2, value.revision], [3, value.previousRevisionDigest],
    [4, value.issuerRootPublicKey], [5, value.grants.map(grantToCbor)], [6, value.revocations],
    [7, value.validationPolicies.map(policyToCbor)], [8, value.successorRootPublicKey],
    [9, value.successorCapabilityLogFeed],
  ])
}

export function encodeCapabilityRevision(value: CapabilityRevision): Uint8Array {
  return encodeCanonicalCbor(revisionToCbor(value))
}

export function decodeCapabilityRevision(bytes: Uint8Array): CapabilityRevision {
  const map = expectMap(assertCanonicalCbor(bytes), 'capability_revision')
  assertKnownIntegerKeys(map, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 'capability_revision')
  expectVersion(map, 1n, 'capability_revision')
  const successorRoot = optional(map, 8)
  const successorFeed = optional(map, 9)
  const revision: CapabilityRevision = {
    groupId: expectBytes(required(map, 1, 'revision.group_id'), 'revision.group_id'),
    revision: expectUint64(required(map, 2, 'revision.number'), 'revision.number'),
    previousRevisionDigest: expectBytes(required(map, 3, 'revision.previous_digest'), 'revision.previous_digest', 32),
    issuerRootPublicKey: expectBytes(required(map, 4, 'revision.issuer'), 'revision.issuer', 32),
    grants: expectArray(required(map, 5, 'revision.grants'), 'revision.grants').map((item, index) => grantFromCbor(item, `revision.grants[${index}]`)),
    revocations: expectArray(required(map, 6, 'revision.revocations'), 'revision.revocations').map((item, index) => expectBytes(item, `revision.revocations[${index}]`, 32)),
    validationPolicies: expectArray(required(map, 7, 'revision.policies'), 'revision.policies').map((item, index) => policyFromCbor(item, `revision.policies[${index}]`)),
    ...(successorRoot === undefined ? {} : { successorRootPublicKey: expectBytes(successorRoot, 'revision.successor_root', 32) }),
    ...(successorFeed === undefined ? {} : { successorCapabilityLogFeed: expectBytes(successorFeed, 'revision.successor_feed') }),
  }
  revisionToCbor(revision)
  return revision
}

export function encodeSignedCapabilityRevision(value: SignedCapabilityRevision): Uint8Array {
  return encodeCanonicalCbor(integerMap([
    [0, 1n],
    [1, encodeCapabilityRevision(value.revision)],
    [2, value.signature],
  ]))
}

export function decodeSignedCapabilityRevision(bytes: Uint8Array): SignedCapabilityRevision {
  const map = expectMap(assertCanonicalCbor(bytes), 'signed_capability_revision')
  assertKnownIntegerKeys(map, [0, 1, 2], 'signed_capability_revision')
  expectVersion(map, 1n, 'signed_capability_revision')
  return {
    revision: decodeCapabilityRevision(expectBytes(required(map, 1, 'signed_revision.payload'), 'signed_revision.payload')),
    signature: expectBytes(required(map, 2, 'signed_revision.signature'), 'signed_revision.signature', 64),
  }
}

function recoveryToCbor(value: RecoveryPayload): CborValue {
  protocolInvariant(value.newRevision > value.lastRevision, 'SCHEMA_INVALID', 'Recovery must advance the membership revision')
  protocolInvariant(value.newRootPublicKey.length === 32, 'SCHEMA_INVALID', 'Recovery root key must contain 32 bytes')
  protocolInvariant(value.reopenHistory === (value.reopeningReason !== undefined), 'SCHEMA_INVALID', 'History reopening requires exactly one explicit reason')
  protocolInvariant(value.validatorGrants.every((grant) => grant.role === 'validator'), 'SCHEMA_INVALID', 'Recovery validator grants must all be validator capabilities')
  return integerMap([
    [0, 1n], [1, value.groupId], [2, value.lastRevision], [3, value.lastRevisionDigest],
    [4, value.newRevision], [5, value.newRootPublicKey], [6, value.newCapabilityLogFeed],
    [7, value.validatorGrants.map(grantToCbor)], [8, value.reopenHistory], [9, value.reopeningReason],
  ])
}

export function encodeRecoveryPayload(value: RecoveryPayload): Uint8Array {
  return encodeCanonicalCbor(recoveryToCbor(value))
}

export function decodeRecoveryPayload(bytes: Uint8Array): RecoveryPayload {
  const map = expectMap(assertCanonicalCbor(bytes), 'recovery')
  assertKnownIntegerKeys(map, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 'recovery')
  expectVersion(map, 1n, 'recovery')
  const reason = optional(map, 9)
  const payload: RecoveryPayload = {
    groupId: expectBytes(required(map, 1, 'recovery.group_id'), 'recovery.group_id'),
    lastRevision: expectUint64(required(map, 2, 'recovery.last_revision'), 'recovery.last_revision'),
    lastRevisionDigest: expectBytes(required(map, 3, 'recovery.last_digest'), 'recovery.last_digest', 32),
    newRevision: expectUint64(required(map, 4, 'recovery.new_revision'), 'recovery.new_revision'),
    newRootPublicKey: expectBytes(required(map, 5, 'recovery.new_root'), 'recovery.new_root', 32),
    newCapabilityLogFeed: expectBytes(required(map, 6, 'recovery.new_feed'), 'recovery.new_feed'),
    validatorGrants: expectArray(required(map, 7, 'recovery.validator_grants'), 'recovery.validator_grants').map((item, index) => grantFromCbor(item, `recovery.validator_grants[${index}]`)),
    reopenHistory: (() => {
      const value = required(map, 8, 'recovery.reopen_history')
      protocolInvariant(typeof value === 'boolean', 'SCHEMA_INVALID', 'Recovery history-reopening flag must be boolean')
      return value
    })(),
    ...(reason === undefined ? {} : { reopeningReason: expectString(reason, 'recovery.reopening_reason') }),
  }
  recoveryToCbor(payload)
  return payload
}

export function encodeRecoveryRecord(value: RecoveryRecord): Uint8Array {
  return encodeCanonicalCbor(integerMap([
    [0, 1n],
    [1, encodeRecoveryPayload(value.payload)],
    [2, value.signatures.map((signature) => integerMap([
      [0, signature.recoveryKeyIndex],
      [1, signature.signature],
    ]))],
  ]))
}

export function decodeRecoveryRecord(bytes: Uint8Array): RecoveryRecord {
  const map = expectMap(assertCanonicalCbor(bytes), 'recovery_record')
  assertKnownIntegerKeys(map, [0, 1, 2], 'recovery_record')
  expectVersion(map, 1n, 'recovery_record')
  const signatures = expectArray(required(map, 2, 'recovery_record.signatures'), 'recovery_record.signatures')
    .map((item, index) => {
      const signature = expectMap(item, `recovery_record.signatures[${index}]`)
      assertKnownIntegerKeys(signature, [0, 1], `recovery_record.signatures[${index}]`)
      return {
        recoveryKeyIndex: expectUint64(required(signature, 0, 'recovery_signature.key_index'), 'recovery_signature.key_index'),
        signature: expectBytes(required(signature, 1, 'recovery_signature.signature'), 'recovery_signature.signature', 64),
      }
    })
  protocolInvariant(signatures.length > 0, 'SCHEMA_INVALID', 'Recovery record must contain at least one signature')
  for (let index = 1; index < signatures.length; index += 1) {
    protocolInvariant(
      (signatures[index - 1]?.recoveryKeyIndex ?? -1n) < (signatures[index]?.recoveryKeyIndex ?? -1n),
      'SCHEMA_INVALID',
      'Recovery signatures must be uniquely sorted by recovery key index',
    )
  }
  return {
    payload: decodeRecoveryPayload(expectBytes(required(map, 1, 'recovery_record.payload'), 'recovery_record.payload')),
    signatures,
  }
}

export const capabilityCodecInternals = {
  grantToCbor,
  policyToCbor,
  genesisToCbor,
  revisionToCbor,
  recoveryToCbor,
}

export { DOMAINS }
