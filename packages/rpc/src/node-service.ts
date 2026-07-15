import { randomUUID } from 'node:crypto'

import { decodeUtf8, sha256, utf8 } from '@chronolog/canonical'
import {
  decodeCanonicalQueryResult,
  decodeLogicalValues,
  decodeMutation,
  decodeQuery,
  digestCanonicalQueryResult,
  encodeCanonicalQueryResult,
  encodeQuery,
  type CanonicalJsonValue,
  type CanonicalQueryResult as IrQueryResult,
  type ContextField,
  type IrDiagnostic as CompilerDiagnostic,
  type LogicalValue,
  type Mutation,
  type Precondition,
  type Query,
  type TransactionProgram,
} from '@chronolog/ir'
import type { ChronologRpcService, RpcCallContext } from './contract.js'
import { ChronologRpcError } from './errors.js'
import {
  RPC_API_VERSION,
  type AddAssertionIrRequest,
  type AddExpectationRequest,
  type AddMutationIrRequest,
  type BeginDraftRequest,
  type BeginDraftResponse,
  type CancelDraftRequest,
  type CancelDraftResponse,
  type CanonicalQueryResult,
  type DisplayValue,
  type DraftMutationResponse,
  type ExecuteIrRequest,
  type ExecuteIrResponse,
  type GetOutcomeRequest,
  type GetReplicationStatusRequest,
  type GetSettlementEvidenceRequest,
  type GetStatusRequest,
  type GetValidatorWatermarkRequest,
  type IrDiagnostic,
  type LiveIrEvent,
  type LiveIrRequest,
  type LocalSqlRequest,
  type LocalSqlResponse,
  type LocalSqlResult,
  type LocalSqlValue,
  type LogicalResultColumn,
  type NodeStatus,
  type ObserveIrRequest,
  type ObserveIrResponse,
  type PublishDraftRequest,
  type PublishDraftResponse,
  type RejectionAttribution,
  type RebaseDraftRequest,
  type RebaseDraftResponse,
  type ReplicationStatus,
  type RevisionMetadata,
  type SettlementEvidence,
  type StreamOutcomeRequest,
  type StreamReplicationStatusRequest,
  type StreamSettlementEvidenceRequest,
  type StreamStatusRequest,
  type TransactionOutcome,
  type ValidateDraftRequest,
  type ValidateDraftResponse,
  type ValidatorWatermark,
} from './types.js'
import type {
  ChronologRpcNodeService,
  DraftExecutionContext,
  IrQueryExecution,
  NodeRpcIrBackend,
} from './service-contract.js'

export type {
  ChronologRpcNodeService,
  DraftExecutionContext,
  IrQueryExecution,
  LocalSqlExecution,
  NodeRpcIrBackend,
  RpcNodeCandidate,
  RpcNodeCandidateCore,
  RpcNodeSettlementEvidence,
  RpcNodeStatusSnapshot,
  RpcNodeWatermark,
} from './service-contract.js'

interface StoredObservation {
  readonly id: string
  readonly token: string
  readonly query: Query
  readonly queryDigest: string
  readonly result: IrQueryResult
  readonly resultDigest: string
  readonly revision: bigint
  readonly dependsOnContext: readonly ContextField[]
  readonly maxDisplayRows?: number
  readonly applicationLabel?: string
}

interface Draft {
  readonly id: string
  readonly owner: string
  readonly expiresAt: number
  readonly expiresAtMonotonic: number
  pinnedRevision: bigint
  schemaDigest: string
  executionManifestDigest: string
  reservedAuthorTimestampMs: bigint
  reservedNonce: Uint8Array
  readonly preconditions: Precondition[]
  readonly mutations: Mutation[]
  readonly observations: Map<string, StoredObservation>
  readonly diagnostics: IrDiagnostic[]
  readonly labels: Map<string, string>
  readonly expectationObservations: Map<number, string>
  nextPreconditionId: number
  draftRevision: bigint
  state: 'open' | 'busy' | 'publishing' | 'cancelled'
  tail: Promise<void>
}

interface IdempotentEntry {
  readonly fingerprint: string
  readonly promise: Promise<unknown>
  settled: boolean
  expiresAtMonotonic: number
}

interface PublishedLabelsEntry {
  readonly labels: ReadonlyMap<string, string>
  readonly expiresAtMonotonic: number
}

export interface NodeRpcServiceOptions {
  readonly node: ChronologRpcNodeService
  readonly irBackend?: NodeRpcIrBackend
  readonly draftTtlMs?: number
  readonly maxDraftTtlMs?: number
  readonly maxDrafts?: number
  readonly maxObservationsPerDraft?: number
  readonly maxPreconditionsPerDraft?: number
  readonly maxMutationsPerDraft?: number
  readonly maxDisplayRows?: number
  readonly maxLocalSqlRows?: number
  /** Retention for completed request/publication idempotency and label metadata. */
  readonly retentionTtlMs?: number
  readonly maxIdempotencyEntries?: number
  readonly maxPublicationEntries?: number
  readonly maxPublishedLabelEntries?: number
  readonly now?: () => number
  readonly monotonicNow?: () => number
  readonly id?: () => string
}

export class NodeRpcService implements ChronologRpcService {
  readonly #node: ChronologRpcNodeService
  readonly #ir: NodeRpcIrBackend
  readonly #draftTtlMs: number
  readonly #maxDraftTtlMs: number
  readonly #maxDrafts: number
  readonly #maxObservationsPerDraft: number
  readonly #maxPreconditionsPerDraft: number
  readonly #maxMutationsPerDraft: number
  readonly #maxDisplayRows: number
  readonly #maxLocalSqlRows: number
  readonly #retentionTtlMs: number
  readonly #maxIdempotencyEntries: number
  readonly #maxPublicationEntries: number
  readonly #maxPublishedLabelEntries: number
  readonly #now: () => number
  readonly #monotonicNow: () => number
  readonly #id: () => string
  readonly #drafts = new Map<string, Draft>()
  readonly #idempotent = new Map<string, IdempotentEntry>()
  readonly #publications = new Map<string, IdempotentEntry>()
  readonly #publishedLabels = new Map<string, PublishedLabelsEntry>()

  constructor(options: NodeRpcServiceOptions) {
    this.#node = options.node
    this.#ir = options.irBackend ?? nodeIrBackend(options.node)
    this.#draftTtlMs = positiveSafeInteger(options.draftTtlMs ?? 5 * 60_000, 'draftTtlMs')
    this.#maxDraftTtlMs = positiveSafeInteger(options.maxDraftTtlMs ?? 60 * 60_000, 'maxDraftTtlMs')
    this.#maxDrafts = positiveSafeInteger(options.maxDrafts ?? 1_024, 'maxDrafts')
    this.#maxObservationsPerDraft = positiveSafeInteger(options.maxObservationsPerDraft ?? 1_024, 'maxObservationsPerDraft')
    this.#maxPreconditionsPerDraft = positiveSafeInteger(options.maxPreconditionsPerDraft ?? 1_024, 'maxPreconditionsPerDraft')
    this.#maxMutationsPerDraft = positiveSafeInteger(options.maxMutationsPerDraft ?? 1_024, 'maxMutationsPerDraft')
    this.#maxDisplayRows = nonnegativeSafeInteger(options.maxDisplayRows ?? 1_000, 'maxDisplayRows')
    this.#maxLocalSqlRows = nonnegativeSafeInteger(options.maxLocalSqlRows ?? 10_000, 'maxLocalSqlRows')
    this.#retentionTtlMs = positiveSafeInteger(options.retentionTtlMs ?? 24 * 60 * 60_000, 'retentionTtlMs')
    this.#maxIdempotencyEntries = positiveSafeInteger(options.maxIdempotencyEntries ?? 10_000, 'maxIdempotencyEntries')
    this.#maxPublicationEntries = positiveSafeInteger(options.maxPublicationEntries ?? 10_000, 'maxPublicationEntries')
    this.#maxPublishedLabelEntries = positiveSafeInteger(options.maxPublishedLabelEntries ?? 10_000, 'maxPublishedLabelEntries')
    this.#now = options.now ?? Date.now
    this.#monotonicNow = options.monotonicNow ?? (() => performance.now())
    this.#id = options.id ?? randomUUID
  }

  async getStatus(request: GetStatusRequest, _context: RpcCallContext): Promise<NodeStatus> {
    this.#assertGroupOptional(request.groupId)
    const status = await this.#node.status()
    return {
      apiVersion: RPC_API_VERSION,
      state: !status.started ? 'starting' : status.lastError === undefined ? 'ready' : 'degraded',
      nodeId: toBase64Url(this.#node.identity),
      revision: await this.#revision(status.materializedRevision, status.orderLength),
      writable: await this.#node.isWritable(),
      validating: status.validating,
      ...(status.lastError === undefined ? {} : { lastErrorCode: status.lastError }),
    }
  }

  async *streamStatus(request: StreamStatusRequest, context: RpcCallContext): AsyncIterable<NodeStatus> {
    this.#assertGroupOptional(request.groupId)
    yield await this.getStatus(request, context)
    const after = BigInt(request.resumeAfterEventSetRevision ?? this.#node.revision)
    for await (const _event of this.#node.events(after, context.signal)) yield await this.getStatus(request, context)
  }

  async executeIr(request: ExecuteIrRequest, _context: RpcCallContext): Promise<ExecuteIrResponse> {
    this.#assertGroup(request.groupId)
    const backend = this.#backend()
    const query = decodeAndBindQuery(request.queryIr, request.parameters, request.parameterNames)
    const queryDigest = await digestQuery(query)
    const atRevision = request.atRevision === undefined ? backend.revision : BigInt(request.atRevision)
    const execution = await backend.query(query, { atRevision })
    this.#assertExecutionRevision(execution, atRevision)
    return {
      revision: await this.#revisionFromExecution(execution),
      queryDigest,
      result: await toRpcQueryResult(execution.result, this.#boundedDisplayRows(request.maxDisplayRows)),
    }
  }

  async *liveIr(request: LiveIrRequest, context: RpcCallContext): AsyncIterable<LiveIrEvent> {
    this.#assertGroup(request.groupId)
    const backend = this.#backend()
    const query = decodeAndBindQuery(request.queryIr, request.parameters, request.parameterNames)
    const queryDigest = await digestQuery(query)
    if (request.resume !== undefined && (
      request.resume.groupId !== request.groupId || request.resume.queryDigest !== queryDigest
    )) throw invalid('Live-query resume cursor does not belong to this group and canonical query')

    // Subscribe before taking the initial reader snapshot. Events are queued by
    // node-core while the snapshot is executing, closing the snapshot/subscribe gap.
    const barrierRevision = this.#node.revision
    const events = this.#node.events(barrierRevision, context.signal)
    let execution = await backend.query(query, { atRevision: backend.revision })
    let revision = await this.#revisionFromExecution(execution)
    let result = await toRpcQueryResult(execution.result, this.#boundedDisplayRows(request.maxDisplayRows))
    const resumeMatches = request.resume === undefined || request.resume.eventSetRevision === revision.eventSetRevision
    yield resumeMatches
      ? { type: 'snapshot', revision, queryDigest, result }
      : { type: 'reset', revision, queryDigest, result, reason: 'history_unavailable' }

    let priorMaterialized = execution.revision
    let priorDigest = result.resultDigest
    let priorSchema = revision.schemaDigest
    let priorManifest = revision.executionManifestDigest
    for await (const _event of events) {
      if (backend.revision === priorMaterialized) continue
      execution = await backend.query(query, { atRevision: backend.revision })
      revision = await this.#revisionFromExecution(execution)
      result = await toRpcQueryResult(execution.result, this.#boundedDisplayRows(request.maxDisplayRows))
      const previousMaterializedRevision = priorMaterialized.toString(10)
      priorMaterialized = execution.revision
      if (revision.schemaDigest !== priorSchema) {
        priorSchema = revision.schemaDigest
        priorManifest = revision.executionManifestDigest
        priorDigest = result.resultDigest
        yield { type: 'reset', revision, queryDigest, result, reason: 'schema_changed' }
        continue
      }
      if (revision.executionManifestDigest !== priorManifest) {
        priorManifest = revision.executionManifestDigest
        priorDigest = result.resultDigest
        yield { type: 'reset', revision, queryDigest, result, reason: 'manifest_changed' }
        continue
      }
      if (result.resultDigest === priorDigest) continue
      priorDigest = result.resultDigest
      yield { type: 'change', revision, queryDigest, result, previousMaterializedRevision }
    }
  }

  async localSql(request: LocalSqlRequest, _context: RpcCallContext): Promise<LocalSqlResponse> {
    this.#assertGroup(request.groupId)
    const backend = this.#backend()
    const atRevision = request.atRevision === undefined ? backend.revision : BigInt(request.atRevision)
    const execution = await backend.localQuery(
      request.sql,
      request.parameters.map(copyLocalSqlValue),
      { atRevision },
    )
    if (execution.revision !== atRevision) throw revisionUnavailable('Requested local SQL reader is unavailable')
    const limit = this.#boundedLocalRows(request.maxRows)
    const rows = execution.rows.slice(0, limit).map((row) => row.map(copyLocalSqlValue))
    const result: LocalSqlResult = {
      columns: execution.columns.map((column) => ({ ...column })),
      rows,
      truncated: rows.length !== execution.rows.length,
      consensusSafe: false,
    }
    return { revision: await this.#revision(execution.revision, execution.orderLength), result }
  }

  async beginDraft(request: BeginDraftRequest, context: RpcCallContext): Promise<BeginDraftResponse> {
    this.#assertGroup(request.groupId)
    const owner = principal(context)
    return this.#once('begin', request, owner, async () => {
      this.#pruneDrafts()
      if (this.#drafts.size >= this.#maxDrafts) throw exhausted('Too many active transaction drafts')
      const backend = this.#backend()
      const pinnedRevision = request.atRevision === undefined ? backend.revision : BigInt(request.atRevision)
      if (pinnedRevision !== backend.revision) throw revisionUnavailable('Requested draft revision is not retained locally')
      const ttl = Math.min(request.ttlMs ?? this.#draftTtlMs, this.#maxDraftTtlMs)
      if (!Number.isSafeInteger(ttl) || ttl <= 0) throw invalid('Draft TTL must be a positive integer')
      const now = this.#now()
      const reserved = this.#node.reserveTransactionContext()
      const authorTimestamp = reserved.authorTimestampMs
      const reservedNonce = reserved.nonce
      if (reservedNonce.byteLength !== 32) throw new ChronologRpcError('internal', 'Nonce source returned an invalid length')
      const draft: Draft = {
        id: this.#id(),
        owner,
        expiresAt: now + ttl,
        expiresAtMonotonic: this.#monotonicNow() + ttl,
        pinnedRevision,
        schemaDigest: toBase64Url(backend.schemaDigest),
        executionManifestDigest: toBase64Url(backend.executionManifestDigest),
        reservedAuthorTimestampMs: authorTimestamp,
        reservedNonce: Uint8Array.from(reservedNonce),
        preconditions: [],
        mutations: [],
        observations: new Map(),
        diagnostics: [],
        labels: new Map(),
        expectationObservations: new Map(),
        // Preconditions are introduced by the RPC service around already
        // canonical application IR. Allocate down from the safe-integer ceiling
        // so ordinary monotonic code-generated query/mutation IDs cannot collide.
        nextPreconditionId: Number.MAX_SAFE_INTEGER,
        draftRevision: 0n,
        state: 'open',
        tail: Promise.resolve(),
      }
      this.#drafts.set(draft.id, draft)
      const revision = await this.#revision(pinnedRevision, backend.orderLength)
      return {
        draftId: draft.id,
        pinnedRevision: revision,
        schemaDigest: draft.schemaDigest,
        executionManifestDigest: draft.executionManifestDigest,
        reservedAuthorTimestampMs: authorTimestamp.toString(10),
        transactionNonce: toBase64Url(draft.reservedNonce),
        expiresAt: new Date(draft.expiresAt).toISOString(),
      }
    })
  }

  async observeIr(request: ObserveIrRequest, context: RpcCallContext): Promise<ObserveIrResponse> {
    this.#assertGroup(request.groupId)
    const owner = principal(context)
    return this.#once('observeIr', request, owner, () => this.#withDraft(request.draftId, owner, 'busy', async (draft) => {
      if (draft.observations.size >= this.#maxObservationsPerDraft) {
        throw exhausted('Transaction draft observation limit reached')
      }
      const backend = this.#backend()
      this.#assertDraftConfiguration(draft, backend)
      const query = decodeAndBindQuery(request.queryIr, request.parameters, request.parameterNames)
      assertObservableDraftContext(query)
      const diagnostics = mapDiagnostics(backend.validateQuery(query), request.applicationLabel)
      this.#replaceDiagnostics(draft, diagnostics)
      if (diagnostics.some((item) => item.severity === 'error')) throw protocolRejected(diagnostics)
      const execution = await backend.query(query, {
        atRevision: draft.pinnedRevision,
        context: this.#draftContext(draft),
      })
      this.#assertExecutionRevision(execution, draft.pinnedRevision)
      const id = this.#id()
      const token = this.#id()
      const resultDigest = toBase64Url(await digestCanonicalQueryResult(execution.result))
      const observation: StoredObservation = {
        id,
        token,
        query,
        queryDigest: await digestQuery(query),
        result: execution.result,
        resultDigest,
        revision: execution.revision,
        dependsOnContext: collectContextDependencies(query),
        ...(request.maxDisplayRows === undefined ? {} : { maxDisplayRows: request.maxDisplayRows }),
        ...(request.applicationLabel === undefined ? {} : { applicationLabel: request.applicationLabel }),
      }
      draft.observations.set(id, observation)
      draft.draftRevision += 1n
      return this.#observationResponse(draft, observation, execution)
    }))
  }

  async addAssertionIr(request: AddAssertionIrRequest, context: RpcCallContext): Promise<DraftMutationResponse> {
    return this.#mutateDraft('assertionIr', request, context, (draft, backend) => {
      this.#assertPreconditionCapacity(draft)
      const query = decodeAndBindQuery(request.queryIr, request.parameters, request.parameterNames)
      const diagnostics = mapDiagnostics(backend.validateQuery(query), request.applicationLabel)
      const id = draft.nextPreconditionId--
      if (request.applicationLabel !== undefined) draft.labels.set(`p:${id}`, request.applicationLabel)
      draft.preconditions.push({ kind: 'assert', id, query, unknownIsFailure: true })
      return diagnostics
    })
  }

  async addExpectation(request: AddExpectationRequest, context: RpcCallContext): Promise<DraftMutationResponse> {
    return this.#mutateDraft('expectation', request, context, (draft, backend) => {
      this.#assertPreconditionCapacity(draft)
      let query: Query
      let result: IrQueryResult
      let observationId: string | undefined
      if (request.source.kind === 'observation') {
        const observation = draft.observations.get(request.source.observationId)
        if (!observation || observation.token !== request.source.observationToken) throw invalid('Observation provenance is invalid for this draft')
        if (observation.revision !== draft.pinnedRevision) throw failed('Observation no longer belongs to the pinned draft revision')
        query = observation.query
        result = observation.result
        observationId = observation.id
      } else {
        const source = request.source
        query = decodeAndBindQuery(source.queryIr, source.parameters, source.parameterNames)
        result = decodeCanonical('canonical query result', () => decodeCanonicalQueryResult(fromBase64Url(source.canonicalResult)))
      }
      const id = draft.nextPreconditionId--
      if (observationId !== undefined) draft.expectationObservations.set(id, observationId)
      if (request.applicationLabel !== undefined) draft.labels.set(`p:${id}`, request.applicationLabel)
      draft.preconditions.push({ kind: 'expect', id, query, expected: { kind: 'inline', result } })
      return mapDiagnostics(backend.validateQuery(query), request.applicationLabel)
    })
  }

  async addMutationIr(request: AddMutationIrRequest, context: RpcCallContext): Promise<DraftMutationResponse> {
    return this.#mutateDraft('mutationIr', request, context, (draft, backend) => {
      if (draft.mutations.length >= this.#maxMutationsPerDraft) {
        throw exhausted('Transaction draft mutation limit reached')
      }
      const mutation = decodeCanonical('mutation IR', () => decodeMutation(fromBase64Url(request.mutationIr)))
      if (containsParameterExpression(mutation)) throw invalid('Published mutation IR cannot retain parameter expressions')
      if (request.applicationLabel !== undefined) draft.labels.set(`m:${mutation.id}`, request.applicationLabel)
      draft.mutations.push(request.applicationLabel === undefined || mutation.label !== undefined
        ? mutation
        : { ...mutation, label: request.applicationLabel })
      return mapDiagnostics(backend.validateMutation(mutation), request.applicationLabel)
    })
  }

  async validateDraft(request: ValidateDraftRequest, context: RpcCallContext): Promise<ValidateDraftResponse> {
    this.#assertGroup(request.groupId)
    return this.#withDraft(request.draftId, principal(context), 'busy', async (draft) => {
      this.#validateCompleteDraft(draft)
      return this.#mutationResponse(draft)
    })
  }

  async rebaseDraft(request: RebaseDraftRequest, context: RpcCallContext): Promise<RebaseDraftResponse> {
    this.#assertGroup(request.groupId)
    const owner = principal(context)
    return this.#once('rebase', request, owner, () => this.#withDraft(request.draftId, owner, 'busy', async (draft) => {
      const backend = this.#backend()
      const target = request.toRevision === undefined ? backend.revision : BigInt(request.toRevision)
      if (target !== backend.revision) throw revisionUnavailable('Requested rebase revision is not retained locally')
      const targetSchema = Uint8Array.from(backend.schemaDigest)
      const targetManifest = Uint8Array.from(backend.executionManifestDigest)
      const targetOrderLength = backend.orderLength
      const reserved = request.renewContext
        ? this.#node.reserveTransactionContext()
        : { authorTimestampMs: draft.reservedAuthorTimestampMs, nonce: Uint8Array.from(draft.reservedNonce) }
      if (reserved.nonce.byteLength !== 32) throw new ChronologRpcError('internal', 'Nonce source returned an invalid length')
      const invalidated = request.renewContext
        ? [...draft.observations.values()].filter((item) => item.dependsOnContext.length > 0).map((item) => item.id)
        : []
      const invalidatedSet = new Set(invalidated)
      const stagedContext = this.#executionContext(reserved.authorTimestampMs, reserved.nonce)
      const refreshed: RebaseDraftResponse['refreshedObservations'][number][] = []
      const replacements: StoredObservation[] = []
      if (request.refreshObservations) {
        for (const observation of draft.observations.values()) {
          if (invalidatedSet.has(observation.id)) continue
          const execution = await backend.query(observation.query, {
            atRevision: target,
            context: stagedContext,
          })
          this.#assertExecutionRevision(execution, target)
          if (!equalBytes(execution.schemaDigest, targetSchema) ||
              !equalBytes(execution.executionManifestDigest, targetManifest)) {
            throw revisionUnavailable('Schema or execution manifest changed while rebasing the draft')
          }
          const resultDigest = toBase64Url(await digestCanonicalQueryResult(execution.result))
          const replacement: StoredObservation = { ...observation, result: execution.result, resultDigest, revision: target }
          replacements.push(replacement)
          refreshed.push({
            ...await this.#observationResponse(draft, replacement, execution),
            changed: resultDigest !== observation.resultDigest,
          })
        }
      }

      // Nothing observable on the draft changes until every refresh has
      // succeeded against the same revision/configuration snapshot.
      if (backend.revision !== target || !equalBytes(backend.schemaDigest, targetSchema) ||
          !equalBytes(backend.executionManifestDigest, targetManifest)) {
        throw revisionUnavailable('Target revision changed while rebasing the draft')
      }
      draft.reservedAuthorTimestampMs = reserved.authorTimestampMs
      draft.reservedNonce = Uint8Array.from(reserved.nonce)
      draft.pinnedRevision = target
      draft.schemaDigest = toBase64Url(targetSchema)
      draft.executionManifestDigest = toBase64Url(targetManifest)
      for (const id of invalidated) draft.observations.delete(id)
      for (let index = draft.preconditions.length - 1; index >= 0; index -= 1) {
        const precondition = draft.preconditions[index]
        if (precondition === undefined) continue
        const observationId = draft.expectationObservations.get(precondition.id)
        if (observationId !== undefined && invalidatedSet.has(observationId)) {
          draft.preconditions.splice(index, 1)
          draft.expectationObservations.delete(precondition.id)
          draft.labels.delete(`p:${precondition.id}`)
        }
      }
      for (const replacement of replacements) draft.observations.set(replacement.id, replacement)
      if (request.refreshObservations) {
        for (let index = 0; index < draft.preconditions.length; index += 1) {
          const precondition = draft.preconditions[index]
          if (precondition?.kind !== 'expect' || precondition.expected.kind !== 'inline') continue
          const observationId = draft.expectationObservations.get(precondition.id)
          const observation = observationId === undefined ? undefined : draft.observations.get(observationId)
          if (observation !== undefined) draft.preconditions[index] = { ...precondition, expected: { kind: 'inline', result: observation.result } }
        }
      }
      draft.draftRevision += 1n
      return {
        ...this.#mutationResponse(draft),
        pinnedRevision: await this.#revision(target, targetOrderLength, targetSchema, targetManifest),
        schemaDigest: draft.schemaDigest,
        executionManifestDigest: draft.executionManifestDigest,
        reservedAuthorTimestampMs: draft.reservedAuthorTimestampMs.toString(10),
        transactionNonce: toBase64Url(draft.reservedNonce),
        refreshedObservations: refreshed,
        invalidatedObservationIds: invalidated,
      }
    }))
  }

  async cancelDraft(request: CancelDraftRequest, context: RpcCallContext): Promise<CancelDraftResponse> {
    this.#assertGroup(request.groupId)
    const owner = principal(context)
    return this.#once('cancel', request, owner, async () => {
      const draft = this.#drafts.get(request.draftId)
      if (!draft || draft.owner !== owner) return { draftId: request.draftId, cancelled: false }
      try {
        return await this.#withDraft(request.draftId, owner, 'cancelled', async (locked) => {
          this.#drafts.delete(request.draftId)
          return { draftId: locked.id, cancelled: true }
        })
      } catch (error) {
        if (error instanceof ChronologRpcError && error.code === 'not_found') {
          return { draftId: request.draftId, cancelled: false }
        }
        throw error
      }
    })
  }

  async publishDraft(request: PublishDraftRequest, context: RpcCallContext): Promise<PublishDraftResponse> {
    this.#assertGroup(request.groupId)
    const owner = principal(context)
    const fingerprint = stableFingerprint({ ...request, requestId: undefined })
    const key = `${owner}\0${request.groupId}\0${request.idempotencyKey}`
    this.#maintenance()
    const existing = this.#publications.get(key)
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new ChronologRpcError('already_exists', 'Idempotency key was used for another draft')
      this.#touch(this.#publications, key, existing)
      return existing.promise as Promise<PublishDraftResponse>
    }
    this.#ensureEntryCapacity(this.#publications, this.#maxPublicationEntries, 'publication')
    const operation = this.#once('publish', request, owner, () => this.#withDraft(request.draftId, owner, 'publishing', async (draft) => {
      this.#validateCompleteDraft(draft)
      this.#assertDraftConfiguration(draft, this.#backend())
      const program: TransactionProgram = {
        preconditions: draft.preconditions,
        mutations: draft.mutations,
        ...(draft.labels.size === 0 ? {} : {
          metadata: new Map([['chronolog.application-labels.v1', utf8(JSON.stringify(Object.fromEntries(draft.labels)))]]),
        }),
      }
      const published = await publishProgram(this.#node, {
        program,
        authorTimestampMs: draft.reservedAuthorTimestampMs,
        nonce: draft.reservedNonce,
      })
      const actualNonce = published.core.nonce
      if (!equalBytes(actualNonce, draft.reservedNonce)) throw new ChronologRpcError('internal', 'Node did not preserve reserved transaction nonce')
      const response: PublishDraftResponse = {
        transactionId: published.txIdText,
        candidateDigest: toBase64Url(published.candidateDigest),
        authorTimestampMs: published.core.authorTimestampMs.toString(10),
        transactionNonce: toBase64Url(actualNonce),
        schemaDigest: draft.schemaDigest,
        executionManifestDigest: draft.executionManifestDigest,
        durableLocalAppend: true,
        publishedAt: new Date(this.#now()).toISOString(),
      }
      this.#publishedLabels.set(published.txIdText, {
        labels: new Map(draft.labels),
        expiresAtMonotonic: this.#monotonicNow() + this.#retentionTtlMs,
      })
      this.#prunePublishedLabels()
      this.#drafts.delete(draft.id)
      return response
    }))
    const entry = this.#newEntry(fingerprint, operation)
    this.#publications.set(key, entry)
    this.#pruneEntries(this.#publications, this.#maxPublicationEntries)
    void operation.then(
      () => this.#settleEntry(this.#publications, key, entry),
      (error: unknown) => {
        if (error instanceof ChronologRpcError && error.retryable) this.#publications.delete(key)
        else this.#settleEntry(this.#publications, key, entry)
      },
    )
    return operation
  }

  async getOutcome(request: GetOutcomeRequest, _context: RpcCallContext): Promise<TransactionOutcome> {
    this.#assertGroup(request.groupId)
    const txId = utf8(request.transactionId)
    const candidate = this.#node.candidate(txId)
    if (!candidate) throw new ChronologRpcError('not_found', 'Unknown transaction')
    const derived = this.#node.outcome(txId) as DerivedOutcome | null
    const status = await this.#node.status()
    const phase = derived === null
      ? candidate.state === 'admissible' ? 'admissible' : 'collecting_attestations'
      : derived.outcome === 'accepted' ? 'accepted' : 'rejected'
    return {
      transactionId: request.transactionId,
      phase,
      outcome: derived === null
        ? { type: 'pending' }
        : derived.outcome === 'accepted'
          ? { type: 'accepted' }
          : {
              type: 'rejected',
              attribution: this.#rejectionAttribution(request.transactionId, derived),
              message: derived.rejectionCode ?? derived.outcome,
            },
      eventSetRevision: this.#node.revision.toString(10),
      materializedRevision: status.materializedRevision.toString(10),
      orderKey: orderKeyText(candidate.orderKey),
      changedByReplay: this.#node.outcomeChangedByReplay(txId),
      admissible: candidate.state === 'admissible',
      observedAt: new Date(this.#now()).toISOString(),
    }
  }

  async *streamOutcome(request: StreamOutcomeRequest, context: RpcCallContext): AsyncIterable<TransactionOutcome> {
    yield await this.getOutcome(request, context)
    const after = BigInt(request.resumeAfterEventSetRevision ?? this.#node.revision)
    for await (const _event of this.#node.events(after, context.signal)) yield await this.getOutcome(request, context)
  }

  async getSettlementEvidence(request: GetSettlementEvidenceRequest, context: RpcCallContext): Promise<SettlementEvidence> {
    const outcome = await this.getOutcome(request, context)
    const txId = utf8(request.transactionId)
    const candidate = this.#node.candidate(txId)
    const core = this.#node.candidateCore(txId)
    if (!candidate || !core) throw new ChronologRpcError('not_found', 'Unknown transaction')
    const evidence = await this.#node.settlementEvidence(txId)
    const reopenings = new Map(this.#node.controlStore.snapshot().historyReopenings.map((event) => [event.id, event]))
    const historyReopeningEvents = (evidence?.historyReopeningIds ?? []).flatMap((id) => {
      const event = reopenings.get(id)
      return event === undefined ? [] : [{
        eventId: event.id,
        type: 'recovery' as const,
        effectiveFromTimestamp: event.floorMs.toString(10),
        membershipRevision: toBase64Url(event.membershipRevision),
      }]
    })
    return {
      transactionId: request.transactionId,
      outcome,
      evidenceRevision: this.#node.revision.toString(10),
      orderKey: orderKeyText(candidate.orderKey),
      authorTimestamp: core.authorTimestampMs.toString(10),
      validationPolicyId: toBase64Url(core.validationPolicy),
      membershipRevision: toBase64Url(core.membershipRevision),
      ...(evidence?.watermark.cutoffMs === null || evidence === null ? {} : { policyWatermarkTimestamp: evidence.watermark.cutoffMs.toString(10) }),
      blockingHeartbeats: (evidence?.watermark.heartbeatIds ?? []).map(toBase64Url),
      unresolvedReferences: (evidence?.unresolvedAttestationIds ?? []).map((id) => ({ kind: 'attestation' as const, reference: toBase64Url(id) })),
      historyReopeningEvents,
      confidence: historyReopeningEvents.length > 0
        ? 'history_reopened'
        : evidence?.belowWatermark === true ? 'policy_watermark_reached' : evidence === null ? 'insufficient' : 'provisional',
      calculatedAt: new Date(this.#now()).toISOString(),
    }
  }

  async *streamSettlementEvidence(request: StreamSettlementEvidenceRequest, context: RpcCallContext): AsyncIterable<SettlementEvidence> {
    yield await this.getSettlementEvidence(request, context)
    const after = BigInt(request.resumeAfterEventSetRevision ?? this.#node.revision)
    for await (const _event of this.#node.events(after, context.signal)) yield await this.getSettlementEvidence(request, context)
  }

  async getValidatorWatermark(request: GetValidatorWatermarkRequest, _context: RpcCallContext): Promise<ValidatorWatermark> {
    this.#assertGroup(request.groupId)
    const watermark = await this.#node.watermark()
    return {
      groupId: this.#groupId(),
      revision: this.#node.revision.toString(10),
      policyId: watermark?.policyId ?? toBase64Url(this.#node.validationPolicy),
      membershipRevision: toBase64Url(this.#node.membershipRevision),
      ...(watermark?.cutoffMs === null || watermark === null ? {} : { timestamp: watermark.cutoffMs.toString(10) }),
      supportingValidators: (watermark?.blockingValidatorIds ?? []).map(toBase64Url),
      blockedBy: watermark?.explanation === 'established' ? [] : (watermark?.blockingValidatorIds ?? []).map(toBase64Url),
    }
  }

  async getReplicationStatus(request: GetReplicationStatusRequest, _context: RpcCallContext): Promise<ReplicationStatus> {
    this.#assertGroup(request.groupId)
    const status = await this.#node.status()
    const knownPeers = status.transport.configuredPeers?.length ?? status.transport.peers.length
    const ingestionBacklog = Math.max(0, status.transport.records - status.processedTransportRecords)
    const feedsWithGaps = status.transport.feedsWithGaps ??
      status.transport.feedStates?.filter((feed) => feed.hasGaps).length ?? 0
    const pendingPayloads = this.#node.controlStore.listCandidates().filter((candidate) => candidate.state === 'waiting_for_payload').length
    return {
      groupId: this.#groupId(),
      revision: this.#node.revision.toString(10),
      connectedPeers: status.transport.peers.length,
      knownPeers,
      feedsWithGaps,
      pendingPayloads,
      ingestionBacklog,
      materializationPending: status.materializationPending,
      state: status.lastError === undefined && status.transport.lastCatchUpError === undefined
        ? ingestionBacklog > 0 || feedsWithGaps > 0 || pendingPayloads > 0 || status.materializationPending
          ? 'syncing'
          : knownPeers === 0 || status.transport.peers.length > 0 ? 'current' : 'offline'
        : 'degraded',
    }
  }

  async *streamReplicationStatus(request: StreamReplicationStatusRequest, context: RpcCallContext): AsyncIterable<ReplicationStatus> {
    yield await this.getReplicationStatus(request, context)
    const after = BigInt(request.resumeAfterEventSetRevision ?? this.#node.revision)
    for await (const _event of this.#node.events(after, context.signal)) yield await this.getReplicationStatus(request, context)
  }

  async #mutateDraft<T extends { readonly groupId: string; readonly draftId: string; readonly requestId: string }>(
    kind: string,
    request: T,
    context: RpcCallContext,
    mutation: (draft: Draft, backend: NodeRpcIrBackend) => readonly IrDiagnostic[],
  ): Promise<DraftMutationResponse> {
    this.#assertGroup(request.groupId)
    const owner = principal(context)
    return this.#once(kind, request, owner, () => this.#withDraft(request.draftId, owner, 'busy', async (draft) => {
      const backend = this.#backend()
      this.#assertDraftConfiguration(draft, backend)
      const diagnostics = mutation(draft, backend)
      this.#replaceDiagnostics(draft, diagnostics)
      draft.draftRevision += 1n
      return this.#mutationResponse(draft)
    }))
  }

  #validateCompleteDraft(draft: Draft): void {
    if (draft.preconditions.length === 0) throw failed('Every transaction requires a precondition')
    if (draft.mutations.length === 0) throw failed('Every transaction requires a mutation')
    const backend = this.#backend()
    const diagnostics = [
      ...draft.preconditions.flatMap((precondition) => mapDiagnostics(backend.validateQuery(precondition.query), draft.labels.get(`p:${precondition.id}`))),
      ...draft.mutations.flatMap((mutation) => mapDiagnostics(backend.validateMutation(mutation), draft.labels.get(`m:${mutation.id}`))),
    ]
    this.#replaceDiagnostics(draft, diagnostics)
    if (diagnostics.some((item) => item.severity === 'error')) throw protocolRejected(diagnostics)
  }

  #assertPreconditionCapacity(draft: Draft): void {
    if (draft.preconditions.length >= this.#maxPreconditionsPerDraft) {
      throw exhausted('Transaction draft precondition limit reached')
    }
  }

  #replaceDiagnostics(draft: Draft, diagnostics: readonly IrDiagnostic[]): void {
    draft.diagnostics.splice(0, draft.diagnostics.length, ...diagnostics)
  }

  #mutationResponse(draft: Draft): DraftMutationResponse {
    return {
      draftId: draft.id,
      draftRevision: draft.draftRevision.toString(10),
      preconditionCount: draft.preconditions.length,
      mutationCount: draft.mutations.length,
      diagnostics: [...draft.diagnostics],
      expiresAt: new Date(draft.expiresAt).toISOString(),
    }
  }

  async #observationResponse(draft: Draft, observation: StoredObservation, execution: IrQueryExecution): Promise<ObserveIrResponse> {
    const result = await toRpcQueryResult(observation.result, this.#boundedDisplayRows(observation.maxDisplayRows))
    return {
      observationId: observation.id,
      observationToken: observation.token,
      revision: await this.#revisionFromExecution(execution),
      queryDigest: observation.queryDigest,
      dependsOnContext: observation.dependsOnContext,
      ...result,
    }
  }

  #draft(id: string, owner: string): Draft {
    const draft = this.#drafts.get(id)
    this.#pruneDrafts(id)
    if (!draft || draft.state === 'cancelled' || draft.owner !== owner) throw new ChronologRpcError('not_found', 'Unknown draft')
    if (draft.expiresAtMonotonic <= this.#monotonicNow()) {
      if (draft.state === 'open') this.#drafts.delete(id)
      throw new ChronologRpcError('draft_expired', 'Draft expired')
    }
    return draft
  }

  async #withDraft<T>(
    id: string,
    owner: string,
    state: 'busy' | 'publishing' | 'cancelled',
    operation: (draft: Draft) => Promise<T>,
  ): Promise<T> {
    const known = this.#draft(id, owner)
    const previous = known.tail
    let release: (() => void) | undefined
    const turn = new Promise<void>((resolve) => { release = resolve })
    known.tail = previous.then(() => turn)
    await previous
    try {
      const draft = this.#draft(id, owner)
      if (draft !== known || draft.state !== 'open') throw failed('Draft is not open for mutation')
      draft.state = state
      return await operation(draft)
    } finally {
      if (this.#drafts.get(id) === known && known.state !== 'cancelled') known.state = 'open'
      release?.()
    }
  }

  #draftContext(draft: Draft): DraftExecutionContext {
    return this.#executionContext(draft.reservedAuthorTimestampMs, draft.reservedNonce)
  }

  #executionContext(authorTimestampMs: bigint, transactionNonce: Uint8Array): DraftExecutionContext {
    return {
      groupId: this.#node.groupId,
      membershipRevision: this.#node.membershipRevision,
      validationPolicy: this.#node.validationPolicy,
      authorId: this.#node.identity,
      authorTimestampMs,
      transactionNonce: Uint8Array.from(transactionNonce),
    }
  }

  #assertDraftConfiguration(draft: Draft, backend: NodeRpcIrBackend): void {
    if (draft.schemaDigest !== toBase64Url(backend.schemaDigest) ||
        draft.executionManifestDigest !== toBase64Url(backend.executionManifestDigest)) {
      throw revisionUnavailable('Draft schema or execution manifest is no longer available')
    }
  }

  #assertExecutionRevision(execution: IrQueryExecution, requested: bigint): void {
    if (execution.revision !== requested) throw revisionUnavailable('IR backend did not execute the requested immutable revision')
  }

  #backend(): NodeRpcIrBackend {
    return this.#ir
  }

  #boundedDisplayRows(requested?: number): number {
    return boundedRows(requested, this.#maxDisplayRows, 'maxDisplayRows')
  }

  #boundedLocalRows(requested?: number): number {
    return boundedRows(requested, this.#maxLocalSqlRows, 'maxRows')
  }

  #assertGroup(groupId: string): void {
    if (groupId !== this.#groupId()) throw new ChronologRpcError('not_found', 'Unknown group')
  }

  #assertGroupOptional(groupId?: string): void {
    if (groupId !== undefined) this.#assertGroup(groupId)
  }

  #groupId(): string { return toBase64Url(this.#node.groupId) }

  async #revisionFromExecution(execution: IrQueryExecution): Promise<RevisionMetadata> {
    return this.#revision(execution.revision, execution.orderLength, execution.schemaDigest, execution.executionManifestDigest)
  }

  async #revision(
    materializedRevision: bigint,
    orderLength: number,
    schemaDigest = this.#backend().schemaDigest,
    executionManifestDigest = this.#backend().executionManifestDigest,
  ): Promise<RevisionMetadata> {
    return {
      groupId: this.#groupId(),
      eventSetRevision: this.#node.revision.toString(10),
      materializedRevision: materializedRevision.toString(10),
      publishedOrderLength: orderLength.toString(10),
      schemaDigest: toBase64Url(schemaDigest),
      executionManifestDigest: toBase64Url(executionManifestDigest),
      replaying: false,
    }
  }

  #rejectionAttribution(transactionId: string, outcome: DerivedOutcome): RejectionAttribution {
    this.#maintenance()
    const labelEntry = this.#publishedLabels.get(transactionId)
    if (labelEntry !== undefined) this.#touch(this.#publishedLabels, transactionId, labelEntry)
    const persistedLabels = this.#node.candidateCore(utf8(transactionId))?.program.metadata?.get('chronolog.application-labels.v1')
    const labels = labelEntry?.labels ?? decodeApplicationLabels(persistedLabels)
    const code = outcome.rejectionCode ?? outcome.outcome
    const preconditionId = outcome.failingPreconditionId ?? outcome.preconditionId
    const commandId = outcome.failingCommandId ?? outcome.commandId
    const ruleId = outcome.failingRuleId ?? outcome.ruleId
    const constraintId = outcome.failingConstraintId ?? outcome.constraintId
    const key = preconditionId === undefined ? commandId === undefined ? undefined : `m:${commandId}` : `p:${preconditionId}`
    const label = key === undefined ? undefined : labels?.get(key)
    return {
      code,
      ...(preconditionId === undefined ? {} : { preconditionId }),
      ...(commandId === undefined ? {} : { commandId }),
      ...(ruleId === undefined ? {} : { ruleId }),
      ...(constraintId === undefined ? {} : { constraintId }),
      ...(label === undefined ? {} : { applicationLabel: label }),
    }
  }

  #once<T>(kind: string, request: object & { readonly groupId?: string; readonly requestId: string }, owner: string, operation: () => Promise<T>): Promise<T> {
    this.#maintenance()
    const key = `${owner}\0${request.groupId ?? ''}\0${kind}\0${request.requestId}`
    const fingerprint = stableFingerprint(request)
    const previous = this.#idempotent.get(key)
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new ChronologRpcError('already_exists', 'Request ID was reused with different content')
      this.#touch(this.#idempotent, key, previous)
      return previous.promise as Promise<T>
    }
    this.#ensureEntryCapacity(this.#idempotent, this.#maxIdempotencyEntries, 'request')
    const promise = operation()
    const entry = this.#newEntry(fingerprint, promise)
    this.#idempotent.set(key, entry)
    this.#pruneEntries(this.#idempotent, this.#maxIdempotencyEntries)
    void promise.then(
      () => this.#settleEntry(this.#idempotent, key, entry),
      (error: unknown) => {
        if (error instanceof ChronologRpcError && error.retryable) this.#idempotent.delete(key)
        else this.#settleEntry(this.#idempotent, key, entry)
      },
    )
    return promise
  }

  #newEntry(fingerprint: string, promise: Promise<unknown>): IdempotentEntry {
    return {
      fingerprint,
      promise,
      settled: false,
      expiresAtMonotonic: this.#monotonicNow() + this.#retentionTtlMs,
    }
  }

  #settleEntry(map: Map<string, IdempotentEntry>, key: string, entry: IdempotentEntry): void {
    entry.settled = true
    entry.expiresAtMonotonic = this.#monotonicNow() + this.#retentionTtlMs
    if (map.get(key) === entry) this.#touch(map, key, entry)
    this.#pruneEntries(
      map,
      map === this.#idempotent ? this.#maxIdempotencyEntries : this.#maxPublicationEntries,
    )
  }

  #maintenance(): void {
    const now = this.#monotonicNow()
    this.#pruneEntries(this.#idempotent, this.#maxIdempotencyEntries, now)
    this.#pruneEntries(this.#publications, this.#maxPublicationEntries, now)
    this.#prunePublishedLabels(now)
  }

  #pruneDrafts(exceptId?: string): void {
    const now = this.#monotonicNow()
    for (const [id, draft] of this.#drafts) {
      if (id !== exceptId && draft.state === 'open' && draft.expiresAtMonotonic <= now) this.#drafts.delete(id)
    }
  }

  #pruneEntries(map: Map<string, IdempotentEntry>, maximum: number, now = this.#monotonicNow()): void {
    for (const [key, entry] of map) {
      if (entry.settled && entry.expiresAtMonotonic <= now) map.delete(key)
    }
    while (map.size > maximum) {
      const oldestSettled = [...map].find(([, entry]) => entry.settled)
      if (oldestSettled === undefined) break
      map.delete(oldestSettled[0])
    }
  }

  #ensureEntryCapacity(map: Map<string, IdempotentEntry>, maximum: number, kind: string): void {
    this.#pruneEntries(map, maximum)
    while (map.size >= maximum) {
      const oldestSettled = [...map].find(([, entry]) => entry.settled)
      if (oldestSettled === undefined) {
        throw new ChronologRpcError('resource_exhausted', `Too many in-flight unique ${kind}s`, { retryable: true })
      }
      map.delete(oldestSettled[0])
    }
  }

  #prunePublishedLabels(now = this.#monotonicNow()): void {
    for (const [transactionId, entry] of this.#publishedLabels) {
      if (entry.expiresAtMonotonic <= now) this.#publishedLabels.delete(transactionId)
    }
    while (this.#publishedLabels.size > this.#maxPublishedLabelEntries) {
      const oldest = this.#publishedLabels.keys().next().value
      if (oldest === undefined) break
      this.#publishedLabels.delete(oldest)
    }
  }

  #touch<T>(map: Map<string, T>, key: string, value: T): void {
    map.delete(key)
    map.set(key, value)
  }
}

interface DerivedOutcome {
  readonly outcome: string
  readonly rejectionCode: string | null
  readonly preconditionId?: number
  readonly commandId?: number
  readonly ruleId?: number
  readonly constraintId?: number
  readonly failingPreconditionId?: number | null
  readonly failingCommandId?: number | null
  readonly failingRuleId?: number | null
  readonly failingConstraintId?: number | null
}

interface PublishedProgram {
  readonly txIdText: string
  readonly candidateDigest: Uint8Array
  readonly core: { readonly authorTimestampMs: bigint; readonly nonce: Uint8Array }
}

async function publishProgram(
  node: ChronologRpcNodeService,
  input: { readonly program: TransactionProgram; readonly authorTimestampMs: bigint; readonly nonce: Uint8Array },
): Promise<PublishedProgram> {
  return node.publish({ ...input, nonce: Uint8Array.from(input.nonce) })
}

function nodeIrBackend(node: ChronologRpcNodeService): NodeRpcIrBackend {
  return {
    get revision() { return node.materializedRevision },
    get orderLength() { return node.orderLength },
    get schemaDigest() { return node.schemaDigest },
    get executionManifestDigest() { return node.executionManifestDigest },
    query(query, options) {
      return node.queryIr(query, options)
    },
    localQuery(sql, parameters, options) {
      return node.localSql(sql, parameters, options)
    },
    validateQuery(query) {
      return node.validateQuery(query)
    },
    validateMutation(mutation) {
      return node.validateMutation(mutation)
    },
  }
}

function decodeAndBindQuery(queryIr: string, encodedParameters: string, parameterNames: readonly string[]): Query {
  return decodeCanonical('query IR', () => {
    const query = decodeQuery(fromBase64Url(queryIr))
    const parameters = decodeLogicalValues(fromBase64Url(encodedParameters))
    return bindQueryParameters(query, parameters, parameterNames)
  })
}

function decodeCanonical<T>(label: string, operation: () => T): T {
  try {
    return operation()
  } catch (error) {
    if (error instanceof ChronologRpcError) throw error
    throw new ChronologRpcError('invalid_argument', `Malformed canonical ${label}`, { cause: error })
  }
}

function bindQueryParameters(query: Query, parameters: readonly LogicalValue[], parameterNames: readonly string[]): Query {
  if (parameterNames.length !== parameters.length) throw invalid('Parameter names and canonical values have different lengths')
  const values = new Map<string, LogicalValue>()
  for (let index = 0; index < parameterNames.length; index += 1) {
    const name = parameterNames[index]!
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) throw invalid(`Invalid parameter name ${name}`)
    if (values.has(name)) throw invalid(`Duplicate parameter binding ${name}`)
    values.set(name, parameters[index]!)
  }
  const required = collectParameters(query)
  if (required.size !== values.size || [...required].some((name) => !values.has(name))) {
    throw invalid(`Query parameter bindings do not match template names: expected ${[...required].sort().join(', ')}`)
  }
  return replaceParameters(query, values) as Query
}

function collectParameters(value: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectParameters(item, found)
    return found
  }
  if (value instanceof Map) {
    for (const item of value.values()) collectParameters(item, found)
    return found
  }
  if (typeof value !== 'object' || value === null || value instanceof Uint8Array) return found
  const record = value as Record<string, unknown>
  if (record.kind === 'parameter' && typeof record.name === 'string') found.add(record.name)
  for (const item of Object.values(record)) collectParameters(item, found)
  return found
}

function replaceParameters(value: unknown, values: ReadonlyMap<string, LogicalValue>): unknown {
  if (Array.isArray(value)) return value.map((item) => replaceParameters(item, values))
  if (value instanceof Uint8Array) return Uint8Array.from(value)
  if (value instanceof Map) return new Map([...value].map(([key, item]) => [key, replaceParameters(item, values)]))
  if (typeof value !== 'object' || value === null) return value
  const record = value as Record<string, unknown>
  if (record.kind === 'parameter' && typeof record.id === 'number' && typeof record.name === 'string') {
    const replacement = values.get(record.name)
    if (replacement === undefined) throw invalid(`Missing parameter value for ${record.name}`)
    return { kind: 'literal', id: record.id, value: replacement }
  }
  return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, replaceParameters(item, values)]))
}

function collectContextDependencies(value: unknown, found = new Set<ContextField>()): readonly ContextField[] {
  if (Array.isArray(value)) {
    for (const item of value) collectContextDependencies(item, found)
  } else if (value instanceof Map) {
    for (const item of value.values()) collectContextDependencies(item, found)
  } else if (typeof value === 'object' && value !== null && !(value instanceof Uint8Array)) {
    const record = value as Record<string, unknown>
    if (record.kind === 'context' && typeof record.field === 'string') found.add(record.field as ContextField)
    if (record.kind === 'entropy') found.add('transaction_nonce')
    for (const item of Object.values(record)) collectContextDependencies(item, found)
  }
  return Object.freeze([...found].sort())
}

function assertObservableDraftContext(query: Query): void {
  const unavailable = collectContextDependencies(query).filter((field) =>
    field === 'candidate_digest' || field === 'transaction_id' || field === 'author_feed_sequence',
  )
  if (unavailable.length > 0) {
    throw failed(`Draft observation references publication context that is not available before publication: ${unavailable.join(', ')}`)
  }
}

function containsParameterExpression(value: unknown): boolean {
  return collectParameters(value).size > 0
}

async function toRpcQueryResult(result: IrQueryResult, maxRows: number): Promise<CanonicalQueryResult> {
  const rows = result.rows.slice(0, maxRows)
  return {
    schema: result.columns.map(toLogicalColumn),
    resultMode: result.resultMode.kind,
    canonicalResult: toBase64Url(encodeCanonicalQueryResult(result)),
    resultDigest: toBase64Url(await digestCanonicalQueryResult(result)),
    displayRows: rows.map((row) => row.map(toDisplayValue)),
    displayTruncated: rows.length !== result.rows.length,
  }
}

function toLogicalColumn(column: IrQueryResult['columns'][number]): LogicalResultColumn {
  const logical = column.valueType.logical
  return {
    id: column.id,
    name: column.name,
    logicalType: logical.kind,
    nullable: column.valueType.nullable,
    ...(logical.kind === 'decimal' ? { precision: logical.precision, scale: logical.scale } : {}),
    ...(logical.kind === 'vector' ? { vectorElement: logical.element, vectorDimensions: logical.dimensions } : {}),
  }
}

function toDisplayValue(value: LogicalValue): DisplayValue {
  switch (value.kind) {
    case 'null': return { kind: 'null' }
    case 'boolean': return { kind: 'boolean', value: value.value }
    case 'int64': return { kind: 'int64', value: value.value.toString(10) }
    case 'decimal': return { kind: 'decimal', coefficient: value.coefficient.toString(10), scale: value.scale }
    case 'text': return { kind: 'text', value: decodeUtf8(value.utf8) }
    case 'blob': return { kind: 'blob', value: toBase64Url(value.bytes) }
    case 'uuid': return { kind: 'uuid', value: toBase64Url(value.bytes) }
    case 'timestamp_ms': return { kind: 'timestamp_ms', value: value.value.toString(10) }
    case 'duration_ms': return { kind: 'duration_ms', value: value.value.toString(10) }
    case 'json': return { kind: 'json', canonicalJson: canonicalJsonText(value.value) }
    case 'vector': return { kind: 'vector', element: value.element, dimensions: value.dimensions, value: toBase64Url(value.bytes) }
  }
}

function canonicalJsonText(value: CanonicalJsonValue): string {
  if (value === null) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'bigint') return value.toString(10)
  if (typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJsonText).join(',')}]`
  if ('kind' in value) {
    const negative = value.coefficient < 0n
    const digits = (negative ? -value.coefficient : value.coefficient).toString().padStart(value.scale + 1, '0')
    const number = value.scale === 0 ? digits : `${digits.slice(0, -value.scale)}.${digits.slice(-value.scale)}`
    return negative ? `-${number}` : number
  }
  return `{${[...value.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJsonText(item)}`).join(',')}}`
}

function decodeApplicationLabels(value: Uint8Array | undefined): ReadonlyMap<string, string> | undefined {
  if (value === undefined) return undefined
  try {
    const decoded: unknown = JSON.parse(decodeUtf8(value))
    if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) return undefined
    const labels = new Map<string, string>()
    for (const [key, label] of Object.entries(decoded as Record<string, unknown>)) {
      if (!/^[mp]:-?(?:0|[1-9][0-9]*)$/u.test(key) || typeof label !== 'string') return undefined
      labels.set(key, label)
    }
    return labels
  } catch {
    // Application attribution is advisory and must not make outcome reads fail
    // if metadata was produced by a non-RPC writer.
    return undefined
  }
}

function mapDiagnostics(diagnostics: readonly CompilerDiagnostic[], applicationLabel?: string): IrDiagnostic[] {
  return diagnostics.map((diagnostic) => {
    const label = applicationLabel ?? diagnostic.location?.builderLabel
    return {
      nodeId: diagnostic.nodeId ?? 0,
      code: diagnostic.code,
      severity: 'error',
      message: diagnostic.message,
      ...(label === undefined ? {} : { applicationLabel: label }),
    }
  })
}

function protocolRejected(diagnostics: readonly IrDiagnostic[]): ChronologRpcError {
  const first = diagnostics.find((item) => item.severity === 'error')
  return new ChronologRpcError('protocol_rejected', first?.message ?? 'Canonical IR validation failed', {
    ...(first === undefined ? {} : { details: { code: first.code, nodeId: first.nodeId.toString(10) } }),
  })
}

function copyLocalSqlValue(value: LocalSqlValue): LocalSqlValue {
  return value.kind === 'blob' ? { ...value, value: Uint8Array.from(value.value) } : { ...value }
}

function boundedRows(requested: number | undefined, maximum: number, field: string): number {
  if (requested === undefined) return maximum
  if (!Number.isSafeInteger(requested) || requested < 0) throw invalid(`${field} must be a non-negative integer`)
  return Math.min(requested, maximum)
}

function positiveSafeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${field} must be a positive safe integer`)
  return value
}

function nonnegativeSafeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${field} must be a non-negative safe integer`)
  return value
}

function principal(context: RpcCallContext): string {
  return context.metadata?.principal ?? context.token ?? context.peer ?? 'anonymous-local'
}

function stableFingerprint(value: unknown): string {
  if (value === undefined) return 'u'
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'bigint') return `b:${value}`
  if (value instanceof Uint8Array) return `x:${toBase64Url(value)}`
  if (Array.isArray(value)) return `[${value.map(stableFingerprint).join(',')}]`
  if (typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${stableFingerprint(item)}`).join(',')}}`
  }
  throw new TypeError('Unsupported request fingerprint value')
}

async function digestQuery(query: Query): Promise<string> {
  return toBase64Url(await sha256(encodeQuery(query)))
}

function fromBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/u.test(value)) throw invalid('Canonical bytes must use unpadded base64url')
  const padding = '='.repeat((4 - value.length % 4) % 4)
  return Uint8Array.from(Buffer.from(value.replace(/-/gu, '+').replace(/_/gu, '/') + padding, 'base64'))
}

function toBase64Url(value: Uint8Array): string { return Buffer.from(value).toString('base64url') }
function equalBytes(left: Uint8Array, right: Uint8Array): boolean { return left.length === right.length && left.every((byte, index) => byte === right[index]) }
function orderKeyText(key: { readonly authorTimestampMs: bigint; readonly authorId: Uint8Array; readonly authorFeedSequence: bigint; readonly txId: Uint8Array }): string {
  return `${key.authorTimestampMs}:${toBase64Url(key.authorId)}:${key.authorFeedSequence}:${toBase64Url(key.txId)}`
}
function invalid(message: string): ChronologRpcError { return new ChronologRpcError('invalid_argument', message) }
function failed(message: string): ChronologRpcError { return new ChronologRpcError('failed_precondition', message) }
function exhausted(message: string): ChronologRpcError { return new ChronologRpcError('resource_exhausted', message, { retryable: true }) }
function revisionUnavailable(message: string): ChronologRpcError { return new ChronologRpcError('revision_unavailable', message) }
