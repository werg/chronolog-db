import {
  compareObjectRefs,
  decodeMaterializationInvocation,
  encodeMaterializationOutcome,
  exactDatabaseRefToCbor,
  resolveDecodedMaterializationInvocation,
  sameBytes,
  type ChronologMaterializationOutcome,
  type ExactArtifactRef,
  type ExactDatabaseRef,
  type ExactObjectRef,
} from '@chronolog/materializer'
import { encodeCanonicalCbor } from '@chronolog/canonical'

import type {
  ChronologArtifactSelector,
  ChronologCompatibilityTuple,
  ChronologDatabaseInputName,
  ChronologNamedArtifactOutput,
  ChronologNamedDatabaseOutput,
  ChronologReducerResult,
  ChronologTypedArtifactWrite,
  ChronologWorkerdDatabaseKernel,
  ChronologWorkerdHostContext,
} from './types.js'

export class ChronologWorkerdContractError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'ChronologWorkerdContractError'
  }
}

export async function runChronologWorkerdController<Database, PrivateDatabase>(
  invocationBytes: Uint8Array,
  host: ChronologWorkerdHostContext<Database, PrivateDatabase>,
  kernel: ChronologWorkerdDatabaseKernel<Database, PrivateDatabase>,
): Promise<ChronologReducerResult> {
  // This is the sole invocation decode. Prove all host-injected identities and
  // the compatibility tuple before even immutable artifact resolution.
  const invocation = decodeMaterializationInvocation(invocationBytes)
  assertNamedInputs(invocation.previous?.database ?? null,
    invocation.replayBase.database, host.inputs)
  assertCompatibility(invocation, host.compatibility)

  const reads: ExactObjectRef[] = []
  const resolved = await resolveDecodedMaterializationInvocation(invocation, {
    async readExact(ref): Promise<Uint8Array> {
      reads.push(ref)
      return host.readExact(ref)
    },
  })
  const created: PrivateDatabase[] = []
  const finalized: ExactDatabaseRef[] = []
  const checkpointed: ExactDatabaseRef[] = []
  const artifacts: { readonly request: ChronologTypedArtifactWrite; readonly ref: ExactArtifactRef }[] = []
  const outcome = await kernel.materialize(resolved, {
    inputs: host.inputs,
    async readExact(ref): Promise<Uint8Array> {
      reads.push(ref)
      return host.readExact(ref)
    },
    async createPrivateOutput(request): Promise<PrivateDatabase> {
      assertOutputCreation(request.name, request.from, host.inputs, created.length)
      const output = await host.createPrivateOutput(request)
      created.push(output)
      return output
    },
    async writeTypedArtifact(request): Promise<ExactArtifactRef> {
      assertArtifactRequest(request)
      const ref = await host.writeTypedArtifact(request)
      assertWrittenArtifact(request, ref)
      artifacts.push({ request, ref })
      return ref
    },
    async finalizePrivateOutput(request): Promise<ExactDatabaseRef> {
      assertKnownOutput(request.output, created)
      if (request.name !== 'materialized' || finalized.length !== 0 || checkpointed.length !== 0) {
        throw new ChronologWorkerdContractError('CHRONOLOG_FINALIZE_INVALID')
      }
      const ref = await host.finalizePrivateOutput(request)
      finalized.push(ref)
      return ref
    },
    async checkpointPrivateOutput(request): Promise<ExactDatabaseRef> {
      assertKnownOutput(request.output, created)
      if (
        request.selector !== 'checkpoint' ||
        !Number.isSafeInteger(request.nextOrderIndex) ||
        request.nextOrderIndex < 0 ||
        checkpointed.length !== 0 ||
        finalized.length !== 0
      ) {
        throw new ChronologWorkerdContractError('CHRONOLOG_CHECKPOINT_INVALID')
      }
      const ref = await host.checkpointPrivateOutput(request)
      checkpointed.push(ref)
      return ref
    },
  })

  const selected = validateOutcome(outcome, resolved.invocation.previous,
    resolved.invocation.replayBase, created.length, finalized, checkpointed, artifacts)
  return {
    version: 1,
    compatibility: copyCompatibility(host.compatibility),
    outputs: selected.outputs,
    artifacts: selected.artifacts,
    applicationResult: encodeMaterializationOutcome(outcome),
    exactReadSet: uniqueReads(reads),
  }
}

function assertNamedInputs(
  previous: ExactDatabaseRef | null,
  replayBase: ExactDatabaseRef,
  inputs: ReadonlyMap<ChronologDatabaseInputName, { readonly ref: ExactDatabaseRef }>,
): void {
  const expectedSize = previous === null ? 1 : 2
  if (inputs.size !== expectedSize) {
    throw new ChronologWorkerdContractError('CHRONOLOG_NAMED_INPUT_SET_MISMATCH')
  }
  const replay = inputs.get('replayBase')
  if (replay === undefined) throw new ChronologWorkerdContractError('CHRONOLOG_REPLAY_BASE_MISSING')
  if (!sameDatabase(replay.ref, replayBase)) {
    throw new ChronologWorkerdContractError('CHRONOLOG_REPLAY_BASE_MISMATCH')
  }
  const injectedPrevious = inputs.get('previous')
  if ((previous === null) !== (injectedPrevious === undefined)) {
    throw new ChronologWorkerdContractError('CHRONOLOG_PREVIOUS_INPUT_PRESENCE_MISMATCH')
  }
  if (previous !== null && injectedPrevious !== undefined && !sameDatabase(previous, injectedPrevious.ref)) {
    throw new ChronologWorkerdContractError('CHRONOLOG_PREVIOUS_INPUT_MISMATCH')
  }
}

function assertCompatibility(
  invocation: {
    readonly expectedEngineDigest: Uint8Array
    readonly expectedExecutionManifestDigest: Uint8Array
  },
  actual: ChronologCompatibilityTuple,
): void {
  if (!sameBytes(invocation.expectedEngineDigest, actual.engineDigest)) {
    throw new ChronologWorkerdContractError('CHRONOLOG_ENGINE_COMPATIBILITY_MISMATCH')
  }
  if (!sameBytes(invocation.expectedExecutionManifestDigest, actual.executionManifestDigest)) {
    throw new ChronologWorkerdContractError('CHRONOLOG_EXECUTION_COMPATIBILITY_MISMATCH')
  }
}

function assertOutputCreation<Database>(
  name: string,
  from: ChronologDatabaseInputName,
  inputs: ReadonlyMap<ChronologDatabaseInputName, { readonly database: Database }>,
  created: number,
): void {
  if (name !== 'materialized' || !inputs.has(from) || created !== 0) {
    throw new ChronologWorkerdContractError('CHRONOLOG_PRIVATE_OUTPUT_INVALID')
  }
}

function assertArtifactRequest(request: ChronologTypedArtifactWrite): void {
  const expected = artifactKind(request.selector)
  if (
    request.kind !== expected ||
    !Number.isSafeInteger(request.formatVersion) ||
    request.formatVersion <= 0
  ) {
    throw new ChronologWorkerdContractError('CHRONOLOG_TYPED_ARTIFACT_INVALID')
  }
}

function assertWrittenArtifact(request: ChronologTypedArtifactWrite, ref: ExactArtifactRef): void {
  if (ref.kind !== request.kind || ref.formatVersion !== request.formatVersion) {
    throw new ChronologWorkerdContractError('CHRONOLOG_TYPED_ARTIFACT_RECEIPT_MISMATCH')
  }
}

function assertKnownOutput<PrivateDatabase>(output: PrivateDatabase, created: readonly PrivateDatabase[]): void {
  if (created.length !== 1 || created[0] !== output) {
    throw new ChronologWorkerdContractError('CHRONOLOG_PRIVATE_OUTPUT_UNKNOWN')
  }
}

function validateOutcome(
  outcome: ChronologMaterializationOutcome,
  previous: { readonly database: ExactDatabaseRef; readonly manifest: ExactArtifactRef } | null,
  replayBase: { readonly database: ExactDatabaseRef; readonly manifest: ExactArtifactRef },
  createdCount: number,
  finalized: readonly ExactDatabaseRef[],
  checkpointed: readonly ExactDatabaseRef[],
  writes: readonly { readonly request: ChronologTypedArtifactWrite; readonly ref: ExactArtifactRef }[],
): { readonly outputs: readonly ChronologNamedDatabaseOutput[]; readonly artifacts: readonly ChronologNamedArtifactOutput[] } {
  if (outcome.kind === 'completed') {
    requireLifecycle(createdCount === 1 && finalized.length === 1 && checkpointed.length === 0)
    requireDatabase(outcome.outputDatabase, finalized[0])
    return {
      outputs: [{ name: 'materialized', ref: outcome.outputDatabase }],
      artifacts: requireArtifacts(writes, [
        ['materializationManifest', outcome.materializationManifest],
        ['outcomeChanges', outcome.outcomeChanges],
      ]),
    }
  }
  if (outcome.kind === 'checkpointed') {
    requireLifecycle(createdCount === 1 && finalized.length === 0 && checkpointed.length === 1)
    requireDatabase(outcome.partialDatabase, checkpointed[0])
    return {
      outputs: [{ name: 'checkpoint', ref: outcome.partialDatabase }],
      artifacts: requireArtifacts(writes, [['continuation', outcome.continuation]]),
    }
  }
  requireLifecycle(createdCount === 0 && finalized.length === 0 && checkpointed.length === 0)
  const unchanged = previous ?? replayBase
  requireDatabase(outcome.outputDatabase, unchanged.database)
  const selectedArtifacts = writes.length === 0
    ? sameArtifact(outcome.materializationManifest, unchanged.manifest)
      ? [{ name: 'materializationManifest' as const, ref: outcome.materializationManifest }]
      : substitution('CHRONOLOG_UNCHANGED_MANIFEST_SUBSTITUTION')
    : requireArtifacts(writes, [['materializationManifest', outcome.materializationManifest]])
  return {
    outputs: [{ name: 'materialized', ref: outcome.outputDatabase }],
    artifacts: selectedArtifacts,
  }
}

function requireLifecycle(valid: boolean): void {
  if (!valid) throw new ChronologWorkerdContractError('CHRONOLOG_OUTPUT_LIFECYCLE_MISMATCH')
}

function requireDatabase(actual: ExactDatabaseRef, expected: ExactDatabaseRef | undefined): void {
  if (expected === undefined || !sameDatabase(actual, expected)) {
    throw new ChronologWorkerdContractError('CHRONOLOG_OUTPUT_DATABASE_SUBSTITUTION')
  }
}

function requireArtifacts(
  writes: readonly { readonly request: ChronologTypedArtifactWrite; readonly ref: ExactArtifactRef }[],
  expected: readonly (readonly [ChronologArtifactSelector, ExactArtifactRef])[],
): readonly ChronologNamedArtifactOutput[] {
  if (writes.length !== expected.length) {
    throw new ChronologWorkerdContractError('CHRONOLOG_ARTIFACT_SELECTOR_MISMATCH')
  }
  return expected.map(([name, ref]) => {
    const write = writes.find((candidate) => candidate.request.selector === name)
    if (write === undefined || !sameArtifact(write.ref, ref)) {
      throw new ChronologWorkerdContractError('CHRONOLOG_ARTIFACT_SUBSTITUTION')
    }
    return { name, ref }
  })
}

function artifactKind(selector: ChronologArtifactSelector): ExactArtifactRef['kind'] {
  if (selector === 'materializationManifest') return 'materialization-manifest'
  if (selector === 'outcomeChanges') return 'outcome-changes'
  return 'continuation'
}

function substitution(code: string): never {
  throw new ChronologWorkerdContractError(code)
}

function sameDatabase(left: ExactDatabaseRef, right: ExactDatabaseRef): boolean {
  return sameBytes(encodeCanonicalCbor(exactDatabaseRefToCbor(left)),
    encodeCanonicalCbor(exactDatabaseRefToCbor(right)))
}

function sameArtifact(left: ExactArtifactRef, right: ExactArtifactRef): boolean {
  return left.kind === right.kind && left.formatVersion === right.formatVersion &&
    sameBytes(left.object.storeId, right.object.storeId) &&
    left.object.codec.number === right.object.codec.number &&
    left.object.codec.version === right.object.codec.version &&
    left.object.contentId.algorithm === right.object.contentId.algorithm &&
    sameBytes(left.object.contentId.digest, right.object.contentId.digest)
}

function uniqueReads(reads: readonly ExactObjectRef[]): readonly ExactObjectRef[] {
  const sorted = [...reads].sort(compareObjectRefs)
  return sorted.filter((ref, index) => index === 0 || compareObjectRefs(sorted[index - 1]!, ref) !== 0)
}

function copyCompatibility(value: ChronologCompatibilityTuple): ChronologCompatibilityTuple {
  return {
    engineDigest: value.engineDigest.slice(),
    executionManifestDigest: value.executionManifestDigest.slice(),
  }
}
