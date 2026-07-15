import { sha256 } from '@chronolog/canonical'
import {
  digestExecutionManifest,
  digestSchemaManifest,
  encodeExecutionManifest,
  encodeSchemaManifest,
  portableExecutionManifestFixture,
  portableSchemaManifestFixture,
  portableTransactionProgramFixture,
} from '@chronolog/ir'
import {
  decodeMaterializationInvocation,
  digestAdmittedOrder,
  encodeAdmittedSuffix,
  encodeMaterializationInvocation,
  type ChronologAdmittedSuffix,
  type ExactArtifactRef,
  type ExactDatabaseRef,
} from '@chronolog/materializer'
import { encodeTransactionCore, transactionDigest, type TransactionCore } from '@chronolog/protocol'
import { describe, expect, it } from 'vitest'

import {
  ChronologWorkerdHostClient,
  createChronologReducerWorkerModule,
  decodeDatabaseReducerByteString,
  encodeDatabaseReducerByteString,
  type ChronologCompatibilityTuple,
  type ChronologReducerWorkerModule,
  type ChronologReducerInvocationBundle,
  type ChronologWorkerdHostTransport,
  type ChronologWorkerdPublicationIntent,
  type ChronologWorkerdPublicationResult,
  type ChronologWorkerdTransportRunRequest,
  type DatabaseReducerDatabasesHandle,
  type DatabaseReducerHandlerResult,
  type DatabaseReducerInputHandle,
  type DatabaseReducerInvocationContextHandle,
  type DatabaseReducerOutputHandle,
  type DatabaseReducerOutputStatus,
  type WorkerdDatabaseReducerDatabaseRefValue,
  type WorkerdDatabaseReducerRunResult,
} from './index.js'

const bytes = (value: number, length: number): Uint8Array => new Uint8Array(length).fill(value)
const hex = (value: Uint8Array): string =>
  Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join('')

function database(seed: number): ExactDatabaseRef {
  const chunk = (value: number) => ({
    doltFormatVersion: 1,
    contentId: { algorithm: 'dolt-blake3-160' as const, digest: bytes(value, 20) },
  })
  return {
    storeId: Uint8Array.of(1),
    doltFormatVersion: 1,
    canonicalGenesisCommit: chunk(1),
    commitHash: chunk(seed),
    stateDigest: {
      stateFormatVersion: 1,
      contentId: { algorithm: 'dolt-blake3-160', digest: bytes(seed + 1, 20) },
    },
  }
}

function transportDatabase(value: ExactDatabaseRef): WorkerdDatabaseReducerDatabaseRefValue {
  return {
    repositoryRoot: {
      storeId: hex(value.storeId),
      codecNumber: 0x4442_0001,
      codecVersion: 1,
      hashAlgorithm: 'sha2-256',
      digest: hex(bytes(0x91, 32)),
    },
    doltFormatVersion: value.doltFormatVersion,
    commitHash: hex(value.commitHash.contentId.digest),
    stateFormatVersion: value.stateDigest.stateFormatVersion,
    stateDigest: hex(value.stateDigest.contentId.digest),
  }
}

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

async function fixture(): Promise<{
  readonly bundle: ChronologReducerInvocationBundle
  readonly compatibility: ChronologCompatibilityTuple
  readonly replayBase: ExactDatabaseRef
}> {
  const schema = portableSchemaManifestFixture()
  const execution = portableExecutionManifestFixture()
  const core: TransactionCore = {
    groupId: bytes(7, 32),
    membershipRevision: bytes(8, 32),
    validationPolicy: bytes(9, 32),
    authorId: bytes(10, 32),
    authorTimestampMs: 42n,
    nonce: bytes(11, 16),
    executionManifestDigest: await digestExecutionManifest(execution),
    schemaDigest: await digestSchemaManifest(schema),
    program: portableTransactionProgramFixture(),
  }
  const canonicalCandidate = encodeTransactionCore(core)
  const transaction = {
    txId: bytes(12, 16),
    authorFeedSequence: 4n,
    candidateDigest: await transactionDigest(canonicalCandidate),
    canonicalCandidate,
    core,
  }
  const targetOrderDigest = await digestAdmittedOrder([transaction.txId])
  const suffix: ChronologAdmittedSuffix = {
    version: 1,
    groupId: core.groupId,
    replayFromIndex: 0,
    targetOrderLength: 1,
    targetOrderDigest,
    transactions: [transaction],
  }
  const schemaBytes = encodeSchemaManifest(schema)
  const executionBytes = encodeExecutionManifest(execution)
  const suffixBytes = encodeAdmittedSuffix(suffix)
  const baseManifestBytes = Uint8Array.of(0xa1, 0x00, 0x01)
  const schemaRef = await artifact('schema-manifest', 101, schemaBytes)
  const executionRef = await artifact('execution-manifest', 102, executionBytes)
  const suffixRef = await artifact('admitted-suffix', 103, suffixBytes)
  const baseManifest = await artifact('materialization-manifest', 104, baseManifestBytes)
  const replayBase = database(2)
  const compatibility = {
    engineDigest: execution.engineDigest,
    schemaDigest: await digestSchemaManifest(schema),
    executionManifestDigest: await digestExecutionManifest(execution),
  }
  const invocation = encodeMaterializationInvocation({
    version: 1,
    profile: 'pure',
    context: { groupId: core.groupId, logicalTimeMs: null, entropySeed: null },
    previous: null,
    replayBase: { manifest: baseManifest, database: replayBase },
    admittedSuffix: suffixRef,
    schemaManifest: schemaRef,
    executionManifest: executionRef,
    continuation: null,
    expectedEngineDigest: compatibility.engineDigest,
    expectedSchemaDigest: compatibility.schemaDigest,
    expectedExecutionManifestDigest: compatibility.executionManifestDigest,
    expectedPreviousOrderDigest: await digestAdmittedOrder([]),
    replayFromIndex: 0,
    targetOrderLength: 1,
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
    replayBase,
  }
}

describe('deployable Chronolog reducer bundle and typed host client', () => {
  it('executes the real module contract, follows an ambiguous run, and publishes separately', async () => {
    const built = await fixture()
    const module = createChronologReducerWorkerModule({
      async materialize(input, context) {
        expect(input.admittedSuffix.transactions).toHaveLength(1)
        expect(context.previous).toBeNull()
        expect(context.replayBase.logicalName).toBe('replayBase')
        context.materialized.execute('CREATE TABLE shadow_execution(id INTEGER PRIMARY KEY)')
        context.materialized.commit({
          message: 'shadow materialization',
          authorName: 'Chronolog test',
          authorEmail: 'test@chronolog.invalid',
          timestamp: '1970-01-01T00:00:00',
        })
        return {
          databaseSelector: 'materialized',
          selectedSource: 'materialized',
          payload: input.invocation.targetOrderDigest,
        }
      },
    })
    const host = new InMemoryWorkerdHost(module)
    host.loseNextRunResponse = true
    const client = new ChronologWorkerdHostClient(host)
    const request = {
      bundle: built.bundle,
      inputs: [{
        name: 'replayBase' as const,
        sqlAlias: 'replay_base_db',
        exact: built.replayBase,
        transport: transportDatabase(built.replayBase),
      }],
      outputSource: 'replayBase' as const,
      compatibility: built.compatibility,
    }

    const response = await client.execute(request)
    expect(host.runCount).toBe(1)
    expect(host.followCount).toBe(1)
    expect(host.executedSql).toEqual(['CREATE TABLE shadow_execution(id INTEGER PRIMARY KEY)'])
    expect(response.application.databaseSelector).toBe('materialized')
    expect(response.application.selectedSource).toBe('materialized')
    expect(response.application.payload).toEqual(
      decodeMaterializationInvocation(built.bundle.invocation).targetOrderDigest,
    )
    expect(response.application.exactReadSet).toHaveLength(4)
    expect(response.outputs).toHaveLength(1)
    expect(response.outputs[0]?.name).toBe('materialized')
    expect(response.outputs[0]?.ref.commitHash.contentId.digest).toEqual(bytes(0x44, 20))
    expect(host.publications).toEqual([])

    const intent = client.createPublicationIntent(response, 'groups/demo/materialized', built.replayBase)
    const published = await client.publish(intent)
    expect(published.status).toBe('published')
    expect(host.publications).toHaveLength(1)
    expect(host.reducerObservedPublicationCapability).toBe(false)
  })
})

class MemoryInput implements DatabaseReducerInputHandle {
  constructor(
    readonly logicalName: string,
    readonly sqlAlias: string,
  ) {}

  queryText(_sql: string): string { return '' }
  query(): { readonly columnNames: readonly string[]; readonly rows: readonly [] } {
    return { columnNames: [], rows: [] }
  }
}

class MemoryOutput implements DatabaseReducerOutputHandle {
  #dirty = true

  constructor(
    readonly logicalName: string,
    readonly sqlAlias: string,
    private readonly sql: string[],
  ) {}

  get status(): DatabaseReducerOutputStatus {
    return {
      logicalName: this.logicalName,
      sqlAlias: this.sqlAlias,
      headCommit: hex(bytes(0x44, 20)),
      stateDigest: hex(bytes(0x45, 20)),
      dirty: this.#dirty,
    }
  }

  queryText(_sql: string): string { return '' }
  query(): { readonly columnNames: readonly string[]; readonly rows: readonly [] } {
    return { columnNames: [], rows: [] }
  }

  execute(sql: string): { readonly columnNames: readonly string[]; readonly rows: readonly [] } {
    this.sql.push(sql)
    this.#dirty = true
    return { columnNames: [], rows: [] }
  }

  transactionSync<T>(callback: () => T): T { return callback() }

  commit(): string {
    this.#dirty = false
    return this.status.headCommit
  }
}

class MemoryDatabases implements DatabaseReducerDatabasesHandle {
  readonly inputNames: readonly string[]
  readonly outputNames: readonly string[]

  constructor(
    private readonly inputs: ReadonlyMap<string, MemoryInput>,
    private readonly outputs: ReadonlyMap<string, MemoryOutput>,
  ) {
    this.inputNames = [...inputs.keys()]
    this.outputNames = [...outputs.keys()]
  }

  getInput(logicalName: string): MemoryInput | null {
    return this.inputs.get(logicalName) ?? null
  }

  getOutput(logicalName: string): MemoryOutput | null {
    return this.outputs.get(logicalName) ?? null
  }
}

class InMemoryWorkerdHost implements ChronologWorkerdHostTransport {
  loseNextRunResponse = false
  runCount = 0
  followCount = 0
  readonly executedSql: string[] = []
  readonly publications: ChronologWorkerdPublicationIntent[] = []
  reducerObservedPublicationCapability = false
  readonly #completed = new Map<string, WorkerdDatabaseReducerRunResult>()

  constructor(private readonly module: ChronologReducerWorkerModule) {}

  async run(request: ChronologWorkerdTransportRunRequest): Promise<WorkerdDatabaseReducerRunResult> {
    this.runCount += 1
    const inputs = new Map(request.options.inputs.map((input) => [
      input.logicalName,
      new MemoryInput(input.logicalName, input.sqlAlias),
    ]))
    const outputPlan = request.options.outputs[0]
    if (outputPlan === undefined) throw new Error('OUTPUT_PLAN_REQUIRED')
    const output = new MemoryOutput(outputPlan.logicalName, outputPlan.sqlAlias, this.executedSql)
    const outputs = new Map([[output.logicalName, output]])
    const context: DatabaseReducerInvocationContextHandle = {
      cas: {
        get: async () => { throw new Error('PURE_CAS_UNUSED') },
      },
      waitUntil: (_promise) => undefined,
      randomBytes: () => { throw new Error('PURE_RANDOM_UNUSED') },
    }
    this.reducerObservedPublicationCapability = 'publish' in context
    const result = await this.module.reduce(
      new MemoryDatabases(inputs, outputs),
      decodeDatabaseReducerByteString(request.options.canonicalInput),
      {},
      context,
    )
    const response = this.completeResult(result, request, inputs, output)
    this.#completed.set(hex(request.executionKey), response)
    if (this.loseNextRunResponse) {
      this.loseNextRunResponse = false
      throw new Error('AMBIGUOUS_RESPONSE_LOSS')
    }
    return response
  }

  async follow(executionKey: Uint8Array): Promise<WorkerdDatabaseReducerRunResult | null> {
    this.followCount += 1
    return this.#completed.get(hex(executionKey)) ?? null
  }

  async publish(request: ChronologWorkerdPublicationIntent): Promise<ChronologWorkerdPublicationResult> {
    this.publications.push(request)
    return { status: 'published', generation: 1n, current: request.selectedOutput.ref }
  }

  private completeResult(
    result: DatabaseReducerHandlerResult,
    request: ChronologWorkerdTransportRunRequest,
    inputs: ReadonlyMap<string, MemoryInput>,
    output: MemoryOutput,
  ): WorkerdDatabaseReducerRunResult {
    if (!(result.output instanceof Uint8Array)) throw new Error('OUTPUT_BYTES_REQUIRED')
    const selected = Object.entries(result.databases)
    const databases = selected.map(([logicalName, handle]) => {
      const inputIndex = [...inputs.values()].findIndex((candidate) => candidate === handle)
      if (inputIndex >= 0) {
        const source = request.options.inputs[inputIndex]
        if (source === undefined) throw new Error('INPUT_RESULT_MISSING')
        return { logicalName, sqlAlias: handle.sqlAlias, database: source.database }
      }
      if (handle !== output) throw new Error('UNKNOWN_SELECTED_HANDLE')
      const source = request.options.inputs.find((input) =>
        input.logicalName === request.options.outputs[0]?.sourceInput)
      if (source === undefined) throw new Error('OUTPUT_SOURCE_MISSING')
      return {
        logicalName,
        sqlAlias: output.sqlAlias,
        database: {
          ...source.database,
          repositoryRoot: { ...source.database.repositoryRoot, digest: hex(bytes(0x46, 32)) },
          commitHash: output.status.headCommit,
          stateDigest: output.status.stateDigest,
        },
      }
    })
    return {
      databases,
      canonicalOutput: encodeDatabaseReducerByteString(result.output),
    }
  }
}
