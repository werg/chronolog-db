import { describe, expect, it } from 'vitest'

import { SeededRandom } from './rng.js'
import { builtInScenarios, validateScenario } from './scenarios.js'

describe('chaos scenario primitives', () => {
  it('reproduces random choices exactly from a seed', () => {
    const left = new SeededRandom('repeatable')
    const right = new SeededRandom('repeatable')
    expect(Array.from({ length: 100 }, () => left.integer(-20, 20)))
      .toEqual(Array.from({ length: 100 }, () => right.integer(-20, 20)))
    expect(left.bytes(37)).toEqual(right.bytes(37))
  })

  it('validates built-in scenarios and rejects incomplete partitions', () => {
    expect(validateScenario(builtInScenarios.smoke).name).toBe('smoke')
    expect(() => validateScenario({
      ...builtInScenarios.smoke,
      faults: [{ atMs: 1, durationMs: 1, kind: 'partition', groups: [['node-0'], ['node-1']] }],
    })).toThrow('CHAOS_PARTITION_MUST_COVER_NODES_ONCE')
  })
})
