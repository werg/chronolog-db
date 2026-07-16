import {
  ChronologRpcError,
  type RpcTransport,
  type StreamOutcomeRequest,
  type TransactionOutcome,
} from '@chronolog/rpc'
import { describe, expect, it } from 'vitest'

import { ChronologClient } from './client.js'

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let count = 0; count < 100; count += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  throw new Error('Timed out waiting for condition')
}

describe('ChronologClient transaction results', () => {
  it('resumes after an outcome whose accepted result revision is no longer retained', async () => {
    const requests: StreamOutcomeRequest[] = []
    const outcome: TransactionOutcome = {
      transactionId: 'tx-1',
      phase: 'accepted',
      outcome: {
        type: 'accepted',
        result: { envelopeVersion: 1, digest: 'digest', byteLength: 1 },
      },
      eventSetRevision: '7',
      materializedRevision: '3',
      changedByReplay: false,
      admissible: true,
      observedAt: '2026-07-16T00:00:00.000Z',
    }
    const transport = {
      async unary() {
        throw new ChronologRpcError('revision_not_retained', 'stale result revision')
      },
      stream(_method: string, request: StreamOutcomeRequest) {
        requests.push(structuredClone(request))
        return {
          async *[Symbol.asyncIterator]() { yield outcome },
        }
      },
    } as unknown as RpcTransport
    const client = new ChronologClient({
      transport,
      groupId: 'group-1',
      requestId: () => 'request-1',
      streamRetryDelayMs: () => 0,
    })
    const resource = client.transactionResult('tx-1')
    const unsubscribe = resource.subscribe(() => undefined)
    try {
      await waitFor(() => requests.length >= 2)
      expect(requests[0]?.resumeAfterEventSetRevision).toBeUndefined()
      expect(requests[1]?.resumeAfterEventSetRevision).toBe('7')
      expect(resource.getSnapshot()).toMatchObject({ value: null })
    } finally {
      unsubscribe()
      await client.close()
    }
  })
})
