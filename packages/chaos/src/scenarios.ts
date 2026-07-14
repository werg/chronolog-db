import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import type { ChaosScenario, FaultSpec, LinkName, NodeName } from './types.js'

const smoke: ChaosScenario = {
  format: 'chronolog-chaos-scenario',
  name: 'smoke',
  description: 'Three-node quorum under latency, a minority partition, and a validator restart.',
  nodes: 3,
  threshold: 2,
  durationMs: 8_000,
  convergenceTimeoutMs: 45_000,
  checkpointEvery: 5,
  cutoffLagMs: 8_000,
  workload: { workers: 3, intervalMs: 80, accounts: 8, minimumDelta: -3, maximumDelta: 5 },
  faults: [
    { atMs: 1_000, durationMs: 1_200, kind: 'latency', links: 'all', latencyMs: 120, jitterMs: 40 },
    { atMs: 2_700, durationMs: 1_800, kind: 'partition', groups: [['node-0', 'node-1'], ['node-2']] },
    { atMs: 5_200, kind: 'restart', node: 'node-1' },
  ],
}

const crash: ChaosScenario = {
  format: 'chronolog-chaos-scenario',
  name: 'crash',
  description: 'Focused SIGKILL, durable-feed recovery, stale-session recycling, and catch-up check.',
  nodes: 3,
  threshold: 2,
  durationMs: 18_000,
  convergenceTimeoutMs: 60_000,
  checkpointEvery: 5,
  cutoffLagMs: 12_000,
  workload: { workers: 4, intervalMs: 60, accounts: 8, minimumDelta: -3, maximumDelta: 5 },
  faults: [
    { atMs: 3_000, durationMs: 3_000, kind: 'crash', node: 'node-2' },
  ],
}

const stress: ChaosScenario = {
  format: 'chronolog-chaos-scenario',
  name: 'stress',
  description: 'Sustained five-node workload across partitions, packet faults, crashes, pauses, and CPU pressure.',
  nodes: 5,
  threshold: 3,
  durationMs: 60_000,
  convergenceTimeoutMs: 90_000,
  checkpointEvery: 10,
  cutoffLagMs: 15_000,
  workload: { workers: 12, intervalMs: 25, accounts: 32, minimumDelta: -10, maximumDelta: 15 },
  faults: [
    { atMs: 3_000, durationMs: 4_000, kind: 'latency', links: 'all', latencyMs: 250, jitterMs: 150 },
    { atMs: 9_000, durationMs: 5_000, kind: 'partition', groups: [['node-0', 'node-1', 'node-2'], ['node-3', 'node-4']] },
    { atMs: 16_000, durationMs: 2_500, kind: 'pause', node: 'node-2' },
    { atMs: 21_000, durationMs: 4_000, kind: 'bandwidth', links: 'all', rateKbps: 32 },
    { atMs: 28_000, durationMs: 3_000, kind: 'crash', node: 'node-4' },
    { atMs: 34_000, durationMs: 4_000, kind: 'cpu', node: 'node-1', cores: 0.15 },
    { atMs: 41_000, durationMs: 2_000, kind: 'timeout', links: 'all', timeoutMs: 600 },
    { atMs: 48_000, kind: 'reset', links: 'all', resetAfterMs: 50 },
    { atMs: 53_000, kind: 'restart', node: 'node-0' },
  ],
}

export const builtInScenarios = Object.freeze({ smoke, crash, stress })

export async function loadScenario(nameOrPath: string): Promise<ChaosScenario> {
  const builtIn = builtInScenarios[nameOrPath as keyof typeof builtInScenarios]
  const value = builtIn ?? JSON.parse(await readFile(resolve(nameOrPath), 'utf8')) as unknown
  return validateScenario(value)
}

export function validateScenario(value: unknown): ChaosScenario {
  if (!isRecord(value) || value.format !== 'chronolog-chaos-scenario') throw new Error('CHAOS_SCENARIO_FORMAT_INVALID')
  const scenario = value as unknown as ChaosScenario
  if (!/^[a-z][a-z0-9_-]{0,62}$/u.test(scenario.name) || typeof scenario.description !== 'string') throw new Error('CHAOS_SCENARIO_NAME_INVALID')
  integerBetween(scenario.nodes, 2, 6, 'nodes')
  integerBetween(scenario.threshold, 1, scenario.nodes, 'threshold')
  integerBetween(scenario.durationMs, 1, 3_600_000, 'durationMs')
  integerBetween(scenario.convergenceTimeoutMs, 1_000, 600_000, 'convergenceTimeoutMs')
  integerBetween(scenario.checkpointEvery, 1, 100_000, 'checkpointEvery')
  integerBetween(scenario.cutoffLagMs, 0, 600_000, 'cutoffLagMs')
  if (!isRecord(scenario.workload)) throw new Error('CHAOS_WORKLOAD_INVALID')
  integerBetween(scenario.workload.workers, 1, 1_000, 'workload.workers')
  integerBetween(scenario.workload.intervalMs, 0, 60_000, 'workload.intervalMs')
  integerBetween(scenario.workload.accounts, 1, 10_000, 'workload.accounts')
  integerBetween(scenario.workload.minimumDelta, -1_000_000, 1_000_000, 'workload.minimumDelta')
  integerBetween(scenario.workload.maximumDelta, scenario.workload.minimumDelta, 1_000_000, 'workload.maximumDelta')
  const faults: unknown = value.faults
  if (!Array.isArray(faults)) throw new Error('CHAOS_FAULTS_INVALID')
  for (const fault of faults as readonly unknown[]) validateFault(fault, scenario)
  return structuredClone(scenario)
}

function validateFault(value: unknown, scenario: ChaosScenario): void {
  if (!isRecord(value) || typeof value.kind !== 'string') throw new Error('CHAOS_FAULT_INVALID')
  const fault = value as unknown as FaultSpec
  integerBetween(fault.atMs, 0, scenario.durationMs, 'fault.atMs')
  if ('durationMs' in fault) integerBetween(fault.durationMs, 1, scenario.durationMs, 'fault.durationMs')
  if ('node' in fault) assertNode(fault.node, scenario.nodes)
  if ('links' in fault && fault.links !== 'all') {
    if (!Array.isArray(fault.links) || fault.links.length === 0) throw new Error('CHAOS_FAULT_LINKS_INVALID')
    for (const link of fault.links as readonly unknown[]) assertLink(link, scenario.nodes)
  }
  switch (fault.kind) {
    case 'partition': {
      if (!Array.isArray(fault.groups) || fault.groups.length < 2) throw new Error('CHAOS_PARTITION_GROUPS_INVALID')
      const members = (fault.groups as readonly unknown[]).flatMap((group) => {
        if (!Array.isArray(group)) throw new Error('CHAOS_PARTITION_GROUPS_INVALID')
        return group as readonly unknown[]
      })
      for (const node of members) assertNode(node, scenario.nodes)
      if (members.length !== scenario.nodes || new Set(members).size !== scenario.nodes) throw new Error('CHAOS_PARTITION_MUST_COVER_NODES_ONCE')
      break
    }
    case 'latency': integerBetween(fault.latencyMs, 0, 60_000, 'latencyMs'); integerBetween(fault.jitterMs, 0, 60_000, 'jitterMs'); break
    case 'bandwidth': integerBetween(fault.rateKbps, 1, 1_000_000, 'rateKbps'); break
    case 'timeout': integerBetween(fault.timeoutMs, 0, 60_000, 'timeoutMs'); break
    case 'reset': integerBetween(fault.resetAfterMs, 0, 60_000, 'resetAfterMs'); break
    case 'cpu': if (!Number.isFinite(fault.cores) || fault.cores <= 0 || fault.cores > 64) throw new Error('CHAOS_CPU_INVALID'); break
    case 'pause': case 'crash': case 'restart': break
    default: throw new Error(`CHAOS_FAULT_KIND_UNSUPPORTED:${(fault as { kind: string }).kind}`)
  }
}

function assertNode(value: unknown, count: number): asserts value is NodeName {
  if (typeof value !== 'string') throw new Error('CHAOS_NODE_INVALID_TYPE')
  const match = /^node-(\d+)$/u.exec(value)
  if (!match || Number(match[1]) >= count) throw new Error(`CHAOS_NODE_INVALID:${value}`)
}

function assertLink(value: unknown, count: number): asserts value is LinkName {
  if (typeof value !== 'string') throw new Error('CHAOS_LINK_INVALID_TYPE')
  const match = /^(node-\d+)->(node-\d+)$/u.exec(value)
  if (!match || match[1] === match[2]) throw new Error(`CHAOS_LINK_INVALID:${value}`)
  assertNode(match[1]!, count)
  assertNode(match[2]!, count)
}

function integerBetween(value: number, minimum: number, maximum: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`CHAOS_SCENARIO_RANGE_INVALID:${field}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
