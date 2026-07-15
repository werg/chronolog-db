import { ControlStore } from '@chronolog/control-store'
import { IrBuilder, values } from '@chronolog/ir'
import type {
  ChronologMaterializationRuntime,
  MaterializedRevision,
  MaterializedRevisionSnapshot,
} from '@chronolog/materializer'
import {
  encodeTransactionCore,
  equalBytes,
  generateEd25519KeyPair,
  transactionDigest,
  transactionOrderKey,
  utf8,
  type TransactionCore,
} from '@chronolog/protocol'
import type {
  ChronologTransport,
  PublishOptions,
  TransportRecord,
  TransportStatus,
} from '@chronolog/transport-ssb'
import { describe, expect, it, vi } from 'vitest'

import { ChronologNode } from './node.js'
import { encodeSignedEnvelope } from './wire.js'

describe('ChronologNode materializer reconciliation', () => {
  it('composes a staged workerd coordinator with publication before exposing its query revision', async () => {
    const identity = await generateEd25519KeyPair()
    const groupId = bytes32(1)
    const membershipRevision = bytes32(2)
    const validationPolicy = bytes32(3)
    const schemaDigest = bytes32(4)
    const executionManifestDigest = bytes32(5)
    const ir = new IrBuilder()
    const core: TransactionCore = {
      groupId,
      membershipRevision,
      validationPolicy,
      authorId: identity.publicKeyBytes,
      authorTimestampMs: 100n,
      nonce: bytes32(6),
      schemaDigest,
      executionManifestDigest,
      program: ir.program([
        ir.assertion(ir.query([
          ir.projection('ok', ir.literal(values.boolean(true))),
        ], { resultMode: { kind: 'scalar' } })),
      ], [
        ir.insert('test_rows', ['id'], [[ir.literal(values.int64(1n))]], { kind: 'exactly', count: 1n }),
      ]),
    }
    const canonical = encodeTransactionCore(core)
    const record: TransportRecord = {
      id: '%startup-reconciliation.sha256',
      author: '@author.ed25519',
      sequence: 1n,
      receivedAtMs: 100,
      payload: await encodeSignedEnvelope(groupId, 'candidate', canonical, identity),
    }
    const txId = utf8(record.id)
    const controlStore = new ControlStore()
    controlStore.putCandidate({
      txId,
      groupId,
      candidateDigest: await transactionDigest(canonical),
      validationPolicy,
      orderKey: transactionOrderKey(core, { authorFeedSequence: record.sequence, txId }),
      canonicalPayload: canonical,
      state: 'admissible',
      proofAttestationIds: [],
    })

    let orderLength = 0
    let revision = 0n
    const subscribers = new Set<(value: MaterializedRevisionSnapshot) => void>()
    const materialize = vi.fn(async (transactions: readonly unknown[]) => {
      const materialized: MaterializedRevision = {
        revision: 1n,
        previousRevision: 0n,
        orderLength: transactions.length,
        replayFromIndex: 0,
        replayedTransactions: transactions.length,
        checkpointPrefix: 0,
        contentHash: 'workerd-candidate-1',
        schemaDigest,
        manifestDigest: executionManifestDigest,
        earliestChangedOrderIndex: 0,
        outcomeChanges: [],
      }
      return {
        revision: materialized,
        publication: {
          publicationKey: 'workerd-execution-1',
          expectedRevision: 0n,
          targetRevision: 1n,
          targetOrderLength: transactions.length,
          candidateIdentity: 'workerd-candidate-1',
        },
      }
    })
    const publish = vi.fn(async (request: {
      readonly publicationKey: string
      readonly expectedRevision: bigint
      readonly targetRevision: bigint
      readonly targetOrderLength: number
    }) => {
      expect(revision).toBe(request.expectedRevision)
      revision = request.targetRevision
      orderLength = request.targetOrderLength
      for (const subscriber of subscribers) subscriber({
        revision,
        orderLength,
        schemaDigest,
        executionManifestDigest,
      })
      return {
        status: 'published' as const,
        publicationKey: request.publicationKey,
        revision,
        orderLength,
        schemaDigest,
        executionManifestDigest,
      }
    })
    const reconcile = vi.fn(async (expectation: {
      readonly targetOrderLength: number
      readonly targetRevision?: bigint
    }) => {
      expect(orderLength).toBe(expectation.targetOrderLength)
      expect(revision).toBe(expectation.targetRevision)
      return {
        status: 'reconciled' as const,
        publicationKey: null,
        revision,
        orderLength,
        schemaDigest,
        executionManifestDigest,
      }
    })
    const materialization: ChronologMaterializationRuntime = {
      coordinator: { materialize },
      queries: {
        get revision() { return revision },
        get orderLength() { return orderLength },
        schemaDigest,
        executionManifestDigest,
        async queryIr() { throw new Error('TEST_QUERY_UNUSED') },
        localSql() { throw new Error('TEST_QUERY_UNUSED') },
        validateQuery() { return [] },
        validateMutation() { return [] },
        outcome() { return null },
        subscribe(subscriber) {
          subscribers.add(subscriber)
          return () => subscribers.delete(subscriber)
        },
      },
      publications: { publish, reconcile },
      close: vi.fn(),
    }
    const observed: bigint[] = []
    materialization.queries.subscribe((value) => observed.push(value.revision))
    const transport = new StaticHistoryTransport(record)
    const node = new ChronologNode({
      groupId,
      membershipRevision,
      validationPolicy,
      identity,
      transport,
      materialization,
      controlStore,
      membership: {
        canWrite: () => true,
        canValidate: () => false,
        threshold: () => 1,
        canUseTransportAuthor: ({ signingId, transportAuthor }) =>
          equalBytes(signingId, identity.publicKeyBytes) && transportAuthor === record.author,
      },
    })

    await node.start()
    expect(materialize).toHaveBeenCalledOnce()
    expect(materialize.mock.calls[0]?.[0]).toHaveLength(1)
    expect(publish).toHaveBeenCalledOnce()
    expect(reconcile).toHaveBeenCalledOnce()
    expect(node.orderLength).toBe(1)
    expect(node.materializedRevision).toBe(1n)
    expect(observed).toEqual([1n])
    await node.close()
  })
})

class StaticHistoryTransport implements ChronologTransport {
  readonly identity = '@static.ed25519'

  constructor(private readonly record: TransportRecord) {}

  async publish(_payload: Uint8Array, _options?: PublishOptions): Promise<TransportRecord> {
    throw new Error('TEST_TRANSPORT_READ_ONLY')
  }

  async get(id: string): Promise<TransportRecord | undefined> {
    return id === this.record.id ? structuredClone(this.record) : undefined
  }

  async history(): Promise<readonly TransportRecord[]> {
    return [structuredClone(this.record)]
  }

  subscribe(): AsyncIterable<TransportRecord> {
    return { async *[Symbol.asyncIterator]() { /* no live records */ } }
  }

  async status(): Promise<TransportStatus> {
    return {
      identity: this.identity,
      records: 1,
      closed: false,
      peers: [],
    }
  }

  async close(): Promise<void> {}
}

function bytes32(seed: number): Uint8Array {
  return Uint8Array.from({ length: 32 }, (_value, index) => (seed + index) & 0xff)
}
