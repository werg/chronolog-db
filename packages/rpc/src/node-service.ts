import { randomUUID } from 'node:crypto'

import { sha256, utf8 } from '@chronolog/canonical'
import {
  decodeSqlBindingValue,
  encodeSqlBindingValue,
  decodeCanonicalSqlResult,
  decodeCanonicalSchemaIdentity,
  decodeTransactionResultEnvelope,
  digestCanonicalSqlResult,
  digestTransactionResultEnvelope,
  encodeCanonicalSqlResult,
  encodeTransactionResultEnvelope,
  type CanonicalSqlResult,
  type SqlPrecondition,
  type SqlResultMode,
  type SqlStatement,
  type SqlTransactionProgram,
} from '@chronolog/protocol'

import type { ChronologRpcService, RpcCallContext } from './contract.js'
import { ChronologRpcError } from './errors.js'
import type {
  AddPreconditionRequest,
  AddStatementsRequest,
  BeginDraftRequest,
  BeginDraftResponse,
  CancelDraftRequest,
  CancelDraftResponse,
  DraftMutationResponse,
  GetOutcomeRequest,
  GetReplicationStatusRequest,
  GetSettlementEvidenceRequest,
  GetStatusRequest,
  GetTransactionResultRequest,
  GetTransactionResultResponse,
  GetValidatorWatermarkRequest,
  LiveSqlEvent,
  LiveSqlRequest,
  LocalSqlRequest,
  LocalSqlResponse,
  LocalSqlValue,
  NodeStatus,
  ObserveSqlRequest,
  ObserveSqlResponse,
  PublishDraftRequest,
  PublishDraftResponse,
  RebaseDraftRequest,
  RebaseDraftResponse,
  RefreshedObservation,
  RejectionAttribution,
  ReplaceStatementsRequest,
  ReplicationStatus,
  RevisionMetadata,
  RpcSqlStatement,
  SettlementEvidence,
  SqlDiagnostic,
  StreamOutcomeRequest,
  StreamReplicationStatusRequest,
  StreamSettlementEvidenceRequest,
  StreamStatusRequest,
  TransactionOutcome,
  ValidateDraftRequest,
  ValidateDraftResponse,
  ValidatorWatermark,
} from './types.js'
import { RPC_API_VERSION } from './types.js'
import type {
  ChronologRpcNodeService,
  RpcMaterializedOutcome,
  SqlObservationExecution,
} from './service-contract.js'

export type {
  ChronologRpcNodeService,
  LocalSqlExecution,
  RpcMaterializedOutcome,
  RpcNodeCandidate,
  RpcNodeCandidateCore,
  RpcNodeSettlementEvidence,
  RpcNodeStatusSnapshot,
  RpcNodeWatermark,
  SqlObservationExecution,
} from './service-contract.js'

interface StoredObservation {
  readonly id: string
  readonly token: string
  readonly statement: SqlStatement
  readonly resultMode: SqlResultMode
  result: CanonicalSqlResult
  resultDigest: Uint8Array
  revision: bigint
  readonly applicationLabel?: string
}

interface Draft {
  readonly id: string
  readonly owner: string
  readonly expiresAt: number
  readonly expiresAtMonotonic: number
  pinnedRevision: bigint
  executionManifestDigest: Uint8Array
  reservedAuthorTimestampMs: bigint
  reservedNonce: Uint8Array
  readonly preconditions: SqlPrecondition[]
  readonly body: SqlStatement[]
  readonly observations: Map<string, StoredObservation>
  readonly observationPreconditions: Map<number, string>
  diagnostics: SqlDiagnostic[]
  nextPreconditionId: number
  draftRevision: bigint
  state: 'open' | 'busy' | 'publishing' | 'cancelled'
  tail: Promise<void>
}

interface IdempotentEntry {
  readonly fingerprint: string
  readonly promise: Promise<unknown>
  expiresAt: number
}

export interface NodeRpcServiceOptions {
  readonly node: ChronologRpcNodeService
  readonly draftTtlMs?: number
  readonly maxDraftTtlMs?: number
  readonly maxDrafts?: number
  readonly maxObservationsPerDraft?: number
  readonly maxPreconditionsPerDraft?: number
  readonly maxStatementsPerDraft?: number
  readonly maxLocalSqlRows?: number
  readonly retentionTtlMs?: number
  readonly maxIdempotencyEntries?: number
  readonly now?: () => number
  readonly monotonicNow?: () => number
  readonly id?: () => string
}

/** SQL-first RPC facade. Draft state is advisory; only the published SQL program is signed. */
export class NodeRpcService implements ChronologRpcService {
  readonly #node: ChronologRpcNodeService
  readonly #draftTtlMs: number
  readonly #maxDraftTtlMs: number
  readonly #maxDrafts: number
  readonly #maxObservations: number
  readonly #maxPreconditions: number
  readonly #maxStatements: number
  readonly #maxLocalSqlRows: number
  readonly #retentionTtlMs: number
  readonly #maxIdempotencyEntries: number
  readonly #now: () => number
  readonly #monotonicNow: () => number
  readonly #id: () => string
  readonly #drafts = new Map<string, Draft>()
  readonly #idempotent = new Map<string, IdempotentEntry>()
  readonly #publications = new Map<string, IdempotentEntry>()

  constructor(options: NodeRpcServiceOptions) {
    this.#node = options.node
    this.#draftTtlMs = positive(options.draftTtlMs ?? 5 * 60_000, 'draftTtlMs')
    this.#maxDraftTtlMs = positive(options.maxDraftTtlMs ?? 60 * 60_000, 'maxDraftTtlMs')
    this.#maxDrafts = positive(options.maxDrafts ?? 1_024, 'maxDrafts')
    this.#maxObservations = positive(options.maxObservationsPerDraft ?? 1_024, 'maxObservationsPerDraft')
    this.#maxPreconditions = positive(options.maxPreconditionsPerDraft ?? 1_024, 'maxPreconditionsPerDraft')
    this.#maxStatements = positive(options.maxStatementsPerDraft ?? 1_024, 'maxStatementsPerDraft')
    this.#maxLocalSqlRows = nonnegative(options.maxLocalSqlRows ?? 10_000, 'maxLocalSqlRows')
    this.#retentionTtlMs = positive(options.retentionTtlMs ?? 24 * 60 * 60_000, 'retentionTtlMs')
    this.#maxIdempotencyEntries = positive(options.maxIdempotencyEntries ?? 10_000, 'maxIdempotencyEntries')
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
      revision: this.#revision(status.materializedRevision, status.orderLength),
      writable: await this.#node.isWritable(),
      validating: status.validating,
      ...(status.lastError === undefined ? {} : { lastErrorCode: status.lastError }),
    }
  }

  async *streamStatus(request: StreamStatusRequest, context: RpcCallContext): AsyncIterable<NodeStatus> {
    this.#assertGroupOptional(request.groupId)
    yield await this.getStatus(request, context)
    const after = BigInt(request.resumeAfterEventSetRevision ?? this.#node.revision)
    for await (const _event of this.#node.events(after, context.signal)) {
      yield await this.getStatus(request, context)
    }
  }

  async localSql(request: LocalSqlRequest, _context: RpcCallContext): Promise<LocalSqlResponse> {
    this.#assertGroup(request.groupId)
    const atRevision = request.atRevision === undefined ? this.#node.materializedRevision : BigInt(request.atRevision)
    const execution = this.#node.localSql(
      request.sql,
      request.parameters.map(copyLocalSqlValue),
      { atRevision },
    )
    if (execution.revision !== atRevision) throw revisionUnavailable('Requested SQL reader is unavailable')
    const limit = boundedRows(request.maxRows, this.#maxLocalSqlRows)
    const rows = execution.rows.slice(0, limit).map((row) => row.map(copyLocalSqlValue))
    return {
      revision: this.#revision(execution.revision, execution.orderLength),
      result: {
        columns: execution.columns.map((column) => ({ ...column })),
        rows,
        truncated: rows.length !== execution.rows.length,
        consensusSafe: false,
      },
    }
  }

  async *liveSql(request: LiveSqlRequest, context: RpcCallContext): AsyncIterable<LiveSqlEvent> {
    this.#assertGroup(request.groupId)
    const queryDigest = toBase64Url(await sha256(utf8(stableFingerprint({ sql: request.sql, parameters: request.parameters }))))
    if (request.resume !== undefined &&
        (request.resume.groupId !== request.groupId || request.resume.queryDigest !== queryDigest)) {
      throw invalid('Live-query cursor does not belong to this SQL query')
    }
    const barrier = this.#node.revision
    const events = this.#node.events(barrier, context.signal)
    let prior: LocalSqlResponse
    try {
      prior = await this.localSql({ ...request, atRevision: this.#node.materializedRevision.toString(10) }, context)
    } catch (error) {
      if (isSqlInvalid(error)) {
        yield { type: 'reset', revision: this.#revision(this.#node.materializedRevision, this.#node.orderLength), queryDigest, reason: 'query_invalid' }
        return
      }
      throw error
    }
    const initialMatches = request.resume === undefined || request.resume.eventSetRevision === prior.revision.eventSetRevision
    yield initialMatches
      ? { type: 'snapshot', revision: prior.revision, queryDigest, result: prior.result }
      : { type: 'reset', revision: prior.revision, queryDigest, result: prior.result, reason: 'history_unavailable' }
    let priorFingerprint = stableFingerprint(prior.result)
    let priorMaterialized = prior.revision.materializedRevision
    let priorManifest = prior.revision.executionManifestDigest
    for await (const _event of events) {
      if (this.#node.materializedRevision.toString(10) === priorMaterialized) continue
      let next: LocalSqlResponse
      try {
        next = await this.localSql({ ...request, atRevision: this.#node.materializedRevision.toString(10) }, context)
      } catch (error) {
        if (isSqlInvalid(error)) {
          yield { type: 'reset', revision: this.#revision(this.#node.materializedRevision, this.#node.orderLength), queryDigest, reason: 'query_invalid' }
          return
        }
        throw error
      }
      const previousMaterializedRevision = priorMaterialized
      priorMaterialized = next.revision.materializedRevision
      const nextFingerprint = stableFingerprint(next.result)
      if (next.revision.executionManifestDigest !== priorManifest) {
        priorManifest = next.revision.executionManifestDigest
        priorFingerprint = nextFingerprint
        yield { type: 'reset', revision: next.revision, queryDigest, result: next.result, reason: 'manifest_changed' }
      } else if (nextFingerprint !== priorFingerprint) {
        priorFingerprint = nextFingerprint
        yield { type: 'change', revision: next.revision, queryDigest, result: next.result, previousMaterializedRevision }
      }
    }
  }

  async beginDraft(request: BeginDraftRequest, context: RpcCallContext): Promise<BeginDraftResponse> {
    this.#assertGroup(request.groupId)
    const owner = principal(context)
    return this.#once('begin', request, owner, async () => {
      this.#prune()
      if (this.#drafts.size >= this.#maxDrafts) throw exhausted('Too many active transaction drafts')
      const pinnedRevision = request.atRevision === undefined ? this.#node.materializedRevision : BigInt(request.atRevision)
      if (pinnedRevision !== this.#node.materializedRevision) throw revisionUnavailable('Requested draft revision is not retained locally')
      const ttl = Math.min(request.ttlMs ?? this.#draftTtlMs, this.#maxDraftTtlMs)
      positive(ttl, 'ttlMs')
      const reserved = this.#node.reserveTransactionContext()
      if (reserved.nonce.byteLength < 16) throw new ChronologRpcError('internal', 'Node returned an invalid transaction nonce')
      const draft: Draft = {
        id: this.#id(),
        owner,
        expiresAt: this.#now() + ttl,
        expiresAtMonotonic: this.#monotonicNow() + ttl,
        pinnedRevision,
        executionManifestDigest: Uint8Array.from(this.#node.executionManifestDigest),
        reservedAuthorTimestampMs: reserved.authorTimestampMs,
        reservedNonce: Uint8Array.from(reserved.nonce),
        preconditions: [],
        body: [],
        observations: new Map(),
        observationPreconditions: new Map(),
        diagnostics: [],
        nextPreconditionId: Number.MAX_SAFE_INTEGER,
        draftRevision: 0n,
        state: 'open',
        tail: Promise.resolve(),
      }
      this.#drafts.set(draft.id, draft)
      return {
        draftId: draft.id,
        pinnedRevision: this.#revision(pinnedRevision, this.#node.orderLength),
        executionManifestDigest: toBase64Url(draft.executionManifestDigest),
        reservedAuthorTimestampMs: draft.reservedAuthorTimestampMs.toString(10),
        transactionNonce: toBase64Url(draft.reservedNonce),
        expiresAt: new Date(draft.expiresAt).toISOString(),
      }
    })
  }

  async observeSql(request: ObserveSqlRequest, context: RpcCallContext): Promise<ObserveSqlResponse> {
    this.#assertGroup(request.groupId)
    return this.#once('observe', request, principal(context), () =>
      this.#withDraft(request.draftId, principal(context), 'busy', async (draft) => {
        if (draft.observations.size >= this.#maxObservations) throw exhausted('Draft observation limit reached')
        this.#assertDraftConfiguration(draft)
        const statement = decodeStatement(request.statement)
        const diagnostics = this.#statementDiagnostics(statement, 'precondition', { applicationLabel: request.applicationLabel })
        if (diagnostics.length > 0) throw protocolRejected(diagnostics)
        const execution = await this.#node.observe(statement, { atRevision: draft.pinnedRevision, resultMode: request.resultMode })
        this.#assertExecutionRevision(execution, draft.pinnedRevision)
        const observation: StoredObservation = {
          id: this.#id(),
          token: this.#id(),
          statement,
          resultMode: request.resultMode,
          result: execution.result,
          resultDigest: Uint8Array.from(execution.resultDigest),
          revision: execution.revision,
          ...(request.applicationLabel === undefined ? {} : { applicationLabel: request.applicationLabel }),
        }
        draft.observations.set(observation.id, observation)
        draft.draftRevision += 1n
        return this.#observationResponse(observation, execution)
      }),
    )
  }

  async addPrecondition(request: AddPreconditionRequest, context: RpcCallContext): Promise<DraftMutationResponse> {
    this.#assertGroup(request.groupId)
    const owner = principal(context)
    return this.#once('add-precondition', request, owner, () => this.#withDraft(request.draftId, owner, 'busy', async (draft) => {
      if (draft.preconditions.length >= this.#maxPreconditions) throw exhausted('Draft precondition limit reached')
      this.#assertDraftConfiguration(draft)
      let precondition: SqlPrecondition
      let observationId: string | undefined
      if (request.source.kind === 'observation') {
        const observation = draft.observations.get(request.source.observationId)
        if (observation === undefined || observation.token !== request.source.observationToken) throw failed('Observation token is invalid')
        const id = draft.nextPreconditionId--
        precondition = {
          id,
          query: observation.statement,
          resultMode: observation.resultMode,
          expectation: { kind: 'inline', result: observation.result },
          ...(request.applicationLabel ?? observation.applicationLabel) === undefined ? {} : { label: request.applicationLabel ?? observation.applicationLabel },
        }
        observationId = observation.id
      } else {
        const statement = decodeStatement(request.source.statement)
        const id = request.source.id
        const expectation = request.source.kind === 'assert_true'
          ? { kind: 'assert_true' as const }
          : request.source.kind === 'inline'
            ? { kind: 'inline' as const, result: decodeCanonicalResult(request.source.canonicalResult, request.source.resultMode) }
            : { kind: 'digest' as const, digest: requireDigest(request.source.digest) }
        precondition = {
          id,
          query: statement,
          resultMode: request.source.kind === 'assert_true' ? 'scalar' : request.source.resultMode,
          expectation,
          ...(request.applicationLabel === undefined ? {} : { label: request.applicationLabel }),
        }
      }
      if (draft.preconditions.some((item) => item.id === precondition.id)) throw invalid('Precondition ID is already in use')
      const diagnostics = this.#statementDiagnostics(precondition.query, 'precondition', {
        preconditionIndex: draft.preconditions.length,
        applicationLabel: precondition.label,
      })
      draft.preconditions.push(precondition)
      if (observationId !== undefined) draft.observationPreconditions.set(precondition.id, observationId)
      draft.diagnostics = diagnostics
      draft.draftRevision += 1n
      return this.#mutationResponse(draft)
    }))
  }

  async addStatements(request: AddStatementsRequest, context: RpcCallContext): Promise<DraftMutationResponse> {
    return this.#setStatements(request, context, false)
  }

  async replaceStatements(request: ReplaceStatementsRequest, context: RpcCallContext): Promise<DraftMutationResponse> {
    return this.#setStatements(request, context, true)
  }

  async #setStatements(request: AddStatementsRequest | ReplaceStatementsRequest, context: RpcCallContext, replace: boolean): Promise<DraftMutationResponse> {
    this.#assertGroup(request.groupId)
    const owner = principal(context)
    return this.#once(replace ? 'replace-statements' : 'add-statements', request, owner, () =>
      this.#withDraft(request.draftId, owner, 'busy', async (draft) => {
        const statements = request.statements.map(decodeStatement)
        const total = replace ? statements.length : draft.body.length + statements.length
        if (total > this.#maxStatements) throw exhausted('Draft statement limit reached')
        if (replace) draft.body.splice(0, draft.body.length, ...statements)
        else draft.body.push(...statements)
        draft.diagnostics = this.#allDiagnostics(draft)
        draft.draftRevision += 1n
        return this.#mutationResponse(draft)
      }),
    )
  }

  async validateDraft(request: ValidateDraftRequest, context: RpcCallContext): Promise<ValidateDraftResponse> {
    this.#assertGroup(request.groupId)
    return this.#withDraft(request.draftId, principal(context), 'busy', async (draft) => {
      draft.diagnostics = this.#allDiagnostics(draft)
      return this.#mutationResponse(draft)
    })
  }

  async rebaseDraft(request: RebaseDraftRequest, context: RpcCallContext): Promise<RebaseDraftResponse> {
    this.#assertGroup(request.groupId)
    const owner = principal(context)
    return this.#once('rebase', request, owner, () => this.#withDraft(request.draftId, owner, 'busy', async (draft) => {
      const target = request.toRevision === undefined ? this.#node.materializedRevision : BigInt(request.toRevision)
      if (target !== this.#node.materializedRevision) throw revisionUnavailable('Requested rebase revision is not retained locally')
      const refreshed: RefreshedObservation[] = []
      const invalidated: string[] = []
      draft.pinnedRevision = target
      draft.executionManifestDigest = Uint8Array.from(this.#node.executionManifestDigest)
      if (request.renewContext) {
        const reserved = this.#node.reserveTransactionContext()
        draft.reservedAuthorTimestampMs = reserved.authorTimestampMs
        draft.reservedNonce = Uint8Array.from(reserved.nonce)
      }
      if (request.refreshObservations) {
        for (const observation of draft.observations.values()) {
          try {
            const execution = await this.#node.observe(observation.statement, { atRevision: target, resultMode: observation.resultMode })
            const changed = !equalBytes(execution.resultDigest, observation.resultDigest)
            observation.result = execution.result
            observation.resultDigest = Uint8Array.from(execution.resultDigest)
            observation.revision = execution.revision
            for (const [preconditionId, observationId] of draft.observationPreconditions) {
              if (observationId !== observation.id) continue
              const index = draft.preconditions.findIndex((item) => item.id === preconditionId)
              const previous = draft.preconditions[index]
              if (index >= 0 && previous !== undefined) {
                draft.preconditions[index] = { ...previous, expectation: { kind: 'inline', result: observation.result } }
              }
            }
            refreshed.push({ ...(await this.#observationResponse(observation, execution)), changed })
          } catch {
            invalidated.push(observation.id)
          }
        }
      } else {
        invalidated.push(...draft.observations.keys())
      }
      for (const id of invalidated) {
        draft.observations.delete(id)
        for (let index = draft.preconditions.length - 1; index >= 0; index -= 1) {
          const precondition = draft.preconditions[index]
          if (precondition !== undefined && draft.observationPreconditions.get(precondition.id) === id) {
            draft.preconditions.splice(index, 1)
            draft.observationPreconditions.delete(precondition.id)
          }
        }
      }
      draft.diagnostics = this.#allDiagnostics(draft)
      draft.draftRevision += 1n
      return {
        ...this.#mutationResponse(draft),
        pinnedRevision: this.#revision(target, this.#node.orderLength),
        executionManifestDigest: toBase64Url(draft.executionManifestDigest),
        reservedAuthorTimestampMs: draft.reservedAuthorTimestampMs.toString(10),
        transactionNonce: toBase64Url(draft.reservedNonce),
        refreshedObservations: refreshed,
        invalidatedObservationIds: invalidated,
      }
    }))
  }

  async cancelDraft(request: CancelDraftRequest, context: RpcCallContext): Promise<CancelDraftResponse> {
    this.#assertGroup(request.groupId)
    const draft = this.#drafts.get(request.draftId)
    if (draft === undefined || draft.owner !== principal(context)) return { draftId: request.draftId, cancelled: false }
    this.#drafts.delete(request.draftId)
    draft.state = 'cancelled'
    return { draftId: request.draftId, cancelled: true }
  }

  async publishDraft(request: PublishDraftRequest, context: RpcCallContext): Promise<PublishDraftResponse> {
    this.#assertGroup(request.groupId)
    const owner = principal(context)
    this.#prune()
    const key = `${owner}\0${request.groupId}\0${request.idempotencyKey}`
    const fingerprint = stableFingerprint({ draftId: request.draftId })
    const existing = this.#publications.get(key)
    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint) throw new ChronologRpcError('already_exists', 'Publication idempotency key is already in use')
      return existing.promise as Promise<PublishDraftResponse>
    }
    const operation = this.#withDraft(request.draftId, owner, 'publishing', async (draft) => {
      this.#assertDraftConfiguration(draft)
      draft.diagnostics = this.#allDiagnostics(draft)
      if (draft.preconditions.length === 0) throw failed('Every transaction requires a precondition')
      if (draft.body.length === 0) throw failed('Every transaction requires a body statement')
      if (draft.diagnostics.length > 0) throw protocolRejected(draft.diagnostics)
      const published = await this.#node.publish({
        program: { version: 1, preconditions: draft.preconditions, body: draft.body },
        authorTimestampMs: draft.reservedAuthorTimestampMs,
        nonce: Uint8Array.from(draft.reservedNonce),
      })
      if (!equalBytes(published.core.nonce, draft.reservedNonce)) throw new ChronologRpcError('internal', 'Node changed the reserved transaction nonce')
      this.#drafts.delete(draft.id)
      return {
        transactionId: published.txIdText,
        candidateDigest: toBase64Url(published.candidateDigest),
        authorTimestampMs: published.core.authorTimestampMs.toString(10),
        transactionNonce: toBase64Url(published.core.nonce),
        executionManifestDigest: toBase64Url(draft.executionManifestDigest),
        durableLocalAppend: true as const,
        publishedAt: new Date(this.#now()).toISOString(),
      }
    })
    this.#publications.set(key, { fingerprint, promise: operation, expiresAt: this.#monotonicNow() + this.#retentionTtlMs })
    void operation.catch(() => this.#publications.delete(key))
    return operation
  }

  async getOutcome(request: GetOutcomeRequest, _context: RpcCallContext): Promise<TransactionOutcome> {
    this.#assertGroup(request.groupId)
    const txId = utf8(request.transactionId)
    const candidate = this.#node.candidate(txId)
    if (candidate === null) throw new ChronologRpcError('not_found', 'Unknown transaction')
    const outcome = this.#node.outcome(txId)
    const status = await this.#node.status()
    const phase = outcome === null
      ? candidate.state === 'admissible' ? 'admissible' : 'collecting_attestations'
      : outcome.outcome === 'accepted' ? 'accepted' : 'rejected'
    return {
      transactionId: request.transactionId,
      phase,
      outcome: outcome === null
        ? { type: 'pending' }
        : outcome.outcome === 'accepted'
          ? {
              type: 'accepted',
              result: {
                envelopeVersion: requireEnvelopeVersion(outcome),
                digest: toBase64Url(requireOutcomeDigest(outcome)),
                byteLength: outcome.resultEnvelope?.byteLength ?? 0,
              },
            }
          : { type: 'rejected', attribution: this.#rejectionAttribution(request.transactionId, outcome) },
      eventSetRevision: this.#node.revision.toString(10),
      materializedRevision: status.materializedRevision.toString(10),
      orderKey: orderKeyText(candidate.orderKey),
      changedByReplay: this.#node.outcomeChangedByReplay(txId),
      admissible: candidate.state === 'admissible',
      observedAt: new Date(this.#now()).toISOString(),
    }
  }

  async getTransactionResult(request: GetTransactionResultRequest, _context: RpcCallContext): Promise<GetTransactionResultResponse> {
    this.#assertGroup(request.groupId)
    if (request.atMaterializedRevision !== undefined && BigInt(request.atMaterializedRevision) !== this.#node.materializedRevision) {
      throw new ChronologRpcError('revision_not_retained', 'Requested result revision is not retained locally')
    }
    const txId = utf8(request.transactionId)
    const outcome = this.#node.outcome(txId)
    if (outcome === null) throw new ChronologRpcError('not_found', 'Transaction has no materialized outcome')
    if (outcome.outcome !== 'accepted') {
      throw new ChronologRpcError('result_not_available', 'Rejected transactions do not have result envelopes')
    }
    if (outcome.resultEnvelopeVersion !== 1 || outcome.resultDigest === null) {
      throw new ChronologRpcError('internal', 'Accepted transaction result reference is incomplete')
    }
    if (outcome.resultEnvelope === null) throw new ChronologRpcError('internal', 'Accepted transaction result envelope is unavailable')
    const encoded = Uint8Array.from(outcome.resultEnvelope)
    const envelope = decodeTransactionResultEnvelope(encoded)
    if (!equalBytes(encodeTransactionResultEnvelope(envelope), encoded)) {
      throw new ChronologRpcError('internal', 'Stored transaction result envelope is not canonical')
    }
    const digest = await digestTransactionResultEnvelope(encoded)
    if (!equalBytes(digest, outcome.resultDigest)) throw new ChronologRpcError('internal', 'Stored transaction result digest mismatch')
    return {
      revision: this.#revision(this.#node.materializedRevision, this.#node.orderLength),
      transactionId: request.transactionId,
      reference: { envelopeVersion: 1, digest: toBase64Url(digest), byteLength: encoded.byteLength },
      canonicalEnvelope: toBase64Url(encoded),
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
    if (candidate === null || core === null) throw new ChronologRpcError('not_found', 'Unknown transaction')
    const evidence = await this.#node.settlementEvidence(txId)
    const reopenings = new Map(this.#node.controlStore.snapshot().historyReopenings.map((event) => [event.id, event]))
    const historyReopeningEvents = (evidence?.historyReopeningIds ?? []).flatMap((id) => {
      const event = reopenings.get(id)
      return event === undefined ? [] : [{ eventId: event.id, type: 'recovery' as const, effectiveFromTimestamp: event.floorMs.toString(10), membershipRevision: toBase64Url(event.membershipRevision) }]
    })
    return {
      transactionId: request.transactionId,
      outcome,
      evidenceRevision: this.#node.revision.toString(10),
      orderKey: orderKeyText(candidate.orderKey),
      authorTimestamp: core.authorTimestampMs.toString(10),
      validationPolicyId: toBase64Url(core.validationPolicy),
      membershipRevision: toBase64Url(core.membershipRevision),
      ...(evidence?.watermark.cutoffMs == null ? {} : { policyWatermarkTimestamp: evidence.watermark.cutoffMs.toString(10) }),
      blockingHeartbeats: (evidence?.watermark.heartbeatIds ?? []).map(toBase64Url),
      unresolvedReferences: (evidence?.unresolvedAttestationIds ?? []).map((reference) => ({ kind: 'attestation' as const, reference: toBase64Url(reference) })),
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
      ...(watermark?.cutoffMs == null ? {} : { timestamp: watermark.cutoffMs.toString(10) }),
      supportingValidators: (watermark?.blockingValidatorIds ?? []).map(toBase64Url),
      blockedBy: watermark?.explanation === 'established' ? [] : (watermark?.blockingValidatorIds ?? []).map(toBase64Url),
    }
  }

  async getReplicationStatus(request: GetReplicationStatusRequest, _context: RpcCallContext): Promise<ReplicationStatus> {
    this.#assertGroup(request.groupId)
    const status = await this.#node.status()
    const knownPeers = status.transport.configuredPeers?.length ?? status.transport.peers.length
    const ingestionBacklog = Math.max(0, status.transport.records - status.processedTransportRecords)
    const feedsWithGaps = status.transport.feedsWithGaps ?? status.transport.feedStates?.filter((feed) => feed.hasGaps).length ?? 0
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
      state: status.lastError !== undefined || status.transport.lastCatchUpError !== undefined
        ? 'degraded'
        : ingestionBacklog > 0 || feedsWithGaps > 0 || pendingPayloads > 0 || status.materializationPending
          ? 'syncing'
          : knownPeers === 0 || status.transport.peers.length > 0 ? 'current' : 'offline',
    }
  }

  async *streamReplicationStatus(request: StreamReplicationStatusRequest, context: RpcCallContext): AsyncIterable<ReplicationStatus> {
    yield await this.getReplicationStatus(request, context)
    const after = BigInt(request.resumeAfterEventSetRevision ?? this.#node.revision)
    for await (const _event of this.#node.events(after, context.signal)) yield await this.getReplicationStatus(request, context)
  }

  #allDiagnostics(draft: Draft): SqlDiagnostic[] {
    const diagnostics = [
      ...draft.preconditions.flatMap((item, preconditionIndex) => this.#statementDiagnostics(item.query, 'precondition', { preconditionIndex, applicationLabel: item.label })),
      ...draft.body.flatMap((item, statementIndex) => this.#statementDiagnostics(item, 'body', { statementIndex })),
    ]
    if (diagnostics.length === 0 && draft.preconditions.length > 0 && draft.body.length > 0) {
      try {
        const program: SqlTransactionProgram = { version: 1, preconditions: draft.preconditions, body: draft.body }
        this.#node.validateProgram(program)
      } catch (error) {
        diagnostics.push({ code: errorCode(error, 'SQL_PROGRAM_INVALID'), severity: 'error' })
      }
    }
    return diagnostics
  }

  #statementDiagnostics(
    statement: SqlStatement,
    mode: 'precondition' | 'body',
    attribution: {
      readonly preconditionIndex?: number | undefined
      readonly statementIndex?: number | undefined
      readonly applicationLabel?: string | undefined
    },
  ): SqlDiagnostic[] {
    try {
      return this.#node.validateStatement(statement, mode).map((item) => ({
        code: item.code,
        severity: 'error' as const,
        ...(attribution.preconditionIndex === undefined ? {} : { preconditionIndex: attribution.preconditionIndex }),
        ...(attribution.statementIndex === undefined ? {} : { statementIndex: attribution.statementIndex }),
        ...(item.startByte === undefined ? {} : { startByte: item.startByte }),
        ...(item.endByte === undefined ? {} : { endByte: item.endByte }),
        ...(attribution.applicationLabel === undefined ? {} : { applicationLabel: attribution.applicationLabel }),
      }))
    } catch (error) {
      return [{
        code: error instanceof Error ? error.message : 'SQL_INVALID',
        severity: 'error',
        ...(attribution.preconditionIndex === undefined ? {} : { preconditionIndex: attribution.preconditionIndex }),
        ...(attribution.statementIndex === undefined ? {} : { statementIndex: attribution.statementIndex }),
        ...(attribution.applicationLabel === undefined ? {} : { applicationLabel: attribution.applicationLabel }),
      }]
    }
  }

  #mutationResponse(draft: Draft): DraftMutationResponse {
    return {
      draftId: draft.id,
      draftRevision: draft.draftRevision.toString(10),
      preconditionCount: draft.preconditions.length,
      statementCount: draft.body.length,
      diagnostics: draft.diagnostics.map((item) => ({ ...item })),
      expiresAt: new Date(draft.expiresAt).toISOString(),
    }
  }

  async #observationResponse(observation: StoredObservation, execution: SqlObservationExecution): Promise<ObserveSqlResponse> {
    const digest = await digestCanonicalSqlResult(observation.result)
    if (!equalBytes(digest, observation.resultDigest)) throw new ChronologRpcError('internal', 'Observation result digest mismatch')
    return {
      observationId: observation.id,
      observationToken: observation.token,
      revision: this.#revision(execution.revision, execution.orderLength, execution.executionManifestDigest),
      statement: encodeStatement(observation.statement),
      resultMode: observation.resultMode,
      canonicalResult: toBase64Url(encodeCanonicalSqlResult(observation.result)),
      resultDigest: toBase64Url(observation.resultDigest),
    }
  }

  #rejectionAttribution(transactionId: string, outcome: RpcMaterializedOutcome): RejectionAttribution {
    const core = this.#node.candidateCore(utf8(transactionId))
    const label = outcome.failingPreconditionIndex === null
      ? undefined
      : core?.program.preconditions[outcome.failingPreconditionIndex]?.label
    return {
      phase: outcome.failurePhase ?? 'finalize',
      code: outcome.rejectionCode ?? outcome.outcome,
      preconditionId: outcome.failingPreconditionId,
      preconditionIndex: outcome.failingPreconditionIndex,
      statementIndex: outcome.failingStatementIndex,
      constraintIdentity: outcome.failingConstraintIdentity === null
        ? null
        : decodeCanonicalSchemaIdentity(outcome.failingConstraintIdentity),
      triggerIdentity: outcome.failingTriggerIdentity === null
        ? null
        : decodeCanonicalSchemaIdentity(outcome.failingTriggerIdentity),
      ...(label === undefined ? {} : { applicationLabel: label }),
    }
  }

  #revision(materializedRevision: bigint, orderLength: number, manifest = this.#node.executionManifestDigest): RevisionMetadata {
    return {
      groupId: this.#groupId(),
      eventSetRevision: this.#node.revision.toString(10),
      materializedRevision: materializedRevision.toString(10),
      publishedOrderLength: orderLength.toString(10),
      executionManifestDigest: toBase64Url(manifest),
      replaying: false,
    }
  }

  async #withDraft<T>(id: string, owner: string, state: Draft['state'], operation: (draft: Draft) => Promise<T>): Promise<T> {
    const known = this.#draft(id, owner)
    const previous = known.tail
    let release: (() => void) | undefined
    const turn = new Promise<void>((resolve) => { release = resolve })
    known.tail = previous.then(() => turn)
    await previous
    try {
      const draft = this.#draft(id, owner)
      if (draft !== known || draft.state !== 'open') throw failed('Draft is not open')
      draft.state = state
      return await operation(draft)
    } finally {
      if (this.#drafts.get(id) === known && known.state !== 'cancelled') known.state = 'open'
      release?.()
    }
  }

  #draft(id: string, owner: string): Draft {
    this.#prune()
    const draft = this.#drafts.get(id)
    if (draft === undefined || draft.owner !== owner || draft.state === 'cancelled') throw new ChronologRpcError('not_found', 'Unknown draft')
    if (draft.expiresAtMonotonic <= this.#monotonicNow()) {
      this.#drafts.delete(id)
      throw new ChronologRpcError('draft_expired', 'Draft expired')
    }
    return draft
  }

  #assertDraftConfiguration(draft: Draft): void {
    if (!equalBytes(draft.executionManifestDigest, this.#node.executionManifestDigest)) {
      throw revisionUnavailable('Draft execution manifest is no longer available')
    }
  }

  #assertExecutionRevision(execution: SqlObservationExecution, requested: bigint): void {
    if (execution.revision !== requested) throw revisionUnavailable('SQL observation did not use the pinned revision')
  }

  #assertGroup(groupId: string): void {
    if (groupId !== this.#groupId()) throw new ChronologRpcError('not_found', 'Unknown group')
  }

  #assertGroupOptional(groupId?: string): void { if (groupId !== undefined) this.#assertGroup(groupId) }
  #groupId(): string { return toBase64Url(this.#node.groupId) }

  async #once<T>(kind: string, request: { readonly requestId: string; readonly groupId?: string }, owner: string, operation: () => Promise<T>): Promise<T> {
    this.#prune()
    const key = `${kind}\0${owner}\0${request.groupId ?? ''}\0${request.requestId}`
    const fingerprint = stableFingerprint(request)
    const existing = this.#idempotent.get(key)
    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint) throw new ChronologRpcError('already_exists', 'Request ID was reused with different input')
      return existing.promise as Promise<T>
    }
    if (this.#idempotent.size >= this.#maxIdempotencyEntries) throw exhausted('RPC idempotency cache is full')
    const promise = operation()
    this.#idempotent.set(key, { fingerprint, promise, expiresAt: this.#monotonicNow() + this.#retentionTtlMs })
    void promise.catch(() => this.#idempotent.delete(key))
    return promise
  }

  #prune(): void {
    const now = this.#monotonicNow()
    for (const [id, draft] of this.#drafts) if (draft.state === 'open' && draft.expiresAtMonotonic <= now) this.#drafts.delete(id)
    for (const [key, entry] of this.#idempotent) if (entry.expiresAt <= now) this.#idempotent.delete(key)
    for (const [key, entry] of this.#publications) if (entry.expiresAt <= now) this.#publications.delete(key)
  }
}

function decodeStatement(value: RpcSqlStatement): SqlStatement {
  if (typeof value.sql !== 'string' || value.sql.length === 0 || value.sql.includes('\0')) throw invalid('SQL statement source is invalid')
  return {
    sql: value.sql,
    bindings: value.bindings.map((binding) => ({
      parameter: binding.parameter.kind === 'index'
        ? { kind: 'index' as const, index: binding.parameter.index }
        : { kind: 'name' as const, name: binding.parameter.name },
      value: decodeCanonical('SQL binding value', () => decodeSqlBindingValue(fromBase64Url(binding.canonicalValue))),
    })),
  }
}

function encodeStatement(value: SqlStatement): RpcSqlStatement {
  return {
    sql: value.sql,
    bindings: value.bindings.map((binding) => ({
      parameter: binding.parameter.kind === 'index'
        ? { kind: 'index' as const, index: binding.parameter.index }
        : { kind: 'name' as const, name: binding.parameter.name },
      canonicalValue: toBase64Url(encodeSqlBindingValue(binding.value)),
    })),
  }
}

function decodeCanonicalResult(value: string, mode: SqlResultMode): CanonicalSqlResult {
  const result = decodeCanonical('SQL result', () => decodeCanonicalSqlResult(fromBase64Url(value)))
  if (result.mode !== mode) throw invalid('Inline SQL result mode does not match its expectation')
  return result
}

function decodeCanonical<T>(label: string, operation: () => T): T {
  try { return operation() } catch (error) {
    if (error instanceof ChronologRpcError) throw error
    throw new ChronologRpcError('invalid_argument', `Malformed canonical ${label}`, { cause: error })
  }
}

function requireDigest(value: string): Uint8Array {
  const digest = fromBase64Url(value)
  if (digest.byteLength !== 32) throw invalid('Digest must be 32 bytes')
  return digest
}

function requireEnvelopeVersion(outcome: RpcMaterializedOutcome): 1 {
  if (outcome.resultEnvelopeVersion !== 1) throw new ChronologRpcError('internal', 'Accepted transaction has no result envelope version')
  return 1
}

function requireOutcomeDigest(outcome: RpcMaterializedOutcome): Uint8Array {
  if (outcome.resultDigest === null) throw new ChronologRpcError('internal', 'Accepted transaction has no result digest')
  return outcome.resultDigest
}

function protocolRejected(diagnostics: readonly SqlDiagnostic[]): ChronologRpcError {
  const first = diagnostics[0]
  return new ChronologRpcError('protocol_rejected', first?.code ?? 'SQL program is outside the deterministic profile', {
    ...(first === undefined ? {} : { details: { code: first.code } }),
  })
}

function copyLocalSqlValue(value: LocalSqlValue): LocalSqlValue {
  return value.kind === 'blob' ? { ...value, value: Uint8Array.from(value.value) } : { ...value }
}

function boundedRows(requested: number | undefined, maximum: number): number {
  if (requested === undefined) return maximum
  if (!Number.isSafeInteger(requested) || requested < 0) throw invalid('maxRows must be a nonnegative safe integer')
  return Math.min(requested, maximum)
}

function positive(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${field} must be a positive safe integer`)
  return value
}

function nonnegative(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${field} must be a nonnegative safe integer`)
  return value
}

function principal(context: RpcCallContext): string { return context.metadata?.principal ?? context.token ?? context.peer ?? 'anonymous-local' }
function invalid(message: string): ChronologRpcError { return new ChronologRpcError('invalid_argument', message) }
function failed(message: string): ChronologRpcError { return new ChronologRpcError('failed_precondition', message) }
function exhausted(message: string): ChronologRpcError { return new ChronologRpcError('resource_exhausted', message, { retryable: true }) }
function revisionUnavailable(message: string): ChronologRpcError { return new ChronologRpcError('revision_unavailable', message) }
function isSqlInvalid(error: unknown): boolean { return error instanceof Error && /SQL|sqlite|prepare|syntax/iu.test(error.message) }
function errorCode(error: unknown, fallback: string): string {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') return error.code
  return error instanceof Error && error.message !== '' ? error.message : fallback
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

function stableFingerprint(value: unknown): string {
  if (value === undefined) return 'u'
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'bigint') return `b:${value}`
  if (value instanceof Uint8Array) return `x:${toBase64Url(value)}`
  if (Array.isArray(value)) return `[${value.map(stableFingerprint).join(',')}]`
  if (typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableFingerprint(item)}`).join(',')}}`
  throw new TypeError('Unsupported RPC value')
}
