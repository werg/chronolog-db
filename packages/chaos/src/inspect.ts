import { access, readFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { SsbDb2Transport } from '@chronolog/transport-ssb'

export interface RunInspection {
  readonly format: 'chronolog-chaos-inspection'
  readonly directory: string
  readonly nodes: readonly unknown[]
}

export async function inspectRun(directory: string): Promise<RunInspection> {
  // Some legacy SSB readiness callbacks do not own a referenced Node handle.
  // Keep the one-shot inspection process alive until they settle.
  const keepAlive = setInterval(() => undefined, 1_000)
  try {
    const absolute = resolve(directory)
    const nodesDirectory = join(absolute, 'nodes')
    const names = (await readdir(nodesDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && /^node-\d+$/u.test(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => Number(left.slice(5)) - Number(right.slice(5)))
    const nodes = []
    for (const name of names) {
    const directory = join(nodesDirectory, name)
    const uncleanMarker = await exists(join(directory, 'ssb', '.chronolog-ssb-open'))
    const transport = await SsbDb2Transport.open({ path: join(directory, 'ssb'), network: { reconnect: false } })
    try {
      const history = await transport.history()
      const feeds = new Map<string, { sequence: number; id: string; previous?: string }[]>()
      for (const record of history) {
        const records = feeds.get(record.author) ?? []
        records.push({ sequence: Number(record.sequence), id: record.id, ...(record.previous === undefined ? {} : { previous: record.previous }) })
        feeds.set(record.author, records)
      }
      const control = JSON.parse(await readFile(join(directory, 'control.json'), 'utf8')) as Record<string, unknown>
      nodes.push({
        name,
        uncleanMarker,
        transportRecords: history.length,
        feeds: [...feeds.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([author, records]) => {
          const sequences = records.map((record) => record.sequence)
          const sorted = [...new Set(sequences)].sort((left, right) => left - right)
          const maximum = sorted.at(-1) ?? 0
          const present = new Set(sorted)
          const gaps: number[] = []
          for (let sequence = 1; sequence <= maximum && gaps.length < 20; sequence += 1) if (!present.has(sequence)) gaps.push(sequence)
          const samples = records
            .filter((record) => record.sequence <= 16 || isPowerOfTwo(record.sequence) || record.sequence === maximum)
            .sort((left, right) => left.sequence - right.sequence)
          return { author, records: sequences.length, maximumSequence: maximum, gaps, duplicateSequences: sequences.length - sorted.length, samples }
        }),
        control: {
          candidates: arrayLength(control.candidates),
          attestations: arrayLength(control.attestations),
          heartbeats: arrayLength(control.heartbeats),
          orderedTransactions: arrayLength(control.orderedTxIds),
          checkpoints: arrayLength(control.checkpoints),
          deltas: arrayLength(control.deltas),
        },
      })
    } finally {
      await transport.close()
    }
    }
    return { format: 'chronolog-chaos-inspection', directory: absolute, nodes }
  } finally {
    clearInterval(keepAlive)
  }
}

function arrayLength(value: unknown): number | undefined { return Array.isArray(value) ? value.length : undefined }
function isPowerOfTwo(value: number): boolean { return value > 0 && (value & (value - 1)) === 0 }

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true } catch { return false }
}
