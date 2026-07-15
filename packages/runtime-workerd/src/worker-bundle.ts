import {
  resolveMaterializationInvocation,
  type ResolvedMaterializationInvocation,
} from '@chronolog/materializer'

import { ChronologWorkerdContractError } from './controller.js'
import {
  createChronologBundledObjectReader,
  decodeChronologReducerInvocationBundle,
  encodeChronologReducerApplicationResult,
  type ChronologReducerDatabaseSelector,
  type ChronologReducerSelectedSource,
} from './worker-codec.js'

export type DatabaseReducerValue = null | boolean | string | number | bigint | Uint8Array |
  readonly DatabaseReducerValue[] | { readonly [key: string]: DatabaseReducerValue }

export interface DatabaseReducerCommitOptions {
  readonly message: string
  readonly authorName: string
  readonly authorEmail: string
  readonly timestamp: string
}

export interface DatabaseReducerOutputStatus {
  readonly logicalName: string
  readonly sqlAlias: string
  readonly headCommit: string
  readonly stateDigest: string
  readonly dirty: boolean
}

export type DatabaseReducerSqlParameter = null | bigint | number | string |
  ArrayBuffer | ArrayBufferView
export type DatabaseReducerSqlValue = null | bigint | number | string | Uint8Array

export interface DatabaseReducerSqlResult {
  readonly columnNames: readonly string[]
  readonly rows: readonly { readonly values: readonly DatabaseReducerSqlValue[] }[]
}

export interface DatabaseReducerInputHandle {
  readonly logicalName: string
  readonly sqlAlias: string
  queryText(sql: string): string
  query(sql: string, parameters?: readonly DatabaseReducerSqlParameter[]): DatabaseReducerSqlResult
}

export interface DatabaseReducerOutputHandle {
  readonly logicalName: string
  readonly sqlAlias: string
  readonly status: DatabaseReducerOutputStatus
  queryText(sql: string): string
  query(sql: string, parameters?: readonly DatabaseReducerSqlParameter[]): DatabaseReducerSqlResult
  execute(sql: string, parameters?: readonly DatabaseReducerSqlParameter[]): DatabaseReducerSqlResult
  transactionSync<T>(callback: () => T): T
  commit(options: DatabaseReducerCommitOptions): string
}

export interface DatabaseReducerDatabasesHandle {
  readonly inputNames: readonly string[]
  readonly outputNames: readonly string[]
  getInput(logicalName: string): DatabaseReducerInputHandle | null
  getOutput(logicalName: string): DatabaseReducerOutputHandle | null
}

export interface DatabaseReducerPureCasObjectRef {
  readonly storeId: string
  readonly codecNumber: number
  readonly codecVersion: number
  readonly hashAlgorithm: string
  readonly digest: string
}

export interface DatabaseReducerPureCasHandle {
  get(object: DatabaseReducerPureCasObjectRef): Promise<Uint8Array>
}

export interface DatabaseReducerInvocationContextHandle {
  readonly cas: DatabaseReducerPureCasHandle
  waitUntil(promise: Promise<void>): void
  randomBytes(byteCount: number): Uint8Array
}

export interface DatabaseReducerHandlerResult {
  readonly databases: Readonly<Record<string, DatabaseReducerInputHandle | DatabaseReducerOutputHandle>>
  readonly output: DatabaseReducerValue
}

export interface ChronologReducerKernelContext {
  readonly previous: DatabaseReducerInputHandle | null
  readonly replayBase: DatabaseReducerInputHandle
  readonly materialized: DatabaseReducerOutputHandle
  readonly invocation: DatabaseReducerInvocationContextHandle
}

export interface ChronologReducerKernelResult {
  readonly databaseSelector: ChronologReducerDatabaseSelector
  readonly selectedSource: ChronologReducerSelectedSource
  /** Canonical domain payload. Its schema is owned by the materializer kernel. */
  readonly payload: Uint8Array
}

/**
 * Workerd-facing form of the portable materializer kernel. It consumes the
 * same fully resolved invocation as the backend-neutral kernel, but receives
 * the exact named database handles that may be used inside this invocation.
 */
export interface ChronologReducerBundleKernel {
  materialize(
    input: ResolvedMaterializationInvocation,
    context: ChronologReducerKernelContext,
  ): Promise<ChronologReducerKernelResult>
}

export interface ChronologReducerWorkerModule<Env = unknown> {
  reduce(
    databases: DatabaseReducerDatabasesHandle,
    input: unknown,
    env: Env,
    ctx: DatabaseReducerInvocationContextHandle,
  ): Promise<DatabaseReducerHandlerResult>
}

/**
 * Creates a modules-syntax Worker object that can be exported directly as a
 * reducer service. `env` is accepted because standard workerd reducers retain
 * ordinary Worker bindings; Chronolog's pure kernel does not observe it.
 */
export function createChronologReducerWorkerModule<Env = unknown>(
  kernel: ChronologReducerBundleKernel,
): ChronologReducerWorkerModule<Env> {
  return {
    async reduce(databases, input, _env, ctx): Promise<DatabaseReducerHandlerResult> {
      return reduceChronologMaterialization(databases, input, ctx, kernel)
    },
  }
}

/** Three-argument typed reducer core used by the modules-syntax adapter. */
export async function reduceChronologMaterialization(
  databases: DatabaseReducerDatabasesHandle,
  input: unknown,
  ctx: DatabaseReducerInvocationContextHandle,
  kernel: ChronologReducerBundleKernel,
): Promise<DatabaseReducerHandlerResult> {
  if (!(input instanceof Uint8Array)) {
    throw new ChronologWorkerdContractError('CHRONOLOG_REDUCER_INPUT_BYTES_REQUIRED')
  }
  const bundle = decodeChronologReducerInvocationBundle(input)
  const invocation = await resolveMaterializationInvocation(
    bundle.invocation,
    createChronologBundledObjectReader(bundle),
  )
  const previous = invocation.invocation.previous === null
    ? null
    : requireInput(databases, 'previous')
  const replayBase = requireInput(databases, 'replayBase')
  const materialized = requireOutput(databases, 'materialized')
  assertNamedHandles(databases, previous !== null)

  const result = await kernel.materialize(invocation, {
    previous,
    replayBase,
    materialized,
    invocation: ctx,
  })
  const selected = selectDatabase(result.selectedSource, previous, replayBase, materialized)
  if (result.databaseSelector === 'checkpoint' && result.selectedSource !== 'materialized') {
    throw new ChronologWorkerdContractError('CHRONOLOG_CHECKPOINT_SELECTS_PRIVATE_OUTPUT')
  }
  return {
    databases: { [result.databaseSelector]: selected },
    output: encodeChronologReducerApplicationResult({
      version: 1,
      databaseSelector: result.databaseSelector,
      selectedSource: result.selectedSource,
      payload: result.payload,
      exactReadSet: invocation.exactReadSet,
    }),
  }
}

function requireInput(
  databases: DatabaseReducerDatabasesHandle,
  name: 'previous' | 'replayBase',
): DatabaseReducerInputHandle {
  const input = databases.getInput(name)
  if (input === null || input.logicalName !== name) {
    throw new ChronologWorkerdContractError(`CHRONOLOG_${name.toUpperCase()}_HANDLE_MISSING`)
  }
  return input
}

function requireOutput(
  databases: DatabaseReducerDatabasesHandle,
  name: 'materialized',
): DatabaseReducerOutputHandle {
  const output = databases.getOutput(name)
  if (output === null || output.logicalName !== name) {
    throw new ChronologWorkerdContractError('CHRONOLOG_MATERIALIZED_HANDLE_MISSING')
  }
  return output
}

function assertNamedHandles(databases: DatabaseReducerDatabasesHandle, hasPrevious: boolean): void {
  const expectedInputs = hasPrevious ? ['previous', 'replayBase'] : ['replayBase']
  if (!sameNames(databases.inputNames, expectedInputs) ||
      !sameNames(databases.outputNames, ['materialized'])) {
    throw new ChronologWorkerdContractError('CHRONOLOG_REDUCER_NAMED_HANDLE_SET_MISMATCH')
  }
}

function sameNames(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length &&
    [...actual].sort().every((name, index) => name === [...expected].sort()[index])
}

function selectDatabase(
  source: ChronologReducerSelectedSource,
  previous: DatabaseReducerInputHandle | null,
  replayBase: DatabaseReducerInputHandle,
  materialized: DatabaseReducerOutputHandle,
): DatabaseReducerInputHandle | DatabaseReducerOutputHandle {
  if (source === 'materialized') return materialized
  if (source === 'replayBase') return replayBase
  if (previous === null) {
    throw new ChronologWorkerdContractError('CHRONOLOG_PREVIOUS_SELECTION_WITHOUT_INPUT')
  }
  return previous
}
