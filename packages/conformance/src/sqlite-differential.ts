import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  compileSqlStatement,
  SQLITE_PARSER_BASELINE,
  SqlCompilerError,
} from '@chronolog/compiler-sqlite'
import { DatabaseSync } from '@dolthub/doltlite'

type JsonScalar = null | boolean | number | string

interface CorpusBinding {
  readonly kind: 'integer' | 'text' | 'null'
  readonly value?: string
}

interface CorpusCompilerExpectation {
  readonly status: 'accepted' | 'rejected'
  readonly code?: string
  readonly statementClass?: string
  readonly resultMode?: string | null
  readonly maximumParameterIndex?: number
  readonly parameterCount?: number
}

interface RuntimeExecutionExpectation {
  readonly mode: 'all' | 'run'
  readonly columns?: readonly string[]
  readonly rows?: readonly (readonly JsonScalar[])[]
  readonly affectedRows: string | null
}

interface CorpusFixture {
  readonly id: string
  readonly families: readonly string[]
  readonly sql: string
  readonly bindings?: readonly CorpusBinding[]
  readonly compiler: CorpusCompilerExpectation
  readonly runtime: {
    readonly prepare: 'accepted' | 'rejected'
    readonly error?: string
    readonly execute?: RuntimeExecutionExpectation
  }
}

interface DifferentialCorpus {
  readonly format: 'chronolog-sqlite-differential-corpus-v1'
  readonly parserPackage: string
  readonly parserGrammar: string
  readonly runtimeProfile: string
  readonly fixtures: readonly CorpusFixture[]
}

export interface DifferentialFixtureResult {
  readonly id: string
  readonly passed: boolean
  readonly compiler: string
  readonly runtimePrepare: 'accepted' | 'rejected'
  readonly runtimeError?: string
  readonly columns?: readonly string[]
  readonly rows?: readonly (readonly JsonScalar[])[]
  readonly affectedRows?: string | null
  readonly failures: readonly string[]
}

export interface SqliteDifferentialReport {
  readonly format: 'chronolog-sqlite-differential-report-v1'
  readonly parserPackage: string
  readonly parserGrammar: string
  readonly runtimeProfile: string
  readonly runtimeVersion: string
  readonly ledgerFamilies: number
  readonly coveredFamilies: number
  readonly passed: boolean
  readonly fixtures: readonly DifferentialFixtureResult[]
  readonly failures: readonly string[]
}

const moduleDirectory = dirname(fileURLToPath(import.meta.url))
const defaultCorpusPath = resolve(moduleDirectory, '../fixtures/sqlite-differential.json')
const defaultLedgerPath = resolve(moduleDirectory, '../../../docs/sqlite-compatibility-ledger.json')

export async function runSqliteDifferential(options: {
  readonly corpusPath?: string
  readonly ledgerPath?: string
} = {}): Promise<SqliteDifferentialReport> {
  const corpus = parseCorpus(JSON.parse(await readFile(options.corpusPath ?? defaultCorpusPath, 'utf8')))
  const ledger = JSON.parse(await readFile(options.ledgerPath ?? defaultLedgerPath, 'utf8')) as unknown
  const ledgerFamilies = classifiedSqlFamilies(ledger)
  const coveredFamilies = new Set(corpus.fixtures.flatMap((fixture) => fixture.families))
  const failures = ledgerFamilies.filter((family) => !coveredFamilies.has(family)).map((family) => `UNCOVERED_LEDGER_FAMILY:${family}`)
  for (const family of coveredFamilies) if (!ledgerFamilies.includes(family)) failures.push(`UNKNOWN_LEDGER_FAMILY:${family}`)
  if (corpus.parserPackage !== SQLITE_PARSER_BASELINE.package) failures.push('PARSER_PACKAGE_IDENTITY_MISMATCH')
  if (corpus.parserGrammar !== SQLITE_PARSER_BASELINE.grammar) failures.push('PARSER_GRAMMAR_IDENTITY_MISMATCH')

  const versionDatabase = createFixtureDatabase()
  const versionRow = versionDatabase.prepare('SELECT sqlite_version() AS version').get() as { version?: unknown } | undefined
  const runtimeVersion = typeof versionRow?.version === 'string' ? versionRow.version : 'unknown'
  versionDatabase.close()
  const fixtures: DifferentialFixtureResult[] = []
  for (const fixture of corpus.fixtures) {
    const database = createFixtureDatabase()
    try { fixtures.push(runFixture(database, fixture)) }
    finally { database.close() }
  }
  return {
    format: 'chronolog-sqlite-differential-report-v1',
    parserPackage: corpus.parserPackage,
    parserGrammar: corpus.parserGrammar,
    runtimeProfile: corpus.runtimeProfile,
    runtimeVersion,
    ledgerFamilies: ledgerFamilies.length,
    coveredFamilies: coveredFamilies.size,
    passed: failures.length === 0 && fixtures.every((fixture) => fixture.passed),
    fixtures,
    failures,
  }
}

function runFixture(database: DatabaseSync, fixture: CorpusFixture): DifferentialFixtureResult {
  const failures: string[] = []
  let compiler = 'accepted'
  try {
    const compiled = compileSqlStatement({
      sql: fixture.sql,
      bindings: (fixture.bindings ?? []).map((binding, index) => ({
        parameter: { kind: 'index' as const, index: index + 1 },
        value: binding.kind === 'integer'
          ? { kind: 'int64' as const, value: BigInt(binding.value ?? '0') }
          : binding.kind === 'text'
            ? { kind: 'text' as const, utf8: new TextEncoder().encode(binding.value ?? '') }
            : { kind: 'null' as const },
      })),
    }, 'body')
    if (fixture.compiler.status !== 'accepted') failures.push(`COMPILER_ACCEPTED_EXPECTED_${fixture.compiler.code ?? 'REJECTION'}`)
    if (fixture.compiler.statementClass !== undefined && compiled.statementClass !== fixture.compiler.statementClass) {
      failures.push(`STATEMENT_CLASS:${compiled.statementClass}!=${fixture.compiler.statementClass}`)
    }
    if (fixture.compiler.resultMode !== undefined && compiled.resultMode !== fixture.compiler.resultMode) {
      failures.push(`RESULT_MODE:${String(compiled.resultMode)}!=${String(fixture.compiler.resultMode)}`)
    }
    if (fixture.compiler.maximumParameterIndex !== undefined && compiled.maximumParameterIndex !== fixture.compiler.maximumParameterIndex) {
      failures.push(`MAXIMUM_PARAMETER_INDEX:${compiled.maximumParameterIndex}!=${fixture.compiler.maximumParameterIndex}`)
    }
    if (fixture.compiler.parameterCount !== undefined && compiled.parameters.length !== fixture.compiler.parameterCount) {
      failures.push(`PARAMETER_COUNT:${compiled.parameters.length}!=${fixture.compiler.parameterCount}`)
    }
  } catch (error) {
    compiler = error instanceof SqlCompilerError ? error.code : error instanceof Error ? error.message : String(error)
    if (fixture.compiler.status !== 'rejected') failures.push(`COMPILER_REJECTED:${compiler}`)
    else if (fixture.compiler.code !== compiler) failures.push(`COMPILER_CODE:${compiler}!=${fixture.compiler.code ?? 'unspecified'}`)
  }

  let runtimePrepare: 'accepted' | 'rejected' = 'accepted'
  let runtimeError: string | undefined
  let columns: readonly string[] | undefined
  let rows: readonly (readonly JsonScalar[])[] | undefined
  let affectedRows: string | null | undefined
  try {
    const statement = database.prepare(fixture.sql)
    if (fixture.runtime.execute !== undefined) {
      const parameters = (fixture.bindings ?? []).map(runtimeBinding)
      if (fixture.runtime.execute.mode === 'all') {
        statement.setReturnArrays(true)
        statement.setReadBigInts(true)
        columns = statement.columns().map((column, index) => column.name ?? `column_${index}`)
        rows = statement.all(...parameters).map((row) => {
          if (!Array.isArray(row)) throw new Error('DIFFERENTIAL_RUNTIME_ROW_NOT_ARRAY')
          return row.map(jsonScalar)
        })
        affectedRows = isMutationClass(fixture.compiler.statementClass) ? readChanges(database) : null
      } else {
        const result = statement.run(...parameters)
        affectedRows = String(result.changes)
      }
      compareExecution(fixture.runtime.execute, { columns, rows, affectedRows }, failures)
    }
  } catch (error) {
    runtimePrepare = 'rejected'
    runtimeError = sqliteErrorName(error)
  }
  if (runtimePrepare !== fixture.runtime.prepare) failures.push(`RUNTIME_PREPARE:${runtimePrepare}!=${fixture.runtime.prepare}`)
  if (fixture.runtime.error !== undefined && runtimeError !== fixture.runtime.error) {
    failures.push(`RUNTIME_ERROR:${runtimeError ?? 'none'}!=${fixture.runtime.error}`)
  }
  return {
    id: fixture.id,
    passed: failures.length === 0,
    compiler,
    runtimePrepare,
    ...(runtimeError === undefined ? {} : { runtimeError }),
    ...(columns === undefined ? {} : { columns }),
    ...(rows === undefined ? {} : { rows }),
    ...(affectedRows === undefined ? {} : { affectedRows }),
    failures,
  }
}

function createFixtureDatabase(): DatabaseSync {
  const database = new DatabaseSync(':memory:')
  database.exec(`
    CREATE TABLE accounts (id INTEGER PRIMARY KEY, value TEXT NOT NULL) STRICT;
    CREATE TABLE archive (id INTEGER PRIMARY KEY, value TEXT NOT NULL) STRICT;
    CREATE TABLE source (id INTEGER PRIMARY KEY, value TEXT NOT NULL) STRICT;
    CREATE INDEX accounts_value_idx ON accounts(value);
    INSERT INTO accounts VALUES (1, 'one'), (2, 'two');
    INSERT INTO source VALUES (1, 'updated');
  `)
  return database
}

function runtimeBinding(binding: CorpusBinding): unknown {
  if (binding.kind === 'integer') return BigInt(binding.value ?? '0')
  if (binding.kind === 'text') return binding.value ?? ''
  return null
}

function jsonScalar(value: unknown): JsonScalar {
  if (typeof value === 'bigint') return value.toString()
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') return value
  if (value instanceof Uint8Array) return `hex:${Buffer.from(value).toString('hex')}`
  throw new Error('DIFFERENTIAL_RUNTIME_VALUE_UNSUPPORTED')
}

function readChanges(database: DatabaseSync): string {
  const statement = database.prepare('SELECT changes()')
  statement.setReturnArrays(true)
  statement.setReadBigInts(true)
  const row = statement.get()
  if (!Array.isArray(row) || (typeof row[0] !== 'bigint' && typeof row[0] !== 'number')) throw new Error('DIFFERENTIAL_CHANGES_UNAVAILABLE')
  return String(row[0])
}

function compareExecution(
  expected: RuntimeExecutionExpectation,
  actual: {
    readonly columns: readonly string[] | undefined
    readonly rows: readonly (readonly JsonScalar[])[] | undefined
    readonly affectedRows: string | null | undefined
  },
  failures: string[],
): void {
  if (expected.columns !== undefined && JSON.stringify(actual.columns) !== JSON.stringify(expected.columns)) failures.push('RUNTIME_COLUMNS_MISMATCH')
  if (expected.rows !== undefined && JSON.stringify(actual.rows) !== JSON.stringify(expected.rows)) failures.push('RUNTIME_ROWS_MISMATCH')
  if (actual.affectedRows !== expected.affectedRows) failures.push(`AFFECTED_ROWS:${String(actual.affectedRows)}!=${String(expected.affectedRows)}`)
}

function sqliteErrorName(error: unknown): string {
  if (typeof error === 'object' && error !== null && typeof (error as { sqliteName?: unknown }).sqliteName === 'string') {
    return (error as { sqliteName: string }).sqliteName
  }
  return error instanceof Error ? error.name : 'UNKNOWN_ERROR'
}

function isMutationClass(statementClass: string | undefined): boolean {
  return statementClass === 'insert' || statementClass === 'update' || statementClass === 'delete'
}

function parseCorpus(value: unknown): DifferentialCorpus {
  if (typeof value !== 'object' || value === null || (value as { format?: unknown }).format !== 'chronolog-sqlite-differential-corpus-v1') {
    throw new Error('SQLITE_DIFFERENTIAL_CORPUS_INVALID')
  }
  const fixtures = (value as { fixtures?: unknown }).fixtures
  if (!Array.isArray(fixtures) || fixtures.length === 0) throw new Error('SQLITE_DIFFERENTIAL_CORPUS_EMPTY')
  const ids = new Set<string>()
  for (const rawFixture of fixtures as readonly unknown[]) {
    if (typeof rawFixture !== 'object' || rawFixture === null) throw new Error('SQLITE_DIFFERENTIAL_FIXTURE_INVALID')
    const fixture = rawFixture as { id?: unknown; families?: unknown; sql?: unknown }
    if (typeof fixture.id !== 'string' || ids.has(fixture.id) || !Array.isArray(fixture.families) || typeof fixture.sql !== 'string') {
      throw new Error('SQLITE_DIFFERENTIAL_FIXTURE_INVALID')
    }
    ids.add(fixture.id)
  }
  return value as DifferentialCorpus
}

function classifiedSqlFamilies(value: unknown): string[] {
  if (typeof value !== 'object' || value === null) throw new Error('SQLITE_COMPATIBILITY_LEDGER_INVALID')
  const ledger = value as { statements?: unknown; queryAndExpressionFeatures?: unknown; functions?: unknown }
  return [
    ...classifiedChildren('statements', ledger.statements),
    ...classifiedChildren('queryAndExpressionFeatures', ledger.queryAndExpressionFeatures),
    ...classifiedChildren('functions', ledger.functions),
  ]
}

function classifiedChildren(prefix: string, value: unknown): string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('SQLITE_COMPATIBILITY_LEDGER_INVALID')
  return Object.entries(value).map(([key, classification]) => {
    if (typeof classification !== 'object' || classification === null || typeof (classification as { status?: unknown }).status !== 'string') {
      throw new Error(`SQLITE_COMPATIBILITY_CLASSIFICATION_INVALID:${prefix}.${key}`)
    }
    return `${prefix}.${key}`
  })
}

async function main(): Promise<void> {
  const report = await runSqliteDifferential()
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  if (!report.passed) process.exitCode = 1
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main()
