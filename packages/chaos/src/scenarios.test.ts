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

  it('accepts a custom mixed-operation workload', () => {
    const scenario = validateScenario({
      ...builtInScenarios.smoke,
      workload: {
        ...builtInScenarios.smoke.workload,
        maximumTransfer: 13,
        resultSampleSize: 7,
        operationWeights: { transfer: 3, constraint_rejection: 1 },
      },
    })
    expect(scenario.workload.operationWeights).toEqual({ transfer: 3, constraint_rejection: 1 })
  })

  it('rejects unknown and all-zero workload operation weights', () => {
    expect(() => validateScenario({
      ...builtInScenarios.smoke,
      workload: { ...builtInScenarios.smoke.workload, operationWeights: { mystery: 1 } },
    })).toThrow('CHAOS_WORKLOAD_OPERATION_UNKNOWN:mystery')
    expect(() => validateScenario({
      ...builtInScenarios.smoke,
      workload: { ...builtInScenarios.smoke.workload, operationWeights: { transfer: 0 } },
    })).toThrow('CHAOS_WORKLOAD_WEIGHTS_EMPTY')
  })
})
