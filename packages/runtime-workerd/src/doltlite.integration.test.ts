import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  encodeCanonicalCbor,
  hexToBytes,
  integerMap,
  sha256,
  utf8,
  type CborValue,
} from '@chronolog/canonical'
import { createCoreExecutionManifest } from '@chronolog/compiler-sqlite'
import {
  digestExecutionManifest,
  digestSchemaManifest,
  encodeExecutionManifest,
  encodeSchemaManifest,
  type Expr,
  type Mutation,
  type Precondition,
  type Query,
  type SchemaManifest,
} from '@chronolog/ir'
import {
  compareObjectRefs,
  createFixtureObjectReader,
  createInProcessDifferentialBackend,
  decodeMaterializationOutcome,
  digestAdmittedOrder,
  encodeAdmittedSuffix,
  encodeMaterializationInvocation,
  encodeMaterializationOutcome,
  exactDatabaseRefToCbor,
  runDifferentialFixture,
  sameBytes,
  type AdmittedTransaction,
  type ChronologAdmittedSuffix,
  type ChronologMaterializationInvocation,
  type ChronologMaterializationOutcome,
  type DifferentialMaterializationFixture,
  type DifferentialObservation,
  type ExactArtifactRef,
  type ExactDatabaseRef,
  type ExactObjectRef,
  type MaterializationInput,
} from '@chronolog/materializer'
import {
  DeterministicMaterializer,
  createDoltLitePortableKernel,
  readNativeEngineInfo,
  type DoltLitePortableProjectionContext,
  type MaterializedRevision,
  type TransactionLogRow,
} from '@chronolog/materializer-doltlite'
import {
  encodeTransactionCore,
  transactionDigest,
  type TransactionCore,
} from '@chronolog/protocol'
import { afterEach, describe, expect, it } from 'vitest'

import {
  createChronologWorkerdDifferentialBackend,
  runChronologWorkerdController,
  type ChronologCompatibilityTuple,
  type ChronologExecutionResponse,
  type ChronologWorkerdDatabaseKernel,
  type ChronologWorkerdHostContext,
} from './index.js'

const STORE_ID = utf8('chronolog-real-doltlite-differential-v1')
const MATERIALIZATION_MANIFEST_CODEC = 0x434d_0001
const OUTCOME_CHANGES_CODEC = 0x434f_0001
const temporaryDirectories: string[] = []

const schema: SchemaManifest = {
  version: 1,
  name: 'workerd_differential_ledger',
  objects: [{
    kind: 'table',
    id: 1,
    name: 'accounts',
    declarationOrder: 0,
    withoutRowId: true,
    columns: [
      {
        id: 2,
        name: 'id',
        declarationOrder: 0,
        valueType: { logical: { kind: 'int64' }, nullable: false },
      },
      {
        id: 3,
        name: 'balance',
        declarationOrder: 1,
        valueType: { logical: { kind: 'int64' }, nullable: false },
      },
    ],
    constraints: [{ kind: 'primary_key', id: 4, name: 'accounts_pk', columnIds: [2] }],
  }],
  seedRows: [{ tableId: 1, values: new Map([
    [2, { kind: 'int64', value: 1n }],
    [3, { kind: 'int64', value: 100n }],
  ]) }],
  functionIds: [],
  collationIds: [],
  moduleIds: [],
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (directory) =>
    rm(directory, { recursive: true, force: true })))
})

describe('real DoltLite through the workerd controller contract', () => {
  it('matches legacy append and late-predecessor replay without reducer publication authority', async () => {
    // This is deliberately a test-only composition: it gives the portable
    // controller a pinned native DoltLite oracle without importing Node/N-API
    // code into runtime-workerd's production graph or claiming a JSG binding.
    const native = readNativeEngineInfo()
    const executionManifest = createCoreExecutionManifest({
      profile: 'chronolog-workerd-real-differential-v1',
      engine: native.descriptor,
      engineDigest: native.digest,
    })
    const legacy = await openMaterializer('legacy', executionManifest)
    const workerd = await openMaterializer('workerd', executionManifest)
    try {
      const compatibility: ChronologCompatibilityTuple = {
        engineDigest: executionManifest.engineDigest,
        schemaDigest: await digestSchemaManifest(schema),
        executionManifestDigest: await digestExecutionManifest(executionManifest),
      }
      const legacyGenesis = await databaseRef(
        legacy,
        genesisContentHash(legacy),
        genesisContentHash(legacy),
      )
      const workerdGenesis = await databaseRef(
        workerd,
        genesisContentHash(workerd),
        genesisContentHash(workerd),
      )
      expect(workerdGenesis).toEqual(legacyGenesis)
      const genesisManifestBytes = snapshotManifestBytes(
        workerdGenesis,
        0n,
        0,
        await digestAdmittedOrder([]),
      )
      const genesisManifest = await artifactRef(
        'materialization-manifest',
        MATERIALIZATION_MANIFEST_CODEC,
        genesisManifestBytes,
      )
      const genesis: InputFixture = {
        input: { manifest: genesisManifest, database: workerdGenesis },
        manifestBytes: genesisManifestBytes,
      }
      const later = await transaction(2, 20n, [setBalance(100, 90n)], [
        expectBalance(200, 100n),
      ], compatibility)
      const earlier = await transaction(1, 10n, [setBalance(300, 5n)], [
        truePrecondition(400),
      ], compatibility)

      const append = await runStage({
        name: 'append-later',
        legacy,
        workerd,
        compatibility,
        schemaManifest: schema,
        executionManifest,
        previous: genesis,
        replayBase: genesis,
        expectedPrevious: [],
        replayFromIndex: 0,
        suffix: [later],
        target: [later],
        expectedPrivateSource: 'previous',
      })
      expect(append.workerdOutcome.kind).toBe('completed')
      expect(append.workerdRevision).toMatchObject({
        replayFromIndex: 0,
        replayedTransactions: 1,
        earliestChangedOrderIndex: 0,
      })
      expect(await balance(workerd)).toBe(90n)
      expect(workerd.outcome(later.txId)).toMatchObject({ outcome: 'accepted' })

      const replay = await runStage({
        name: 'late-predecessor-replay',
        legacy,
        workerd,
        compatibility,
        schemaManifest: schema,
        executionManifest,
        previous: append.output,
        replayBase: genesis,
        expectedPrevious: [later],
        replayFromIndex: 0,
        suffix: [earlier, later],
        target: [earlier, later],
        expectedPrivateSource: 'replayBase',
      })
      expect(replay.workerdOutcome.kind).toBe('completed')
      expect(replay.workerdRevision).toMatchObject({
        replayFromIndex: 0,
        replayedTransactions: 2,
        earliestChangedOrderIndex: 0,
      })
      expect(await balance(workerd)).toBe(5n)
      expect(workerd.outcome(later.txId)).toMatchObject({
        outcome: 'rejected_precondition',
        rejectionCode: 'EXPECTATION_MISMATCH',
      })
      expect(replay.workerdRevision.outcomeChanges).toContainEqual(expect.objectContaining({
        txId: later.txId,
        previous: 'accepted',
        current: 'rejected_precondition',
      }))
    } finally {
      legacy.close()
      workerd.close()
    }
  })
})

interface InputFixture {
  readonly input: MaterializationInput
  readonly manifestBytes: Uint8Array
}

interface StageOptions {
  readonly name: string
  readonly legacy: DeterministicMaterializer
  readonly workerd: DeterministicMaterializer
  readonly compatibility: ChronologCompatibilityTuple
  readonly schemaManifest: SchemaManifest
  readonly executionManifest: ReturnType<typeof createCoreExecutionManifest>
  readonly previous: InputFixture
  readonly replayBase: InputFixture
  readonly expectedPrevious: readonly AdmittedTransaction[]
  readonly replayFromIndex: number
  readonly suffix: readonly AdmittedTransaction[]
  readonly target: readonly AdmittedTransaction[]
  readonly expectedPrivateSource: 'previous' | 'replayBase'
}

interface StageResult {
  readonly output: InputFixture
  readonly workerdOutcome: ChronologMaterializationOutcome
  readonly workerdRevision: MaterializedRevision
}

async function runStage(options: StageOptions): Promise<StageResult> {
  const built = await differentialFixture(options)
  let legacyOutcome: ChronologMaterializationOutcome | null = null
  let legacyRevision: MaterializedRevision | null = null
  let workerdRevision: MaterializedRevision | null = null
  let response: ChronologExecutionResponse | null = null
  let host: RealDoltHost | null = null

  const legacyKernel = createDoltLitePortableKernel(options.legacy, async (projection) => {
    legacyRevision = requireRevision(projection)
    legacyOutcome = await projectOutcome(options.legacy, legacyRevision, projection)
    return legacyOutcome
  })
  const legacyBackend = createInProcessDifferentialBackend(
    'legacy-doltlite',
    legacyKernel,
    () => differentialObservation(options.legacy),
  )
  const workerdBackend = createChronologWorkerdDifferentialBackend('workerd-controller-doltlite', {
    compatibility: options.compatibility,
    clientForFixture(fixture) {
      return {
        async run(request): Promise<ChronologExecutionResponse> {
          host = new RealDoltHost(fixture, request.inputs, options.compatibility)
          const kernel = workerdKernel(options.workerd, host, (revision) => {
            workerdRevision = revision
          })
          const result = await runChronologWorkerdController(
            fixture.invocation,
            host.context,
            kernel,
          )
          response = { ...result, executionKey: request.executionKey.slice() }
          return response
        },
        async follow(): Promise<null> { return null },
      }
    },
    project: () => differentialObservation(options.workerd),
  })

  const observations = await runDifferentialFixture(built.fixture, [legacyBackend, workerdBackend])
  expect(observations.get('workerd-controller-doltlite'))
    .toEqual(observations.get('legacy-doltlite'))
  expect(legacyRevision).not.toBeNull()
  expect(workerdRevision).not.toBeNull()
  expect(normalizedRevision(workerdRevision!)).toEqual(normalizedRevision(legacyRevision!))
  expect(options.workerd.transactionLog()).toEqual(options.legacy.transactionLog())
  expect(await options.workerd.queryIr(balanceQuery(8_000)))
    .toEqual(await options.legacy.queryIr(balanceQuery(8_000)))
  expect(response).not.toBeNull()
  expect(host).not.toBeNull()
  expect(response!.exactReadSet).toEqual(built.fixture.objects.map((object) => object.ref))
  expect(host!.createdFrom).toEqual([options.expectedPrivateSource])
  expect('publish' in host!.context).toBe(false)
  expect(encodeMaterializationOutcome(decodeMaterializationOutcome(response!.applicationResult)))
    .toEqual(response!.applicationResult)
  expect(response!.applicationResult).toEqual(encodeMaterializationOutcome(legacyOutcome!))

  const output = response!.outputs.find((value) => value.name === 'materialized')
  const manifest = response!.artifacts.find((value) => value.name === 'materializationManifest')
  expect(output).toBeDefined()
  expect(manifest).toBeDefined()
  const manifestBytes = host!.artifactBytes(manifest!.ref)
  return {
    output: {
      input: { database: output!.ref, manifest: manifest!.ref },
      manifestBytes,
    },
    workerdOutcome: decodeMaterializationOutcome(response!.applicationResult),
    workerdRevision: workerdRevision!,
  }
}

function workerdKernel(
  materializer: DeterministicMaterializer,
  host: RealDoltHost,
  observeRevision: (revision: MaterializedRevision) => void,
): ChronologWorkerdDatabaseKernel<string, { readonly id: number }> {
  return {
    async materialize(input, context): Promise<ChronologMaterializationOutcome> {
      const portable = createDoltLitePortableKernel(materializer, async (projection) => {
        const revision = requireRevision(projection)
        observeRevision(revision)
        const previous = input.invocation.previous
        const sameBase = previous !== null && sameDatabase(
          previous.database,
          input.invocation.replayBase.database,
        )
        const from = sameBase ? 'previous' : 'replayBase'
        const privateOutput = await context.createPrivateOutput({
          name: 'materialized',
          from,
        })
        const outputDatabase = await databaseRef(
          materializer,
          genesisContentHash(materializer),
          revision.contentHash,
        )
        host.expectOutput(outputDatabase)
        const finalized = await context.finalizePrivateOutput({
          name: 'materialized',
          output: privateOutput,
        })
        const manifestBytes = snapshotManifestBytes(
          finalized,
          revision.revision,
          revision.orderLength,
          input.invocation.targetOrderDigest,
        )
        const materializationManifest = await context.writeTypedArtifact({
          selector: 'materializationManifest',
          kind: 'materialization-manifest',
          formatVersion: 1,
          canonicalBytes: manifestBytes,
        })
        const outcomeChanges = await context.writeTypedArtifact({
          selector: 'outcomeChanges',
          kind: 'outcome-changes',
          formatVersion: 1,
          canonicalBytes: outcomeChangesBytes(revision),
        })
        return {
          kind: 'completed',
          outputDatabase: finalized,
          materializationManifest,
          outcomeChanges,
          orderLength: revision.orderLength,
          orderDigest: input.invocation.targetOrderDigest,
          replayFromIndex: revision.replayFromIndex,
          stateDigest: finalized.stateDigest.contentId,
        }
      })
      return portable.materialize(input)
    },
  }
}

class RealDoltHost {
  readonly context: ChronologWorkerdHostContext<string, { readonly id: number }>
  readonly createdFrom: string[] = []
  readonly #artifactBytes = new Map<string, Uint8Array>()
  #expectedOutput: ExactDatabaseRef | null = null
  #nextOutput = 0

  constructor(
    fixture: DifferentialMaterializationFixture,
    inputs: readonly { readonly name: 'previous' | 'replayBase'; readonly ref: ExactDatabaseRef }[],
    compatibility: ChronologCompatibilityTuple,
  ) {
    const reader = createFixtureObjectReader(fixture)
    this.context = {
      compatibility,
      inputs: new Map(inputs.map((input) => [input.name, {
        name: input.name,
        ref: input.ref,
        database: `${input.name}-immutable`,
      }])),
      readExact(ref) { return reader.readExact(ref) },
      createPrivateOutput: async (request) => {
        this.createdFrom.push(request.from)
        return { id: ++this.#nextOutput }
      },
      writeTypedArtifact: async (request) => {
        const codec = request.selector === 'materializationManifest'
          ? MATERIALIZATION_MANIFEST_CODEC
          : OUTCOME_CHANGES_CODEC
        const ref = await artifactRef(request.kind, codec, request.canonicalBytes)
        this.#artifactBytes.set(objectIdentity(ref.object), request.canonicalBytes.slice())
        return ref
      },
      finalizePrivateOutput: async () => {
        if (this.#expectedOutput === null) throw new Error('TEST_OUTPUT_NOT_PROJECTED')
        return structuredClone(this.#expectedOutput)
      },
      checkpointPrivateOutput: async () => {
        throw new Error('TEST_CHECKPOINT_UNEXPECTED')
      },
    }
  }

  expectOutput(ref: ExactDatabaseRef): void {
    this.#expectedOutput = structuredClone(ref)
  }

  artifactBytes(ref: ExactArtifactRef): Uint8Array {
    const bytes = this.#artifactBytes.get(objectIdentity(ref.object))
    if (bytes === undefined) throw new Error('TEST_ARTIFACT_BYTES_MISSING')
    return bytes.slice()
  }
}

async function differentialFixture(options: StageOptions): Promise<{
  readonly fixture: DifferentialMaterializationFixture
  readonly invocation: ChronologMaterializationInvocation
}> {
  const targetOrderDigest = await digestAdmittedOrder(options.target.map((value) => value.txId))
  const suffix: ChronologAdmittedSuffix = {
    version: 1,
    groupId: digestBytes(1),
    replayFromIndex: options.replayFromIndex,
    targetOrderLength: options.target.length,
    targetOrderDigest,
    transactions: options.suffix,
  }
  const schemaBytes = encodeSchemaManifest(options.schemaManifest)
  const executionBytes = encodeExecutionManifest(options.executionManifest)
  const suffixBytes = encodeAdmittedSuffix(suffix)
  const schemaManifest = await artifactRef('schema-manifest', 0x4353_0001, schemaBytes)
  const executionManifest = await artifactRef('execution-manifest', 0x4345_0001, executionBytes)
  const admittedSuffix = await artifactRef('admitted-suffix', 0x4341_0001, suffixBytes)
  const invocation: ChronologMaterializationInvocation = {
    version: 1,
    profile: 'pure',
    context: { groupId: digestBytes(1), logicalTimeMs: null, entropySeed: null },
    previous: options.previous.input,
    replayBase: options.replayBase.input,
    admittedSuffix,
    schemaManifest,
    executionManifest,
    continuation: null,
    expectedEngineDigest: options.compatibility.engineDigest,
    expectedSchemaDigest: options.compatibility.schemaDigest,
    expectedExecutionManifestDigest: options.compatibility.executionManifestDigest,
    expectedPreviousOrderDigest: await digestAdmittedOrder(
      options.expectedPrevious.map((value) => value.txId),
    ),
    replayFromIndex: options.replayFromIndex,
    targetOrderLength: options.target.length,
    targetOrderDigest,
  }
  const objects = uniqueObjects([
    { ref: options.previous.input.manifest.object, bytes: options.previous.manifestBytes },
    { ref: options.replayBase.input.manifest.object, bytes: options.replayBase.manifestBytes },
    { ref: schemaManifest.object, bytes: schemaBytes },
    { ref: executionManifest.object, bytes: executionBytes },
    { ref: admittedSuffix.object, bytes: suffixBytes },
  ])
  return {
    invocation,
    fixture: {
      version: 1,
      name: options.name,
      invocation: encodeMaterializationInvocation(invocation),
      objects,
    },
  }
}

async function projectOutcome(
  materializer: DeterministicMaterializer,
  revision: MaterializedRevision,
  projection: DoltLitePortableProjectionContext,
): Promise<ChronologMaterializationOutcome> {
  const outputDatabase = await databaseRef(
    materializer,
    genesisContentHash(materializer),
    revision.contentHash,
  )
  const manifestBytes = snapshotManifestBytes(
    outputDatabase,
    revision.revision,
    revision.orderLength,
    projection.invocation.targetOrderDigest,
  )
  return {
    kind: 'completed',
    outputDatabase,
    materializationManifest: await artifactRef(
      'materialization-manifest',
      MATERIALIZATION_MANIFEST_CODEC,
      manifestBytes,
    ),
    outcomeChanges: await artifactRef(
      'outcome-changes',
      OUTCOME_CHANGES_CODEC,
      outcomeChangesBytes(revision),
    ),
    orderLength: revision.orderLength,
    orderDigest: projection.invocation.targetOrderDigest,
    replayFromIndex: revision.replayFromIndex,
    stateDigest: outputDatabase.stateDigest.contentId,
  }
}

async function differentialObservation(
  materializer: DeterministicMaterializer,
): Promise<DifferentialObservation> {
  const query = await materializer.queryIr(balanceQuery(9_000))
  const log = materializer.transactionLog()
  const orderDigest = await digestAdmittedOrder(log.map((row) => row.txId))
  return {
    version: 1,
    orderLength: log.length,
    orderDigest,
    stateDigest: { algorithm: 'sha2-256', digest: query.resultDigest.slice() },
    protectedLogDigest: await sha256(logBytes(log, true)),
    outcomeSetDigest: await sha256(logBytes(log, false)),
    queryResultDigest: query.resultDigest.slice(),
    rejectionAttributionDigest: await sha256(rejectionBytes(log)),
  }
}

async function databaseRef(
  materializer: DeterministicMaterializer,
  genesisHash: string,
  contentHash: string,
): Promise<ExactDatabaseRef> {
  // This test-only projection uses Dolt's immutable state hash as the portable
  // database hash until the real workerd CAS exporter assigns the generic ref.
  const query = await materializer.queryIr(balanceQuery(7_000))
  return {
    storeId: STORE_ID,
    doltFormatVersion: 1,
    canonicalGenesisCommit: doltChunk(genesisHash),
    commitHash: doltChunk(contentHash),
    stateDigest: {
      stateFormatVersion: 1,
      contentId: { algorithm: 'sha2-256', digest: query.resultDigest.slice() },
    },
  }
}

function genesisContentHash(materializer: DeterministicMaterializer): string {
  const genesis = materializer.checkpoints().find((value) => value.prefixLength === 0)
  if (genesis === undefined) throw new Error('TEST_GENESIS_CHECKPOINT_MISSING')
  return genesis.contentHash
}

function doltChunk(hash: string): ExactDatabaseRef['commitHash'] {
  return {
    doltFormatVersion: 1,
    contentId: { algorithm: 'dolt-blake3-160', digest: decodeDoltHex160(hash) },
  }
}

function decodeDoltHex160(hash: string): Uint8Array {
  // The pinned @dolthub/doltlite JS binding exposes DOLT_HASHOF_DB() as the
  // lowercase hexadecimal encoding of its 20-byte value. It is not the Noms
  // base32 text representation used by some other Dolt surfaces.
  if (!/^[0-9a-f]{40}$/u.test(hash)) throw new Error(`TEST_DOLT_HEX160_INVALID:${hash}`)
  const digest = hexToBytes(hash)
  if (digest.length !== 20) throw new Error('TEST_DOLT_HEX160_LENGTH_INVALID')
  return digest
}

async function artifactRef(
  kind: ExactArtifactRef['kind'],
  codec: number,
  canonicalBytes: Uint8Array,
): Promise<ExactArtifactRef> {
  return {
    kind,
    formatVersion: 1,
    object: {
      storeId: STORE_ID,
      codec: { number: codec, version: 1 },
      contentId: { algorithm: 'sha2-256', digest: await sha256(canonicalBytes) },
    },
  }
}

function snapshotManifestBytes(
  database: ExactDatabaseRef,
  revision: bigint,
  orderLength: number,
  orderDigest: Uint8Array,
): Uint8Array {
  return encodeCanonicalCbor(integerMap([
    [0, 1n],
    [1, exactDatabaseRefToCbor(database)],
    [2, revision],
    [3, BigInt(orderLength)],
    [4, orderDigest],
  ]))
}

function outcomeChangesBytes(revision: MaterializedRevision): Uint8Array {
  return encodeCanonicalCbor(revision.outcomeChanges.map((change) => integerMap([
    [0, change.txId],
    [1, change.previous],
    [2, change.current],
    [3, change.previousRejectionCode],
    [4, change.currentRejectionCode],
  ])))
}

function logBytes(log: readonly TransactionLogRow[], includeCandidate: boolean): Uint8Array {
  return encodeCanonicalCbor(log.map((row) => integerMap([
    [0, row.txId],
    [1, BigInt(row.orderIndex)],
    [2, row.outcome],
    [3, row.rejectionCode],
    [4, includeCandidate ? row.canonicalCandidate : undefined],
    [5, row.resultDigest],
  ])))
}

function rejectionBytes(log: readonly TransactionLogRow[]): Uint8Array {
  return encodeCanonicalCbor(log.map((row) => integerMap([
    [0, row.txId],
    [1, row.rejectionCode],
    [2, nullableInteger(row.failingPreconditionId)],
    [3, nullableInteger(row.failingCommandId)],
    [4, nullableInteger(row.failingRuleId)],
    [5, nullableInteger(row.failingConstraintId)],
  ])))
}

function nullableInteger(value: number | null): CborValue {
  return value === null ? null : BigInt(value)
}

function requireRevision(projection: DoltLitePortableProjectionContext): MaterializedRevision {
  if (projection.revision === null) throw new Error('TEST_MATERIALIZATION_UNCHANGED')
  return projection.revision
}

function normalizedRevision(revision: MaterializedRevision): object {
  return {
    ...revision,
    schemaDigest: revision.schemaDigest.slice(),
    manifestDigest: revision.manifestDigest.slice(),
    outcomeChanges: revision.outcomeChanges.map((change) => structuredClone(change)),
  }
}

function uniqueObjects(
  objects: readonly { readonly ref: ExactObjectRef; readonly bytes: Uint8Array }[],
): readonly { readonly ref: ExactObjectRef; readonly bytes: Uint8Array }[] {
  const sorted = [...objects].sort((left, right) => compareObjectRefs(left.ref, right.ref))
  return sorted.filter((object, index) => {
    if (index === 0 || compareObjectRefs(sorted[index - 1]!.ref, object.ref) !== 0) return true
    if (!sameBytes(sorted[index - 1]!.bytes, object.bytes)) throw new Error('TEST_OBJECT_ALIAS')
    return false
  })
}

function objectIdentity(ref: ExactObjectRef): string {
  return [
    Array.from(ref.storeId).join('.'),
    ref.codec.number,
    ref.codec.version,
    ref.contentId.algorithm,
    Array.from(ref.contentId.digest).join('.'),
  ].join(':')
}

function sameDatabase(left: ExactDatabaseRef, right: ExactDatabaseRef): boolean {
  return sameBytes(
    encodeCanonicalCbor(exactDatabaseRefToCbor(left)),
    encodeCanonicalCbor(exactDatabaseRefToCbor(right)),
  )
}

async function openMaterializer(
  name: string,
  executionManifest: ReturnType<typeof createCoreExecutionManifest>,
): Promise<DeterministicMaterializer> {
  const directory = await mkdtemp(join(tmpdir(), `chronolog-workerd-${name}-`))
  temporaryDirectories.push(directory)
  return DeterministicMaterializer.open({
    path: join(directory, 'state.db'),
    schemaManifest: schema,
    executionManifest,
    checkpointEvery: 1,
  })
}

function literal(id: number, value: Extract<Expr, { kind: 'literal' }>['value']): Expr {
  return { kind: 'literal', id, value }
}

function balanceQuery(base: number): Query {
  return {
    id: base,
    ctes: [],
    from: { kind: 'table', id: base + 1, name: 'accounts', alias: 'account' },
    joins: [],
    where: {
      kind: 'binary',
      id: base + 2,
      operator: 'eq',
      left: { kind: 'column', id: base + 3, relation: 'account', name: 'id' },
      right: literal(base + 4, { kind: 'int64', value: 1n }),
    },
    groupBy: [],
    projection: [{
      id: base + 5,
      name: 'balance',
      expression: { kind: 'column', id: base + 6, relation: 'account', name: 'balance' },
    }],
    windows: [],
    compounds: [],
    orderBy: [],
    resultMode: { kind: 'scalar' },
  }
}

function expectBalance(base: number, expected: bigint): Precondition {
  return {
    kind: 'expect',
    id: base,
    query: balanceQuery(base + 1),
    expected: {
      kind: 'inline',
      result: {
        resultMode: { kind: 'scalar' },
        columns: [{
          id: base + 6,
          name: 'balance',
          valueType: { logical: { kind: 'int64' }, nullable: false },
        }],
        rows: [[{ kind: 'int64', value: expected }]],
      },
    },
  }
}

function truePrecondition(base: number): Precondition {
  return {
    kind: 'assert',
    id: base,
    query: {
      id: base + 1,
      ctes: [],
      joins: [],
      groupBy: [],
      projection: [{
        id: base + 2,
        name: 'ok',
        expression: literal(base + 3, { kind: 'boolean', value: true }),
      }],
      windows: [],
      compounds: [],
      orderBy: [],
      resultMode: { kind: 'scalar' },
    },
    unknownIsFailure: true,
  }
}

function setBalance(base: number, value: bigint): Mutation {
  return {
    kind: 'update',
    id: base,
    target: { kind: 'name', name: 'accounts' },
    affectedRows: { kind: 'exactly', count: 1n },
    assignments: [{ column: 'balance', value: literal(base + 1, { kind: 'int64', value }) }],
    where: {
      kind: 'binary',
      id: base + 2,
      operator: 'eq',
      left: { kind: 'column', id: base + 3, name: 'id' },
      right: literal(base + 4, { kind: 'int64', value: 1n }),
    },
  }
}

async function transaction(
  id: number,
  timestamp: bigint,
  mutations: readonly Mutation[],
  preconditions: readonly Precondition[],
  compatibility: ChronologCompatibilityTuple,
): Promise<AdmittedTransaction> {
  const core: TransactionCore = {
    groupId: digestBytes(1),
    membershipRevision: digestBytes(2),
    validationPolicy: digestBytes(3),
    authorId: digestBytes(7),
    authorTimestampMs: timestamp,
    nonce: Uint8Array.from({ length: 16 }, (_value, index) => (id + index) & 0xff),
    executionManifestDigest: compatibility.executionManifestDigest,
    schemaDigest: compatibility.schemaDigest,
    program: { preconditions, mutations },
  }
  const canonicalCandidate = encodeTransactionCore(core)
  return {
    txId: Uint8Array.of(id),
    authorFeedSequence: BigInt(id),
    candidateDigest: await transactionDigest(canonicalCandidate),
    canonicalCandidate,
    core,
  }
}

function digestBytes(seed: number): Uint8Array {
  return Uint8Array.from({ length: 32 }, (_value, index) => (seed + index) & 0xff)
}

async function balance(materializer: DeterministicMaterializer): Promise<bigint> {
  const result = await materializer.queryIr(balanceQuery(6_000))
  const value = result.result.rows[0]?.[0]
  if (value?.kind !== 'int64') throw new Error('TEST_BALANCE_NOT_INT64')
  return value.value
}
