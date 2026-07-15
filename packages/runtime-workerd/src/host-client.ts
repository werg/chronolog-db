import {
  sameBytes,
  type ExactDatabaseRef,
} from '@chronolog/materializer'

import { ChronologWorkerdContractError } from './controller.js'
import { createChronologExecutionRequest } from './coordinator.js'
import type {
  ChronologCompatibilityTuple,
  ChronologDatabaseInputName,
  ChronologNamedDatabaseOutput,
  ChronologPublicationRequest,
} from './types.js'
import {
  decodeDatabaseReducerByteString,
  decodeChronologReducerApplicationResult,
  decodeChronologReducerInvocationBundle,
  encodeDatabaseReducerByteString,
  encodeChronologReducerInvocationBundle,
  type ChronologReducerApplicationResult,
  type ChronologReducerInvocationBundle,
} from './worker-codec.js'
import type { DatabaseReducerCommitOptions } from './worker-bundle.js'

/** Structural snapshot of the generated workerd database-reducer binding. */
export interface WorkerdDatabaseReducerObjectRefValue {
  readonly storeId: string
  readonly codecNumber: number
  readonly codecVersion: number
  readonly hashAlgorithm: string
  readonly digest: string
}

export interface WorkerdDatabaseReducerDatabaseRefValue {
  readonly repositoryRoot: WorkerdDatabaseReducerObjectRefValue
  readonly doltFormatVersion: number
  readonly commitHash: string
  readonly stateFormatVersion: number
  readonly stateDigest: string
}

export interface WorkerdDatabaseReducerRunInput {
  readonly logicalName: string
  readonly sqlAlias: string
  readonly database: WorkerdDatabaseReducerDatabaseRefValue
}

export interface WorkerdDatabaseReducerRunOutputPlan {
  readonly logicalName: string
  readonly sqlAlias: string
  readonly origin: 'fork-input' | 'create-canonical' | 'pass-through-input'
  readonly sourceInput: string
  readonly commit: DatabaseReducerCommitOptions
}

export interface WorkerdDatabaseReducerRunOptions {
  readonly inputs: WorkerdDatabaseReducerRunInput[]
  readonly outputs: WorkerdDatabaseReducerRunOutputPlan[]
  readonly canonicalInput: Uint8Array
}

export interface WorkerdDatabaseReducerRunDatabase {
  readonly logicalName: string
  readonly sqlAlias: string
  readonly database: WorkerdDatabaseReducerDatabaseRefValue
}

export interface WorkerdDatabaseReducerRunResult {
  readonly databases: WorkerdDatabaseReducerRunDatabase[]
  readonly canonicalOutput: Uint8Array
}

export interface WorkerdDatabaseReducerGeneratedBinding {
  run(options: WorkerdDatabaseReducerRunOptions): Promise<WorkerdDatabaseReducerRunResult>
}

export interface ChronologWorkerdTransportRunRequest {
  readonly executionKey: Uint8Array
  readonly options: WorkerdDatabaseReducerRunOptions
}

export interface ChronologWorkerdPublicationResult {
  readonly status: 'published' | 'already_current' | 'conflict'
  readonly generation: bigint | null
  readonly current: ExactDatabaseRef | null
}

export interface ChronologWorkerdPublicationIntent extends ChronologPublicationRequest {
  /** Preserves the repository-root identity omitted by Chronolog's portable ref shape. */
  readonly selectedTransportOutput: WorkerdDatabaseReducerRunDatabase
}

/**
 * Injectable coordination seam. A runnable workerd configuration can adapt
 * its generated reducer binding to `run`; durable metadata owns follow and
 * publication. The reducer Worker receives none of these methods.
 */
export interface ChronologWorkerdHostTransport {
  run(request: ChronologWorkerdTransportRunRequest): Promise<WorkerdDatabaseReducerRunResult>
  follow(executionKey: Uint8Array): Promise<WorkerdDatabaseReducerRunResult | null>
  publish(request: ChronologWorkerdPublicationIntent): Promise<ChronologWorkerdPublicationResult>
}

export interface ChronologWorkerdClientDatabaseInput {
  readonly name: ChronologDatabaseInputName
  readonly sqlAlias: string
  readonly exact: ExactDatabaseRef
  readonly transport: WorkerdDatabaseReducerDatabaseRefValue
}

export interface ChronologWorkerdClientRunRequest {
  readonly bundle: ChronologReducerInvocationBundle
  readonly inputs: readonly ChronologWorkerdClientDatabaseInput[]
  readonly outputSource: ChronologDatabaseInputName
  readonly compatibility: ChronologCompatibilityTuple
  readonly commit?: DatabaseReducerCommitOptions
}

export interface ChronologWorkerdBundleExecutionResponse {
  readonly executionKey: Uint8Array
  readonly application: ChronologReducerApplicationResult
  readonly outputs: readonly ChronologNamedDatabaseOutput[]
  readonly transportOutputs: readonly WorkerdDatabaseReducerRunDatabase[]
}

const DEFAULT_COMMIT: DatabaseReducerCommitOptions = Object.freeze({
  message: 'Chronolog materialization',
  authorName: 'Chronolog reducer',
  authorEmail: 'reducer@chronolog.invalid',
  timestamp: '1970-01-01T00:00:00',
})

export class ChronologWorkerdHostClient {
  constructor(private readonly transport: ChronologWorkerdHostTransport) {}

  async run(request: ChronologWorkerdClientRunRequest): Promise<ChronologWorkerdBundleExecutionResponse> {
    const prepared = await prepareRun(request)
    return decodeRunResult(request, prepared.executionKey, await this.transport.run(prepared))
  }

  async follow(
    request: ChronologWorkerdClientRunRequest,
  ): Promise<ChronologWorkerdBundleExecutionResponse | null> {
    const prepared = await prepareRun(request)
    const result = await this.transport.follow(prepared.executionKey)
    return result === null ? null : decodeRunResult(request, prepared.executionKey, result)
  }

  /** Run once, then reconcile an ambiguous response by deterministic key. */
  async execute(
    request: ChronologWorkerdClientRunRequest,
  ): Promise<ChronologWorkerdBundleExecutionResponse> {
    try {
      return await this.run(request)
    } catch (error) {
      const followed = await this.follow(request)
      if (followed === null) throw error
      return followed
    }
  }

  createPublicationIntent(
    response: ChronologWorkerdBundleExecutionResponse,
    refName: string,
    expectedCurrent: ExactDatabaseRef | null,
  ): ChronologWorkerdPublicationIntent {
    if (refName.length === 0) throw new ChronologWorkerdContractError('CHRONOLOG_REF_NAME_EMPTY')
    const output = response.outputs.find((candidate) => candidate.name === 'materialized')
    const transportOutput = response.transportOutputs.find(
      (candidate) => candidate.logicalName === 'materialized',
    )
    if (output === undefined || transportOutput === undefined) {
      throw new ChronologWorkerdContractError('CHRONOLOG_PUBLICATION_REQUIRES_MATERIALIZED_OUTPUT')
    }
    return {
      version: 1,
      executionKey: response.executionKey.slice(),
      refName,
      selectedOutput: { name: output.name, ref: cloneDatabase(output.ref) },
      selectedTransportOutput: cloneTransportOutput(transportOutput),
      expectedCurrent: expectedCurrent === null ? null : cloneDatabase(expectedCurrent),
    }
  }

  publish(request: ChronologWorkerdPublicationIntent): Promise<ChronologWorkerdPublicationResult> {
    return this.transport.publish(request)
  }
}

export function createGeneratedBindingRunTransport(
  binding: WorkerdDatabaseReducerGeneratedBinding,
  metadata: Pick<ChronologWorkerdHostTransport, 'follow' | 'publish'>,
): ChronologWorkerdHostTransport {
  return {
    async run(request): Promise<WorkerdDatabaseReducerRunResult> {
      return binding.run(request.options)
    },
    follow: (executionKey) => metadata.follow(executionKey),
    publish: (request) => metadata.publish(request),
  }
}

async function prepareRun(
  request: ChronologWorkerdClientRunRequest,
): Promise<ChronologWorkerdTransportRunRequest> {
  const bundle = decodeChronologReducerInvocationBundle(
    encodeChronologReducerInvocationBundle(request.bundle),
  )
  const inputs = canonicalInputs(request.inputs)
  const source = inputs.find((input) => input.name === request.outputSource)
  if (source === undefined) {
    throw new ChronologWorkerdContractError('CHRONOLOG_OUTPUT_SOURCE_MISSING')
  }
  const execution = await createChronologExecutionRequest({
    invocation: bundle.invocation,
    inputs: inputs.map((input) => ({ name: input.name, ref: input.exact })),
    compatibility: request.compatibility,
  })
  return {
    executionKey: execution.executionKey,
    options: {
      inputs: inputs.map((input) => ({
        logicalName: input.name,
        sqlAlias: input.sqlAlias,
        database: cloneTransportDatabase(input.transport),
      })),
      outputs: [{
        logicalName: 'materialized',
        sqlAlias: 'materialized_db',
        origin: 'fork-input',
        sourceInput: source.name,
        commit: request.commit ?? DEFAULT_COMMIT,
      }],
      canonicalInput: encodeDatabaseReducerByteString(encodeChronologReducerInvocationBundle(bundle)),
    },
  }
}

function canonicalInputs(
  values: readonly ChronologWorkerdClientDatabaseInput[],
): readonly ChronologWorkerdClientDatabaseInput[] {
  const order: Record<ChronologDatabaseInputName, number> = { previous: 0, replayBase: 1 }
  const inputs = [...values].sort((left, right) => order[left.name] - order[right.name])
  if (inputs.length < 1 || inputs.length > 2 ||
      inputs[inputs.length - 1]?.name !== 'replayBase' ||
      new Set(inputs.map((input) => input.name)).size !== inputs.length) {
    throw new ChronologWorkerdContractError('CHRONOLOG_CLIENT_INPUT_SET_INVALID')
  }
  for (const input of inputs) assertTransportMatchesExact(input)
  return inputs
}

function assertTransportMatchesExact(input: ChronologWorkerdClientDatabaseInput): void {
  const transport = input.transport
  if (
    !sameBytes(fromHex(transport.repositoryRoot.storeId, 'storeId'), input.exact.storeId) ||
    transport.doltFormatVersion !== input.exact.doltFormatVersion ||
    transport.commitHash !== toHex(input.exact.commitHash.contentId.digest) ||
    transport.stateFormatVersion !== input.exact.stateDigest.stateFormatVersion ||
    transport.stateDigest !== toHex(input.exact.stateDigest.contentId.digest)
  ) {
    throw new ChronologWorkerdContractError('CHRONOLOG_TRANSPORT_DATABASE_SUBSTITUTION')
  }
}

function decodeRunResult(
  request: ChronologWorkerdClientRunRequest,
  executionKey: Uint8Array,
  value: WorkerdDatabaseReducerRunResult,
): ChronologWorkerdBundleExecutionResponse {
  const applicationBytes = decodeDatabaseReducerByteString(value.canonicalOutput)
  const application = decodeChronologReducerApplicationResult(applicationBytes)
  if (value.databases.length !== 1 ||
      value.databases[0]?.logicalName !== application.databaseSelector) {
    throw new ChronologWorkerdContractError('CHRONOLOG_WORKER_RESULT_SELECTOR_MISMATCH')
  }
  const selected = value.databases[0]
  if (application.databaseSelector === 'checkpoint' &&
      application.selectedSource !== 'materialized') {
    throw new ChronologWorkerdContractError('CHRONOLOG_CHECKPOINT_SELECTS_PRIVATE_OUTPUT')
  }
  const source = request.inputs.find((input) => input.name === application.selectedSource) ??
    (application.selectedSource === 'materialized'
      ? request.inputs.find((input) => input.name === request.outputSource)
      : undefined)
  if (source === undefined) {
    throw new ChronologWorkerdContractError('CHRONOLOG_WORKER_RESULT_SOURCE_MISSING')
  }
  const expectedAlias = application.selectedSource === 'materialized'
    ? 'materialized_db'
    : source.sqlAlias
  if (selected.sqlAlias !== expectedAlias) {
    throw new ChronologWorkerdContractError('CHRONOLOG_WORKER_RESULT_ALIAS_MISMATCH')
  }
  const exact = exactFromTransport(selected.database, source.exact)
  return {
    executionKey: executionKey.slice(),
    application,
    outputs: [{ name: application.databaseSelector, ref: exact }],
    transportOutputs: [cloneTransportOutput(selected)],
  }
}

function exactFromTransport(
  value: WorkerdDatabaseReducerDatabaseRefValue,
  source: ExactDatabaseRef,
): ExactDatabaseRef {
  const storeId = fromHex(value.repositoryRoot.storeId, 'storeId')
  if (!sameBytes(storeId, source.storeId) ||
      value.doltFormatVersion !== source.doltFormatVersion ||
      value.stateFormatVersion !== source.stateDigest.stateFormatVersion) {
    throw new ChronologWorkerdContractError('CHRONOLOG_RESULT_DATABASE_LINEAGE_MISMATCH')
  }
  const commitDigest = fromHex(value.commitHash, 'commitHash')
  const stateDigest = fromHex(value.stateDigest, 'stateDigest')
  if (commitDigest.length !== 20 || stateDigest.length !== source.stateDigest.contentId.digest.length) {
    throw new ChronologWorkerdContractError('CHRONOLOG_RESULT_DATABASE_DIGEST_LENGTH')
  }
  return {
    storeId,
    doltFormatVersion: value.doltFormatVersion,
    canonicalGenesisCommit: {
      doltFormatVersion: source.canonicalGenesisCommit.doltFormatVersion,
      contentId: {
        algorithm: source.canonicalGenesisCommit.contentId.algorithm,
        digest: source.canonicalGenesisCommit.contentId.digest.slice(),
      },
    },
    commitHash: {
      doltFormatVersion: value.doltFormatVersion,
      contentId: { algorithm: 'dolt-blake3-160', digest: commitDigest },
    },
    stateDigest: {
      stateFormatVersion: value.stateFormatVersion,
      contentId: { algorithm: source.stateDigest.contentId.algorithm, digest: stateDigest },
    },
  }
}

function cloneTransportDatabase(
  value: WorkerdDatabaseReducerDatabaseRefValue,
): WorkerdDatabaseReducerDatabaseRefValue {
  return {
    repositoryRoot: { ...value.repositoryRoot },
    doltFormatVersion: value.doltFormatVersion,
    commitHash: value.commitHash,
    stateFormatVersion: value.stateFormatVersion,
    stateDigest: value.stateDigest,
  }
}

function cloneTransportOutput(
  value: WorkerdDatabaseReducerRunDatabase,
): WorkerdDatabaseReducerRunDatabase {
  return {
    logicalName: value.logicalName,
    sqlAlias: value.sqlAlias,
    database: cloneTransportDatabase(value.database),
  }
}

function cloneDatabase(value: ExactDatabaseRef): ExactDatabaseRef {
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

function toHex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function fromHex(value: string, field: string): Uint8Array {
  if (value.length === 0 || value.length % 2 !== 0 || !/^[0-9a-f]+$/u.test(value)) {
    throw new ChronologWorkerdContractError(`CHRONOLOG_${field.toUpperCase()}_HEX_INVALID`)
  }
  const result = new Uint8Array(value.length / 2)
  for (let index = 0; index < result.length; index += 1) {
    result[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16)
  }
  return result
}
