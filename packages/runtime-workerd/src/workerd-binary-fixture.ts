import {
  compileProgram,
  compileSchema,
  CompilerError,
  type BackendParameter,
  type CompiledPrecondition,
  type TransactionContextValues,
} from '@chronolog/compiler-sqlite'
import {
  concatBytes,
  encodeCanonicalCbor,
  integerMap,
  sha256,
  uint32Bytes,
  utf8,
} from '@chronolog/canonical'
import {
  digestCanonicalQueryResult,
  encodeExecutionManifest,
  encodeSchemaManifest,
  type AffectedRowsExpectation,
  type CanonicalQueryResult,
  type LogicalValue,
} from '@chronolog/ir'
import {
  digestAdmittedOrder,
  sameBytes,
  type AdmittedTransaction,
  type ResolvedMaterializationInvocation,
} from '@chronolog/materializer'

import {
  createChronologReducerWorkerModule,
  type DatabaseReducerSqlParameter,
  type ChronologReducerKernelContext,
} from './worker-bundle.js'

type Outcome = 'accepted' | 'rejected_precondition' | 'rejected_execution'

interface LoggedOutcome {
  readonly txId: Uint8Array
  readonly outcome: Outcome
  readonly rejectionCode: string | null
}

/**
 * Binary fixture kernel for the subset that the current synchronous workerd
 * handle can execute faithfully. It uses Chronolog's real SQLite compiler and
 * protected-log representation. It uses the reducer output's wrapper-owned
 * synchronous transaction/savepoint surface and parameterized typed SQL. The
 * fixture remains deliberately narrower than the complete production kernel:
 * preconditions are scalar booleans and every mutation must declare an exact
 * affected-row count so its accepted-result digest can be computed before the
 * synchronous transaction callback.
 */
export default createChronologReducerWorkerModule({
  async materialize(input, context) {
    const compiledSchema = compileSchema(input.schemaManifest, input.executionManifest)
    await verifyPrevious(input, context)
    const prefix = await prepareReplayBase(input, context, compiledSchema)
    const targetIds = [
      ...prefix,
      ...input.admittedSuffix.transactions.map((transaction) => transaction.txId),
    ]
    if (targetIds.length !== input.invocation.targetOrderLength ||
        !sameBytes(await digestAdmittedOrder(targetIds), input.invocation.targetOrderDigest)) {
      throw new Error('MATERIALIZER_TARGET_ORDER_DIGEST_MISMATCH')
    }

    for (const [offset, transaction] of input.admittedSuffix.transactions.entries()) {
      await applyTransaction(input, context, transaction, prefix.length + offset, compiledSchema.catalog)
    }

    const outcomes = readOutcomes(context.materialized)
    if (outcomes.length !== input.invocation.targetOrderLength) {
      throw new Error('MATERIALIZER_LOG_LENGTH_MISMATCH')
    }
    const previousOutcomes = context.previous === null ? [] : readOutcomes(context.previous)
    const itemValue = context.materialized.queryText(
      "SELECT COALESCE((SELECT value FROM items WHERE id = 2), '')",
    )
    const payload = observation(
      input.invocation.targetOrderDigest,
      outcomes,
      previousOutcomes,
      itemValue,
    )
    context.materialized.commit({
      message: `Chronolog materialization (${outcomes.length} transactions)`,
      authorName: 'Chronolog integration test',
      authorEmail: 'workerd-fixture@chronolog.invalid',
      timestamp: '1970-01-01T00:00:00',
    })
    return {
      databaseSelector: 'materialized',
      selectedSource: 'materialized',
      payload,
    }
  },
})

async function verifyPrevious(
  input: ResolvedMaterializationInvocation,
  context: ChronologReducerKernelContext,
): Promise<void> {
  const previousIds = context.previous === null ? [] : readTransactionIds(context.previous)
  if (!sameBytes(
    await digestAdmittedOrder(previousIds),
    input.invocation.expectedPreviousOrderDigest,
  )) {
    throw new Error('MATERIALIZER_PREVIOUS_ORDER_DIGEST_MISMATCH')
  }
}

async function prepareReplayBase(
  input: ResolvedMaterializationInvocation,
  context: ChronologReducerKernelContext,
  compiledSchema: ReturnType<typeof compileSchema>,
): Promise<readonly Uint8Array[]> {
  const initialized = context.materialized.queryText(
    "SELECT CAST(count(*) AS TEXT) FROM sqlite_schema " +
    "WHERE type = 'table' AND name = 'chronolog_transactions'",
  ) === '1'
  if (!initialized) {
    if (input.invocation.replayFromIndex !== 0) {
      throw new Error('MATERIALIZER_CHECKPOINT_PREFIX_UNAVAILABLE')
    }
    // The bootstrap fixture needs one ordinary table in order to create its
    // first immutable commit. Production canonical repositories are already
    // initialized and never take this fixture-only cleanup path.
    context.materialized.execute('DROP TABLE IF EXISTS chronolog_seed')
    initializeChronologDatabase(input, context, compiledSchema)
  } else {
    verifyStoredManifests(input, context)
  }
  const prefix = readTransactionIds(context.materialized)
  if (prefix.length !== input.invocation.replayFromIndex) {
    throw new Error('MATERIALIZER_CHECKPOINT_PREFIX_LENGTH_MISMATCH')
  }
  return prefix
}

function initializeChronologDatabase(
  input: ResolvedMaterializationInvocation,
  context: ChronologReducerKernelContext,
  compiledSchema: ReturnType<typeof compileSchema>,
): void {
  context.materialized.transactionSync(() => {
    context.materialized.execute(`
      CREATE TABLE chronolog_execution_manifest (
        singleton_key INTEGER PRIMARY KEY NOT NULL CHECK (singleton_key = 1),
        manifest_digest BLOB NOT NULL CHECK (length(manifest_digest) = 32),
        canonical_manifest BLOB NOT NULL,
        schema_digest BLOB NOT NULL CHECK (length(schema_digest) = 32),
        canonical_schema BLOB NOT NULL
      ) STRICT
    `)
    context.materialized.execute(`
      CREATE TABLE chronolog_transactions (
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
        failing_command_id INTEGER,
        failing_rule_id INTEGER,
        failing_constraint_id INTEGER,
        result_digest BLOB CHECK (result_digest IS NULL OR length(result_digest) = 32)
      ) STRICT
    `)
    context.materialized.execute(
      'INSERT INTO chronolog_execution_manifest (' +
      'singleton_key, manifest_digest, canonical_manifest, schema_digest, canonical_schema' +
      ') VALUES (1, ?, ?, ?, ?)',
      [
        input.invocation.expectedExecutionManifestDigest,
        encodeExecutionManifest(input.executionManifest),
        input.invocation.expectedSchemaDigest,
        encodeSchemaManifest(input.schemaManifest),
      ],
    )
    for (const statement of compiledSchema.statements) {
      context.materialized.execute(
        statement.sql,
        bindParameters(statement.parameters, null),
      )
    }
  })
}

function verifyStoredManifests(
  input: ResolvedMaterializationInvocation,
  context: ChronologReducerKernelContext,
): void {
  const stored = context.materialized.queryText(
    "SELECT lower(hex(manifest_digest)) || ':' || lower(hex(schema_digest)) " +
    'FROM chronolog_execution_manifest WHERE singleton_key = 1',
  )
  const expected = `${hex(input.invocation.expectedExecutionManifestDigest)}:` +
    hex(input.invocation.expectedSchemaDigest)
  if (stored !== expected) throw new Error('DATABASE_MANIFEST_MISMATCH')
}

async function applyTransaction(
  input: ResolvedMaterializationInvocation,
  context: ChronologReducerKernelContext,
  transaction: AdmittedTransaction,
  orderIndex: number,
  catalog: ReturnType<typeof compileSchema>['catalog'],
): Promise<void> {
  let outcome: Outcome = 'accepted'
  let rejectionCode: string | null = null
  let failingPreconditionId: number | null = null
  let failingCommandId: number | null = null
  let resultDigest: Uint8Array | null = null
  let compiled: ReturnType<typeof compileProgram> | null = null
  let transactionContext: TransactionContextValues | null = null
  try {
    if (!sameBytes(transaction.core.schemaDigest, input.invocation.expectedSchemaDigest)) {
      throw new FixtureRejection('SCHEMA_DIGEST_MISMATCH')
    }
    if (!sameBytes(
      transaction.core.executionManifestDigest,
      input.invocation.expectedExecutionManifestDigest,
    )) {
      throw new FixtureRejection('EXECUTION_MANIFEST_DIGEST_MISMATCH')
    }
    compiled = compileProgram(transaction.core.program, catalog)
    transactionContext = contextOf(transaction)
    const preconditions: Uint8Array[] = []
    for (const precondition of compiled.preconditions) {
      preconditions.push(await evaluatePrecondition(context, precondition, transactionContext))
    }
    const exactAffectedRows = compiled.mutations.map((mutation) =>
      requiredExactAffectedRows(mutation.source.affectedRows, mutation.id))
    resultDigest = await acceptedResultDigest(preconditions, exactAffectedRows)
  } catch (error) {
    const rejection = deterministicRejection(error)
    if (rejection === null) {
      const failure = error instanceof Error ? error : new Error(String(error))
      throw failure
    }
    ({ outcome, rejectionCode, failingPreconditionId, failingCommandId } = rejection)
  }

  context.materialized.transactionSync(() => {
    if (outcome === 'accepted') {
      if (compiled === null || transactionContext === null) {
        throw new Error('WORKERD_FIXTURE_COMPILED_PROGRAM_MISSING')
      }
      try {
        // The nested wrapper is a private savepoint. Any deterministic command
        // rejection rolls back every application mutation while the outer
        // transaction remains available to append the protected rejection row.
        context.materialized.transactionSync(() => {
          for (const mutation of compiled.mutations) {
            let changes: bigint
            try {
              context.materialized.execute(
                mutation.sql,
                bindParameters(mutation.parameters, transactionContext),
              )
              changes = BigInt(
                context.materialized.queryText('SELECT CAST(changes() AS TEXT)'),
              )
            } catch (error) {
              if (!isConstraintViolation(error)) throw error
              throw new FixtureRejection('CONSTRAINT_VIOLATION', null, mutation.id)
            }
            assertAffectedRows(mutation.source.affectedRows, changes, mutation.id)
          }
        })
      } catch (error) {
        const rejection = deterministicRejection(error)
        if (rejection === null) {
          const failure = error instanceof Error ? error : new Error(String(error))
          throw failure
        }
        ({ outcome, rejectionCode, failingPreconditionId, failingCommandId } = rejection)
        resultDigest = null
      }
    }
    insertLogRow(context, transaction, orderIndex, {
      outcome,
      rejectionCode,
      failingPreconditionId,
      failingCommandId,
      resultDigest,
    })
  })
}

async function evaluatePrecondition(
  context: ChronologReducerKernelContext,
  precondition: CompiledPrecondition,
  transactionContext: TransactionContextValues,
): Promise<Uint8Array> {
  if (precondition.kind !== 'assert' ||
      precondition.query.resultMode.kind !== 'scalar' ||
      precondition.query.columns.length !== 1 ||
      precondition.query.columns[0]?.valueType.logical.kind !== 'boolean') {
    throw new Error('WORKERD_FIXTURE_PRECONDITION_SHAPE_UNSUPPORTED')
  }
  const sqlResult = context.materialized.query(
    precondition.query.sql,
    bindParameters(precondition.query.parameters, transactionContext),
  )
  if (sqlResult.rows.length !== 1 || sqlResult.rows[0]?.values.length !== 1) {
    throw new Error('WORKERD_FIXTURE_SCALAR_RESULT_INVALID')
  }
  const raw = sqlResult.rows[0].values[0]
  if (raw !== 0n && raw !== 1n) {
    throw new Error('WORKERD_FIXTURE_BOOLEAN_RESULT_INVALID')
  }
  const value = raw === 1n
  if (!value) throw new FixtureRejection('ASSERTION_FALSE', precondition.id)
  const canonicalResult: CanonicalQueryResult = {
    resultMode: precondition.query.resultMode,
    columns: precondition.query.columns,
    rows: [[{ kind: 'boolean', value }]],
  }
  return digestCanonicalQueryResult(canonicalResult)
}

function assertAffectedRows(
  expectation: AffectedRowsExpectation,
  actual: bigint,
  commandId: number,
): void {
  const accepted = expectation.kind === 'unconstrained' ? true
    : expectation.kind === 'exactly' ? actual === expectation.count
      : expectation.kind === 'at_least' ? actual >= expectation.count
        : expectation.kind === 'at_most' ? actual <= expectation.count
          : actual >= expectation.minimum && actual <= expectation.maximum
  if (!accepted) {
    throw new FixtureRejection('AFFECTED_ROWS_MISMATCH', null, commandId)
  }
}

function requiredExactAffectedRows(
  expectation: AffectedRowsExpectation,
  commandId: number,
): bigint {
  if (expectation.kind !== 'exactly') {
    throw new Error(`WORKERD_FIXTURE_AFFECTED_ROWS_SHAPE_UNSUPPORTED:${commandId}`)
  }
  return expectation.count
}

function deterministicRejection(error: unknown): {
  readonly outcome: Outcome
  readonly rejectionCode: string
  readonly failingPreconditionId: number | null
  readonly failingCommandId: number | null
} | null {
  if (error instanceof FixtureRejection) {
    return {
      outcome: error.failingPreconditionId === null
        ? 'rejected_execution'
        : 'rejected_precondition',
      rejectionCode: error.code,
      failingPreconditionId: error.failingPreconditionId,
      failingCommandId: error.failingCommandId,
    }
  }
  if (error instanceof CompilerError) {
    const failingPreconditionId = error.attribution === 'precondition' ? error.nodeId : null
    return {
      outcome: failingPreconditionId === null
        ? 'rejected_execution'
        : 'rejected_precondition',
      rejectionCode: error.code,
      failingPreconditionId,
      failingCommandId: error.attribution === 'command' ? error.nodeId : null,
    }
  }
  return null
}

function insertLogRow(
  context: ChronologReducerKernelContext,
  transaction: AdmittedTransaction,
  orderIndex: number,
  result: {
    readonly outcome: Outcome
    readonly rejectionCode: string | null
    readonly failingPreconditionId: number | null
    readonly failingCommandId: number | null
    readonly resultDigest: Uint8Array | null
  },
): void {
  context.materialized.execute(
    'INSERT INTO chronolog_transactions (' +
    'tx_id, order_index, author_id, author_timestamp_ms, author_feed_sequence, ' +
    'candidate_digest, canonical_candidate, outcome, rejection_code, ' +
    'failing_precondition_id, failing_command_id, failing_rule_id, ' +
    'failing_constraint_id, result_digest' +
    ') VALUES (' + [
      blob(transaction.txId),
      String(orderIndex),
      blob(transaction.core.authorId),
      text(transaction.core.authorTimestampMs.toString(10)),
      text(transaction.authorFeedSequence.toString(10)),
      blob(transaction.candidateDigest),
      blob(transaction.canonicalCandidate),
      text(result.outcome),
      nullableText(result.rejectionCode),
      nullableInteger(result.failingPreconditionId),
      nullableInteger(result.failingCommandId),
      'NULL',
      'NULL',
      result.resultDigest === null ? 'NULL' : blob(result.resultDigest),
    ].join(', ') + ')',
  )
}

function readTransactionIds(handle: { queryText(sql: string): string }): Uint8Array[] {
  const value = handle.queryText(
    "SELECT COALESCE(group_concat(tx_id_hex, ','), '') FROM (" +
    'SELECT lower(hex(tx_id)) AS tx_id_hex FROM chronolog_transactions ORDER BY order_index)',
  )
  return value === '' ? [] : value.split(',').map(fromHex)
}

function readOutcomes(handle: { queryText(sql: string): string }): LoggedOutcome[] {
  const value = handle.queryText(
    "SELECT COALESCE(group_concat(entry, '|'), '') FROM (" +
    "SELECT lower(hex(tx_id)) || ':' || outcome || ':' || " +
    "coalesce(rejection_code, '') AS entry FROM chronolog_transactions ORDER BY order_index)",
  )
  if (value === '') return []
  return value.split('|').map((entry) => {
    const [txId, outcome, rejectionCode] = entry.split(':')
    if (txId === undefined ||
        (outcome !== 'accepted' &&
         outcome !== 'rejected_precondition' &&
         outcome !== 'rejected_execution') ||
        rejectionCode === undefined) {
      throw new Error('MATERIALIZER_CORRUPT_OUTCOME')
    }
    return { txId: fromHex(txId), outcome, rejectionCode: rejectionCode === '' ? null : rejectionCode }
  })
}

function observation(
  orderDigest: Uint8Array,
  outcomes: readonly LoggedOutcome[],
  previous: readonly LoggedOutcome[],
  itemValue: string,
): Uint8Array {
  const prior = new Map(previous.map((entry) => [hex(entry.txId), entry]))
  const changes = outcomes.flatMap((entry) => {
    const before = prior.get(hex(entry.txId))
    return before?.outcome === entry.outcome && before.rejectionCode === entry.rejectionCode
      ? []
      : [[entry.txId, before?.outcome ?? null, entry.outcome,
        before?.rejectionCode ?? null, entry.rejectionCode]]
  })
  return encodeCanonicalCbor(integerMap([
    [0, 1n],
    [1, BigInt(outcomes.length)],
    [2, orderDigest],
    [3, outcomes.map((entry) => [entry.txId, entry.outcome, entry.rejectionCode])],
    [4, itemValue],
    [5, changes],
  ]))
}

function bindParameters(
  parameters: readonly BackendParameter[],
  context: TransactionContextValues | null,
): DatabaseReducerSqlParameter[] {
  return parameters.map((parameter, index) => {
    if (parameter.ordinal !== index + 1) throw new Error('COMPILER_PARAMETER_ORDER_INVALID')
    const value = parameter.source.kind === 'literal'
      ? parameter.source.value
      : parameter.source.kind === 'context' && context !== null
        ? contextValue(parameter.source.field, context)
        : null
    if (value === null) throw new Error('WORKERD_FIXTURE_BINDING_UNSUPPORTED')
    return sqlParameter(value)
  })
}

function contextValue(
  field: keyof TransactionContextValues,
  context: TransactionContextValues,
): LogicalValue {
  const value = context[field]
  if (field === 'author_timestamp_ms') return { kind: 'timestamp_ms', value: value as bigint }
  if (field === 'author_feed_sequence') return { kind: 'int64', value: value as bigint }
  return { kind: 'blob', bytes: Uint8Array.from(value as Uint8Array) }
}

function sqlParameter(value: LogicalValue): DatabaseReducerSqlParameter {
  switch (value.kind) {
    case 'null': return null
    case 'boolean': return value.value ? 1n : 0n
    case 'int64':
    case 'timestamp_ms':
    case 'duration_ms': return value.value
    case 'text': return new TextDecoder('utf-8', { fatal: true }).decode(value.utf8)
    case 'blob':
    case 'uuid':
    case 'vector': return Uint8Array.from(value.bytes)
    default: throw new Error(`WORKERD_FIXTURE_VALUE_UNSUPPORTED:${value.kind}`)
  }
}

function contextOf(transaction: AdmittedTransaction): TransactionContextValues {
  return {
    group_id: transaction.core.groupId,
    membership_revision: transaction.core.membershipRevision,
    validation_policy: transaction.core.validationPolicy,
    author_id: transaction.core.authorId,
    author_timestamp_ms: transaction.core.authorTimestampMs,
    transaction_nonce: transaction.core.nonce,
    candidate_digest: transaction.candidateDigest,
    transaction_id: transaction.txId,
    author_feed_sequence: transaction.authorFeedSequence,
  }
}

async function acceptedResultDigest(
  preconditions: readonly Uint8Array[],
  affectedRows: readonly bigint[],
): Promise<Uint8Array> {
  const counts = affectedRows.flatMap((count) => {
    const encoded = utf8(count.toString(10))
    return [uint32Bytes(encoded.length), encoded]
  })
  return sha256(concatBytes(
    utf8('chronolog-accepted-result-v1\0'),
    ...preconditions,
    ...counts,
  ))
}

function text(value: string): string {
  if (value.includes('\0')) return `CAST(${blob(new TextEncoder().encode(value))} AS TEXT)`
  return `'${value.replaceAll("'", "''")}'`
}

function nullableText(value: string | null): string {
  return value === null ? 'NULL' : text(value)
}

function nullableInteger(value: number | null): string {
  return value === null ? 'NULL' : String(value)
}

function blob(value: Uint8Array): string {
  return `X'${hex(value)}'`
}

function hex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function fromHex(value: string): Uint8Array {
  if (value.length % 2 !== 0 || !/^[0-9a-f]*$/u.test(value)) {
    throw new Error('MATERIALIZER_CORRUPT_TRANSACTION_ID')
  }
  return Uint8Array.from({ length: value.length / 2 }, (_, index) =>
    Number.parseInt(value.slice(index * 2, index * 2 + 2), 16))
}

function isConstraintViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const message = (error as { readonly message?: unknown }).message
  return typeof message === 'string' && /(?:constraint|unique|primary key)/iu.test(message)
}

class FixtureRejection extends Error {
  constructor(
    readonly code: string,
    readonly failingPreconditionId: number | null = null,
    readonly failingCommandId: number | null = null,
  ) {
    super(code)
    this.name = 'FixtureRejection'
  }
}
