import type {
  AdmittedTransaction,
  MaterializedRevision as PortableMaterializedRevision,
} from '@chronolog/materializer'
import { describe, expect, it, vi } from 'vitest'

import { createDoltLiteLegacyMaterializationRuntime } from './legacy-runtime.js'
import type {
  DoltLiteLegacyMaterializer,
} from './legacy-runtime.js'
import type { MaterializedRevision } from './types.js'

const digest = (seed: number): Uint8Array => new Uint8Array(32).fill(seed)

describe('DoltLite legacy materialization runtime adapter', () => {
  it('preserves current query revisions, subscriptions, and idempotent publication reconciliation', async () => {
    let revision = 0n
    let orderLength = 0
    const subscribers = new Set<(value: MaterializedRevision) => void>()
    const close = vi.fn()
    const materializer = {
      get revision() { return revision },
      get orderLength() { return orderLength },
      schemaDigest: digest(1),
      executionManifestDigest: digest(2),
      async materialize(transactions: readonly AdmittedTransaction[]) {
        const value = materializedRevision(revision, revision + 1n, transactions.length)
        revision = value.revision
        orderLength = value.orderLength
        for (const subscriber of subscribers) subscriber(value)
        return value
      },
      async queryIr() {
        return {
          revision,
          orderLength,
          schemaDigest: digest(1),
          executionManifestDigest: digest(2),
          result: { resultMode: { kind: 'scalar' as const }, columns: [], rows: [] },
          resultDigest: digest(3),
        }
      },
      localSql() { return { revision, orderLength, columns: [], rows: [] } },
      validateQuery() { return [] },
      validateMutation() { return [] },
      outcome() { return null },
      subscribe(subscriber: (value: MaterializedRevision) => void) {
        subscribers.add(subscriber)
        return () => subscribers.delete(subscriber)
      },
      close,
    } as DoltLiteLegacyMaterializer
    const runtime = createDoltLiteLegacyMaterializationRuntime(materializer)
    const observed: bigint[] = []
    const unsubscribe = runtime.queries.subscribe((value) => observed.push(value.revision))

    const coordinated = await runtime.coordinator.materialize([])
    expect(coordinated?.revision.revision).toBe(1n)
    expect(runtime.queries.revision).toBe(1n)
    expect(observed).toEqual([1n])
    expect((await runtime.queries.queryIr({} as never)).revision).toBe(1n)

    const first = await runtime.publications.publish(coordinated!.publication)
    const retry = await runtime.publications.publish(coordinated!.publication)
    expect(first).toMatchObject({ status: 'already_current', revision: 1n, orderLength: 0 })
    expect(retry).toEqual(first)
    expect(await runtime.publications.reconcile({ targetRevision: 1n, targetOrderLength: 0 }))
      .toMatchObject({ status: 'reconciled', revision: 1n })
    await expect(runtime.publications.publish({
      ...coordinated!.publication,
      targetOrderLength: 1,
    })).rejects.toThrow('MATERIALIZATION_PUBLICATION_KEY_REUSED')

    const second = await runtime.coordinator.materialize([])
    await runtime.publications.publish(second!.publication)
    expect((await runtime.publications.publish(coordinated!.publication)).revision).toBe(1n)
    expect(observed).toEqual([1n, 2n])

    unsubscribe()
    await runtime.close()
    expect(close).toHaveBeenCalledOnce()
  })
})

function materializedRevision(
  previousRevision: bigint,
  revision: bigint,
  orderLength: number,
): MaterializedRevision & PortableMaterializedRevision {
  return {
    revision,
    previousRevision,
    orderLength,
    replayFromIndex: 0,
    replayedTransactions: orderLength,
    checkpointPrefix: 0,
    contentHash: `commit-${revision}`,
    schemaDigest: digest(1),
    manifestDigest: digest(2),
    earliestChangedOrderIndex: 0,
    outcomeChanges: [],
  }
}
