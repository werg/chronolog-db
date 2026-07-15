import {
  assertCanonicalCbor,
  DEFAULT_DECODE_LIMITS,
  expectArray,
  expectBigint,
  expectBytes,
  expectMap,
  expectString,
  required,
  sha256,
  type CborValue,
} from '@chronolog/canonical'
import {
  digestExecutionManifest,
  digestSchemaManifest,
  encodeExecutionManifest,
  encodeSchemaManifest,
  portableExecutionManifestFixture,
  portableSchemaManifestFixture,
  portableTransactionProgramFixture,
  type ExecutionManifest,
  type Query,
  type TransactionProgram,
} from '@chronolog/ir'
import {
  digestAdmittedOrder,
  encodeAdmittedSuffix,
  encodeMaterializationInvocation,
  type ChronologAdmittedSuffix,
  type ExactArtifactRef,
  type ExactDatabaseRef,
} from '@chronolog/materializer'
import {
  DeterministicMaterializer,
  readNativeEngineInfo,
  type AdmittedTransaction,
  type OutcomeChange,
  type TransactionLogRow,
} from '@chronolog/materializer-doltlite'
import { encodeTransactionCore, transactionDigest, type TransactionCore } from '@chronolog/protocol'
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

import {
  ChronologWorkerdHostClient,
  decodeDatabaseReducerByteString,
  type ChronologCompatibilityTuple,
  type ChronologWorkerdBundleExecutionResponse,
  type ChronologReducerInvocationBundle,
  type ChronologWorkerdHostTransport,
  type WorkerdDatabaseReducerDatabaseRefValue,
  type WorkerdDatabaseReducerRunOptions,
  type WorkerdDatabaseReducerRunResult,
} from './index.js'

const WORKERD_BINARY = process.env.WORKERD_DATABASE_REDUCER_BIN
const RUN_BINARY_TEST = WORKERD_BINARY !== undefined && existsSync(WORKERD_BINARY)
const SOURCE_DIR = dirname(fileURLToPath(import.meta.url))
const REPOSITORY_ROOT = resolve(SOURCE_DIR, '../../..')
const activeProcesses = new Set<ChildProcessWithoutNullStreams>()
const processStderr = new Map<ChildProcessWithoutNullStreams, string>()

afterEach(async () => {
  await Promise.all([...activeProcesses].map(stopWorkerd))
})

describe('Chronolog real workerd database-reducer fixture', () => {
  const binaryIt = RUN_BINARY_TEST ? it : it.skip

  binaryIt('matches the portable oracle for append and late-predecessor replay', async () => {
    const root = mkdtempSync(join(tmpdir(), 'chronolog-workerd-binary-'))
    let oracle: DeterministicMaterializer | null = null
    try {
      const reducerBundle = join(root, 'chronolog-reducer.mjs')
      bundleWorker(join(SOURCE_DIR, 'workerd-binary-fixture.ts'), reducerBundle)
      writeFileSync(join(root, 'bootstrap.mjs'), BOOTSTRAP_WORKER)
      writeFileSync(join(root, 'caller.mjs'), CALLER_WORKER)
      mkdirSync(join(root, 'cas'))
      mkdirSync(join(root, 'workspaces'))
      const port = await unusedPort()
      writeFileSync(join(root, 'workerd.capnp'), workerdConfig(root, port))

      const child = startWorkerd(WORKERD_BINARY!, join(root, 'workerd.capnp'))
      await waitForWorkerd(port, child)

      const bootstrap = await postJson<{
        database: WorkerdDatabaseReducerDatabaseRefValue
        canonicalOutput: number[]
      }>(
        port,
        '/bootstrap',
        {},
      )
      const replayBase = exactDatabase(
        bootstrap.database,
        decodeDatabaseReducerByteString(Uint8Array.from(bootstrap.canonicalOutput)),
      )
      const transport: ChronologWorkerdHostTransport = {
        run: async (request) => {
          const result = await postJson<
            Omit<WorkerdDatabaseReducerRunResult, 'canonicalOutput'> & {
              readonly canonicalOutput: number[]
            }
          >(port, '/run', serializeOptions(request.options))
          return { ...result, canonicalOutput: Uint8Array.from(result.canonicalOutput) }
        },
        follow: async () => null,
        publish: async () => { throw new Error('BINARY_FIXTURE_DOES_NOT_PUBLISH') },
      }
      const client = new ChronologWorkerdHostClient(transport)
      const execution = workerdExecutionManifestFixture()
      const later = await transaction(execution, 12, 40n)
      const earlier = await transaction(execution, 13, 20n)
      oracle = await DeterministicMaterializer.open({
        path: join(root, 'oracle.db'),
        schemaManifest: portableSchemaManifestFixture(),
        executionManifest: execution,
        checkpointEvery: 1,
      })
      const oracleAppend = await oracle.materialize([later])
      const oracleAppendLog = oracle.transactionLog()
      const oracleReplay = await oracle.materialize([earlier, later])
      const oracleReplayLog = oracle.transactionLog()

      const initialized = await fixture({
        replayBase,
        previous: null,
        previousOrder: [],
        targetOrder: [],
        execution,
      })
      const initializedResponse = await client.run({
        bundle: initialized.bundle,
        inputs: [{
          name: 'replayBase',
          sqlAlias: 'replay_base_db',
          exact: replayBase,
          transport: bootstrap.database,
        }],
        outputSource: 'replayBase',
        compatibility: initialized.compatibility,
      })
      expect(decodeObservation(initializedResponse.application.payload)).toMatchObject({
        orderLength: 0,
        outcomes: [],
        changes: [],
      })
      const checkpoint = selectedDatabase(initializedResponse)

      const append = await fixture({
        replayBase: checkpoint.exact,
        previous: checkpoint.exact,
        previousOrder: [],
        targetOrder: [later],
        execution,
      })
      const appendResponse = await client.run({
        bundle: append.bundle,
        inputs: [
          {
            name: 'previous',
            sqlAlias: 'previous_db',
            exact: checkpoint.exact,
            transport: checkpoint.transport,
          },
          {
            name: 'replayBase',
            sqlAlias: 'replay_base_db',
            exact: checkpoint.exact,
            transport: checkpoint.transport,
          },
        ],
        outputSource: 'replayBase',
        compatibility: append.compatibility,
      })
      const appendObservation = decodeObservation(appendResponse.application.payload)
      expect(appendObservation.orderDigest).toEqual(await digestAdmittedOrder([later.txId]))
      expect(appendObservation.outcomes).toEqual(outcomeObservation(oracleAppendLog))
      expect(appendObservation.changes).toEqual(outcomeChanges(oracleAppend?.outcomeChanges ?? []))
      expect(appendObservation.itemValue).toBe('fixture')
      const appended = selectedDatabase(appendResponse)

      const replay = await fixture({
        replayBase: checkpoint.exact,
        previous: appended.exact,
        previousOrder: [later],
        targetOrder: [earlier, later],
        execution,
      })
      const replayResponse = await client.run({
        bundle: replay.bundle,
        inputs: [
          {
            name: 'previous',
            sqlAlias: 'previous_db',
            exact: appended.exact,
            transport: appended.transport,
          },
          {
            name: 'replayBase',
            sqlAlias: 'replay_base_db',
            exact: checkpoint.exact,
            transport: checkpoint.transport,
          },
        ],
        outputSource: 'replayBase',
        compatibility: replay.compatibility,
      })
      const replayObservation = decodeObservation(replayResponse.application.payload)
      expect(replayObservation.orderDigest).toEqual(
        await digestAdmittedOrder([earlier.txId, later.txId]),
      )
      expect(replayObservation.outcomes).toEqual(outcomeObservation(oracleReplayLog))
      expect(replayObservation.changes).toEqual(outcomeChanges(oracleReplay?.outcomeChanges ?? []))
      expect(replayObservation.itemValue).toBe('fixture')

      expect(replayResponse.application.databaseSelector).toBe('materialized')
      expect(replayResponse.application.selectedSource).toBe('materialized')
      expect(replayResponse.transportOutputs).toHaveLength(1)
      expect(replayResponse.transportOutputs[0]?.database.commitHash).not.toBe(
        appendResponse.transportOutputs[0]?.database.commitHash,
      )
      expect(replayResponse.transportOutputs[0]?.database.repositoryRoot.storeId).toBe(
        bootstrap.database.repositoryRoot.storeId,
      )
    } finally {
      oracle?.close()
      await Promise.all([...activeProcesses].map(stopWorkerd))
      rmSync(root, { recursive: true, force: true })
    }
  }, 60_000)
})

function bundleWorker(entry: string, output: string): void {
  const executable = findEsbuildBinary()
  const built = spawnSync(executable, [
    entry,
    '--bundle',
    '--format=esm',
    '--platform=browser',
    '--target=es2022',
    `--outfile=${output}`,
    '--conditions=workerd,worker,browser',
  ], { cwd: REPOSITORY_ROOT, encoding: 'utf8' })
  if (built.status !== 0) {
    throw new Error(`esbuild failed: ${built.stderr || built.stdout}`)
  }
}

function findEsbuildBinary(): string {
  const pnpm = join(REPOSITORY_ROOT, 'node_modules', '.pnpm')
  const packageDir = readdirSync(pnpm).find((entry) => entry.startsWith('esbuild@'))
  if (packageDir === undefined) throw new Error('Installed esbuild package is required')
  const executable = join(pnpm, packageDir, 'node_modules', 'esbuild', 'bin', 'esbuild')
  chmodSync(executable, 0o755)
  return executable
}

function startWorkerd(binary: string, config: string): ChildProcessWithoutNullStreams {
  const child = spawn(binary, ['serve', config], { cwd: dirname(config) })
  child.stdout.resume()
  processStderr.set(child, '')
  child.stderr.on('data', (chunk: Buffer) => {
    processStderr.set(child, `${processStderr.get(child) ?? ''}${chunk.toString()}`.slice(-16_384))
  })
  activeProcesses.add(child)
  return child
}

async function stopWorkerd(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (!activeProcesses.delete(child)) return
  if (child.exitCode !== null) {
    processStderr.delete(child)
    return
  }
  child.kill('SIGTERM')
  await Promise.race([
    new Promise<void>((resolveClose) => child.once('close', () => resolveClose())),
    new Promise<void>((resolveTimeout) => setTimeout(resolveTimeout, 2_000)),
  ])
  if (child.exitCode === null) child.kill('SIGKILL')
  processStderr.delete(child)
}

async function waitForWorkerd(port: number, child: ChildProcessWithoutNullStreams): Promise<void> {
  let stderr = ''
  child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-16_384) })
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`workerd exited before readiness: ${stderr}`)
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`)
      if (response.ok) return
    } catch {
      // The socket is not accepting requests yet.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50))
  }
  throw new Error(`workerd readiness timeout: ${stderr}`)
}

async function unusedPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('TCP port allocation failed')
  await new Promise<void>((resolveClose, rejectClose) => server.close((error) => {
    if (error) rejectClose(error)
    else resolveClose()
  }))
  return address.port
}

async function postJson<Result>(port: number, path: string, value: unknown): Promise<Result> {
  let response: Response
  try {
    response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(value),
    })
  } catch (error) {
    throw new Error(`workerd fixture request failed\n${activeWorkerdStderr()}`, { cause: error })
  }
  const text = await response.text()
  if (!response.ok) {
    throw new Error(`workerd fixture ${response.status}: ${text}\n${activeWorkerdStderr()}`)
  }
  return JSON.parse(text) as Result
}

function activeWorkerdStderr(): string {
  return [...activeProcesses]
    .map((child) => processStderr.get(child) ?? '')
    .filter((value) => value.length > 0)
    .join('\n')
}

function serializeOptions(options: WorkerdDatabaseReducerRunOptions): unknown {
  return { ...options, canonicalInput: [...options.canonicalInput] }
}

function fromHex(value: string): Uint8Array {
  if (value.length % 2 !== 0) throw new Error('INVALID_HEX')
  return Uint8Array.from({ length: value.length / 2 }, (_, index) =>
    Number.parseInt(value.slice(index * 2, index * 2 + 2), 16))
}

function exactDatabase(
  value: WorkerdDatabaseReducerDatabaseRefValue,
  canonicalGenesisCommit: Uint8Array,
): ExactDatabaseRef {
  if (canonicalGenesisCommit.byteLength !== 20) throw new Error('INVALID_CANONICAL_GENESIS')
  return {
    storeId: fromHex(value.repositoryRoot.storeId),
    doltFormatVersion: value.doltFormatVersion,
    canonicalGenesisCommit: {
      doltFormatVersion: value.doltFormatVersion,
      contentId: { algorithm: 'dolt-blake3-160', digest: canonicalGenesisCommit },
    },
    commitHash: {
      doltFormatVersion: value.doltFormatVersion,
      contentId: { algorithm: 'dolt-blake3-160', digest: fromHex(value.commitHash) },
    },
    stateDigest: {
      stateFormatVersion: value.stateFormatVersion,
      contentId: { algorithm: 'dolt-blake3-160', digest: fromHex(value.stateDigest) },
    },
  }
}

function selectedDatabase(response: ChronologWorkerdBundleExecutionResponse): {
  readonly exact: ExactDatabaseRef
  readonly transport: WorkerdDatabaseReducerDatabaseRefValue
} {
  const exact = response.outputs[0]?.ref
  const transport = response.transportOutputs[0]?.database
  if (exact === undefined || transport === undefined) throw new Error('BINARY_OUTPUT_MISSING')
  return { exact, transport }
}

interface BinaryObservation {
  readonly orderLength: number
  readonly orderDigest: Uint8Array
  readonly outcomes: readonly {
    readonly txId: Uint8Array
    readonly outcome: string
    readonly rejectionCode: string | null
  }[]
  readonly itemValue: string
  readonly changes: readonly {
    readonly txId: Uint8Array
    readonly previous: string | null
    readonly current: string
    readonly previousRejectionCode: string | null
    readonly currentRejectionCode: string | null
  }[]
}

function decodeObservation(bytes: Uint8Array): BinaryObservation {
  const map = expectMap(assertCanonicalCbor(bytes, DEFAULT_DECODE_LIMITS), 'binary_observation')
  if (expectBigint(required(map, 0, 'binary_observation.version'),
    'binary_observation.version') !== 1n) throw new Error('BINARY_OBSERVATION_VERSION')
  const nullableString = (value: CborValue | undefined, name: string): string | null => {
    if (value === undefined) throw new Error(`${name} is missing`)
    return value === null ? null : expectString(value, name)
  }
  const outcomes = expectArray(required(map, 3, 'binary_observation.outcomes'),
    'binary_observation.outcomes').map((value, index) => {
    const tuple = expectArray(value, `binary_observation.outcomes[${index}]`)
    if (tuple.length !== 3) throw new Error('BINARY_OBSERVATION_OUTCOME_ARITY')
    return {
      txId: expectBytes(tuple[0] ?? null, `binary_observation.outcomes[${index}].tx_id`),
      outcome: expectString(tuple[1] ?? null, `binary_observation.outcomes[${index}].outcome`),
      rejectionCode: nullableString(tuple[2],
        `binary_observation.outcomes[${index}].rejection_code`),
    }
  })
  const changes = expectArray(required(map, 5, 'binary_observation.changes'),
    'binary_observation.changes').map((value, index) => {
    const tuple = expectArray(value, `binary_observation.changes[${index}]`)
    if (tuple.length !== 5) throw new Error('BINARY_OBSERVATION_CHANGE_ARITY')
    return {
      txId: expectBytes(tuple[0] ?? null, `binary_observation.changes[${index}].tx_id`),
      previous: nullableString(tuple[1], `binary_observation.changes[${index}].previous`),
      current: expectString(tuple[2] ?? null, `binary_observation.changes[${index}].current`),
      previousRejectionCode: nullableString(tuple[3],
        `binary_observation.changes[${index}].previous_rejection_code`),
      currentRejectionCode: nullableString(tuple[4],
        `binary_observation.changes[${index}].current_rejection_code`),
    }
  })
  return {
    orderLength: Number(expectBigint(required(map, 1, 'binary_observation.order_length'),
      'binary_observation.order_length')),
    orderDigest: expectBytes(required(map, 2, 'binary_observation.order_digest'),
      'binary_observation.order_digest'),
    outcomes,
    itemValue: expectString(required(map, 4, 'binary_observation.item_value'),
      'binary_observation.item_value'),
    changes,
  }
}

function outcomeObservation(log: readonly TransactionLogRow[]): BinaryObservation['outcomes'] {
  return log.map((row) => ({
    txId: row.txId,
    outcome: row.outcome,
    rejectionCode: row.rejectionCode,
  }))
}

function outcomeChanges(changes: readonly OutcomeChange[]): BinaryObservation['changes'] {
  return changes.map((change) => ({
    txId: change.txId,
    previous: change.previous,
    current: change.current,
    previousRejectionCode: change.previousRejectionCode,
    currentRejectionCode: change.currentRejectionCode,
  }))
}

const bytes = (value: number, length: number): Uint8Array => new Uint8Array(length).fill(value)

async function artifact(
  kind: ExactArtifactRef['kind'],
  codec: number,
  value: Uint8Array,
): Promise<ExactArtifactRef> {
  return {
    kind,
    formatVersion: 1,
    object: {
      storeId: Uint8Array.of(1),
      codec: { number: codec, version: 1 },
      contentId: { algorithm: 'sha2-256', digest: await sha256(value) },
    },
  }
}

function workerdExecutionManifestFixture(): ExecutionManifest {
  const portable = portableExecutionManifestFixture()
  return {
    ...portable,
    engineDigest: readNativeEngineInfo().digest,
    resources: {
      ...portable.resources,
      maxExpressionDepth: 100,
      maxQueryRows: 10_000,
    },
  }
}

async function transaction(
  execution: ExecutionManifest,
  identity: number,
  authorTimestampMs: bigint,
): Promise<AdmittedTransaction> {
  const schema = portableSchemaManifestFixture()
  const core: TransactionCore = {
    groupId: bytes(7, 32),
    membershipRevision: bytes(8, 32),
    validationPolicy: bytes(9, 32),
    authorId: bytes(10, 32),
    authorTimestampMs,
    nonce: bytes(identity + 16, 16),
    executionManifestDigest: await digestExecutionManifest(execution),
    schemaDigest: await digestSchemaManifest(schema),
    program: replayTransactionProgramFixture(),
  }
  const canonicalCandidate = encodeTransactionCore(core)
  return {
    txId: bytes(identity, 16),
    authorFeedSequence: BigInt(identity),
    candidateDigest: await transactionDigest(canonicalCandidate),
    canonicalCandidate,
    core,
  }
}

function replayTransactionProgramFixture(): TransactionProgram {
  const base = portableTransactionProgramFixture()
  const existing: Query = {
    id: 101,
    ctes: [],
    from: { kind: 'table', id: 102, name: 'items', alias: 'item' },
    joins: [],
    where: {
      kind: 'binary',
      id: 103,
      operator: 'eq',
      left: { kind: 'column', id: 104, relation: 'item', name: 'id' },
      right: { kind: 'literal', id: 105, value: { kind: 'int64', value: 2n } },
    },
    groupBy: [],
    windows: [],
    compounds: [],
    orderBy: [],
    projection: [{
      id: 106,
      name: 'id',
      expression: { kind: 'column', id: 107, relation: 'item', name: 'id' },
    }],
    resultMode: { kind: 'set' },
  }
  return {
    preconditions: [{
      kind: 'assert',
      id: 108,
      query: {
        id: 109,
        ctes: [],
        joins: [],
        groupBy: [],
        windows: [],
        compounds: [],
        orderBy: [],
        projection: [{
          id: 110,
          name: 'available',
          expression: { kind: 'exists', id: 111, negated: true, query: existing },
        }],
        resultMode: { kind: 'scalar' },
      },
      unknownIsFailure: true,
    }],
    mutations: base.mutations,
    metadata: base.metadata ?? new Map(),
  }
}

async function fixture(options: {
  readonly replayBase: ExactDatabaseRef
  readonly previous: ExactDatabaseRef | null
  readonly previousOrder: readonly AdmittedTransaction[]
  readonly targetOrder: readonly AdmittedTransaction[]
  readonly execution: ExecutionManifest
  readonly replayFromIndex?: number
}): Promise<{
  readonly bundle: ChronologReducerInvocationBundle
  readonly compatibility: ChronologCompatibilityTuple
}> {
  const schema = portableSchemaManifestFixture()
  const replayFromIndex = options.replayFromIndex ?? 0
  const targetOrderDigest = await digestAdmittedOrder(options.targetOrder.map(({ txId }) => txId))
  const suffix: ChronologAdmittedSuffix = {
    version: 1,
    groupId: bytes(7, 32),
    replayFromIndex,
    targetOrderLength: options.targetOrder.length,
    targetOrderDigest,
    transactions: options.targetOrder.slice(replayFromIndex),
  }
  const schemaBytes = encodeSchemaManifest(schema)
  const executionBytes = encodeExecutionManifest(options.execution)
  const suffixBytes = encodeAdmittedSuffix(suffix)
  const baseManifestBytes = Uint8Array.of(0xa1, 0x00, 0x01)
  const schemaRef = await artifact('schema-manifest', 101, schemaBytes)
  const executionRef = await artifact('execution-manifest', 102, executionBytes)
  const suffixRef = await artifact('admitted-suffix', 103, suffixBytes)
  const baseManifest = await artifact('materialization-manifest', 104, baseManifestBytes)
  const compatibility = {
    engineDigest: options.execution.engineDigest,
    schemaDigest: await digestSchemaManifest(schema),
    executionManifestDigest: await digestExecutionManifest(options.execution),
  }
  const invocation = encodeMaterializationInvocation({
    version: 1,
    profile: 'pure',
    context: { groupId: bytes(7, 32), logicalTimeMs: null, entropySeed: null },
    previous: options.previous === null
      ? null
      : { manifest: baseManifest, database: options.previous },
    replayBase: { manifest: baseManifest, database: options.replayBase },
    admittedSuffix: suffixRef,
    schemaManifest: schemaRef,
    executionManifest: executionRef,
    continuation: null,
    expectedEngineDigest: compatibility.engineDigest,
    expectedSchemaDigest: compatibility.schemaDigest,
    expectedExecutionManifestDigest: compatibility.executionManifestDigest,
    expectedPreviousOrderDigest: await digestAdmittedOrder(
      options.previousOrder.map(({ txId }) => txId),
    ),
    replayFromIndex,
    targetOrderLength: options.targetOrder.length,
    targetOrderDigest,
  })
  return {
    bundle: {
      version: 1,
      invocation,
      objects: [
        { ref: baseManifest.object, bytes: baseManifestBytes },
        { ref: suffixRef.object, bytes: suffixBytes },
        { ref: schemaRef.object, bytes: schemaBytes },
        { ref: executionRef.object, bytes: executionBytes },
      ],
    },
    compatibility,
  }
}

function workerdConfig(root: string, port: number): string {
  const q = (value: string): string => JSON.stringify(value)
  return `using Workerd = import "/workerd/workerd.capnp";\n` +
    `const config :Workerd.Config = (\n` +
    `  databaseReducerLocal = (storeId = "chronolog-workerd-fixture", ` +
    `casDirectory = ${q(join(root, 'cas'))}, ` +
    `metadataSnapshot = ${q(join(root, 'executions.snapshot'))}, ` +
    `refSnapshot = ${q(join(root, 'refs.snapshot'))}, ` +
    `workspaceDirectory = ${q(join(root, 'workspaces'))}),\n` +
    `  services = [\n` +
    `    (name = "bootstrap", reducerWorker = (profile = standard, worker = (` +
    `compatibilityDate = "2026-07-15", modules = [` +
    `(name = "bootstrap.mjs", esModule = embed "bootstrap.mjs")]))),\n` +
    `    (name = "chronolog", reducerWorker = (profile = pure, worker = (` +
    `compatibilityDate = "2026-07-15", modules = [` +
    `(name = "chronolog-reducer.mjs", esModule = embed "chronolog-reducer.mjs")]))),\n` +
    `    (name = "caller", worker = (compatibilityDate = "2026-07-15", modules = [` +
    `(name = "caller.mjs", esModule = embed "caller.mjs")], bindings = [` +
    `(name = "BOOTSTRAP", databaseReducer = "bootstrap"), ` +
    `(name = "CHRONOLOG", databaseReducer = "chronolog")]))\n` +
    `  ],\n` +
    `  sockets = [(name = "http", address = "127.0.0.1:${port}", service = "caller")],\n` +
    `);\n`
}

const BOOTSTRAP_WORKER = `export default {
  async reduce(databases) {
    const output = databases.getOutput("base");
    const genesis = output.status.headCommit;
    output.execute("CREATE TABLE chronolog_seed(id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
    output.execute("INSERT INTO chronolog_seed VALUES (1, 'seed')");
    output.commit({message: "bootstrap", authorName: "fixture", authorEmail: "fixture@invalid", timestamp: "1970-01-01T00:00:00"});
    const genesisBytes = Uint8Array.from({length: 20}, (_, index) => Number.parseInt(genesis.slice(index * 2, index * 2 + 2), 16));
    return {databases: {base: output}, output: genesisBytes};
  }
};
`

const CALLER_WORKER = `function result(value) {
  return {
    databases: value.databases,
    canonicalOutput: [...value.canonicalOutput],
  };
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/health") return new Response("ok");
    try {
      if (url.pathname === "/bootstrap") {
        const value = await env.BOOTSTRAP.run({
          inputs: [],
          outputs: [{logicalName: "base", sqlAlias: "base_db", origin: "create-canonical", sourceInput: "", commit: {message: "bootstrap", authorName: "fixture", authorEmail: "fixture@invalid", timestamp: "1970-01-01T00:00:00"}}],
          canonicalInput: new Uint8Array([0xf6]),
        });
        return Response.json({database: value.databases[0].database, canonicalOutput: [...value.canonicalOutput]});
      }
      if (url.pathname === "/run") {
        const body = await request.json();
        body.canonicalInput = new Uint8Array(body.canonicalInput);
        return Response.json(result(await env.CHRONOLOG.run(body)));
      }
      return new Response("not found", {status: 404});
    } catch (error) {
      return Response.json({error: error instanceof Error ? error.message : String(error)}, {status: 500});
    }
  }
};
`
