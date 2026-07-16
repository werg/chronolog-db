import {
  capabilityId,
  decodeRecoveryRecord,
  isCapabilityActive,
  type CapabilityGrant,
} from '@chronolog/capabilities'
import type { GovernanceControlPlane } from '@chronolog/node-core'
import { equalBytes } from '@chronolog/protocol'
import {
  ChronologRpcError,
  type GovernanceCapabilityStatus,
  type GovernanceRpcAdmin,
} from '@chronolog/rpc'

export function createGovernanceRpcAdmin(options: {
  readonly governance: GovernanceControlPlane
  readonly rootPrivateKey: CryptoKey
  readonly now?: () => number
}): GovernanceRpcAdmin {
  const now = options.now ?? Date.now
  return {
    async getStatus() {
      const snapshot = options.governance.snapshot
      const capabilities: GovernanceCapabilityStatus[] = [...snapshot.capabilities.values()]
        .map((item) => ({
          capabilityId: base64url(item.id),
          subjectId: base64url(item.grant.subjectId),
          signingPublicKey: base64url(item.grant.signingPublicKey),
          ...(item.grant.transportAuthor === undefined ? {} : { transportAuthor: item.grant.transportAuthor }),
          role: item.grant.role,
          validFromRevision: item.grant.validFromRevision.toString(10),
          ...(item.grant.validUntilRevision === undefined ? {} : { validUntilRevision: item.grant.validUntilRevision.toString(10) }),
          ...(item.revokedAtRevision === undefined ? {} : { revokedAtRevision: item.revokedAtRevision.toString(10) }),
          active: isCapabilityActive(item, snapshot.revision),
          ...(item.grant.organization === undefined ? {} : { organization: item.grant.organization }),
          ...(item.grant.validatorClass === undefined ? {} : { validatorClass: item.grant.validatorClass }),
          ...(item.grant.readerScope === undefined ? {} : { readerScope: item.grant.readerScope }),
          ...(item.grant.hpkePublicKey === undefined ? {} : { hpkePublicKey: base64url(item.grant.hpkePublicKey) }),
        }))
        .sort((left, right) => left.role.localeCompare(right.role) || left.capabilityId.localeCompare(right.capabilityId))
      return {
        groupId: base64url(snapshot.groupId),
        revision: snapshot.revision.toString(10),
        revisionDigest: base64url(snapshot.revisionDigest),
        rootAdminPublicKey: base64url(snapshot.rootAdminPublicKey),
        capabilityLogFeed: new TextDecoder().decode(snapshot.capabilityLogFeed),
        currentEpoch: options.governance.currentEpoch?.toString(10) ?? null,
        historyReopened: snapshot.historyReopened,
        capabilities,
      }
    },

    async grantCapability(request) {
      const snapshot = options.governance.snapshot
      const grant: Omit<CapabilityGrant, 'validFromRevision'> = {
        subjectId: publicKey(request.subjectId, 'subjectId'),
        signingPublicKey: publicKey(request.signingPublicKey, 'signingPublicKey'),
        role: request.role,
        ...(request.transportAuthor === undefined ? {} : { transportAuthor: boundedText(request.transportAuthor, 'transportAuthor') }),
        ...(request.validUntilRevision === undefined ? {} : { validUntilRevision: decimal(request.validUntilRevision, 'validUntilRevision') }),
        ...(request.organization === undefined ? {} : { organization: boundedText(request.organization, 'organization') }),
        ...(request.validatorClass === undefined ? {} : { validatorClass: boundedText(request.validatorClass, 'validatorClass') }),
        ...(request.minimumAuthorTimestampMs === undefined
          ? request.role === 'validator' ? { minimumAuthorTimestampMs: BigInt(Math.trunc(now())) } : {}
          : { minimumAuthorTimestampMs: decimal(request.minimumAuthorTimestampMs, 'minimumAuthorTimestampMs') }),
        ...(request.readerScope === undefined ? {} : { readerScope: request.readerScope }),
        ...(request.hpkePublicKey === undefined ? {} : { hpkePublicKey: publicKey(request.hpkePublicKey, 'hpkePublicKey') }),
      }
      if (grant.validUntilRevision !== undefined && grant.validUntilRevision <= snapshot.revision) {
        throw invalid('validUntilRevision must be later than the current governance revision')
      }
      if (grant.role === 'reader' && (grant.readerScope === undefined || grant.hpkePublicKey === undefined)) {
        throw invalid('reader grants require readerScope and hpkePublicKey')
      }
      if (grant.role !== 'reader' && (grant.readerScope !== undefined || grant.hpkePublicKey !== undefined)) {
        throw invalid('readerScope and hpkePublicKey are valid only for reader grants')
      }
      const signed = await operation(() => options.governance.publishCapabilityChange({ grants: [grant] }, options.rootPrivateKey))
      return {
        revision: signed.revision.revision.toString(10),
        capabilityId: base64url(await capabilityId(signed.revision.grants[0]!)),
      }
    },

    async revokeCapabilities(request) {
      if (request.capabilityIds.length === 0) throw invalid('capabilityIds must not be empty')
      const ids = request.capabilityIds.map((value) => bytes(value, 'capabilityId', 32))
      const signed = await operation(() => options.governance.revoke(ids, options.rootPrivateKey))
      return { revision: signed.revision.revision.toString(10), revokedCapabilityIds: ids.map(base64url) }
    },

    async rotateEpoch() {
      const signed = await operation(() => options.governance.rotateEpoch(options.rootPrivateKey))
      return { epoch: signed.manifest.epoch.toString(10) }
    },

    async grantHistoricalAccess(request) {
      const published = await operation(() => options.governance.grantHistoricalAccess(
        publicKey(request.subjectId, 'subjectId'),
        options.rootPrivateKey,
      ))
      return { epochManifestsPublished: published }
    },

    async publishRecovery(request) {
      let record
      try { record = decodeRecoveryRecord(bytes(request.canonicalRecoveryRecord, 'canonicalRecoveryRecord')) }
      catch (error) { throw invalid('canonicalRecoveryRecord is not a canonical recovery record', error) }
      if (!equalBytes(record.payload.groupId, options.governance.snapshot.groupId)) throw invalid('Recovery record belongs to another group')
      await operation(() => options.governance.publishRecovery(record))
      return { published: true }
    },
  }
}

async function operation<T>(run: () => Promise<T>): Promise<T> {
  try { return await run() }
  catch (error) {
    if (error instanceof ChronologRpcError) throw error
    throw new ChronologRpcError('failed_precondition', error instanceof Error ? error.message : 'Governance operation failed', { cause: error })
  }
}

function boundedText(value: string, label: string): string {
  if (value.length === 0 || value.length > 512) throw invalid(`${label} must contain 1 to 512 characters`)
  return value
}

function decimal(value: string, label: string): bigint {
  if (!/^(0|[1-9][0-9]*)$/u.test(value)) throw invalid(`${label} must be an unsigned decimal integer`)
  return BigInt(value)
}

function publicKey(value: string, label: string): Uint8Array { return bytes(value, label, 32) }
function bytes(value: string, label: string, length?: number): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw invalid(`${label} must be unpadded base64url`)
  const decoded = Uint8Array.from(Buffer.from(value, 'base64url'))
  if (base64url(decoded) !== value || (length !== undefined && decoded.byteLength !== length)) {
    throw invalid(`${label} is not canonical${length === undefined ? '' : ` ${length}-byte`} base64url`)
  }
  return decoded
}
function base64url(value: Uint8Array): string { return Buffer.from(value).toString('base64url') }
function invalid(message: string, cause?: unknown): ChronologRpcError {
  return new ChronologRpcError('invalid_argument', message, cause === undefined ? {} : { cause })
}
