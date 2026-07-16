import type { DatabaseLike, StoredExecutionManifest, TransactionLogRow } from './types.js'

/** The sole protocol-visible protected relation in the main Dolt database. */
export const TRANSACTION_LOG_TABLE = 'chronolog_transactions' as const
export const EXECUTION_MANIFEST_TABLE = 'chronolog_execution_manifest' as const

export function initializeSystemLog(database: DatabaseLike): void {
  database.exec(`
    CREATE TABLE ${EXECUTION_MANIFEST_TABLE} (
      singleton_key INTEGER PRIMARY KEY NOT NULL CHECK (singleton_key = 1),
      manifest_digest BLOB NOT NULL CHECK (length(manifest_digest) = 32),
      canonical_manifest BLOB NOT NULL
    ) STRICT;
    CREATE TABLE ${TRANSACTION_LOG_TABLE} (
      tx_id BLOB PRIMARY KEY NOT NULL,
      order_index INTEGER NOT NULL UNIQUE,
      author_id BLOB NOT NULL,
      author_timestamp_ms TEXT NOT NULL,
      author_feed_sequence TEXT NOT NULL,
      candidate_digest BLOB NOT NULL,
      canonical_candidate BLOB NOT NULL,
      outcome TEXT NOT NULL CHECK (
        outcome IN ('accepted', 'rejected_precondition', 'rejected_execution')
      ),
      rejection_code TEXT,
      failing_precondition_id INTEGER,
      failing_precondition_index INTEGER,
      failing_statement_index INTEGER,
      failure_phase TEXT CHECK (
        failure_phase IS NULL OR failure_phase IN ('precondition', 'statement', 'finalize')
      ),
      failing_constraint_identity BLOB,
      failing_trigger_identity BLOB,
      result_envelope_version INTEGER CHECK (
        result_envelope_version IS NULL OR result_envelope_version = 1
      ),
      result_envelope BLOB,
      result_digest BLOB CHECK (result_digest IS NULL OR length(result_digest) = 32),
      CHECK (
        (outcome = 'accepted' AND result_envelope_version = 1
          AND result_envelope IS NOT NULL AND result_digest IS NOT NULL)
        OR
        (outcome <> 'accepted' AND result_envelope_version IS NULL
          AND result_envelope IS NULL AND result_digest IS NULL)
      ),
      CHECK (
        outcome <> 'accepted' OR
        (failing_constraint_identity IS NULL AND failing_trigger_identity IS NULL)
      ),
      CHECK (
        (failure_phase = 'precondition' AND failing_precondition_id IS NOT NULL
          AND failing_precondition_index IS NOT NULL AND failing_statement_index IS NULL)
        OR (failure_phase = 'statement' AND failing_precondition_id IS NULL
          AND failing_precondition_index IS NULL AND failing_statement_index IS NOT NULL)
        OR (failure_phase = 'finalize' AND failing_precondition_id IS NULL
          AND failing_precondition_index IS NULL AND failing_statement_index IS NULL)
        OR (failure_phase IS NULL AND outcome = 'accepted')
      )
    ) STRICT
  `)
}

export function insertExecutionManifest(
  database: DatabaseLike,
  manifest: StoredExecutionManifest,
): void {
  database.prepare(`
    INSERT INTO ${EXECUTION_MANIFEST_TABLE} (
      singleton_key, manifest_digest, canonical_manifest
    ) VALUES (1, ?, ?)
  `).run(
    manifest.manifestDigest,
    manifest.canonicalManifest,
  )
}

export function readExecutionManifest(database: DatabaseLike): StoredExecutionManifest {
  const raw = database.prepare(`
    SELECT manifest_digest, canonical_manifest
      FROM ${EXECUTION_MANIFEST_TABLE}
     WHERE singleton_key = 1
  `).get()
  if (raw === undefined || Array.isArray(raw)) throw new Error('DATABASE_MANIFEST_MISSING')
  return {
    manifestDigest: asDigest(raw.manifest_digest),
    canonicalManifest: asBytes(raw.canonical_manifest),
  }
}

export function readSystemLog(database: DatabaseLike): TransactionLogRow[] {
  const statement = database.prepare(`
    SELECT tx_id, order_index, author_id, author_timestamp_ms,
           author_feed_sequence, candidate_digest, canonical_candidate,
           outcome, rejection_code, failing_precondition_id,
           failing_precondition_index, failing_statement_index, failure_phase,
           failing_constraint_identity, failing_trigger_identity,
           result_envelope_version, result_envelope, result_digest
      FROM ${TRANSACTION_LOG_TABLE}
     ORDER BY order_index
  `)
  statement.setReadBigInts?.(true)
  return statement.all().map((raw) => {
    if (Array.isArray(raw)) throw new Error('MATERIALIZER_EXPECTED_OBJECT_ROW')
    const outcome = String(raw.outcome)
    if (
      outcome !== 'accepted' &&
      outcome !== 'rejected_precondition' &&
      outcome !== 'rejected_execution'
    ) {
      throw new Error('MATERIALIZER_CORRUPT_OUTCOME')
    }
    const txId = asBytes(raw.tx_id)
    const authorId = asBytes(raw.author_id)
    const authorTimestampMs = BigInt(String(raw.author_timestamp_ms))
    const authorFeedSequence = BigInt(String(raw.author_feed_sequence))
    return {
      txId,
      orderIndex: Number(raw.order_index),
      authorId,
      authorTimestampMs,
      authorFeedSequence,
      candidateDigest: asBytes(raw.candidate_digest),
      canonicalCandidate: asBytes(raw.canonical_candidate),
      orderKey: { authorTimestampMs, authorId, authorFeedSequence, txId },
      outcome,
      rejectionCode: raw.rejection_code === null ? null : asString(raw.rejection_code),
      failingPreconditionId: asNullableId(raw.failing_precondition_id),
      failingPreconditionIndex: asNullableId(raw.failing_precondition_index),
      failingStatementIndex: asNullableId(raw.failing_statement_index),
      failurePhase: asNullablePhase(raw.failure_phase),
      failingConstraintIdentity: raw.failing_constraint_identity === null ? null : asBytes(raw.failing_constraint_identity),
      failingTriggerIdentity: raw.failing_trigger_identity === null ? null : asBytes(raw.failing_trigger_identity),
      resultEnvelopeVersion: raw.result_envelope_version === null ? null : 1,
      resultEnvelope: raw.result_envelope === null ? null : asBytes(raw.result_envelope),
      resultDigest: raw.result_digest === null ? null : asDigest(raw.result_digest),
    }
  })
}

export function insertSystemLogRow(
  database: DatabaseLike,
  row: {
    readonly txId: Uint8Array
    readonly orderIndex: number
    readonly authorId: Uint8Array
    readonly authorTimestampMs: bigint
    readonly authorFeedSequence: bigint
    readonly candidateDigest: Uint8Array
    readonly canonicalCandidate: Uint8Array
    readonly outcome: string
    readonly rejectionCode: string | null
    readonly failingPreconditionId: number | null
    readonly failingPreconditionIndex: number | null
    readonly failingStatementIndex: number | null
    readonly failurePhase: 'precondition' | 'statement' | 'finalize' | null
    readonly failingConstraintIdentity: Uint8Array | null
    readonly failingTriggerIdentity: Uint8Array | null
    readonly resultEnvelopeVersion: 1 | null
    readonly resultEnvelope: Uint8Array | null
    readonly resultDigest: Uint8Array | null
  },
): void {
  database
    .prepare(`
      INSERT INTO ${TRANSACTION_LOG_TABLE} (
        tx_id, order_index, author_id, author_timestamp_ms,
        author_feed_sequence, candidate_digest, canonical_candidate,
        outcome, rejection_code, failing_precondition_id,
        failing_precondition_index, failing_statement_index, failure_phase,
        failing_constraint_identity, failing_trigger_identity,
        result_envelope_version, result_envelope, result_digest
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      row.txId,
      row.orderIndex,
      row.authorId,
      row.authorTimestampMs.toString(10),
      row.authorFeedSequence.toString(10),
      row.candidateDigest,
      row.canonicalCandidate,
      row.outcome,
      row.rejectionCode,
      row.failingPreconditionId,
      row.failingPreconditionIndex,
      row.failingStatementIndex,
      row.failurePhase,
      row.failingConstraintIdentity,
      row.failingTriggerIdentity,
      row.resultEnvelopeVersion,
      row.resultEnvelope,
      row.resultDigest,
    )
}

function asBytes(value: unknown): Uint8Array {
  if (!(value instanceof Uint8Array)) throw new Error('MATERIALIZER_CORRUPT_BYTES')
  return Uint8Array.from(value)
}

function asDigest(value: unknown): Uint8Array {
  const bytes = asBytes(value)
  if (bytes.length !== 32) throw new Error('MATERIALIZER_CORRUPT_DIGEST')
  return bytes
}

function asString(value: unknown): string {
  if (typeof value !== 'string') throw new Error('MATERIALIZER_CORRUPT_TEXT')
  return value
}

function asNullableId(value: unknown): number | null {
  if (value === null) return null
  const id = typeof value === 'bigint' ? Number(value) : value
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 0) {
    throw new Error('MATERIALIZER_CORRUPT_ATTRIBUTION_ID')
  }
  return id
}

function asNullablePhase(value: unknown): 'precondition' | 'statement' | 'finalize' | null {
  if (value === null) return null
  if (value === 'precondition' || value === 'statement' || value === 'finalize') return value
  throw new Error('MATERIALIZER_CORRUPT_FAILURE_PHASE')
}
