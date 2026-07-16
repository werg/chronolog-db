import type { LogicalValue } from '@chronolog/ir'
import {
  decodeCanonicalSqlResult,
  decodeTransactionResultEnvelope,
  digestTransactionResultEnvelope,
  encodeSqlBindingValue,
  numberToSqlRealBinding,
  type CanonicalSqlColumn,
  type CanonicalSqlResult,
  type CanonicalSqlValue,
  type SqlBindingValue,
  type SqlResultMode,
  type TransactionResultEnvelopeV1,
} from '@chronolog/protocol'
import {
  ChronologRpcError,
  isChronologRpcError,
  type BeginDraftResponse,
  type LiveSqlEvent,
  type NodeStatus,
  type PublishDraftResponse,
  type RebaseDraftResponse,
  type ReplicationStatus,
  type RevisionMetadata,
  type RpcCallOptions,
  type RpcSqlStatement,
  type RpcTransport,
  type SettlementEvidence,
  type SqlDiagnostic,
  type TransactionOutcome,
  type UnaryRequest,
  type UnaryResponse,
  type UnaryRpcMethod,
  type ValidatorWatermark,
} from '@chronolog/rpc'

import {
  decodeLocalSqlResult,
  encodeCompiledLocalSqlQuery,
  encodeLocalSqlParameters,
  type CompiledLocalSqlQuery,
  type DecodedLocalSqlResult,
  type LocalSqlInput,
} from './local-sql.js'
import { StreamResource } from './stream-resource.js'
import { blob, boolean, int64, text, timestampMsFromDate, type LogicalInput } from './values.js'

export interface GeneratedSchemaBindings {
  readonly executionManifestDigest: string
}

export interface ChronologClientOptions {
  readonly transport: RpcTransport
  readonly groupId: string
  readonly bindings?: GeneratedSchemaBindings
  readonly token?: string
  readonly requestId?: () => string
  readonly unaryRetryAttempts?: number
  readonly streamRetryDelayMs?: (attempt: number) => number
}

export interface QueryOptions {
  readonly signal?: AbortSignal
  readonly maxRows?: number
  readonly atRevision?: string
}

export interface LocalSqlQueryResponse {
  readonly revision: RevisionMetadata
  readonly result: DecodedLocalSqlResult
}

export interface LiveQueryValue {
  readonly type: LiveSqlEvent['type']
  readonly revision: RevisionMetadata
  readonly queryDigest: string
  readonly result?: DecodedLocalSqlResult
  readonly resetReason?: Extract<LiveSqlEvent, { type: 'reset' }>['reason']
}

export interface TransactionOptions {
  readonly signal?: AbortSignal
  readonly atRevision?: string
  readonly ttlMs?: number
  readonly idempotencyKey?: string
}

export interface DraftCommandOptions { readonly applicationLabel?: string }
export interface DraftObserveOptions extends DraftCommandOptions { readonly resultMode?: SqlResultMode }

export type ClientSqlValue = null | boolean | bigint | number | string | Uint8Array | Date | LogicalInput
export type ClientSqlBindings = readonly ClientSqlValue[] | Readonly<Record<string, ClientSqlValue>>

/** Structural shape emitted by common SQLite query builders. */
export interface CompiledSqlStatement {
  readonly sql: string
  readonly parameters?: ClientSqlBindings
}

export type DecodedSqlValue = null | bigint | number | string | Uint8Array | LogicalValue |
  Extract<CanonicalSqlValue, { readonly kind: 'registered' }>
export interface DecodedSqlResult {
  readonly mode: SqlResultMode
  readonly columns: readonly CanonicalSqlColumn[]
  readonly rows: readonly (readonly DecodedSqlValue[])[]
  readonly raw: CanonicalSqlResult
}

export class ClientManifestMismatchError extends Error {
  readonly code = 'CLIENT_EXECUTION_MANIFEST_MISMATCH'
  constructor(
    readonly expectedExecutionManifestDigest: string,
    readonly actualExecutionManifestDigest: string,
  ) {
    super('Generated bindings do not match the node execution manifest')
    this.name = 'ClientManifestMismatchError'
  }
}

interface ObservationProvenance {
  readonly draftId: string
  readonly generation: number
  readonly observationId: string
  readonly observationToken: string
}

const observationProvenance = new WeakMap<object, ObservationProvenance>()

export class ObservedSqlResult {
  constructor(
    readonly statement: CompiledSqlStatement,
    readonly result: DecodedSqlResult,
    readonly revision: RevisionMetadata,
    readonly resultDigest: string,
    provenance: ObservationProvenance,
  ) {
    observationProvenance.set(this, provenance)
    Object.freeze(this)
  }
}

export class DraftStatementHandle {
  #index: number | null
  constructor(readonly draftId: string, index: number) { this.#index = index }
  get statementIndex(): number {
    if (this.#index === null) throw new TypeError('Draft statement handle is no longer valid')
    return this.#index
  }
  _invalidate(): void { this.#index = null }
}

export interface TransactionResultSnapshot {
  readonly revision: RevisionMetadata
  readonly digest: string
  readonly envelope: TransactionResultEnvelopeV1
}

export class TransactionHandle {
  readonly outcome: StreamResource<TransactionOutcome>
  readonly evidence: StreamResource<SettlementEvidence>
  readonly result: StreamResource<TransactionResultSnapshot | null>

  constructor(
    readonly client: ChronologClient,
    readonly publication: PublishDraftResponse,
    readonly draftId: string,
  ) {
    this.outcome = client.transactionOutcome(publication.transactionId)
    this.evidence = client.settlementEvidence(publication.transactionId)
    this.result = client.transactionResult(publication.transactionId)
  }

  get transactionId(): string { return this.publication.transactionId }

  async getResult(options: { readonly atMaterializedRevision?: string } = {}): Promise<TransactionResultSnapshot> {
    return this.client.getTransactionResult(this.transactionId, options)
  }

  statement(snapshot: TransactionResultSnapshot, handle: DraftStatementHandle) {
    if (handle.draftId !== this.draftId) throw new TypeError('Statement handle belongs to a different transaction draft')
    const statement = snapshot.envelope.statements[handle.statementIndex]
    if (statement === undefined) throw new TypeError('Statement handle does not belong to this accepted result')
    return statement
  }

  dispose(): void { this.outcome.dispose(); this.evidence.dispose(); this.result.dispose() }
  [Symbol.dispose](): void { this.dispose() }
}

export class TransactionDraft {
  readonly #client: ChronologClient
  readonly #draft: BeginDraftResponse
  #tail: Promise<void> = Promise.resolve()
  #failed: unknown
  #pinnedRevision: RevisionMetadata
  #generation = 0
  #preconditionCount = 0
  #statementCount = 0
  readonly #invalidatedObservations = new Set<string>()
  readonly #handles: DraftStatementHandle[] = []

  constructor(client: ChronologClient, draft: BeginDraftResponse) {
    this.#client = client
    this.#draft = draft
    this.#pinnedRevision = draft.pinnedRevision
  }

  get id(): string { return this.#draft.draftId }
  get pinnedRevision(): RevisionMetadata { return this.#pinnedRevision }
  get reservedAuthorTimestampMs(): bigint { return BigInt(this.#draft.reservedAuthorTimestampMs) }
  get transactionNonce(): Uint8Array { return fromBase64Url(this.#draft.transactionNonce) }

  observe(sql: string, bindings?: ClientSqlBindings, options?: DraftObserveOptions): Promise<ObservedSqlResult>
  observe(statement: CompiledSqlStatement, options?: DraftObserveOptions): Promise<ObservedSqlResult>
  observe(
    input: string | CompiledSqlStatement,
    bindingsOrOptions: ClientSqlBindings | DraftObserveOptions = [],
    inputOptions: DraftObserveOptions = {},
  ): Promise<ObservedSqlResult> {
    const compiled = typeof input === 'string'
      ? { sql: input, parameters: bindingsOrOptions as ClientSqlBindings }
      : input
    const options = typeof input === 'string' ? inputOptions : bindingsOrOptions as DraftObserveOptions
    return this.#enqueueResult(async () => {
      const response = await this.#client._unary('transaction.observeSql', {
        groupId: this.#client.groupId,
        draftId: this.id,
        requestId: this.#client._requestId(),
        statement: encodeConsensusStatement(compiled),
        resultMode: options.resultMode ?? 'ordered',
        ...(options.applicationLabel === undefined ? {} : { applicationLabel: options.applicationLabel }),
      })
      this.#client._assertCompatibility(response.revision)
      const result = decodeSqlResult(decodeCanonicalSqlResult(fromBase64Url(response.canonicalResult)))
      return new ObservedSqlResult(
        {
          sql: response.statement.sql,
          ...(compiled.parameters === undefined ? {} : { parameters: compiled.parameters }),
        },
        result,
        response.revision,
        response.resultDigest,
        {
          draftId: this.id,
          generation: this.#generation,
          observationId: response.observationId,
          observationToken: response.observationToken,
        },
      )
    })
  }

  expect(observed: ObservedSqlResult, options: DraftCommandOptions = {}): this {
    const provenance = observationProvenance.get(observed)
    if (provenance === undefined || provenance.draftId !== this.id) throw new TypeError('An observation can only be expected by its originating draft')
    if (provenance.generation !== this.#generation || this.#invalidatedObservations.has(provenance.observationId)) {
      throw new TypeError('Observation was invalidated by draft rebase')
    }
    this.#preconditionCount += 1
    this.#enqueue(async () => {
      await this.#client._unary('transaction.addPrecondition', {
        groupId: this.#client.groupId,
        draftId: this.id,
        requestId: this.#client._requestId(),
        source: { kind: 'observation', observationId: provenance.observationId, observationToken: provenance.observationToken },
        ...(options.applicationLabel === undefined ? {} : { applicationLabel: options.applicationLabel }),
      })
    })
    return this
  }

  assert(sql: string, bindings: ClientSqlBindings = [], options: DraftCommandOptions = {}): this {
    this.#preconditionCount += 1
    this.#enqueue(async () => {
      await this.#client._unary('transaction.addPrecondition', {
        groupId: this.#client.groupId,
        draftId: this.id,
        requestId: this.#client._requestId(),
        source: { kind: 'assert_true', id: nextClientPreconditionId(), statement: encodeConsensusStatement({ sql, parameters: bindings }) },
        ...(options.applicationLabel === undefined ? {} : { applicationLabel: options.applicationLabel }),
      })
    })
    return this
  }

  exec(sql: string, bindings?: ClientSqlBindings): DraftStatementHandle
  exec(statement: CompiledSqlStatement): DraftStatementHandle
  exec(statements: readonly CompiledSqlStatement[]): readonly DraftStatementHandle[]
  exec(
    input: string | CompiledSqlStatement | readonly CompiledSqlStatement[],
    bindings: ClientSqlBindings = [],
  ): DraftStatementHandle | readonly DraftStatementHandle[] {
    const statements = typeof input === 'string'
      ? [{ sql: input, parameters: bindings }]
      : Array.isArray(input) ? input : [input as CompiledSqlStatement]
    const handles = statements.map((_, offset) => new DraftStatementHandle(this.id, this.#statementCount + offset))
    this.#handles.push(...handles)
    this.#statementCount += statements.length
    this.#enqueue(async () => {
      await this.#client._unary('transaction.addStatements', {
        groupId: this.#client.groupId,
        draftId: this.id,
        requestId: this.#client._requestId(),
        statements: statements.map(encodeConsensusStatement),
      })
    })
    return Array.isArray(input) ? handles : handles[0]!
  }

  validate(): Promise<readonly SqlDiagnostic[]> {
    return this.#enqueueResult(async () => (await this.#client._unary('transaction.validateDraft', {
      groupId: this.#client.groupId,
      draftId: this.id,
      requestId: this.#client._requestId(),
    })).diagnostics)
  }

  rebase(options: { readonly toRevision?: string; readonly refreshObservations?: boolean; readonly renewContext?: boolean } = {}): Promise<RebaseDraftResponse> {
    return this.#enqueueResult(async () => {
      const refresh = options.refreshObservations ?? false
      const response = await this.#client._unary('transaction.rebaseDraft', {
        groupId: this.#client.groupId,
        draftId: this.id,
        requestId: this.#client._requestId(),
        refreshObservations: refresh,
        renewContext: options.renewContext ?? false,
        ...(options.toRevision === undefined ? {} : { toRevision: options.toRevision }),
      })
      this.#client._assertCompatibility(response.pinnedRevision)
      this.#pinnedRevision = response.pinnedRevision
      for (const id of response.invalidatedObservationIds) this.#invalidatedObservations.add(id)
      if (!refresh) this.#generation += 1
      return response
    })
  }

  async _flushAndValidate(): Promise<void> {
    await this.#tail
    if (this.#failed !== undefined) throw errorFromUnknown(this.#failed)
    if (this.#preconditionCount === 0) throw new TypeError('Every transaction requires a precondition')
    if (this.#statementCount === 0) throw new TypeError('Every transaction requires a body statement')
    const diagnostics = await this.validate()
    await this.#tail
    const error = diagnostics.find((diagnostic) => diagnostic.severity === 'error')
    if (error !== undefined) throw new ChronologRpcError('protocol_rejected', error.code, { details: { code: error.code } })
  }

  _invalidateHandles(): void { for (const handle of this.#handles) handle._invalidate() }

  #enqueue(operation: () => Promise<void>): void { void this.#enqueueResult(operation).catch(() => undefined) }
  #enqueueResult<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(async () => {
      if (this.#failed !== undefined) throw errorFromUnknown(this.#failed)
      return operation()
    })
    this.#tail = result.then(() => undefined, (error: unknown) => { if (this.#failed === undefined) this.#failed = error })
    return result
  }
}

export class ChronologClient {
  readonly groupId: string
  readonly #transport: RpcTransport
  readonly #bindings?: GeneratedSchemaBindings
  readonly #token?: string
  readonly #idFactory: () => string
  readonly #unaryRetryAttempts: number
  readonly #streamRetryDelayMs?: (attempt: number) => number
  readonly #resources = new Set<{ dispose(): void }>()
  #closed = false

  constructor(options: ChronologClientOptions) {
    this.groupId = options.groupId
    this.#transport = options.transport
    if (options.bindings !== undefined) this.#bindings = options.bindings
    if (options.token !== undefined) this.#token = options.token
    this.#idFactory = options.requestId ?? (() => crypto.randomUUID())
    this.#unaryRetryAttempts = options.unaryRetryAttempts ?? 2
    if (options.streamRetryDelayMs !== undefined) this.#streamRetryDelayMs = options.streamRetryDelayMs
  }

  async query(sql: string, bindings: readonly LocalSqlInput[] = [], options: QueryOptions = {}): Promise<LocalSqlQueryResponse> {
    const response = await this._unary('query.localSql', {
      groupId: this.groupId,
      requestId: this._requestId(),
      sql,
      parameters: encodeLocalSqlParameters(bindings),
      ...(options.maxRows === undefined ? {} : { maxRows: options.maxRows }),
      ...(options.atRevision === undefined ? {} : { atRevision: options.atRevision }),
    }, options.signal === undefined ? {} : { signal: options.signal })
    this._assertCompatibility(response.revision)
    return { revision: response.revision, result: decodeLocalSqlResult(response.result) }
  }

  async queryCompiled(query: CompiledLocalSqlQuery, options: QueryOptions = {}): Promise<LocalSqlQueryResponse> {
    const compiled = encodeCompiledLocalSqlQuery(query)
    return this.query(compiled.sql, compiled.parameters, options)
  }

  liveQuery(sql: string, bindings: readonly LocalSqlInput[] = [], options: Omit<QueryOptions, 'atRevision'> = {}): StreamResource<LiveQueryValue> {
    const requestId = this._requestId()
    const parameters = encodeLocalSqlParameters(bindings)
    let queryDigest: string | undefined
    return this.#track(new StreamResource({
      open: (cursor, signal) => mapAsync(
        this.#transport.stream('query.liveSql', {
          groupId: this.groupId,
          requestId,
          sql,
          parameters,
          ...(options.maxRows === undefined ? {} : { maxRows: options.maxRows }),
          ...(cursor === undefined || queryDigest === undefined ? {} : { resume: { groupId: this.groupId, queryDigest, eventSetRevision: cursor } }),
        }, this.#callOptions(signal)),
        (event): LiveQueryValue => {
          this._assertCompatibility(event.revision)
          queryDigest = event.queryDigest
          return {
            type: event.type,
            revision: event.revision,
            queryDigest: event.queryDigest,
            ...(event.result === undefined ? {} : { result: decodeLocalSqlResult(event.result) }),
            ...(event.type === 'reset' ? { resetReason: event.reason } : {}),
          }
        },
      ),
      cursor: (value) => value.revision.eventSetRevision,
      ...(this.#streamRetryDelayMs === undefined ? {} : { retryDelayMs: this.#streamRetryDelayMs }),
    }))
  }

  async transaction(build: (draft: TransactionDraft) => void | Promise<void>, options: TransactionOptions = {}): Promise<TransactionHandle> {
    const begin = await this._unary('transaction.beginDraft', {
      groupId: this.groupId,
      requestId: this._requestId(),
      ...(options.atRevision === undefined ? {} : { atRevision: options.atRevision }),
      ...(options.ttlMs === undefined ? {} : { ttlMs: options.ttlMs }),
    }, options.signal === undefined ? {} : { signal: options.signal })
    this._assertCompatibility(begin.pinnedRevision)
    const draft = new TransactionDraft(this, begin)
    try {
      await build(draft)
      await draft._flushAndValidate()
      const publication = await this._unary('transaction.publishDraft', {
        groupId: this.groupId,
        draftId: begin.draftId,
        requestId: this._requestId(),
        idempotencyKey: options.idempotencyKey ?? this._requestId(),
      }, options.signal === undefined ? {} : { signal: options.signal })
      this.#assertManifest(publication.executionManifestDigest)
      return new TransactionHandle(this, publication, begin.draftId)
    } catch (error) {
      draft._invalidateHandles()
      await this._unary('transaction.cancelDraft', { groupId: this.groupId, draftId: begin.draftId, requestId: this._requestId() }).catch(() => undefined)
      throw error
    }
  }

  async getTransactionOutcome(transactionId: string): Promise<TransactionOutcome> {
    return this._unary('transaction.getOutcome', { groupId: this.groupId, transactionId, requestId: this._requestId() })
  }

  async getTransactionResult(transactionId: string, options: { readonly atMaterializedRevision?: string } = {}): Promise<TransactionResultSnapshot> {
    const response = await this._unary('transaction.getResult', {
      groupId: this.groupId,
      transactionId,
      requestId: this._requestId(),
      ...(options.atMaterializedRevision === undefined ? {} : { atMaterializedRevision: options.atMaterializedRevision }),
    })
    this._assertCompatibility(response.revision)
    const bytes = fromBase64Url(response.canonicalEnvelope)
    if (bytes.byteLength !== response.reference.byteLength) {
      throw new ChronologRpcError('protocol_rejected', 'Transaction result byte length mismatch')
    }
    const digest = toBase64Url(await digestTransactionResultEnvelope(bytes))
    if (digest !== response.reference.digest) {
      throw new ChronologRpcError('protocol_rejected', 'Transaction result digest mismatch')
    }
    return {
      revision: response.revision,
      digest: response.reference.digest,
      envelope: decodeTransactionResultEnvelope(bytes),
    }
  }

  transactionResult(transactionId: string): StreamResource<TransactionResultSnapshot | null> {
    const requestId = this._requestId()
    let outcomeCursor: string | undefined
    return this.#track(new StreamResource({
      open: (cursor, signal) => mapAsyncAwait(
        this.#transport.stream('transaction.streamOutcome', {
          groupId: this.groupId,
          transactionId,
          requestId,
          ...(cursor === undefined ? {} : { resumeAfterEventSetRevision: cursor }),
        }, this.#callOptions(signal)),
        async (outcome): Promise<TransactionResultSnapshot | null> => {
          outcomeCursor = outcome.eventSetRevision
          if (outcome.outcome.type !== 'accepted') return null
          try {
            return await this.getTransactionResult(transactionId, { atMaterializedRevision: outcome.materializedRevision })
          } catch (error) {
            if (isChronologRpcError(error) && error.code === 'revision_not_retained') return null
            throw error
          }
        },
      ),
      // Resume the source outcome stream from the event that was consumed,
      // including when its accepted result revision was no longer retained.
      cursor: () => outcomeCursor,
      ...(this.#streamRetryDelayMs === undefined ? {} : { retryDelayMs: this.#streamRetryDelayMs }),
    }))
  }

  transactionOutcome(transactionId: string): StreamResource<TransactionOutcome> {
    const requestId = this._requestId()
    return this.#revisionStream(
      (cursor, signal) => this.#transport.stream('transaction.streamOutcome', {
        groupId: this.groupId,
        transactionId,
        requestId,
        ...(cursor === undefined ? {} : { resumeAfterEventSetRevision: cursor }),
      }, this.#callOptions(signal)),
      (outcome) => outcome.eventSetRevision,
    )
  }

  async getSettlementEvidence(transactionId: string): Promise<SettlementEvidence> {
    return this._unary('evidence.getSettlement', { groupId: this.groupId, transactionId, requestId: this._requestId() })
  }

  settlementEvidence(transactionId: string): StreamResource<SettlementEvidence> {
    const requestId = this._requestId()
    return this.#revisionStream(
      (cursor, signal) => this.#transport.stream('evidence.streamSettlement', {
        groupId: this.groupId,
        transactionId,
        requestId,
        ...(cursor === undefined ? {} : { resumeAfterEventSetRevision: cursor }),
      }, this.#callOptions(signal)),
      (evidence) => evidence.evidenceRevision,
    )
  }

  async validatorWatermark(): Promise<ValidatorWatermark> {
    return this._unary('evidence.getValidatorWatermark', { groupId: this.groupId, requestId: this._requestId() })
  }

  async getReplicationStatus(): Promise<ReplicationStatus> {
    return this._unary('node.getReplicationStatus', { groupId: this.groupId, requestId: this._requestId() })
  }

  replicationStatus(): StreamResource<ReplicationStatus> {
    const requestId = this._requestId()
    return this.#revisionStream(
      (cursor, signal) => this.#transport.stream('node.streamReplicationStatus', {
        groupId: this.groupId,
        requestId,
        ...(cursor === undefined ? {} : { resumeAfterEventSetRevision: cursor }),
      }, this.#callOptions(signal)),
      (status) => status.revision,
    )
  }

  async getStatus(): Promise<NodeStatus> {
    const status = await this._unary('node.getStatus', { groupId: this.groupId, requestId: this._requestId() })
    if (status.revision !== undefined) this._assertCompatibility(status.revision)
    return status
  }

  status(): StreamResource<NodeStatus> {
    const requestId = this._requestId()
    return this.#revisionStream(
      (cursor, signal) => mapAsync(this.#transport.stream('node.streamStatus', {
        groupId: this.groupId,
        requestId,
        ...(cursor === undefined ? {} : { resumeAfterEventSetRevision: cursor }),
      }, this.#callOptions(signal)), (status) => { if (status.revision !== undefined) this._assertCompatibility(status.revision); return status }),
      (status) => status.revision?.eventSetRevision,
    )
  }

  queryResourceKey(sql: string, bindings: readonly LocalSqlInput[] = []): string {
    return `${sql}\0${stableClientValue(bindings)}`
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    for (const resource of this.#resources) resource.dispose()
    this.#resources.clear()
    await this.#transport.close?.()
  }

  _requestId(): string { return this.#idFactory() }
  _assertCompatibility(revision: RevisionMetadata): void { this.#assertManifest(revision.executionManifestDigest) }

  async _unary<M extends UnaryRpcMethod>(method: M, request: UnaryRequest<M>, options: RpcCallOptions = {}): Promise<UnaryResponse<M>> {
    if (this.#closed) throw new ChronologRpcError('transport_unavailable', 'Client is closed')
    let attempt = 0
    while (true) {
      try { return await this.#transport.unary(method, request, { ...this.#callOptions(options.signal), ...options }) } catch (error) {
        attempt += 1
        if (attempt > this.#unaryRetryAttempts || !isChronologRpcError(error) || !error.retryable || options.signal?.aborted === true) throw error
        await delay(Math.min(50 * 2 ** attempt, 500), options.signal)
      }
    }
  }

  #assertManifest(actual: string): void {
    const expected = this.#bindings?.executionManifestDigest
    if (expected !== undefined && expected !== actual) throw new ClientManifestMismatchError(expected, actual)
  }

  #revisionStream<T>(open: (cursor: string | undefined, signal: AbortSignal) => AsyncIterable<T>, cursor: (value: T) => string | undefined): StreamResource<T> {
    return this.#track(new StreamResource({ open, cursor, ...(this.#streamRetryDelayMs === undefined ? {} : { retryDelayMs: this.#streamRetryDelayMs }) }))
  }

  #track<T>(resource: StreamResource<T>): StreamResource<T> {
    this.#resources.add(resource)
    resource.onDispose(() => this.#resources.delete(resource))
    return resource
  }

  #callOptions(signal?: AbortSignal): RpcCallOptions {
    return { ...(signal === undefined ? {} : { signal }), ...(this.#token === undefined ? {} : { token: this.#token }) }
  }
}

export function decodeSqlResult(result: CanonicalSqlResult): DecodedSqlResult {
  return Object.freeze({
    mode: result.mode,
    columns: result.columns,
    rows: result.rows.map((row) => Object.freeze(row.map(decodeSqlValue))),
    raw: result,
  })
}

export function decodeSqlValue(value: CanonicalSqlValue): DecodedSqlValue {
  switch (value.kind) {
    case 'null': return null
    case 'integer': return value.value
    case 'real': return new DataView(value.bits.buffer, value.bits.byteOffset, 8).getFloat64(0, false)
    case 'text': return new TextDecoder('utf-8', { fatal: true }).decode(value.utf8)
    case 'blob': return Uint8Array.from(value.bytes)
    case 'logical': return value.value
    case 'registered': return {
      kind: 'registered',
      typeId: value.typeId,
      implementationDigest: Uint8Array.from(value.implementationDigest),
      canonicalPayload: Uint8Array.from(value.canonicalPayload),
    }
  }
}

function encodeConsensusStatement(statement: CompiledSqlStatement): RpcSqlStatement {
  return {
    sql: statement.sql,
    bindings: normalizeConsensusBindings(statement.sql, statement.parameters ?? []).map((binding) => ({
      parameter: binding.parameter,
      canonicalValue: toBase64Url(encodeSqlBindingValue(toSqlBindingValue(binding.value))),
    })),
  }
}

function normalizeConsensusBindings(sql: string, bindings: ClientSqlBindings): readonly {
  readonly parameter: { readonly kind: 'index'; readonly index: number } | { readonly kind: 'name'; readonly name: string }
  readonly value: ClientSqlValue
}[] {
  if (isClientSqlValueArray(bindings)) {
    return bindings.map((value, index) => ({ parameter: { kind: 'index' as const, index: index + 1 }, value }))
  }
  const named = bindings
  const parameters = scanNamedParameters(sql)
  const result: { parameter: { kind: 'name'; name: string }; value: ClientSqlValue }[] = []
  const used = new Set<string>()
  for (const token of parameters) {
    const bare = token.slice(1)
    const exact = Object.hasOwn(named, token) ? token : Object.hasOwn(named, bare) ? bare : undefined
    if (exact === undefined) throw new TypeError(`Missing SQL binding ${token}`)
    result.push({ parameter: { kind: 'name', name: token }, value: named[exact]! })
    used.add(exact)
  }
  const unused = Object.keys(named).filter((key) => !used.has(key))
  if (unused.length > 0) throw new TypeError(`Unused SQL bindings: ${unused.join(', ')}`)
  return result
}

function toSqlBindingValue(value: ClientSqlValue): SqlBindingValue {
  if (typeof value === 'object' && value !== null && 'kind' in value) return value
  if (value === null) return { kind: 'null' }
  if (typeof value === 'boolean') return boolean(value)
  if (typeof value === 'bigint') return int64(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Consensus SQL REAL bindings must be finite')
    return Number.isSafeInteger(value) ? int64(value) : numberToSqlRealBinding(value)
  }
  if (typeof value === 'string') return text(value)
  if (value instanceof Uint8Array) return blob(value)
  if (value instanceof Date) return timestampMsFromDate(value)
  throw new TypeError('Unsupported consensus SQL binding')
}

/** Finds SQLite named parameters while ignoring quoted text, identifiers, and comments. */
function scanNamedParameters(sql: string): readonly string[] {
  const found: string[] = []
  const seen = new Set<string>()
  for (let index = 0; index < sql.length;) {
    const char = sql[index]!
    const next = sql[index + 1]
    if (char === "'" || char === '"' || char === '`' || char === '[') {
      const close = char === '[' ? ']' : char
      index += 1
      while (index < sql.length) {
        if (sql[index] === close) {
          if (close !== ']' && sql[index + 1] === close) { index += 2; continue }
          index += 1
          break
        }
        index += 1
      }
      continue
    }
    if (char === '-' && next === '-') { index = sql.indexOf('\n', index + 2); if (index < 0) break; continue }
    if (char === '/' && next === '*') { const end = sql.indexOf('*/', index + 2); index = end < 0 ? sql.length : end + 2; continue }
    if ((char === ':' || char === '@' || char === '$') && /[A-Za-z_]/u.test(next ?? '')) {
      let end = index + 2
      while (/[A-Za-z0-9_]/u.test(sql[end] ?? '')) end += 1
      const token = sql.slice(index, end)
      if (!seen.has(token)) { seen.add(token); found.push(token) }
      index = end
      continue
    }
    index += 1
  }
  return found
}

let clientPreconditionId = 0
function nextClientPreconditionId(): number { clientPreconditionId += 1; return clientPreconditionId }
function fromBase64Url(value: string): Uint8Array { return Uint8Array.from(Buffer.from(value, 'base64url')) }
function toBase64Url(value: Uint8Array): string { return Buffer.from(value).toString('base64url') }

async function* mapAsync<A, B>(source: AsyncIterable<A>, map: (value: A) => B): AsyncIterable<B> {
  for await (const value of source) yield map(value)
}

async function* mapAsyncAwait<A, B>(source: AsyncIterable<A>, map: (value: A) => Promise<B>): AsyncIterable<B> {
  for await (const value of source) yield await map(value)
}

function stableClientValue(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'bigint') return `${value}n`
  if (value instanceof Uint8Array) return toBase64Url(value)
  if (Array.isArray(value)) return `[${value.map(stableClientValue).join(',')}]`
  if (typeof value === 'object') {
    const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableClientValue(item)}`).join(',')}}`
  }
  return typeof value
}

function isClientSqlValueArray(value: ClientSqlBindings): value is readonly ClientSqlValue[] {
  return Array.isArray(value)
}

function errorFromUnknown(value: unknown): Error { return value instanceof Error ? value : new Error('Queued draft operation failed', { cause: value }) }
function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) return Promise.reject(signal.reason)
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timeout); reject(signal?.reason) }
    const timeout = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve() }, milliseconds)
    signal?.addEventListener('abort', abort, { once: true })
  })
}
