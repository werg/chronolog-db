import { describe, expect, it } from 'vitest'

import { SeededRandom } from './rng.js'
import { schemaVersionPrecondition } from './schema.js'
import type { WorkloadSpec } from './types.js'
import {
  chooseScheduledWorkloadOperation,
  chooseWorkloadOperation,
  migrationChainStatements,
  migrationRollbackStatements,
} from './workload.js'

const operationKinds = [
  'migration_chain',
  'migration_rollback',
  'legacy_client_write',
  'current_client_write',
  'balance_update',
  'transfer',
  'ordered_touch',
  'empty_returning',
  'document_insert',
  'ddl_sequence',
  'precondition_rejection',
  'constraint_rejection',
] as const

const workload: WorkloadSpec = {
  workers: 1,
  intervalMs: 0,
  accounts: 4,
  minimumDelta: -1,
  maximumDelta: 1,
}

describe('chaos mixed workload selection', () => {
  it('replays the same broad operation sequence for the same seed', () => {
    const sequence = (seed: string) => {
      const random = new SeededRandom(seed)
      return Array.from({ length: 100 }, () => chooseWorkloadOperation(random, workload))
    }
    const first = sequence('mixed-workload')
    expect(sequence('mixed-workload')).toEqual(first)
    expect(new Set(first)).toEqual(new Set(operationKinds))
  })

  it('honors sparse operation weights', () => {
    const selected = chooseWorkloadOperation(new SeededRandom('only-documents'), {
      ...workload,
      operationWeights: { document_insert: 1 },
    })
    expect(selected).toBe('document_insert')
  })

  it('covers every enabled operation at the start of a short multi-worker run', () => {
    const random = new SeededRandom('coverage-prefix')
    const operations = Array.from({ length: 4 }, (_value, operation) =>
      Array.from({ length: 3 }, (_workerValue, worker) =>
        chooseScheduledWorkloadOperation(random, { ...workload, workers: 3 }, worker, operation),
      ),
    ).flat()
    expect(operations).toEqual(operationKinds)
  })

  it('falls back from transfers when only one account exists', () => {
    const selected = chooseWorkloadOperation(new SeededRandom('one-account'), {
      ...workload,
      accounts: 1,
      operationWeights: { transfer: 1 },
    })
    expect(selected).toBe('balance_update')
  })
})

describe('chaos migration workload builders', () => {
  it('builds an inspectable v1-to-v2 lifecycle with backfill and catalog replacement', () => {
    const statements = migrationChainStatements('chaos_migrate_test')
    expect(statements).toHaveLength(20)
    expect(statements.map((statement) => statement.sql)).toEqual(expect.arrayContaining([
      expect.stringContaining('ALTER TABLE chaos_migrate_test_items ADD COLUMN normalized_name'),
      expect.stringContaining('UPDATE chaos_migrate_test_items SET normalized_name'),
      expect.stringContaining('DROP TRIGGER chaos_migrate_test_legacy_trigger'),
      expect.stringContaining('CREATE UNIQUE INDEX chaos_migrate_test_current_idx'),
      expect.stringContaining('CREATE VIEW chaos_migrate_test_current_view'),
      expect.stringContaining('CREATE TRIGGER chaos_migrate_test_current_trigger'),
    ]))
  })

  it('builds a failing migration whose last statement collides with migration history', () => {
    const statements = migrationRollbackStatements('chaos_rollback_test')
    expect(statements).toHaveLength(6)
    expect(statements.at(-1)?.sql).toContain("VALUES ('profiles', 1")
  })

  it('provides a reusable signed schema-version assumption', () => {
    expect(schemaVersionPrecondition('profiles', 2)).toEqual({
      sql: 'SELECT EXISTS (SELECT 1 FROM chaos_schema_migrations WHERE component = ? AND version = ?)',
      parameters: ['profiles', 2n],
      applicationLabel: 'chaos.schema.profiles.v2',
    })
  })
})
