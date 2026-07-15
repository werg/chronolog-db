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
  createFixtureObjectReader,
  digestAdmittedOrder,
  encodeAdmittedSuffix,
  encodeDifferentialFixture,
  encodeMaterializationInvocation,
  runDifferentialFixture,
  type ChronologAdmittedSuffix,
  type ChronologMaterializationInvocation,
  type ChronologMaterializationOutcome,
  type DifferentialMaterializationFixture,
  type DifferentialObservation,
  type ExactArtifactRef,
  type ExactDatabaseRef,
} from '@chronolog/materializer'
import { encodeTransactionCore, transactionDigest, type TransactionCore } from '@chronolog/protocol'
import { describe, expect, it } from 'vitest'

import {
  ChronologWorkerdContractError,
  createChronologExecutionRequest,
  createChronologPublicationRequest,
  createChronologWorkerdDifferentialBackend,
  executeChronologMaterialization,
  runChronologWorkerdController,
  type ChronologCompatibilityTuple,
  type ChronologExecutionResponse,
  type ChronologReducerCoordinatorClient,
  type ChronologWorkerdDatabaseKernel,
  type ChronologWorkerdHostContext,
} from './index.js'

const bytes = (value: number, length: number): Uint8Array => new Uint8Array(length).fill(value)

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

async function transaction(): Promise<ChronologAdmittedSuffix['transactions'][number]> {
  const manifest = portableExecutionManifestFixture()
  const schema = portableSchemaManifestFixture()
  const core: TransactionCore = {
    groupId: bytes(7, 32),
    membershipRevision: bytes(8, 32),
    validationPolicy: bytes(9, 32),
    authorId: bytes(10, 32),
    authorTimestampMs: 42n,
    nonce: bytes(11, 16),
    executionManifestDigest: await digestExecutionManifest(manifest),
    schemaDigest: await digestSchemaManifest(schema),
    program: portableTransactionProgramFixture(),
  }
  const canonicalCandidate = encodeTransactionCore(core)
  return {
    txId: bytes(12, 16),
    authorFeedSequence: 4n,
    candidateDigest: await transactionDigest(canonicalCandidate),
    canonicalCandidate,
    core,
  }
}

interface BuiltFixture {
  readonly fixture: DifferentialMaterializationFixture
  readonly invocation: ChronologMaterializationInvocation
  readonly compatibility: ChronologCompatibilityTuple
}

async function fixture(withPrevious = false, append = false): Promise<BuiltFixture> {
  const schema = portableSchemaManifestFixture()
  const execution = portableExecutionManifestFixture()
  const tx = await transaction()
  const targetOrderDigest = await digestAdmittedOrder([tx.txId])
  const admittedSuffix: ChronologAdmittedSuffix = {
    version: 1,
    groupId: bytes(7, 32),
    replayFromIndex: 0,
    targetOrderLength: 1,
    targetOrderDigest,
    transactions: [tx],
  }
  const schemaBytes = encodeSchemaManifest(schema)
  const executionBytes = encodeExecutionManifest(execution)
  const suffixBytes = encodeAdmittedSuffix(admittedSuffix)
  const baseManifestBytes = Uint8Array.of(0xa1, 0x00, 0x01)
  const previousManifestBytes = Uint8Array.of(0xa1, 0x00, 0x02)
  const schemaRef = await artifact('schema-manifest', 101, schemaBytes)
  const executionRef = await artifact('execution-manifest', 102, executionBytes)
  const suffixRef = await artifact('admitted-suffix', 103, suffixBytes)
  const baseManifestRef = await artifact('materialization-manifest', 104, baseManifestBytes)
  const previousManifestRef = await artifact('materialization-manifest', 105, previousManifestBytes)
  const previous = withPrevious
    ? append
      ? { manifest: baseManifestRef, database: database(2) }
      : { manifest: previousManifestRef, database: database(4) }
    : null
  const compatibility = {
    engineDigest: execution.engineDigest,
    schemaDigest: await digestSchemaManifest(schema),
    executionManifestDigest: await digestExecutionManifest(execution),
  }
  const invocation: ChronologMaterializationInvocation = {
    version: 1,
    profile: 'pure',
    context: { groupId: bytes(7, 32), logicalTimeMs: null, entropySeed: null },
    previous,
    replayBase: { manifest: baseManifestRef, database: database(2) },
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
  }
  return {
    fixture: {
      version: 1,
      name: withPrevious && !append ? 'insert-predecessor' : 'append-one',
      invocation: encodeMaterializationInvocation(invocation),
      objects: [
        { ref: baseManifestRef.object, bytes: baseManifestBytes },
        ...(withPrevious && !append
          ? [{ ref: previousManifestRef.object, bytes: previousManifestBytes }]
          : []),
        { ref: suffixRef.object, bytes: suffixBytes },
        { ref: schemaRef.object, bytes: schemaBytes },
        { ref: executionRef.object, bytes: executionBytes },
      ],
    },
    invocation,
    compatibility,
  }
}

interface HostLog {
  reads: number
  creates: string[]
  artifacts: string[]
  finalizes: number
  checkpoints: number
}

async function makeHost(
  built: BuiltFixture,
  outputDatabase: ExactDatabaseRef,
  options: { readonly omitReplay?: boolean; readonly replayRef?: ExactDatabaseRef } = {},
): Promise<{
  readonly host: ChronologWorkerdHostContext<string, { readonly id: number }>
  readonly log: HostLog
}> {
  const reader = createFixtureObjectReader(built.fixture)
  const inputs = new Map()
  if (!options.omitReplay) {
    inputs.set('replayBase', {
      name: 'replayBase',
      ref: options.replayRef ?? built.invocation.replayBase.database,
      database: 'replay-base-handle',
    })
  }
  if (built.invocation.previous !== null) {
    inputs.set('previous', {
      name: 'previous',
      ref: built.invocation.previous.database,
      database: 'previous-handle',
    })
  }
  const log: HostLog = { reads: 0, creates: [], artifacts: [], finalizes: 0, checkpoints: 0 }
  let outputId = 0
  const host: ChronologWorkerdHostContext<string, { readonly id: number }> = {
    compatibility: built.compatibility,
    inputs,
    async readExact(ref): Promise<Uint8Array> {
      log.reads++
      return reader.readExact(ref)
    },
    async createPrivateOutput(request): Promise<{ readonly id: number }> {
      log.creates.push(request.from)
      return { id: ++outputId }
    },
    async writeTypedArtifact(request): Promise<ExactArtifactRef> {
      log.artifacts.push(request.selector)
      const codec = request.selector === 'materializationManifest' ? 201
        : request.selector === 'outcomeChanges' ? 202 : 203
      return artifact(request.kind, codec, request.canonicalBytes)
    },
    async finalizePrivateOutput(): Promise<ExactDatabaseRef> {
      log.finalizes++
      return outputDatabase
    },
    async checkpointPrivateOutput(): Promise<ExactDatabaseRef> {
      log.checkpoints++
      return outputDatabase
    },
  }
  return { host, log }
}

function completionKernel(
  from: 'previous' | 'replayBase',
  outputOverride?: ExactDatabaseRef,
): ChronologWorkerdDatabaseKernel<string, { readonly id: number }> {
  return {
    async materialize(input, context): Promise<ChronologMaterializationOutcome> {
      expect('has' in context).toBe(false)
      expect('publish' in context).toBe(false)
      await context.readExact(input.invocation.admittedSuffix.object)
      const output = await context.createPrivateOutput({ name: 'materialized', from })
      const materializationManifest = await context.writeTypedArtifact({
        selector: 'materializationManifest',
        kind: 'materialization-manifest',
        formatVersion: 1,
        canonicalBytes: Uint8Array.of(0xa1, 0x00, 0x03),
      })
      const outcomeChanges = await context.writeTypedArtifact({
        selector: 'outcomeChanges',
        kind: 'outcome-changes',
        formatVersion: 1,
        canonicalBytes: Uint8Array.of(0x80),
      })
      const outputDatabase = await context.finalizePrivateOutput({ name: 'materialized', output })
      return {
        kind: 'completed',
        outputDatabase: outputOverride ?? outputDatabase,
        materializationManifest,
        outcomeChanges,
        orderLength: input.invocation.targetOrderLength,
        orderDigest: input.invocation.targetOrderDigest,
        replayFromIndex: input.invocation.replayFromIndex,
        stateDigest: (outputOverride ?? outputDatabase).stateDigest.contentId,
      }
    },
  }
}

function checkpointKernel(): ChronologWorkerdDatabaseKernel<string, { readonly id: number }> {
  return {
    async materialize(input, context): Promise<ChronologMaterializationOutcome> {
      const output = await context.createPrivateOutput({ name: 'materialized', from: 'replayBase' })
      const continuation = await context.writeTypedArtifact({
        selector: 'continuation',
        kind: 'continuation',
        formatVersion: 1,
        canonicalBytes: Uint8Array.of(0xa1, 0x00, 0x01),
      })
      const partialDatabase = await context.checkpointPrivateOutput({
        selector: 'checkpoint',
        output,
        nextOrderIndex: 1,
      })
      return {
        kind: 'checkpointed',
        partialDatabase,
        continuation,
        nextOrderIndex: 1,
        prefixOrderDigest: input.invocation.targetOrderDigest,
      }
    },
  }
}

describe('Chronolog workerd controller', () => {
  it('completes append materialization with exact reads and no ambient CAS or publication API', async () => {
    const built = await fixture(true, true)
    const made = await makeHost(built, database(20))
    const result = await runChronologWorkerdController(
      built.fixture.invocation,
      made.host,
      completionKernel('previous'),
    )
    expect(result.outputs.map((value) => value.name)).toEqual(['materialized'])
    expect(result.artifacts.map((value) => value.name))
      .toEqual(['materializationManifest', 'outcomeChanges'])
    expect(result.exactReadSet).toHaveLength(4)
    expect(made.log.reads).toBe(5)
    expect(made.log.creates).toEqual(['previous'])
    expect(made.log.finalizes).toBe(1)
  })

  it('uses replayBase for predecessor insertion even when previous is supplied', async () => {
    const built = await fixture(true)
    const made = await makeHost(built, database(21))
    await runChronologWorkerdController(built.fixture.invocation, made.host,
      completionKernel('replayBase'))
    expect(made.log.creates).toEqual(['replayBase'])
    expect(made.log.reads).toBe(6)
  })

  it('rejects missing or mismatched named refs before kernel or mutation', async () => {
    const built = await fixture()
    for (const options of [{ omitReplay: true }, { replayRef: database(99) }]) {
      const made = await makeHost(built, database(22), options)
      let kernelCalls = 0
      const kernel: ChronologWorkerdDatabaseKernel<string, { readonly id: number }> = {
        async materialize(): Promise<ChronologMaterializationOutcome> {
          kernelCalls++
          throw new Error('unreachable')
        },
      }
      await expect(runChronologWorkerdController(built.fixture.invocation, made.host, kernel))
        .rejects.toBeInstanceOf(ChronologWorkerdContractError)
      expect(kernelCalls).toBe(0)
      expect(made.log.reads).toBe(0)
      expect(made.log.creates).toEqual([])
      expect(made.log.artifacts).toEqual([])
    }
  })

  it('returns canonical checkpoint selectors', async () => {
    const built = await fixture()
    const made = await makeHost(built, database(23))
    const result = await runChronologWorkerdController(
      built.fixture.invocation,
      made.host,
      checkpointKernel(),
    )
    expect(result.outputs.map((value) => value.name)).toEqual(['checkpoint'])
    expect(result.artifacts.map((value) => value.name)).toEqual(['continuation'])
    expect(made.log.checkpoints).toBe(1)
    expect(made.log.finalizes).toBe(0)
  })

  it('rejects a compatibility mismatch before reads, kernel, or mutation', async () => {
    const built = await fixture()
    const made = await makeHost(built, database(23))
    made.host.compatibility.engineDigest[0] = made.host.compatibility.engineDigest[0]! ^ 0xff
    let kernelCalls = 0
    const kernel: ChronologWorkerdDatabaseKernel<string, { readonly id: number }> = {
      async materialize(): Promise<ChronologMaterializationOutcome> {
        kernelCalls++
        throw new Error('unreachable')
      },
    }
    await expect(runChronologWorkerdController(built.fixture.invocation, made.host, kernel))
      .rejects.toMatchObject({ code: 'CHRONOLOG_ENGINE_COMPATIBILITY_MISMATCH' })
    expect(kernelCalls).toBe(0)
    expect(made.log).toMatchObject({
      reads: 0,
      creates: [],
      artifacts: [],
      finalizes: 0,
      checkpoints: 0,
    })
  })

  it('allows unchanged to reuse only the selected input manifest', async () => {
    const built = await fixture()
    const made = await makeHost(built, database(23))
    const unchanged = (manifest: ExactArtifactRef): ChronologWorkerdDatabaseKernel<string, { readonly id: number }> => ({
      async materialize(input): Promise<ChronologMaterializationOutcome> {
        return {
          kind: 'unchanged',
          outputDatabase: input.invocation.replayBase.database,
          materializationManifest: manifest,
          orderLength: input.invocation.targetOrderLength,
          orderDigest: input.invocation.targetOrderDigest,
          stateDigest: input.invocation.replayBase.database.stateDigest.contentId,
        }
      },
    })
    const result = await runChronologWorkerdController(
      built.fixture.invocation,
      made.host,
      unchanged(built.invocation.replayBase.manifest),
    )
    expect(result.artifacts).toEqual([
      { name: 'materializationManifest', ref: built.invocation.replayBase.manifest },
    ])
    const substituted = await artifact('materialization-manifest', 299, Uint8Array.of(0x80))
    await expect(runChronologWorkerdController(
      built.fixture.invocation,
      made.host,
      unchanged(substituted),
    )).rejects.toMatchObject({ code: 'CHRONOLOG_UNCHANGED_MANIFEST_SUBSTITUTION' })
  })

  it('rejects a kernel substituting an output after finalize', async () => {
    const built = await fixture()
    const made = await makeHost(built, database(24))
    await expect(runChronologWorkerdController(
      built.fixture.invocation,
      made.host,
      completionKernel('replayBase', database(25)),
    )).rejects.toMatchObject({ code: 'CHRONOLOG_OUTPUT_DATABASE_SUBSTITUTION' })
  })
})

describe('Chronolog standard coordinator', () => {
  it('uses one deterministic key and follows an ambiguous run without publishing', async () => {
    const built = await fixture()
    const made = await makeHost(built, database(30))
    const pure = await runChronologWorkerdController(
      built.fixture.invocation,
      made.host,
      completionKernel('replayBase'),
    )
    let retained: ChronologExecutionResponse | null = null
    let runCalls = 0
    let followCalls = 0
    const client: ChronologReducerCoordinatorClient = {
      async run(request): Promise<ChronologExecutionResponse> {
        runCalls++
        retained = { ...pure, executionKey: request.executionKey }
        throw new Error('ambiguous transport failure')
      },
      async follow(executionKey): Promise<ChronologExecutionResponse | null> {
        followCalls++
        expect(executionKey).toEqual(retained?.executionKey)
        return retained
      },
    }
    const args = {
      invocation: built.fixture.invocation,
      inputs: [{ name: 'replayBase' as const, ref: built.invocation.replayBase.database }],
      compatibility: built.compatibility,
    }
    const [requestA, requestB] = await Promise.all([
      createChronologExecutionRequest(args),
      createChronologExecutionRequest(args),
    ])
    expect(requestA.executionKey).toEqual(requestB.executionKey)
    const response = await executeChronologMaterialization(client, args)
    expect(response.executionKey).toEqual(requestA.executionKey)
    expect(runCalls).toBe(1)
    expect(followCalls).toBe(1)
    expect('publish' in client).toBe(false)

    const publication = createChronologPublicationRequest(response, 'groups/7/head', null)
    expect(publication.selectedOutput.name).toBe('materialized')
    expect(publication.refName).toBe('groups/7/head')
  })

  it('rejects transport output substitution', async () => {
    const built = await fixture()
    const made = await makeHost(built, database(31))
    const pure = await runChronologWorkerdController(
      built.fixture.invocation,
      made.host,
      completionKernel('replayBase'),
    )
    const client: ChronologReducerCoordinatorClient = {
      async run(request): Promise<ChronologExecutionResponse> {
        return {
          ...pure,
          executionKey: request.executionKey,
          outputs: [{ name: 'materialized', ref: database(32) }],
        }
      },
      async follow(): Promise<null> { return null },
    }
    await expect(executeChronologMaterialization(client, {
      invocation: built.fixture.invocation,
      inputs: [{ name: 'replayBase', ref: built.invocation.replayBase.database }],
      compatibility: built.compatibility,
    })).rejects.toMatchObject({ code: 'CHRONOLOG_OUTPUT_SUBSTITUTION' })
  })

  it('rejects reordered selectors and snapshots publication intent', async () => {
    const built = await fixture()
    const made = await makeHost(built, database(33))
    const pure = await runChronologWorkerdController(
      built.fixture.invocation,
      made.host,
      completionKernel('replayBase'),
    )
    const request = await createChronologExecutionRequest({
      invocation: built.fixture.invocation,
      inputs: [{ name: 'replayBase', ref: built.invocation.replayBase.database }],
      compatibility: built.compatibility,
    })
    const reordered: ChronologExecutionResponse = {
      ...pure,
      executionKey: request.executionKey,
      artifacts: [...pure.artifacts].reverse(),
    }
    const client: ChronologReducerCoordinatorClient = {
      async run(): Promise<ChronologExecutionResponse> { return reordered },
      async follow(): Promise<null> { return null },
    }
    await expect(executeChronologMaterialization(client, {
      invocation: built.fixture.invocation,
      inputs: request.inputs,
      compatibility: built.compatibility,
    })).rejects.toMatchObject({ code: 'CHRONOLOG_ARTIFACT_SUBSTITUTION' })

    const response: ChronologExecutionResponse = { ...pure, executionKey: request.executionKey.slice() }
    const expectedCurrent = database(34)
    const publication = createChronologPublicationRequest(response, 'groups/7/head', expectedCurrent)
    const executionByte = publication.executionKey[0]
    const outputByte = publication.selectedOutput.ref.commitHash.contentId.digest[0]
    const expectedByte = publication.expectedCurrent?.commitHash.contentId.digest[0]
    response.executionKey[0] = response.executionKey[0]! ^ 0xff
    const responseDigest = response.outputs[0]!.ref.commitHash.contentId.digest
    responseDigest[0] = responseDigest[0]! ^ 0xff
    const expectedDigest = expectedCurrent.commitHash.contentId.digest
    expectedDigest[0] = expectedDigest[0]! ^ 0xff
    expect(publication.executionKey[0]).toBe(executionByte)
    expect(publication.selectedOutput.ref.commitHash.contentId.digest[0]).toBe(outputByte)
    expect(publication.expectedCurrent?.commitHash.contentId.digest[0]).toBe(expectedByte)
  })
})

describe('Chronolog workerd differential backend', () => {
  it('plugs into the existing canonical fixture runner', async () => {
    const built = await fixture()
    const observation: DifferentialObservation = {
      version: 1,
      orderLength: 1,
      orderDigest: bytes(41, 32),
      stateDigest: { algorithm: 'dolt-blake3-160', digest: bytes(42, 20) },
      protectedLogDigest: bytes(43, 32),
      outcomeSetDigest: bytes(44, 32),
      queryResultDigest: bytes(45, 32),
      rejectionAttributionDigest: bytes(46, 32),
    }
    const backend = createChronologWorkerdDifferentialBackend('workerd-contract', {
      compatibility: built.compatibility,
      clientForFixture(received) {
        return {
          async run(request): Promise<ChronologExecutionResponse> {
            const localBuilt = { ...built, fixture: received }
            const made = await makeHost(localBuilt, database(40))
            const result = await runChronologWorkerdController(
              received.invocation,
              made.host,
              completionKernel('replayBase'),
            )
            return { ...result, executionKey: request.executionKey }
          },
          async follow(): Promise<null> { return null },
        }
      },
      project: () => observation,
    })
    const results = await runDifferentialFixture(built.fixture, [backend])
    expect(results.get('workerd-contract')).toEqual(observation)
    expect(encodeDifferentialFixture(built.fixture)).toBeInstanceOf(Uint8Array)
  })
})
