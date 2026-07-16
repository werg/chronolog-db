import { resolve } from 'node:path'

import { errorText, RunArtifacts } from './artifacts.js'
import { prepareCluster } from './bootstrap.js'
import { buildChaosImage, ChaosCluster, describeChaosEnvironment, type FaultHandle } from './cluster.js'
import { waitForConvergence } from './invariants.js'
import { SeededRandom } from './rng.js'
import type { ChaosScenario, FaultSpec, NodeSnapshot, RunSummary } from './types.js'
import { runWorkload, type WorkloadResult } from './workload.js'

export interface RunOptions {
  readonly scenario: ChaosScenario
  readonly seed: string
  readonly artifactRoot: string
  readonly repositoryRoot: string
  readonly image: string
  readonly buildImage: boolean
  readonly signal?: AbortSignal
  readonly progress?: (message: string) => void
}

export interface CompletedRun {
  readonly artifacts: string
  readonly summary: RunSummary
}

export async function runChaos(options: RunOptions): Promise<CompletedRun> {
  const artifacts = await RunArtifacts.create(options.artifactRoot, options.scenario, options.seed)
  const progress = options.progress ?? (() => undefined)
  let cluster: ChaosCluster | undefined
  let workload: WorkloadResult = { attempted: 0, published: 0, failed: 0, transactionIds: [], expectations: [], byKind: {} }
  let snapshots: readonly NodeSnapshot[] = []
  let invariants: RunSummary['invariants'] = []
  let failure: string | undefined
  let stopTelemetry: (() => Promise<void>) | undefined
  const controller = new AbortController()
  const relayAbort = () => controller.abort(options.signal?.reason)
  options.signal?.addEventListener('abort', relayAbort, { once: true })

  try {
    await artifacts.record({ type: 'run', phase: 'start', name: 'run', details: { seed: options.seed, scenario: options.scenario.name } })
    if (options.buildImage) {
      progress(`Building ${options.image}`)
      await artifacts.record({ type: 'run', phase: 'start', name: 'image.build', details: { image: options.image } })
      await buildChaosImage(options.repositoryRoot, options.image)
      await artifacts.record({ type: 'run', phase: 'success', name: 'image.build', details: { image: options.image } })
    }
    await artifacts.writeJson('environment.json', await describeChaosEnvironment(options.image))
    progress('Preparing permissioned cluster identities and schema')
    const prepared = await prepareCluster(artifacts.directory, options.scenario, new SeededRandom(options.seed).fork('cluster'))
    progress(`Starting ${options.scenario.nodes} Chronolog nodes and ${options.scenario.nodes * (options.scenario.nodes - 1)} controlled SSB links`)
    cluster = await ChaosCluster.start({ prepared, scenario: options.scenario, artifacts, image: options.image })
    stopTelemetry = startTelemetry(cluster, artifacts)
    await artifacts.record({ type: 'run', phase: 'success', name: 'cluster.start', details: { nodes: cluster.nodeNames(), links: cluster.linkNames().length } })

    const scenarioStartedAt = performance.now()
    progress(`Running ${options.scenario.name} workload for ${(options.scenario.durationMs / 1000).toFixed(1)}s (seed ${options.seed})`)
    const faultTasks = options.scenario.faults.map((fault, index) => scheduleFault({
      cluster: cluster!, artifacts, fault, index, startedAt: scenarioStartedAt, signal: controller.signal,
    }))
    const workloadTask = runWorkload({
      cluster,
      scenario: options.scenario,
      artifacts,
      random: new SeededRandom(options.seed).fork('workload'),
      startedAt: scenarioStartedAt,
      signal: controller.signal,
    }).then((result) => { workload = result; return result })
    const [workloadResult] = await Promise.all([workloadTask, ...faultTasks])
    workload = workloadResult
    progress('Healing all faults and waiting for canonical convergence')
    await cluster.healAll()
    const convergence = await waitForConvergence({
      cluster,
      artifacts,
      timeoutMs: options.scenario.convergenceTimeoutMs,
      expectations: workload.expectations,
      resultSampleSize: options.scenario.workload.resultSampleSize ?? 64,
    })
    snapshots = convergence.snapshots
    invariants = convergence.invariants
    const failedInvariant = invariants.find((invariant) => !invariant.passed)
    if (failedInvariant) throw new Error(`CHAOS_INVARIANT_FAILED:${failedInvariant.name}:${failedInvariant.details ?? ''}`)
    await artifacts.writeJson('snapshots.json', snapshots)
    await artifacts.record({ type: 'run', phase: 'success', name: 'run' })
  } catch (error) {
    failure = errorText(error)
    controller.abort(error)
    await artifacts.record({ type: 'run', phase: 'failure', name: 'run', error: failure }).catch(() => undefined)
  } finally {
    controller.abort('run complete')
    await stopTelemetry?.()
    options.signal?.removeEventListener('abort', relayAbort)
  }

  const finishedAt = new Date()
  const summary: RunSummary = {
    format: 'chronolog-chaos-result',
    scenario: options.scenario.name,
    seed: options.seed,
    startedAt: artifacts.startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    elapsedMs: artifacts.elapsedMs(),
    passed: failure === undefined,
    operations: { attempted: workload.attempted, published: workload.published, failed: workload.failed, byKind: workload.byKind },
    invariants,
    snapshots,
    ...(failure === undefined ? {} : { failure }),
    replayCommand: `pnpm chaos replay ${shellQuote(artifacts.directory)}`,
  }
  await artifacts.finish(summary)
  await cluster?.close()
  return { artifacts: artifacts.directory, summary }
}

function startTelemetry(cluster: ChaosCluster, artifacts: RunArtifacts): () => Promise<void> {
  let stopped = false
  let inFlight: Promise<void> | undefined
  const sample = (): void => {
    if (stopped || inFlight !== undefined) return
    inFlight = (async () => {
      await artifacts.recordMetrics({ nodes: await cluster.sampleResources() })
    })().catch(() => undefined).finally(() => { inFlight = undefined })
  }
  sample()
  const timer = setInterval(sample, 1_000)
  timer.unref?.()
  return async () => {
    stopped = true
    clearInterval(timer)
    await inFlight
  }
}

async function scheduleFault(options: {
  readonly cluster: ChaosCluster
  readonly artifacts: RunArtifacts
  readonly fault: FaultSpec
  readonly index: number
  readonly startedAt: number
  readonly signal: AbortSignal
}): Promise<void> {
  const ready = await delayUntil(options.startedAt + options.fault.atMs, options.signal)
  if (!ready) return
  const name = `fault-${options.index}-${options.fault.kind}`
  let handle: FaultHandle | undefined
  await options.artifacts.record({ type: 'fault', phase: 'start', name, details: options.fault })
  try {
    handle = await options.cluster.applyFault(options.fault, `chronolog-${options.index}`)
    const duration = 'durationMs' in options.fault ? options.fault.durationMs : options.fault.kind === 'reset' ? 250 : 0
    if (duration > 0) await abortableDelay(duration, options.signal)
    await handle.heal()
    handle = undefined
    await options.artifacts.record({ type: 'fault', phase: 'heal', name })
  } catch (error) {
    await options.artifacts.record({ type: 'fault', phase: 'failure', name, error: errorText(error) })
    throw error
  } finally {
    await handle?.heal().catch(() => undefined)
  }
}

async function delayUntil(deadline: number, signal: AbortSignal): Promise<boolean> {
  const remaining = Math.max(0, deadline - performance.now())
  if (remaining === 0) return !signal.aborted
  await abortableDelay(remaining, signal)
  return !signal.aborted
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolveDelay) => {
    const timer = setTimeout(done, milliseconds)
    const abort = () => { clearTimeout(timer); done() }
    function done(): void { signal.removeEventListener('abort', abort); resolveDelay() }
    signal.addEventListener('abort', abort, { once: true })
  })
}

function shellQuote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'` }

export const defaultChaosImage = 'chronolog-chaos:dev'
export const defaultArtifactRoot = resolve('.chaos')
