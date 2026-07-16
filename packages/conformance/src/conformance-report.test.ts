import { describe, expect, it } from 'vitest'

import { assertConformanceReport, generateConformanceReport } from './conformance-report.js'

describe('machine-readable conformance report', () => {
  it('keeps portable evidence deterministic while operational metadata changes', async () => {
    const first = await generateConformanceReport({
      sourceCommit: 'first',
      platform: 'test-a',
      generatedAt: '2026-01-01T00:00:00.000Z',
    })
    const second = await generateConformanceReport({
      sourceCommit: 'second',
      platform: 'test-b',
      generatedAt: '2026-01-02T00:00:00.000Z',
    })

    assertConformanceReport(first)
    assertConformanceReport(second)
    expect(first.deterministic).toEqual(second.deterministic)
    expect(first.operational).not.toEqual(second.operational)
    expect(first.deterministic.testGroups.every((group) => group.passed)).toBe(true)
    expect(Object.keys(first.deterministic.featureEvidence)).toEqual(first.deterministic.enabledFeatures)
  })
})
