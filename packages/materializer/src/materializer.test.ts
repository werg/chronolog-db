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
import { encodeTransactionCore, transactionDigest, type TransactionCore } from '@chronolog/protocol'
import { describe, expect, it } from 'vitest'

import {
  decodeAdmittedSuffix,
  decodeDifferentialFixture,
  decodeMaterializationInvocation,
  decodeMaterializationOutcome,
  digestAdmittedOrder,
  encodeAdmittedSuffix,
  encodeDifferentialFixture,
  encodeMaterializationInvocation,
  encodeMaterializationOutcome,
  sameBytes,
} from './codec.js'
import {
  createFixtureObjectReader,
  createInProcessDifferentialBackend,
  DifferentialMismatchError,
  runDifferentialFixture,
} from './differential.js'
import { resolveMaterializationInvocation, runMaterializationInvocation } from './runner.js'
import type {
  ChronologAdmittedSuffix,
  ChronologMaterializationInvocation,
  ChronologMaterializationOutcome,
  DifferentialMaterializationFixture,
  DifferentialObservation,
  ExactArtifactRef,
  ExactDatabaseRef,
  ExactObjectRef,
} from './types.js'

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

async function fixture(): Promise<{
  readonly fixture: DifferentialMaterializationFixture
  readonly invocation: ChronologMaterializationInvocation
  readonly outcome: ChronologMaterializationOutcome
}> {
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
  const schemaRef = await artifact('schema-manifest', 101, schemaBytes)
  const executionRef = await artifact('execution-manifest', 102, executionBytes)
  const suffixRef = await artifact('admitted-suffix', 103, suffixBytes)
  const baseManifestRef = await artifact('materialization-manifest', 104, baseManifestBytes)
  const invocation: ChronologMaterializationInvocation = {
    version: 1,
    profile: 'pure',
    context: { groupId: bytes(7, 32), logicalTimeMs: null, entropySeed: null },
    previous: null,
    replayBase: { manifest: baseManifestRef, database: database(2) },
    admittedSuffix: suffixRef,
    schemaManifest: schemaRef,
    executionManifest: executionRef,
    continuation: null,
    expectedEngineDigest: execution.engineDigest,
    expectedSchemaDigest: await digestSchemaManifest(schema),
    expectedExecutionManifestDigest: await digestExecutionManifest(execution),
    expectedPreviousOrderDigest: await digestAdmittedOrder([]),
    replayFromIndex: 0,
    targetOrderLength: 1,
    targetOrderDigest,
  }
  const outputManifestBytes = Uint8Array.of(0xa1, 0x00, 0x02)
  const outcomeChangesBytes = Uint8Array.of(0x80)
  const outcome: ChronologMaterializationOutcome = {
    kind: 'completed',
    outputDatabase: database(3),
    materializationManifest: await artifact('materialization-manifest', 105, outputManifestBytes),
    outcomeChanges: await artifact('outcome-changes', 106, outcomeChangesBytes),
    orderLength: 1,
    orderDigest: targetOrderDigest,
    replayFromIndex: 0,
    stateDigest: database(3).stateDigest.contentId,
  }
  return {
    fixture: {
      version: 1,
      name: 'append-one',
      invocation: encodeMaterializationInvocation(invocation),
      objects: [
        { ref: baseManifestRef.object, bytes: baseManifestBytes },
        { ref: suffixRef.object, bytes: suffixBytes },
        { ref: schemaRef.object, bytes: schemaBytes },
        { ref: executionRef.object, bytes: executionBytes },
      ],
    },
    invocation,
    outcome,
  }
}

function observation(stateSeed: number): DifferentialObservation {
  return {
    version: 1,
    orderLength: 1,
    orderDigest: bytes(1, 32),
    stateDigest: { algorithm: 'dolt-blake3-160', digest: bytes(stateSeed, 20) },
    protectedLogDigest: bytes(2, 32),
    outcomeSetDigest: bytes(3, 32),
    queryResultDigest: bytes(4, 32),
    rejectionAttributionDigest: bytes(5, 32),
  }
}

describe('portable Chronolog materializer contract', () => {
  it('round-trips canonical invocation, suffix, outcome, and fixture bytes', async () => {
    const built = await fixture()
    expect(decodeMaterializationInvocation(encodeMaterializationInvocation(built.invocation)))
      .toEqual(built.invocation)
    const suffixBytes = built.fixture.objects.find((object) => object.ref.codec.number === 103)?.bytes
    expect(suffixBytes).toBeDefined()
    expect(encodeAdmittedSuffix(decodeAdmittedSuffix(suffixBytes!))).toEqual(suffixBytes)
    expect(decodeMaterializationOutcome(encodeMaterializationOutcome(built.outcome))).toEqual(built.outcome)
    const canonicalFixture = encodeDifferentialFixture(built.fixture)
    expect(encodeDifferentialFixture(decodeDifferentialFixture(canonicalFixture))).toEqual(canonicalFixture)
  })

  it('resolves only declared exact objects and rejects ambient pure context', async () => {
    const built = await fixture()
    const read: ExactObjectRef[] = []
    const delegate = createFixtureObjectReader(built.fixture)
    const resolved = await resolveMaterializationInvocation(built.fixture.invocation, {
      async readExact(ref): Promise<Uint8Array> {
        read.push(ref)
        return delegate.readExact(ref)
      },
    })
    expect(read).toHaveLength(4)
    expect(resolved.exactReadSet).toHaveLength(4)
    expect(resolved.admittedSuffix.transactions[0]?.core.authorTimestampMs).toBe(42n)

    const invalid = {
      ...built.invocation,
      context: { ...built.invocation.context, logicalTimeMs: 1n },
    }
    expect(() => encodeMaterializationInvocation(invalid)).toThrow(/forbids logical time/)
  })

  it('runs through a host-agnostic kernel and catches exact-object corruption', async () => {
    const built = await fixture()
    let called = false
    const result = await runMaterializationInvocation(
      built.fixture.invocation,
      createFixtureObjectReader(built.fixture),
      {
        async materialize(input): Promise<ChronologMaterializationOutcome> {
          called = true
          expect(input.invocation.context.logicalTimeMs).toBeNull()
          expect(input.invocation.context.entropySeed).toBeNull()
          return built.outcome
        },
      },
    )
    expect(called).toBe(true)
    expect(result).toEqual(built.outcome)

    const corrupted = {
      ...built.fixture,
      objects: built.fixture.objects.map((object, index) => index === 0
        ? { ...object, bytes: Uint8Array.of(...object.bytes, 0) }
        : object),
    }
    await expect(createFixtureObjectReader(corrupted).readExact(corrupted.objects[0]!.ref))
      .rejects.toThrow('DIFFERENTIAL_EXACT_OBJECT_DIGEST_MISMATCH')
  })

  it('provides one canonical differential fixture to independent backends', async () => {
    const built = await fixture()
    const kernel = { async materialize(): Promise<ChronologMaterializationOutcome> { return built.outcome } }
    const left = createInProcessDifferentialBackend('node-oracle', kernel, () => observation(9))
    const right = createInProcessDifferentialBackend('workerd', kernel, () => observation(9))
    const results = await runDifferentialFixture(built.fixture, [left, right])
    expect(results.size).toBe(2)
    expect(sameBytes(results.get('node-oracle')!.stateDigest.digest, bytes(9, 20))).toBe(true)

    const mismatch = createInProcessDifferentialBackend('mismatch', kernel, () => observation(10))
    await expect(runDifferentialFixture(built.fixture, [left, mismatch]))
      .rejects.toBeInstanceOf(DifferentialMismatchError)
  })
})
