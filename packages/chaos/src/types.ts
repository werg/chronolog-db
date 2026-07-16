export type NodeName = `node-${number}`
export type LinkName = `${NodeName}->${NodeName}`

export const WORKLOAD_OPERATION_KINDS = [
  'migration_chain',
  'migration_rollback',
  'legacy_client_write',
  'current_client_write',
  'balance_update',
  'transfer',
  'ordered_touch',
  'empty_returning',
  'document_insert',
  'ddl_sequence',
  'precondition_rejection',
  'constraint_rejection',
] as const
export type WorkloadOperationKind = typeof WORKLOAD_OPERATION_KINDS[number]

export interface WorkloadSpec {
  readonly workers: number
  readonly intervalMs: number
  readonly accounts: number
  readonly minimumDelta: number
  readonly maximumDelta: number
  readonly maximumTransfer?: number
  readonly resultSampleSize?: number
  readonly operationWeights?: Partial<Readonly<Record<WorkloadOperationKind, number>>>
}

export interface WorkloadExpectation {
  readonly transactionId: string
  readonly operationId: string
  readonly operation: WorkloadOperationKind
  readonly allowedOutcomes: readonly ('accepted' | 'rejected_precondition' | 'rejected_execution')[]
  readonly rejectionCode?: string
  readonly failingStatementIndex?: number
  readonly migrationPrefix?: string
}

export type FaultSpec =
  | { readonly atMs: number; readonly durationMs: number; readonly kind: 'partition'; readonly groups: readonly (readonly NodeName[])[] }
  | { readonly atMs: number; readonly durationMs: number; readonly kind: 'latency'; readonly links: readonly LinkName[] | 'all'; readonly latencyMs: number; readonly jitterMs: number }
  | { readonly atMs: number; readonly durationMs: number; readonly kind: 'bandwidth'; readonly links: readonly LinkName[] | 'all'; readonly rateKbps: number }
  | { readonly atMs: number; readonly durationMs: number; readonly kind: 'timeout'; readonly links: readonly LinkName[] | 'all'; readonly timeoutMs: number }
  | { readonly atMs: number; readonly kind: 'reset'; readonly links: readonly LinkName[] | 'all'; readonly resetAfterMs: number }
  | { readonly atMs: number; readonly durationMs: number; readonly kind: 'pause'; readonly node: NodeName }
  | { readonly atMs: number; readonly durationMs: number; readonly kind: 'crash'; readonly node: NodeName }
  | { readonly atMs: number; readonly kind: 'restart'; readonly node: NodeName }
  | { readonly atMs: number; readonly durationMs: number; readonly kind: 'cpu'; readonly node: NodeName; readonly cores: number }

export interface ChaosScenario {
  readonly format: 'chronolog-chaos-scenario'
  readonly name: string
  readonly description: string
  readonly nodes: number
  readonly threshold: number
  readonly durationMs: number
  readonly convergenceTimeoutMs: number
  readonly checkpointEvery: number
  readonly cutoffLagMs: number
  readonly workload: WorkloadSpec
  readonly faults: readonly FaultSpec[]
}

export interface HistoryEvent {
  readonly sequence: number
  readonly elapsedMs: number
  readonly wallTime: string
  readonly type: 'run' | 'fault' | 'operation' | 'invariant'
  readonly phase: 'start' | 'success' | 'failure' | 'heal' | 'info'
  readonly name: string
  readonly node?: NodeName
  readonly transactionId?: string
  readonly details?: Readonly<Record<string, unknown>>
  readonly error?: string
}

export interface NodeSnapshot {
  readonly node: NodeName
  readonly status: 'starting' | 'ready' | 'replaying' | 'degraded' | 'stopping'
  readonly lastErrorCode?: string
  readonly stateDigest: string
  readonly schemaDigest: string
  readonly logDigest: string
  readonly stateRows: readonly (readonly unknown[])[]
  readonly schemaRows: readonly (readonly unknown[])[]
  readonly logRows: readonly (readonly unknown[])[]
  readonly eventSetRevision: string
  readonly materializedRevision: string
  readonly publishedOrderLength: string
  readonly replaying: boolean
  readonly connectedPeers: number
  readonly knownPeers: number
  readonly pendingPayloads: number
  readonly ingestionBacklog: number
  readonly materializationPending: boolean
}

export interface NodeResourceSample {
  readonly node: NodeName
  readonly containerId: string
  readonly state: string
  readonly restartCount: number
  readonly cpuPercent?: number
  readonly memoryBytes?: number
  readonly memoryLimitBytes?: number
  readonly networkRxBytes?: number
  readonly networkTxBytes?: number
  readonly blockReadBytes?: number
  readonly blockWriteBytes?: number
  readonly error?: string
}

export interface ResourceSample {
  readonly elapsedMs: number
  readonly wallTime: string
  readonly nodes: readonly NodeResourceSample[]
}

export interface RunSummary {
  readonly format: 'chronolog-chaos-result'
  readonly scenario: string
  readonly seed: string
  readonly startedAt: string
  readonly finishedAt: string
  readonly elapsedMs: number
  readonly passed: boolean
  readonly operations: {
    readonly attempted: number
    readonly published: number
    readonly failed: number
    readonly byKind: Readonly<Partial<Record<WorkloadOperationKind, number>>>
  }
  readonly invariants: readonly { readonly name: string; readonly passed: boolean; readonly details?: string }[]
  readonly snapshots: readonly NodeSnapshot[]
  readonly failure?: string
  readonly replayCommand: string
}
