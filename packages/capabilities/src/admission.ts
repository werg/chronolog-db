import {
  bytesToHex,
  equalBytes,
  type TransactionCore,
  type ValidatorAttestation,
} from '@chronolog/protocol'
import { evaluateValidationPolicy } from './policy.js'
import { isCapabilityActive } from './reducer.js'
import type {
  CapabilitySnapshot,
  EffectiveCapability,
  PolicyEvaluation,
  ValidationPolicy,
  ValidatorEvidence,
} from './types.js'

export interface AdmissionProofEvaluation extends PolicyEvaluation {
  readonly consideredAttestations: number
  readonly rejectedAttestations: readonly string[]
}

export function activeCapabilityById(
  snapshot: CapabilitySnapshot,
  id: Uint8Array,
  revision = snapshot.revision,
): EffectiveCapability | undefined {
  const capability = snapshot.capabilities.get(bytesToHex(id))
  return capability !== undefined && isCapabilityActive(capability, revision) ? capability : undefined
}

export function policyById(snapshot: CapabilitySnapshot, id: Uint8Array): ValidationPolicy | undefined {
  return snapshot.policies.get(bytesToHex(id))?.policy
}

export function canAuthorTransaction(snapshot: CapabilitySnapshot, core: TransactionCore): boolean {
  if (!equalBytes(snapshot.groupId, core.groupId) || !equalBytes(snapshot.revisionDigest, core.membershipRevision)) return false
  return [...snapshot.capabilities.values()].some((capability) =>
    capability.grant.role === 'writer'
    && equalBytes(capability.grant.signingPublicKey, core.authorId)
    && isCapabilityActive(capability, snapshot.revision))
}

export function validatorEvidenceForAttestation(
  snapshot: CapabilitySnapshot,
  attestation: ValidatorAttestation,
  core: TransactionCore,
  txId: Uint8Array,
  candidateDigest: Uint8Array,
): ValidatorEvidence | undefined {
  if (!equalBytes(attestation.groupId, snapshot.groupId)
    || !equalBytes(core.groupId, snapshot.groupId)
    || !equalBytes(attestation.membershipRevision, snapshot.revisionDigest)
    || !equalBytes(core.membershipRevision, snapshot.revisionDigest)
    || !equalBytes(attestation.txId, txId)
    || !equalBytes(attestation.candidateDigest, candidateDigest)
    || attestation.authorTimestampMs !== core.authorTimestampMs
    || attestation.authorTimestampMs <= attestation.acceptedAboveMs) return undefined
  const capability = activeCapabilityById(snapshot, attestation.validatorCapability)
  if (capability?.grant.role !== 'validator'
    || !equalBytes(capability.grant.signingPublicKey, attestation.validatorId)
    || core.authorTimestampMs <= (capability.grant.minimumAuthorTimestampMs ?? -1n)) return undefined
  return {
    capabilityId: capability.id,
    validatorId: attestation.validatorId,
    ...(capability.grant.organization === undefined ? {} : { organization: capability.grant.organization }),
    ...(capability.grant.validatorClass === undefined ? {} : { validatorClass: capability.grant.validatorClass }),
  }
}

export function assembleAdmissionProof(
  snapshot: CapabilitySnapshot,
  core: TransactionCore,
  txId: Uint8Array,
  candidateDigest: Uint8Array,
  attestations: readonly ValidatorAttestation[],
): AdmissionProofEvaluation {
  const policy = policyById(snapshot, core.validationPolicy)
  if (policy === undefined) {
    return { satisfied: false, selected: [], missing: ['policy:unknown'], consideredAttestations: 0, rejectedAttestations: attestations.map(() => 'unknown_policy') }
  }
  const evidence: ValidatorEvidence[] = []
  const rejected: string[] = []
  for (const attestation of attestations) {
    if (attestation.policyVersion !== policy.version) {
      rejected.push('wrong_policy_version')
      continue
    }
    const item = validatorEvidenceForAttestation(snapshot, attestation, core, txId, candidateDigest)
    if (item === undefined) rejected.push('invalid_attestation_context')
    else evidence.push(item)
  }
  const evaluation = evaluateValidationPolicy(policy, evidence)
  return {
    ...evaluation,
    consideredAttestations: evidence.length,
    rejectedAttestations: rejected,
  }
}

export function canReaderAccessRevision(capability: EffectiveCapability, membershipRevision: bigint): boolean {
  if (capability.grant.role !== 'reader') return false
  if (capability.grant.readerScope === 'audit') return true
  return membershipRevision >= capability.grant.validFromRevision
}

export function readerRecipientsForRevision(
  snapshot: CapabilitySnapshot,
  membershipRevision: bigint,
): readonly { recipientId: Uint8Array; publicKey: Uint8Array }[] {
  const readers = [...snapshot.capabilities.values()]
    .filter((capability) => isCapabilityActive(capability, snapshot.revision) && canReaderAccessRevision(capability, membershipRevision))
    .map((capability) => ({
      recipientId: capability.grant.subjectId,
      publicKey: capability.grant.hpkePublicKey as Uint8Array,
    }))
  const unique = new Map(readers.map((reader) => [bytesToHex(reader.recipientId), reader]))
  return [...unique.values()]
}
