import { describe, expect, it } from 'vitest'
import {
  generateEd25519KeyPair,
  type TransactionCore,
  type ValidatorAttestation,
} from '@chronolog/protocol'
import {
  activeCapabilityById,
  applyCapabilityRevision,
  assembleAdmissionProof,
  canAuthorTransaction,
  canReaderAccessRevision,
  capabilityId,
  readerRecipientsForRevision,
  reduceCapabilityLog,
  signCapabilityRevision,
  signGenesis,
  validationPolicyId,
  validatorEvidenceForAttestation,
  type CapabilityGrant,
  type CapabilityRevision,
  type CapabilitySnapshot,
  type GenesisManifest,
  type SignedGenesis,
  type ValidationPolicy,
} from './index.js'

const bytes = (value: number, length = 32) => new Uint8Array(length).fill(value)
const txId = bytes(70)
const candidateDigest = bytes(71)

const policy: ValidationPolicy = {
  version: 3n,
  minimumValidators: 2n,
  classMinimums: new Map(),
  requiredOrganizations: ['A', 'B'],
}

function validator(subject: number, organization: string, floor = 1_000n): CapabilityGrant {
  return {
    subjectId: bytes(subject), signingPublicKey: bytes(subject), role: 'validator', validFromRevision: 0n,
    organization, validatorClass: 'general', minimumAuthorTimestampMs: floor,
  }
}

const writer: CapabilityGrant = { subjectId: bytes(20), signingPublicKey: bytes(20), role: 'writer', validFromRevision: 0n }

async function fixture(extraGrants: readonly CapabilityGrant[] = []) {
  const root = await generateEd25519KeyPair()
  const recovery = await Promise.all([generateEd25519KeyPair(), generateEd25519KeyPair(), generateEd25519KeyPair()])
  const manifest: GenesisManifest = {
    groupId: bytes(1), schemaId: bytes(2), rootAdminPublicKey: root.publicKeyBytes, capabilityLogFeed: bytes(3),
    recoveryPublicKeys: [recovery[0].publicKeyBytes, recovery[1].publicKeyBytes, recovery[2].publicKeyBytes],
    recoveryThreshold: 2n,
    initialCapabilities: [writer, validator(21, 'A'), validator(22, 'B'), ...extraGrants],
    validationPolicies: [policy],
    clockPolicy: { maxFutureSkewMs: 60_000n, cutoffLagMs: 300_000n, heartbeatIntervalMs: 30_000n },
    resourcePolicy: { maxCandidateBytes: 1_000_000n, maxProgramNodes: 10_000n, maxPreconditions: 100n, maxMutations: 100n },
    encryptionSuite: 'DHKEM(X25519,HKDF-SHA256)/HKDF-SHA256/AES-256-GCM', createdAtMs: 10n,
  }
  const genesis = await signGenesis(manifest, root.privateKey)
  const snapshot = await reduceCapabilityLog(genesis, [])
  return { root, genesis, snapshot, policyId: await validationPolicyId(policy) }
}

function coreFor(snapshot: CapabilitySnapshot, policyId: Uint8Array, overrides: Partial<TransactionCore> = {}): TransactionCore {
  return {
    groupId: snapshot.groupId, membershipRevision: snapshot.revisionDigest, validationPolicy: policyId,
    authorId: bytes(20), authorTimestampMs: 5_000n, nonce: bytes(9), executionManifestDigest: bytes(10),
    program: {} as TransactionCore['program'], ...overrides,
  }
}

async function attestationFor(
  snapshot: CapabilitySnapshot,
  subject: number,
  overrides: Partial<ValidatorAttestation> = {},
): Promise<ValidatorAttestation> {
  const capability = [...snapshot.capabilities.values()].find((entry) => entry.grant.subjectId[0] === subject)!
  return {
    groupId: snapshot.groupId, membershipRevision: snapshot.revisionDigest, validatorCapability: capability.id,
    txId, validatorId: bytes(subject), authorTimestampMs: 5_000n, acceptedAboveMs: 4_000n,
    candidateDigest, decision: 'admit', policyVersion: policy.version, ...overrides,
  }
}

async function advance(
  genesisFixture: { readonly root: { readonly privateKey: CryptoKey; readonly publicKeyBytes: Uint8Array }; readonly genesis: SignedGenesis },
  snapshot: CapabilitySnapshot,
  revision: Partial<CapabilityRevision>,
): Promise<CapabilitySnapshot> {
  const signed = await signCapabilityRevision({
    groupId: snapshot.groupId, revision: snapshot.revision + 1n, previousRevisionDigest: snapshot.revisionDigest,
    issuerRootPublicKey: genesisFixture.root.publicKeyBytes, grants: [], revocations: [], validationPolicies: [],
    ...revision,
  }, genesisFixture.root.privateKey)
  return applyCapabilityRevision(snapshot, signed)
}

describe('writer authorization', () => {
  it('binds authorship to the exact group, membership revision and an active writer grant', async () => {
    const f = await fixture()
    expect(canAuthorTransaction(f.snapshot, coreFor(f.snapshot, f.policyId))).toBe(true)
    expect(canAuthorTransaction(f.snapshot, coreFor(f.snapshot, f.policyId, { groupId: bytes(99) }))).toBe(false)
    expect(canAuthorTransaction(f.snapshot, coreFor(f.snapshot, f.policyId, { membershipRevision: bytes(99) }))).toBe(false)
    // A validator key is not a writer key even when it appears in the capability set.
    expect(canAuthorTransaction(f.snapshot, coreFor(f.snapshot, f.policyId, { authorId: bytes(21) }))).toBe(false)
    expect(canAuthorTransaction(f.snapshot, coreFor(f.snapshot, f.policyId, { authorId: bytes(77) }))).toBe(false)
  })

  it('stops accepting a revoked writer at the revoking revision', async () => {
    const f = await fixture()
    const next = await advance(f, f.snapshot, { revocations: [await capabilityId(writer)] })
    expect(canAuthorTransaction(next, coreFor(next, f.policyId))).toBe(false)
  })
})

describe('validator attestation evidence', () => {
  it('accepts only an attestation that binds the exact transaction context', async () => {
    const f = await fixture()
    const core = coreFor(f.snapshot, f.policyId)
    const good = await attestationFor(f.snapshot, 21)
    expect(validatorEvidenceForAttestation(f.snapshot, good, core, txId, candidateDigest)).toMatchObject({ organization: 'A' })

    const rejected: readonly [string, Partial<ValidatorAttestation>][] = [
      ['group', { groupId: bytes(98) }],
      ['membership revision', { membershipRevision: bytes(98) }],
      ['transaction id', { txId: bytes(98) }],
      ['candidate digest', { candidateDigest: bytes(98) }],
      ['author timestamp', { authorTimestampMs: 5_001n }],
      ['validator key', { validatorId: bytes(22) }],
      ['unknown capability', { validatorCapability: bytes(98) }],
      ['non-advancing watermark', { authorTimestampMs: 5_000n, acceptedAboveMs: 5_000n }],
      ['watermark above timestamp', { acceptedAboveMs: 6_000n }],
    ]
    for (const [label, override] of rejected) {
      const attestation = await attestationFor(f.snapshot, 21, override)
      expect(validatorEvidenceForAttestation(f.snapshot, attestation, core, txId, candidateDigest), label).toBeUndefined()
    }
  })

  it('rejects a core whose own group or revision differs from the attestation snapshot', async () => {
    const f = await fixture()
    const attestation = await attestationFor(f.snapshot, 21)
    for (const core of [
      coreFor(f.snapshot, f.policyId, { groupId: bytes(98) }),
      coreFor(f.snapshot, f.policyId, { membershipRevision: bytes(98) }),
    ]) {
      expect(validatorEvidenceForAttestation(f.snapshot, attestation, core, txId, candidateDigest)).toBeUndefined()
    }
  })

  it('refuses timestamps at or below the validator floor and non-validator capabilities', async () => {
    const f = await fixture()
    const atFloor = coreFor(f.snapshot, f.policyId, { authorTimestampMs: 1_000n })
    const floorAttestation = await attestationFor(f.snapshot, 21, { authorTimestampMs: 1_000n, acceptedAboveMs: 500n })
    expect(validatorEvidenceForAttestation(f.snapshot, floorAttestation, atFloor, txId, candidateDigest)).toBeUndefined()

    const writerCapabilityId = await capabilityId(writer)
    const asWriter = await attestationFor(f.snapshot, 21, { validatorCapability: writerCapabilityId, validatorId: bytes(20) })
    expect(validatorEvidenceForAttestation(f.snapshot, asWriter, coreFor(f.snapshot, f.policyId), txId, candidateDigest)).toBeUndefined()
  })

  it('ignores a revoked validator in the revision where it was revoked', async () => {
    const f = await fixture()
    const attestation = await attestationFor(f.snapshot, 21)
    const next = await advance(f, f.snapshot, { revocations: [attestation.validatorCapability] })
    const core = coreFor(next, f.policyId)
    const rebound = { ...attestation, membershipRevision: next.revisionDigest }
    expect(activeCapabilityById(next, attestation.validatorCapability)).toBeUndefined()
    expect(validatorEvidenceForAttestation(next, rebound, core, txId, candidateDigest)).toBeUndefined()
  })
})

describe('admission proof assembly', () => {
  it('satisfies the policy only with all required organizations', async () => {
    const f = await fixture()
    const core = coreFor(f.snapshot, f.policyId)
    const a = await attestationFor(f.snapshot, 21)
    const b = await attestationFor(f.snapshot, 22)
    const ok = assembleAdmissionProof(f.snapshot, core, txId, candidateDigest, [a, b])
    expect(ok).toMatchObject({ satisfied: true, consideredAttestations: 2, rejectedAttestations: [] })

    const short = assembleAdmissionProof(f.snapshot, core, txId, candidateDigest, [a])
    expect(short.satisfied).toBe(false)
    expect(short.missing).toContain('organization:B')
  })

  it('does not let one validator satisfy a multi-validator policy by repeating itself', async () => {
    const f = await fixture()
    const core = coreFor(f.snapshot, f.policyId)
    const a = await attestationFor(f.snapshot, 21)
    const result = assembleAdmissionProof(f.snapshot, core, txId, candidateDigest, [a, { ...a }, { ...a }])
    expect(result.satisfied).toBe(false)
    expect(result.selected).toHaveLength(0)
  })

  it('records and excludes stale-version and mis-bound attestations', async () => {
    const f = await fixture()
    const core = coreFor(f.snapshot, f.policyId)
    const a = await attestationFor(f.snapshot, 21)
    const stale = await attestationFor(f.snapshot, 22, { policyVersion: policy.version - 1n })
    const wrongTx = await attestationFor(f.snapshot, 22, { txId: bytes(98) })
    const result = assembleAdmissionProof(f.snapshot, core, txId, candidateDigest, [a, stale, wrongTx])
    expect(result.satisfied).toBe(false)
    expect(result.consideredAttestations).toBe(1)
    expect(result.rejectedAttestations).toEqual(['wrong_policy_version', 'invalid_attestation_context'])
  })

  it('fails closed for an unknown policy identifier', async () => {
    const f = await fixture()
    const core = coreFor(f.snapshot, bytes(97))
    const a = await attestationFor(f.snapshot, 21)
    expect(assembleAdmissionProof(f.snapshot, core, txId, candidateDigest, [a])).toEqual({
      satisfied: false, selected: [], missing: ['policy:unknown'], consideredAttestations: 0,
      rejectedAttestations: ['unknown_policy'],
    })
  })
})

describe('reader recipients', () => {
  it('keeps prospective readers out of earlier revisions and de-duplicates recipients', async () => {
    const readerA: CapabilityGrant = {
      subjectId: bytes(40), signingPublicKey: bytes(40), role: 'reader', validFromRevision: 0n,
      readerScope: 'snapshot', hpkePublicKey: bytes(41),
    }
    const duplicateKey: CapabilityGrant = { ...readerA, hpkePublicKey: bytes(42) }
    const f = await fixture([readerA, duplicateKey])
    const later: CapabilityGrant = {
      subjectId: bytes(43), signingPublicKey: bytes(43), role: 'reader', validFromRevision: 1n,
      readerScope: 'snapshot', hpkePublicKey: bytes(44),
    }
    const audit: CapabilityGrant = { ...later, subjectId: bytes(45), signingPublicKey: bytes(45), readerScope: 'audit', hpkePublicKey: bytes(46) }
    const next = await advance(f, f.snapshot, { grants: [later, audit] })

    const atZero = readerRecipientsForRevision(next, 0n).map((entry) => entry.recipientId[0])
    expect(atZero).toEqual([40, 45])
    // Later duplicate subject wins the map slot, never producing two recipients for one subject.
    expect(readerRecipientsForRevision(next, 0n).find((entry) => entry.recipientId[0] === 40)?.publicKey[0]).toBe(42)
    expect(readerRecipientsForRevision(next, 1n).map((entry) => entry.recipientId[0])).toEqual([40, 43, 45])
  })

  it('never lets a non-reader role read history', async () => {
    const f = await fixture()
    const validatorCapability = [...f.snapshot.capabilities.values()].find((entry) => entry.grant.role === 'validator')!
    expect(canReaderAccessRevision(validatorCapability, 100n)).toBe(false)
  })
})
