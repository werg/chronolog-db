import {
  concatBytes,
  encodeCanonicalCbor,
  integerMap,
  sha256,
  uint32Bytes,
  utf8,
  type CborValue,
} from '@chronolog/canonical'
import {
  compareObjectRefs,
  decodeMaterializationOutcome,
  encodeMaterializationOutcome,
  exactArtifactRefToCbor,
  exactDatabaseRefToCbor,
  sameBytes,
  type ChronologMaterializationOutcome,
  type ExactArtifactRef,
  type ExactDatabaseRef,
} from '@chronolog/materializer'

import { ChronologWorkerdContractError } from './controller.js'
import type {
  ChronologArtifactSelector,
  ChronologCompatibilityTuple,
  ChronologDatabaseInputName,
  ChronologExecutionRequest,
  ChronologExecutionResponse,
  ChronologNamedArtifactOutput,
  ChronologNamedDatabaseOutput,
  ChronologPublicationRequest,
  ChronologReducerCoordinatorClient,
} from './types.js'

const EXECUTION_KEY_DOMAIN = utf8('chronolog/workerd-execution-key/v1')

export interface ChronologCoordinatorInvocation {
  readonly invocation: Uint8Array
  readonly inputs: readonly {
    readonly name: ChronologDatabaseInputName
    readonly ref: ExactDatabaseRef
  }[]
  readonly compatibility: ChronologCompatibilityTuple
}

export async function createChronologExecutionRequest(
  value: ChronologCoordinatorInvocation,
): Promise<ChronologExecutionRequest> {
  const inputs = canonicalInputs(value.inputs)
  const payload = encodeCanonicalCbor(integerMap([
    [0, 1n],
    [1, value.invocation],
    [2, inputs.map(inputToCbor)],
    [3, compatibilityToCbor(value.compatibility)],
  ]))
  const framed = concatBytes(uint32Bytes(EXECUTION_KEY_DOMAIN.length), EXECUTION_KEY_DOMAIN,
    Uint8Array.of(0), payload)
  return {
    version: 1,
    executionKey: await sha256(framed),
    invocation: value.invocation.slice(),
    inputs,
    compatibility: copyCompatibility(value.compatibility),
  }
}

/**
 * Standard-mode coordination. An ambiguous run failure is followed by its
 * deterministic key; this helper never publishes a mutable ref.
 */
export async function executeChronologMaterialization(
  client: ChronologReducerCoordinatorClient,
  invocation: ChronologCoordinatorInvocation,
): Promise<ChronologExecutionResponse> {
  const request = await createChronologExecutionRequest(invocation)
  let response: ChronologExecutionResponse
  try {
    response = await client.run(request)
  } catch (error) {
    const followed = await client.follow(request.executionKey)
    if (followed === null) throw error
    response = followed
  }
  validateChronologExecutionResponse(request, response)
  return response
}

export function validateChronologExecutionResponse(
  request: ChronologExecutionRequest,
  response: ChronologExecutionResponse,
): ChronologMaterializationOutcome {
  if (response.version !== 1 || !sameBytes(request.executionKey, response.executionKey)) {
    throw new ChronologWorkerdContractError('CHRONOLOG_EXECUTION_IDENTITY_MISMATCH')
  }
  assertCompatibility(request.compatibility, response.compatibility)
  const outcome = decodeMaterializationOutcome(response.applicationResult)
  if (!sameBytes(encodeMaterializationOutcome(outcome), response.applicationResult)) {
    throw new ChronologWorkerdContractError('CHRONOLOG_APPLICATION_RESULT_NON_CANONICAL')
  }
  const expected = selectorsForOutcome(outcome)
  assertOutputs(response.outputs, expected.outputs)
  assertArtifacts(response.artifacts, expected.artifacts)
  for (let index = 1; index < response.exactReadSet.length; index++) {
    if (compareObjectRefs(response.exactReadSet[index - 1]!, response.exactReadSet[index]!) >= 0) {
      throw new ChronologWorkerdContractError('CHRONOLOG_EXACT_READ_SET_NON_CANONICAL')
    }
  }
  return outcome
}

/** Produces data for a separate publisher; it performs no ref mutation. */
export function createChronologPublicationRequest(
  response: ChronologExecutionResponse,
  refName: string,
  expectedCurrent: ExactDatabaseRef | null,
): ChronologPublicationRequest {
  if (refName.length === 0) throw new ChronologWorkerdContractError('CHRONOLOG_REF_NAME_EMPTY')
  const selectedOutput = response.outputs.find((output) => output.name === 'materialized')
  if (selectedOutput === undefined) {
    throw new ChronologWorkerdContractError('CHRONOLOG_PUBLICATION_REQUIRES_COMPLETED_OUTPUT')
  }
  return {
    version: 1,
    executionKey: response.executionKey.slice(),
    refName,
    selectedOutput: { name: selectedOutput.name, ref: copyDatabase(selectedOutput.ref) },
    expectedCurrent: expectedCurrent === null ? null : copyDatabase(expectedCurrent),
  }
}

function canonicalInputs(
  inputs: ChronologCoordinatorInvocation['inputs'],
): ChronologExecutionRequest['inputs'] {
  const order: Record<ChronologDatabaseInputName, number> = { previous: 0, replayBase: 1 }
  const result = [...inputs].sort((left, right) => order[left.name] - order[right.name])
    .map((input) => ({ name: input.name, ref: input.ref }))
  const names = new Set(result.map((input) => input.name))
  if (names.size !== result.length || !names.has('replayBase')) {
    throw new ChronologWorkerdContractError('CHRONOLOG_COORDINATOR_INPUTS_INVALID')
  }
  return result
}

function inputToCbor(input: ChronologExecutionRequest['inputs'][number]): CborValue {
  return integerMap([
    [0, input.name === 'previous' ? 1n : 2n],
    [1, exactDatabaseRefToCbor(input.ref)],
  ])
}

function compatibilityToCbor(value: ChronologCompatibilityTuple): CborValue {
  return integerMap([
    [0, value.engineDigest],
    [1, value.schemaDigest],
    [2, value.executionManifestDigest],
  ])
}

function selectorsForOutcome(outcome: ChronologMaterializationOutcome): {
  readonly outputs: readonly ChronologNamedDatabaseOutput[]
  readonly artifacts: readonly ChronologNamedArtifactOutput[]
} {
  if (outcome.kind === 'completed') {
    return {
      outputs: [{ name: 'materialized', ref: outcome.outputDatabase }],
      artifacts: [
        { name: 'materializationManifest', ref: outcome.materializationManifest },
        { name: 'outcomeChanges', ref: outcome.outcomeChanges },
      ],
    }
  }
  if (outcome.kind === 'unchanged') {
    return {
      outputs: [{ name: 'materialized', ref: outcome.outputDatabase }],
      artifacts: [{ name: 'materializationManifest', ref: outcome.materializationManifest }],
    }
  }
  return {
    outputs: [{ name: 'checkpoint', ref: outcome.partialDatabase }],
    artifacts: [{ name: 'continuation', ref: outcome.continuation }],
  }
}

function assertOutputs(
  actual: readonly ChronologNamedDatabaseOutput[],
  expected: readonly ChronologNamedDatabaseOutput[],
): void {
  if (actual.length !== expected.length) substitution('CHRONOLOG_OUTPUT_SELECTOR_MISMATCH')
  for (let index = 0; index < expected.length; index++) {
    const selected = expected[index]!
    const candidate = actual[index]!
    if (candidate.name !== selected.name || !sameDatabase(candidate.ref, selected.ref)) {
      substitution('CHRONOLOG_OUTPUT_SUBSTITUTION')
    }
  }
}

function assertArtifacts(
  actual: readonly ChronologNamedArtifactOutput[],
  expected: readonly ChronologNamedArtifactOutput[],
): void {
  if (actual.length !== expected.length) substitution('CHRONOLOG_ARTIFACT_SELECTOR_MISMATCH')
  for (let index = 0; index < expected.length; index++) {
    const selected = expected[index]!
    const candidate = actual[index]!
    if (candidate.name !== selected.name || !sameArtifact(candidate.ref, selected.ref)) {
      substitution('CHRONOLOG_ARTIFACT_SUBSTITUTION')
    }
  }
}

function assertCompatibility(expected: ChronologCompatibilityTuple, actual: ChronologCompatibilityTuple): void {
  if (
    !sameBytes(expected.engineDigest, actual.engineDigest) ||
    !sameBytes(expected.schemaDigest, actual.schemaDigest) ||
    !sameBytes(expected.executionManifestDigest, actual.executionManifestDigest)
  ) substitution('CHRONOLOG_RESPONSE_COMPATIBILITY_MISMATCH')
}

function sameDatabase(left: ExactDatabaseRef, right: ExactDatabaseRef): boolean {
  return sameBytes(encodeCanonicalCbor(exactDatabaseRefToCbor(left)),
    encodeCanonicalCbor(exactDatabaseRefToCbor(right)))
}

function sameArtifact(left: ExactArtifactRef, right: ExactArtifactRef): boolean {
  return sameBytes(encodeCanonicalCbor(exactArtifactRefToCbor(left)),
    encodeCanonicalCbor(exactArtifactRefToCbor(right)))
}

function substitution(code: string): never {
  throw new ChronologWorkerdContractError(code)
}

function copyCompatibility(value: ChronologCompatibilityTuple): ChronologCompatibilityTuple {
  return {
    engineDigest: value.engineDigest.slice(),
    schemaDigest: value.schemaDigest.slice(),
    executionManifestDigest: value.executionManifestDigest.slice(),
  }
}

function copyDatabase(value: ExactDatabaseRef): ExactDatabaseRef {
  return {
    storeId: value.storeId.slice(),
    doltFormatVersion: value.doltFormatVersion,
    canonicalGenesisCommit: {
      doltFormatVersion: value.canonicalGenesisCommit.doltFormatVersion,
      contentId: {
        algorithm: value.canonicalGenesisCommit.contentId.algorithm,
        digest: value.canonicalGenesisCommit.contentId.digest.slice(),
      },
    },
    commitHash: {
      doltFormatVersion: value.commitHash.doltFormatVersion,
      contentId: {
        algorithm: value.commitHash.contentId.algorithm,
        digest: value.commitHash.contentId.digest.slice(),
      },
    },
    stateDigest: {
      stateFormatVersion: value.stateDigest.stateFormatVersion,
      contentId: {
        algorithm: value.stateDigest.contentId.algorithm,
        digest: value.stateDigest.contentId.digest.slice(),
      },
    },
  }
}

export const CHRONOLOG_OUTPUT_SELECTORS: readonly ChronologNamedDatabaseOutput['name'][] =
  Object.freeze(['materialized', 'checkpoint'])
export const CHRONOLOG_ARTIFACT_SELECTORS: readonly ChronologArtifactSelector[] =
  Object.freeze(['materializationManifest', 'outcomeChanges', 'continuation'])
