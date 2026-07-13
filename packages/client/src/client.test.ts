import { encodeCanonicalQueryResult, encodeMutation, encodeQuery, type CanonicalQueryResult as IrResult, type Mutation as IrMutation, type Query as IrQuery } from '@chronolog/ir'
import {
  ChronologRpcError,
  InProcessRpcTransport,
  type ChronologRpcService,
  type LiveIrRequest,
} from '@chronolog/rpc'
import { describe, expect, it, vi } from 'vitest'

import { ChronologClient, ClientSchemaMismatchError, type ObservedValue } from './client.js'
import { defineMutation, defineQuery, toBase64Url } from './ir.js'
import { encodeLogicalParameters, int64, text, uuid, vectorFloat32 } from './values.js'

const revision = (eventSetRevision: string, materializedRevision = eventSetRevision) => ({
  groupId: 'group-1',
  eventSetRevision,
  materializedRevision,
  publishedOrderLength: materializedRevision,
  schemaDigest: 'schema-1',
  executionManifestDigest: 'manifest-1',
  replaying: false,
})

const scalarIr: IrQuery = {
  id: 1,
  ctes: [], joins: [], groupBy: [], projection: [{ id: 2, name: 'value', expression: {
    kind: 'parameter', id: 3, name: 'value', valueType: { logical: { kind: 'int64' }, nullable: false },
  } }], windows: [], compounds: [], orderBy: [], resultMode: { kind: 'scalar' },
}
const boolIr: IrQuery = {
  ...scalarIr,
  id: 10,
  projection: [{ id: 11, name: 'ok', expression: { kind: 'literal', id: 12, value: { kind: 'boolean', value: true } } }],
}
const mutationIr: IrMutation = {
  kind: 'update', id: 20, target: { kind: 'name', name: 'accounts' }, assignments: [],
  affectedRows: { kind: 'exactly', count: 1n },
}

const scalarQuery = defineQuery({
  canonicalBytes: encodeQuery(scalarIr),
  resultMode: 'scalar' as const,
  schemaDigest: 'schema-1',
  executionManifestDigest: 'manifest-1',
  parameterNames: ['value'],
  encodeParameters: (parameters: readonly ReturnType<typeof int64>[]) => encodeLogicalParameters(parameters),
  decodeResult: (result) => result.rows[0]?.[0] as bigint,
})
const boolQuery = defineQuery({
  canonicalBytes: encodeQuery(boolIr),
  resultMode: 'scalar' as const,
  parameterNames: [],
  encodeParameters: () => encodeLogicalParameters(),
  decodeResult: (result) => result.rows[0]?.[0] as boolean,
})
const updateMutation = defineMutation('update', encodeMutation(mutationIr), 'debit-account')

function rpcResult(value: string) {
  const ir: IrResult = {
    resultMode: { kind: 'scalar' },
    columns: [{ id: 2, name: 'value', valueType: { logical: { kind: 'int64' }, nullable: false } }],
    rows: [[{ kind: 'int64', value: BigInt(value) }]],
  }
  return {
    schema: [{ id: 2, name: 'value', logicalType: 'int64' as const, nullable: false }],
    resultMode: 'scalar' as const,
    canonicalResult: toBase64Url(encodeCanonicalQueryResult(ir)),
    resultDigest: `digest-${value}`,
    displayRows: [[{ kind: 'int64' as const, value }]],
    displayTruncated: false,
  }
}

function service(overrides: Partial<ChronologRpcService>): ChronologRpcService {
  const missing = async () => { throw new Error('not implemented in test') }
  const missingStream = async function* () { throw new Error('not implemented in test') }
  return {
    getStatus: missing, streamStatus: missingStream,
    executeIr: missing, liveIr: missingStream, localSql: missing,
    beginDraft: missing, observeIr: missing, addAssertionIr: missing,
    addExpectation: missing, addMutationIr: missing, validateDraft: missing,
    rebaseDraft: missing, cancelDraft: async (request) => ({ draftId: request.draftId, cancelled: true }),
    publishDraft: missing, getOutcome: missing, streamOutcome: missingStream,
    getSettlementEvidence: missing, streamSettlementEvidence: missingStream,
    getValidatorWatermark: missing, getReplicationStatus: missing,
    streamReplicationStatus: missingStream,
    ...overrides,
  } as ChronologRpcService
}

function clientFor(rpcService: ChronologRpcService): ChronologClient {
  let id = 0
  return new ChronologClient({
    groupId: 'group-1',
    bindings: { schemaDigest: 'schema-1', executionManifestDigest: 'manifest-1' },
    transport: new InProcessRpcTransport(rpcService),
    requestId: () => `id-${++id}`,
    streamRetryDelayMs: () => 0,
  })
}

function beginResponse(draftId = 'draft-1') {
  return {
    draftId, pinnedRevision: revision('5'), schemaDigest: 'schema-1',
    executionManifestDigest: 'manifest-1', reservedAuthorTimestampMs: '100',
    transactionNonce: 'AA', expiresAt: '2026-07-13T12:10:00.000Z',
  }
}

function mutationResponse(preconditionCount: number, mutationCount: number) {
  return { draftId: 'draft-1', draftRevision: '1', preconditionCount, mutationCount, diagnostics: [], expiresAt: 'later' }
}

function publication() {
  return {
    transactionId: 'tx-1', candidateDigest: 'candidate-1', authorTimestampMs: '100',
    transactionNonce: 'AA', schemaDigest: 'schema-1', executionManifestDigest: 'manifest-1',
    durableLocalAppend: true as const, publishedAt: '2026-07-13T12:00:00.001Z',
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let count = 0; count < 100; count += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  throw new Error('Timed out waiting for condition')
}

describe('ChronologClient canonical IR surface', () => {
  it('builds a pinned draft with observation provenance and no transaction SQL method', async () => {
    const calls: string[] = []
    const rpcService = service({
      beginDraft: async (request) => { calls.push(`begin:${request.atRevision}`); return beginResponse() },
      observeIr: async (request) => {
        calls.push(`observe:${request.queryIr}`)
        return {
          observationId: 'observation-1', observationToken: 'token-1', revision: revision('5'),
          queryDigest: 'query-1', dependsOnContext: [], ...rpcResult('20'),
        }
      },
      addExpectation: async (request) => { calls.push(`expect:${request.source.kind}`); return mutationResponse(1, 0) },
      addAssertionIr: async () => { calls.push('assert'); return mutationResponse(2, 0) },
      addMutationIr: async () => { calls.push('mutation'); return mutationResponse(2, 1) },
      validateDraft: async () => { calls.push('validate'); return mutationResponse(2, 1) },
      publishDraft: async (request) => { calls.push(`publish:${request.idempotencyKey}`); return publication() },
    })
    const client = clientFor(rpcService)
    const handle = await client.transaction(async (draft) => {
      expect('execute' in draft).toBe(false)
      const observed = await draft.observe(scalarQuery, [int64(1n)])
      expect(observed.value).toBe(20n)
      draft.expect(observed)
      draft.assert(boolQuery)
      draft.update(updateMutation)
    }, { atRevision: '5', idempotencyKey: 'payment-42' })

    expect(handle.transactionId).toBe('tx-1')
    expect(calls.map((call) => call.split(':')[0])).toEqual([
      'begin', 'observe', 'expect', 'assert', 'mutation', 'validate', 'publish',
    ])
  })

  it('rejects cross-draft observation provenance before RPC', async () => {
    let firstObservation: ObservedValue<bigint> | undefined
    let draftNumber = 0
    const rpcService = service({
      beginDraft: async () => beginResponse(`draft-${++draftNumber}`),
      observeIr: async () => ({
        observationId: 'observation-1', observationToken: 'token-1', revision: revision('5'),
        queryDigest: 'query-1', dependsOnContext: [], ...rpcResult('20'),
      }),
      addMutationIr: async () => mutationResponse(0, 1),
      addAssertionIr: async () => mutationResponse(1, 0),
      validateDraft: async () => mutationResponse(1, 1),
      publishDraft: async () => publication(),
    })
    const client = clientFor(rpcService)
    await expect(client.transaction(async (draft) => {
      firstObservation = await draft.observe(scalarQuery, [int64(1n)])
      draft.assert(boolQuery).update(updateMutation)
    })).resolves.toBeDefined()
    await expect(client.transaction((draft) => {
      draft.expect(firstObservation!)
      draft.update(updateMutation)
    })).rejects.toThrow('originating draft')
  })

  it('rejects later queued result operations instead of leaving them pending', async () => {
    const observeIr = vi.fn()
    const client = clientFor(service({
      beginDraft: async () => beginResponse(),
      addAssertionIr: async () => { throw new ChronologRpcError('protocol_rejected', 'bad assertion') },
      observeIr,
    }))
    const result = client.transaction(async (draft) => {
      draft.assert(boolQuery)
      await draft.observe(scalarQuery, [int64(1n)])
    })
    await expect(Promise.race([
      result,
      new Promise((_, reject) => setTimeout(() => reject(new Error('hung')), 100)),
    ])).rejects.toThrow('bad assertion')
    expect(observeIr).not.toHaveBeenCalled()
  })

  it('retries publication with exactly the same request and idempotency key', async () => {
    const attempts: Array<{ requestId: string; idempotencyKey: string }> = []
    const client = clientFor(service({
      beginDraft: async () => beginResponse(),
      addAssertionIr: async () => mutationResponse(1, 0),
      addMutationIr: async () => mutationResponse(1, 1),
      validateDraft: async () => mutationResponse(1, 1),
      publishDraft: async (request) => {
        attempts.push({ requestId: request.requestId, idempotencyKey: request.idempotencyKey })
        if (attempts.length === 1) throw new ChronologRpcError('transport_unavailable', 'disconnect')
        return publication()
      },
    }))
    await client.transaction((draft) => { draft.assert(boolQuery).update(updateMutation) }, { idempotencyKey: 'unique-op' })
    expect(attempts).toHaveLength(2)
    expect(attempts[1]).toEqual(attempts[0])
  })

  it('resumes live IR queries with group/query/revision cursor and surfaces reset', async () => {
    const requests: LiveIrRequest[] = []
    const liveIr = (request: LiveIrRequest) => {
      requests.push(request)
      return (async function* () {
        if (requests.length === 1) {
          yield { type: 'snapshot' as const, revision: revision('1'), queryDigest: 'query-1', result: rpcResult('1') }
          throw new ChronologRpcError('transport_unavailable', 'partition')
        }
        yield { type: 'reset' as const, revision: revision('3'), queryDigest: 'query-1', result: rpcResult('3'), reason: 'history_unavailable' as const }
        await new Promise(() => undefined)
      })()
    }
    const live = clientFor(service({ liveIr })).liveQuery(scalarQuery, [int64(1n)])
    const snapshots: string[] = []
    const unsubscribe = live.subscribe(() => {
      const snapshot = live.getSnapshot()
      if (snapshot.status === 'ready' && snapshot.value !== undefined) snapshots.push(`${snapshot.value.type}:${snapshot.value.revision.eventSetRevision}`)
    })
    await waitFor(() => snapshots.includes('reset:3'))
    unsubscribe()
    expect(requests[1]?.resume).toEqual({ groupId: 'group-1', queryDigest: 'query-1', eventSetRevision: '1' })
  })

  it('fails schema compatibility before decoding application rows', async () => {
    const client = clientFor(service({
      executeIr: async () => ({ revision: { ...revision('1'), schemaDigest: 'other' }, queryDigest: 'query-1', result: rpcResult('1') }),
    }))
    await expect(client.query(scalarQuery, [int64(1n)])).rejects.toBeInstanceOf(ClientSchemaMismatchError)
  })

  it('constructs exact logical values and copies mutable input', () => {
    expect(() => int64(Number.MAX_SAFE_INTEGER + 1)).toThrow('safe integer')
    expect(() => text('\ud800')).toThrow('unpaired UTF-16')
    expect(() => uuid(new Uint8Array(15))).toThrow('16 bytes')
    const vector = new Float32Array([1, 2])
    const encoded = vectorFloat32(vector)
    vector[0] = 9
    expect(encoded.kind === 'vector' && encoded.bytes).toEqual(new Uint8Array([63, 128, 0, 0, 64, 0, 0, 0]))
  })

  it('decodes exact canonical rows even when display rows are truncated', async () => {
    const result = { ...rpcResult('9007199254740993'), displayRows: [], displayTruncated: true }
    const client = clientFor(service({
      executeIr: async () => ({ revision: revision('9'), queryDigest: 'exact', result }),
    }))
    const response = await client.query(scalarQuery, [int64(1n)])
    expect(response.result).toBe(9_007_199_254_740_993n)
    expect(response.canonical.rows).toEqual([[9_007_199_254_740_993n]])
  })
})
