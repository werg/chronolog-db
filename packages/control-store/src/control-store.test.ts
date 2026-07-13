import { describe, expect, it } from 'vitest'

import { ControlStore, ControlStoreConflictError } from './control-store.js'
import { MemoryControlStorePersistence } from './persistence.js'
import type {
  PutCandidateInput,
  StoredAttestation,
  ValidatorHeartbeat,
} from './types.js'

const bytes = (...values: number[]) => Uint8Array.from(values)

function candidate(id: number, timestamp: bigint, author = id): PutCandidateInput {
  return {
    txId: bytes(id),
    groupId: bytes(1),
    candidateDigest: bytes(100 + id),
    validationPolicy: bytes(8),
    orderKey: {
      authorTimestampMs: timestamp,
      authorId: bytes(author),
      authorFeedSequence: BigInt(id),
      txId: bytes(id),
    },
    canonicalPayload: bytes(200, id),
    state: 'pending_validation',
  }
}

function attestation(id: number, txId: number, validator = id): StoredAttestation {
  return {
    attestationId: bytes(id),
    txId: bytes(txId),
    validatorId: bytes(validator),
    validatorCapability: bytes(validator, 1),
    membershipRevision: bytes(1),
    candidateDigest: bytes(100 + txId),
    validatorFeedSequence: BigInt(id),
    authorTimestampMs: BigInt(txId),
    acceptedAboveMs: 0n,
  }
}

function heartbeat(validator: number, cutoff: bigint, contiguous = true): ValidatorHeartbeat {
  return {
    heartbeatId: bytes(validator, Number(cutoff)),
    validatorId: bytes(validator),
    validatorCapability: bytes(validator, 1),
    membershipRevision: bytes(1),
    validatorFeedSequence: cutoff,
    acceptanceCutoffMs: cutoff,
    feedContiguous: contiguous,
  }
}

describe('ControlStore', () => {
  it('inserts newly admissible candidates at a stable deterministic position', () => {
    const store = new ControlStore()
    store.putCandidate(candidate(2, 20n))
    store.putCandidate(candidate(3, 30n))
    store.setCandidateState(bytes(2), 'admissible')
    store.setCandidateState(bytes(3), 'admissible')

    store.putCandidate(candidate(1, 10n))
    const deltas = store.setCandidateState(bytes(1), 'admissible')

    expect([...store.orderedTransactionIds()].map((id) => id[0])).toEqual([1, 2, 3])
    expect(deltas.at(-1)).toMatchObject({
      kind: 'order_insert',
      index: 0,
      previousLength: 2,
    })
    expect(store.earliestOrderDifference([bytes(2), bytes(3)])).toBe(0)
  })

  it('uses immutable byte tie-breakers and never lets attestations move order', () => {
    const store = new ControlStore()
    const highAuthor = candidate(1, 10n, 2)
    const lowAuthor = candidate(2, 10n, 1)
    store.putCandidate(highAuthor)
    store.setCandidateState(highAuthor.txId, 'admissible')
    store.putCandidate(lowAuthor)
    store.setCandidateState(lowAuthor.txId, 'admissible')
    const before = store.orderedTransactionIds()

    store.putAttestation(attestation(10, 1))
    store.putAttestation(attestation(11, 1))
    expect(store.putCandidate(highAuthor).added).toBe(false)

    expect(store.orderedTransactionIds()).toEqual(before)
    expect([...store.orderedTransactionIds()].map((id) => id[0])).toEqual([2, 1])
    expect(() => store.setCandidateState(bytes(1), 'pending_validation')).toThrowError(
      new ControlStoreConflictError('CONTROL_STORE_ADMISSION_NOT_MONOTONIC'),
    )
  })

  it('assembles admission with a pluggable capability policy evaluator', () => {
    const store = new ControlStore()
    store.putCandidate(candidate(4, 40n))
    store.putAttestation(attestation(20, 4, 1))
    store.putAttestation(attestation(21, 4, 2))

    const result = store.evaluateAdmission(bytes(4), (_candidate, attestations) => ({
      state: attestations.length >= 2 ? 'admissible' : 'pending_validation',
      proofAttestationIds: attestations.map((value) => value.attestationId),
    }))

    expect(result.state).toBe('admissible')
    expect(store.getCandidate(bytes(4))?.proofAttestationIds).toHaveLength(2)
    expect(store.orderedTransactionIds()).toEqual([bytes(4)])
  })

  it('calculates the exact 2-of-3 blocking watermark from contiguous feeds', () => {
    const store = new ControlStore()
    store.putCandidate(candidate(1, 85n))
    store.setCandidateState(bytes(1), 'admissible')
    store.recordHeartbeat(heartbeat(1, 100n))
    store.recordHeartbeat(heartbeat(2, 90n))
    store.recordHeartbeat(heartbeat(3, 80n))
    const policy = {
      kind: 'threshold' as const,
      policyId: 'two-of-three',
      validatorIds: [bytes(1), bytes(2), bytes(3)],
      threshold: 2,
    }

    const watermark = store.watermark(policy)
    expect(watermark.cutoffMs).toBe(90n)
    expect(watermark.explanation).toBe('established')
    expect(store.settlementEvidence(bytes(1), policy).belowWatermark).toBe(true)

    const incomplete = new ControlStore()
    incomplete.recordHeartbeat(heartbeat(1, 100n, false))
    expect(incomplete.watermark(policy).cutoffMs).toBeNull()
  })

  it('surfaces unresolved attestation references and explicit history reopening', () => {
    const store = new ControlStore()
    store.putCandidate(candidate(1, 85n))
    store.setCandidateState(bytes(1), 'admissible')
    store.putAttestation(attestation(99, 9, 1))
    store.recordHistoryReopening({
      id: 'recovery-1',
      floorMs: 80n,
      membershipRevision: bytes(3),
      reason: 'offline recovery',
    })
    store.recordHeartbeat(heartbeat(1, 100n))

    const evidence = store.settlementEvidence(bytes(1), {
      kind: 'threshold',
      policyId: 'one',
      validatorIds: [bytes(1)],
      threshold: 1,
    })
    expect(evidence.unresolvedAttestationIds).toEqual([bytes(99)])
    expect(evidence.historyReopeningIds).toEqual(['recovery-1'])
  })

  it('persists exact bigint/byte state and returns defensive copies', () => {
    const persistence = new MemoryControlStorePersistence()
    const first = new ControlStore(persistence)
    first.putCandidate(candidate(7, 9_007_199_254_740_993n))
    first.setCandidateState(bytes(7), 'admissible')
    const exposed = first.orderedTransactionIds()[0]!
    exposed[0] = 255

    const restored = new ControlStore(persistence)
    expect(restored.orderedTransactionIds()).toEqual([bytes(7)])
    expect(restored.getCandidate(bytes(7))?.orderKey.authorTimestampMs).toBe(
      9_007_199_254_740_993n,
    )
    expect(restored.changesSince(0n).length).toBe(first.changesSince(0n).length)
  })

  it('rejects conflicting duplicate identities and regressing cutoffs', () => {
    const store = new ControlStore()
    store.putCandidate(candidate(1, 1n))
    expect(() => store.putCandidate(candidate(1, 2n))).toThrowError(
      'CONTROL_STORE_CANDIDATE_CONFLICT',
    )
    store.recordHeartbeat(heartbeat(1, 100n))
    expect(() => store.recordHeartbeat(heartbeat(1, 99n))).toThrowError(
      'CONTROL_STORE_HEARTBEAT_SEQUENCE_REGRESSION',
    )
  })
})
