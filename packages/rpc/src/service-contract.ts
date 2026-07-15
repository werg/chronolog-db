import type {
  CanonicalQueryResult,
  IrDiagnostic as CompilerDiagnostic,
  Mutation,
  Query,
  TransactionProgram,
} from '@chronolog/ir'

import type { LocalSqlValue } from './types.js'

export interface DraftExecutionContext {
  readonly groupId: Uint8Array
  readonly membershipRevision: Uint8Array
  readonly validationPolicy: Uint8Array
  readonly authorId: Uint8Array
  readonly authorTimestampMs: bigint
  readonly transactionNonce: Uint8Array
}

export interface IrQueryExecution {
  readonly revision: bigint
  readonly orderLength: number
  readonly schemaDigest: Uint8Array
  readonly executionManifestDigest: Uint8Array
  readonly result: CanonicalQueryResult
}

export interface LocalSqlExecution {
  readonly revision: bigint
  readonly orderLength: number
  readonly columns: readonly { readonly name: string; readonly declaredType?: string }[]
  readonly rows: readonly (readonly LocalSqlValue[])[]
}

/** Immutable query/validation boundary consumed by RPC. */
export interface NodeRpcIrBackend {
  readonly revision: bigint
  readonly orderLength: number
  readonly schemaDigest: Uint8Array
  readonly executionManifestDigest: Uint8Array
  query(query: Query, options: {
    readonly atRevision: bigint
    readonly context?: DraftExecutionContext
  }): IrQueryExecution | Promise<IrQueryExecution>
  localQuery(
    sql: string,
    parameters: readonly LocalSqlValue[],
    options: { readonly atRevision: bigint },
  ): LocalSqlExecution | Promise<LocalSqlExecution>
  validateQuery(query: Query): readonly CompilerDiagnostic[]
  validateMutation(mutation: Mutation): readonly CompilerDiagnostic[]
}

export interface RpcNodeCandidate {
  readonly state: string
  readonly orderKey: {
    readonly authorTimestampMs: bigint
    readonly authorId: Uint8Array
    readonly authorFeedSequence: bigint
    readonly txId: Uint8Array
  }
}

export interface RpcNodeCandidateCore {
  readonly authorTimestampMs: bigint
  readonly validationPolicy: Uint8Array
  readonly membershipRevision: Uint8Array
  readonly program: { readonly metadata?: ReadonlyMap<string, Uint8Array> }
}

export interface RpcNodeSettlementEvidence {
  readonly historyReopeningIds: readonly string[]
  readonly unresolvedAttestationIds: readonly Uint8Array[]
  readonly belowWatermark: boolean
  readonly watermark: {
    readonly cutoffMs: bigint | null
    readonly heartbeatIds: readonly Uint8Array[]
  }
}

export interface RpcNodeWatermark {
  readonly policyId: string
  readonly cutoffMs: bigint | null
  readonly blockingValidatorIds: readonly Uint8Array[]
  readonly explanation: string
}

export interface RpcNodeStatusSnapshot {
  readonly started: boolean
  readonly materializedRevision: bigint
  readonly orderLength: number
  readonly validating: boolean
  readonly processedTransportRecords: number
  readonly materializationPending: boolean
  readonly lastError?: string
  readonly transport: {
    readonly records: number
    readonly peers: readonly string[]
    readonly configuredPeers?: readonly unknown[]
    readonly feedsWithGaps?: number
    readonly feedStates?: readonly { readonly hasGaps: boolean }[]
    readonly lastCatchUpError?: string
  }
}

/**
 * Narrow application-service contract for RPC. It intentionally contains no
 * transport implementation, materializer class, or node lifecycle constructor.
 */
export interface ChronologRpcNodeService {
  readonly identity: Uint8Array
  readonly groupId: Uint8Array
  readonly membershipRevision: Uint8Array
  readonly validationPolicy: Uint8Array
  readonly revision: bigint
  readonly materializedRevision: bigint
  readonly orderLength: number
  readonly schemaDigest: Uint8Array
  readonly executionManifestDigest: Uint8Array
  readonly controlStore: {
    listCandidates(): readonly { readonly state: string }[]
    snapshot(): {
      readonly historyReopenings: readonly {
        readonly id: string
        readonly floorMs: bigint
        readonly membershipRevision: Uint8Array
      }[]
    }
  }
  reserveTransactionContext(): { readonly authorTimestampMs: bigint; readonly nonce: Uint8Array }
  publish(input: {
    readonly program: TransactionProgram
    readonly authorTimestampMs: bigint
    readonly nonce: Uint8Array
  }): Promise<{
    readonly txId: Uint8Array
    readonly txIdText: string
    readonly candidateDigest: Uint8Array
    readonly core: {
      readonly authorTimestampMs: bigint
      readonly nonce: Uint8Array
    }
  }>
  status(): Promise<RpcNodeStatusSnapshot>
  isWritable(): Promise<boolean>
  candidate(txId: Uint8Array): RpcNodeCandidate | null
  candidateCore(txId: Uint8Array): RpcNodeCandidateCore | null
  outcome(txId: Uint8Array): unknown
  outcomeChangedByReplay(txId: Uint8Array): boolean
  settlementEvidence(txId: Uint8Array): Promise<RpcNodeSettlementEvidence | null>
  watermark(): Promise<RpcNodeWatermark | null>
  events(afterRevision?: bigint, signal?: AbortSignal): AsyncIterable<unknown>
  queryIr(query: Query, options?: {
    readonly atRevision?: bigint
    readonly context?: DraftExecutionContext
  }): IrQueryExecution | Promise<IrQueryExecution>
  localSql(
    sql: string,
    parameters?: readonly LocalSqlValue[],
    options?: { readonly atRevision?: bigint },
  ): LocalSqlExecution
  validateQuery(query: Query): readonly CompilerDiagnostic[]
  validateMutation(mutation: Mutation): readonly CompilerDiagnostic[]
}
