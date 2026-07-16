import {
  combineRecoverySignatures,
  decodeRecoveryPayload,
  decodeRecoveryRecord,
  encodeRecoveryPayload,
  encodeRecoveryRecord,
  signRecoveryPayload,
  verifyRecoveryRecord,
  type CapabilityGrant,
  type CapabilitySnapshot,
  type RecoveryPayload,
} from '@chronolog/capabilities'
import { importEd25519PrivateKey } from '@chronolog/protocol'

export interface RecoveryPayloadSpec {
  readonly groupId: string
  readonly lastRevision: string
  readonly lastRevisionDigest: string
  readonly newRevision: string
  readonly newRootPublicKey: string
  readonly newCapabilityLogFeed: string
  readonly validatorGrants: readonly {
    readonly subjectId: string
    readonly signingPublicKey: string
    readonly transportAuthor?: string
    readonly validUntilRevision?: string
    readonly organization?: string
    readonly validatorClass?: string
    readonly minimumAuthorTimestampMs: string
  }[]
  readonly reopenHistory: boolean
  readonly reopeningReason?: string
}

export interface RecoveryCustodyPublicManifest {
  readonly format: 'chronolog-recovery-custody-v1'
  readonly groupId: string
  readonly recoveryThreshold: string
  readonly recoveryPublicKeys: readonly [string, string, string]
}

export function prepareRecoveryPayload(spec: RecoveryPayloadSpec): string {
  const newRevision = decimal(spec.newRevision, 'newRevision')
  const validatorGrants: CapabilityGrant[] = spec.validatorGrants.map((grant) => ({
    subjectId: bytes(grant.subjectId, 'subjectId', 32),
    signingPublicKey: bytes(grant.signingPublicKey, 'signingPublicKey', 32),
    role: 'validator',
    validFromRevision: newRevision,
    minimumAuthorTimestampMs: decimal(grant.minimumAuthorTimestampMs, 'minimumAuthorTimestampMs'),
    ...(grant.transportAuthor === undefined ? {} : { transportAuthor: grant.transportAuthor }),
    ...(grant.validUntilRevision === undefined ? {} : { validUntilRevision: decimal(grant.validUntilRevision, 'validUntilRevision') }),
    ...(grant.organization === undefined ? {} : { organization: grant.organization }),
    ...(grant.validatorClass === undefined ? {} : { validatorClass: grant.validatorClass }),
  }))
  const payload: RecoveryPayload = {
    groupId: bytes(spec.groupId, 'groupId', 32),
    lastRevision: decimal(spec.lastRevision, 'lastRevision'),
    lastRevisionDigest: bytes(spec.lastRevisionDigest, 'lastRevisionDigest', 32),
    newRevision,
    newRootPublicKey: bytes(spec.newRootPublicKey, 'newRootPublicKey', 32),
    newCapabilityLogFeed: bytes(spec.newCapabilityLogFeed, 'newCapabilityLogFeed'),
    validatorGrants,
    reopenHistory: spec.reopenHistory,
    ...(spec.reopeningReason === undefined ? {} : { reopeningReason: spec.reopeningReason }),
  }
  return base64url(encodeRecoveryPayload(payload))
}

export function inspectRecoveryPayload(encoded: string): RecoveryPayloadSpec {
  const payload = decodeRecoveryPayload(bytes(encoded.trim(), 'payload'))
  return {
    groupId: base64url(payload.groupId),
    lastRevision: payload.lastRevision.toString(10),
    lastRevisionDigest: base64url(payload.lastRevisionDigest),
    newRevision: payload.newRevision.toString(10),
    newRootPublicKey: base64url(payload.newRootPublicKey),
    newCapabilityLogFeed: base64url(payload.newCapabilityLogFeed),
    validatorGrants: payload.validatorGrants.map((grant) => ({
      subjectId: base64url(grant.subjectId),
      signingPublicKey: base64url(grant.signingPublicKey),
      minimumAuthorTimestampMs: (grant.minimumAuthorTimestampMs ?? 0n).toString(10),
      ...(grant.transportAuthor === undefined ? {} : { transportAuthor: grant.transportAuthor }),
      ...(grant.validUntilRevision === undefined ? {} : { validUntilRevision: grant.validUntilRevision.toString(10) }),
      ...(grant.organization === undefined ? {} : { organization: grant.organization }),
      ...(grant.validatorClass === undefined ? {} : { validatorClass: grant.validatorClass }),
    })),
    reopenHistory: payload.reopenHistory,
    ...(payload.reopeningReason === undefined ? {} : { reopeningReason: payload.reopeningReason }),
  }
}

export async function signRecoveryArtifact(encodedPayload: string, keyIndex: number, privateKeyPkcs8Base64: string): Promise<string> {
  if (!Number.isInteger(keyIndex) || keyIndex < 0 || keyIndex > 2) throw new Error('Recovery key index must be 0, 1, or 2')
  const payload = decodeRecoveryPayload(bytes(encodedPayload.trim(), 'payload'))
  const keyBytes = standardBase64(privateKeyPkcs8Base64.trim(), 'privateKeyPkcs8')
  const privateKey = await importEd25519PrivateKey(keyBytes, false)
  const signature = await signRecoveryPayload(payload, BigInt(keyIndex), privateKey)
  return base64url(encodeRecoveryRecord(combineRecoverySignatures(payload, [signature])))
}

export function combineRecoveryArtifacts(encodedPayload: string, artifacts: readonly string[]): string {
  if (artifacts.length === 0) throw new Error('At least one signed artifact is required')
  const payloadBytes = bytes(encodedPayload.trim(), 'payload')
  const payload = decodeRecoveryPayload(payloadBytes)
  const signatures = artifacts.flatMap((artifact) => {
    const record = decodeRecoveryRecord(bytes(artifact.trim(), 'signedArtifact'))
    if (base64url(encodeRecoveryPayload(record.payload)) !== base64url(payloadBytes)) throw new Error('Signed artifact payload mismatch')
    return record.signatures
  })
  return base64url(encodeRecoveryRecord(combineRecoverySignatures(payload, signatures)))
}

export async function verifyRecoveryArtifact(encodedRecord: string, manifest: RecoveryCustodyPublicManifest): Promise<boolean> {
  if (manifest.format !== 'chronolog-recovery-custody-v1' || manifest.recoveryPublicKeys.length !== 3) {
    throw new Error('Recovery custody manifest is invalid')
  }
  const record = decodeRecoveryRecord(bytes(encodedRecord.trim(), 'recoveryRecord'))
  const snapshot: CapabilitySnapshot = {
    groupId: bytes(manifest.groupId, 'manifest.groupId', 32),
    revision: record.payload.lastRevision,
    revisionDigest: record.payload.lastRevisionDigest,
    rootAdminPublicKey: new Uint8Array(32),
    capabilityLogFeed: new Uint8Array(),
    capabilities: new Map(),
    policies: new Map(),
    recoveryPublicKeys: manifest.recoveryPublicKeys.map((key) => standardBase64(key, 'recoveryPublicKey', 32)) as unknown as [Uint8Array, Uint8Array, Uint8Array],
    recoveryThreshold: decimal(manifest.recoveryThreshold, 'recoveryThreshold'),
    historyReopened: false,
  }
  return verifyRecoveryRecord(snapshot, record)
}

function decimal(value: string, label: string): bigint {
  if (!/^(0|[1-9][0-9]*)$/u.test(value)) throw new Error(`${label} must be an unsigned decimal integer`)
  return BigInt(value)
}
function bytes(value: string, label: string, length?: number): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error(`${label} must be canonical base64url`)
  const decoded = Uint8Array.from(Buffer.from(value, 'base64url'))
  if (base64url(decoded) !== value || (length !== undefined && decoded.byteLength !== length)) throw new Error(`${label} must be canonical base64url${length === undefined ? '' : ` with ${length} bytes`}`)
  return decoded
}
function standardBase64(value: string, label: string, length?: number): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) throw new Error(`${label} must be canonical base64`)
  const decoded = Uint8Array.from(Buffer.from(value, 'base64'))
  if (Buffer.from(decoded).toString('base64') !== value || (length !== undefined && decoded.byteLength !== length)) throw new Error(`${label} must be canonical base64${length === undefined ? '' : ` with ${length} bytes`}`)
  return decoded
}
function base64url(value: Uint8Array): string { return Buffer.from(value).toString('base64url') }
