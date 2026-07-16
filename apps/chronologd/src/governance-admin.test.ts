import { describe, expect, it, vi } from 'vitest'

import type { CapabilitySnapshot, SignedCapabilityRevision } from '@chronolog/capabilities'
import type { CapabilityChange, GovernanceControlPlane } from '@chronolog/node-core'

import { createGovernanceRpcAdmin } from './governance-admin.js'

describe('governance admin RPC adapter', () => {
  it('reports a stable public capability inventory and delegates a bounded grant', async () => {
    const snapshot = capabilitySnapshot()
    const publishCapabilityChange = vi.fn(async (change: CapabilityChange): Promise<SignedCapabilityRevision> => ({
      revision: {
        groupId: snapshot.groupId,
        revision: 4n,
        previousRevisionDigest: snapshot.revisionDigest,
        issuerRootPublicKey: snapshot.rootAdminPublicKey,
        grants: (change.grants ?? []).map((grant) => ({ ...grant, validFromRevision: 4n })),
        revocations: [],
        validationPolicies: [],
      },
      signature: bytes(99),
    }))
    const governance = {
      snapshot,
      currentEpoch: 7n,
      publishCapabilityChange,
    } as unknown as GovernanceControlPlane
    const admin = createGovernanceRpcAdmin({ governance, rootPrivateKey: {} as CryptoKey, now: () => 12_345 })

    const status = await admin.getStatus({ groupId: b64(snapshot.groupId), requestId: 'status' })
    expect(status).toMatchObject({ revision: '3', currentEpoch: '7', historyReopened: false })
    expect(status.capabilities).toEqual([expect.objectContaining({ role: 'administrator', active: true })])

    const response = await admin.grantCapability({
      groupId: b64(snapshot.groupId),
      requestId: 'grant',
      subjectId: b64(bytes(20)),
      signingPublicKey: b64(bytes(21)),
      transportAuthor: 'new-node-feed',
      role: 'validator',
      organization: 'pilot-a',
    })
    expect(response.revision).toBe('4')
    expect(Buffer.from(response.capabilityId, 'base64url')).toHaveLength(32)
    expect(publishCapabilityChange).toHaveBeenCalledWith({ grants: [expect.objectContaining({
      role: 'validator',
      minimumAuthorTimestampMs: 12_345n,
    })] }, expect.anything())
  })

  it('rejects ambiguous keys, invalid reader grants, and non-future expiry', async () => {
    const governance = { snapshot: capabilitySnapshot(), currentEpoch: null } as unknown as GovernanceControlPlane
    const admin = createGovernanceRpcAdmin({ governance, rootPrivateKey: {} as CryptoKey })
    const base = { groupId: b64(governance.snapshot.groupId), requestId: 'grant' }
    const common = { ...base, subjectId: b64(bytes(20)), signingPublicKey: b64(bytes(21)) }

    await expect(admin.grantCapability({ ...common, role: 'reader' })).rejects.toMatchObject({ code: 'invalid_argument' })
    await expect(admin.grantCapability({ ...common, role: 'writer', signingPublicKey: 'not base64!' })).rejects.toMatchObject({ code: 'invalid_argument' })
    await expect(admin.grantCapability({ ...common, role: 'writer', validUntilRevision: '3' })).rejects.toMatchObject({ code: 'invalid_argument' })
  })

  it('accepts only same-group canonical offline recovery records', async () => {
    const publishRecovery = vi.fn()
    const governance = {
      snapshot: capabilitySnapshot(),
      currentEpoch: null,
      publishRecovery,
    } as unknown as GovernanceControlPlane
    const admin = createGovernanceRpcAdmin({ governance, rootPrivateKey: {} as CryptoKey })
    await expect(admin.publishRecovery({
      groupId: b64(governance.snapshot.groupId),
      requestId: 'recover',
      canonicalRecoveryRecord: b64(Uint8Array.of(1, 2, 3)),
    })).rejects.toMatchObject({ code: 'invalid_argument' })
    expect(publishRecovery).not.toHaveBeenCalled()
  })
})

function capabilitySnapshot(): CapabilitySnapshot {
  const id = bytes(8)
  return {
    groupId: bytes(1),
    revision: 3n,
    revisionDigest: bytes(2),
    rootAdminPublicKey: bytes(3),
    capabilityLogFeed: new TextEncoder().encode('admin-feed'),
    capabilities: new Map([[b64(id), {
      id,
      grant: {
        subjectId: bytes(4),
        signingPublicKey: bytes(4),
        transportAuthor: 'admin-feed',
        role: 'administrator',
        validFromRevision: 0n,
      },
      grantedAtRevision: 0n,
    }]]),
    policies: new Map(),
    recoveryPublicKeys: [bytes(5), bytes(6), bytes(7)],
    recoveryThreshold: 2n,
    historyReopened: false,
  }
}

function bytes(seed: number): Uint8Array {
  return Uint8Array.from({ length: 32 }, (_value, index) => (seed + index) & 0xff)
}
function b64(value: Uint8Array): string { return Buffer.from(value).toString('base64url') }
