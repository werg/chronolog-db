import type {
  CanonicalSqlResult,
  SqlResultMode,
  SqlStatement,
  SqlTransactionProgram,
  TransactionResultEnvelopeV1,
} from '@chronolog/protocol'

import type { LocalSqlValue } from './types.js'

export interface SqlObservationExecution {
  readonly revision: bigint
  readonly orderLength: number
  readonly executionManifestDigest: Uint8Array
  readonly statement: SqlStatement
  readonly result: CanonicalSqlResult
  readonly resultDigest: Uint8Array
}

export interface LocalSqlExecution {
  readonly revision: bigint
  readonly orderLength: number
  readonly columns: readonly { readonly name: string; readonly declaredType?: string }[]
  readonly rows: readonly (readonly LocalSqlValue[])[]
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
  readonly program: SqlTransactionProgram
}

export interface RpcNodeSettlementEvidence {
  readonly historyReopeningIds: readonly string[]
  readonly unresolvedAttestationIds: readonly Uint8Array[]
  readonly belowWatermark: boolean
  readonly watermark: { readonly cutoffMs: bigint | null; readonly heartbeatIds: readonly Uint8Array[] }
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
  readonly quarantinedFeeds: readonly string[]
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

export interface RpcMaterializedOutcome {
  readonly outcome: 'accepted' | 'rejected_precondition' | 'rejected_execution'
  readonly rejectionCode: string | null
  readonly failingPreconditionId: number | null
  readonly failingPreconditionIndex: number | null
  readonly failingStatementIndex: number | null
  readonly failurePhase: 'precondition' | 'statement' | 'finalize' | null
  readonly failingConstraintIdentity: Uint8Array | null
  readonly failingTriggerIdentity: Uint8Array | null
  readonly resultEnvelopeVersion: 1 | null
  readonly resultEnvelope: Uint8Array | null
  readonly resultDigest: Uint8Array | null
}

export interface ChronologRpcNodeService {
  readonly identity: Uint8Array
  readonly groupId: Uint8Array
  readonly membershipRevision: Uint8Array
  readonly validationPolicy: Uint8Array
  readonly revision: bigint
  readonly materializedRevision: bigint
  readonly orderLength: number
  readonly executionManifestDigest: Uint8Array
  readonly controlStore: {
    listCandidates(): readonly { readonly state: string }[]
    snapshot(): { readonly historyReopenings: readonly { readonly id: string; readonly floorMs: bigint; readonly membershipRevision: Uint8Array }[] }
  }
  reserveTransactionContext(): { readonly authorTimestampMs: bigint; readonly nonce: Uint8Array }
  publish(input: { readonly program: SqlTransactionProgram; readonly authorTimestampMs: bigint; readonly nonce: Uint8Array }): Promise<{
    readonly txId: Uint8Array
    readonly txIdText: string
    readonly candidateDigest: Uint8Array
    readonly core: { readonly authorTimestampMs: bigint; readonly nonce: Uint8Array }
  }>
  status(): Promise<RpcNodeStatusSnapshot>
  isWritable(): Promise<boolean>
  candidate(txId: Uint8Array): RpcNodeCandidate | null
  candidateCore(txId: Uint8Array): RpcNodeCandidateCore | null
  outcome(txId: Uint8Array): RpcMaterializedOutcome | null
  transactionResult(txId: Uint8Array): TransactionResultEnvelopeV1 | null
  outcomeChangedByReplay(txId: Uint8Array): boolean
  settlementEvidence(txId: Uint8Array): Promise<RpcNodeSettlementEvidence | null>
  watermark(): Promise<RpcNodeWatermark | null>
  events(afterRevision?: bigint, signal?: AbortSignal): AsyncIterable<unknown>
  observe(statement: SqlStatement, options: { readonly atRevision?: bigint; readonly resultMode: SqlResultMode }): SqlObservationExecution | Promise<SqlObservationExecution>
  localSql(sql: string, parameters?: readonly LocalSqlValue[], options?: { readonly atRevision?: bigint }): LocalSqlExecution
  validateStatement(statement: SqlStatement, mode: 'precondition' | 'body'): readonly { readonly code: string; readonly startByte?: number; readonly endByte?: number }[]
  validateProgram(program: SqlTransactionProgram): void
}
