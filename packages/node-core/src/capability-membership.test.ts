import type { CapabilitySnapshot, EffectiveCapability, ValidationPolicy } from '@chronolog/capabilities'
import type { StoredAttestation } from '@chronolog/control-store'
import { IrBuilder, values } from '@chronolog/ir'
import { bytesToHex } from '@chronolog/protocol'
import { describe, expect, it } from 'vitest'

import { CapabilityMembershipResolver } from './capability-membership.js'

const bytes = (value: number): Uint8Array => Uint8Array.of(value)

describe('CapabilityMembershipResolver', () => {
  it('enforces a revision-pinned absolute class and organization policy', async () => {
    const revisionDigest = bytes(4)
    const groupId = bytes(3)
    const policyId = bytes(9)
    const writer = capability(1, 'writer', 21)
    const validatorA = capability(2, 'validator', 22, { organization: 'org-a', validatorClass: 'primary' })
    const validatorB = capability(3, 'validator', 23, { organization: 'org-b', validatorClass: 'backup' })
    const policy: ValidationPolicy = {
      version: 1n,
      minimumValidators: 2n,
      classMinimums: new Map([['primary', 1n]]),
      requiredOrganizations: ['org-b'],
    }
    const snapshot: CapabilitySnapshot = {
      groupId,
      revision: 1n,
      revisionDigest,
      rootAdminPublicKey: bytes(90),
      capabilityLogFeed: bytes(91),
      recoveryPublicKeys: [bytes(92), bytes(93), bytes(94)],
      recoveryThreshold: 2n,
      capabilities: new Map([
        [bytesToHex(writer.id), writer],
        [bytesToHex(validatorA.id), validatorA],
        [bytesToHex(validatorB.id), validatorB],
      ]),
      policies: new Map([[bytesToHex(policyId), { id: policyId, policy, installedAtRevision: 1n }]]),
      historyReopened: false,
    }
    const resolver = new CapabilityMembershipResolver({ snapshotForRevision: () => snapshot })
    const context = { groupId, membershipRevision: revisionDigest, validationPolicy: policyId, writerId: writer.grant.signingPublicKey }
    const attestations = [attestation(validatorA, 1), attestation(validatorB, 2)]

    expect(await resolver.canWrite(context)).toBe(true)
    expect(await resolver.selectAdmission(context, attestations)).toEqual(attestations)
    const ir = new IrBuilder()
    const assertion = ir.query(
      [ir.projection('ok', ir.literal(values.boolean(true)))],
      { resultMode: { kind: 'scalar' } },
    )
    expect(await resolver.watermarkPolicy({
      ...context,
      authorId: context.writerId,
      authorTimestampMs: 100n,
      nonce: new Uint8Array(16),
      executionManifestDigest: new Uint8Array(32),
      schemaDigest: new Uint8Array(32),
      program: ir.program(
        [ir.assertion(assertion)],
        [ir.insert('audit', ['ok'], [[ir.literal(values.boolean(true))]])],
      ),
    })).toMatchObject({ kind: 'proof-alternatives' })
  })
})

function capability(
  id: number,
  role: 'writer' | 'validator',
  key: number,
  detail: { readonly organization?: string; readonly validatorClass?: string } = {},
): EffectiveCapability {
  return {
    id: bytes(id),
    grantedAtRevision: 1n,
    grant: {
      subjectId: bytes(key + 30),
      signingPublicKey: bytes(key),
      role,
      validFromRevision: 1n,
      ...detail,
    },
  }
}

function attestation(capability: EffectiveCapability, id: number): StoredAttestation {
  return {
    attestationId: bytes(id),
    txId: bytes(70),
    validatorId: capability.grant.signingPublicKey,
    validatorCapability: capability.id,
    membershipRevision: bytes(4),
    candidateDigest: bytes(71),
    validatorFeedSequence: BigInt(id),
    authorTimestampMs: 100n,
    acceptedAboveMs: 50n,
  }
}
