import {
  digestAdmittedOrder,
  type ChronologMaterializationInvocation,
  type ChronologMaterializationOutcome,
  type ExactArtifactRef,
  type ExactDatabaseRef,
  type ResolvedMaterializationInvocation,
} from '@chronolog/materializer'
import {
  digestExecutionManifest,
  digestSchemaManifest,
  portableExecutionManifestFixture,
  portableSchemaManifestFixture,
  portableTransactionProgramFixture,
} from '@chronolog/ir'
import { encodeTransactionCore, transactionDigest, type TransactionCore } from '@chronolog/protocol'
import { describe, expect, it } from 'vitest'

import { createDoltLitePortableKernel, type DoltLitePortableMaterializerLike } from './portable.js'
import type {
  AdmittedTransaction,
  MaterializedRevision,
  MaterializerBackendInfo,
  TransactionLogRow,
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

function artifact(kind: ExactArtifactRef['kind'], codec: number): ExactArtifactRef {
  return {
    kind,
    formatVersion: 1,
    object: {
      storeId: Uint8Array.of(1),
      codec: { number: codec, version: 1 },
      contentId: { algorithm: 'sha2-256', digest: bytes(codec, 32) },
    },
  }
}

async function admitted(): Promise<AdmittedTransaction> {
  const execution = portableExecutionManifestFixture()
  const schema = portableSchemaManifestFixture()
  const core: TransactionCore = {
    groupId: bytes(1, 32),
    membershipRevision: bytes(2, 32),
    validationPolicy: bytes(3, 32),
    authorId: bytes(4, 32),
    authorTimestampMs: 5n,
    nonce: bytes(6, 16),
    executionManifestDigest: await digestExecutionManifest(execution),
    schemaDigest: await digestSchemaManifest(schema),
    program: portableTransactionProgramFixture(),
  }
  const canonicalCandidate = encodeTransactionCore(core)
  return {
    txId: bytes(7, 16),
    authorFeedSequence: 8n,
    candidateDigest: await transactionDigest(canonicalCandidate),
    canonicalCandidate,
    core,
  }
}

function backend(engineDigest: Uint8Array): MaterializerBackendInfo {
  return {
    engine: 'doltlite',
    version: 'test',
    sqliteVersion: 'test',
    vecVersion: null,
    nativeManifest: {
      doltliteVersion: 'test',
      doltliteSourceSha256: 'test',
      sqliteVecVersion: 'test',
      sqliteVecSourceSha256: 'test',
      chronologPatchProfile: 'test',
      fts5: true,
      json1: true,
      rtree: true,
      dynamicExtensions: false,
    },
    engineDigest,
    securityConfigured: true,
  }
}

class FakeOracle implements DoltLitePortableMaterializerLike {
  revision = 0n
  readonly schemaDigest: Uint8Array
  readonly executionManifestDigest: Uint8Array
  readonly backend: MaterializerBackendInfo
  #log: TransactionLogRow[] = []
  received: readonly AdmittedTransaction[] = []

  constructor(schemaDigest: Uint8Array, manifestDigest: Uint8Array, engineDigest: Uint8Array) {
    this.schemaDigest = schemaDigest
    this.executionManifestDigest = manifestDigest
    this.backend = backend(engineDigest)
  }

  get orderLength(): number { return this.#log.length }
  transactionLog(): readonly TransactionLogRow[] { return this.#log.map((row) => structuredClone(row)) }

  async materialize(orderedTransactions: readonly AdmittedTransaction[]): Promise<MaterializedRevision> {
    this.received = orderedTransactions.map((transaction) => structuredClone(transaction))
    this.revision += 1n
    this.#log = orderedTransactions.map((transaction, orderIndex) => ({
      txId: transaction.txId.slice(),
      orderKey: {
        authorTimestampMs: transaction.core.authorTimestampMs,
        authorId: transaction.core.authorId.slice(),
        authorFeedSequence: transaction.authorFeedSequence,
        txId: transaction.txId.slice(),
      },
      orderIndex,
      outcome: 'accepted',
      rejectionCode: null,
      failingPreconditionId: null,
      failingCommandId: null,
      failingRuleId: null,
      failingConstraintId: null,
      resultDigest: bytes(9, 32),
      authorId: transaction.core.authorId.slice(),
      authorTimestampMs: transaction.core.authorTimestampMs,
      authorFeedSequence: transaction.authorFeedSequence,
      candidateDigest: transaction.candidateDigest.slice(),
      canonicalCandidate: transaction.canonicalCandidate.slice(),
    }))
    return {
      revision: this.revision,
      previousRevision: this.revision - 1n,
      orderLength: this.#log.length,
      replayFromIndex: 0,
      replayedTransactions: this.#log.length,
      checkpointPrefix: 0,
      contentHash: 'test',
      schemaDigest: this.schemaDigest.slice(),
      manifestDigest: this.executionManifestDigest.slice(),
      earliestChangedOrderIndex: 0,
      outcomeChanges: [],
    }
  }
}

async function resolved(transaction: AdmittedTransaction): Promise<ResolvedMaterializationInvocation> {
  const schema = portableSchemaManifestFixture()
  const executionManifest = portableExecutionManifestFixture()
  const schemaDigest = await digestSchemaManifest(schema)
  const executionManifestDigest = await digestExecutionManifest(executionManifest)
  const targetOrderDigest = await digestAdmittedOrder([transaction.txId])
  const invocation: ChronologMaterializationInvocation = {
    version: 1,
    profile: 'pure',
    context: { groupId: bytes(1, 32), logicalTimeMs: null, entropySeed: null },
    previous: null,
    replayBase: { manifest: artifact('materialization-manifest', 1), database: database(2) },
    admittedSuffix: artifact('admitted-suffix', 2),
    schemaManifest: artifact('schema-manifest', 3),
    executionManifest: artifact('execution-manifest', 4),
    continuation: null,
    expectedEngineDigest: executionManifest.engineDigest,
    expectedSchemaDigest: schemaDigest,
    expectedExecutionManifestDigest: executionManifestDigest,
    expectedPreviousOrderDigest: await digestAdmittedOrder([]),
    replayFromIndex: 0,
    targetOrderLength: 1,
    targetOrderDigest,
  }
  return {
    invocation,
    schemaManifest: schema,
    executionManifest,
    admittedSuffix: {
      version: 1,
      groupId: bytes(1, 32),
      replayFromIndex: 0,
      targetOrderLength: 1,
      targetOrderDigest,
      transactions: [transaction],
    },
    continuation: null,
    exactReadSet: [invocation.admittedSuffix.object],
  }
}

describe('DoltLite portable differential adapter', () => {
  it('runs the exact suffix through the existing oracle without publishing a generic ref', async () => {
    const transaction = await admitted()
    const input = await resolved(transaction)
    const oracle = new FakeOracle(
      input.invocation.expectedSchemaDigest,
      input.invocation.expectedExecutionManifestDigest,
      input.invocation.expectedEngineDigest,
    )
    let projectedRevision: bigint | null = null
    const expected: ChronologMaterializationOutcome = {
      kind: 'completed',
      outputDatabase: database(3),
      materializationManifest: artifact('materialization-manifest', 5),
      outcomeChanges: artifact('outcome-changes', 6),
      orderLength: 1,
      orderDigest: input.invocation.targetOrderDigest,
      replayFromIndex: 0,
      stateDigest: database(3).stateDigest.contentId,
    }
    const kernel = createDoltLitePortableKernel(oracle, (context) => {
      projectedRevision = context.revision?.revision ?? null
      expect(context.exactReadSet).toEqual(input.exactReadSet)
      return expected
    })
    expect(await kernel.materialize(input)).toEqual(expected)
    expect(projectedRevision).toBe(1n)
    expect(oracle.received[0]?.canonicalCandidate).toEqual(transaction.canonicalCandidate)
  })

  it('fails before materialization when prior order identity differs', async () => {
    const transaction = await admitted()
    const input = await resolved(transaction)
    const oracle = new FakeOracle(
      input.invocation.expectedSchemaDigest,
      input.invocation.expectedExecutionManifestDigest,
      input.invocation.expectedEngineDigest,
    )
    const kernel = createDoltLitePortableKernel(oracle, () => {
      throw new Error('projector must not run')
    })
    await expect(kernel.materialize({
      ...input,
      invocation: { ...input.invocation, expectedPreviousOrderDigest: bytes(99, 32) },
    })).rejects.toThrow('MATERIALIZER_PREVIOUS_ORDER_DIGEST_MISMATCH')
    expect(oracle.received).toHaveLength(0)
  })
})
