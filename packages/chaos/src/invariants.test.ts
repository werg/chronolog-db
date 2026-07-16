import { describe, expect, it } from 'vitest'

import { checkLedgerConsistency, checkMigrationConsistency } from './invariants.js'
import type { WorkloadExpectation } from './types.js'

describe('chaos ledger oracle', () => {
  it('reconciles account balances and versions with committed ledger legs', () => {
    expect(checkLedgerConsistency([
      ['0', '0', '0', '7', '2', '0', null, null],
      ['0', '1', '0', '-7', '1', '0', null, null],
      ['1', '__reserved_constraint_key__', '0', '0', '0', '0', null, { bytes: '' }],
      ['1', 'op-1', '0', '0', '10', '0', null, { bytes: '' }],
      ['1', 'op-2', '0', '0', '-3', '0', 'delta--3', { bytes: 'AQ' }],
      ['1', 'op-2', '1', '1', '-7', '0', 'delta--7', { bytes: 'Ag' }],
    ])).toMatchObject({ passed: true })
  })

  it('reports a committed-state mismatch', () => {
    const result = checkLedgerConsistency([
      ['0', '0', '0', '9', '1', '0', null, null],
      ['1', '__reserved_constraint_key__', '0', '0', '0', '0', null, { bytes: '' }],
      ['1', 'op-1', '0', '0', '8', '0', null, { bytes: '' }],
    ])
    expect(result.passed).toBe(false)
    expect(result.details).toContain('balance=9/8')
  })
})

describe('chaos migration oracle', () => {
  const prefix = 'chaos_migrate_worker_0_operation_0'
  const rollbackPrefix = 'chaos_rollback_worker_1_operation_0'
  const expectations: readonly WorkloadExpectation[] = [
    { transactionId: 'chain-tx', operationId: 'worker-0-operation-0', operation: 'migration_chain', allowedOutcomes: ['accepted'], migrationPrefix: prefix },
    { transactionId: 'rollback-tx', operationId: 'worker-1-operation-0', operation: 'migration_rollback', allowedOutcomes: ['rejected_execution'], migrationPrefix: rollbackPrefix },
    { transactionId: 'legacy-tx', operationId: 'worker-2-operation-0', operation: 'legacy_client_write', allowedOutcomes: ['accepted'] },
    { transactionId: 'current-tx', operationId: 'worker-0-operation-1', operation: 'current_client_write', allowedOutcomes: ['accepted'] },
  ]
  const logRows = expectations.map((expectation) => [
    { bytes: Buffer.from(expectation.transactionId).toString('base64url') },
    '0', null, '0', expectation.operation === 'migration_rollback' ? 'rejected_execution' : 'accepted',
  ])
  const stateRows = [
    ['3', 'worker-2-operation-0', '2', '0', '0', '0', 'legacy-2|', null],
    ['3', 'worker-0-operation-1', '2', '0', '0', '0', 'current-0|worker-0-operation-1@example.test', null],
    ['4', 'worker-2-operation-0', '2', '0', '0', '0', null, null],
    ['4', 'worker-0-operation-1', '2', '1', '0', '0', null, null],
    ['5', 'profiles', '1', '0', '0', '0', 'profiles-v1', null],
    ['5', 'profiles', '2', '0', '0', '0', 'profiles-v2', null],
    ['5', prefix, '1', '0', '0', '0', 'chain-v1', null],
    ['5', prefix, '2', '0', '0', '0', 'chain-v2', null],
  ]
  const schemaRows = [
    ['index', 'chaos_profiles_display_name_idx'],
    ['view', 'chaos_profiles_current'],
    ['trigger', 'chaos_profiles_insert_audit'],
    ['table', `${prefix}_items`],
    ['table', `${prefix}_audit`],
    ['index', `${prefix}_current_idx`],
    ['view', `${prefix}_current_view`],
    ['trigger', `${prefix}_current_trigger`],
  ]

  it('checks migration history, retired objects, rollback, and old/new clients', () => {
    expect(checkMigrationConsistency(stateRows, schemaRows, expectations, logRows)).toEqual({
      passed: true,
      details: '1 chains, 1 rollbacks, 1 legacy and 1 current writes',
    })
  })

  it('detects catalog leakage from a rejected migration', () => {
    const result = checkMigrationConsistency(stateRows, [...schemaRows, ['table', `${rollbackPrefix}_items`]], expectations, logRows)
    expect(result.passed).toBe(false)
    expect(result.details).toContain('leaked rolled-back schema')
  })
})
