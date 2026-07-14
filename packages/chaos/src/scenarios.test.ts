import { describe, expect, it } from 'vitest'

import { builtInScenarios, validateScenario } from './scenarios.js'

describe('chaos scenarios', () => {
  it('validates and clones every built-in scenario', () => {
    for (const scenario of Object.values(builtInScenarios)) {
      const validated = validateScenario(scenario)
      expect(validated).toEqual(scenario)
      expect(validated).not.toBe(scenario)
    }
  })

  it('rejects partitions that do not cover every node exactly once', () => {
    expect(() => validateScenario({
      ...builtInScenarios.smoke,
      faults: [{ atMs: 1, durationMs: 1, kind: 'partition', groups: [['node-0'], ['node-1']] }],
    })).toThrow('CHAOS_PARTITION_MUST_COVER_NODES_ONCE')
  })

  it('rejects links to unknown nodes', () => {
    expect(() => validateScenario({
      ...builtInScenarios.smoke,
      faults: [{ atMs: 1, durationMs: 1, kind: 'latency', links: ['node-0->node-9'], latencyMs: 1, jitterMs: 0 }],
    })).toThrow('CHAOS_NODE_INVALID')
  })
})
