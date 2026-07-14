import { ControlStore } from '@chronolog/control-store'
import { IrBuilder, values } from '@chronolog/ir'
import {
  encodeTransactionCore,
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
import type { ChronologNodeOptions } from './types.js'
import { encodeSignedEnvelope } from './wire.js'

describe('ChronologNode materializer reconciliation', () => {
  it('repairs a derived materializer behind an already-admissible control order on startup', async () => {
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
    const materialize = vi.fn(async (transactions: readonly unknown[]) => {
      orderLength = transactions.length
      revision += 1n
      return null
    })
    const materializer = {
      get revision() { return revision },
      get orderLength() { return orderLength },
      schemaDigest,
      executionManifestDigest,
      materialize,
      close: vi.fn(),
    } as unknown as ChronologNodeOptions['materializer']
    const transport = new StaticHistoryTransport(record)
    const node = new ChronologNode({
      groupId,
      membershipRevision,
      validationPolicy,
      identity,
      transport,
      materializer,
      controlStore,
      membership: {
        canWrite: () => true,
        canValidate: () => false,
        threshold: () => 1,
      },
    })

    await node.start()
    expect(materialize).toHaveBeenCalledOnce()
    expect(materialize.mock.calls[0]?.[0]).toHaveLength(1)
    expect(node.orderLength).toBe(1)
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
