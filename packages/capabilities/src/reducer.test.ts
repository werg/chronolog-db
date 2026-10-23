import { describe, expect, it } from 'vitest'
import { generateEd25519KeyPair, type Ed25519KeyPair } from '@chronolog/protocol'
import {
  applyCapabilityRevision,
  applyRecoveryRecord,
  capabilityId,
  combineRecoverySignatures,
  isCapabilityActive,
  reduceCapabilityLog,
  signCapabilityRevision,
  signGenesis,
  signRecoveryPayload,
  verifyRecoveryRecord,
  verifySignedGenesis,
  type CapabilityGrant,
  type CapabilityRevision,
  type CapabilitySnapshot,
  type GenesisManifest,
  type RecoveryPayload,
  type ValidationPolicy,
} from './index.js'

const bytes = (value: number, length = 32) => new Uint8Array(length).fill(value)

const policy: ValidationPolicy = { version: 1n, minimumValidators: 1n, classMinimums: new Map(), requiredOrganizations: [] }
const writer: CapabilityGrant = { subjectId: bytes(20), signingPublicKey: bytes(20), role: 'writer', validFromRevision: 0n }
const validatorAt = (subject: number, revision: bigint, floor: bigint): CapabilityGrant => ({
  subjectId: bytes(subject), signingPublicKey: bytes(subject), role: 'validator', validFromRevision: revision,
  organization: 'A', validatorClass: 'general', minimumAuthorTimestampMs: floor,
})

async function fixture(overrides: Partial<GenesisManifest> = {}) {
  const root = await generateEd25519KeyPair()
  const recovery = await Promise.all([generateEd25519KeyPair(), generateEd25519KeyPair(), generateEd25519KeyPair()])
  const manifest: GenesisManifest = {
    groupId: bytes(1), schemaId: bytes(2), rootAdminPublicKey: root.publicKeyBytes, capabilityLogFeed: bytes(3),
    recoveryPublicKeys: [recovery[0].publicKeyBytes, recovery[1].publicKeyBytes, recovery[2].publicKeyBytes],
    recoveryThreshold: 2n,
    initialCapabilities: [writer, validatorAt(21, 0n, 1_000n)], validationPolicies: [policy],
    clockPolicy: { maxFutureSkewMs: 60_000n, cutoffLagMs: 300_000n, heartbeatIntervalMs: 30_000n },
    resourcePolicy: { maxCandidateBytes: 1_000_000n, maxProgramNodes: 10_000n, maxPreconditions: 100n, maxMutations: 100n },
    encryptionSuite: 'DHKEM(X25519,HKDF-SHA256)/HKDF-SHA256/AES-256-GCM', createdAtMs: 10n,
    ...overrides,
  }
  const genesis = await signGenesis(manifest, root.privateKey)
  return { root, recovery, manifest, genesis, snapshot: await reduceCapabilityLog(genesis, []) }
}

function revisionAfter(
  f: { readonly snapshot: CapabilitySnapshot; readonly root: Ed25519KeyPair },
  overrides: Partial<CapabilityRevision> = {},
): CapabilityRevision {
  return {
    groupId: f.snapshot.groupId, revision: f.snapshot.revision + 1n, previousRevisionDigest: f.snapshot.revisionDigest,
    issuerRootPublicKey: f.root.publicKeyBytes, grants: [], revocations: [], validationPolicies: [], ...overrides,
  }
}

describe('genesis verification', () => {
  it('rejects a genesis whose signature does not cover the manifest', async () => {
    const f = await fixture()
    const tampered = { ...f.genesis, manifest: { ...f.genesis.manifest, createdAtMs: 11n } }
    expect(await verifySignedGenesis(tampered)).toBe(false)
    await expect(reduceCapabilityLog(tampered, [])).rejects.toMatchObject({ code: 'INVALID_SIGNATURE' })
  })

  it('rejects a genesis signed by a key other than its declared root', async () => {
    const f = await fixture()
    const imposter = await generateEd25519KeyPair()
    const forged = await signGenesis(f.manifest, imposter.privateKey)
    await expect(reduceCapabilityLog(forged, [])).rejects.toMatchObject({ code: 'INVALID_SIGNATURE' })
  })

  it('rejects initial grants that do not begin at revision zero or repeat', async () => {
    const late = await fixture({ initialCapabilities: [{ ...writer, validFromRevision: 1n }] })
      .then(() => undefined, (error: unknown) => error)
    expect(late).toMatchObject({ code: 'SCHEMA_INVALID' })
    const duplicate = await fixture({ initialCapabilities: [writer, writer] }).then(() => undefined, (error: unknown) => error)
    expect(duplicate).toMatchObject({ code: 'SCHEMA_INVALID' })
    const policyRepeat = await fixture({ validationPolicies: [policy, policy] }).then(() => undefined, (error: unknown) => error)
    expect(policyRepeat).toMatchObject({ code: 'SCHEMA_INVALID' })
  })

  it('refuses a recovery set that would let one key satisfy two-of-three', async () => {
    const key = (await generateEd25519KeyPair()).publicKeyBytes
    const other = (await generateEd25519KeyPair()).publicKeyBytes
    const error = await fixture({ recoveryPublicKeys: [key, key, other] }).then(() => undefined, (cause: unknown) => cause)
    expect(error).toMatchObject({ code: 'SCHEMA_INVALID' })
  })

  it('rejects thresholds other than two and wrong recovery key counts', async () => {
    for (const overrides of [
      { recoveryThreshold: 1n },
      { recoveryThreshold: 0n },
      { recoveryThreshold: 3n },
    ] satisfies Partial<GenesisManifest>[]) {
      const error = await fixture(overrides).then(() => undefined, (cause: unknown) => cause)
      expect(error, String(overrides.recoveryThreshold)).toMatchObject({ code: 'SCHEMA_INVALID' })
    }
  })
})

describe('capability revision chain', () => {
  it('rejects every way a revision can fail to extend the signed chain', async () => {
    const f = await fixture()
    const stranger = await generateEd25519KeyPair()
    const cases: readonly [string, Partial<CapabilityRevision>, string, 'root' | 'stranger'][] = [
      ['foreign group', { groupId: bytes(98) }, 'SCHEMA_INVALID', 'root'],
      ['revision gap', { revision: 2n }, 'SCHEMA_INVALID', 'root'],
      ['forked predecessor', { previousRevisionDigest: bytes(98) }, 'DIGEST_MISMATCH', 'root'],
      ['wrong declared issuer', { issuerRootPublicKey: stranger.publicKeyBytes }, 'INVALID_KEY', 'stranger'],
      ['non-root signature', {}, 'INVALID_SIGNATURE', 'stranger'],
    ]
    for (const [label, override, code, signer] of cases) {
      const signed = await signCapabilityRevision(
        revisionAfter(f, override),
        (signer === 'root' ? f.root : stranger).privateKey,
      )
      await expect(applyCapabilityRevision(f.snapshot, signed), label).rejects.toMatchObject({ code })
    }
  })

  it('rejects a revision whose signature is replayed over different content', async () => {
    const f = await fixture()
    const signed = await signCapabilityRevision(revisionAfter(f), f.root.privateKey)
    const swapped = { revision: revisionAfter(f, { grants: [{ ...writer, subjectId: bytes(50), signingPublicKey: bytes(50), validFromRevision: 1n }] }), signature: signed.signature }
    await expect(applyCapabilityRevision(f.snapshot, swapped)).rejects.toMatchObject({ code: 'INVALID_SIGNATURE' })
  })

  it('rejects unknown and repeated revocations, early grants, duplicates and repeated policies', async () => {
    const f = await fixture()
    const writerId = await capabilityId(writer)
    const extra: CapabilityGrant = { ...writer, subjectId: bytes(51), signingPublicKey: bytes(51), validFromRevision: 1n }
    const sign = (revision: CapabilityRevision, snapshot: CapabilitySnapshot = f.snapshot) =>
      signCapabilityRevision(revision, f.root.privateKey).then((signed) => applyCapabilityRevision(snapshot, signed))

    await expect(sign(revisionAfter(f, { revocations: [bytes(98)] }))).rejects.toMatchObject({ code: 'SCHEMA_INVALID' })
    await expect(sign(revisionAfter(f, { grants: [{ ...extra, validFromRevision: 5n }] }))).rejects.toMatchObject({ code: 'SCHEMA_INVALID' })
    await expect(sign(revisionAfter(f, { grants: [extra, extra] }))).rejects.toMatchObject({ code: 'SCHEMA_INVALID' })
    await expect(sign(revisionAfter(f, { validationPolicies: [policy] }))).rejects.toMatchObject({ code: 'SCHEMA_INVALID' })

    const revoked = await sign(revisionAfter(f, { revocations: [writerId] }))
    await expect(sign(revisionAfter({ snapshot: revoked, root: f.root }, { revocations: [writerId] }), revoked))
      .rejects.toMatchObject({ code: 'SCHEMA_INVALID' })
  })

  it('prevents a later-granted validator from reopening closed timestamp history', async () => {
    const f = await fixture()
    const lowFloor = validatorAt(22, 1n, 500n)
    const signed = await signCapabilityRevision(revisionAfter(f, { grants: [lowFloor] }), f.root.privateKey)
    await expect(applyCapabilityRevision(f.snapshot, signed)).rejects.toMatchObject({ code: 'SCHEMA_INVALID' })
  })

  it('stops honoring the old root after succession', async () => {
    const f = await fixture()
    const successor = await generateEd25519KeyPair()
    const rotated = await applyCapabilityRevision(f.snapshot, await signCapabilityRevision(
      revisionAfter(f, { successorRootPublicKey: successor.publicKeyBytes, successorCapabilityLogFeed: bytes(8) }),
      f.root.privateKey,
    ))
    const oldRootAttempt = await signCapabilityRevision(revisionAfter({ snapshot: rotated, root: f.root }), f.root.privateKey)
    await expect(applyCapabilityRevision(rotated, oldRootAttempt)).rejects.toMatchObject({ code: 'INVALID_KEY' })
    const newRootRevision = await signCapabilityRevision(revisionAfter({ snapshot: rotated, root: successor }), successor.privateKey)
    expect((await applyCapabilityRevision(rotated, newRootRevision)).revision).toBe(2n)
  })

  it('orders unsorted input revisions before applying them', async () => {
    const f = await fixture()
    const one = await signCapabilityRevision(revisionAfter(f), f.root.privateKey)
    const stateOne = await applyCapabilityRevision(f.snapshot, one)
    const two = await signCapabilityRevision(revisionAfter({ snapshot: stateOne, root: f.root }), f.root.privateKey)
    expect((await reduceCapabilityLog(f.genesis, [two, one])).revision).toBe(2n)
    await expect(reduceCapabilityLog(f.genesis, [two])).rejects.toMatchObject({ code: 'SCHEMA_INVALID' })
  })
})

describe('capability validity windows', () => {
  it('honors start, end and revocation boundaries inclusively where the grant says so', () => {
    const base = { id: bytes(1), grantedAtRevision: 2n }
    const grant: CapabilityGrant = { ...writer, validFromRevision: 2n, validUntilRevision: 4n }
    expect(isCapabilityActive({ ...base, grant }, 1n)).toBe(false)
    expect(isCapabilityActive({ ...base, grant }, 2n)).toBe(true)
    expect(isCapabilityActive({ ...base, grant }, 4n)).toBe(true)
    expect(isCapabilityActive({ ...base, grant }, 5n)).toBe(false)
    expect(isCapabilityActive({ ...base, grant, revokedAtRevision: 3n }, 2n)).toBe(true)
    expect(isCapabilityActive({ ...base, grant, revokedAtRevision: 3n }, 3n)).toBe(false)
  })
})

describe('recovery verification', () => {
  async function recoveryFixture() {
    const f = await fixture()
    const newRoot = await generateEd25519KeyPair()
    const payload: RecoveryPayload = {
      groupId: f.snapshot.groupId, lastRevision: f.snapshot.revision, lastRevisionDigest: f.snapshot.revisionDigest,
      newRevision: 1n, newRootPublicKey: newRoot.publicKeyBytes, newCapabilityLogFeed: bytes(9),
      validatorGrants: [validatorAt(30, 1n, 2_000n)], reopenHistory: false,
    }
    const sign = (index: number, body: RecoveryPayload = payload) =>
      signRecoveryPayload(body, BigInt(index), f.recovery[index]!.privateKey)
    return { ...f, newRoot, payload, sign }
  }

  it('applies a two-of-three recovery and retires old validators and the old root', async () => {
    const f = await recoveryFixture()
    const record = combineRecoverySignatures(f.payload, [await f.sign(0), await f.sign(1)])
    const recovered = await applyRecoveryRecord(f.snapshot, record)
    expect(recovered.historyReopened).toBe(false)
    const oldValidator = [...recovered.capabilities.values()].find((entry) => entry.grant.subjectId[0] === 21)!
    expect(isCapabilityActive(oldValidator, recovered.revision)).toBe(false)
    expect(isCapabilityActive(oldValidator, 0n)).toBe(true)
    const newValidator = [...recovered.capabilities.values()].find((entry) => entry.grant.subjectId[0] === 30)!
    expect(isCapabilityActive(newValidator, recovered.revision)).toBe(true)
  })

  it('rejects a recovery signed by the same custodian twice or by a non-custodian', async () => {
    const f = await recoveryFixture()
    const outsider = await generateEd25519KeyPair()
    const duplicated = combineRecoverySignatures(f.payload, [await f.sign(0), await f.sign(0)])
    expect(await verifyRecoveryRecord(f.snapshot, duplicated)).toBe(false)
    const outsiderSignature = await signRecoveryPayload(f.payload, 1n, outsider.privateKey)
    expect(await verifyRecoveryRecord(f.snapshot, combineRecoverySignatures(f.payload, [await f.sign(0), outsiderSignature]))).toBe(false)
    await expect(applyRecoveryRecord(f.snapshot, duplicated)).rejects.toMatchObject({ code: 'INVALID_SIGNATURE' })
  })

  it('rejects a signature presented under the wrong custodian index', async () => {
    const f = await recoveryFixture()
    const real = await f.sign(0)
    const relabeled = { ...real, recoveryKeyIndex: 2n }
    expect(await verifyRecoveryRecord(f.snapshot, combineRecoverySignatures(f.payload, [await f.sign(1), relabeled]))).toBe(false)
    const outOfRange = { ...real, recoveryKeyIndex: 3n }
    expect(await verifyRecoveryRecord(f.snapshot, { payload: f.payload, signatures: [outOfRange, await f.sign(1)] })).toBe(false)
    const negative = { ...real, recoveryKeyIndex: -1n }
    expect(await verifyRecoveryRecord(f.snapshot, { payload: f.payload, signatures: [negative, await f.sign(1)] })).toBe(false)
  })

  it('binds signatures to the exact payload, group, predecessor and revision', async () => {
    const f = await recoveryFixture()
    const signatures = [await f.sign(0), await f.sign(1)]
    expect(await verifyRecoveryRecord(f.snapshot, { payload: f.payload, signatures })).toBe(true)
    const mutated: readonly RecoveryPayload[] = [
      { ...f.payload, newRootPublicKey: bytes(77) },
      { ...f.payload, newCapabilityLogFeed: bytes(77) },
      { ...f.payload, validatorGrants: [] },
    ]
    for (const payload of mutated) expect(await verifyRecoveryRecord(f.snapshot, { payload, signatures })).toBe(false)

    const rebound: readonly RecoveryPayload[] = [
      { ...f.payload, groupId: bytes(98) },
      { ...f.payload, lastRevisionDigest: bytes(98) },
      { ...f.payload, lastRevision: 4n, newRevision: 5n },
    ]
    for (const payload of rebound) {
      const resigned = [await f.sign(0, payload), await f.sign(1, payload)]
      expect(await verifyRecoveryRecord(f.snapshot, { payload, signatures: resigned })).toBe(false)
    }
  })

  it('does not let recovery silently lower the validator floor without declaring a reopening', async () => {
    const f = await recoveryFixture()
    const payload: RecoveryPayload = { ...f.payload, validatorGrants: [validatorAt(30, 1n, 10n)] }
    const record = combineRecoverySignatures(payload, [await f.sign(0, payload), await f.sign(1, payload)])
    await expect(applyRecoveryRecord(f.snapshot, record)).rejects.toMatchObject({ code: 'SCHEMA_INVALID' })
  })

  it('rejects recovery grants that start at the wrong revision or repeat a capability', async () => {
    const f = await recoveryFixture()
    const early: RecoveryPayload = { ...f.payload, validatorGrants: [validatorAt(30, 0n, 2_000n)] }
    await expect(applyRecoveryRecord(f.snapshot, combineRecoverySignatures(early, [await f.sign(0, early), await f.sign(1, early)])))
      .rejects.toMatchObject({ code: 'SCHEMA_INVALID' })
    const repeated: RecoveryPayload = { ...f.payload, validatorGrants: [validatorAt(30, 1n, 2_000n), validatorAt(30, 1n, 2_000n)] }
    await expect(applyRecoveryRecord(f.snapshot, combineRecoverySignatures(repeated, [await f.sign(0, repeated), await f.sign(1, repeated)])))
      .rejects.toMatchObject({ code: 'SCHEMA_INVALID' })
  })

  it('does not replay a recovery after it has been applied', async () => {
    const f = await recoveryFixture()
    const record = combineRecoverySignatures(f.payload, [await f.sign(0), await f.sign(1)])
    const recovered = await applyRecoveryRecord(f.snapshot, record)
    expect(await verifyRecoveryRecord(recovered, record)).toBe(false)
  })
})
