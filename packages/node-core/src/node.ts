import { randomBytes } from 'node:crypto'

import {
  ControlStore,
  type SettlementEvidence,
  type StoredAttestation,
  type StoredCandidate,
  type WatermarkEvidence,
} from '@chronolog/control-store'
import type { Mutation, Query } from '@chronolog/ir'
import type {
  AdmittedTransaction,
  LocalSqlQueryResult,
  LocalSqlValue,
  MaterializedIrQueryResult,
  TransactionOutcome,
} from '@chronolog/materializer-doltlite'
import {
  decodeTransactionCore,
  decodeValidatorAttestation,
  decodeValidatorHeartbeat,
  encodeTransactionCore,
  encodeValidatorAttestation,
  encodeValidatorHeartbeat,
  equalBytes,
  transactionDigest,
  transactionOrderKey,
  utf8,
  type TransactionCore,
  type ValidatorAttestation,
  type ValidatorHeartbeat,
} from '@chronolog/protocol'
import type { TransportRecord } from '@chronolog/transport-ssb'

import { Mutex, RevisionBroadcaster } from './async.js'
import type {
  ChronologNodeOptions,
  NodeRevisionEvent,
  NodeStatus,
  PublishTransactionInput,
  PublishedTransaction,
  ReservedTransactionContext,
} from './types.js'
import { decodeSignedEnvelope, encodeSignedEnvelope } from './wire.js'

export class ChronologNode {
  readonly #options: ChronologNodeOptions
  readonly #control: ControlStore
  readonly #mutex = new Mutex()
  readonly #events = new RevisionBroadcaster<NodeRevisionEvent>()
  readonly #seen = new Set<string>()
  readonly #candidateCores = new Map<string, TransactionCore>()
  readonly #replayedOutcomes = new Set<string>()
  readonly #abort = new AbortController()
  #revision = 0n
  #started = false
  #closed = false
  #consumeTask: Promise<void> | null = null
  #lastError: Error | undefined
  #acceptedAboveMs: bigint
  #heartbeatTimer: ReturnType<typeof setInterval> | undefined
  #materializationDebounceTimer: ReturnType<typeof setTimeout> | undefined
  #materializationRetryTimer: ReturnType<typeof setTimeout> | undefined
  #materializationRetryMs = 100
  #materializationPending = false
  #lastAuthoredTimestampMs = -1n

  constructor(options: ChronologNodeOptions) {
    this.#options = options
    this.#control = options.controlStore ?? new ControlStore()
    this.#revision = this.#control.sequence
    const snapshot = this.#control.snapshot()
    const persistedCutoffs = [
      ...snapshot.heartbeats
        .filter((item) => equalBytes(item.validatorId, options.identity.publicKeyBytes))
        .map((item) => item.acceptanceCutoffMs),
      ...snapshot.attestations
        .filter((item) => equalBytes(item.validatorId, options.identity.publicKeyBytes))
        .map((item) => item.acceptedAboveMs),
    ]
    this.#acceptedAboveMs = persistedCutoffs.reduce(
      (maximum, value) => value > maximum ? value : maximum,
      options.validator?.initialAcceptedAboveMs ?? 0n,
    )
    this.#lastAuthoredTimestampMs = snapshot.candidates
      .filter((candidate) => equalBytes(candidate.orderKey.authorId, options.identity.publicKeyBytes))
      .reduce(
        (maximum, candidate) => candidate.orderKey.authorTimestampMs > maximum
          ? candidate.orderKey.authorTimestampMs
          : maximum,
        -1n,
      )
  }

  get identity(): Uint8Array { return this.#options.identity.publicKeyBytes.slice() }
  get groupId(): Uint8Array { return this.#options.groupId.slice() }
  get membershipRevision(): Uint8Array { return this.#options.membershipRevision.slice() }
  get validationPolicy(): Uint8Array { return this.#options.validationPolicy.slice() }
  get schemaDigest(): Uint8Array { return this.#options.materializer.schemaDigest }
  get executionManifestDigest(): Uint8Array { return this.#options.materializer.executionManifestDigest }
  get controlStore(): ControlStore { return this.#control }
  get revision(): bigint { return this.#revision }
  get materializedRevision(): bigint { return this.#options.materializer.revision }
  get orderLength(): number { return this.#options.materializer.orderLength }

  reserveTransactionContext(): ReservedTransactionContext {
    this.#assertReady()
    return this.#allocateTransactionContext()
  }

  async start(): Promise<void> {
    if (this.#closed) throw new Error('NODE_CLOSED')
    if (this.#started) return
    this.#started = true
    const subscription = this.#options.transport.subscribe(this.#abort.signal)
    this.#consumeTask = this.#consume(subscription)
    await this.#drainHistory()
    // The control store is authoritative and is committed before the derived
    // DoltLite revision. A crash between those two writes can therefore leave
    // an admissible order ahead of the materializer. Reconcile even when replay
    // did not cause a new admission transition: restored candidates are already
    // marked admissible, so their normal ingest path intentionally does nothing.
    await this.#mutex.run(async () => {
      this.#materializationPending = true
      try {
        await this.#reconcileMaterializer()
      } catch (error) {
        this.#recordError(error)
        this.#scheduleMaterializationRetry()
      }
    })
    if (this.#options.validator?.heartbeatIntervalMs) {
      const interval = this.#options.validator.heartbeatIntervalMs
      this.#heartbeatTimer = setInterval(() => { void this.publishHeartbeat().catch((error) => this.#recordError(error)) }, interval)
      this.#heartbeatTimer.unref?.()
    }
  }

  async publish(input: PublishTransactionInput): Promise<PublishedTransaction> {
    this.#assertReady()
    const membershipRevision = input.membershipRevision ?? this.#options.membershipRevision
    const validationPolicy = input.validationPolicy ?? this.#options.validationPolicy
    const allocated = input.authorTimestampMs === undefined && input.nonce === undefined
      ? this.#allocateTransactionContext()
      : {
          authorTimestampMs: input.authorTimestampMs ?? this.#nextAuthorTimestamp(),
          nonce: input.nonce?.slice() ?? this.#randomBytes(32),
        }
    const authorTimestampMs = allocated.authorTimestampMs
    if (authorTimestampMs < 0n || authorTimestampMs > 0x7fff_ffff_ffff_ffffn) {
      throw new Error('AUTHOR_TIMESTAMP_OUT_OF_RANGE')
    }
    if (allocated.nonce.length < 16) throw new Error('TRANSACTION_NONCE_TOO_SHORT')
    if (authorTimestampMs > this.#lastAuthoredTimestampMs) this.#lastAuthoredTimestampMs = authorTimestampMs
    const core: TransactionCore = {
      groupId: this.#options.groupId,
      membershipRevision,
      validationPolicy,
      authorId: this.identity,
      authorTimestampMs,
      nonce: allocated.nonce,
      executionManifestDigest: this.executionManifestDigest,
      schemaDigest: this.schemaDigest,
      program: input.program,
      ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
    }
    const canWrite = await this.#options.membership.canWrite({
      groupId: core.groupId,
      membershipRevision: core.membershipRevision,
      validationPolicy: core.validationPolicy,
      writerId: core.authorId,
    })
    if (!canWrite) throw new Error('WRITER_UNAUTHORIZED')
    const canonical = encodeTransactionCore(core)
    const candidateDigest = await transactionDigest(canonical)
    const envelope = await encodeSignedEnvelope(this.#groupRoute(), 'candidate', canonical, this.#options.identity, this.#options.envelopeCipher)
    const record = await this.#options.transport.publish(envelope, { timestampMs: Number(authorTimestampMs) })
    await this.ingest(record)
    return { txId: utf8(record.id), txIdText: record.id, candidateDigest, core }
  }

  async publishHeartbeat(): Promise<void> {
    this.#assertReady()
    const validator = this.#options.validator
    if (!validator) throw new Error('NODE_NOT_VALIDATOR')
    const now = this.#clockNow()
    this.#advanceValidatorCutoff(now)
    const heartbeat: ValidatorHeartbeat = {
      groupId: this.#options.groupId,
      membershipRevision: this.#options.membershipRevision,
      validatorCapability: validator.capabilityId,
      validatorId: this.identity,
      acceptanceCutoffMs: this.#acceptedAboveMs,
    }
    const payload = encodeValidatorHeartbeat(heartbeat)
    const envelope = await encodeSignedEnvelope(this.#groupRoute(), 'heartbeat', payload, this.#options.identity, this.#options.envelopeCipher)
    const record = await this.#options.transport.publish(envelope, { timestampMs: now })
    await this.ingest(record)
  }

  async ingest(record: TransportRecord): Promise<void> {
    await this.#mutex.run(async () => {
      if (this.#seen.has(record.id)) return
      try {
        const wire = await decodeSignedEnvelope(record.payload, this.#groupRoute(), this.#options.envelopeCipher)
        if (wire.type === 'candidate') await this.#ingestCandidate(record, wire.payload, wire.signer)
        else if (wire.type === 'attestation') await this.#ingestAttestation(record, wire.payload, wire.signer)
        else await this.#ingestHeartbeat(record, wire.payload, wire.signer)
        this.#seen.add(record.id)
      } catch (error) {
        this.#seen.add(record.id)
        this.#recordError(error)
        this.#scheduleMaterializationRetry()
      }
    })
  }

  queryIr(
    query: Query,
    options?: Parameters<ChronologNodeOptions['materializer']['queryIr']>[1],
  ): Promise<MaterializedIrQueryResult> {
    return this.#materializerQueryIr(query, options)
  }

  localSql(
    sql: string,
    parameters: readonly LocalSqlValue[] = [],
    options?: Parameters<ChronologNodeOptions['materializer']['localSql']>[2],
  ): LocalSqlQueryResult {
    return this.#materializerLocalSql(sql, parameters, options)
  }

  validateQuery(query: Query): ReturnType<ChronologNodeOptions['materializer']['validateQuery']> {
    return this.#options.materializer.validateQuery(query)
  }

  validateMutation(mutation: Mutation): ReturnType<ChronologNodeOptions['materializer']['validateMutation']> {
    return this.#options.materializer.validateMutation(mutation)
  }

  outcome(txId: Uint8Array): TransactionOutcome | null {
    return this.#options.materializer.outcome(txId)
  }

  outcomeChangedByReplay(txId: Uint8Array): boolean {
    return this.#replayedOutcomes.has(this.#idKey(txId))
  }

  candidate(txId: Uint8Array): StoredCandidate | null {
    return this.#control.getCandidate(txId)
  }

  candidateCore(txId: Uint8Array): TransactionCore | null {
    return this.#candidateCores.get(this.#idKey(txId)) ?? null
  }

  async settlementEvidence(txId: Uint8Array): Promise<SettlementEvidence | null> {
    const core = this.candidateCore(txId)
    if (!core) return null
    const policy = await this.#options.membership.watermarkPolicy?.(core)
    if (!policy) return null
    return this.#control.settlementEvidence(txId, policy)
  }

  async watermark(txId?: Uint8Array): Promise<WatermarkEvidence | null> {
    const candidate = txId === undefined
      ? this.#control.orderedCandidates().at(-1)
      : this.#control.getCandidate(txId)
    if (!candidate) return null
    const core = this.candidateCore(candidate.txId)
    if (!core) return null
    const policy = await this.#options.membership.watermarkPolicy?.(core)
    return policy ? this.#control.watermark(policy) : null
  }

  events(afterRevision = 0n, signal?: AbortSignal): AsyncIterable<NodeRevisionEvent> {
    const source = this.#events.subscribe(signal === undefined ? {} : { signal })
    return {
      async *[Symbol.asyncIterator]() {
        for await (const event of source) {
          if (event.revision > afterRevision) yield event
        }
      },
    }
  }

  async status(): Promise<NodeStatus> {
    const status: NodeStatus = {
      started: this.#started,
      closed: this.#closed,
      eventSetRevision: this.#revision,
      candidates: this.#control.listCandidates().length,
      admitted: this.#control.orderedTransactionIds().length,
      processedTransportRecords: this.#seen.size,
      materializationPending: this.#materializationPending,
      materializedRevision: this.#options.materializer.revision,
      orderLength: this.#options.materializer.orderLength,
      schemaDigest: this.schemaDigest,
      executionManifestDigest: this.executionManifestDigest,
      validating: this.#options.validator !== undefined,
      transport: await this.#options.transport.status(),
      ...(this.#lastError === undefined ? {} : { lastError: this.#lastError.message }),
    }
    return status
  }

  async isWritable(): Promise<boolean> {
    return this.#options.membership.canWrite({
      groupId: this.#options.groupId,
      membershipRevision: this.#options.membershipRevision,
      validationPolicy: this.#options.validationPolicy,
      writerId: this.identity,
    })
  }

  async waitForIdle(): Promise<void> {
    await this.#mutex.run(async () => {
      if (this.#materializationPending) await this.#reconcileMaterializer()
    })
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    this.#abort.abort()
    if (this.#heartbeatTimer) clearInterval(this.#heartbeatTimer)
    if (this.#materializationDebounceTimer) clearTimeout(this.#materializationDebounceTimer)
    if (this.#materializationRetryTimer) clearTimeout(this.#materializationRetryTimer)
    await this.#consumeTask?.catch(() => {})
    await this.#mutex.run(async () => {
      if (!this.#materializationPending) return
      try { await this.#reconcileMaterializer() } catch (error) { this.#recordError(error) }
    })
    this.#control.flush()
    this.#events.close()
    this.#options.materializer.close()
    await this.#options.transport.close()
  }

  async #drainHistory(): Promise<void> {
    for (const record of await this.#options.transport.history()) await this.ingest(record)
  }

  async #consume(records: AsyncIterable<TransportRecord>): Promise<void> {
    try {
      for await (const record of records) await this.ingest(record)
    } catch (error) {
      if (!this.#abort.signal.aborted) this.#recordError(error)
    }
  }

  async #ingestCandidate(record: TransportRecord, canonical: Uint8Array, signer: Uint8Array): Promise<void> {
    const core = decodeTransactionCore(canonical)
    if (!equalBytes(core.groupId, this.#options.groupId)) throw new Error('CANDIDATE_WRONG_GROUP')
    if (!equalBytes(core.authorId, signer)) throw new Error('CANDIDATE_SIGNER_MISMATCH')
    if (!equalBytes(core.schemaDigest, this.schemaDigest)) throw new Error('CANDIDATE_SCHEMA_DIGEST_MISMATCH')
    if (!equalBytes(core.executionManifestDigest, this.executionManifestDigest)) {
      throw new Error('CANDIDATE_EXECUTION_MANIFEST_DIGEST_MISMATCH')
    }
    const writerContext = {
      groupId: core.groupId,
      membershipRevision: core.membershipRevision,
      validationPolicy: core.validationPolicy,
      writerId: core.authorId,
    }
    const candidateDigest = await transactionDigest(canonical)
    const txId = utf8(record.id)
    const canWrite = await this.#options.membership.canWrite(writerContext)
    const state = canWrite ? 'pending_validation' as const : 'unauthorized' as const
    const candidate: StoredCandidate = {
      txId,
      groupId: core.groupId,
      candidateDigest,
      validationPolicy: core.validationPolicy,
      orderKey: transactionOrderKey(core, { authorFeedSequence: record.sequence, txId }),
      canonicalPayload: canonical,
      state,
      ...(canWrite ? {} : { stateReason: 'WRITER_UNAUTHORIZED' }),
      proofAttestationIds: [],
    }
    const inserted = this.#control.putCandidate(candidate)
    this.#candidateCores.set(this.#idKey(txId), core)
    if (inserted.added) this.#emit('candidate', txId)
    if (canWrite) {
      await this.#evaluateAdmission(txId, core)
      await this.#maybeAttest(txId, candidate, core)
    }
  }

  async #maybeAttest(txId: Uint8Array, candidate: StoredCandidate, core: TransactionCore): Promise<void> {
    const validator = this.#options.validator
    if (!validator) return
    const now = this.#clockNow()
    this.#advanceValidatorCutoff(now)
    const futureLimit = BigInt(Math.trunc(now + (validator.maxFutureSkewMs ?? 30_000)))
    if (core.authorTimestampMs > futureLimit || core.authorTimestampMs <= this.#acceptedAboveMs) return
    const context = {
      groupId: core.groupId,
      membershipRevision: core.membershipRevision,
      validationPolicy: core.validationPolicy,
      writerId: core.authorId,
      validatorId: this.identity,
      validatorCapability: validator.capabilityId,
    }
    if (!await this.#options.membership.canValidate(context)) return
    if (this.#control.attestationsFor(txId).some((item) => equalBytes(item.validatorId, this.identity))) return
    const attestation: ValidatorAttestation = {
      groupId: core.groupId,
      membershipRevision: core.membershipRevision,
      validatorCapability: validator.capabilityId,
      txId,
      validatorId: this.identity,
      authorTimestampMs: core.authorTimestampMs,
      acceptedAboveMs: this.#acceptedAboveMs,
      candidateDigest: candidate.candidateDigest,
      decision: 'admit',
      policyVersion: validator.policyVersion ?? 1n,
    }
    const payload = encodeValidatorAttestation(attestation)
    const envelope = await encodeSignedEnvelope(this.#groupRoute(), 'attestation', payload, this.#options.identity, this.#options.envelopeCipher)
    // Publishing before returning is the validator durability rule. The newly
    // appended record is handled by the normal subscription path.
    await this.#options.transport.publish(envelope, { timestampMs: now })
  }

  async #ingestAttestation(record: TransportRecord, encoded: Uint8Array, signer: Uint8Array): Promise<void> {
    const value = decodeValidatorAttestation(encoded)
    if (!equalBytes(value.groupId, this.#options.groupId)) throw new Error('ATTESTATION_WRONG_GROUP')
    if (!equalBytes(value.validatorId, signer)) throw new Error('ATTESTATION_SIGNER_MISMATCH')
    const core = this.#candidateCores.get(this.#idKey(value.txId))
    const candidate = this.#control.getCandidate(value.txId)
    if (candidate && !equalBytes(candidate.candidateDigest, value.candidateDigest)) throw new Error('ATTESTATION_DIGEST_MISMATCH')
    if (core && (
      !equalBytes(core.membershipRevision, value.membershipRevision) ||
      core.authorTimestampMs !== value.authorTimestampMs
    )) throw new Error('ATTESTATION_CANDIDATE_MISMATCH')
    if (core && !await this.#options.membership.canValidate({
      groupId: core.groupId,
      membershipRevision: value.membershipRevision,
      validationPolicy: core.validationPolicy,
      writerId: core.authorId,
      validatorId: value.validatorId,
      validatorCapability: value.validatorCapability,
    })) throw new Error('VALIDATOR_UNAUTHORIZED')
    const stored: StoredAttestation = {
      attestationId: utf8(record.id),
      txId: value.txId,
      validatorId: value.validatorId,
      validatorCapability: value.validatorCapability,
      membershipRevision: value.membershipRevision,
      candidateDigest: value.candidateDigest,
      validatorFeedSequence: record.sequence,
      authorTimestampMs: value.authorTimestampMs,
      acceptedAboveMs: value.acceptedAboveMs,
    }
    const inserted = this.#control.putAttestation(stored)
    if (inserted.added) this.#emit('attestation', value.txId)
    if (core) await this.#evaluateAdmission(value.txId, core)
  }

  async #evaluateAdmission(txId: Uint8Array, core: TransactionCore): Promise<void> {
    const candidate = this.#control.getCandidate(txId)
    if (!candidate || candidate.state !== 'pending_validation') return
    const context = {
      groupId: core.groupId,
      membershipRevision: core.membershipRevision,
      validationPolicy: core.validationPolicy,
      writerId: core.authorId,
    }
    const threshold = await this.#options.membership.threshold(context)
    if (!Number.isSafeInteger(threshold) || threshold < 1) throw new Error('INVALID_VALIDATION_THRESHOLD')
    const customSelection = await this.#options.membership.selectAdmission?.(
      context,
      this.#control.attestationsFor(txId),
    )
    if (customSelection !== undefined) {
      if (customSelection.length === 0) return
      const available = new Set(this.#control.attestationsFor(txId).map((item) => this.#idKey(item.attestationId)))
      if (customSelection.some((item) => !available.has(this.#idKey(item.attestationId)))) {
        throw new Error('MEMBERSHIP_RESOLVER_RETURNED_UNKNOWN_ATTESTATION')
      }
      this.#control.setCandidateState(txId, 'admissible', {
        proofAttestationIds: customSelection.map((item) => item.attestationId),
      })
      this.#materializationPending = true
      this.#scheduleMaterialization()
      return
    }
    const eligible: StoredAttestation[] = []
    const validators = new Set<string>()
    for (const attestation of this.#control.attestationsFor(txId)) {
      const key = this.#idKey(attestation.validatorId)
      if (validators.has(key)) continue
      const accepted = await this.#options.membership.canValidate({
        ...context,
        validatorId: attestation.validatorId,
        validatorCapability: attestation.validatorCapability,
      })
      if (accepted && equalBytes(attestation.candidateDigest, candidate.candidateDigest)) {
        validators.add(key)
        eligible.push(attestation)
      }
    }
    if (eligible.length < threshold) return
    this.#control.setCandidateState(txId, 'admissible', {
      proofAttestationIds: eligible.slice(0, threshold).map((item) => item.attestationId),
    })
    this.#materializationPending = true
    this.#scheduleMaterialization()
  }

  async #ingestHeartbeat(record: TransportRecord, encoded: Uint8Array, signer: Uint8Array): Promise<void> {
    const heartbeat = decodeValidatorHeartbeat(encoded)
    if (!equalBytes(heartbeat.groupId, this.#options.groupId)) throw new Error('HEARTBEAT_WRONG_GROUP')
    if (!equalBytes(heartbeat.validatorId, signer)) throw new Error('HEARTBEAT_SIGNER_MISMATCH')
    if (equalBytes(heartbeat.validatorId, this.identity) && heartbeat.acceptanceCutoffMs > this.#acceptedAboveMs) {
      this.#acceptedAboveMs = heartbeat.acceptanceCutoffMs
    }
    const recorded = this.#control.recordHeartbeat({
      heartbeatId: utf8(record.id),
      validatorId: heartbeat.validatorId,
      validatorCapability: heartbeat.validatorCapability,
      membershipRevision: heartbeat.membershipRevision,
      validatorFeedSequence: record.sequence,
      acceptanceCutoffMs: heartbeat.acceptanceCutoffMs,
      feedContiguous: true,
    })
    if (recorded !== null) this.#emit('heartbeat')
  }

  async #reconcileMaterializer(): Promise<void> {
    if (!this.#materializationPending) return
    const ordered: AdmittedTransaction[] = this.#control.orderedCandidates().map((candidate) => {
      const core = this.#candidateCores.get(this.#idKey(candidate.txId))
      if (!core || !candidate.canonicalPayload) throw new Error('ADMITTED_CANDIDATE_PAYLOAD_MISSING')
      return {
        txId: candidate.txId,
        authorFeedSequence: candidate.orderKey.authorFeedSequence,
        candidateDigest: candidate.candidateDigest,
        canonicalCandidate: candidate.canonicalPayload,
        core,
      }
    })
    const revision = await this.#options.materializer.materialize(ordered)
    this.#materializationPending = false
    this.#materializationRetryMs = 100
    if (this.#materializationDebounceTimer) {
      clearTimeout(this.#materializationDebounceTimer)
      this.#materializationDebounceTimer = undefined
    }
    if (this.#materializationRetryTimer) {
      clearTimeout(this.#materializationRetryTimer)
      this.#materializationRetryTimer = undefined
    }
    if (revision !== null) {
      for (const change of revision.outcomeChanges) {
        if (change.previous !== null && change.previous !== change.current) {
          this.#replayedOutcomes.add(this.#idKey(change.txId))
        }
      }
      this.#emit('materialized')
    }
  }

  #scheduleMaterialization(): void {
    if (this.#closed || !this.#materializationPending) return
    if (this.#materializationDebounceTimer) clearTimeout(this.#materializationDebounceTimer)
    this.#materializationDebounceTimer = setTimeout(() => {
      this.#materializationDebounceTimer = undefined
      void this.#mutex.run(async () => {
        if (this.#closed || !this.#materializationPending) return
        try {
          await this.#reconcileMaterializer()
        } catch (error) {
          this.#recordError(error)
          this.#scheduleMaterializationRetry()
        }
      })
    }, 25)
    this.#materializationDebounceTimer.unref?.()
  }

  #scheduleMaterializationRetry(): void {
    if (this.#closed || !this.#materializationPending || this.#materializationRetryTimer) return
    const delay = this.#materializationRetryMs
    this.#materializationRetryMs = Math.min(this.#materializationRetryMs * 2, 5_000)
    this.#materializationRetryTimer = setTimeout(() => {
      this.#materializationRetryTimer = undefined
      void this.#mutex.run(async () => {
        if (this.#closed || !this.#materializationPending) return
        try {
          await this.#reconcileMaterializer()
        } catch (error) {
          this.#recordError(error)
          this.#scheduleMaterializationRetry()
        }
      })
    }, delay)
    this.#materializationRetryTimer.unref?.()
  }

  #emit(reason: NodeRevisionEvent['reason'], txId?: Uint8Array, error?: Error): void {
    this.#revision = this.#revision + 1n > this.#control.sequence
      ? this.#revision + 1n
      : this.#control.sequence
    this.#events.emit({
      revision: this.#revision,
      reason,
      ...(txId === undefined ? {} : { txId: txId.slice() }),
      ...(error === undefined ? {} : { error }),
    })
  }

  #recordError(value: unknown): void {
    const error = value instanceof Error ? value : new Error(String(value))
    this.#lastError = error
    this.#emit('error', undefined, error)
  }

  #clockNow(): number { return this.#options.clock?.now() ?? Date.now() }
  #nextAuthorTimestamp(): bigint {
    const wallClock = BigInt(Math.max(0, Math.trunc(this.#clockNow())))
    return wallClock > this.#lastAuthoredTimestampMs ? wallClock : this.#lastAuthoredTimestampMs + 1n
  }
  #allocateTransactionContext(): ReservedTransactionContext {
    const authorTimestampMs = this.#nextAuthorTimestamp()
    this.#lastAuthoredTimestampMs = authorTimestampMs
    return { authorTimestampMs, nonce: this.#randomBytes(32) }
  }
  #advanceValidatorCutoff(now: number): void {
    const validator = this.#options.validator
    if (!validator) return
    const proposed = BigInt(Math.max(0, Math.trunc(now - (validator.cutoffLagMs ?? 60_000))))
    if (proposed > this.#acceptedAboveMs) this.#acceptedAboveMs = proposed
  }
  #randomBytes(length: number): Uint8Array { return this.#options.random?.bytes(length) ?? randomBytes(length) }
  #materializerQueryIr(
    query: Query,
    options?: Parameters<ChronologNodeOptions['materializer']['queryIr']>[1],
  ): Promise<MaterializedIrQueryResult> {
    return this.#options.materializer.queryIr(query, options)
  }
  #materializerLocalSql(
    sql: string,
    parameters: readonly LocalSqlValue[],
    options?: Parameters<ChronologNodeOptions['materializer']['localSql']>[2],
  ): LocalSqlQueryResult {
    return this.#options.materializer.localSql(sql, parameters, options)
  }
  #groupRoute(): Uint8Array { return this.#options.groupRoute ?? this.#options.groupId }
  #idKey(value: Uint8Array): string { return Buffer.from(value).toString('base64url') }

  #assertReady(): void {
    if (!this.#started) throw new Error('NODE_NOT_STARTED')
    if (this.#closed) throw new Error('NODE_CLOSED')
  }
}
