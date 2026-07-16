import {
  compileManifestArtifacts,
  compileSqlProgram,
  compileSqlStatement,
  SqlCompilerError,
  type ManifestArtifacts,
} from '@chronolog/compiler-sqlite'
import type { ExecutionManifest } from '@chronolog/ir'
import {
  compareTransactionOrder,
  decodeCanonicalSchemaIdentity,
  decodeTransactionCore,
  decodeTransactionResultEnvelope,
  digestCanonicalSqlResult,
  digestTransactionResultEnvelope,
  encodeTransactionResultEnvelope,
  encodeCanonicalSchemaIdentity,
  encodeTransactionCore,
  transactionDigest,
  type SqlStatement,
  type SqlTransactionProgram,
  type TransactionOrderKey,
  type TransactionResultEnvelopeV1,
} from '@chronolog/protocol'

import {
  HEAD_BRANCH,
  checkpointOrderDigest,
  cleanupOrphanBranches,
  createCheckpointRef,
  createReplayBranch,
  createRevisionRef,
  discoverCheckpoints,
  discoverPublishedRef,
  orderDigest,
  publishRef,
  removeBranchIfPresent,
  verifyPublishedLog,
  type PublishedRef,
} from './checkpoints.js'
import { openDatabase } from './driver.js'
import { isOperationalSqliteError, withAuthorizer } from './sql-profile.js'
import {
  DeterministicSqlRejection,
  evaluateSqlPrecondition,
  executeSqlBodyStatement,
  executeSqlObservation,
  type SqlResultExecutionLimits,
} from './sql-executor.js'
import { executeLocalSql } from './sql-values.js'
import {
  initializeSystemLog,
  insertExecutionManifest,
  insertSystemLogRow,
  readExecutionManifest,
  readSystemLog,
} from './system-log.js'
import type {
  AdmittedTransaction,
  DatabaseLike,
  LocalSqlOptions,
  LocalSqlQueryResult,
  LocalSqlValue,
  MaterializedSqlQueryResult,
  MaterializedRevision,
  MaterializerBackendInfo,
  MaterializerCheckpointInfo,
  MaterializerSqlBackend,
  MaterializerOptions,
  MaterializerPublicationFaultPoint,
  OutcomeChange,
  ObserveSqlOptions,
  RevisionSubscriber,
  StoredExecutionManifest,
  TransactionLogRow,
  TransactionOutcome,
  TransactionOutcomeKind,
} from './types.js'

export class MaterializerInputError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'MaterializerInputError'
  }
}

export class DeterministicMaterializer implements MaterializerSqlBackend {
  readonly #writer: DatabaseLike
  #reader: DatabaseLike
  readonly #sourceOptions: MaterializerOptions
  readonly #options: Required<Pick<MaterializerOptions, 'checkpointEvery' | 'retainCheckpoints'>>
  readonly #backend: MaterializerBackendInfo
  readonly #executionManifest: ExecutionManifest
  readonly #artifacts: ManifestArtifacts
  readonly #subscribers = new Set<RevisionSubscriber>()
  #published: PublishedRef
  #checkpoints: MaterializerCheckpointInfo[]
  #order: Uint8Array[]
  #log: TransactionLogRow[]
  #closed = false
  #materializing = false
  #checkpointError: string | null = null

  private constructor(
    writer: DatabaseLike,
    reader: DatabaseLike,
    options: MaterializerOptions,
    backend: MaterializerBackendInfo,
    executionManifest: ExecutionManifest,
    artifacts: ManifestArtifacts,
    published: PublishedRef,
    checkpoints: MaterializerCheckpointInfo[],
    log: TransactionLogRow[],
  ) {
    this.#writer = writer
    this.#reader = reader
    this.#sourceOptions = options
    this.#backend = backend
    this.#executionManifest = structuredClone(executionManifest)
    this.#artifacts = artifacts
    this.#published = published
    this.#checkpoints = checkpoints
    this.#log = log
    this.#order = log.map((row) => copyBytes(row.txId))
    this.#options = {
      checkpointEvery: validatePositiveInteger(options.checkpointEvery ?? 100, 'checkpointEvery'),
      retainCheckpoints: validatePositiveInteger(options.retainCheckpoints ?? 16, 'retainCheckpoints'),
    }
  }

  static async open(options: MaterializerOptions): Promise<DeterministicMaterializer> {
    const artifacts = await compileManifestArtifacts(options.executionManifest)
    const opened = openDatabase(options)
    let reader: DatabaseLike | null = null
    try {
      if (!bytesEqual(opened.backend.engineDigest, options.executionManifest.engineDigest)) {
        throw new MaterializerInputError('MATERIALIZER_ENGINE_DIGEST_MISMATCH')
      }
      let published = discoverPublishedRef(opened.database)
      if (published === null) {
        published = initializeRepository(opened.database, artifacts)
      } else {
        resetActiveWorkingSet(opened.database)
        opened.database.doltCheckout(HEAD_BRANCH)
        verifyDatabaseState(opened.database, artifacts)
      }
      const log = readSystemLog(opened.database)
      await verifyLogResultIntegrity(log, options.executionManifest.errorCodes)
      verifyPublishedLog(published, log)
      const checkpoints = await validateCheckpointRefs(opened.database, published, log, artifacts, options.executionManifest.errorCodes)
      cleanupOrphanBranches(opened.database, published, checkpoints)

      const readerOpened = openDatabase(options)
      reader = readerOpened.database
      if (!bytesEqual(readerOpened.backend.engineDigest, options.executionManifest.engineDigest)) {
        throw new MaterializerInputError('MATERIALIZER_ENGINE_DIGEST_MISMATCH')
      }
      reader.doltCheckout(published.branchRef)
      verifyDatabaseState(reader, artifacts)
      const readerLog = readSystemLog(reader)
      await verifyLogResultIntegrity(readerLog, options.executionManifest.errorCodes)
      verifyPublishedLog(published, readerLog)
      if (reader.doltHashOf(published.branchRef) !== published.contentHash) {
        throw new Error('MATERIALIZER_READER_CONTENT_MISMATCH')
      }
      return new DeterministicMaterializer(
        opened.database,
        reader,
        options,
        opened.backend,
        options.executionManifest,
        artifacts,
        published,
        checkpoints,
        readerLog,
      )
    } catch (error) {
      reader?.close()
      opened.database.close()
      throw error
    }
  }

  get revision(): bigint { return this.#published.revision }
  get orderLength(): number { return this.#order.length }
  get executionManifestDigest(): Uint8Array { return copyBytes(this.#artifacts.executionManifestDigest) }
  get executionManifest(): ExecutionManifest { return structuredClone(this.#executionManifest) }
  get backend(): MaterializerBackendInfo { return structuredClone(this.#backend) }
  get checkpointError(): string | null { return this.#checkpointError }

  checkpoints(): readonly MaterializerCheckpointInfo[] {
    return this.#checkpoints.map((checkpoint) => structuredClone(checkpoint))
  }

  transactionLog(): readonly TransactionLogRow[] { return this.#log.map(cloneLogRow) }

  outcome(txId: Uint8Array): TransactionOutcome | null {
    const row = this.#log.find((entry) => bytesEqual(entry.txId, txId))
    if (row === undefined) return null
    return {
      txId: copyBytes(row.txId),
      orderKey: structuredClone(row.orderKey),
      orderIndex: row.orderIndex,
      outcome: row.outcome,
      rejectionCode: row.rejectionCode,
      failingPreconditionId: row.failingPreconditionId,
      failingPreconditionIndex: row.failingPreconditionIndex,
      failingStatementIndex: row.failingStatementIndex,
      failurePhase: row.failurePhase,
      failingConstraintIdentity: row.failingConstraintIdentity === null ? null : copyBytes(row.failingConstraintIdentity),
      failingTriggerIdentity: row.failingTriggerIdentity === null ? null : copyBytes(row.failingTriggerIdentity),
      resultEnvelopeVersion: row.resultEnvelopeVersion,
      resultEnvelope: row.resultEnvelope === null ? null : copyBytes(row.resultEnvelope),
      resultDigest: row.resultDigest === null ? null : copyBytes(row.resultDigest),
    }
  }

  transactionResult(txId: Uint8Array): TransactionResultEnvelopeV1 | null {
    const row = this.#log.find((entry) => bytesEqual(entry.txId, txId))
    if (row?.resultEnvelope === null || row?.resultEnvelope === undefined) return null
    return decodeTransactionResultEnvelope(row.resultEnvelope)
  }

  async observe(statement: SqlStatement, options: ObserveSqlOptions): Promise<MaterializedSqlQueryResult> {
    this.#assertOpen()
    this.#assertRevision(options.atRevision)
    const observation = {
      revision: this.revision,
      orderLength: this.orderLength,
      executionManifestDigest: this.executionManifestDigest,
    }
    const diagnostics = this.validateStatement(statement, 'precondition')
    if (diagnostics.length > 0) throw new MaterializerInputError(diagnostics[0]!.code)
    const result = executeSqlObservation(
      this.#reader,
      statement,
      options.resultMode,
      this.#executionManifest.resources.maxQueryRows,
      this.#executionManifest.resources.maxResultBytes,
      {},
    )
    const resultDigest = await digestCanonicalSqlResult(result)
    return {
      ...observation,
      statement: structuredClone(statement),
      result,
      resultDigest,
    }
  }

  localSql(
    sql: string,
    parameters: readonly LocalSqlValue[] = [],
    options: LocalSqlOptions = {},
  ): LocalSqlQueryResult {
    this.#assertOpen()
    this.#assertRevision(options.atRevision)
    const result = executeLocalSql(this.#reader, sql, parameters)
    return { revision: this.revision, orderLength: this.orderLength, ...result }
  }

  localQuery(
    sql: string,
    parameters: readonly LocalSqlValue[] = [],
    options: LocalSqlOptions = {},
  ): LocalSqlQueryResult {
    return this.localSql(sql, parameters, options)
  }

  validateStatement(statement: SqlStatement, mode: 'precondition' | 'body') {
    try {
      compileSqlStatement(statement, mode)
      return []
    } catch (error) {
      return [sqlCompilerDiagnostic(error)]
    }
  }

  subscribe(subscriber: RevisionSubscriber): () => void {
    this.#assertOpen()
    this.#subscribers.add(subscriber)
    return () => this.#subscribers.delete(subscriber)
  }

  async materialize(orderedTransactions: readonly AdmittedTransaction[]): Promise<MaterializedRevision | null> {
    this.#assertOpen()
    if (this.#materializing) throw new Error('MATERIALIZER_REENTRANT_CALL')
    this.#materializing = true
    let replayBranch: string | null = null
    let revisionBranch: string | null = null
    let newCheckpoint: MaterializerCheckpointInfo | null = null
    let candidateReader: DatabaseLike | null = null
    let publishedMoved = false
    let replayBaseRef: string | null = null
    try {
      const transactions = orderedTransactions.map(cloneTransaction)
      await validateTransactionSet(transactions)
      ensureMonotonicSet(this.#order, transactions.map((transaction) => transaction.txId))
      validateExistingIdentities(this.#log, transactions)
      const difference = earliestDifference(this.#order, transactions.map((transaction) => transaction.txId))
      if (difference === null) return null

      const previousRevision = this.revision
      const previousLog = this.#log.map(cloneLogRow)
      const isAppend = difference === this.#order.length
      const checkpoint = isAppend ? null : this.#checkpointAtOrBefore(difference)
      if (!isAppend && checkpoint === null) throw new Error('MATERIALIZER_GENESIS_CHECKPOINT_MISSING')
      const baseRef = isAppend ? this.#published.doltCommitHash : checkpoint!.doltCommitHash
      replayBaseRef = baseRef
      const replayFrom = isAppend ? this.#order.length : checkpoint!.prefixLength
      const nextRevision = previousRevision + 1n

      replayBranch = createReplayBranch(this.#writer, nextRevision, baseRef)
      this.#writer.doltCheckout(replayBranch)
      verifyDatabaseState(this.#writer, this.#artifacts)
      const replayLog = readSystemLog(this.#writer)
      await verifyLogResultIntegrity(replayLog, this.#executionManifest.errorCodes)
      verifyReplayBase(replayLog, transactions, replayFrom)

      for (let index = replayFrom; index < transactions.length; index += 1) {
        verifyNextLogIndex(this.#writer, index)
        await this.#applyTransaction(transactions[index]!, index)
      }

      const candidateLog = readSystemLog(this.#writer)
      await verifyLogResultIntegrity(candidateLog, this.#executionManifest.errorCodes)
      verifyDesiredLog(candidateLog, transactions)
      verifyDatabaseState(this.#writer, this.#artifacts)
      const commitHash = this.#writer.doltCommit(`chronolog revision ${nextRevision}`)
      const contentHash = this.#writer.doltHashOf(commitHash)
      if (contentHash !== this.#writer.doltHashOf()) throw new Error('MATERIALIZER_COMMIT_CONTENT_MISMATCH')
      this.#publicationFault('after_candidate_commit')

      const retainedBeforeInsertion = this.#checkpoints.filter(
        (entry) => isAppend || entry.prefixLength <= difference,
      )
      if (shouldCheckpoint(retainedBeforeInsertion, transactions.length, this.#options.checkpointEvery)) {
        newCheckpoint = createCheckpointRef(this.#writer, transactions.length, nextRevision, commitHash, candidateLog)
      }
      const nextPublished = createRevisionRef(this.#writer, nextRevision, transactions.length, commitHash, candidateLog)
      revisionBranch = nextPublished.branchRef
      if (nextPublished.contentHash !== contentHash) throw new Error('MATERIALIZER_REVISION_CONTENT_MISMATCH')
      this.#publicationFault('after_revision_ref_created')

      const candidateOpened = openDatabase(this.#sourceOptions)
      candidateReader = candidateOpened.database
      candidateReader.doltCheckout(revisionBranch)
      verifyDatabaseState(candidateReader, this.#artifacts)
      const readerLog = readSystemLog(candidateReader)
      await verifyLogResultIntegrity(readerLog, this.#executionManifest.errorCodes)
      verifyPublishedLog(nextPublished, readerLog)
      if (candidateReader.doltHashOf(revisionBranch) !== contentHash) {
        throw new Error('MATERIALIZER_CANDIDATE_READER_CONTENT_MISMATCH')
      }

      this.#publicationFault('before_head_publish')
      publishRef(this.#writer, nextPublished)
      publishedMoved = true
      this.#publicationFault('after_head_publish')

      const oldReader = this.#reader
      this.#reader = candidateReader
      candidateReader = null
      this.#published = nextPublished
      this.#log = readerLog
      this.#order = transactions.map((transaction) => copyBytes(transaction.txId))
      oldReader.close()
      this.#publicationFault('after_reader_swap')

      try {
        this.#writer.doltCheckout(HEAD_BRANCH)
        const retained = newCheckpoint === null ? retainedBeforeInsertion : [...retainedBeforeInsertion, newCheckpoint]
        this.#checkpoints = this.#pruneCheckpoints(retained)
        cleanupOrphanBranches(this.#writer, nextPublished, this.#checkpoints)
        this.#checkpointError = null
      } catch (error) {
        this.#checkpointError = nonThrowingDiagnostic(error, 'CHECKPOINT_CLEANUP_FAILED')
      }

      const event: MaterializedRevision = {
        revision: nextRevision,
        previousRevision,
        orderLength: transactions.length,
        replayFromIndex: replayFrom,
        replayedTransactions: transactions.length - replayFrom,
        checkpointPrefix: checkpoint?.prefixLength ?? replayFrom,
        contentHash,
        manifestDigest: this.executionManifestDigest,
        earliestChangedOrderIndex: difference,
        outcomeChanges: calculateOutcomeChanges(previousLog, this.#log),
      }
      for (const subscriber of [...this.#subscribers]) {
        try { subscriber(structuredClone(event)) } catch { /* subscriber failures are local */ }
      }
      return event
    } catch (error) {
      candidateReader?.close()
      rollbackIfActive(this.#writer)
      if (!publishedMoved) {
        try {
          if (replayBaseRef !== null && replayBranch !== null && this.#writer.doltActiveBranch() === replayBranch) {
            this.#writer.doltResetHard(replayBaseRef)
          }
          this.#writer.doltCheckout(HEAD_BRANCH)
          if (replayBranch !== null) removeBranchIfPresent(this.#writer, replayBranch)
          if (revisionBranch !== null) removeBranchIfPresent(this.#writer, revisionBranch)
          if (newCheckpoint !== null) removeBranchIfPresent(this.#writer, newCheckpoint.branchRef)
        } catch { /* startup orphan cleanup is authoritative */ }
      }
      throw error
    } finally {
      this.#materializing = false
    }
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    this.#subscribers.clear()
    this.#reader.close()
    this.#writer.close()
  }

  async #applyTransaction(transaction: AdmittedTransaction, orderIndex: number): Promise<void> {
    this.#writer.exec('BEGIN IMMEDIATE')
    this.#writer.exec('SAVEPOINT chronolog_program')
    try {
      if (!bytesEqual(transaction.core.executionManifestDigest, this.#artifacts.executionManifestDigest)) {
        throw new DeterministicSqlRejection('EXECUTION_MANIFEST_DIGEST_MISMATCH', 'finalize')
      }
      compileSqlProgram(transaction.core.program)
      const resultLimits = sqlResultLimits(this.#executionManifest)
      const resultBudget = { rows: 0 }
      const preconditionResults = []
      for (const [index, precondition] of transaction.core.program.preconditions.entries()) {
        preconditionResults.push(await evaluateSqlPrecondition(
          this.#writer,
          precondition,
          index,
          this.#executionManifest.resources.maxQueryRows,
          this.#executionManifest.resources.maxResultBytes,
          {},
          resultLimits,
          resultBudget,
        ))
      }
      const statementResults = []
      for (const [index, statement] of transaction.core.program.body.entries()) {
        statementResults.push(executeSqlBodyStatement(
          this.#writer,
          statement,
          index,
          this.#executionManifest.resources.maxQueryRows,
          this.#executionManifest.resources.maxResultBytes,
          {},
          resultLimits,
          resultBudget,
        ))
        const partialEnvelope = encodeTransactionResultEnvelope({
          version: 1,
          preconditions: preconditionResults,
          statements: statementResults,
        })
        if (partialEnvelope.length > this.#executionManifest.resources.maxTransactionResultBytes) {
          throw new DeterministicSqlRejection('SQL_TRANSACTION_RESULT_BYTE_LIMIT', 'statement', null, null, index)
        }
      }
      const envelope: TransactionResultEnvelopeV1 = {
        version: 1,
        preconditions: preconditionResults,
        statements: statementResults,
      }
      const resultEnvelope = encodeTransactionResultEnvelope(envelope)
      verifyEnvelopeAgainstProgram(transaction.core.program, envelope)
      const resultDigest = await digestTransactionResultEnvelope(resultEnvelope)
      insertSystemLogRow(this.#writer, logRow(transaction, orderIndex, 'accepted', null, {
        resultEnvelopeVersion: 1,
        resultEnvelope,
        resultDigest,
      }))
      this.#writer.exec('RELEASE SAVEPOINT chronolog_program')
      this.#writer.exec('COMMIT')
    } catch (error) {
      const rejection = deterministicRejection(error)
      if (rejection === null) {
        rollbackIfActive(this.#writer)
        if (isOperationalSqliteError(error)) throw error
        throw error
      }
      if (!this.#executionManifest.errorCodes.includes(rejection.code)) {
        rollbackIfActive(this.#writer)
        throw new Error(`MATERIALIZER_UNREGISTERED_REJECTION_CODE:${rejection.code}`, { cause: error })
      }
      try {
        // Keep rejection recording in the same outer transaction. A full
        // ROLLBACK after checking out a replay branch can restore DoltLite's
        // previous branch working set, resurrecting later protected-log rows.
        // The savepoint rolls back every application mutation while preserving
        // the selected replay base and lets us commit the rejection atomically.
        this.#writer.exec('ROLLBACK TO SAVEPOINT chronolog_program')
        this.#writer.exec('RELEASE SAVEPOINT chronolog_program')
        insertSystemLogRow(this.#writer, logRow(
          transaction,
          orderIndex,
          rejection.failurePhase === 'precondition' ? 'rejected_precondition' : 'rejected_execution',
          rejection.code,
          rejection,
        ))
        this.#writer.exec('COMMIT')
      } catch (writeError) {
        rollbackIfActive(this.#writer)
        throw new Error(
          `MATERIALIZER_REJECTION_WRITE_FAILED:${errorMessage(error)}:${errorMessage(writeError)}`,
          { cause: writeError },
        )
      }
    }
  }

  #publicationFault(point: MaterializerPublicationFaultPoint): void {
    this.#sourceOptions.publicationFaultInjector?.(point)
  }

  #checkpointAtOrBefore(prefixLength: number): MaterializerCheckpointInfo | null {
    let selected: MaterializerCheckpointInfo | null = null
    for (const checkpoint of this.#checkpoints) {
      if (checkpoint.prefixLength <= prefixLength &&
          (selected === null || checkpoint.prefixLength > selected.prefixLength)) selected = checkpoint
    }
    return selected
  }

  #pruneCheckpoints(checkpoints: readonly MaterializerCheckpointInfo[]): MaterializerCheckpointInfo[] {
    const sorted = [...checkpoints].sort((left, right) => left.prefixLength - right.prefixLength)
    const genesis = sorted.find((checkpoint) => checkpoint.prefixLength === 0)
    const keep = sorted.slice(-Math.max(1, this.#options.retainCheckpoints - (genesis === undefined ? 0 : 1)))
    if (genesis !== undefined && !keep.some((checkpoint) => checkpoint.branchRef === genesis.branchRef)) keep.unshift(genesis)
    const retained = new Set(keep.map((checkpoint) => checkpoint.branchRef))
    for (const checkpoint of sorted) if (!retained.has(checkpoint.branchRef)) removeBranchIfPresent(this.#writer, checkpoint.branchRef)
    return keep
  }

  #assertRevision(atRevision: bigint | undefined): void {
    if (atRevision !== undefined && atRevision !== this.revision) {
      throw new MaterializerInputError('MATERIALIZER_REVISION_UNAVAILABLE')
    }
  }

  #assertOpen(): void { if (this.#closed) throw new Error('MATERIALIZER_CLOSED') }
}

interface Rejection {
  readonly code: string
  readonly failingPreconditionId: number | null
  readonly failingPreconditionIndex: number | null
  readonly failingStatementIndex: number | null
  readonly failurePhase: 'precondition' | 'statement' | 'finalize' | null
  readonly failingConstraintIdentity: Uint8Array | null
  readonly failingTriggerIdentity: Uint8Array | null
  readonly resultEnvelopeVersion: 1 | null
  readonly resultEnvelope: Uint8Array | null
  readonly resultDigest: Uint8Array | null
}

function initializeRepository(
  database: DatabaseLike,
  artifacts: ManifestArtifacts,
): PublishedRef {
  if (!isFreshRepository(database)) throw new Error('MATERIALIZER_RESERVED_HEAD_MISSING')
  database.exec('BEGIN IMMEDIATE')
  try {
    withAuthorizer(database, 'internal_bootstrap', () => {
      initializeSystemLog(database)
      insertExecutionManifest(database, storedManifest(artifacts))
    })
    verifyDatabaseState(database, artifacts)
    database.exec('COMMIT')
  } catch (error) {
    rollbackIfActive(database)
    throw error
  }
  const log = readSystemLog(database)
  const commitHash = database.doltCommit('chronolog genesis')
  createCheckpointRef(database, 0, 0n, commitHash, log)
  const published = createRevisionRef(database, 0n, 0, commitHash, log)
  publishRef(database, published)
  database.doltCheckout(HEAD_BRANCH)
  return published
}

function isFreshRepository(database: DatabaseLike): boolean {
  return database.prepare(`
    SELECT name FROM sqlite_schema
     WHERE type IN ('table', 'view', 'trigger', 'index')
       AND name NOT LIKE 'sqlite_%'
       AND name NOT LIKE 'dolt_%'
     LIMIT 1
  `).get() === undefined
}

function verifyDatabaseState(
  database: DatabaseLike,
  artifacts: ManifestArtifacts,
): void {
  verifyStoredManifest(readExecutionManifest(database), artifacts)
}

async function validateCheckpointRefs(
  database: DatabaseLike,
  published: PublishedRef,
  publishedLog: readonly TransactionLogRow[],
  artifacts: ManifestArtifacts,
  errorCodes: readonly string[],
): Promise<MaterializerCheckpointInfo[]> {
  const valid: MaterializerCheckpointInfo[] = []
  for (const checkpoint of discoverCheckpoints(database)) {
    const expectedDigest = orderDigest(publishedLog.slice(0, checkpoint.prefixLength))
    if (checkpoint.prefixLength > publishedLog.length || checkpointOrderDigest(checkpoint.branchRef) !== expectedDigest) {
      removeBranchIfPresent(database, checkpoint.branchRef)
      continue
    }
    let matches: boolean
    try {
      database.doltCheckout(checkpoint.branchRef)
      verifyStoredManifest(readExecutionManifest(database), artifacts)
      const checkpointLog = readSystemLog(database)
      await verifyLogResultIntegrity(checkpointLog, errorCodes)
      matches = checkpointLog.length === checkpoint.prefixLength && orderDigest(checkpointLog) === expectedDigest
    } catch { matches = false }
    database.doltCheckout(HEAD_BRANCH)
    if (!matches) {
      removeBranchIfPresent(database, checkpoint.branchRef)
      continue
    }
    valid.push(checkpoint)
  }
  database.doltCheckout(HEAD_BRANCH)
  if (!valid.some((checkpoint) => checkpoint.prefixLength === 0)) throw new Error('MATERIALIZER_GENESIS_CHECKPOINT_MISSING')
  verifyPublishedLog(published, publishedLog)
  return valid.sort((left, right) => left.prefixLength - right.prefixLength)
}

async function verifyLogResultIntegrity(log: readonly TransactionLogRow[], errorCodes: readonly string[]): Promise<void> {
  for (const row of log) {
    if (row.outcome === 'accepted') {
      if (
        row.rejectionCode !== null || row.failurePhase !== null ||
        row.failingPreconditionId !== null || row.failingPreconditionIndex !== null ||
        row.failingStatementIndex !== null || row.failingConstraintIdentity !== null ||
        row.failingTriggerIdentity !== null ||
        row.resultEnvelopeVersion !== 1 || row.resultEnvelope === null || row.resultDigest === null
      ) throw new Error('MATERIALIZER_CORRUPT_ACCEPTED_RESULT_RECORD')
      const envelope = decodeTransactionResultEnvelope(row.resultEnvelope)
      const core = decodeTransactionCore(row.canonicalCandidate)
      verifyEnvelopeAgainstProgram(core.program, envelope)
      if (!bytesEqual(encodeTransactionResultEnvelope(envelope), row.resultEnvelope)) {
        throw new Error('MATERIALIZER_NONCANONICAL_RESULT_ENVELOPE')
      }
      if (!bytesEqual(await digestTransactionResultEnvelope(row.resultEnvelope), row.resultDigest)) {
        throw new Error('MATERIALIZER_RESULT_DIGEST_MISMATCH')
      }
    } else if (
      row.rejectionCode === null || row.failurePhase === null ||
      row.resultEnvelopeVersion !== null || row.resultEnvelope !== null || row.resultDigest !== null
    ) {
      throw new Error('MATERIALIZER_CORRUPT_REJECTED_RESULT_RECORD')
    } else {
      if (!errorCodes.includes(row.rejectionCode)) throw new Error('MATERIALIZER_UNREGISTERED_REJECTION_CODE')
      if (row.failingConstraintIdentity !== null) {
        const identity = decodeCanonicalSchemaIdentity(row.failingConstraintIdentity)
        if (identity.objectKind !== 'constraint') throw new Error('MATERIALIZER_CORRUPT_CONSTRAINT_IDENTITY')
      }
      if (row.failingTriggerIdentity !== null) {
        const identity = decodeCanonicalSchemaIdentity(row.failingTriggerIdentity)
        if (identity.objectKind !== 'trigger') throw new Error('MATERIALIZER_CORRUPT_TRIGGER_IDENTITY')
      }
    }
  }
}

function verifyEnvelopeAgainstProgram(
  program: SqlTransactionProgram,
  envelope: TransactionResultEnvelopeV1,
): void {
  if (envelope.preconditions.length !== program.preconditions.length) {
    throw new Error('MATERIALIZER_RESULT_PRECONDITION_COUNT_MISMATCH')
  }
  for (const [index, result] of envelope.preconditions.entries()) {
    if (result.index !== index || result.id !== program.preconditions[index]!.id) {
      throw new Error('MATERIALIZER_RESULT_PRECONDITION_ID_MISMATCH')
    }
  }
  if (envelope.statements.length !== program.body.length) {
    throw new Error('MATERIALIZER_RESULT_STATEMENT_COUNT_MISMATCH')
  }
  for (const [index, result] of envelope.statements.entries()) {
    const compiled = compileSqlStatement(program.body[index]!, 'body')
    if (result.index !== index || result.statementClass !== compiled.statementClass) {
      throw new Error('MATERIALIZER_RESULT_STATEMENT_CLASS_MISMATCH')
    }
    if (compiled.producesResult !== (result.result !== null)) {
      throw new Error('MATERIALIZER_RESULT_PRESENCE_MISMATCH')
    }
    if (result.result !== null && (
      compiled.statementClass === 'insert' || compiled.statementClass === 'update' || compiled.statementClass === 'delete'
    ) && result.affectedRows !== BigInt(result.result.rows.length)) {
      throw new Error('MATERIALIZER_RETURNING_AFFECTED_COUNT_MISMATCH')
    }
  }
}

async function validateTransactionSet(transactions: readonly AdmittedTransaction[]): Promise<void> {
  let previous: TransactionOrderKey | null = null
  const seen = new Set<string>()
  for (const transaction of transactions) {
    if (transaction.txId.length === 0) throw new MaterializerInputError('MATERIALIZER_TRANSACTION_ID_INVALID')
    if (transaction.authorFeedSequence < 0n || transaction.authorFeedSequence > (1n << 63n) - 1n) {
      throw new MaterializerInputError('MATERIALIZER_AUTHOR_FEED_SEQUENCE_INVALID')
    }
    if (!bytesEqual(encodeTransactionCore(transaction.core), transaction.canonicalCandidate)) {
      throw new MaterializerInputError('MATERIALIZER_CANONICAL_CANDIDATE_MISMATCH')
    }
    if (!bytesEqual(await transactionDigest(transaction.canonicalCandidate), transaction.candidateDigest)) {
      throw new MaterializerInputError('MATERIALIZER_CANDIDATE_DIGEST_MISMATCH')
    }
    try { compileSqlProgram(transaction.core.program) } catch (error) {
      if (error instanceof SqlCompilerError) throw new MaterializerInputError(error.code)
      throw error
    }
    const key = orderKeyOf(transaction)
    if (previous !== null && compareTransactionOrder(previous, key) >= 0) {
      throw new MaterializerInputError('MATERIALIZER_ORDER_NOT_STRICT')
    }
    const txKey = idKey(transaction.txId)
    if (seen.has(txKey)) throw new MaterializerInputError('MATERIALIZER_DUPLICATE_TRANSACTION')
    seen.add(txKey)
    previous = key
  }
}

function validateExistingIdentities(
  existing: readonly TransactionLogRow[],
  transactions: readonly AdmittedTransaction[],
): void {
  const transactionsById = new Map(transactions.map((transaction) => [idKey(transaction.txId), transaction]))
  for (const row of existing) {
    const transaction = transactionsById.get(idKey(row.txId))
    if (transaction === undefined || !sameIdentity(row, transaction)) {
      throw new MaterializerInputError('MATERIALIZER_TRANSACTION_IDENTITY_CONFLICT')
    }
  }
}

function ensureMonotonicSet(previous: readonly Uint8Array[], next: readonly Uint8Array[]): void {
  let nextIndex = 0
  for (const previousId of previous) {
    while (nextIndex < next.length && !bytesEqual(previousId, next[nextIndex]!)) nextIndex += 1
    if (nextIndex === next.length) throw new MaterializerInputError('MATERIALIZER_ADMISSION_SET_REMOVAL')
    nextIndex += 1
  }
}

function verifyReplayBase(
  baseLog: readonly TransactionLogRow[],
  transactions: readonly AdmittedTransaction[],
  prefixLength: number,
): void {
  if (baseLog.length !== prefixLength) throw new Error('MATERIALIZER_CHECKPOINT_PREFIX_LENGTH_MISMATCH')
  for (let index = 0; index < prefixLength; index += 1) {
    if (!sameIdentity(baseLog[index]!, transactions[index]!)) throw new Error('MATERIALIZER_CHECKPOINT_PREFIX_MISMATCH')
  }
}

function verifyNextLogIndex(database: DatabaseLike, expectedIndex: number): void {
  const row = database.prepare(`
    SELECT count(*) AS row_count, max(order_index) AS maximum_index
      FROM chronolog_transactions
  `).get()
  if (row === undefined || Array.isArray(row)) throw new Error('MATERIALIZER_REPLAY_LOG_STATE_UNAVAILABLE')
  const count = Number(row.row_count)
  const maximum = row.maximum_index === null ? -1 : Number(row.maximum_index)
  if (count !== expectedIndex || maximum !== expectedIndex - 1) {
    throw new Error(`MATERIALIZER_REPLAY_LOG_DRIFT:${expectedIndex}:${count}:${maximum}`)
  }
}

function verifyDesiredLog(log: readonly TransactionLogRow[], transactions: readonly AdmittedTransaction[]): void {
  if (log.length !== transactions.length) throw new Error('MATERIALIZER_LOG_LENGTH_MISMATCH')
  for (let index = 0; index < log.length; index += 1) {
    if (log[index]!.orderIndex !== index || !sameIdentity(log[index]!, transactions[index]!)) {
      throw new Error('MATERIALIZER_LOG_ORDER_MISMATCH')
    }
  }
}

function sameIdentity(row: TransactionLogRow, transaction: AdmittedTransaction): boolean {
  return bytesEqual(row.txId, transaction.txId) &&
    bytesEqual(row.candidateDigest, transaction.candidateDigest) &&
    bytesEqual(row.canonicalCandidate, transaction.canonicalCandidate) &&
    bytesEqual(row.authorId, transaction.core.authorId) &&
    row.authorTimestampMs === transaction.core.authorTimestampMs &&
    row.authorFeedSequence === transaction.authorFeedSequence &&
    compareTransactionOrder(row.orderKey, orderKeyOf(transaction)) === 0
}

function shouldCheckpoint(
  checkpoints: readonly MaterializerCheckpointInfo[],
  prefixLength: number,
  interval: number,
): boolean {
  const nearest = checkpoints.reduce((max, checkpoint) => Math.max(max, checkpoint.prefixLength), 0)
  return prefixLength - nearest >= interval
}

function calculateOutcomeChanges(previous: readonly TransactionLogRow[], current: readonly TransactionLogRow[]): OutcomeChange[] {
  const previousById = new Map(previous.map((row) => [idKey(row.txId), row]))
  const changes: OutcomeChange[] = []
  for (const row of current) {
    const prior = previousById.get(idKey(row.txId))
    if (prior?.outcome !== row.outcome || prior.rejectionCode !== row.rejectionCode) {
      changes.push({
        txId: copyBytes(row.txId),
        previous: prior?.outcome ?? null,
        current: row.outcome,
        previousRejectionCode: prior?.rejectionCode ?? null,
        currentRejectionCode: row.rejectionCode,
      })
    }
  }
  return changes
}

function earliestDifference(previous: readonly Uint8Array[], next: readonly Uint8Array[]): number | null {
  const length = Math.min(previous.length, next.length)
  for (let index = 0; index < length; index += 1) if (!bytesEqual(previous[index]!, next[index]!)) return index
  return previous.length === next.length ? null : length
}

function deterministicRejection(error: unknown): Rejection | null {
  if (error instanceof DeterministicSqlRejection) {
    return {
      code: error.code,
      failingPreconditionId: error.preconditionId,
      failingPreconditionIndex: error.preconditionIndex,
      failingStatementIndex: error.statementIndex,
      failurePhase: error.phase,
      failingConstraintIdentity: error.constraintIdentity === null ? null : encodeCanonicalSchemaIdentity(error.constraintIdentity),
      failingTriggerIdentity: error.triggerIdentity === null ? null : encodeCanonicalSchemaIdentity(error.triggerIdentity),
      resultEnvelopeVersion: null,
      resultEnvelope: null,
      resultDigest: null,
    }
  }
  if (error instanceof SqlCompilerError) {
    return {
      code: error.code,
      failingPreconditionId: null,
      failingPreconditionIndex: null,
      failingStatementIndex: null,
      failurePhase: 'finalize',
      failingConstraintIdentity: null,
      failingTriggerIdentity: null,
      resultEnvelopeVersion: null,
      resultEnvelope: null,
      resultDigest: null,
    }
  }
  return null
}

function sqlCompilerDiagnostic(error: unknown) {
  if (error instanceof SqlCompilerError) return {
    code: error.code,
    ...(error.span === null ? {} : { startByte: error.span.startByte, endByte: error.span.endByte }),
  }
  return { code: error instanceof Error ? error.message : 'SQL_COMPILER_REJECTED' }
}

function logRow(
  transaction: AdmittedTransaction,
  orderIndex: number,
  outcome: TransactionOutcomeKind,
  rejectionCode: string | null,
  details: Partial<Rejection> = {},
) {
  return {
    txId: transaction.txId,
    orderIndex,
    authorId: transaction.core.authorId,
    authorTimestampMs: transaction.core.authorTimestampMs,
    authorFeedSequence: transaction.authorFeedSequence,
    candidateDigest: transaction.candidateDigest,
    canonicalCandidate: transaction.canonicalCandidate,
    outcome,
    rejectionCode,
    failingPreconditionId: details.failingPreconditionId ?? null,
    failingPreconditionIndex: details.failingPreconditionIndex ?? null,
    failingStatementIndex: details.failingStatementIndex ?? null,
    failurePhase: details.failurePhase ?? null,
    failingConstraintIdentity: details.failingConstraintIdentity ?? null,
    failingTriggerIdentity: details.failingTriggerIdentity ?? null,
    resultEnvelopeVersion: details.resultEnvelopeVersion ?? null,
    resultEnvelope: details.resultEnvelope ?? null,
    resultDigest: details.resultDigest ?? null,
  }
}

function storedManifest(artifacts: ManifestArtifacts): StoredExecutionManifest {
  return {
    manifestDigest: artifacts.executionManifestDigest,
    canonicalManifest: artifacts.canonicalExecutionManifest,
  }
}

function verifyStoredManifest(stored: StoredExecutionManifest, artifacts: ManifestArtifacts): void {
  if (!bytesEqual(stored.manifestDigest, artifacts.executionManifestDigest) ||
      !bytesEqual(stored.canonicalManifest, artifacts.canonicalExecutionManifest)) {
    throw new Error('DATABASE_MANIFEST_MISMATCH')
  }
}

function rollbackIfActive(database: DatabaseLike): void { if (database.inTransaction) database.exec('ROLLBACK') }
function orderKeyOf(transaction: AdmittedTransaction): TransactionOrderKey {
  return { authorTimestampMs: transaction.core.authorTimestampMs, authorId: copyBytes(transaction.core.authorId), authorFeedSequence: transaction.authorFeedSequence, txId: copyBytes(transaction.txId) }
}
function cloneTransaction(transaction: AdmittedTransaction): AdmittedTransaction { return structuredClone(transaction) }
function cloneLogRow(row: TransactionLogRow): TransactionLogRow { return structuredClone(row) }
function idKey(bytes: Uint8Array): string { return Buffer.from(bytes).toString('base64url') }
function bytesEqual(left: Uint8Array, right: Uint8Array): boolean { return left.length === right.length && left.every((value, index) => value === right[index]) }
function copyBytes(value: Uint8Array): Uint8Array { return Uint8Array.from(value) }
function validatePositiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new MaterializerInputError(`MATERIALIZER_INVALID_${name.toUpperCase()}`)
  return value
}
function sqlResultLimits(manifest: ExecutionManifest): SqlResultExecutionLimits {
  const resources = manifest.resources
  return {
    maxColumnsPerStatement: resources.maxResultColumnsPerStatement,
    maxRowsPerStatement: resources.maxResultRowsPerStatement,
    maxBytesPerStatement: resources.maxResultBytesPerStatement,
    maxTransactionRows: resources.maxTransactionResultRows,
    maxValueBytes: resources.maxResultValueBytes,
    maxSortWork: resources.maxResultSortWork,
    maxOrderedMutationTargets: resources.maxOrderedMutationTargets,
    maxOrderedMutationIdentityBytes: resources.maxOrderedMutationIdentityBytes,
    maxOrderedMutationBindings: resources.maxOrderedMutationBindings,
  }
}
function nonThrowingDiagnostic(error: unknown, fallback: string): string { return error instanceof Error && error.message.length > 0 ? error.message : fallback }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error) }
function resetActiveWorkingSet(database: DatabaseLike): void {
  const active = database.doltActiveBranch()
  const branch = database.doltBranches().find((entry) => entry.name === active)
  if (branch === undefined) throw new Error('MATERIALIZER_ACTIVE_BRANCH_MISSING')
  database.doltResetHard(branch.hash)
}
