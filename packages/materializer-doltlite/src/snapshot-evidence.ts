import { encodeCanonicalCbor, hashDomain, DOMAINS, type CborValue } from '@chronolog/protocol'

import type { TransactionLogRow } from './types.js'

/** Exact digest of every protected materialized-log field in order. */
export function materializedLogDigest(rows: readonly TransactionLogRow[]): Promise<Uint8Array> {
  const encoded = encodeCanonicalCbor(rows.map((row) => new Map<bigint, CborValue>([
    [0n, row.txId],
    [1n, BigInt(row.orderIndex)],
    [2n, row.authorId],
    [3n, row.authorTimestampMs],
    [4n, row.authorFeedSequence],
    [5n, row.candidateDigest],
    [6n, row.canonicalCandidate],
    [7n, row.outcome],
    [8n, row.rejectionCode],
    [9n, row.failingPreconditionId === null ? null : BigInt(row.failingPreconditionId)],
    [10n, row.failingPreconditionIndex === null ? null : BigInt(row.failingPreconditionIndex)],
    [11n, row.failingStatementIndex === null ? null : BigInt(row.failingStatementIndex)],
    [12n, row.failurePhase],
    [13n, row.failingConstraintIdentity],
    [14n, row.failingTriggerIdentity],
    [15n, row.resultEnvelopeVersion === null ? null : BigInt(row.resultEnvelopeVersion)],
    [16n, row.resultEnvelope],
    [17n, row.resultDigest],
  ])))
  return hashDomain(DOMAINS.materializedLog, encoded)
}
