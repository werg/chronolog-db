import {
  DOMAINS,
  bytesToHex,
  equalBytes,
  hashDomain,
  protocolInvariant,
  signDomain,
  verifyDomain,
} from '@chronolog/protocol'
import { encodeRecoveryPayload } from './codec.js'
import { capabilityId } from './reducer.js'
import type {
  CapabilitySnapshot,
  EffectiveCapability,
  RecoveryPayload,
  RecoveryRecord,
  RecoverySignature,
} from './types.js'

export async function signRecoveryPayload(
  payload: RecoveryPayload,
  recoveryKeyIndex: bigint,
  privateKey: CryptoKey,
): Promise<RecoverySignature> {
  protocolInvariant(recoveryKeyIndex >= 0n && recoveryKeyIndex < 3n, 'SCHEMA_INVALID', 'Recovery key index must be zero, one, or two')
  return {
    recoveryKeyIndex,
    signature: await signDomain(DOMAINS.recovery, encodeRecoveryPayload(payload), privateKey),
  }
}

export function combineRecoverySignatures(
  payload: RecoveryPayload,
  signatures: readonly RecoverySignature[],
): RecoveryRecord {
  const unique = new Map(signatures.map((signature) => [signature.recoveryKeyIndex.toString(), signature]))
  return { payload, signatures: [...unique.values()].sort((a, b) => a.recoveryKeyIndex < b.recoveryKeyIndex ? -1 : 1) }
}

export async function verifyRecoveryRecord(
  snapshot: CapabilitySnapshot,
  record: RecoveryRecord,
): Promise<boolean> {
  if (!equalBytes(record.payload.groupId, snapshot.groupId)
    || record.payload.lastRevision !== snapshot.revision
    || !equalBytes(record.payload.lastRevisionDigest, snapshot.revisionDigest)
    || record.payload.newRevision <= snapshot.revision) return false
  const bytes = encodeRecoveryPayload(record.payload)
  const seen = new Set<string>()
  let valid = 0n
  for (const item of record.signatures) {
    const index = Number(item.recoveryKeyIndex)
    if (!Number.isInteger(index) || index < 0 || index >= snapshot.recoveryPublicKeys.length || seen.has(String(index))) continue
    seen.add(String(index))
    const publicKey = snapshot.recoveryPublicKeys[index]
    if (publicKey !== undefined && await verifyDomain(DOMAINS.recovery, bytes, item.signature, publicKey)) valid += 1n
  }
  return valid >= snapshot.recoveryThreshold
}

export async function applyRecoveryRecord(
  snapshot: CapabilitySnapshot,
  record: RecoveryRecord,
): Promise<CapabilitySnapshot> {
  protocolInvariant(await verifyRecoveryRecord(snapshot, record), 'INVALID_SIGNATURE', 'Recovery record does not carry a valid threshold signature')
  const capabilities = new Map(snapshot.capabilities)
  const activeValidatorFloor = [...capabilities.values()]
    .filter((entry) => entry.grant.role === 'validator' && entry.revokedAtRevision === undefined)
    .reduce((maximum, entry) => {
      const floor = entry.grant.minimumAuthorTimestampMs ?? 0n
      return floor > maximum ? floor : maximum
    }, 0n)
  if (!record.payload.reopenHistory) {
    protocolInvariant(
      record.payload.validatorGrants.every((grant) => (grant.minimumAuthorTimestampMs ?? -1n) >= activeValidatorFloor),
      'SCHEMA_INVALID',
      'Recovery lowers a validator floor without declaring history reopening',
    )
  }
  for (const [key, effective] of capabilities) {
    if (effective.grant.role === 'validator' && effective.revokedAtRevision === undefined) {
      capabilities.set(key, { ...effective, revokedAtRevision: record.payload.newRevision })
    }
  }
  for (const grant of record.payload.validatorGrants) {
    protocolInvariant(grant.validFromRevision === record.payload.newRevision, 'SCHEMA_INVALID', 'Recovery grant must begin at recovery revision')
    const id = await capabilityId(grant)
    protocolInvariant(!capabilities.has(bytesToHex(id)), 'SCHEMA_INVALID', 'Recovery repeats an existing capability')
    const effective: EffectiveCapability = { id, grant, grantedAtRevision: record.payload.newRevision }
    capabilities.set(bytesToHex(id), effective)
  }
  const recoveryEventDigest = await hashDomain(DOMAINS.recovery, encodeRecoveryPayload(record.payload))
  return {
    ...snapshot,
    revision: record.payload.newRevision,
    revisionDigest: recoveryEventDigest,
    rootAdminPublicKey: record.payload.newRootPublicKey,
    capabilityLogFeed: record.payload.newCapabilityLogFeed,
    capabilities,
    historyReopened: record.payload.reopenHistory,
    recoveryEventDigest,
  }
}
