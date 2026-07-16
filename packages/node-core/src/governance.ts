import {
  applyCapabilityRevision,
  applyRecoveryRecord,
  capabilityId,
  decodeRecoveryRecord as decodeRecoveryRecordBytes,
  decodeSignedCapabilityRevision as decodeSignedCapabilityRevisionBytes,
  encodeRecoveryRecord as encodeRecoveryRecordBytes,
  encodeSignedCapabilityRevision as encodeSignedCapabilityRevisionBytes,
  isCapabilityActive,
  reduceCapabilityLog,
  signCapabilityRevision,
  type CapabilityGrant,
  type CapabilityRevision,
  type CapabilitySnapshot,
  type RecoveryRecord,
  type SignedCapabilityRevision,
  type SignedGenesis,
  type ValidationPolicy,
} from '@chronolog/capabilities'
import {
  createEpochManifest,
  decodeSignedEpochManifest,
  encodeEpochManifest,
  encodeSignedEpochManifest,
  unwrapEpochKey,
  verifyEpochManifest,
  type SignedEpochManifest,
} from '@chronolog/crypto'
import {
  DOMAINS,
  assertCanonicalCbor,
  bytesToHex,
  decodeEnvelope,
  encodeCanonicalCbor,
  encodeEnvelope,
  equalBytes,
  hashDomain,
  signDomain,
  verifyDomain,
  type CborValue,
  type Ed25519KeyPair,
  type EnvelopeMessageType,
  type ProtocolDomain,
} from '@chronolog/protocol'
import type { ChronologTransport, TransportRecord } from '@chronolog/transport-ssb'

import { Mutex, RevisionBroadcaster } from './async.js'
import { EpochCipherRing } from './cipher.js'

type GovernanceMessageType = Extract<EnvelopeMessageType, 'capability' | 'recovery' | 'epoch-manifest'>

export interface GovernanceEvent {
  readonly revision: bigint
  readonly type: 'capability' | 'recovery' | 'epoch_rotated' | 'historical_access_granted'
  readonly recordId: string
  readonly membershipRevision: Uint8Array
  readonly epoch?: bigint
  readonly historyReopened: boolean
}

export interface GovernanceControlPlaneOptions {
  readonly genesis: SignedGenesis
  readonly groupRoute: Uint8Array
  readonly transport: ChronologTransport
  readonly identity: Ed25519KeyPair
  readonly cipherRing?: EpochCipherRing
  readonly recipient?: {
    readonly id: Uint8Array
    readonly privateKey: CryptoKey
  }
  readonly now?: () => number
  readonly onHistoryReopened?: (event: {
    readonly id: string
    readonly membershipRevision: Uint8Array
    readonly reason: string
  }) => void
}

export interface CapabilityChange {
  readonly grants?: readonly Omit<CapabilityGrant, 'validFromRevision'>[]
  readonly revocations?: readonly Uint8Array[]
  readonly validationPolicies?: readonly ValidationPolicy[]
  readonly successorRootPublicKey?: Uint8Array
  readonly successorCapabilityLogFeed?: Uint8Array
}

export class GovernanceControlPlane {
  readonly #options: GovernanceControlPlaneOptions
  readonly #cipherRing: EpochCipherRing
  readonly #snapshots = new Map<string, CapabilitySnapshot>()
  readonly #seen = new Set<string>()
  readonly #mutex = new Mutex()
  readonly #events = new RevisionBroadcaster<GovernanceEvent>()
  readonly #epochManifests = new Map<bigint, SignedEpochManifest>()
  readonly #epochDigests = new Map<bigint, Uint8Array>()
  readonly #contentKeys = new Map<bigint, Uint8Array>()
  readonly #abort = new AbortController()
  #snapshot: CapabilitySnapshot
  #eventRevision = 0n
  #currentEpoch = -1n
  #consumeTask: Promise<void> | undefined
  #started = false

  private constructor(options: GovernanceControlPlaneOptions, snapshot: CapabilitySnapshot) {
    this.#options = options
    this.#snapshot = snapshot
    this.#cipherRing = options.cipherRing ?? new EpochCipherRing()
    this.#rememberSnapshot(snapshot)
  }

  static async create(options: GovernanceControlPlaneOptions): Promise<GovernanceControlPlane> {
    return new GovernanceControlPlane(options, await reduceCapabilityLog(options.genesis, []))
  }

  get snapshot(): CapabilitySnapshot { return structuredClone(this.#snapshot) }
  get cipherRing(): EpochCipherRing { return this.#cipherRing }
  get currentEpoch(): bigint | null { return this.#currentEpoch < 0n ? null : this.#currentEpoch }

  snapshotForRevision(digest: Uint8Array): CapabilitySnapshot | null {
    const snapshot = this.#snapshots.get(bytesToHex(digest))
    return snapshot === undefined ? null : structuredClone(snapshot)
  }

  async start(): Promise<void> {
    if (this.#started) return
    this.#started = true
    const history = await this.#options.transport.history()
    for (const record of history) await this.ingest(record)
    this.#consumeTask = this.#consume(this.#options.transport.subscribe(this.#abort.signal))
  }

  async close(): Promise<void> {
    this.#abort.abort()
    await this.#consumeTask?.catch(() => undefined)
    this.#events.close()
  }

  events(afterRevision = 0n, signal?: AbortSignal): AsyncIterable<GovernanceEvent> {
    const source = this.#events.subscribe(signal === undefined ? {} : { signal })
    return {
      async *[Symbol.asyncIterator]() {
        for await (const event of source) if (event.revision > afterRevision) yield event
      },
    }
  }

  async publishCapabilityChange(change: CapabilityChange, rootPrivateKey: CryptoKey): Promise<SignedCapabilityRevision> {
    this.#assertCapabilityFeedOwner()
    const revisionNumber = this.#snapshot.revision + 1n
    const revision: CapabilityRevision = {
      groupId: this.#snapshot.groupId,
      revision: revisionNumber,
      previousRevisionDigest: this.#snapshot.revisionDigest,
      issuerRootPublicKey: this.#snapshot.rootAdminPublicKey,
      grants: (change.grants ?? []).map((grant) => ({ ...grant, validFromRevision: revisionNumber })),
      revocations: (change.revocations ?? []).map((id) => id.slice()),
      validationPolicies: [...(change.validationPolicies ?? [])],
      ...(change.successorRootPublicKey === undefined ? {} : { successorRootPublicKey: change.successorRootPublicKey }),
      ...(change.successorCapabilityLogFeed === undefined ? {} : { successorCapabilityLogFeed: change.successorCapabilityLogFeed }),
    }
    const signed = await signCapabilityRevision(revision, rootPrivateKey)
    await this.#publish('capability', encodeCanonicalCbor([1n, encodeSignedCapabilityRevisionBytes(signed)]))
    return signed
  }

  async revoke(capabilityIds: readonly Uint8Array[], rootPrivateKey: CryptoKey): Promise<SignedCapabilityRevision> {
    return this.publishCapabilityChange({ revocations: capabilityIds }, rootPrivateKey)
  }

  async publishRecovery(record: RecoveryRecord): Promise<void> {
    await this.#publish('recovery', encodeCanonicalCbor([1n, encodeRecoveryRecordBytes(record)]))
  }

  async rotateEpoch(rootPrivateKey: CryptoKey, contentKey?: Uint8Array): Promise<SignedEpochManifest> {
    this.#assertCapabilityFeedOwner()
    const recipients = [...this.#snapshot.capabilities.values()]
      .filter((capability) => capability.grant.role === 'reader' && isCapabilityActive(capability, this.#snapshot.revision))
      .map((capability) => ({
        recipientId: capability.grant.subjectId,
        publicKey: capability.grant.hpkePublicKey!,
      }))
    const epoch = this.#currentEpoch + 1n
    const created = await createEpochManifest({
      groupId: this.#snapshot.groupId,
      epoch,
      previousEpochDigest: this.#currentEpoch < 0n ? null : this.#epochDigests.get(this.#currentEpoch) ?? null,
      createdAtMs: BigInt(Math.trunc(this.#options.now?.() ?? Date.now())),
      recipients,
      signerPublicKey: this.#snapshot.rootAdminPublicKey,
      signerPrivateKey: rootPrivateKey,
      ...(contentKey === undefined ? {} : { contentKey }),
    })
    this.#contentKeys.set(epoch, created.contentKey.slice())
    await this.#publish('epoch-manifest', encodeCanonicalCbor([1n, encodeSignedEpochManifest(created.signedManifest)]))
    return created.signedManifest
  }

  async grantHistoricalAccess(subjectId: Uint8Array, rootPrivateKey: CryptoKey): Promise<number> {
    this.#assertCapabilityFeedOwner()
    const reader = [...this.#snapshot.capabilities.values()].find((capability) =>
      capability.grant.role === 'reader' && capability.grant.readerScope === 'audit' &&
      equalBytes(capability.grant.subjectId, subjectId) && isCapabilityActive(capability, this.#snapshot.revision))
    if (reader === undefined) throw new Error('GOVERNANCE_AUDIT_READER_REQUIRED')
    let published = 0
    for (const [epoch, key] of [...this.#contentKeys].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) {
      const original = this.#epochManifests.get(epoch)
      if (original === undefined) continue
      const created = await createEpochManifest({
        groupId: this.#snapshot.groupId,
        epoch,
        previousEpochDigest: original.manifest.previousEpochDigest,
        createdAtMs: BigInt(Math.trunc(this.#options.now?.() ?? Date.now())),
        recipients: [{ recipientId: subjectId, publicKey: reader.grant.hpkePublicKey! }],
        signerPublicKey: this.#snapshot.rootAdminPublicKey,
        signerPrivateKey: rootPrivateKey,
        contentKey: key,
      })
      await this.#publish('epoch-manifest', encodeCanonicalCbor([2n, encodeSignedEpochManifest(created.signedManifest)]))
      published += 1
    }
    return published
  }

  async ingest(record: TransportRecord): Promise<boolean> {
    return this.#mutex.run(() => this.#ingest(record))
  }

  async #ingest(record: TransportRecord): Promise<boolean> {
    if (this.#seen.has(record.id)) return false
    let decoded: { readonly type: GovernanceMessageType; readonly payload: Uint8Array }
    try { decoded = await decodeGovernanceEnvelope(record.payload, this.#options.groupRoute) }
    catch { return false }
    if (decoded.type !== 'recovery' && record.author !== feedAuthor(this.#snapshot.capabilityLogFeed)) {
      throw new Error('GOVERNANCE_CAPABILITY_FEED_UNAUTHORIZED')
    }
    const tagged = assertCanonicalCbor(decoded.payload)
    if (!Array.isArray(tagged) || tagged.length !== 2 || typeof tagged[0] !== 'bigint' || !(tagged[1] instanceof Uint8Array)) {
      throw new Error('GOVERNANCE_PAYLOAD_INVALID')
    }
    if (decoded.type === 'capability') {
      const signed = decodeSignedCapabilityRevisionBytes(tagged[1])
      this.#snapshot = await applyCapabilityRevision(this.#snapshot, signed)
      this.#rememberSnapshot(this.#snapshot)
      this.#emit('capability', record.id)
    } else if (decoded.type === 'recovery') {
      const recovery = decodeRecoveryRecordBytes(tagged[1])
      this.#snapshot = await applyRecoveryRecord(this.#snapshot, recovery)
      this.#rememberSnapshot(this.#snapshot)
      if (recovery.payload.reopenHistory) {
        const id = bytesToHex(this.#snapshot.recoveryEventDigest!)
        this.#options.onHistoryReopened?.({
          id,
          membershipRevision: this.#snapshot.revisionDigest,
          reason: recovery.payload.reopeningReason!,
        })
      }
      this.#emit('recovery', record.id)
    } else {
      const signed = decodeSignedEpochManifest(tagged[1])
      await this.#ingestEpoch(signed, tagged[0] === 2n, record.id)
    }
    this.#seen.add(record.id)
    return true
  }

  async capabilityIdsForSubject(subjectId: Uint8Array): Promise<readonly Uint8Array[]> {
    const ids: Uint8Array[] = []
    for (const capability of this.#snapshot.capabilities.values()) {
      if (equalBytes(capability.grant.subjectId, subjectId) && isCapabilityActive(capability, this.#snapshot.revision)) {
        ids.push(await capabilityId(capability.grant))
      }
    }
    return ids
  }

  async #ingestEpoch(signed: SignedEpochManifest, historical: boolean, recordId: string): Promise<void> {
    if (!equalBytes(signed.manifest.groupId, this.#snapshot.groupId) ||
        !await verifyEpochManifest(signed, this.#snapshot.rootAdminPublicKey)) throw new Error('GOVERNANCE_EPOCH_INVALID')
    const digest = await hashDomain(DOMAINS.epochManifest, encodeEpochManifest(signed.manifest))
    if (!historical) {
      const expectedEpoch = this.#currentEpoch + 1n
      const expectedPrevious = this.#currentEpoch < 0n ? null : this.#epochDigests.get(this.#currentEpoch) ?? null
      if (signed.manifest.epoch !== expectedEpoch || !nullableBytesEqual(signed.manifest.previousEpochDigest, expectedPrevious)) {
        throw new Error('GOVERNANCE_EPOCH_CHAIN_INVALID')
      }
      this.#currentEpoch = signed.manifest.epoch
      this.#epochManifests.set(signed.manifest.epoch, signed)
      this.#epochDigests.set(signed.manifest.epoch, digest)
    } else if (!this.#epochManifests.has(signed.manifest.epoch)) {
      throw new Error('GOVERNANCE_HISTORICAL_EPOCH_UNKNOWN')
    }
    if (this.#options.recipient !== undefined) {
      try {
        const key = await unwrapEpochKey({
          signedManifest: signed,
          trustedSigner: this.#snapshot.rootAdminPublicKey,
          recipientId: this.#options.recipient.id,
          recipientPrivateKey: this.#options.recipient.privateKey,
        })
        this.#contentKeys.set(signed.manifest.epoch, key.slice())
        this.#cipherRing.install(key, signed.manifest.epoch, !historical)
      } catch {
        // A valid manifest need not include this participant. Revoked and
        // snapshot-scoped readers intentionally retain only prior epochs.
      }
    }
    this.#emit(historical ? 'historical_access_granted' : 'epoch_rotated', recordId, signed.manifest.epoch)
  }

  async #publish(type: GovernanceMessageType, payload: Uint8Array): Promise<void> {
    const envelope = await encodeGovernanceEnvelope(
      this.#options.groupRoute,
      type,
      payload,
      this.#options.identity,
    )
    const record = await this.#options.transport.publish(envelope, { timestampMs: this.#options.now?.() ?? Date.now() })
    await this.ingest(record)
  }

  async #consume(records: AsyncIterable<TransportRecord>): Promise<void> {
    for await (const record of records) {
      if (this.#abort.signal.aborted) return
      await this.ingest(record)
    }
  }

  #rememberSnapshot(snapshot: CapabilitySnapshot): void {
    this.#snapshots.set(bytesToHex(snapshot.revisionDigest), structuredClone(snapshot))
  }

  #assertCapabilityFeedOwner(): void {
    if (this.#options.transport.identity !== feedAuthor(this.#snapshot.capabilityLogFeed)) {
      throw new Error('GOVERNANCE_CAPABILITY_FEED_OWNER_REQUIRED')
    }
  }

  #emit(type: GovernanceEvent['type'], recordId: string, epoch?: bigint): void {
    this.#eventRevision += 1n
    this.#events.emit({
      revision: this.#eventRevision,
      type,
      recordId,
      membershipRevision: this.#snapshot.revisionDigest.slice(),
      ...(epoch === undefined ? {} : { epoch }),
      historyReopened: this.#snapshot.historyReopened,
    })
  }
}

async function encodeGovernanceEnvelope(
  groupRoute: Uint8Array,
  type: GovernanceMessageType,
  payload: Uint8Array,
  signer: Ed25519KeyPair,
): Promise<Uint8Array> {
  const signature = await signDomain(domainFor(type), payload, signer.privateKey)
  const wire = encodeCanonicalCbor([1n, payload, signer.publicKeyBytes, signature])
  return encodeEnvelope({
    groupRoute,
    messageType: type,
    encryptionEpoch: null,
    payloadDigest: await hashDomain(DOMAINS.envelope, wire),
    payload: { type: 'inline', bytes: wire },
  })
}

async function decodeGovernanceEnvelope(
  bytes: Uint8Array,
  groupRoute: Uint8Array,
): Promise<{ readonly type: GovernanceMessageType; readonly payload: Uint8Array }> {
  const envelope = decodeEnvelope(bytes)
  if (!equalBytes(envelope.groupRoute, groupRoute) || envelope.encryptionEpoch !== null || envelope.payload.type !== 'inline' ||
      (envelope.messageType !== 'capability' && envelope.messageType !== 'recovery' && envelope.messageType !== 'epoch-manifest')) {
    throw new Error('GOVERNANCE_ENVELOPE_INVALID')
  }
  if (!equalBytes(await hashDomain(DOMAINS.envelope, envelope.payload.bytes), envelope.payloadDigest)) {
    throw new Error('GOVERNANCE_ENVELOPE_DIGEST_MISMATCH')
  }
  const value = assertCanonicalCbor(envelope.payload.bytes)
  if (!Array.isArray(value) || value.length !== 4 || value[0] !== 1n || !(value[1] instanceof Uint8Array) ||
      !(value[2] instanceof Uint8Array) || !(value[3] instanceof Uint8Array)) throw new Error('GOVERNANCE_ENVELOPE_INVALID')
  const fields = value as readonly CborValue[]
  const payload = fields[1] as Uint8Array
  const signer = fields[2] as Uint8Array
  const signature = fields[3] as Uint8Array
  if (!await verifyDomain(domainFor(envelope.messageType), payload, signature, signer)) throw new Error('GOVERNANCE_ENVELOPE_SIGNATURE_INVALID')
  return { type: envelope.messageType, payload }
}

function domainFor(type: GovernanceMessageType): ProtocolDomain {
  if (type === 'capability') return DOMAINS.capabilityRevision
  if (type === 'recovery') return DOMAINS.recovery
  return DOMAINS.epochManifest
}

function feedAuthor(value: Uint8Array): string { return new TextDecoder().decode(value) }

function nullableBytesEqual(left: Uint8Array | null, right: Uint8Array | null): boolean {
  return left === null ? right === null : right !== null && equalBytes(left, right)
}
