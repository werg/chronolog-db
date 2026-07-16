import { describe, expect, it } from 'vitest'

import { exportEd25519PrivateKey, generateEd25519KeyPair } from '@chronolog/protocol'

import {
  combineRecoveryArtifacts,
  inspectRecoveryPayload,
  prepareRecoveryPayload,
  signRecoveryArtifact,
  verifyRecoveryArtifact,
  type RecoveryCustodyPublicManifest,
  type RecoveryPayloadSpec,
} from './ceremony.js'

describe('offline recovery ceremony', () => {
  it('prepares inspectable bytes, signs on separate shares, combines, and verifies the threshold', async () => {
    const recovery = await Promise.all([generateEd25519KeyPair(), generateEd25519KeyPair(), generateEd25519KeyPair()])
    const spec = recoverySpec()
    const payload = prepareRecoveryPayload(spec)
    expect(inspectRecoveryPayload(payload)).toEqual(spec)
    const shares = await Promise.all([0, 2].map(async (index) => signRecoveryArtifact(
      payload,
      index,
      Buffer.from(await exportEd25519PrivateKey(recovery[index]!.privateKey)).toString('base64'),
    )))
    const record = combineRecoveryArtifacts(payload, shares)
    const manifest: RecoveryCustodyPublicManifest = {
      format: 'chronolog-recovery-custody-v1',
      groupId: spec.groupId,
      recoveryThreshold: '2',
      recoveryPublicKeys: recovery.map((key) => Buffer.from(key.publicKeyBytes).toString('base64')) as [string, string, string],
    }
    expect(await verifyRecoveryArtifact(record, manifest)).toBe(true)
    expect(await verifyRecoveryArtifact(shares[0]!, manifest)).toBe(false)
  })

  it('refuses to combine signatures over different payloads', async () => {
    const recovery = await generateEd25519KeyPair()
    const first = prepareRecoveryPayload(recoverySpec())
    const second = prepareRecoveryPayload({ ...recoverySpec(), newRevision: '6' })
    const share = await signRecoveryArtifact(second, 0, Buffer.from(
      await exportEd25519PrivateKey(recovery.privateKey),
    ).toString('base64'))
    expect(() => combineRecoveryArtifacts(first, [share])).toThrow('Signed artifact payload mismatch')
  })
})

function recoverySpec(): RecoveryPayloadSpec {
  return {
    groupId: b64url(bytes(1)),
    lastRevision: '4',
    lastRevisionDigest: b64url(bytes(2)),
    newRevision: '5',
    newRootPublicKey: b64url(bytes(3)),
    newCapabilityLogFeed: b64url(new TextEncoder().encode('@replacement.ed25519')),
    validatorGrants: [{
      subjectId: b64url(bytes(4)),
      signingPublicKey: b64url(bytes(4)),
      transportAuthor: '@replacement.ed25519',
      organization: 'pilot-a',
      validatorClass: 'primary',
      minimumAuthorTimestampMs: '1700000000000',
    }],
    reopenHistory: true,
    reopeningReason: 'restore quorum after administrator loss',
  }
}

function bytes(seed: number): Uint8Array {
  return Uint8Array.from({ length: 32 }, (_value, index) => (seed + index) & 0xff)
}
function b64url(value: Uint8Array): string { return Buffer.from(value).toString('base64url') }
