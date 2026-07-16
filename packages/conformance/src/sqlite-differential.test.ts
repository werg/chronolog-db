import { describe, expect, it } from 'vitest'

import { runSqliteDifferential } from './sqlite-differential.js'

describe('SQLite parser/runtime differential corpus', () => {
  it('classifies every SQL ledger family against the pinned runtime', async () => {
    const report = await runSqliteDifferential()
    expect(report.runtimeVersion).toBe('3.54.0')
    expect(report.coveredFamilies).toBe(report.ledgerFamilies)
    expect(report.failures).toEqual([])
    expect(report.fixtures.filter((fixture) => !fixture.passed)).toEqual([])
    expect(report.passed).toBe(true)
  })
})
