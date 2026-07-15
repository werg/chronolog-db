import type {
  ChronologArtifactKind,
  ChronologMaterializationOutcome,
  ExactArtifactRef,
  ExactDatabaseRef,
  ExactObjectRef,
  ResolvedMaterializationInvocation,
} from '@chronolog/materializer'

export type ChronologDatabaseInputName = 'previous' | 'replayBase'
export type ChronologPrivateOutputName = 'materialized'
export type ChronologOutputSelector = 'materialized' | 'checkpoint'
export type ChronologArtifactSelector =
  | 'materializationManifest'
  | 'outcomeChanges'
  | 'continuation'

export interface ChronologCompatibilityTuple {
  readonly engineDigest: Uint8Array
  readonly schemaDigest: Uint8Array
  readonly executionManifestDigest: Uint8Array
}

export interface ChronologNamedDatabaseInput<Database> {
  readonly name: ChronologDatabaseInputName
  readonly ref: ExactDatabaseRef
  readonly database: Database
}

export interface ChronologTypedArtifactWrite {
  readonly selector: ChronologArtifactSelector
  readonly kind: ChronologArtifactKind
  readonly formatVersion: number
  readonly canonicalBytes: Uint8Array
}

/**
 * Transport-neutral subset of the reducer host needed by Chronolog. In
 * particular it has no object-existence test, enumeration, ref mutation, or
 * publication operation.
 */
export interface ChronologWorkerdHostContext<Database, PrivateDatabase> {
  readonly compatibility: ChronologCompatibilityTuple
  readonly inputs: ReadonlyMap<ChronologDatabaseInputName, ChronologNamedDatabaseInput<Database>>
  readExact(ref: ExactObjectRef): Promise<Uint8Array>
  createPrivateOutput(request: {
    readonly name: ChronologPrivateOutputName
    readonly from: ChronologDatabaseInputName
  }): Promise<PrivateDatabase>
  writeTypedArtifact(request: ChronologTypedArtifactWrite): Promise<ExactArtifactRef>
  finalizePrivateOutput(request: {
    readonly name: ChronologPrivateOutputName
    readonly output: PrivateDatabase
  }): Promise<ExactDatabaseRef>
  checkpointPrivateOutput(request: {
    readonly selector: 'checkpoint'
    readonly output: PrivateDatabase
    readonly nextOrderIndex: number
  }): Promise<ExactDatabaseRef>
}

export interface ChronologWorkerdKernelContext<Database, PrivateDatabase> {
  readonly inputs: ReadonlyMap<ChronologDatabaseInputName, ChronologNamedDatabaseInput<Database>>
  readExact(ref: ExactObjectRef): Promise<Uint8Array>
  createPrivateOutput(request: {
    readonly name: ChronologPrivateOutputName
    readonly from: ChronologDatabaseInputName
  }): Promise<PrivateDatabase>
  writeTypedArtifact(request: ChronologTypedArtifactWrite): Promise<ExactArtifactRef>
  finalizePrivateOutput(request: {
    readonly name: ChronologPrivateOutputName
    readonly output: PrivateDatabase
  }): Promise<ExactDatabaseRef>
  checkpointPrivateOutput(request: {
    readonly selector: 'checkpoint'
    readonly output: PrivateDatabase
    readonly nextOrderIndex: number
  }): Promise<ExactDatabaseRef>
}

/** The database implementation is injected until the workerd JSG surface executes it. */
export interface ChronologWorkerdDatabaseKernel<Database, PrivateDatabase> {
  materialize(
    input: ResolvedMaterializationInvocation,
    context: ChronologWorkerdKernelContext<Database, PrivateDatabase>,
  ): Promise<ChronologMaterializationOutcome>
}

export interface ChronologNamedDatabaseOutput {
  readonly name: ChronologOutputSelector
  readonly ref: ExactDatabaseRef
}

export interface ChronologNamedArtifactOutput {
  readonly name: ChronologArtifactSelector
  readonly ref: ExactArtifactRef
}

export interface ChronologReducerResult {
  readonly version: 1
  readonly compatibility: ChronologCompatibilityTuple
  readonly outputs: readonly ChronologNamedDatabaseOutput[]
  readonly artifacts: readonly ChronologNamedArtifactOutput[]
  readonly applicationResult: Uint8Array
  readonly exactReadSet: readonly ExactObjectRef[]
}

export interface ChronologExecutionRequest {
  readonly version: 1
  readonly executionKey: Uint8Array
  readonly invocation: Uint8Array
  readonly inputs: readonly {
    readonly name: ChronologDatabaseInputName
    readonly ref: ExactDatabaseRef
  }[]
  readonly compatibility: ChronologCompatibilityTuple
}

export interface ChronologExecutionResponse extends ChronologReducerResult {
  readonly executionKey: Uint8Array
}

export interface ChronologReducerCoordinatorClient {
  run(request: ChronologExecutionRequest): Promise<ChronologExecutionResponse>
  follow(executionKey: Uint8Array): Promise<ChronologExecutionResponse | null>
}

export interface ChronologPublicationRequest {
  readonly version: 1
  readonly executionKey: Uint8Array
  readonly refName: string
  readonly selectedOutput: ChronologNamedDatabaseOutput
  readonly expectedCurrent: ExactDatabaseRef | null
}
