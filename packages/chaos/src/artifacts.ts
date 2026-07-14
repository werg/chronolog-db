import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import type { ChaosScenario, HistoryEvent, ResourceSample, RunSummary } from './types.js'

export class RunArtifacts {
  readonly startedAt = new Date()
  readonly #monotonicStartedAt = performance.now()
  readonly historyPath: string
  #sequence = 0
  #writeTail: Promise<void> = Promise.resolve()

  private constructor(readonly directory: string) {
    this.historyPath = join(directory, 'history.ndjson')
  }

  static async create(root: string, scenario: ChaosScenario, seed: string): Promise<RunArtifacts> {
    const timestamp = new Date().toISOString().replaceAll(/[:.]/g, '-')
    const safeSeed = seed.replaceAll(/[^a-zA-Z0-9_-]/g, '_').slice(0, 32) || 'seed'
    const directory = resolve(root, `${timestamp}-${scenario.name}-${safeSeed}`)
    await mkdir(join(directory, 'logs'), { recursive: true })
    const artifacts = new RunArtifacts(directory)
    await artifacts.writeJson('scenario.json', scenario)
    await artifacts.writeJson('run.json', {
      format: 'chronolog-chaos-run',
      scenario: scenario.name,
      seed,
      startedAt: artifacts.startedAt.toISOString(),
      command: process.argv,
      versions: { node: process.version },
    })
    return artifacts
  }

  elapsedMs(): number { return Math.round(performance.now() - this.#monotonicStartedAt) }

  async record(event: Omit<HistoryEvent, 'sequence' | 'elapsedMs' | 'wallTime'>): Promise<void> {
    const complete: HistoryEvent = {
      sequence: ++this.#sequence,
      elapsedMs: this.elapsedMs(),
      wallTime: new Date().toISOString(),
      ...event,
    }
    this.#writeTail = this.#writeTail.then(() => appendFile(this.historyPath, `${stringify(complete)}\n`))
    await this.#writeTail
  }

  appendNodeLog(node: string, chunk: string | Buffer): void {
    const path = join(this.directory, 'logs', `${node}.log`)
    this.#writeTail = this.#writeTail.then(() => appendFile(path, chunk))
  }

  async recordMetrics(sample: Omit<ResourceSample, 'elapsedMs' | 'wallTime'>): Promise<void> {
    const complete: ResourceSample = {
      elapsedMs: this.elapsedMs(),
      wallTime: new Date().toISOString(),
      ...sample,
    }
    this.#writeTail = this.#writeTail.then(() => appendFile(join(this.directory, 'metrics.ndjson'), `${stringify(complete)}\n`))
    await this.#writeTail
  }

  async writeJson(relativePath: string, value: unknown): Promise<void> {
    await writeFile(join(this.directory, relativePath), `${stringify(value, 2)}\n`)
  }

  async finish(summary: RunSummary): Promise<void> {
    await this.#writeTail
    await this.writeJson('summary.json', summary)
  }
}

export function stringify(value: unknown, space?: number): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === 'bigint') return item.toString(10)
    if (item instanceof Uint8Array) return { bytes: Buffer.from(item).toString('base64url') }
    if (item instanceof Error) return { name: item.name, message: item.message, stack: item.stack }
    return item
  }, space)
}

export function errorText(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}
