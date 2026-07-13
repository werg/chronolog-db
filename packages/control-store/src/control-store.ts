import { compareTransactionOrder } from '@chronolog/protocol'

import type {
  AdmissionEvaluation,
  AdmissionEvaluator,
  CandidateState,
  ControlStoreDelta,
  ControlStorePersistence,
  ControlStoreSnapshot,
  HistoryReopening,
  MaterializedHead,
  PutCandidateInput,
  SettlementEvidence,
  StoredAttestation,
  StoredCandidate,
  StoredCheckpoint,
  ValidatorHeartbeat,
  WatermarkEvidence,
  WatermarkPolicy,
} from './types.js'

const TERMINAL_INVALID_STATES = new Set<CandidateState>([
  'invalid_protocol',
  'unauthorized',
  'quarantined',
])

type WithoutSequence<T> = T extends unknown ? Omit<T, 'sequence'> : never

export class ControlStoreConflictError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'ControlStoreConflictError'
  }
}

export class ControlStore {
  readonly #persistence: ControlStorePersistence | null
  #sequence = 0n
  readonly #candidates = new Map<string, StoredCandidate>()
  readonly #attestations = new Map<string, StoredAttestation>()
  readonly #attestationsByTx = new Map<string, Set<string>>()
  readonly #heartbeats = new Map<string, ValidatorHeartbeat>()
  readonly #orderedTxIds: Uint8Array[] = []
  readonly #deltas: ControlStoreDelta[] = []
  readonly #checkpoints = new Map<number, StoredCheckpoint>()
  readonly #historyReopenings = new Map<string, HistoryReopening>()
  #materializedHead: MaterializedHead | null = null

  constructor(persistence: ControlStorePersistence | null = null) {
    this.#persistence = persistence
    const snapshot = persistence?.load()
    if (snapshot !== null && snapshot !== undefined) this.#restore(snapshot)
  }

  get sequence(): bigint {
    return this.#sequence
  }

  putCandidate(input: PutCandidateInput): { added: boolean; deltas: readonly ControlStoreDelta[] } {
    const txKey = idKey(input.txId)
    const existing = this.#candidates.get(txKey)
    const candidate = cloneCandidate({
      ...input,
      proofAttestationIds: input.proofAttestationIds ?? [],
    })

    if (existing !== undefined) {
      if (!sameCandidateIdentity(existing, candidate)) {
        throw new ControlStoreConflictError('CONTROL_STORE_CANDIDATE_CONFLICT')
      }
      return { added: false, deltas: [] }
    }

    this.#candidates.set(txKey, candidate)
    const deltas: ControlStoreDelta[] = [
      this.#appendDelta({ kind: 'candidate_added', txId: candidate.txId, state: candidate.state }),
    ]
    if (candidate.state === 'admissible') deltas.push(this.#insertOrder(candidate))
    this.#persist()
    return { added: true, deltas: clone(deltas) }
  }

  getCandidate(txId: Uint8Array): StoredCandidate | null {
    const candidate = this.#candidates.get(idKey(txId))
    return candidate === undefined ? null : cloneCandidate(candidate)
  }

  listCandidates(): readonly StoredCandidate[] {
    return [...this.#candidates.values()].map(cloneCandidate)
  }

  putAttestation(attestation: StoredAttestation): {
    added: boolean
    delta: ControlStoreDelta | null
  } {
    const key = idKey(attestation.attestationId)
    const stored = cloneAttestation(attestation)
    const existing = this.#attestations.get(key)
    if (existing !== undefined) {
      if (!sameValue(existing, stored)) {
        throw new ControlStoreConflictError('CONTROL_STORE_ATTESTATION_CONFLICT')
      }
      return { added: false, delta: null }
    }

    this.#attestations.set(key, stored)
    const txKey = idKey(stored.txId)
    let refs = this.#attestationsByTx.get(txKey)
    if (refs === undefined) {
      refs = new Set()
      this.#attestationsByTx.set(txKey, refs)
    }
    refs.add(key)
    const delta = this.#appendDelta({
      kind: 'attestation_added',
      attestationId: stored.attestationId,
      txId: stored.txId,
      unresolvedCandidate: !this.#candidates.has(txKey),
    })
    this.#persist()
    return { added: true, delta: clone(delta) }
  }

  attestationsFor(txId: Uint8Array): readonly StoredAttestation[] {
    const refs = this.#attestationsByTx.get(idKey(txId))
    if (refs === undefined) return []
    return [...refs]
      .map((ref) => this.#attestations.get(ref))
      .filter((value): value is StoredAttestation => value !== undefined)
      .map(cloneAttestation)
  }

  evaluateAdmission(txId: Uint8Array, evaluator: AdmissionEvaluator): AdmissionEvaluation {
    const candidate = this.#requiredCandidate(txId)
    if (candidate.state === 'admissible') {
      return {
        state: 'admissible',
        proofAttestationIds: candidate.proofAttestationIds.map(copyBytes),
      }
    }
    if (TERMINAL_INVALID_STATES.has(candidate.state) || candidate.state === 'waiting_for_payload') {
      throw new ControlStoreConflictError('CONTROL_STORE_CANDIDATE_NOT_ADMISSION_ELIGIBLE')
    }

    const evaluation = evaluator(cloneCandidate(candidate), this.attestationsFor(txId))
    this.setCandidateState(txId, evaluation.state, {
      ...(evaluation.proofAttestationIds === undefined
        ? {}
        : { proofAttestationIds: evaluation.proofAttestationIds }),
      ...(evaluation.reason === undefined ? {} : { reason: evaluation.reason }),
    })
    return clone(evaluation)
  }

  setCandidateState(
    txId: Uint8Array,
    state: CandidateState,
    options: { readonly proofAttestationIds?: readonly Uint8Array[]; readonly reason?: string } = {},
  ): readonly ControlStoreDelta[] {
    const key = idKey(txId)
    const candidate = this.#requiredCandidate(txId)
    validateStateTransition(candidate.state, state)
    const proofAttestationIds = options.proofAttestationIds ?? candidate.proofAttestationIds
    for (const attestationId of proofAttestationIds) {
      const attestation = this.#attestations.get(idKey(attestationId))
      if (attestation === undefined || idKey(attestation.txId) !== key) {
        throw new ControlStoreConflictError('CONTROL_STORE_INVALID_ADMISSION_PROOF')
      }
    }

    if (
      candidate.state === state &&
      sameBytesList(candidate.proofAttestationIds, proofAttestationIds) &&
      candidate.stateReason === options.reason
    ) {
      return []
    }

    const next: StoredCandidate = cloneCandidate({
      ...candidate,
      state,
      ...(options.reason === undefined ? {} : { stateReason: options.reason }),
      proofAttestationIds,
    })
    this.#candidates.set(key, next)
    const deltas: ControlStoreDelta[] = [
      this.#appendDelta({
        kind: 'candidate_state_changed',
        txId: next.txId,
        previousState: candidate.state,
        state,
        ...(options.reason === undefined ? {} : { reason: options.reason }),
      }),
    ]
    if (candidate.state !== 'admissible' && state === 'admissible') {
      deltas.push(this.#insertOrder(next))
    }
    this.#persist()
    return clone(deltas)
  }

  orderedCandidates(): readonly StoredCandidate[] {
    return this.#orderedTxIds.map((txId) => cloneCandidate(this.#requiredCandidate(txId)))
  }

  orderedTransactionIds(): readonly Uint8Array[] {
    return this.#orderedTxIds.map(copyBytes)
  }

  earliestOrderDifference(previous: readonly Uint8Array[]): number | null {
    const common = Math.min(previous.length, this.#orderedTxIds.length)
    for (let index = 0; index < common; index += 1) {
      if (!bytesEqual(previous[index]!, this.#orderedTxIds[index]!)) return index
    }
    return previous.length === this.#orderedTxIds.length ? null : common
  }

  recordHeartbeat(heartbeat: ValidatorHeartbeat): ControlStoreDelta | null {
    const validatorKey = idKey(heartbeat.validatorId)
    const next = cloneHeartbeat(heartbeat)
    const previous = this.#heartbeats.get(validatorKey)
    if (previous !== undefined) {
      if (heartbeat.validatorFeedSequence < previous.validatorFeedSequence) {
        throw new ControlStoreConflictError('CONTROL_STORE_HEARTBEAT_SEQUENCE_REGRESSION')
      }
      if (heartbeat.acceptanceCutoffMs < previous.acceptanceCutoffMs) {
        throw new ControlStoreConflictError('CONTROL_STORE_HEARTBEAT_CUTOFF_REGRESSION')
      }
      if (heartbeat.validatorFeedSequence === previous.validatorFeedSequence) {
        if (!sameValue(previous, next)) {
          throw new ControlStoreConflictError('CONTROL_STORE_HEARTBEAT_CONFLICT')
        }
        return null
      }
    }

    this.#heartbeats.set(validatorKey, next)
    const delta = this.#appendDelta({
      kind: 'heartbeat_advanced',
      heartbeatId: next.heartbeatId,
      validatorId: next.validatorId,
      cutoffMs: next.acceptanceCutoffMs,
      feedContiguous: next.feedContiguous,
    })
    this.#persist()
    return clone(delta)
  }

  watermark(policy: WatermarkPolicy): WatermarkEvidence {
    if (policy.kind === 'threshold') return this.#thresholdWatermark(policy)
    const proofs = policy.minimalProofs
    if (proofs.length === 0 || proofs.some((proof) => proof.length === 0)) {
      return {
        policyId: policy.policyId,
        cutoffMs: null,
        blockingValidatorIds: [],
        heartbeatIds: [],
        explanation: 'invalid_policy',
      }
    }

    let cutoff: bigint | null = null
    const selected = new Map<string, ValidatorHeartbeat>()
    for (const proof of proofs) {
      let best: ValidatorHeartbeat | null = null
      for (const validatorId of proof) {
        const heartbeat = this.#heartbeats.get(idKey(validatorId))
        if (
          heartbeat?.feedContiguous === true &&
          (best === null || heartbeat.acceptanceCutoffMs > best.acceptanceCutoffMs)
        ) {
          best = heartbeat
        }
      }
      if (best === null) {
        return {
          policyId: policy.policyId,
          cutoffMs: null,
          blockingValidatorIds: [],
          heartbeatIds: [],
          explanation: 'insufficient_contiguous_heartbeats',
        }
      }
      if (cutoff === null || best.acceptanceCutoffMs < cutoff) cutoff = best.acceptanceCutoffMs
      selected.set(idKey(best.validatorId), best)
    }

    const atCutoff = [...selected.values()].filter(
      (heartbeat) => heartbeat.acceptanceCutoffMs >= cutoff!,
    )
    return {
      policyId: policy.policyId,
      cutoffMs: cutoff,
      blockingValidatorIds: atCutoff.map((heartbeat) => copyBytes(heartbeat.validatorId)),
      heartbeatIds: atCutoff.map((heartbeat) => copyBytes(heartbeat.heartbeatId)),
      explanation: 'established',
    }
  }

  #thresholdWatermark(
    policy: Extract<WatermarkPolicy, { kind: 'threshold' }>,
  ): WatermarkEvidence {
    if (
      !Number.isSafeInteger(policy.threshold) ||
      policy.threshold < 1 ||
      policy.threshold > policy.validatorIds.length ||
      new Set(policy.validatorIds.map(idKey)).size !== policy.validatorIds.length
    ) {
      return {
        policyId: policy.policyId,
        cutoffMs: null,
        blockingValidatorIds: [],
        heartbeatIds: [],
        explanation: 'invalid_policy',
      }
    }

    const heartbeats = policy.validatorIds.map((validatorId) => {
      const heartbeat = this.#heartbeats.get(idKey(validatorId))
      return heartbeat?.feedContiguous === true ? heartbeat : null
    })
    const available = heartbeats
      .filter((heartbeat): heartbeat is ValidatorHeartbeat => heartbeat !== null)
      .sort((left, right) =>
        left.acceptanceCutoffMs === right.acceptanceCutoffMs
          ? 0
          : left.acceptanceCutoffMs < right.acceptanceCutoffMs
            ? -1
            : 1,
      )
    // For a k-of-n policy, every possible proof intersects any n-k+1
    // validators. The maximum safe cutoff is the kth-lowest validator cutoff;
    // missing/non-contiguous feeds behave as negative infinity.
    const missing = heartbeats.length - available.length
    const selectedIndex = policy.threshold - 1 - missing
    if (selectedIndex < 0 || selectedIndex >= available.length) {
      return {
        policyId: policy.policyId,
        cutoffMs: null,
        blockingValidatorIds: [],
        heartbeatIds: [],
        explanation: 'insufficient_contiguous_heartbeats',
      }
    }
    const cutoffMs = available[selectedIndex]!.acceptanceCutoffMs
    const blocking = available.filter((heartbeat) => heartbeat.acceptanceCutoffMs >= cutoffMs)
    return {
      policyId: policy.policyId,
      cutoffMs,
      blockingValidatorIds: blocking.map((heartbeat) => copyBytes(heartbeat.validatorId)),
      heartbeatIds: blocking.map((heartbeat) => copyBytes(heartbeat.heartbeatId)),
      explanation: 'established',
    }
  }

  settlementEvidence(txId: Uint8Array, policy: WatermarkPolicy): SettlementEvidence {
    const candidate = this.#requiredCandidate(txId)
    const watermark = this.watermark(policy)
    const unresolved = this.#unresolvedAttestations()
    const historyReopenings = [...this.#historyReopenings.values()]
      .filter((event) => event.floorMs <= candidate.orderKey.authorTimestampMs)
      .map((event) => event.id)
      .sort()
    return {
      txId: copyBytes(txId),
      candidateState: candidate.state,
      orderKey: clone(candidate.orderKey),
      proofAttestationIds: candidate.proofAttestationIds.map(copyBytes),
      watermark,
      belowWatermark:
        watermark.cutoffMs !== null && candidate.orderKey.authorTimestampMs <= watermark.cutoffMs,
      unresolvedAttestationIds: unresolved.map((attestation) => copyBytes(attestation.attestationId)),
      historyReopeningIds: historyReopenings,
    }
  }

  publishMaterializedHead(head: MaterializedHead): ControlStoreDelta | null {
    if (this.#materializedHead !== null) {
      if (head.localRevision < this.#materializedHead.localRevision) {
        throw new ControlStoreConflictError('CONTROL_STORE_HEAD_REVISION_REGRESSION')
      }
      if (head.localRevision === this.#materializedHead.localRevision) {
        if (!sameValue(head, this.#materializedHead)) {
          throw new ControlStoreConflictError('CONTROL_STORE_HEAD_REVISION_CONFLICT')
        }
        return null
      }
    }
    if (head.orderLength > this.#orderedTxIds.length) {
      throw new ControlStoreConflictError('CONTROL_STORE_HEAD_AHEAD_OF_ORDER')
    }
    this.#materializedHead = clone(head)
    const delta = this.#appendDelta({ kind: 'materialized_head_published', head })
    this.#persist()
    return clone(delta)
  }

  materializedHead(): MaterializedHead | null {
    return this.#materializedHead === null ? null : clone(this.#materializedHead)
  }

  putCheckpoint(checkpoint: StoredCheckpoint): ControlStoreDelta | null {
    if (checkpoint.prefixLength < 0 || checkpoint.prefixLength > this.#orderedTxIds.length) {
      throw new ControlStoreConflictError('CONTROL_STORE_INVALID_CHECKPOINT_PREFIX')
    }
    const previous = this.#checkpoints.get(checkpoint.prefixLength)
    if (previous !== undefined && sameValue(previous, checkpoint)) return null
    if (previous?.pinned === true && checkpoint.pinned === false) {
      throw new ControlStoreConflictError('CONTROL_STORE_PINNED_CHECKPOINT_REPLACEMENT')
    }
    this.#checkpoints.set(checkpoint.prefixLength, clone(checkpoint))
    const delta = this.#appendDelta({ kind: 'checkpoint_stored', checkpoint })
    this.#persist()
    return clone(delta)
  }

  nearestCheckpointBefore(orderIndex: number): StoredCheckpoint | null {
    let nearest: StoredCheckpoint | null = null
    for (const checkpoint of this.#checkpoints.values()) {
      if (
        checkpoint.prefixLength <= orderIndex &&
        (nearest === null || checkpoint.prefixLength > nearest.prefixLength)
      ) {
        nearest = checkpoint
      }
    }
    return nearest === null ? null : clone(nearest)
  }

  recordHistoryReopening(reopening: HistoryReopening): ControlStoreDelta | null {
    const previous = this.#historyReopenings.get(reopening.id)
    if (previous !== undefined) {
      if (!sameValue(previous, reopening)) {
        throw new ControlStoreConflictError('CONTROL_STORE_REOPENING_CONFLICT')
      }
      return null
    }
    this.#historyReopenings.set(reopening.id, clone(reopening))
    const delta = this.#appendDelta({ kind: 'history_reopened', reopening })
    this.#persist()
    return clone(delta)
  }

  changesSince(sequence: bigint): readonly ControlStoreDelta[] {
    return this.#deltas.filter((delta) => delta.sequence > sequence).map(clone)
  }

  snapshot(): ControlStoreSnapshot {
    return {
      format: 'chronolog-control-store/v1',
      sequence: this.#sequence,
      candidates: this.listCandidates(),
      attestations: [...this.#attestations.values()].map(cloneAttestation),
      heartbeats: [...this.#heartbeats.values()].map(cloneHeartbeat),
      orderedTxIds: this.orderedTransactionIds(),
      deltas: this.#deltas.map(clone),
      materializedHead: this.materializedHead(),
      checkpoints: [...this.#checkpoints.values()].map(clone),
      historyReopenings: [...this.#historyReopenings.values()].map(clone),
    }
  }

  #requiredCandidate(txId: Uint8Array): StoredCandidate {
    const candidate = this.#candidates.get(idKey(txId))
    if (candidate === undefined) throw new ControlStoreConflictError('CONTROL_STORE_UNKNOWN_CANDIDATE')
    return candidate
  }

  #insertOrder(candidate: StoredCandidate): ControlStoreDelta {
    let low = 0
    let high = this.#orderedTxIds.length
    while (low < high) {
      const middle = (low + high) >>> 1
      const middleCandidate = this.#requiredCandidate(this.#orderedTxIds[middle]!)
      if (compareTransactionOrder(middleCandidate.orderKey, candidate.orderKey) < 0) low = middle + 1
      else high = middle
    }
    if (
      low < this.#orderedTxIds.length &&
      bytesEqual(this.#orderedTxIds[low]!, candidate.txId)
    ) {
      throw new ControlStoreConflictError('CONTROL_STORE_DUPLICATE_ORDER_ENTRY')
    }
    const previousLength = this.#orderedTxIds.length
    this.#orderedTxIds.splice(low, 0, copyBytes(candidate.txId))
    return this.#appendDelta({
      kind: low === previousLength ? 'order_append' : 'order_insert',
      txId: candidate.txId,
      index: low,
      previousLength,
    })
  }

  #appendDelta(delta: WithoutSequence<ControlStoreDelta>): ControlStoreDelta {
    this.#sequence += 1n
    const sequenced = clone({ ...delta, sequence: this.#sequence } as ControlStoreDelta)
    this.#deltas.push(sequenced)
    return sequenced
  }

  #unresolvedAttestations(): StoredAttestation[] {
    return [...this.#attestations.values()].filter(
      (attestation) => !this.#candidates.has(idKey(attestation.txId)),
    )
  }

  #persist(): void {
    this.#persistence?.save(this.snapshot())
  }

  #restore(snapshot: ControlStoreSnapshot): void {
    this.#sequence = snapshot.sequence
    for (const candidate of snapshot.candidates) {
      this.#candidates.set(idKey(candidate.txId), cloneCandidate(candidate))
    }
    for (const attestation of snapshot.attestations) {
      const cloned = cloneAttestation(attestation)
      const key = idKey(cloned.attestationId)
      this.#attestations.set(key, cloned)
      const txKey = idKey(cloned.txId)
      const refs = this.#attestationsByTx.get(txKey) ?? new Set<string>()
      refs.add(key)
      this.#attestationsByTx.set(txKey, refs)
    }
    for (const heartbeat of snapshot.heartbeats) {
      this.#heartbeats.set(idKey(heartbeat.validatorId), cloneHeartbeat(heartbeat))
    }
    this.#orderedTxIds.push(...snapshot.orderedTxIds.map(copyBytes))
    this.#deltas.push(...snapshot.deltas.map(clone))
    this.#materializedHead = snapshot.materializedHead === null ? null : clone(snapshot.materializedHead)
    for (const checkpoint of snapshot.checkpoints) {
      this.#checkpoints.set(checkpoint.prefixLength, clone(checkpoint))
    }
    for (const reopening of snapshot.historyReopenings) {
      this.#historyReopenings.set(reopening.id, clone(reopening))
    }
    this.#verifyRestoredOrder()
  }

  #verifyRestoredOrder(): void {
    if (this.#deltas.length > 0 && this.#deltas.at(-1)?.sequence !== this.#sequence) {
      throw new ControlStoreConflictError('CONTROL_STORE_CORRUPT_DELTA_SEQUENCE')
    }
    for (let index = 1; index < this.#deltas.length; index += 1) {
      if (this.#deltas[index]!.sequence <= this.#deltas[index - 1]!.sequence) {
        throw new ControlStoreConflictError('CONTROL_STORE_CORRUPT_DELTA_SEQUENCE')
      }
    }
    let previous: StoredCandidate | null = null
    const seen = new Set<string>()
    for (const txId of this.#orderedTxIds) {
      const candidate = this.#requiredCandidate(txId)
      if (candidate.state !== 'admissible') {
        throw new ControlStoreConflictError('CONTROL_STORE_CORRUPT_ORDER_STATE')
      }
      const key = idKey(txId)
      if (seen.has(key)) throw new ControlStoreConflictError('CONTROL_STORE_CORRUPT_DUPLICATE_ORDER')
      seen.add(key)
      if (previous !== null && compareTransactionOrder(previous.orderKey, candidate.orderKey) >= 0) {
        throw new ControlStoreConflictError('CONTROL_STORE_CORRUPT_ORDER')
      }
      previous = candidate
    }
  }
}

function validateStateTransition(previous: CandidateState, next: CandidateState): void {
  if (previous === next) return
  if (previous === 'admissible') {
    throw new ControlStoreConflictError('CONTROL_STORE_ADMISSION_NOT_MONOTONIC')
  }
  if (TERMINAL_INVALID_STATES.has(previous)) {
    throw new ControlStoreConflictError('CONTROL_STORE_TERMINAL_STATE')
  }
  if (
    previous === 'waiting_for_payload' &&
    next !== 'pending_validation' &&
    !TERMINAL_INVALID_STATES.has(next)
  ) {
    throw new ControlStoreConflictError('CONTROL_STORE_PAYLOAD_NOT_VERIFIED')
  }
  if (next === 'waiting_for_payload') {
    throw new ControlStoreConflictError('CONTROL_STORE_PAYLOAD_STATE_REGRESSION')
  }
}

function idKey(value: Uint8Array): string {
  return Buffer.from(value).toString('base64url')
}

function copyBytes(value: Uint8Array): Uint8Array {
  return Uint8Array.from(value)
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false
  return left.every((value, index) => value === right[index])
}

function sameBytesList(left: readonly Uint8Array[], right: readonly Uint8Array[]): boolean {
  return left.length === right.length && left.every((value, index) => bytesEqual(value, right[index]!))
}

function cloneCandidate(candidate: StoredCandidate): StoredCandidate {
  return clone(candidate)
}

function cloneAttestation(attestation: StoredAttestation): StoredAttestation {
  return clone(attestation)
}

function cloneHeartbeat(heartbeat: ValidatorHeartbeat): ValidatorHeartbeat {
  return clone(heartbeat)
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function sameCandidateIdentity(left: StoredCandidate, right: StoredCandidate): boolean {
  return sameValue(
    {
      txId: left.txId,
      groupId: left.groupId,
      candidateDigest: left.candidateDigest,
      validationPolicy: left.validationPolicy,
      orderKey: left.orderKey,
      canonicalPayload: left.canonicalPayload,
    },
    {
      txId: right.txId,
      groupId: right.groupId,
      candidateDigest: right.candidateDigest,
      validationPolicy: right.validationPolicy,
      orderKey: right.orderKey,
      canonicalPayload: right.canonicalPayload,
    },
  )
}

function sameValue(left: unknown, right: unknown): boolean {
  if (typeof left === 'bigint' || typeof right === 'bigint') return left === right
  if (left instanceof Uint8Array && right instanceof Uint8Array) return bytesEqual(left, right)
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => sameValue(value, right[index]))
  }
  if (typeof left === 'object' && left !== null && typeof right === 'object' && right !== null) {
    const leftRecord = left as Record<string, unknown>
    const rightRecord = right as Record<string, unknown>
    const leftKeys = Object.keys(leftRecord).sort()
    const rightKeys = Object.keys(rightRecord).sort()
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every((key, index) => key === rightKeys[index] && sameValue(leftRecord[key], rightRecord[key]))
    )
  }
  return Object.is(left, right)
}
