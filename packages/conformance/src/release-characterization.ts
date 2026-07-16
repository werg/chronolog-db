import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { performance } from 'node:perf_hooks'

import { createCoreExecutionManifest } from '@chronolog/compiler-sqlite'
import {
  DeterministicMaterializer,
  readNativeEngineInfo,
  type AdmittedTransaction,
} from '@chronolog/materializer-doltlite'
import {
  encodeTransactionCore,
  transactionDigest,
  utf8,
  type SqlBinding,
  type SqlTransactionProgram,
  type TransactionCore,
} from '@chronolog/protocol'

export interface ReleaseCharacterizationOptions {
  readonly iterations: number
  readonly reopenEvery: number
  readonly lateEvery: number
  readonly lateDepth: number
}

export interface ReleaseCharacterizationReport {
  readonly format: 'chronolog-release-characterization-v1'
  readonly deterministic: {
    readonly workloadDigest: string
    readonly iterations: number
    readonly reopenEvery: number
    readonly lateEvery: number
    readonly lateDepth: number
    readonly transactions: number
    readonly revisions: string
    readonly reopenCount: number
    readonly lateTransactions: number
    readonly replayedTransactions: number
    readonly stateDigest: string
  }
  readonly operational: {
    readonly generatedAt: string
    readonly wallTimeMs: number
    readonly peakRssBytes: number
    readonly repositoryBytes: number
  }
}

const moduleDirectory = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(moduleDirectory, '../../..')

export async function characterizeNativeRecovery(
  options: ReleaseCharacterizationOptions,
): Promise<ReleaseCharacterizationReport> {
  validateOptions(options)
  const directory = await mkdtemp(join(tmpdir(), 'chronolog-release-characterization-'))
  const path = join(directory, 'application.db')
  const native = readNativeEngineInfo()
  const manifest = createCoreExecutionManifest({
    profile: 'chronolog-native-release-characterization-v1',
    engine: native.descriptor,
    engineDigest: native.digest,
  })
  const started = performance.now()
  let peakRssBytes = process.memoryUsage.rss()
  let materializer = await DeterministicMaterializer.open({
    path,
    executionManifest: manifest,
    checkpointEvery: Math.max(1, options.reopenEvery),
  })
  const ordered: AdmittedTransaction[] = []
  let replayedTransactions = 0
  let reopenCount = 0
  let lateTransactions = 0
  let nextId = 1
  try {
    ordered.push(await transaction(0n, nextId++, bootstrapProgram(), materializer.executionManifestDigest))
    replayedTransactions += (await requireRevision(materializer, ordered)).replayedTransactions
    for (let iteration = 1; iteration <= options.iterations; iteration += 1) {
      ordered.push(await transaction(
        BigInt(iteration * 100),
        nextId++,
        insertProgram(iteration, 'regular'),
        materializer.executionManifestDigest,
      ))
      if (iteration >= options.lateDepth && iteration % options.lateEvery === 0) {
        ordered.push(await transaction(
          BigInt((iteration - options.lateDepth) * 100 + 50),
          nextId++,
          insertProgram(iteration, 'late'),
          materializer.executionManifestDigest,
        ))
        lateTransactions += 1
      }
      ordered.sort((left, right) => {
        const difference = left.core.authorTimestampMs - right.core.authorTimestampMs
        return difference < 0n ? -1 : difference > 0n ? 1 : 0
      })
      replayedTransactions += (await requireRevision(materializer, ordered)).replayedTransactions
      peakRssBytes = Math.max(peakRssBytes, process.memoryUsage.rss())
      if (iteration % options.reopenEvery === 0 && iteration !== options.iterations) {
        materializer.close()
        materializer = await DeterministicMaterializer.open({
          path,
          executionManifest: manifest,
          checkpointEvery: Math.max(1, options.reopenEvery),
        })
        reopenCount += 1
      }
    }
    const rows = materializer.localSql('SELECT id, iteration, kind FROM release_events ORDER BY id').rows
    if (rows.length !== ordered.length - 1) throw new Error('CHARACTERIZATION_ROW_COUNT_MISMATCH')
    if (materializer.transactionLog().length !== ordered.length) {
      throw new Error('CHARACTERIZATION_LOG_COUNT_MISMATCH')
    }
    const deterministic = {
      workloadDigest: digestJson(options),
      iterations: options.iterations,
      reopenEvery: options.reopenEvery,
      lateEvery: options.lateEvery,
      lateDepth: options.lateDepth,
      transactions: ordered.length,
      revisions: materializer.revision.toString(),
      reopenCount,
      lateTransactions,
      replayedTransactions,
      stateDigest: digestJson(rows),
    }
    materializer.close()
    return {
      format: 'chronolog-release-characterization-v1',
      deterministic,
      operational: {
        generatedAt: new Date().toISOString(),
        wallTimeMs: Math.round((performance.now() - started) * 1_000) / 1_000,
        peakRssBytes,
        repositoryBytes: await directoryBytes(directory),
      },
    }
  } finally {
    materializer.close()
    await rm(directory, { recursive: true, force: true })
  }
}

async function requireRevision(
  materializer: DeterministicMaterializer,
  ordered: readonly AdmittedTransaction[],
) {
  const revision = await materializer.materialize(ordered)
  if (revision === null) throw new Error('CHARACTERIZATION_REVISION_MISSING')
  return revision
}

function bootstrapProgram(): SqlTransactionProgram {
  return {
    version: 1,
    preconditions: [truePrecondition()],
    body: [{
      sql: 'CREATE TABLE release_events (id INTEGER PRIMARY KEY, iteration INTEGER NOT NULL, kind TEXT NOT NULL) STRICT',
      bindings: [],
    }],
  }
}

function insertProgram(iteration: number, kind: string): SqlTransactionProgram {
  return {
    version: 1,
    preconditions: [truePrecondition()],
    body: [{
      sql: 'INSERT INTO release_events (id, iteration, kind) VALUES (?, ?, ?)',
      bindings: [integer(1, BigInt(iteration * 2 + (kind === 'late' ? 1 : 0))), integer(2, BigInt(iteration)), {
        parameter: { kind: 'index', index: 3 },
        value: { kind: 'text', utf8: utf8(kind) },
      }],
    }],
  }
}

function truePrecondition() {
  return {
    id: 1,
    query: { sql: 'SELECT 1', bindings: [] },
    resultMode: 'scalar' as const,
    expectation: { kind: 'assert_true' as const },
  }
}

function integer(index: number, value: bigint): SqlBinding {
  return { parameter: { kind: 'index', index }, value: { kind: 'int64', value } }
}

async function transaction(
  timestamp: bigint,
  id: number,
  program: SqlTransactionProgram,
  executionManifestDigest: Uint8Array,
): Promise<AdmittedTransaction> {
  const core: TransactionCore = {
    groupId: bytes32(1),
    membershipRevision: bytes32(2),
    validationPolicy: bytes32(3),
    authorId: bytes32(4),
    authorTimestampMs: timestamp,
    nonce: bytes32(id + 10),
    executionManifestDigest,
    program,
  }
  const canonicalCandidate = encodeTransactionCore(core)
  return {
    txId: utf8(`characterization-${id.toString().padStart(8, '0')}`),
    authorFeedSequence: BigInt(id),
    candidateDigest: await transactionDigest(canonicalCandidate),
    canonicalCandidate,
    core,
  }
}

function validateOptions(options: ReleaseCharacterizationOptions): void {
  for (const [name, value] of Object.entries(options)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`CHARACTERIZATION_${name.toUpperCase()}_INVALID`)
  }
  if (options.lateDepth > options.iterations) throw new Error('CHARACTERIZATION_LATE_DEPTH_INVALID')
}

async function directoryBytes(path: string): Promise<number> {
  const entries = await readdir(path, { withFileTypes: true })
  let bytes = 0
  for (const entry of entries) {
    const child = join(path, entry.name)
    bytes += entry.isDirectory() ? await directoryBytes(child) : (await stat(child)).size
  }
  return bytes
}

function digestJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value, (_key, item: unknown) =>
    typeof item === 'bigint' ? item.toString() : item), 'utf8').digest('hex')
}

function bytes32(seed: number): Uint8Array {
  return Uint8Array.from({ length: 32 }, (_value, index) => (seed + index) & 0xff)
}

function integerArgument(arguments_: readonly string[], name: string, fallback: number): number {
  const index = arguments_.indexOf(name)
  if (index < 0) return fallback
  const value = Number(arguments_[index + 1])
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`CHARACTERIZATION_ARGUMENT_INVALID:${name}`)
  return value
}

async function main(): Promise<void> {
  const arguments_ = process.argv.slice(2)
  const report = await characterizeNativeRecovery({
    iterations: integerArgument(arguments_, '--iterations', 100),
    reopenEvery: integerArgument(arguments_, '--reopen-every', 20),
    lateEvery: integerArgument(arguments_, '--late-every', 10),
    lateDepth: integerArgument(arguments_, '--late-depth', 5),
  })
  const serialized = `${JSON.stringify(report, null, 2)}\n`
  const outputIndex = arguments_.indexOf('--output')
  if (outputIndex >= 0) {
    const output = arguments_[outputIndex + 1]
    if (output === undefined || output.startsWith('-')) throw new Error('CHARACTERIZATION_OUTPUT_REQUIRED')
    const path = resolve(repositoryRoot, output)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, serialized, 'utf8')
  }
  process.stdout.write(serialized)
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main()
