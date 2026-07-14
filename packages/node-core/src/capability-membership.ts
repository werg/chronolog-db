import {
  evaluateValidationPolicy,
  isCapabilityActive,
  type CapabilitySnapshot,
  type EffectiveCapability,
  type ValidatorEvidence,
} from '@chronolog/capabilities'
import type { StoredAttestation, WatermarkPolicy } from '@chronolog/control-store'
import { bytesToHex, equalBytes, type TransactionCore } from '@chronolog/protocol'

import type {
  CandidateAdmissionContext,
  MembershipResolver,
  TransportAuthorContext,
  ValidatorAuthorityContext,
} from './types.js'

export interface CapabilityMembershipResolverOptions {
  readonly snapshotForRevision: (
    revisionDigest: Uint8Array,
  ) => CapabilitySnapshot | null | Promise<CapabilitySnapshot | null>
  readonly maximumWatermarkValidators?: number
  /** Recovery-controlled binding from a capability to its authenticated SSB feed. */
  readonly transportAuthorForCapability?: (
    capability: EffectiveCapability,
    snapshot: CapabilitySnapshot,
  ) => string | null | Promise<string | null>
}

/** Bridges the signed capability log to revision-pinned node authorization. */
export class CapabilityMembershipResolver implements MembershipResolver {
  readonly #snapshots: CapabilityMembershipResolverOptions['snapshotForRevision']
  readonly #maximumWatermarkValidators: number
  readonly #transportAuthorForCapability: CapabilityMembershipResolverOptions['transportAuthorForCapability']

  constructor(options: CapabilityMembershipResolverOptions) {
    this.#snapshots = options.snapshotForRevision
    this.#maximumWatermarkValidators = options.maximumWatermarkValidators ?? 20
    this.#transportAuthorForCapability = options.transportAuthorForCapability
  }

  async canWrite(context: Omit<CandidateAdmissionContext, 'validatorId' | 'validatorCapability'>): Promise<boolean> {
    const snapshot = await this.#snapshot(context)
    if (!snapshot) return false
    return [...snapshot.capabilities.values()].some((capability) =>
      this.#activeRole(capability, snapshot, 'writer') &&
      equalBytes(capability.grant.signingPublicKey, context.writerId))
  }

  async canValidate(context: CandidateAdmissionContext): Promise<boolean> {
    const snapshot = await this.#snapshot(context)
    if (!snapshot) return false
    const capability = snapshot.capabilities.get(bytesToHex(context.validatorCapability))
    return capability !== undefined &&
      this.#activeRole(capability, snapshot, 'validator') &&
      equalBytes(capability.grant.signingPublicKey, context.validatorId)
  }

  async threshold(context: Omit<CandidateAdmissionContext, 'validatorId' | 'validatorCapability'>): Promise<number> {
    const snapshot = await this.#snapshot(context)
    const policy = snapshot?.policies.get(bytesToHex(context.validationPolicy))?.policy
    if (!policy || policy.minimumValidators > BigInt(Number.MAX_SAFE_INTEGER)) return Number.MAX_SAFE_INTEGER
    return Number(policy.minimumValidators)
  }

  async policyVersion(
    context: Omit<CandidateAdmissionContext, 'validatorId' | 'validatorCapability'>,
  ): Promise<bigint> {
    const snapshot = await this.#snapshot(context)
    return snapshot?.policies.get(bytesToHex(context.validationPolicy))?.policy.version ?? -1n
  }

  async canHeartbeat(context: ValidatorAuthorityContext): Promise<boolean> {
    const snapshot = await this.#snapshot({ ...context, validationPolicy: new Uint8Array(), writerId: new Uint8Array() })
    if (!snapshot) return false
    const capability = snapshot.capabilities.get(bytesToHex(context.validatorCapability))
    return capability !== undefined &&
      this.#activeRole(capability, snapshot, 'validator') &&
      equalBytes(capability.grant.signingPublicKey, context.validatorId)
  }

  async canUseTransportAuthor(context: TransportAuthorContext): Promise<boolean> {
    if (!this.#transportAuthorForCapability) return false
    const snapshot = await this.#snapshot({
      groupId: context.groupId,
      membershipRevision: context.membershipRevision,
      validationPolicy: new Uint8Array(),
      writerId: context.signingId,
    })
    if (!snapshot) return false
    const capability = context.role === 'validator'
      ? snapshot.capabilities.get(bytesToHex(context.validatorCapability ?? new Uint8Array()))
      : [...snapshot.capabilities.values()].find((candidate) =>
          this.#activeRole(candidate, snapshot, 'writer') &&
          equalBytes(candidate.grant.signingPublicKey, context.signingId))
    if (
      capability === undefined ||
      !this.#activeRole(capability, snapshot, context.role) ||
      !equalBytes(capability.grant.signingPublicKey, context.signingId)
    ) return false
    return await this.#transportAuthorForCapability(capability, snapshot) === context.transportAuthor
  }

  async selectAdmission(
    context: Omit<CandidateAdmissionContext, 'validatorId' | 'validatorCapability'>,
    attestations: readonly StoredAttestation[],
  ): Promise<readonly StoredAttestation[]> {
    const snapshot = await this.#snapshot(context)
    const policy = snapshot?.policies.get(bytesToHex(context.validationPolicy))?.policy
    if (!snapshot || !policy) return []
    const indexed = new Map<string, { readonly evidence: ValidatorEvidence; readonly attestation: StoredAttestation }>()
    for (const attestation of attestations) {
      const capability = snapshot.capabilities.get(bytesToHex(attestation.validatorCapability))
      if (
        capability === undefined ||
        !this.#activeRole(capability, snapshot, 'validator') ||
        !equalBytes(capability.grant.signingPublicKey, attestation.validatorId) ||
        !equalBytes(attestation.membershipRevision, snapshot.revisionDigest) ||
        attestation.policyVersion !== policy.version ||
        attestation.authorTimestampMs <= attestation.acceptedAboveMs ||
        attestation.authorTimestampMs <= (capability.grant.minimumAuthorTimestampMs ?? -1n)
      ) continue
      const key = bytesToHex(capability.id)
      if (indexed.has(key)) continue
      indexed.set(key, {
        evidence: {
          capabilityId: capability.id,
          validatorId: attestation.validatorId,
          ...(capability.grant.organization === undefined ? {} : { organization: capability.grant.organization }),
          ...(capability.grant.validatorClass === undefined ? {} : { validatorClass: capability.grant.validatorClass }),
        },
        attestation,
      })
    }
    const evaluation = evaluateValidationPolicy(policy, [...indexed.values()].map((item) => item.evidence))
    if (!evaluation.satisfied) return []
    return evaluation.selected.map((evidence) => indexed.get(bytesToHex(evidence.capabilityId))!.attestation)
  }

  async watermarkPolicy(core: TransactionCore): Promise<WatermarkPolicy | null> {
    const context = {
      groupId: core.groupId,
      membershipRevision: core.membershipRevision,
      validationPolicy: core.validationPolicy,
      writerId: core.authorId,
    }
    const snapshot = await this.#snapshot(context)
    const effective = snapshot?.policies.get(bytesToHex(core.validationPolicy))
    if (!snapshot || !effective) return null
    const validators = [...snapshot.capabilities.values()]
      .filter((capability) => this.#activeRole(capability, snapshot, 'validator'))
    if (validators.length > this.#maximumWatermarkValidators) return null
    const policyId = bytesToHex(effective.id)
    if (effective.policy.classMinimums.size === 0 && effective.policy.requiredOrganizations.length === 0) {
      const threshold = Number(effective.policy.minimumValidators)
      if (!Number.isSafeInteger(threshold)) return null
      return {
        kind: 'threshold',
        policyId,
        validatorIds: validators.map((capability) => capability.grant.signingPublicKey),
        threshold,
      }
    }
    const proofs = minimalProofs(effective.policy, validators)
    return proofs.length === 0 ? null : { kind: 'proof-alternatives', policyId, minimalProofs: proofs }
  }

  async #snapshot(context: Omit<CandidateAdmissionContext, 'validatorId' | 'validatorCapability'>): Promise<CapabilitySnapshot | null> {
    const snapshot = await this.#snapshots(context.membershipRevision)
    return snapshot !== null &&
      equalBytes(snapshot.groupId, context.groupId) &&
      equalBytes(snapshot.revisionDigest, context.membershipRevision)
      ? snapshot
      : null
  }

  #activeRole(capability: EffectiveCapability, snapshot: CapabilitySnapshot, role: 'writer' | 'validator'): boolean {
    return capability.grant.role === role && isCapabilityActive(capability, snapshot.revision)
  }
}

function minimalProofs(
  policy: CapabilitySnapshot['policies'] extends ReadonlyMap<string, infer P>
    ? P extends { readonly policy: infer V } ? V : never
    : never,
  validators: readonly EffectiveCapability[],
): readonly (readonly Uint8Array[])[] {
  const results: Uint8Array[][] = []
  const visit = (index: number, selected: EffectiveCapability[]): void => {
    if (index === validators.length) {
      const evidence: ValidatorEvidence[] = selected.map((capability) => ({
        capabilityId: capability.id,
        validatorId: capability.grant.signingPublicKey,
        ...(capability.grant.organization === undefined ? {} : { organization: capability.grant.organization }),
        ...(capability.grant.validatorClass === undefined ? {} : { validatorClass: capability.grant.validatorClass }),
      }))
      if (!evaluateValidationPolicy(policy, evidence).satisfied) return
      if (results.some((proof) => proof.every((id) => selected.some((candidate) => equalBytes(candidate.grant.signingPublicKey, id))))) return
      results.push(selected.map((capability) => capability.grant.signingPublicKey))
      return
    }
    visit(index + 1, selected)
    visit(index + 1, [...selected, validators[index]!])
  }
  visit(0, [])
  return results
}
