import { randomBytes } from 'node:crypto'

import {
  ControlStore,
  ControlStoreConflictError,
  type SettlementEvidence,
  type StoredAttestation,
  type StoredCandidate,
  type WatermarkEvidence,
} from '@chronolog/control-store'
import { compileSqlProgram } from '@chronolog/compiler-sqlite'
import type {
  AdmittedTransaction,
  MaterializedLocalSqlResult,
  MaterializedLocalSqlValue,
  MaterializedObservationResult,
  MaterializedTransactionOutcome,
} from '@chronolog/materializer'
import {
  decodeTransactionCore,
  decodeEnvelope,
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
  type SqlTransactionProgram,
  type SqlStatement,
  type SqlResultMode,
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
import { FeedForkRegistry } from './feed-forks.js'

export class ChronologNode {
  readonly #options: ChronologNodeOptions
  readonly #control: ControlStore
  readonly #mutex = new Mutex()
  readonly #events = new RevisionBroadcaster<NodeRevisionEvent>()
  readonly #seen = new Set<string>()
  readonly #retryRecords = new Map<string, TransportRecord>()
  readonly #maximumRetryRecords: number
  readonly #feedForks: FeedForkRegistry
  #retryOverflow = false
  readonly #candidateCores = new Map<string, TransactionCore>()
  readonly #replayedOutcomes = new Set<string>()
  readonly #abort = new AbortController()
  #revision = 0n
  #started = false
  #closed = false
  #consumeTask: Promise<void> | null = null
  #lastError: Error | undefined
  #ingestionError: Error | undefined
  #acceptedAboveMs: bigint
  #heartbeatTimer: ReturnType<typeof setInterval> | undefined
  #materializationDebounceTimer: ReturnType<typeof setTimeout> | undefined
  #materializationRetryTimer: ReturnType<typeof setTimeout> | undefined
  #ingestionRetryTimer: ReturnType<typeof setTimeout> | undefined
  #materializationRetryMs = 100
  #materializationPending = false
  #lastAuthoredTimestampMs = -1n

  constructor(options: ChronologNodeOptions) {
    this.#options = options
    this.#control = options.controlStore ?? new ControlStore()
    this.#maximumRetryRecords = options.maximumRetryRecords ?? 4_096
    this.#feedForks = options.feedForkRegistry ?? new FeedForkRegistry()
    if (!Number.isSafeInteger(this.#maximumRetryRecords) || this.#maximumRetryRecords < 1) {
      throw new RangeError('NODE_INVALID_RETRY_CAPACITY')
    }
    this.#revision = this.#control.sequence
    const snapshot = this.#control.snapshot()
    const persistedCutoffs = [
      ...(this.#control.validatorCutoff(options.identity.publicKeyBytes) === null
        ? []
        : [this.#control.validatorCutoff(options.identity.publicKeyBytes)!]),
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
  get membershipRevision(): Uint8Array { return this.#membershipState().membershipRevision.slice() }
  get validationPolicy(): Uint8Array { return this.#membershipState().validationPolicy.slice() }
  get executionManifestDigest(): Uint8Array {
    return this.#options.materialization.queries.executionManifestDigest
  }
  get controlStore(): ControlStore { return this.#control }
  get revision(): bigint { return this.#revision }
  get materializedRevision(): bigint { return this.#options.materialization.queries.revision }
  get orderLength(): number { return this.#options.materialization.queries.orderLength }

  reserveTransactionContext(): ReservedTransactionContext {
    this.#assertReady()
    return this.#allocateTransactionContext()
  }

  async start(): Promise<void> {
    if (this.#closed) throw new Error('NODE_CLOSED')
    if (this.#started) return
    const history = await this.#options.transport.history()
    await this.#recoverValidatorCutoff(history)
    this.#started = true
    const subscription = this.#options.transport.subscribe(this.#abort.signal)
    this.#consumeTask = this.#consume(subscription)
    await this.#drainHistory(history)
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
    compileSqlProgram(input.program)
    const membershipRevision = input.membershipRevision ?? this.membershipRevision
    const validationPolicy = input.validationPolicy ?? this.validationPolicy
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
    if (!await this.#membershipAllowsTransportAuthor(
      this.#options.transport.identity,
      'writer',
      core.authorId,
      core.membershipRevision,
    )) throw new Error('LOCAL_TRANSPORT_AUTHOR_UNAUTHORIZED')
    const canonical = encodeTransactionCore(core)
    const candidateDigest = await transactionDigest(canonical)
    const envelope = await encodeSignedEnvelope(this.#groupRoute(), 'candidate', canonical, this.#options.identity, this.#options.envelopeCipher, this.#options.blobPayloads)
    const record = await this.#options.transport.publish(envelope, { timestampMs: Number(authorTimestampMs) })
    await this.ingest(record)
    return { txId: utf8(record.id), txIdText: record.id, candidateDigest, core }
  }

  validateProgram(program: SqlTransactionProgram): void {
    compileSqlProgram(program)
  }

  async publishHeartbeat(): Promise<void> {
    this.#assertReady()
    const validator = this.#options.validator
    if (!validator) throw new Error('NODE_NOT_VALIDATOR')
    const validatorCapability = this.#validatorCapability()
    if (validatorCapability === undefined) throw new Error('NODE_VALIDATOR_CAPABILITY_UNAVAILABLE')
    if (!await this.#heartbeatAuthorized({
      groupId: this.#options.groupId,
      membershipRevision: this.membershipRevision,
      validatorId: this.identity,
      validatorCapability,
    })) throw new Error('VALIDATOR_UNAUTHORIZED')
    if (!await this.#membershipAllowsTransportAuthor(
      this.#options.transport.identity,
      'validator',
      this.identity,
      this.membershipRevision,
      validatorCapability,
    )) throw new Error('LOCAL_TRANSPORT_AUTHOR_UNAUTHORIZED')
    const now = this.#clockNow()
    this.#advanceValidatorCutoff(now)
    this.#persistValidatorCutoff()
    const heartbeat: ValidatorHeartbeat = {
      groupId: this.#options.groupId,
      membershipRevision: this.membershipRevision,
      validatorCapability,
      validatorId: this.identity,
      acceptanceCutoffMs: this.#acceptedAboveMs,
    }
    const payload = encodeValidatorHeartbeat(heartbeat)
    const envelope = await encodeSignedEnvelope(this.#groupRoute(), 'heartbeat', payload, this.#options.identity, this.#options.envelopeCipher, this.#options.blobPayloads)
    const record = await this.#options.transport.publish(envelope, { timestampMs: now })
    await this.ingest(record)
  }

  async ingest(record: TransportRecord): Promise<void> {
    await this.#mutex.run(async () => {
      if (this.#seen.has(record.id)) return
      try {
        const continuity = this.#feedForks.observe(record)
        if (continuity === 'discarded') {
          this.#seen.add(record.id)
          return
        }
        if (continuity === 'quarantined') {
          const error = new Error(`FEED_FORK_QUARANTINED:${record.author}`)
          this.#seen.add(record.id)
          this.#recordError(error)
          return
        }
        const envelope = decodeEnvelope(record.payload)
        if (envelope.messageType !== 'candidate' && envelope.messageType !== 'attestation' && envelope.messageType !== 'heartbeat') {
          this.#seen.add(record.id)
          return
        }
        const wire = await this.#decodeRecord(record)
        if (wire.type === 'candidate') await this.#ingestCandidate(record, wire.payload, wire.signer)
        else if (wire.type === 'attestation') await this.#ingestAttestation(record, wire.payload, wire.signer)
        else await this.#ingestHeartbeat(record, wire.payload, wire.signer)
        this.#seen.add(record.id)
        this.#retryRecords.delete(record.id)
        if (this.#retryRecords.size === 0 && !this.#retryOverflow) this.#ingestionError = undefined
      } catch (error) {
        if (error instanceof TerminalIngestError || error instanceof ControlStoreConflictError) {
          this.#seen.add(record.id)
          this.#retryRecords.delete(record.id)
          if (error instanceof ControlStoreConflictError) this.#recordError(error)
          else this.#emit('error', undefined, error)
        } else {
          if (this.#retryRecords.has(record.id) || this.#retryRecords.size < this.#maximumRetryRecords) {
            this.#retryRecords.set(record.id, structuredClone(record))
          } else {
            // Keep memory bounded. Once capacity becomes available, the
            // authoritative transport history supplies records that could not
            // be retained in this process-local retry set.
            this.#retryOverflow = true
          }
          this.#scheduleIngestionRetry()
          this.#recordIngestionError(error)
        }
      }
    })
  }

  observe(
    statement: SqlStatement,
    options: { readonly atRevision?: bigint; readonly resultMode: SqlResultMode },
  ): Promise<MaterializedObservationResult> {
    return this.#options.materialization.queries.observe(statement, options)
  }

  localSql(
    sql: string,
    parameters: readonly MaterializedLocalSqlValue[] = [],
    options?: Parameters<ChronologNodeOptions['materialization']['queries']['localSql']>[2],
  ): MaterializedLocalSqlResult {
    return this.#materializerLocalSql(sql, parameters, options)
  }

  validateStatement(statement: SqlStatement, mode: 'precondition' | 'body') {
    return this.#options.materialization.queries.validateStatement(statement, mode)
  }

  outcome(txId: Uint8Array): MaterializedTransactionOutcome | null {
    return this.#options.materialization.queries.outcome(txId)
  }

  transactionResult(txId: Uint8Array) {
    return this.#options.materialization.queries.transactionResult(txId)
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
    return this.#control.settlementEvidence(txId, policy, core.membershipRevision)
  }

  async watermark(txId?: Uint8Array): Promise<WatermarkEvidence | null> {
    const candidate = txId === undefined
      ? this.#control.orderedCandidates().at(-1)
      : this.#control.getCandidate(txId)
    if (!candidate) return null
    const core = this.candidateCore(candidate.txId)
    if (!core) return null
    const policy = await this.#options.membership.watermarkPolicy?.(core)
    return policy ? this.#control.watermark(policy, core.membershipRevision) : null
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
    const error = this.#lastError ?? this.#ingestionError
    const status: NodeStatus = {
      started: this.#started,
      closed: this.#closed,
      eventSetRevision: this.#revision,
      candidates: this.#control.listCandidates().length,
      admitted: this.#control.orderedTransactionIds().length,
      processedTransportRecords: this.#seen.size,
      materializationPending: this.#materializationPending,
      materializedRevision: this.#options.materialization.queries.revision,
      orderLength: this.#options.materialization.queries.orderLength,
      executionManifestDigest: this.executionManifestDigest,
      validating: this.#options.validator !== undefined,
      transport: await this.#options.transport.status(),
      quarantinedFeeds: this.#feedForks.quarantineEvidence().map((item) => item.feedId),
      ...(error === undefined ? {} : { lastError: error.message }),
    }
    return status
  }

  async isWritable(): Promise<boolean> {
    if (this.#feedForks.quarantined()) return false
    return this.#options.membership.canWrite({
      groupId: this.#options.groupId,
      membershipRevision: this.membershipRevision,
      validationPolicy: this.validationPolicy,
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
    if (this.#ingestionRetryTimer) clearTimeout(this.#ingestionRetryTimer)
    await this.#consumeTask?.catch(() => {})
    await this.#mutex.run(async () => {
      if (!this.#materializationPending) return
      try { await this.#reconcileMaterializer() } catch (error) { this.#recordError(error) }
    })
    this.#control.flush()
    this.#events.close()
    await this.#options.materialization.close()
    await this.#options.transport.close()
  }

  async #drainHistory(history: readonly TransportRecord[]): Promise<void> {
    for (const record of history) await this.ingest(record)
  }

  async #consume(records: AsyncIterable<TransportRecord>): Promise<void> {
    try {
      for await (const record of records) await this.ingest(record)
    } catch (error) {
      if (!this.#abort.signal.aborted) this.#recordError(error)
    }
  }

  async #ingestCandidate(record: TransportRecord, canonical: Uint8Array, signer: Uint8Array): Promise<void> {
    const core = this.#decodeCandidate(canonical)
    if (!equalBytes(core.groupId, this.#options.groupId)) invalid('CANDIDATE_WRONG_GROUP')
    if (!equalBytes(core.authorId, signer)) invalid('CANDIDATE_SIGNER_MISMATCH')
    if (!await this.#canUseTransportAuthor(record, 'writer', signer, core.membershipRevision)) {
      invalid('CANDIDATE_TRANSPORT_AUTHOR_UNAUTHORIZED')
    }
    if (!equalBytes(core.executionManifestDigest, this.executionManifestDigest)) {
      invalid('CANDIDATE_EXECUTION_MANIFEST_DIGEST_MISMATCH')
    }
    try { compileSqlProgram(core.program) } catch { invalid('CANDIDATE_SQL_INVALID') }
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
    const validatorCapability = this.#validatorCapability()
    if (validatorCapability === undefined) return
    const now = this.#clockNow()
    this.#advanceValidatorCutoff(now)
    this.#persistValidatorCutoff()
    const futureLimit = BigInt(Math.trunc(now + (validator.maxFutureSkewMs ?? 30_000)))
    if (core.authorTimestampMs > futureLimit || core.authorTimestampMs <= this.#acceptedAboveMs) return
    const context = {
      groupId: core.groupId,
      membershipRevision: core.membershipRevision,
      validationPolicy: core.validationPolicy,
      writerId: core.authorId,
      validatorId: this.identity,
      validatorCapability,
    }
    if (!await this.#options.membership.canValidate(context)) return
    if (!await this.#membershipAllowsTransportAuthor(
      this.#options.transport.identity,
      'validator',
      this.identity,
      core.membershipRevision,
      validatorCapability,
    )) throw new Error('LOCAL_TRANSPORT_AUTHOR_UNAUTHORIZED')
    if (this.#control.attestationsFor(txId).some((item) => equalBytes(item.validatorId, this.identity))) return
    const policyVersion = await this.#expectedPolicyVersion(core)
    if (policyVersion < 0n) return
    const configuredPolicyVersion = validator.policyVersion ?? policyVersion
    if (configuredPolicyVersion !== policyVersion) throw new Error('VALIDATOR_POLICY_VERSION_MISMATCH')
    const attestation: ValidatorAttestation = {
      groupId: core.groupId,
      membershipRevision: core.membershipRevision,
      validatorCapability,
      txId,
      validatorId: this.identity,
      authorTimestampMs: core.authorTimestampMs,
      acceptedAboveMs: this.#acceptedAboveMs,
      candidateDigest: candidate.candidateDigest,
      decision: 'admit',
      policyVersion,
    }
    const payload = encodeValidatorAttestation(attestation)
    const envelope = await encodeSignedEnvelope(this.#groupRoute(), 'attestation', payload, this.#options.identity, this.#options.envelopeCipher, this.#options.blobPayloads)
    // Publishing before returning is the validator durability rule. The newly
    // appended record is handled by the normal subscription path.
    await this.#options.transport.publish(envelope, { timestampMs: now })
  }

  async #ingestAttestation(record: TransportRecord, encoded: Uint8Array, signer: Uint8Array): Promise<void> {
    const value = this.#decodeAttestation(encoded)
    if (!equalBytes(value.groupId, this.#options.groupId)) invalid('ATTESTATION_WRONG_GROUP')
    if (!equalBytes(value.validatorId, signer)) invalid('ATTESTATION_SIGNER_MISMATCH')
    if (!await this.#canUseTransportAuthor(
      record,
      'validator',
      signer,
      value.membershipRevision,
      value.validatorCapability,
    )) invalid('ATTESTATION_TRANSPORT_AUTHOR_UNAUTHORIZED')
    if (
      equalBytes(value.validatorId, this.identity) &&
      record.author === this.#options.transport.identity &&
      value.acceptedAboveMs > this.#acceptedAboveMs
    ) {
      this.#acceptedAboveMs = value.acceptedAboveMs
      this.#persistValidatorCutoff()
    }
    const core = this.#candidateCores.get(this.#idKey(value.txId))
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
      policyVersion: value.policyVersion,
      transportAuthor: record.author,
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
    const eligible: StoredAttestation[] = []
    const validators = new Set<string>()
    for (const attestation of this.#control.attestationsFor(txId)) {
      const key = this.#idKey(attestation.validatorId)
      if (validators.has(key) || !await this.#isValidAdmissionProof(candidate, core, attestation)) continue
      validators.add(key)
      eligible.push(attestation)
    }
    const customSelection = await this.#options.membership.selectAdmission?.(
      context,
      eligible,
    )
    if (customSelection !== undefined) {
      if (customSelection.length === 0) return
      const available = new Set(eligible.map((item) => this.#idKey(item.attestationId)))
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
    if (eligible.length < threshold) return
    this.#control.setCandidateState(txId, 'admissible', {
      proofAttestationIds: eligible.slice(0, threshold).map((item) => item.attestationId),
    })
    this.#materializationPending = true
    this.#scheduleMaterialization()
  }

  async #ingestHeartbeat(record: TransportRecord, encoded: Uint8Array, signer: Uint8Array): Promise<void> {
    const heartbeat = this.#decodeHeartbeat(encoded)
    if (!equalBytes(heartbeat.groupId, this.#options.groupId)) invalid('HEARTBEAT_WRONG_GROUP')
    if (!equalBytes(heartbeat.validatorId, signer)) invalid('HEARTBEAT_SIGNER_MISMATCH')
    if (!await this.#canUseTransportAuthor(
      record,
      'validator',
      signer,
      heartbeat.membershipRevision,
      heartbeat.validatorCapability,
    )) invalid('HEARTBEAT_TRANSPORT_AUTHOR_UNAUTHORIZED')
    const heartbeatAuthorized = await this.#heartbeatAuthorized({
      groupId: heartbeat.groupId,
      membershipRevision: heartbeat.membershipRevision,
      validatorId: heartbeat.validatorId,
      validatorCapability: heartbeat.validatorCapability,
    })
    if (!heartbeatAuthorized) invalid('HEARTBEAT_VALIDATOR_UNAUTHORIZED')
    if (equalBytes(heartbeat.validatorId, this.identity) && heartbeat.acceptanceCutoffMs > this.#acceptedAboveMs) {
      this.#acceptedAboveMs = heartbeat.acceptanceCutoffMs
      this.#persistValidatorCutoff()
    }
    const recorded = this.#control.recordHeartbeat({
      heartbeatId: utf8(record.id),
      validatorId: heartbeat.validatorId,
      validatorCapability: heartbeat.validatorCapability,
      membershipRevision: heartbeat.membershipRevision,
      validatorFeedSequence: record.sequence,
      acceptanceCutoffMs: heartbeat.acceptanceCutoffMs,
      feedContiguous: await this.#isFeedContiguous(record),
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
    const coordinated = await this.#options.materialization.coordinator.materialize(ordered)
    if (coordinated !== null) {
      const published = await this.#options.materialization.publications.publish(
        coordinated.publication,
      )
      if (
        published.revision !== coordinated.revision.revision ||
        published.orderLength !== coordinated.revision.orderLength ||
        !equalBytes(published.executionManifestDigest, coordinated.revision.manifestDigest)
      ) {
        throw new Error('MATERIALIZATION_PUBLICATION_RESULT_MISMATCH')
      }
    }
    const reconciled = await this.#options.materialization.publications.reconcile({
      targetOrderLength: ordered.length,
      ...(coordinated === null ? {} : { targetRevision: coordinated.revision.revision }),
    })
    const queries = this.#options.materialization.queries
    if (
      reconciled.revision !== queries.revision ||
      reconciled.orderLength !== ordered.length ||
      reconciled.orderLength !== queries.orderLength ||
      !equalBytes(reconciled.executionManifestDigest, queries.executionManifestDigest)
    ) {
      throw new Error('MATERIALIZATION_RECONCILIATION_RESULT_MISMATCH')
    }
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
    if (coordinated !== null) {
      for (const change of coordinated.revision.outcomeChanges) {
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

  #scheduleIngestionRetry(): void {
    if (this.#closed || (this.#retryRecords.size === 0 && !this.#retryOverflow) || this.#ingestionRetryTimer) return
    this.#ingestionRetryTimer = setTimeout(() => {
      this.#ingestionRetryTimer = undefined
      const records = [...this.#retryRecords.values()].map((record) => structuredClone(record))
      void (async () => {
        for (const record of records) {
          if (this.#closed) return
          await this.ingest(record)
        }
        if (this.#retryOverflow && this.#retryRecords.size < this.#maximumRetryRecords) {
          this.#retryOverflow = false
          let history: readonly TransportRecord[]
          try {
            history = await this.#options.transport.history()
          } catch (error) {
            this.#retryOverflow = true
            throw error
          }
          for (const record of history) {
            if (this.#closed) return
            if (this.#seen.has(record.id) || this.#retryRecords.has(record.id)) continue
            if (this.#retryRecords.size >= this.#maximumRetryRecords) {
              this.#retryOverflow = true
              break
            }
            await this.ingest(record)
          }
        }
      })().catch((error) => this.#recordError(error)).finally(() => this.#scheduleIngestionRetry())
    }, 100)
    this.#ingestionRetryTimer.unref?.()
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

  #recordIngestionError(value: unknown): void {
    const error = value instanceof Error ? value : new Error(String(value))
    this.#ingestionError = error
    this.#emit('error', undefined, error)
  }

  #clockNow(): number { return this.#options.clock?.now() ?? Date.now() }
  async #decodeRecord(record: TransportRecord): Promise<Awaited<ReturnType<typeof decodeSignedEnvelope>>> {
    try {
      return await decodeSignedEnvelope(record.payload, this.#groupRoute(), this.#options.envelopeCipher, this.#options.blobPayloads?.store)
    } catch (error) {
      throw new TerminalIngestError('INVALID_SIGNED_ENVELOPE', { cause: error })
    }
  }
  #decodeCandidate(encoded: Uint8Array): TransactionCore {
    try {
      return decodeTransactionCore(encoded)
    } catch (error) {
      throw new TerminalIngestError('INVALID_CANDIDATE_PAYLOAD', { cause: error })
    }
  }
  #decodeAttestation(encoded: Uint8Array): ValidatorAttestation {
    try {
      return decodeValidatorAttestation(encoded)
    } catch (error) {
      throw new TerminalIngestError('INVALID_ATTESTATION_PAYLOAD', { cause: error })
    }
  }
  #decodeHeartbeat(encoded: Uint8Array): ValidatorHeartbeat {
    try {
      return decodeValidatorHeartbeat(encoded)
    } catch (error) {
      throw new TerminalIngestError('INVALID_HEARTBEAT_PAYLOAD', { cause: error })
    }
  }
  async #recoverValidatorCutoff(history: readonly TransportRecord[]): Promise<void> {
    if (!this.#options.validator) return
    let recovered = this.#acceptedAboveMs
    for (const record of history) {
      if (record.author !== this.#options.transport.identity) continue
      try {
        const wire = await decodeSignedEnvelope(record.payload, this.#groupRoute(), this.#options.envelopeCipher, this.#options.blobPayloads?.store)
        if (!equalBytes(wire.signer, this.identity)) continue
        if (wire.type === 'attestation') {
          const attestation = decodeValidatorAttestation(wire.payload)
          if (
            equalBytes(attestation.groupId, this.#options.groupId) &&
            equalBytes(attestation.validatorId, this.identity) &&
            attestation.acceptedAboveMs > recovered
          ) recovered = attestation.acceptedAboveMs
        } else if (wire.type === 'heartbeat') {
          const heartbeat = decodeValidatorHeartbeat(wire.payload)
          if (
            equalBytes(heartbeat.groupId, this.#options.groupId) &&
            equalBytes(heartbeat.validatorId, this.identity) &&
            heartbeat.acceptanceCutoffMs > recovered
          ) recovered = heartbeat.acceptanceCutoffMs
        }
      } catch {
        // Invalid application records are handled by normal ingestion. Cutoff
        // preflight uses only fully verified records from our own outer feed.
      }
    }
    this.#acceptedAboveMs = recovered
    this.#persistValidatorCutoff()
  }
  #persistValidatorCutoff(): void {
    if (!this.#options.validator) return
    this.#control.persistValidatorCutoff(this.identity, this.#acceptedAboveMs)
  }
  async #expectedPolicyVersion(core: TransactionCore): Promise<bigint> {
    return this.#options.membership.policyVersion?.({
      groupId: core.groupId,
      membershipRevision: core.membershipRevision,
      validationPolicy: core.validationPolicy,
      writerId: core.authorId,
    }) ?? 1n
  }
  async #canUseTransportAuthor(
    record: TransportRecord,
    role: 'writer' | 'validator',
    signingId: Uint8Array,
    membershipRevision: Uint8Array,
    validatorCapability?: Uint8Array,
  ): Promise<boolean> {
    return this.#membershipAllowsTransportAuthor(
      record.author,
      role,
      signingId,
      membershipRevision,
      validatorCapability,
    )
  }
  async #membershipAllowsTransportAuthor(
    transportAuthor: string,
    role: 'writer' | 'validator',
    signingId: Uint8Array,
    membershipRevision: Uint8Array,
    validatorCapability?: Uint8Array,
  ): Promise<boolean> {
    if (this.#options.membership.canUseTransportAuthor === undefined) {
      return transportAuthor === this.#options.transport.identity && equalBytes(signingId, this.identity)
    }
    return this.#options.membership.canUseTransportAuthor({
      groupId: this.#options.groupId,
      membershipRevision,
      role,
      signingId,
      transportAuthor,
      ...(validatorCapability === undefined ? {} : { validatorCapability }),
    })
  }
  #membershipState() {
    return this.#options.membershipState?.() ?? {
      membershipRevision: this.#options.membershipRevision,
      validationPolicy: this.#options.validationPolicy,
      ...(this.#options.validator === undefined ? {} : { validatorCapability: this.#options.validator.capabilityId }),
    }
  }
  #validatorCapability(): Uint8Array | undefined {
    return this.#membershipState().validatorCapability
  }
  async #heartbeatAuthorized(context: {
    readonly groupId: Uint8Array
    readonly membershipRevision: Uint8Array
    readonly validatorId: Uint8Array
    readonly validatorCapability: Uint8Array
  }): Promise<boolean> {
    if (this.#options.membership.canHeartbeat !== undefined) {
      return this.#options.membership.canHeartbeat(context)
    }
    if (!equalBytes(context.membershipRevision, this.membershipRevision)) return false
    return this.#options.membership.canValidate({
      ...context,
      validationPolicy: this.validationPolicy,
      writerId: context.validatorId,
    })
  }
  async #isValidAdmissionProof(
    candidate: StoredCandidate,
    core: TransactionCore,
    attestation: StoredAttestation,
  ): Promise<boolean> {
    if (
      !equalBytes(attestation.txId, candidate.txId) ||
      !equalBytes(attestation.candidateDigest, candidate.candidateDigest) ||
      !equalBytes(attestation.membershipRevision, core.membershipRevision) ||
      attestation.authorTimestampMs !== core.authorTimestampMs ||
      attestation.authorTimestampMs <= attestation.acceptedAboveMs ||
      attestation.policyVersion !== await this.#expectedPolicyVersion(core) ||
      typeof attestation.transportAuthor !== 'string'
    ) return false
    const transportAuthorized = await this.#options.membership.canUseTransportAuthor?.({
      groupId: core.groupId,
      membershipRevision: core.membershipRevision,
      role: 'validator',
      signingId: attestation.validatorId,
      transportAuthor: attestation.transportAuthor,
      validatorCapability: attestation.validatorCapability,
    }) ?? (
      attestation.transportAuthor === this.#options.transport.identity &&
      equalBytes(attestation.validatorId, this.identity)
    )
    if (!transportAuthorized) return false
    return this.#options.membership.canValidate({
      groupId: core.groupId,
      membershipRevision: core.membershipRevision,
      validationPolicy: core.validationPolicy,
      writerId: core.authorId,
      validatorId: attestation.validatorId,
      validatorCapability: attestation.validatorCapability,
    })
  }
  async #isFeedContiguous(record: TransportRecord): Promise<boolean> {
    const status = await this.#options.transport.status()
    const feed = status.feedStates?.find((candidate) => candidate.feedId === record.author)
    if (feed === undefined || !/^(0|[1-9][0-9]*)$/.test(feed.contiguousThrough)) return false
    return BigInt(feed.contiguousThrough) >= record.sequence
  }
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
  #materializerLocalSql(
    sql: string,
    parameters: readonly MaterializedLocalSqlValue[],
    options?: Parameters<ChronologNodeOptions['materialization']['queries']['localSql']>[2],
  ): MaterializedLocalSqlResult {
    return this.#options.materialization.queries.localSql(sql, parameters, options)
  }
  #groupRoute(): Uint8Array { return this.#options.groupRoute ?? this.#options.groupId }
  #idKey(value: Uint8Array): string { return Buffer.from(value).toString('base64url') }

  #assertReady(): void {
    if (!this.#started) throw new Error('NODE_NOT_STARTED')
    if (this.#closed) throw new Error('NODE_CLOSED')
    if (this.#feedForks.quarantined()) throw new Error('NODE_FEED_FORK_QUARANTINED')
  }
}

class TerminalIngestError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'TerminalIngestError'
  }
}

function invalid(code: string): never {
  throw new TerminalIngestError(code)
}
