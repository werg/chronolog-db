import type { ExactDatabaseRef } from '@chronolog/materializer'
import { describe, expect, it, vi } from 'vitest'

import type { ChronologWorkerdPublicationIntent } from './host-client.js'
import {
  publishChronologCasIntent,
  type ChronologCasPublicationBackend,
  type ChronologCasRefState,
} from './publication.js'

describe('workerd CAS publication boundary', () => {
  it('never moves a ref when immutable output verification fails', async () => {
    const compare = vi.fn<ChronologCasPublicationBackend['compareAndSwapRef']>()
    const backend = fixtureBackend({
      verifyExactOutput: vi.fn().mockRejectedValue(new Error('CAS_OBJECT_MISSING')),
      compareAndSwapRef: compare,
    })
    await expect(publishChronologCasIntent(backend, intent(null, database(2)))).rejects
      .toThrow('CAS_OBJECT_MISSING')
    expect(compare).not.toHaveBeenCalled()
  })

  it('publishes with generation-guarded compare-and-swap', async () => {
    const previous = database(1)
    const selected = database(2)
    const compare = vi.fn<ChronologCasPublicationBackend['compareAndSwapRef']>()
      .mockResolvedValue({ applied: true, state: { generation: 8n, current: selected } })
    const backend = fixtureBackend({
      readRef: vi.fn().mockResolvedValue({ generation: 7n, current: previous }),
      compareAndSwapRef: compare,
    })
    await expect(publishChronologCasIntent(backend, intent(previous, selected))).resolves
      .toMatchObject({ status: 'published', generation: 8n, current: selected })
    expect(compare).toHaveBeenCalledWith(expect.objectContaining({
      expectedGeneration: 7n,
      expectedCurrent: previous,
      selected,
    }))
  })

  it('reconciles a crash after CAS as already current', async () => {
    const previous = database(1)
    const selected = database(2)
    const read = vi.fn<ChronologCasPublicationBackend['readRef']>()
      .mockResolvedValueOnce({ generation: 7n, current: previous })
      .mockResolvedValueOnce({ generation: 8n, current: selected })
    const backend = fixtureBackend({
      readRef: read,
      compareAndSwapRef: vi.fn().mockRejectedValue(new Error('CONNECTION_LOST_AFTER_CAS')),
    })
    await expect(publishChronologCasIntent(backend, intent(previous, selected))).resolves
      .toMatchObject({ status: 'already_current', generation: 8n, current: selected })
  })

  it('preserves an ambiguous pre-CAS failure when the expected ref remains', async () => {
    const previous = database(1)
    const read = vi.fn<ChronologCasPublicationBackend['readRef']>()
      .mockResolvedValue({ generation: 7n, current: previous })
    const backend = fixtureBackend({
      readRef: read,
      compareAndSwapRef: vi.fn().mockRejectedValue(new Error('CONNECTION_LOST_BEFORE_CAS')),
    })
    await expect(publishChronologCasIntent(backend, intent(previous, database(2)))).rejects
      .toThrow('CONNECTION_LOST_BEFORE_CAS')
  })

  it('reports competing and idempotent ref states without attempting CAS', async () => {
    const selected = database(2)
    const compare = vi.fn<ChronologCasPublicationBackend['compareAndSwapRef']>()
    const conflict = fixtureBackend({
      readRef: vi.fn().mockResolvedValue({ generation: 9n, current: database(3) }),
      compareAndSwapRef: compare,
    })
    await expect(publishChronologCasIntent(conflict, intent(database(1), selected))).resolves
      .toMatchObject({ status: 'conflict', generation: 9n })

    const retry = fixtureBackend({
      readRef: vi.fn().mockResolvedValue({ generation: 8n, current: selected }),
      compareAndSwapRef: compare,
    })
    await expect(publishChronologCasIntent(retry, intent(database(1), selected))).resolves
      .toMatchObject({ status: 'already_current', generation: 8n })
    expect(compare).not.toHaveBeenCalled()
  })
})

function fixtureBackend(
  overrides: Partial<ChronologCasPublicationBackend>,
): ChronologCasPublicationBackend {
  return {
    verifyExactOutput: async () => undefined,
    readRef: async (): Promise<ChronologCasRefState> => ({ generation: null, current: null }),
    compareAndSwapRef: async () => ({ applied: false, state: { generation: null, current: null } }),
    ...overrides,
  }
}

function intent(
  expectedCurrent: ExactDatabaseRef | null,
  selected: ExactDatabaseRef,
): ChronologWorkerdPublicationIntent {
  return {
    version: 1,
    executionKey: bytes(32, 90),
    refName: 'groups/example/materialized',
    selectedOutput: { name: 'materialized', ref: selected },
    selectedTransportOutput: {
      logicalName: 'materialized',
      sqlAlias: 'materialized_db',
      database: {
        repositoryRoot: {
          storeId: hex(selected.storeId),
          codecNumber: 1,
          codecVersion: 1,
          hashAlgorithm: 'sha2-256',
          digest: hex(bytes(32, 70)),
        },
        doltFormatVersion: selected.doltFormatVersion,
        commitHash: hex(selected.commitHash.contentId.digest),
        stateFormatVersion: selected.stateDigest.stateFormatVersion,
        stateDigest: hex(selected.stateDigest.contentId.digest),
      },
    },
    expectedCurrent,
  }
}

function database(seed: number): ExactDatabaseRef {
  return {
    storeId: bytes(16, 1),
    doltFormatVersion: 1,
    canonicalGenesisCommit: {
      doltFormatVersion: 1,
      contentId: { algorithm: 'dolt-blake3-160', digest: bytes(20, 10) },
    },
    commitHash: {
      doltFormatVersion: 1,
      contentId: { algorithm: 'dolt-blake3-160', digest: bytes(20, seed) },
    },
    stateDigest: {
      stateFormatVersion: 1,
      contentId: { algorithm: 'sha2-256', digest: bytes(32, seed + 20) },
    },
  }
}

function bytes(length: number, seed: number): Uint8Array {
  return Uint8Array.from({ length }, (_value, index) => (seed + index) & 0xff)
}

function hex(value: Uint8Array): string { return Buffer.from(value).toString('hex') }
