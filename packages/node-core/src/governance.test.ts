import {
  combineRecoverySignatures,
  signGenesis,
  signRecoveryPayload,
  validationPolicyId,
  type CapabilityGrant,
  type GenesisManifest,
  type RecoveryPayload,
  type ValidationPolicy,
} from '@chronolog/capabilities'
import { generateX25519KeyPair } from '@chronolog/crypto'
import { ControlStore } from '@chronolog/control-store'
import { encodeCanonicalCbor, generateEd25519KeyPair } from '@chronolog/protocol'
import { MemoryTransportNetwork } from '@chronolog/transport-ssb'
import { afterEach, describe, expect, it } from 'vitest'

import { CapabilityMembershipResolver } from './capability-membership.js'
import { GovernanceControlPlane } from './governance.js'

const controllers: GovernanceControlPlane[] = []
afterEach(async () => { await Promise.all(controllers.splice(0).map((controller) => controller.close())) })

describe('replicated governance control plane', () => {
  it('onboards, revokes, rotates epochs, and grants audit history without restart', async () => {
    const fixture = await governanceFixture()
    const participantSigning = await generateEd25519KeyPair()
    const participantHpke = await generateX25519KeyPair()
    const participantTransport = fixture.network.createNode('participant')
    fixture.network.connectAll()
    const participant = await GovernanceControlPlane.create({
      genesis: fixture.genesis,
      groupRoute: fixture.groupRoute,
      transport: participantTransport,
      identity: participantSigning,
      recipient: { id: participantSigning.publicKeyBytes, privateKey: participantHpke.privateKey },
    })
    controllers.push(participant)
    await participant.start()

    await fixture.admin.publishCapabilityChange({ grants: [
      grant(participantSigning.publicKeyBytes, 'reader', { readerScope: 'snapshot', hpkePublicKey: participantHpke.publicKeyBytes, transportAuthor: 'participant' }),
      grant(participantSigning.publicKeyBytes, 'writer', { transportAuthor: 'participant' }),
      grant(participantSigning.publicKeyBytes, 'validator', { minimumAuthorTimestampMs: 0n, transportAuthor: 'participant' }),
    ] }, fixture.root.privateKey)
    await waitFor(() => participant.snapshot.revision === 1n)

    const policyId = await validationPolicyId(fixture.policy)
    const resolver = new CapabilityMembershipResolver({
      snapshotForRevision: (digest) => participant.snapshotForRevision(digest),
    })
    expect(await resolver.canWrite({
      groupId: fixture.groupId,
      membershipRevision: participant.snapshot.revisionDigest,
      validationPolicy: policyId,
      writerId: participantSigning.publicKeyBytes,
    })).toBe(true)

    await fixture.admin.rotateEpoch(fixture.root.privateKey, bytes32(90))
    await waitFor(() => participant.cipherRing.resolve(encodeCanonicalCbor(0n)) !== undefined)
    const participantCapabilities = await fixture.admin.capabilityIdsForSubject(participantSigning.publicKeyBytes)
    await fixture.admin.revoke(participantCapabilities, fixture.root.privateKey)
    await waitFor(() => participant.snapshot.revision === 2n)
    await fixture.admin.rotateEpoch(fixture.root.privateKey, bytes32(91))
    await waitFor(() => participant.currentEpoch === 1n)

    expect(participant.cipherRing.resolve(encodeCanonicalCbor(0n))).toBeDefined()
    expect(participant.cipherRing.resolve(encodeCanonicalCbor(1n))).toBeUndefined()
    expect(await resolver.canWrite({
      groupId: fixture.groupId,
      membershipRevision: participant.snapshot.revisionDigest,
      validationPolicy: policyId,
      writerId: participantSigning.publicKeyBytes,
    })).toBe(false)
    const revokedValidator = participantCapabilities.find((id) => {
      const capability = participant.snapshot.capabilities.get(Buffer.from(id).toString('hex'))
      return capability?.grant.role === 'validator'
    })
    expect(revokedValidator).toBeDefined()
    expect(await resolver.canValidate({
      groupId: fixture.groupId,
      membershipRevision: participant.snapshot.revisionDigest,
      validationPolicy: policyId,
      writerId: fixture.root.publicKeyBytes,
      validatorId: participantSigning.publicKeyBytes,
      validatorCapability: revokedValidator!,
    })).toBe(false)

    const auditorSigning = await generateEd25519KeyPair()
    const auditorHpke = await generateX25519KeyPair()
    const auditorTransport = fixture.network.createNode('auditor')
    fixture.network.connectAll()
    const auditor = await GovernanceControlPlane.create({
      genesis: fixture.genesis,
      groupRoute: fixture.groupRoute,
      transport: auditorTransport,
      identity: auditorSigning,
      recipient: { id: auditorSigning.publicKeyBytes, privateKey: auditorHpke.privateKey },
    })
    controllers.push(auditor)
    await auditor.start()
    await fixture.admin.publishCapabilityChange({ grants: [
      grant(auditorSigning.publicKeyBytes, 'reader', { readerScope: 'audit', hpkePublicKey: auditorHpke.publicKeyBytes, transportAuthor: 'auditor' }),
    ] }, fixture.root.privateKey)
    await waitFor(() => auditor.snapshot.revision === 3n)
    expect(await fixture.admin.grantHistoricalAccess(auditorSigning.publicKeyBytes, fixture.root.privateKey)).toBe(2)
    await waitFor(() => auditor.cipherRing.epochs().length === 2)
    expect(auditor.cipherRing.epochs()).toEqual([0n, 1n])
  })

  it('recovers quorum control, revokes a compromised root, and records history reopening', async () => {
    const reopenings: string[] = []
    const control = new ControlStore()
    const fixture = await governanceFixture((event) => {
      reopenings.push(event.reason)
      control.recordHistoryReopening({
        id: event.id,
        floorMs: 0n,
        membershipRevision: event.membershipRevision,
        reason: event.reason,
      })
    })
    const newRoot = await generateEd25519KeyPair()
    const newFeed = fixture.network.createNode('admin2')
    fixture.network.connectAll()
    const recoveryValidator = grant(newRoot.publicKeyBytes, 'validator', { minimumAuthorTimestampMs: 0n, validFromRevision: 5n, transportAuthor: 'admin2' }) as CapabilityGrant
    const payload: RecoveryPayload = {
      groupId: fixture.groupId,
      lastRevision: fixture.admin.snapshot.revision,
      lastRevisionDigest: fixture.admin.snapshot.revisionDigest,
      newRevision: 5n,
      newRootPublicKey: newRoot.publicKeyBytes,
      newCapabilityLogFeed: new TextEncoder().encode('admin2'),
      validatorGrants: [recoveryValidator],
      reopenHistory: true,
      reopeningReason: 'replace compromised root and restore validator quorum',
    }
    const record = combineRecoverySignatures(payload, [
      await signRecoveryPayload(payload, 0n, fixture.recovery[0].privateKey),
      await signRecoveryPayload(payload, 2n, fixture.recovery[2].privateKey),
    ])
    await fixture.admin.publishRecovery(record)
    await waitFor(() => fixture.admin.snapshot.revision === 5n)
    expect(reopenings).toEqual(['replace compromised root and restore validator quorum'])
    const [reopening] = control.snapshot().historyReopenings
    expect(reopening).toBeDefined()
    control.putCandidate({
      txId: bytes32(40),
      groupId: fixture.groupId,
      candidateDigest: bytes32(41),
      validationPolicy: bytes32(42),
      orderKey: {
        authorTimestampMs: 1n,
        authorId: fixture.root.publicKeyBytes,
        authorFeedSequence: 1n,
        txId: bytes32(40),
      },
      canonicalPayload: Uint8Array.of(1),
      state: 'admissible',
    })
    expect(control.settlementEvidence(bytes32(40), {
      kind: 'threshold',
      policyId: 'recovered-quorum',
      validatorIds: [newRoot.publicKeyBytes],
      threshold: 1,
    }).historyReopeningIds).toEqual([reopening!.id])
    expect([...fixture.admin.snapshot.capabilities.values()].filter((item) =>
      bytesEqual(item.grant.signingPublicKey, fixture.root.publicKeyBytes) && item.revokedAtRevision === undefined)).toEqual([])

    const successor = await GovernanceControlPlane.create({
      genesis: fixture.genesis,
      groupRoute: fixture.groupRoute,
      transport: newFeed,
      identity: newRoot,
    })
    controllers.push(successor)
    await successor.start()
    expect(successor.snapshot.revision).toBe(5n)
    await successor.publishCapabilityChange({ grants: [
      grant(newRoot.publicKeyBytes, 'administrator', { transportAuthor: 'admin2' }),
      grant(newRoot.publicKeyBytes, 'writer', { transportAuthor: 'admin2' }),
    ] }, newRoot.privateKey)
    await waitFor(() => fixture.admin.snapshot.revision === 6n)
    expect(fixture.admin.snapshot.revisionDigest).toEqual(successor.snapshot.revisionDigest)
  })
})

async function governanceFixture(onHistoryReopened?: NonNullable<Parameters<typeof GovernanceControlPlane.create>[0]['onHistoryReopened']>) {
  const network = new MemoryTransportNetwork()
  const adminTransport = network.createNode('admin')
  const root = await generateEd25519KeyPair()
  const rootHpke = await generateX25519KeyPair()
  const recovery = await Promise.all([generateEd25519KeyPair(), generateEd25519KeyPair(), generateEd25519KeyPair()])
  const groupId = bytes32(1)
  const groupRoute = bytes32(2)
  const policy: ValidationPolicy = { version: 1n, minimumValidators: 1n, classMinimums: new Map(), requiredOrganizations: [] }
  const manifest: GenesisManifest = {
    groupId,
    schemaId: bytes32(3),
    rootAdminPublicKey: root.publicKeyBytes,
    capabilityLogFeed: new TextEncoder().encode('admin'),
    recoveryPublicKeys: [recovery[0].publicKeyBytes, recovery[1].publicKeyBytes, recovery[2].publicKeyBytes],
    recoveryThreshold: 2n,
    initialCapabilities: [
      { ...grant(root.publicKeyBytes, 'administrator', { transportAuthor: 'admin' }), validFromRevision: 0n },
      { ...grant(root.publicKeyBytes, 'writer', { transportAuthor: 'admin' }), validFromRevision: 0n },
      { ...grant(root.publicKeyBytes, 'validator', { minimumAuthorTimestampMs: 0n, transportAuthor: 'admin' }), validFromRevision: 0n },
      { ...grant(root.publicKeyBytes, 'reader', { readerScope: 'audit', hpkePublicKey: rootHpke.publicKeyBytes, transportAuthor: 'admin' }), validFromRevision: 0n },
    ],
    validationPolicies: [policy],
    clockPolicy: { maxFutureSkewMs: 30_000n, cutoffLagMs: 1_000n, heartbeatIntervalMs: 1_000n },
    resourcePolicy: { maxCandidateBytes: 1_000_000n, maxProgramNodes: 10_000n, maxPreconditions: 100n, maxMutations: 100n },
    encryptionSuite: 'HPKE-X25519-HKDF-SHA256-AES-256-GCM',
    createdAtMs: 1n,
  }
  const genesis = await signGenesis(manifest, root.privateKey)
  const admin = await GovernanceControlPlane.create({
    genesis,
    groupRoute,
    transport: adminTransport,
    identity: root,
    recipient: { id: root.publicKeyBytes, privateKey: rootHpke.privateKey },
    ...(onHistoryReopened === undefined ? {} : { onHistoryReopened }),
  })
  controllers.push(admin)
  await admin.start()
  return { network, root, recovery, genesis, admin, groupId, groupRoute, policy }
}

function grant(
  signingPublicKey: Uint8Array,
  role: CapabilityGrant['role'],
  options: Partial<CapabilityGrant> = {},
): Omit<CapabilityGrant, 'validFromRevision'> & { readonly validFromRevision?: bigint } {
  return {
    subjectId: signingPublicKey,
    signingPublicKey,
    role,
    ...options,
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('governance condition timed out')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

function bytes32(seed: number): Uint8Array {
  return Uint8Array.from({ length: 32 }, (_value, index) => (seed + index) & 0xff)
}
function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}
