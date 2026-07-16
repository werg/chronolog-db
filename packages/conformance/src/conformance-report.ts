import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { arch, platform, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  compileManifestArtifacts,
  createCoreExecutionManifest,
} from '@chronolog/compiler-sqlite'
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

import { runSqliteDifferential } from './sqlite-differential.js'

export interface ConformanceTestGroup {
  readonly id: string
  readonly passed: true
  readonly evidenceDigest: string
}

export interface DeterministicConformanceEvidence {
  readonly executionManifestDigest: string
  readonly fixtureCorpusDigest: string
  readonly compatibilityLedgerDigest: string
  readonly enabledFeatures: readonly string[]
  readonly featureEvidence: Readonly<Record<string, readonly string[]>>
  readonly testGroups: readonly ConformanceTestGroup[]
  readonly replayDigest: string
  readonly portableSemanticDigest: string
}

export interface ConformanceReport {
  readonly format: 'chronolog-conformance-report-v1'
  readonly deterministic: DeterministicConformanceEvidence
  readonly operational: {
    readonly sourceCommit: string
    readonly platform: string
    readonly generatedAt: string
  }
}

interface ReportOptions {
  readonly generatedAt?: string
  readonly platform?: string
  readonly sourceCommit?: string
}

const moduleDirectory = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(moduleDirectory, '../../..')
const corpusPath = resolve(moduleDirectory, '../fixtures/sqlite-differential.json')
const ledgerPath = resolve(repositoryRoot, 'docs/sqlite-compatibility-ledger.json')

export async function generateConformanceReport(options: ReportOptions = {}): Promise<ConformanceReport> {
  const [corpus, ledger, sqlite] = await Promise.all([
    readCanonicalJson(corpusPath),
    readCanonicalJson(ledgerPath),
    runSqliteDifferential(),
  ])
  if (!sqlite.passed) throw new Error('CONFORMANCE_SQLITE_DIFFERENTIAL_FAILED')

  const native = readNativeEngineInfo()
  const manifest = createCoreExecutionManifest({
    profile: 'chronolog-portable-core-conformance-v1',
    engine: native.descriptor,
    engineDigest: native.digest,
  })
  const manifestArtifacts = await compileManifestArtifacts(manifest)
  const replay = await runReplayFixture(manifest)
  const testGroups: readonly ConformanceTestGroup[] = [
    { id: 'sqlite-ledger-v1', passed: true, evidenceDigest: digestJson(sqlite) },
    { id: 'native-replay-v1', passed: true, evidenceDigest: replay.evidenceDigest },
  ]
  const enabledFeatures = [
    'sql-core-v1',
    'sql-ordered-mutations-v1',
    'sql-transaction-results-v1',
    'sql-json1-arrows-v1',
    'sql-trigger-raise-v1',
  ] as const
  const featureEvidence = Object.fromEntries(enabledFeatures.map((feature) => [
    feature,
    feature === 'sql-core-v1'
      ? ['sqlite-ledger-v1', 'native-replay-v1']
      : feature === 'sql-json1-arrows-v1' || feature === 'sql-trigger-raise-v1'
        ? ['sqlite-ledger-v1']
        : ['native-replay-v1'],
  ]))
  const deterministicWithoutDigest = {
    executionManifestDigest: hex(manifestArtifacts.executionManifestDigest),
    fixtureCorpusDigest: digestJson(corpus),
    compatibilityLedgerDigest: digestJson(ledger),
    enabledFeatures,
    featureEvidence,
    testGroups,
    replayDigest: replay.replayDigest,
  }
  const deterministic: DeterministicConformanceEvidence = {
    ...deterministicWithoutDigest,
    portableSemanticDigest: digestJson(deterministicWithoutDigest),
  }
  const report: ConformanceReport = {
    format: 'chronolog-conformance-report-v1',
    deterministic,
    operational: {
      sourceCommit: options.sourceCommit ?? readSourceCommit(),
      platform: options.platform ?? `${platform()}-${arch()}-node${process.versions.node}`,
      generatedAt: options.generatedAt ?? new Date().toISOString(),
    },
  }
  assertConformanceReport(report)
  return report
}

export function assertConformanceReport(value: unknown): asserts value is ConformanceReport {
  if (typeof value !== 'object' || value === null || (value as { format?: unknown }).format !== 'chronolog-conformance-report-v1') {
    throw new Error('CONFORMANCE_REPORT_FORMAT_INVALID')
  }
  const report = value as ConformanceReport
  const deterministic = report.deterministic
  if (typeof deterministic !== 'object' || deterministic === null) throw new Error('CONFORMANCE_REPORT_EVIDENCE_INVALID')
  for (const digest of [
    deterministic.executionManifestDigest,
    deterministic.fixtureCorpusDigest,
    deterministic.compatibilityLedgerDigest,
    deterministic.replayDigest,
    deterministic.portableSemanticDigest,
  ]) if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error('CONFORMANCE_REPORT_DIGEST_INVALID')
  const rawFeatures: unknown = deterministic.enabledFeatures
  const rawGroups: unknown = deterministic.testGroups
  if (!Array.isArray(rawFeatures) || rawFeatures.some((feature: unknown) => typeof feature !== 'string') ||
      !Array.isArray(rawGroups)) {
    throw new Error('CONFORMANCE_REPORT_GROUPS_INVALID')
  }
  const passingGroups = new Set<string>()
  for (const rawGroup of rawGroups as readonly unknown[]) {
    if (typeof rawGroup !== 'object' || rawGroup === null) throw new Error('CONFORMANCE_REPORT_GROUPS_INVALID')
    const group = rawGroup as { id?: unknown; passed?: unknown; evidenceDigest?: unknown }
    if (typeof group.id !== 'string' || group.passed !== true || typeof group.evidenceDigest !== 'string') {
      throw new Error('CONFORMANCE_REPORT_GROUPS_INVALID')
    }
    passingGroups.add(group.id)
  }
  if (typeof deterministic.featureEvidence !== 'object' || deterministic.featureEvidence === null) {
    throw new Error('CONFORMANCE_FEATURE_EVIDENCE_INVALID')
  }
  for (const rawFeature of rawFeatures as readonly unknown[]) {
    const feature = rawFeature as string
    const evidence: readonly string[] | undefined = deterministic.featureEvidence[feature]
    if (evidence === undefined || evidence.length === 0 || evidence.some((group) => !passingGroups.has(group))) {
      throw new Error(`CONFORMANCE_FEATURE_EVIDENCE_MISSING:${feature}`)
    }
  }
  const { portableSemanticDigest: _digest, ...withoutDigest } = deterministic
  if (digestJson(withoutDigest) !== deterministic.portableSemanticDigest) throw new Error('CONFORMANCE_PORTABLE_DIGEST_MISMATCH')
  if (typeof report.operational?.sourceCommit !== 'string' || typeof report.operational.platform !== 'string' ||
      typeof report.operational.generatedAt !== 'string' || !Number.isFinite(Date.parse(report.operational.generatedAt))) {
    throw new Error('CONFORMANCE_OPERATIONAL_METADATA_INVALID')
  }
}

async function runReplayFixture(manifest: ReturnType<typeof createCoreExecutionManifest>): Promise<{
  readonly evidenceDigest: string
  readonly replayDigest: string
}> {
  const directory = await mkdtemp(join(tmpdir(), 'chronolog-conformance-'))
  const path = join(directory, 'application.db')
  try {
    const materializer = await DeterministicMaterializer.open({ path, executionManifest: manifest, checkpointEvery: 1 })
    try {
      const digest = materializer.executionManifestDigest
      const bootstrap = await transaction(1n, 'bootstrap', {
        version: 1,
        preconditions: [truePrecondition()],
        body: [
          statement('CREATE TABLE accounts (id INTEGER PRIMARY KEY, balance INTEGER NOT NULL) STRICT'),
          statement('INSERT INTO accounts VALUES (1, 100), (2, 200)'),
        ],
      }, digest)
      const predecessor = await transaction(10n, 'predecessor', updateProgram(100n, 5n), digest)
      const later = await transaction(20n, 'later', updateProgram(100n, 90n), digest)
      const ordered = await transaction(30n, 'ordered', {
        version: 1,
        preconditions: [truePrecondition()],
        body: [statement('UPDATE accounts SET balance = balance + 1 RETURNING id, balance ORDER BY id DESC LIMIT 1')],
      }, digest)
      await materializer.materialize([bootstrap, later])
      await materializer.materialize([bootstrap, predecessor, later, ordered])
      const state = materializer.localSql('SELECT id, balance FROM accounts ORDER BY id')
      const evidence = {
        state: state.rows,
        outcomes: [bootstrap, predecessor, later, ordered].map((candidate) => {
          const outcome = materializer.outcome(candidate.txId)
          return {
            id: new TextDecoder().decode(candidate.txId),
            outcome: outcome?.outcome ?? null,
            rejectionCode: outcome?.rejectionCode ?? null,
            resultDigest: outcome?.resultDigest === null || outcome?.resultDigest === undefined ? null : hex(outcome.resultDigest),
          }
        }),
        orderedResult: materializer.transactionResult(ordered.txId),
      }
      const replayDigest = digestJson(evidence)
      return { evidenceDigest: replayDigest, replayDigest }
    } finally {
      materializer.close()
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

function updateProgram(expected: bigint, next: bigint): SqlTransactionProgram {
  return {
    version: 1,
    preconditions: [{
      id: 1,
      query: statement('SELECT balance = ? FROM accounts WHERE id = 1', [integer(1, expected)]),
      resultMode: 'scalar',
      expectation: { kind: 'assert_true' },
    }],
    body: [statement('UPDATE accounts SET balance = ? WHERE id = 1', [integer(1, next)])],
  }
}

function truePrecondition() {
  return { id: 1, query: statement('SELECT 1'), resultMode: 'scalar' as const, expectation: { kind: 'assert_true' as const } }
}
function statement(sql: string, bindings: readonly SqlBinding[] = []) { return { sql, bindings } }
function integer(index: number, value: bigint): SqlBinding {
  return { parameter: { kind: 'index', index }, value: { kind: 'int64', value } }
}

async function transaction(
  timestamp: bigint,
  id: string,
  program: SqlTransactionProgram,
  executionManifestDigest: Uint8Array,
): Promise<AdmittedTransaction> {
  const core: TransactionCore = {
    groupId: bytes32(1),
    membershipRevision: bytes32(2),
    validationPolicy: bytes32(3),
    authorId: bytes32(4),
    authorTimestampMs: timestamp,
    nonce: bytes32(Number(timestamp) + 10),
    executionManifestDigest,
    program,
  }
  const canonicalCandidate = encodeTransactionCore(core)
  return {
    txId: utf8(id),
    authorFeedSequence: timestamp,
    candidateDigest: await transactionDigest(canonicalCandidate),
    canonicalCandidate,
    core,
  }
}

function bytes32(seed: number): Uint8Array {
  return Uint8Array.from({ length: 32 }, (_value, index) => (seed + index) & 0xff)
}

async function readCanonicalJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown
}

function digestJson(value: unknown): string {
  return createHash('sha256').update(`chronolog-conformance-json-v1\n${stableJson(value)}`, 'utf8').digest('hex')
}

function stableJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'bigint') return JSON.stringify(value.toString())
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('CONFORMANCE_JSON_NONFINITE')
    return JSON.stringify(value)
  }
  if (value instanceof Uint8Array) return JSON.stringify(`hex:${hex(value)}`)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`
  }
  throw new Error('CONFORMANCE_JSON_VALUE_INVALID')
}

function hex(value: Uint8Array): string { return Buffer.from(value).toString('hex') }

function readSourceCommit(): string {
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot, encoding: 'utf8' }).trim() }
  catch { return 'unknown' }
}

function outputArgument(arguments_: readonly string[]): string | undefined {
  const index = arguments_.indexOf('--output')
  if (index < 0) return undefined
  const output = arguments_[index + 1]
  if (output === undefined || output.startsWith('-')) throw new Error('CONFORMANCE_OUTPUT_PATH_REQUIRED')
  return resolve(repositoryRoot, output)
}

async function main(): Promise<void> {
  const report = await generateConformanceReport()
  const serialized = `${JSON.stringify(report, null, 2)}\n`
  const output = outputArgument(process.argv.slice(2))
  if (output !== undefined) {
    await mkdir(dirname(output), { recursive: true })
    await writeFile(output, serialized, 'utf8')
  }
  process.stdout.write(serialized)
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main()
