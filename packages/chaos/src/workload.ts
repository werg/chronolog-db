import type { ChaosCluster } from './cluster.js'
import { errorText, type RunArtifacts } from './artifacts.js'
import type { SeededRandom } from './rng.js'
import { balanceQuery, balanceUpdate } from './schema.js'
import type { ChaosScenario } from './types.js'

export interface WorkloadResult {
  readonly attempted: number
  readonly published: number
  readonly failed: number
  readonly transactionIds: readonly string[]
}

export async function runWorkload(options: {
  readonly cluster: ChaosCluster
  readonly scenario: ChaosScenario
  readonly artifacts: RunArtifacts
  readonly random: SeededRandom
  readonly startedAt: number
  readonly signal: AbortSignal
}): Promise<WorkloadResult> {
  let attempted = 0
  let published = 0
  let failed = 0
  const transactionIds: string[] = []
  const queries = Array.from({ length: options.scenario.workload.accounts }, (_value, account) => balanceQuery(account))
  const workers = Array.from({ length: options.scenario.workload.workers }, (_value, worker) => (async () => {
    const random = options.random.fork(`worker-${worker}`)
    let operation = 0
    while (!options.signal.aborted && performance.now() - options.startedAt < options.scenario.durationMs) {
      const node = random.pick(options.cluster.nodeNames())
      const account = random.integer(0, options.scenario.workload.accounts - 1)
      const delta = random.integer(options.scenario.workload.minimumDelta, options.scenario.workload.maximumDelta)
      const operationId = `worker-${worker}-operation-${operation++}`
      attempted += 1
      await options.artifacts.record({
        type: 'operation', phase: 'start', name: operationId, node,
        details: { account, delta },
      })
      try {
        const handle = await options.cluster.client(node).transaction(async (draft) => {
          const observed = await draft.observe(queries[account]!, undefined, { applicationLabel: 'chaos.observe_balance' })
          draft.expect(observed, { applicationLabel: 'chaos.expect_balance' })
          draft.update(balanceUpdate(account, observed.value + BigInt(delta)))
        }, {
          idempotencyKey: `${options.random.seed}:${operationId}`,
          signal: AbortSignal.timeout(15_000),
        })
        published += 1
        transactionIds.push(handle.transactionId)
        await options.artifacts.record({
          type: 'operation', phase: 'success', name: operationId, node,
          transactionId: handle.transactionId,
          details: { account, delta },
        })
        handle.dispose()
      } catch (error) {
        failed += 1
        await options.artifacts.record({
          type: 'operation', phase: 'failure', name: operationId, node,
          details: { account, delta }, error: errorText(error),
        })
      }
      const interval = options.scenario.workload.intervalMs
      if (interval > 0) await delay(random.integer(Math.floor(interval / 2), Math.max(1, Math.ceil(interval * 1.5))), options.signal)
    }
  })())
  await Promise.all(workers)
  return { attempted, published, failed, transactionIds }
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolveDelay) => {
    const timer = setTimeout(done, milliseconds)
    const abort = () => { clearTimeout(timer); done() }
    function done(): void { signal.removeEventListener('abort', abort); resolveDelay() }
    signal.addEventListener('abort', abort, { once: true })
  })
}
