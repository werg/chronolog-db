import {
  digestExecutionManifest,
  digestSchemaManifest,
} from '@chronolog/ir'
import { transactionDigest } from '@chronolog/protocol'

import {
  compareObjectRefs,
  decodeAdmittedSuffix,
  decodeExecutionManifestArtifact,
  decodeMaterializationContinuation,
  decodeMaterializationInvocation,
  decodeSchemaManifestArtifact,
  digestMaterializationInvocation,
  sameBytes,
} from './codec.js'
import type {
  ChronologMaterializationInvocation,
  ChronologMaterializationOutcome,
  ChronologMaterializerKernel,
  ExactArtifactRef,
  ExactObjectReader,
  ExactObjectRef,
  ResolvedMaterializationInvocation,
} from './types.js'

export class MaterializerContractError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'MaterializerContractError'
  }
}

export async function resolveMaterializationInvocation(
  invocationBytes: Uint8Array,
  objects: ExactObjectReader,
): Promise<ResolvedMaterializationInvocation> {
  return resolveDecodedMaterializationInvocation(
    decodeMaterializationInvocation(invocationBytes),
    objects,
  )
}

/** Resolves a previously decoded invocation without observing its bytes again. */
export async function resolveDecodedMaterializationInvocation(
  invocation: ChronologMaterializationInvocation,
  objects: ExactObjectReader,
): Promise<ResolvedMaterializationInvocation> {
  assertPureV1Context(invocation)

  const requested = [
    invocation.previous?.manifest,
    invocation.replayBase.manifest,
    invocation.admittedSuffix,
    invocation.schemaManifest,
    invocation.executionManifest,
    invocation.continuation,
  ].filter((ref): ref is ExactArtifactRef => ref !== undefined && ref !== null)
  const unique = uniqueArtifacts(requested)
  const bytesByIdentity = new Map<string, Uint8Array>()
  for (const artifact of unique) {
    bytesByIdentity.set(objectIdentity(artifact.object), await objects.readExact(artifact.object))
  }

  const bytesFor = (artifact: ExactArtifactRef): Uint8Array => {
    const bytes = bytesByIdentity.get(objectIdentity(artifact.object))
    if (bytes === undefined) throw new MaterializerContractError('MATERIALIZER_EXACT_OBJECT_MISSING')
    return bytes
  }
  const schemaManifest = decodeSchemaManifestArtifact(bytesFor(invocation.schemaManifest))
  const executionManifest = decodeExecutionManifestArtifact(bytesFor(invocation.executionManifest))
  const admittedSuffix = decodeAdmittedSuffix(bytesFor(invocation.admittedSuffix))
  const continuation = invocation.continuation === null
    ? null
    : decodeMaterializationContinuation(bytesFor(invocation.continuation))

  if (!sameBytes(await digestSchemaManifest(schemaManifest), invocation.expectedSchemaDigest)) {
    throw new MaterializerContractError('MATERIALIZER_SCHEMA_DIGEST_MISMATCH')
  }
  if (!sameBytes(
    await digestExecutionManifest(executionManifest),
    invocation.expectedExecutionManifestDigest,
  )) {
    throw new MaterializerContractError('MATERIALIZER_EXECUTION_MANIFEST_DIGEST_MISMATCH')
  }
  if (!sameBytes(executionManifest.engineDigest, invocation.expectedEngineDigest)) {
    throw new MaterializerContractError('MATERIALIZER_ENGINE_DIGEST_MISMATCH')
  }
  if (!sameBytes(admittedSuffix.groupId, invocation.context.groupId)) {
    throw new MaterializerContractError('MATERIALIZER_GROUP_MISMATCH')
  }
  if (
    admittedSuffix.replayFromIndex !== invocation.replayFromIndex ||
    admittedSuffix.targetOrderLength !== invocation.targetOrderLength ||
    !sameBytes(admittedSuffix.targetOrderDigest, invocation.targetOrderDigest)
  ) {
    throw new MaterializerContractError('MATERIALIZER_SUFFIX_IDENTITY_MISMATCH')
  }
  for (const transaction of admittedSuffix.transactions) {
    if (!sameBytes(transaction.core.groupId, invocation.context.groupId)) {
      throw new MaterializerContractError('MATERIALIZER_TRANSACTION_GROUP_MISMATCH')
    }
    if (!sameBytes(await transactionDigest(transaction.canonicalCandidate), transaction.candidateDigest)) {
      throw new MaterializerContractError('MATERIALIZER_CANDIDATE_DIGEST_MISMATCH')
    }
  }
  if (continuation !== null) {
    if (!sameBytes(continuation.invocationDigest, await digestMaterializationInvocation(invocation))) {
      throw new MaterializerContractError('MATERIALIZER_CONTINUATION_INVOCATION_MISMATCH')
    }
    if (
      continuation.nextOrderIndex < invocation.replayFromIndex ||
      continuation.nextOrderIndex > invocation.targetOrderLength
    ) {
      throw new MaterializerContractError('MATERIALIZER_CONTINUATION_POSITION_INVALID')
    }
  }

  return {
    invocation,
    schemaManifest,
    executionManifest,
    admittedSuffix,
    continuation,
    exactReadSet: unique.map((artifact) => artifact.object).sort(compareObjectRefs),
  }
}

export async function runMaterializationInvocation(
  invocationBytes: Uint8Array,
  objects: ExactObjectReader,
  kernel: ChronologMaterializerKernel,
): Promise<ChronologMaterializationOutcome> {
  return kernel.materialize(await resolveMaterializationInvocation(invocationBytes, objects))
}

function assertPureV1Context(invocation: ChronologMaterializationInvocation): void {
  if (
    invocation.version !== 1 ||
    invocation.profile !== 'pure' ||
    invocation.context.logicalTimeMs !== null ||
    invocation.context.entropySeed !== null
  ) {
    throw new MaterializerContractError('MATERIALIZER_PURE_CONTEXT_INVALID')
  }
}

function uniqueArtifacts(artifacts: readonly ExactArtifactRef[]): ExactArtifactRef[] {
  const result: ExactArtifactRef[] = []
  const identities = new Map<string, ExactArtifactRef>()
  for (const artifact of artifacts) {
    const identity = objectIdentity(artifact.object)
    const known = identities.get(identity)
    if (known !== undefined) {
      if (known.kind !== artifact.kind || known.formatVersion !== artifact.formatVersion) {
        throw new MaterializerContractError('MATERIALIZER_OBJECT_TYPE_ALIAS')
      }
      continue
    }
    identities.set(identity, artifact)
    result.push(artifact)
  }
  return result
}

function objectIdentity(ref: ExactObjectRef): string {
  return [
    bytesText(ref.storeId),
    ref.codec.number.toString(10),
    ref.codec.version.toString(10),
    ref.contentId.algorithm,
    bytesText(ref.contentId.digest),
  ].join(':')
}

function bytesText(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}
