import { describe, expect, it, vi } from 'vitest'

import type { ChronologRpcService, RpcCallContext } from './contract.js'
import { ChronologRpcError } from './errors.js'
import { InProcessRpcTransport } from './in-process.js'
import { RPC_API_VERSION, type ExecuteIrResponse } from './types.js'

const revision = {
  groupId: 'group-1',
  eventSetRevision: '7',
  materializedRevision: '4',
  publishedOrderLength: '4',
  schemaDigest: 'schema-1',
  executionManifestDigest: 'manifest-1',
  replaying: false,
} as const

const queryResponse: ExecuteIrResponse = {
  revision,
  queryDigest: 'query-digest',
  result: {
    schema: [{ id: 1, name: 'answer', logicalType: 'int64', nullable: false }],
    resultMode: 'scalar',
    canonicalResult: 'AA',
    resultDigest: 'result-digest',
    displayRows: [[{ kind: 'int64', value: '42' }]],
    displayTruncated: false,
  },
}

function service(overrides: Partial<ChronologRpcService>): ChronologRpcService {
  const missing = async () => { throw new Error('not implemented in test') }
  const missingStream = async function* () { throw new Error('not implemented in test') }
  return {
    getStatus: missing,
    streamStatus: missingStream,
    executeIr: missing,
    liveIr: missingStream,
    localSql: missing,
    beginDraft: missing,
    observeIr: missing,
    addAssertionIr: missing,
    addExpectation: missing,
    addMutationIr: missing,
    validateDraft: missing,
    rebaseDraft: missing,
    cancelDraft: missing,
    publishDraft: missing,
    getOutcome: missing,
    streamOutcome: missingStream,
    getSettlementEvidence: missing,
    streamSettlementEvidence: missingStream,
    getValidatorWatermark: missing,
    getReplicationStatus: missing,
    streamReplicationStatus: missingStream,
    ...overrides,
  }
}

describe('InProcessRpcTransport', () => {
  it('dispatches canonical IR calls through interceptors with call context', async () => {
    let context: RpcCallContext | undefined
    const executeIr = vi.fn(async (_request, callContext: RpcCallContext) => {
      context = callContext
      return queryResponse
    })
    const authorize = vi.fn(async (_request, callContext, next) => {
      expect(callContext.token).toBe('secret')
      return next()
    })
    const transport = new InProcessRpcTransport(service({ executeIr }), [authorize])
    const response = await transport.unary('query.executeIr', {
      groupId: 'group-1',
      requestId: 'request-1',
      queryIr: 'AQ',
      parameters: 'gA',
      parameterNames: [],
    }, { token: 'secret' })

    expect(response).toEqual(queryResponse)
    expect(context?.method).toBe('query.executeIr')
    expect(context?.peer).toBe('in-process')
    expect(authorize).toHaveBeenCalledOnce()
  })

  it('copies byte arrays across the in-process boundary', async () => {
    const input = new Uint8Array([1, 2])
    const localSql = vi.fn(async (request) => {
      const parameter = request.parameters[0]
      if (parameter?.kind === 'blob') parameter.value[0] = 9
      return {
        revision,
        result: {
          columns: [{ name: 'value' }],
          rows: [[{ kind: 'blob' as const, value: new Uint8Array([3, 4]) }]],
          truncated: false,
          consensusSafe: false as const,
        },
      }
    })
    const transport = new InProcessRpcTransport(service({ localSql }))
    const response = await transport.unary('query.localSql', {
      groupId: 'group-1', requestId: 'request-1', sql: 'SELECT ?',
      parameters: [{ kind: 'blob', value: input }],
    })
    const output = response.result.rows[0]?.[0]
    expect(input).toEqual(new Uint8Array([1, 2]))
    if (output?.kind !== 'blob') throw new Error('expected blob')
    output.value[0] = 8
    expect((await localSql.mock.results[0]!.value).result.rows[0]?.[0]).toEqual({ kind: 'blob', value: new Uint8Array([3, 4]) })
  })

  it('applies interceptors and cancellation to streaming calls', async () => {
    const authorize = vi.fn(async (_request, _context, next) => next())
    const streamStatus = async function* () {
      yield { apiVersion: RPC_API_VERSION, state: 'ready' as const, nodeId: 'node-1', revision, writable: true, validating: false }
      await new Promise(() => undefined)
    }
    const transport = new InProcessRpcTransport(service({ streamStatus }), [authorize])
    const controller = new AbortController()
    const iterator = transport.stream('node.streamStatus', {
      groupId: 'group-1', requestId: 'request-1',
    }, { signal: controller.signal })[Symbol.asyncIterator]()

    expect((await iterator.next()).value?.nodeId).toBe('node-1')
    controller.abort()
    await expect(iterator.next()).rejects.toMatchObject({ code: 'cancelled' })
    expect(authorize).toHaveBeenCalledOnce()
  })

  it('returns stable deadline and closed-transport errors', async () => {
    const getStatus = async () => new Promise<never>(() => undefined)
    const transport = new InProcessRpcTransport(service({ getStatus }))
    await expect(transport.unary('node.getStatus', { requestId: 'one' }, { timeoutMs: 1 }))
      .rejects.toMatchObject({ code: 'deadline_exceeded', retryable: true })
    await transport.close()
    await expect(transport.unary('node.getStatus', { requestId: 'two' }))
      .rejects.toEqual(expect.any(ChronologRpcError))
  })
})
