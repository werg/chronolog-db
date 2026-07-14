import { encodeLogicalValues, encodeMutation, encodeQuery, type CanonicalQueryResult as IrResult, type Mutation, type Query } from '@chronolog/ir'
import { RevisionBroadcaster, type ChronologNode, type NodeRevisionEvent } from '@chronolog/node-core'
import { describe, expect, it, vi } from 'vitest'

import type { RpcCallContext } from './contract.js'
import { NodeRpcService, type NodeRpcIrBackend } from './node-service.js'
import type { AddAssertionIrRequest, AddMutationIrRequest, BeginDraftResponse } from './types.js'

const groupId = 'AQ'
const schemaDigest = Uint8Array.of(11)
const manifestDigest = Uint8Array.of(12)
const emptyParameters = toBase64Url(encodeLogicalValues([]))

const booleanQuery: Query = {
  id: 1, ctes: [], joins: [], groupBy: [], windows: [], compounds: [], orderBy: [],
  projection: [{ id: 2, name: 'ok', expression: { kind: 'literal', id: 3, value: { kind: 'boolean', value: true } } }],
  resultMode: { kind: 'scalar' },
}
const contextQuery: Query = {
  ...booleanQuery,
  id: 4,
  projection: [{ id: 5, name: 'now', expression: { kind: 'context', id: 6, field: 'author_timestamp_ms' } }],
}
const unavailableContextQuery: Query = {
  ...booleanQuery,
  id: 8,
  projection: [{ id: 9, name: 'tx', expression: { kind: 'context', id: 10, field: 'transaction_id' } }],
}
const parameterQuery: Query = {
  ...booleanQuery,
  id: 11,
  projection: [{
    id: 12,
    name: 'amount',
    expression: {
      kind: 'parameter', id: 13, name: 'amount',
      valueType: { logical: { kind: 'int64' }, nullable: false },
    },
  }],
}
const updateMutation: Mutation = {
  kind: 'update', id: 7, target: { kind: 'name', name: 'accounts' }, assignments: [],
  affectedRows: { kind: 'exactly', count: 1n },
}

function queryBytes(query = booleanQuery): string { return toBase64Url(encodeQuery(query)) }
function mutationBytes(): string { return toBase64Url(encodeMutation(updateMutation)) }
function result(changed = false): IrResult {
  return {
    resultMode: { kind: 'scalar' },
    columns: [{ id: 2, name: 'ok', valueType: { logical: { kind: 'boolean' }, nullable: false } }],
    rows: [[{ kind: 'boolean', value: changed }]],
  }
}

class FakeNode {
  readonly groupId = Uint8Array.of(1)
  readonly identity = Uint8Array.of(2)
  readonly membershipRevision = Uint8Array.of(3)
  readonly validationPolicy = Uint8Array.of(4)
  readonly controlStore = { listCandidates: () => [] }
  readonly schemaDigest = schemaDigest
  readonly executionManifestDigest = manifestDigest
  readonly #events = new RevisionBroadcaster<NodeRevisionEvent>()
  backend: FakeBackend | undefined
  revision = 1n
  materializedRevision = 1n
  orderLength = 1
  reserveCount = 0
  candidateValue: unknown = null
  outcomeValue: unknown = null
  readonly publish = vi.fn(async (input: { program: unknown; authorTimestampMs: bigint; nonce: Uint8Array }) => ({
    txId: new TextEncoder().encode('tx-1'),
    txIdText: 'tx-1',
    candidateDigest: Uint8Array.of(9),
    core: { authorTimestampMs: input.authorTimestampMs, nonce: Uint8Array.from(input.nonce) },
  }))

  reserveTransactionContext() {
    this.reserveCount += 1
    return { authorTimestampMs: BigInt(100 + this.reserveCount), nonce: new Uint8Array(32).fill(this.reserveCount) }
  }

  async status() {
    return {
      started: true, closed: false, eventSetRevision: this.revision, candidates: 0, admitted: 0,
      materializedRevision: this.materializedRevision, orderLength: this.orderLength,
      schemaDigest, executionManifestDigest: manifestDigest, validating: false,
      transport: { peers: [] },
    }
  }

  async isWritable() { return true }

  candidate() { return this.candidateValue }
  outcome() { return this.outcomeValue }
  outcomeChangedByReplay() { return false }

  queryIr(query: Query, options?: { readonly atRevision?: bigint; readonly context?: Parameters<FakeBackend['query']>[1]['context'] }) {
    if (this.backend === undefined) throw new Error('missing fake backend')
    return this.backend.query(query, { atRevision: options?.atRevision ?? this.backend.revision, context: options?.context })
  }

  localSql(sql: string, parameters: readonly unknown[], options?: { readonly atRevision?: bigint }) {
    if (this.backend === undefined) throw new Error('missing fake backend')
    return this.backend.localQuery(sql, parameters, { atRevision: options?.atRevision ?? this.backend.revision })
  }

  validateQuery(query: Query) {
    if (this.backend === undefined) throw new Error('missing fake backend')
    return this.backend.validateQuery(query)
  }

  validateMutation(mutation: Mutation) {
    if (this.backend === undefined) throw new Error('missing fake backend')
    return this.backend.validateMutation(mutation)
  }

  events(afterRevision = 0n, signal?: AbortSignal): AsyncIterable<NodeRevisionEvent> {
    const source = this.#events.subscribe(signal === undefined ? {} : { signal })
    return {
      async *[Symbol.asyncIterator]() {
        for await (const event of source) if (event.revision > afterRevision) yield event
      },
    }
  }

  emitMaterialized(revision: bigint): void {
    this.materializedRevision = revision
    this.revision += 1n
    this.#events.emit({ revision: this.revision, reason: 'materialized' })
  }
}

class FakeBackend implements NodeRpcIrBackend {
  revision = 1n
  orderLength = 1
  readonly schemaDigest = schemaDigest
  readonly executionManifestDigest = manifestDigest
  queryCount = 0
  lastQuery: Query | undefined
  lastContext: Parameters<NodeRpcIrBackend['query']>[1]['context']
  failQuery = false
  onFirstQuery: (() => void) | undefined

  query(query: Query, options: { atRevision: bigint; context?: Parameters<NodeRpcIrBackend['query']>[1]['context'] }) {
    if (this.failQuery) throw new Error('staged query failed')
    this.queryCount += 1
    this.lastQuery = query
    this.lastContext = options.context
    const revision = options.atRevision
    const execution = {
      revision,
      orderLength: Number(revision),
      schemaDigest,
      executionManifestDigest: manifestDigest,
      result: result(revision > 1n),
    }
    if (this.queryCount === 1) this.onFirstQuery?.()
    return execution
  }

  localQuery(_sql: string, _parameters: readonly unknown[], options: { atRevision: bigint }) {
    return {
      revision: options.atRevision, orderLength: Number(options.atRevision),
      columns: [{ name: 'value' }], rows: [[{ kind: 'integer' as const, value: '42' }]],
    }
  }

  validateQuery(_query: Query) { return [] }
  validateMutation(_mutation: Mutation) { return [] }
}

const context: RpcCallContext = { method: 'transaction.beginDraft', peer: 'test-principal' }

function fixture(options: { now?: () => number; monotonicNow?: () => number } = {}) {
  const node = new FakeNode()
  const backend = new FakeBackend()
  node.backend = backend
  let id = 0
  const service = new NodeRpcService({
    node: node as unknown as ChronologNode,
    irBackend: backend,
    id: () => `opaque-${++id}`,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.monotonicNow === undefined ? {} : { monotonicNow: options.monotonicNow }),
  })
  return { node, backend, service }
}

async function begin(service: NodeRpcService, requestId = 'begin-1', ttlMs?: number): Promise<BeginDraftResponse> {
  return service.beginDraft({ groupId, requestId, ...(ttlMs === undefined ? {} : { ttlMs }) }, context)
}

function assertion(draftId: string, requestId = 'assert-1'): AddAssertionIrRequest {
  return { groupId, draftId, requestId, queryIr: queryBytes(), parameters: emptyParameters, parameterNames: [] }
}

function mutation(draftId: string, requestId = 'mutation-1'): AddMutationIrRequest {
  return { groupId, draftId, requestId, mutationIr: mutationBytes() }
}

describe('NodeRpcService canonical drafts', () => {
  it('preserves reserved context and publishes only once for idempotent retries', async () => {
    const { node, service } = fixture({ now: () => 1_000, monotonicNow: () => 10 })
    const draft = await begin(service)
    await service.addAssertionIr(assertion(draft.draftId), context)
    await service.addMutationIr(mutation(draft.draftId), context)
    const first = await service.publishDraft({ groupId, draftId: draft.draftId, requestId: 'publish-1', idempotencyKey: 'once' }, context)
    const retry = await service.publishDraft({ groupId, draftId: draft.draftId, requestId: 'publish-2', idempotencyKey: 'once' }, context)

    expect(retry).toEqual(first)
    expect(node.publish).toHaveBeenCalledOnce()
    const input = node.publish.mock.calls[0]?.[0]
    expect(input?.authorTimestampMs.toString()).toBe(draft.reservedAuthorTimestampMs)
    expect(toBase64Url(input?.nonce ?? new Uint8Array())).toBe(draft.transactionNonce)
    expect(first.transactionNonce).toBe(draft.transactionNonce)
  })

  it('enforces monotonic TTL expiry and explicit cancellation', async () => {
    let monotonic = 0
    const { service } = fixture({ now: () => 1_000, monotonicNow: () => monotonic })
    const expired = await begin(service, 'begin-expired', 10)
    monotonic = 11
    await expect(service.addAssertionIr(assertion(expired.draftId, 'expired-assert'), context))
      .rejects.toMatchObject({ code: 'draft_expired' })

    monotonic = 0
    const cancelled = await begin(service, 'begin-cancelled', 10)
    await expect(service.cancelDraft({ groupId, draftId: cancelled.draftId, requestId: 'cancel-1' }, context))
      .resolves.toEqual({ draftId: cancelled.draftId, cancelled: true })
    await expect(service.validateDraft({ groupId, draftId: cancelled.draftId, requestId: 'validate-cancelled' }, context))
      .rejects.toMatchObject({ code: 'not_found' })
  })

  it('binds expectation provenance and invalidates context observations on renewal', async () => {
    const { service } = fixture()
    const draft = await begin(service)
    const observed = await service.observeIr({
      groupId, draftId: draft.draftId, requestId: 'observe-1',
      queryIr: queryBytes(contextQuery), parameters: emptyParameters, parameterNames: [],
    }, context)
    await expect(service.addExpectation({
      groupId, draftId: draft.draftId, requestId: 'bad-expect',
      source: { kind: 'observation', observationId: observed.observationId, observationToken: 'wrong' },
    }, context)).rejects.toMatchObject({ code: 'invalid_argument' })

    const rebased = await service.rebaseDraft({
      groupId, draftId: draft.draftId, requestId: 'rebase-1', refreshObservations: false, renewContext: true,
    }, context)
    expect(rebased.invalidatedObservationIds).toEqual([observed.observationId])
    expect(rebased.transactionNonce).not.toBe(draft.transactionNonce)
    await expect(service.addExpectation({
      groupId, draftId: draft.draftId, requestId: 'stale-expect',
      source: { kind: 'observation', observationId: observed.observationId, observationToken: observed.observationToken },
    }, context)).rejects.toMatchObject({ code: 'invalid_argument' })
  })

  it('rejects malformed canonical IR before invoking the backend', async () => {
    const { backend, service } = fixture()
    await expect(service.executeIr({
      groupId, requestId: 'query-bad', queryIr: 'AA', parameters: emptyParameters,
      parameterNames: [],
    }, { ...context, method: 'query.executeIr' })).rejects.toMatchObject({ code: 'invalid_argument' })
    expect(backend.queryCount).toBe(0)
  })

  it('uses the node IR backend by default, binds named Int64 parameters, and exposes only reserved draft context', async () => {
    const node = new FakeNode()
    const backend = new FakeBackend()
    node.backend = backend
    let id = 0
    const service = new NodeRpcService({
      node: node as unknown as ChronologNode,
      id: () => `direct-${++id}`,
    })
    await service.executeIr({
      groupId,
      requestId: 'named-parameter',
      queryIr: queryBytes(parameterQuery),
      parameters: toBase64Url(encodeLogicalValues([{ kind: 'int64', value: 42n }])),
      parameterNames: ['amount'],
    }, { ...context, method: 'query.executeIr' })
    expect(backend.lastQuery?.projection[0]?.expression).toEqual({
      kind: 'literal', id: 13, value: { kind: 'int64', value: 42n },
    })

    const draft = await begin(service, 'direct-begin')
    await service.observeIr({
      groupId,
      draftId: draft.draftId,
      requestId: 'direct-observe',
      queryIr: queryBytes(contextQuery),
      parameters: emptyParameters,
      parameterNames: [],
    }, context)
    expect(backend.lastContext).toEqual({
      groupId: node.groupId,
      membershipRevision: node.membershipRevision,
      validationPolicy: node.validationPolicy,
      authorId: node.identity,
      authorTimestampMs: BigInt(draft.reservedAuthorTimestampMs),
      transactionNonce: new Uint8Array(32).fill(1),
    })
    const queryCount = backend.queryCount
    await expect(service.observeIr({
      groupId,
      draftId: draft.draftId,
      requestId: 'unavailable-observe',
      queryIr: queryBytes(unavailableContextQuery),
      parameters: emptyParameters,
      parameterNames: [],
    }, context)).rejects.toMatchObject({ code: 'failed_precondition' })
    expect(backend.queryCount).toBe(queryCount)
  })

  it('leaves a draft unchanged when a staged rebase refresh fails', async () => {
    const { backend, node, service } = fixture()
    const draft = await begin(service, 'atomic-begin')
    const contextual = await service.observeIr({
      groupId,
      draftId: draft.draftId,
      requestId: 'atomic-context',
      queryIr: queryBytes(contextQuery),
      parameters: emptyParameters,
      parameterNames: [],
    }, context)
    await service.observeIr({
      groupId,
      draftId: draft.draftId,
      requestId: 'atomic-plain',
      queryIr: queryBytes(booleanQuery),
      parameters: emptyParameters,
      parameterNames: [],
    }, context)
    backend.revision = 2n
    backend.orderLength = 2
    node.materializedRevision = 2n
    node.orderLength = 2
    backend.failQuery = true
    await expect(service.rebaseDraft({
      groupId,
      draftId: draft.draftId,
      requestId: 'atomic-rebase',
      refreshObservations: true,
      renewContext: true,
    }, context)).rejects.toThrow('staged query failed')
    backend.failQuery = false
    await expect(service.addExpectation({
      groupId,
      draftId: draft.draftId,
      requestId: 'atomic-expect',
      source: {
        kind: 'observation',
        observationId: contextual.observationId,
        observationToken: contextual.observationToken,
      },
    }, context)).resolves.toMatchObject({ preconditionCount: 1 })
  })

  it('uses a subscribe-before-snapshot barrier and separates event/materialized revisions', async () => {
    const { backend, node, service } = fixture()
    backend.onFirstQuery = () => {
      backend.revision = 2n
      backend.orderLength = 2
      node.emitMaterialized(2n)
    }
    const iterator = service.liveIr({
      groupId, requestId: 'live-1', queryIr: queryBytes(), parameters: emptyParameters,
      parameterNames: [],
    }, { ...context, method: 'query.liveIr' })[Symbol.asyncIterator]()
    const snapshot = (await iterator.next()).value
    const change = (await iterator.next()).value
    expect(snapshot?.revision.materializedRevision).toBe('1')
    expect(snapshot?.revision.eventSetRevision).toBe('2')
    expect(change?.type).toBe('change')
    expect(change?.revision.materializedRevision).toBe('2')
    await iterator.return?.()

    const resetIterator = service.liveIr({
      groupId, requestId: 'live-reset', queryIr: queryBytes(), parameters: emptyParameters,
      parameterNames: [],
      resume: { groupId, queryDigest: change?.queryDigest ?? '', eventSetRevision: '0' },
    }, { ...context, method: 'query.liveIr' })[Symbol.asyncIterator]()
    expect((await resetIterator.next()).value?.type).toBe('reset')
    await resetIterator.return?.()
  })

  it('marks the local SQL boundary as non-consensus data', async () => {
    const { service } = fixture()
    const response = await service.localSql({
      groupId, requestId: 'local-1', sql: 'SELECT 42', parameters: [],
    }, { ...context, method: 'query.localSql' })
    expect(response.result.consensusSafe).toBe(false)
    expect(response.result.rows).toEqual([[{ kind: 'integer', value: '42' }]])
  })

  it('maps materializer rejection IDs to structured application attribution', async () => {
    const { node, service } = fixture()
    const draft = await begin(service, 'attribution-begin')
    await service.addAssertionIr({ ...assertion(draft.draftId, 'attribution-assert'), applicationLabel: 'balance-still-current' }, context)
    await service.addMutationIr(mutation(draft.draftId, 'attribution-mutation'), context)
    const published = await service.publishDraft({
      groupId,
      draftId: draft.draftId,
      requestId: 'attribution-publish',
      idempotencyKey: 'attribution',
    }, context)
    const publishedProgram = (node.publish.mock.calls[0]?.[0] as { program: { preconditions: readonly { id: number }[] } }).program
    const preconditionId = publishedProgram.preconditions[0]!.id
    node.candidateValue = {
      state: 'admissible',
      orderKey: {
        authorTimestampMs: 101n,
        authorId: node.identity,
        authorFeedSequence: 1n,
        txId: new TextEncoder().encode(published.transactionId),
      },
    }
    node.outcomeValue = {
      outcome: 'rejected_precondition',
      rejectionCode: 'PRECONDITION_FALSE',
      failingPreconditionId: preconditionId,
      failingCommandId: null,
      failingRuleId: null,
      failingConstraintId: null,
    }
    const outcome = await service.getOutcome({
      groupId,
      transactionId: published.transactionId,
      requestId: 'attribution-outcome',
    }, context)
    expect(outcome.outcome).toEqual({
      type: 'rejected',
      attribution: {
        code: 'PRECONDITION_FALSE',
        preconditionId,
        applicationLabel: 'balance-still-current',
      },
      message: 'PRECONDITION_FALSE',
    })
  })
})

function toBase64Url(value: Uint8Array): string { return Buffer.from(value).toString('base64url') }
