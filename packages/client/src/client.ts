import {
  ChronologRpcError,
  isChronologRpcError,
  type BeginDraftResponse,
  type IrDiagnostic,
  type LiveIrEvent,
  type NodeStatus,
  type PublishDraftResponse,
  type RebaseDraftResponse,
  type ReplicationStatus,
  type RevisionMetadata,
  type RpcCallOptions,
  type RpcTransport,
  type SettlementEvidence,
  type TransactionOutcome,
  type UnaryRequest,
  type UnaryResponse,
  type UnaryRpcMethod,
  type ValidatorWatermark,
} from '@chronolog/rpc'

import {
  contextExpression,
  decodeCanonicalResult,
  entropyExpression,
  fromBase64Url,
  toBase64Url,
  type ContextExpression,
  type DecodedCanonicalResult,
  type EntropyExpression,
  type Mutation,
  type MutationKind,
  type Query,
  type TimestampMs,
  type Uuid,
} from './ir.js'
import {
  decodeLocalSqlResult,
  encodeLocalSqlParameters,
  type DecodedLocalSqlResult,
  type LocalSqlInput,
} from './local-sql.js'
import { StreamResource } from './stream-resource.js'

export interface GeneratedSchemaBindings {
  readonly schemaDigest: string
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
  readonly maxDisplayRows?: number
  readonly atRevision?: string
}

export interface LocalSqlQueryOptions {
  readonly signal?: AbortSignal
  readonly maxRows?: number
  readonly atRevision?: string
}

export interface ClientQueryResponse<Row> {
  readonly revision: RevisionMetadata
  readonly result: Row
  readonly canonical: DecodedCanonicalResult
  readonly queryDigest: string
}

export interface LocalSqlQueryResponse {
  readonly revision: RevisionMetadata
  readonly result: DecodedLocalSqlResult
}

export interface LiveQueryValue<Row> extends ClientQueryResponse<Row> {
  readonly type: LiveIrEvent['type']
  readonly resetReason?: Extract<LiveIrEvent, { type: 'reset' }>['reason']
}

export interface TransactionOptions {
  readonly signal?: AbortSignal
  readonly atRevision?: string
  readonly ttlMs?: number
  readonly idempotencyKey?: string
}

export interface DraftCommandOptions {
  readonly applicationLabel?: string
}

export interface DraftObserveOptions extends DraftCommandOptions {
  readonly maxDisplayRows?: number
}

export class ClientSchemaMismatchError extends Error {
  readonly code = 'CLIENT_SCHEMA_MISMATCH'
  readonly expectedSchemaDigest?: string
  readonly actualSchemaDigest: string
  readonly expectedExecutionManifestDigest?: string
  readonly actualExecutionManifestDigest: string

  constructor(
    expected: Partial<GeneratedSchemaBindings>,
    actual: GeneratedSchemaBindings,
  ) {
    super('Generated bindings do not match the node schema or execution manifest')
    this.name = 'ClientSchemaMismatchError'
    if (expected.schemaDigest !== undefined) this.expectedSchemaDigest = expected.schemaDigest
    this.actualSchemaDigest = actual.schemaDigest
    if (expected.executionManifestDigest !== undefined) {
      this.expectedExecutionManifestDigest = expected.executionManifestDigest
    }
    this.actualExecutionManifestDigest = actual.executionManifestDigest
  }
}

interface ObservationProvenance {
  readonly draftId: string
  readonly generation: number
  readonly observationId: string
  readonly observationToken: string
}

const observationProvenance = new WeakMap<object, ObservationProvenance>()

export class ObservedValue<Row> {
  readonly value: Row
  readonly canonical: DecodedCanonicalResult
  readonly revision: RevisionMetadata
  readonly queryDigest: string
  readonly dependsOnContext: readonly string[]

  constructor(
    value: Row,
    canonical: DecodedCanonicalResult,
    revision: RevisionMetadata,
    queryDigest: string,
    dependsOnContext: readonly string[],
    provenance: ObservationProvenance,
  ) {
    this.value = value
    this.canonical = canonical
    this.revision = revision
    this.queryDigest = queryDigest
    this.dependsOnContext = Object.freeze([...dependsOnContext])
    observationProvenance.set(this, provenance)
    Object.freeze(this)
  }
}

export class TransactionHandle {
  readonly publication: PublishDraftResponse
  readonly outcome: StreamResource<TransactionOutcome>
  readonly evidence: StreamResource<SettlementEvidence>

  constructor(client: ChronologClient, publication: PublishDraftResponse) {
    this.publication = publication
    this.outcome = client.transactionOutcome(publication.transactionId)
    this.evidence = client.settlementEvidence(publication.transactionId)
  }

  get transactionId(): string { return this.publication.transactionId }

  dispose(): void {
    this.outcome.dispose()
    this.evidence.dispose()
  }

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
  #mutationCount = 0
  readonly #invalidatedObservations = new Set<string>()

  constructor(client: ChronologClient, draft: BeginDraftResponse) {
    this.#client = client
    this.#draft = draft
    this.#pinnedRevision = draft.pinnedRevision
  }

  get id(): string { return this.#draft.draftId }
  get pinnedRevision(): RevisionMetadata { return this.#pinnedRevision }
  get reservedAuthorTimestampMs(): bigint { return BigInt(this.#draft.reservedAuthorTimestampMs) }
  get transactionNonce(): Uint8Array { return fromBase64Url(this.#draft.transactionNonce) }

  timestamp(): ContextExpression<TimestampMs> {
    return contextExpression<TimestampMs>('author_timestamp_ms')
  }

  entropy(label: string, index: number, length: number): EntropyExpression {
    return entropyExpression(label, index, length)
  }

  uuid(label: string, index: number): EntropyExpression & { readonly __uuid?: Uuid } {
    return entropyExpression(label, index, 16)
  }

  authorId(): ContextExpression<Uint8Array> { return contextExpression<Uint8Array>('author_id') }
  transactionId(): ContextExpression<Uint8Array> { return contextExpression<Uint8Array>('transaction_id') }

  observe<Row, Mode extends 'scalar' | 'ordered' | 'multiset' | 'set', Parameters = undefined>(
    query: Query<Row, Mode, Parameters>,
    parameters?: Parameters,
    options: DraftObserveOptions = {},
  ): Promise<ObservedValue<Row>> {
    return this.#enqueueResult(async () => {
      const encodedParameters = query.encodeParameters(parameters as Parameters)
      const response = await this.#client._unary('transaction.observeIr', {
        groupId: this.#client.groupId,
        draftId: this.id,
        requestId: this.#client._requestId(),
        queryIr: toBase64Url(query.canonicalBytes),
        parameters: toBase64Url(encodedParameters),
        parameterNames: query.parameterNames,
        ...(options.maxDisplayRows === undefined ? {} : { maxDisplayRows: options.maxDisplayRows }),
        ...(options.applicationLabel === undefined ? {} : { applicationLabel: options.applicationLabel }),
      })
      this.#client._assertCompatibility(response.revision, query)
      if (response.resultMode !== query.resultMode) throw new TypeError('Query result mode does not match generated binding')
      const canonical = decodeCanonicalResult(response)
      return new ObservedValue(
        query.decodeResult(canonical),
        canonical,
        response.revision,
        response.queryDigest,
        response.dependsOnContext,
        {
          draftId: this.id,
          generation: this.#generation,
          observationId: response.observationId,
          observationToken: response.observationToken,
        },
      )
    })
  }

  assert<Parameters = undefined>(
    query: Query<boolean, 'scalar', Parameters>,
    parameters?: Parameters,
    options: DraftCommandOptions = {},
  ): this {
    this.#preconditionCount += 1
    this.#enqueue(async () => {
      await this.#client._unary('transaction.addAssertionIr', {
        groupId: this.#client.groupId,
        draftId: this.id,
        requestId: this.#client._requestId(),
        queryIr: toBase64Url(query.canonicalBytes),
        parameters: toBase64Url(query.encodeParameters(parameters as Parameters)),
        parameterNames: query.parameterNames,
        ...(options.applicationLabel === undefined ? {} : { applicationLabel: options.applicationLabel }),
      })
    })
    return this
  }

  expect(observed: ObservedValue<unknown>, options: DraftCommandOptions = {}): this {
    const provenance = observationProvenance.get(observed)
    if (!provenance || provenance.draftId !== this.id) {
      throw new TypeError('An observation can only be expected by its originating draft')
    }
    if (provenance.generation !== this.#generation || this.#invalidatedObservations.has(provenance.observationId)) {
      throw new TypeError('Observation provenance was invalidated by draft rebase')
    }
    this.#preconditionCount += 1
    this.#enqueue(async () => {
      await this.#client._unary('transaction.addExpectation', {
        groupId: this.#client.groupId,
        draftId: this.id,
        requestId: this.#client._requestId(),
        source: {
          kind: 'observation',
          observationId: provenance.observationId,
          observationToken: provenance.observationToken,
        },
        ...(options.applicationLabel === undefined ? {} : { applicationLabel: options.applicationLabel }),
      })
    })
    return this
  }

  mutate<Kind extends MutationKind>(mutation: Mutation<Kind>): this {
    this.#mutationCount += 1
    this.#enqueue(async () => {
      await this.#client._unary('transaction.addMutationIr', {
        groupId: this.#client.groupId,
        draftId: this.id,
        requestId: this.#client._requestId(),
        mutationIr: toBase64Url(mutation.canonicalBytes),
        ...(mutation.applicationLabel === undefined ? {} : { applicationLabel: mutation.applicationLabel }),
      })
    })
    return this
  }

  insert(mutation: Mutation<'insert'>): this { return this.mutate(mutation) }
  update(mutation: Mutation<'update'>): this { return this.mutate(mutation) }
  delete(mutation: Mutation<'delete'>): this { return this.mutate(mutation) }
  upsert(mutation: Mutation<'upsert'>): this { return this.mutate(mutation) }
  merge(mutation: Mutation<'merge'>): this { return this.mutate(mutation) }
  call(mutation: Mutation<'registered_call'>): this { return this.mutate(mutation) }

  validate(): Promise<readonly IrDiagnostic[]> {
    return this.#enqueueResult(async () => {
      const response = await this.#client._unary('transaction.validateDraft', {
        groupId: this.#client.groupId,
        draftId: this.id,
        requestId: this.#client._requestId(),
      })
      return response.diagnostics
    })
  }

  rebase(options: {
    readonly toRevision?: string
    readonly refreshObservations?: boolean
    readonly renewContext?: boolean
  } = {}): Promise<RebaseDraftResponse> {
    return this.#enqueueResult(async () => {
      const renewContext = options.renewContext ?? false
      const response = await this.#client._unary('transaction.rebaseDraft', {
        groupId: this.#client.groupId,
        draftId: this.id,
        requestId: this.#client._requestId(),
        refreshObservations: options.refreshObservations ?? false,
        renewContext,
        ...(options.toRevision === undefined ? {} : { toRevision: options.toRevision }),
      })
      this.#client._assertCompatibility(response.pinnedRevision)
      this.#pinnedRevision = response.pinnedRevision
      for (const id of response.invalidatedObservationIds) this.#invalidatedObservations.add(id)
      if (renewContext) this.#generation += 1
      return response
    })
  }

  async _flushAndValidate(): Promise<void> {
    await this.#tail
    if (this.#failed !== undefined) throw errorFromUnknown(this.#failed)
    if (this.#preconditionCount === 0) throw new TypeError('Every transaction requires a precondition')
    if (this.#mutationCount === 0) throw new TypeError('Every transaction requires a mutation')
    const diagnostics = await this.validate()
    await this.#tail
    const error = diagnostics.find((diagnostic) => diagnostic.severity === 'error')
    if (error) throw new ChronologRpcError('protocol_rejected', error.message, { details: { code: error.code } })
  }

  #enqueue(operation: () => Promise<void>): void {
    void this.#enqueueResult(operation).catch(() => undefined)
  }

  #enqueueResult<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(async () => {
      if (this.#failed !== undefined) throw errorFromUnknown(this.#failed)
      return operation()
    })
    this.#tail = result.then(
      () => undefined,
      (error: unknown) => { if (this.#failed === undefined) this.#failed = error },
    )
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

  async query<Row, Mode extends 'scalar' | 'ordered' | 'multiset' | 'set', Parameters = undefined>(
    query: Query<Row, Mode, Parameters>,
    parameters?: Parameters,
    options: QueryOptions = {},
  ): Promise<ClientQueryResponse<Row>> {
    const response = await this._unary('query.executeIr', {
      groupId: this.groupId,
      requestId: this._requestId(),
      queryIr: toBase64Url(query.canonicalBytes),
      parameters: toBase64Url(query.encodeParameters(parameters as Parameters)),
      parameterNames: query.parameterNames,
      ...(options.maxDisplayRows === undefined ? {} : { maxDisplayRows: options.maxDisplayRows }),
      ...(options.atRevision === undefined ? {} : { atRevision: options.atRevision }),
    }, options.signal === undefined ? {} : { signal: options.signal })
    this._assertCompatibility(response.revision, query)
    if (response.result.resultMode !== query.resultMode) throw new TypeError('Query result mode does not match generated binding')
    const canonical = decodeCanonicalResult(response.result)
    return { revision: response.revision, result: query.decodeResult(canonical), canonical, queryDigest: response.queryDigest }
  }

  async queryLocalSql(
    sql: string,
    parameters: readonly LocalSqlInput[] = [],
    options: LocalSqlQueryOptions = {},
  ): Promise<LocalSqlQueryResponse> {
    const response = await this._unary('query.localSql', {
      groupId: this.groupId,
      requestId: this._requestId(),
      sql,
      parameters: encodeLocalSqlParameters(parameters),
      ...(options.maxRows === undefined ? {} : { maxRows: options.maxRows }),
      ...(options.atRevision === undefined ? {} : { atRevision: options.atRevision }),
    }, options.signal === undefined ? {} : { signal: options.signal })
    this._assertCompatibility(response.revision)
    return { revision: response.revision, result: decodeLocalSqlResult(response.result) }
  }

  liveQuery<Row, Mode extends 'scalar' | 'ordered' | 'multiset' | 'set', Parameters = undefined>(
    query: Query<Row, Mode, Parameters>,
    parameters?: Parameters,
    options: Omit<QueryOptions, 'atRevision'> = {},
  ): StreamResource<LiveQueryValue<Row>> {
    const requestId = this._requestId()
    const queryIr = toBase64Url(query.canonicalBytes)
    const encodedParameters = toBase64Url(query.encodeParameters(parameters as Parameters))
    let queryDigest: string | undefined
    return this.#track(new StreamResource({
      open: (cursor, signal) => mapAsync(
        this.#transport.stream('query.liveIr', {
          groupId: this.groupId,
          requestId,
          queryIr,
          parameters: encodedParameters,
          parameterNames: query.parameterNames,
          ...(options.maxDisplayRows === undefined ? {} : { maxDisplayRows: options.maxDisplayRows }),
          ...(cursor === undefined || queryDigest === undefined ? {} : {
            resume: { groupId: this.groupId, queryDigest, eventSetRevision: cursor },
          }),
        }, this.#callOptions(signal)),
        (event): LiveQueryValue<Row> => {
          this._assertCompatibility(event.revision, query)
          if (event.result.resultMode !== query.resultMode) throw new TypeError('Query result mode does not match generated binding')
          queryDigest = event.queryDigest
          const canonical = decodeCanonicalResult(event.result)
          return {
            type: event.type,
            revision: event.revision,
            result: query.decodeResult(canonical),
            canonical,
            queryDigest: event.queryDigest,
            ...(event.type === 'reset' ? { resetReason: event.reason } : {}),
          }
        },
      ),
      cursor: (value) => value.revision.eventSetRevision,
      ...(this.#streamRetryDelayMs === undefined ? {} : { retryDelayMs: this.#streamRetryDelayMs }),
    }))
  }

  async transaction(
    build: (draft: TransactionDraft) => void | Promise<void>,
    options: TransactionOptions = {},
  ): Promise<TransactionHandle> {
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
      this.#assertDigestCompatibility(publication.schemaDigest, publication.executionManifestDigest)
      return new TransactionHandle(this, publication)
    } catch (error) {
      await this._unary('transaction.cancelDraft', {
        groupId: this.groupId,
        draftId: begin.draftId,
        requestId: this._requestId(),
      }).catch(() => undefined)
      throw error
    }
  }

  async getTransactionOutcome(transactionId: string): Promise<TransactionOutcome> {
    return this._unary('transaction.getOutcome', { groupId: this.groupId, transactionId, requestId: this._requestId() })
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
      (cursor, signal) => mapAsync(
        this.#transport.stream('node.streamStatus', {
          groupId: this.groupId,
          requestId,
          ...(cursor === undefined ? {} : { resumeAfterEventSetRevision: cursor }),
        }, this.#callOptions(signal)),
        (status) => {
          if (status.revision !== undefined) this._assertCompatibility(status.revision)
          return status
        },
      ),
      (status) => status.revision?.eventSetRevision,
    )
  }

  queryResourceKey<Mode extends 'scalar' | 'ordered' | 'multiset' | 'set', Parameters>(
    query: Query<unknown, Mode, Parameters>,
    parameters?: Parameters,
  ): string {
    return `${toBase64Url(query.canonicalBytes)}.${toBase64Url(query.encodeParameters(parameters as Parameters))}`
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    for (const resource of this.#resources) resource.dispose()
    this.#resources.clear()
    await this.#transport.close?.()
  }

  _requestId(): string { return this.#idFactory() }

  _assertCompatibility(
    revision: RevisionMetadata,
    query?: { readonly schemaDigest?: string; readonly executionManifestDigest?: string },
  ): void {
    this.#assertDigestCompatibility(
      revision.schemaDigest,
      revision.executionManifestDigest,
      query,
    )
  }

  async _unary<M extends UnaryRpcMethod>(
    method: M,
    request: UnaryRequest<M>,
    options: RpcCallOptions = {},
  ): Promise<UnaryResponse<M>> {
    if (this.#closed) throw new ChronologRpcError('transport_unavailable', 'Client is closed')
    let attempt = 0
    while (true) {
      try {
        return await this.#transport.unary(method, request, { ...this.#callOptions(options.signal), ...options })
      } catch (error) {
        attempt += 1
        if (attempt > this.#unaryRetryAttempts || !isChronologRpcError(error) || !error.retryable || options.signal?.aborted === true) throw error
        await delay(Math.min(50 * 2 ** attempt, 500), options.signal)
      }
    }
  }

  #assertDigestCompatibility(
    schemaDigest: string,
    executionManifestDigest: string,
    query?: { readonly schemaDigest?: string; readonly executionManifestDigest?: string },
  ): void {
    const expectedSchema = query?.schemaDigest ?? this.#bindings?.schemaDigest
    const expectedManifest = query?.executionManifestDigest ?? this.#bindings?.executionManifestDigest
    if ((expectedSchema !== undefined && expectedSchema !== schemaDigest) ||
        (expectedManifest !== undefined && expectedManifest !== executionManifestDigest)) {
      throw new ClientSchemaMismatchError(
        {
          ...(expectedSchema === undefined ? {} : { schemaDigest: expectedSchema }),
          ...(expectedManifest === undefined ? {} : { executionManifestDigest: expectedManifest }),
        },
        { schemaDigest, executionManifestDigest },
      )
    }
  }

  #revisionStream<T>(
    open: (cursor: string | undefined, signal: AbortSignal) => AsyncIterable<T>,
    cursor: (value: T) => string | undefined,
  ): StreamResource<T> {
    return this.#track(new StreamResource({
      open,
      cursor,
      ...(this.#streamRetryDelayMs === undefined ? {} : { retryDelayMs: this.#streamRetryDelayMs }),
    }))
  }

  #track<T>(resource: StreamResource<T>): StreamResource<T> {
    this.#resources.add(resource)
    resource.onDispose(() => this.#resources.delete(resource))
    return resource
  }

  #callOptions(signal?: AbortSignal): RpcCallOptions {
    return {
      ...(signal === undefined ? {} : { signal }),
      ...(this.#token === undefined ? {} : { token: this.#token }),
    }
  }
}

async function* mapAsync<A, B>(source: AsyncIterable<A>, map: (value: A) => B): AsyncIterable<B> {
  for await (const value of source) yield map(value)
}

function errorFromUnknown(value: unknown): Error {
  return value instanceof Error ? value : new Error('Queued draft operation failed', { cause: value })
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) return Promise.reject(signal.reason)
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(resolve, milliseconds)
    signal?.addEventListener('abort', () => {
      clearTimeout(timeout)
      reject(signal.reason)
    }, { once: true })
  })
}
