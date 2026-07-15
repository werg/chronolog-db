import { createHash } from 'node:crypto'

import {
  CompilerError,
  compileManifestArtifacts,
  compileMutation,
  compileProgram,
  compileQuery,
  compileSchema,
  storageType,
  type CompiledSchema,
  type ManifestArtifacts,
  type TransactionContextValues,
} from '@chronolog/compiler-sqlite'
import {
  digestCanonicalQueryResult,
  validateQuery as validateIrQuery,
  validateTransactionProgram,
  type ExecutionManifest,
  type IrDiagnostic,
  type Mutation,
  type Query,
  type SchemaManifest,
} from '@chronolog/ir'
import {
  compareTransactionOrder,
  encodeTransactionCore,
  transactionDigest,
  type TransactionOrderKey,
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
import {
  DeterministicIrRejection,
  bindBackendParameters,
  evaluateCompiledPrecondition,
  executeCompiledMutation,
  executeCompiledQuery,
} from './ir-executor.js'
import { isOperationalSqliteError, withProfiledStatement } from './sql-profile.js'
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
  MaterializedIrQueryResult,
  MaterializedRevision,
  MaterializerBackendInfo,
  MaterializerCheckpointInfo,
  MaterializerIrBackend,
  MaterializerOptions,
  OutcomeChange,
  QueryExecutionContext,
  QueryIrOptions,
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

export class DeterministicMaterializer implements MaterializerIrBackend {
  readonly #writer: DatabaseLike
  #reader: DatabaseLike
  readonly #sourceOptions: MaterializerOptions
  readonly #options: Required<Pick<MaterializerOptions, 'checkpointEvery' | 'retainCheckpoints'>>
  readonly #backend: MaterializerBackendInfo
  readonly #compiledSchema: CompiledSchema
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
    compiledSchema: CompiledSchema,
    artifacts: ManifestArtifacts,
    published: PublishedRef,
    checkpoints: MaterializerCheckpointInfo[],
    log: TransactionLogRow[],
  ) {
    this.#writer = writer
    this.#reader = reader
    this.#sourceOptions = options
    this.#backend = backend
    this.#compiledSchema = compiledSchema
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
    const compiledSchema = compileSchema(options.schemaManifest, options.executionManifest)
    const artifacts = await compileManifestArtifacts(options.schemaManifest, options.executionManifest)
    const opened = openDatabase(options)
    let reader: DatabaseLike | null = null
    try {
      if (!bytesEqual(opened.backend.engineDigest, options.executionManifest.engineDigest)) {
        throw new MaterializerInputError('MATERIALIZER_ENGINE_DIGEST_MISMATCH')
      }
      let published = discoverPublishedRef(opened.database)
      if (published === null) {
        published = initializeRepository(opened.database, compiledSchema, artifacts)
      } else {
        resetActiveWorkingSet(opened.database)
        opened.database.doltCheckout(HEAD_BRANCH)
        verifyDatabaseState(opened.database, compiledSchema, artifacts)
      }
      const log = readSystemLog(opened.database)
      verifyPublishedLog(published, log)
      const checkpoints = validateCheckpointRefs(opened.database, published, log, artifacts)
      cleanupOrphanBranches(opened.database, published, checkpoints)

      const readerOpened = openDatabase(options)
      reader = readerOpened.database
      if (!bytesEqual(readerOpened.backend.engineDigest, options.executionManifest.engineDigest)) {
        throw new MaterializerInputError('MATERIALIZER_ENGINE_DIGEST_MISMATCH')
      }
      reader.doltCheckout(published.branchRef)
      verifyDatabaseState(reader, compiledSchema, artifacts)
      const readerLog = readSystemLog(reader)
      verifyPublishedLog(published, readerLog)
      if (reader.doltHashOf(published.branchRef) !== published.contentHash) {
        throw new Error('MATERIALIZER_READER_CONTENT_MISMATCH')
      }
      return new DeterministicMaterializer(
        opened.database,
        reader,
        options,
        opened.backend,
        compiledSchema,
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
  get schemaDigest(): Uint8Array { return copyBytes(this.#artifacts.schemaDigest) }
  get executionManifestDigest(): Uint8Array { return copyBytes(this.#artifacts.executionManifestDigest) }
  get schemaManifest(): SchemaManifest { return structuredClone(this.#compiledSchema.schema) }
  get executionManifest(): ExecutionManifest { return structuredClone(this.#compiledSchema.executionManifest) }
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
      failingCommandId: row.failingCommandId,
      failingRuleId: row.failingRuleId,
      failingConstraintId: row.failingConstraintId,
      resultDigest: row.resultDigest === null ? null : copyBytes(row.resultDigest),
    }
  }

  async queryIr(query: Query, options: QueryIrOptions = {}): Promise<MaterializedIrQueryResult> {
    this.#assertOpen()
    this.#assertRevision(options.atRevision)
    // Pin the observation metadata before executing. JavaScript does not
    // interleave synchronous query execution, but keeping this snapshot
    // explicit prevents a future asynchronous executor or digest refactor from
    // pairing rows from one immutable reader with another published revision.
    const observation = {
      revision: this.revision,
      orderLength: this.orderLength,
      schemaDigest: this.schemaDigest,
      executionManifestDigest: this.executionManifestDigest,
    }
    const diagnostics = this.validateQuery(query)
    if (diagnostics.length > 0) throw new MaterializerInputError(diagnostics[0]!.code)
    const compiled = compileQuery(query, this.#compiledSchema.catalog)
    const result = executeCompiledQuery(
      this.#reader,
      compiled,
      normalizeQueryContext(options.context),
      this.#compiledSchema.executionManifest.resources.maxQueryRows,
      this.#compiledSchema.executionManifest.resources.maxResultBytes,
      {},
    )
    const resultDigest = await digestCanonicalQueryResult(result)
    return {
      ...observation,
      result,
      resultDigest,
    }
  }

  query(query: Query, options: QueryIrOptions = {}): Promise<MaterializedIrQueryResult> {
    return this.queryIr(query, options)
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

  validateQuery(query: Query): readonly IrDiagnostic[] {
    const validation = validateIrQuery(query, {
      schema: this.#compiledSchema.schema,
      manifest: this.#compiledSchema.executionManifest,
    })
    if (!validation.ok) return validation.diagnostics
    try {
      compileQuery(query, this.#compiledSchema.catalog)
      return []
    } catch (error) {
      return [compilerDiagnostic(error, query.id)]
    }
  }

  validateMutation(mutation: Mutation): readonly IrDiagnostic[] {
    const validation = validateTransactionProgram({
      preconditions: [{
        kind: 'assert', id: 9_000_000_000_000_000,
        query: {
          id: 9_000_000_000_000_001,
          ctes: [], joins: [], groupBy: [], windows: [], compounds: [], orderBy: [],
          projection: [{
            id: 9_000_000_000_000_002,
            name: 'valid',
            expression: { kind: 'literal', id: 9_000_000_000_000_003, value: { kind: 'boolean', value: true } },
          }],
          resultMode: { kind: 'scalar' },
        },
        unknownIsFailure: true,
      }],
      mutations: [mutation],
    }, {
      schema: this.#compiledSchema.schema,
      manifest: this.#compiledSchema.executionManifest,
    })
    if (!validation.ok) return validation.diagnostics
    try {
      compileMutation(mutation, this.#compiledSchema.catalog)
      return []
    } catch (error) {
      return [compilerDiagnostic(error, mutation.id)]
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
      verifyDatabaseState(this.#writer, this.#compiledSchema, this.#artifacts)
      verifyReplayBase(readSystemLog(this.#writer), transactions, replayFrom)

      for (let index = replayFrom; index < transactions.length; index += 1) {
        verifyNextLogIndex(this.#writer, index)
        await this.#applyTransaction(transactions[index]!, index)
      }

      const candidateLog = readSystemLog(this.#writer)
      verifyDesiredLog(candidateLog, transactions)
      verifyDatabaseState(this.#writer, this.#compiledSchema, this.#artifacts)
      const commitHash = this.#writer.doltCommit(`chronolog revision ${nextRevision}`)
      const contentHash = this.#writer.doltHashOf(commitHash)
      if (contentHash !== this.#writer.doltHashOf()) throw new Error('MATERIALIZER_COMMIT_CONTENT_MISMATCH')

      const retainedBeforeInsertion = this.#checkpoints.filter(
        (entry) => isAppend || entry.prefixLength <= difference,
      )
      if (shouldCheckpoint(retainedBeforeInsertion, transactions.length, this.#options.checkpointEvery)) {
        newCheckpoint = createCheckpointRef(this.#writer, transactions.length, nextRevision, commitHash, candidateLog)
      }
      const nextPublished = createRevisionRef(this.#writer, nextRevision, transactions.length, commitHash, candidateLog)
      revisionBranch = nextPublished.branchRef
      if (nextPublished.contentHash !== contentHash) throw new Error('MATERIALIZER_REVISION_CONTENT_MISMATCH')

      const candidateOpened = openDatabase(this.#sourceOptions)
      candidateReader = candidateOpened.database
      candidateReader.doltCheckout(revisionBranch)
      verifyDatabaseState(candidateReader, this.#compiledSchema, this.#artifacts)
      const readerLog = readSystemLog(candidateReader)
      verifyPublishedLog(nextPublished, readerLog)
      if (candidateReader.doltHashOf(revisionBranch) !== contentHash) {
        throw new Error('MATERIALIZER_CANDIDATE_READER_CONTENT_MISMATCH')
      }

      publishRef(this.#writer, nextPublished)
      publishedMoved = true

      const oldReader = this.#reader
      this.#reader = candidateReader
      candidateReader = null
      this.#published = nextPublished
      this.#log = readerLog
      this.#order = transactions.map((transaction) => copyBytes(transaction.txId))
      oldReader.close()

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
        schemaDigest: this.schemaDigest,
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
      if (!bytesEqual(transaction.core.schemaDigest, this.#artifacts.schemaDigest)) {
        throw new DeterministicIrRejection('SCHEMA_DIGEST_MISMATCH')
      }
      if (!bytesEqual(transaction.core.executionManifestDigest, this.#artifacts.executionManifestDigest)) {
        throw new DeterministicIrRejection('EXECUTION_MANIFEST_DIGEST_MISMATCH')
      }
      const compiled = compileProgram(transaction.core.program, this.#compiledSchema.catalog)
      const context = contextOf(transaction)
      const preconditionDigests: Uint8Array[] = []
      for (const precondition of compiled.preconditions) {
        preconditionDigests.push(await evaluateCompiledPrecondition(
          this.#writer,
          precondition,
          context,
          this.#compiledSchema.executionManifest.resources.maxQueryRows,
          this.#compiledSchema.executionManifest.resources.maxResultBytes,
        ))
      }
      const affectedRows: bigint[] = []
      for (const mutation of compiled.mutations) {
        affectedRows.push(executeCompiledMutation(this.#writer, mutation, context))
      }
      const resultDigest = acceptedResultDigest(preconditionDigests, affectedRows)
      insertSystemLogRow(this.#writer, logRow(transaction, orderIndex, 'accepted', null, { resultDigest }))
      this.#writer.exec('RELEASE SAVEPOINT chronolog_program')
      this.#writer.exec('COMMIT')
    } catch (error) {
      const rejection = deterministicRejection(error)
      if (rejection === null) {
        rollbackIfActive(this.#writer)
        if (isOperationalSqliteError(error)) throw error
        throw error
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
          rejection.failingPreconditionId === null ? 'rejected_execution' : 'rejected_precondition',
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
  readonly failingCommandId: number | null
  readonly failingRuleId: number | null
  readonly failingConstraintId: number | null
  readonly resultDigest: Uint8Array | null
}

function initializeRepository(
  database: DatabaseLike,
  compiledSchema: CompiledSchema,
  artifacts: ManifestArtifacts,
): PublishedRef {
  if (!isFreshRepository(database)) throw new Error('MATERIALIZER_RESERVED_HEAD_MISSING')
  database.exec('BEGIN IMMEDIATE')
  try {
    initializeSystemLog(database)
    insertExecutionManifest(database, storedManifest(artifacts))
    for (const statement of compiledSchema.statements) {
      withProfiledStatement(database, statement.sql, 'internal_schema', (prepared) => {
        prepared.run(...bindBackendParameters(statement.parameters, {}))
      })
    }
    verifyDatabaseState(database, compiledSchema, artifacts)
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
  compiledSchema: CompiledSchema,
  artifacts: ManifestArtifacts,
): void {
  verifyStoredManifest(readExecutionManifest(database), artifacts)
  const actualObjects = database.prepare(`
    SELECT name, type FROM sqlite_schema
     WHERE type IN ('table', 'index', 'view', 'trigger')
       AND sql IS NOT NULL
       AND name NOT LIKE 'sqlite_%'
       AND name NOT LIKE 'dolt%'
       AND name NOT LIKE 'chronolog_%'
     ORDER BY name
  `).all().map((row) => {
    if (Array.isArray(row)) throw new Error('DATABASE_SCHEMA_MISMATCH')
    return `${String(row.type)}:${String(row.name)}`
  })
  const expectedObjects = compiledSchema.schema.objects.map((object) =>
    `${object.kind === 'table' ? 'table' : object.kind === 'index' ? 'index' : object.kind}:${object.name}`,
  ).sort()
  if (actualObjects.length !== expectedObjects.length ||
      actualObjects.some((value, index) => value !== expectedObjects[index])) {
    throw new Error('DATABASE_SCHEMA_MISMATCH')
  }
  for (const object of compiledSchema.schema.objects) {
    const expectedType = object.kind === 'table' ? 'table' : object.kind === 'index' ? 'index' : null
    if (expectedType === null) throw new Error('DATABASE_SCHEMA_OBJECT_UNSUPPORTED')
    const row = database.prepare('SELECT type FROM sqlite_schema WHERE name = ?').get(object.name)
    if (row === undefined || Array.isArray(row) || row.type !== expectedType) {
      throw new Error('DATABASE_SCHEMA_MISMATCH')
    }
    if (object.kind === 'table') {
      const columns = database.prepare(`PRAGMA table_info("${object.name}")`).all()
      if (columns.length !== object.columns.length) throw new Error('DATABASE_SCHEMA_MISMATCH')
      for (const column of object.columns) {
        const actual = columns.find((item) => !Array.isArray(item) && item.name === column.name)
        if (actual === undefined || Array.isArray(actual) ||
            String(actual.type).toUpperCase() !== storageType(column.valueType.logical)) {
          throw new Error('DATABASE_SCHEMA_MISMATCH')
        }
      }
    }
  }
}

function validateCheckpointRefs(
  database: DatabaseLike,
  published: PublishedRef,
  publishedLog: readonly TransactionLogRow[],
  artifacts: ManifestArtifacts,
): MaterializerCheckpointInfo[] {
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

function contextOf(transaction: AdmittedTransaction): TransactionContextValues {
  return {
    group_id: copyBytes(transaction.core.groupId),
    membership_revision: copyBytes(transaction.core.membershipRevision),
    validation_policy: copyBytes(transaction.core.validationPolicy),
    author_id: copyBytes(transaction.core.authorId),
    author_timestamp_ms: transaction.core.authorTimestampMs,
    transaction_nonce: copyBytes(transaction.core.nonce),
    candidate_digest: copyBytes(transaction.candidateDigest),
    transaction_id: copyBytes(transaction.txId),
    author_feed_sequence: transaction.authorFeedSequence,
  }
}

function normalizeQueryContext(context: QueryExecutionContext | undefined): Partial<TransactionContextValues> {
  if (context === undefined) return {}
  return {
    ...(context.group_id === undefined && context.groupId === undefined ? {} : { group_id: copyBytes(context.group_id ?? context.groupId!) }),
    ...(context.membership_revision === undefined && context.membershipRevision === undefined ? {} : { membership_revision: copyBytes(context.membership_revision ?? context.membershipRevision!) }),
    ...(context.validation_policy === undefined && context.validationPolicy === undefined ? {} : { validation_policy: copyBytes(context.validation_policy ?? context.validationPolicy!) }),
    ...(context.author_id === undefined && context.authorId === undefined ? {} : { author_id: copyBytes(context.author_id ?? context.authorId!) }),
    ...(context.author_timestamp_ms === undefined && context.authorTimestampMs === undefined ? {} : { author_timestamp_ms: context.author_timestamp_ms ?? context.authorTimestampMs! }),
    ...(context.transaction_nonce === undefined && context.transactionNonce === undefined ? {} : { transaction_nonce: copyBytes(context.transaction_nonce ?? context.transactionNonce!) }),
    ...(context.candidate_digest === undefined && context.candidateDigest === undefined ? {} : { candidate_digest: copyBytes(context.candidate_digest ?? context.candidateDigest!) }),
    ...(context.transaction_id === undefined && context.transactionId === undefined ? {} : { transaction_id: copyBytes(context.transaction_id ?? context.transactionId!) }),
    ...(context.author_feed_sequence === undefined && context.authorFeedSequence === undefined ? {} : { author_feed_sequence: context.author_feed_sequence ?? context.authorFeedSequence! }),
  }
}

function acceptedResultDigest(preconditions: readonly Uint8Array[], affectedRows: readonly bigint[]): Uint8Array {
  const hash = createHash('sha256').update('chronolog-accepted-result-v1\0', 'utf8')
  for (const digest of preconditions) hash.update(digest)
  for (const count of affectedRows) {
    const text = Buffer.from(count.toString(10), 'utf8')
    const length = Buffer.allocUnsafe(4)
    length.writeUInt32BE(text.length)
    hash.update(length).update(text)
  }
  return Uint8Array.from(hash.digest())
}

function deterministicRejection(error: unknown): Rejection | null {
  if (error instanceof DeterministicIrRejection) {
    return {
      code: error.code,
      failingPreconditionId: error.failingPreconditionId,
      failingCommandId: error.failingCommandId,
      failingRuleId: null,
      failingConstraintId: error.failingConstraintId,
      resultDigest: null,
    }
  }
  if (error instanceof CompilerError) {
    return {
      code: error.code,
      failingPreconditionId: error.attribution === 'precondition' ? error.nodeId : null,
      failingCommandId: error.attribution === 'command' ? error.nodeId : null,
      failingRuleId: null,
      failingConstraintId: error.attribution === 'constraint' ? error.nodeId : null,
      resultDigest: null,
    }
  }
  return null
}

function compilerDiagnostic(error: unknown, fallbackNodeId: number): IrDiagnostic {
  if (error instanceof CompilerError) return { code: error.code, message: error.code, nodeId: error.nodeId ?? fallbackNodeId }
  if (error instanceof Error) return { code: 'IR_COMPILER_REJECTED', message: error.message, nodeId: fallbackNodeId }
  return { code: 'IR_COMPILER_REJECTED', message: 'IR compiler rejected the node', nodeId: fallbackNodeId }
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
    failingCommandId: details.failingCommandId ?? null,
    failingRuleId: details.failingRuleId ?? null,
    failingConstraintId: details.failingConstraintId ?? null,
    resultDigest: details.resultDigest ?? null,
  }
}

function storedManifest(artifacts: ManifestArtifacts): StoredExecutionManifest {
  return {
    manifestDigest: artifacts.executionManifestDigest,
    canonicalManifest: artifacts.canonicalExecutionManifest,
    schemaDigest: artifacts.schemaDigest,
    canonicalSchema: artifacts.canonicalSchema,
  }
}

function verifyStoredManifest(stored: StoredExecutionManifest, artifacts: ManifestArtifacts): void {
  if (!bytesEqual(stored.manifestDigest, artifacts.executionManifestDigest) ||
      !bytesEqual(stored.canonicalManifest, artifacts.canonicalExecutionManifest) ||
      !bytesEqual(stored.schemaDigest, artifacts.schemaDigest) ||
      !bytesEqual(stored.canonicalSchema, artifacts.canonicalSchema)) {
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
function nonThrowingDiagnostic(error: unknown, fallback: string): string { return error instanceof Error && error.message.length > 0 ? error.message : fallback }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error) }
function resetActiveWorkingSet(database: DatabaseLike): void {
  const active = database.doltActiveBranch()
  const branch = database.doltBranches().find((entry) => entry.name === active)
  if (branch === undefined) throw new Error('MATERIALIZER_ACTIVE_BRANCH_MISSING')
  database.doltResetHard(branch.hash)
}
