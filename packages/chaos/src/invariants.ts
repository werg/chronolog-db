import type { DecodedLogicalValue } from '@chronolog/client'

import type { RunArtifacts } from './artifacts.js'
import type { ChaosCluster } from './cluster.js'
import { stateQuery, transactionLogQuery } from './schema.js'
import type { NodeSnapshot } from './types.js'

export interface ConvergenceResult {
  readonly snapshots: readonly NodeSnapshot[]
  readonly invariants: readonly { readonly name: string; readonly passed: boolean; readonly details?: string }[]
}

export async function waitForConvergence(options: {
  readonly cluster: ChaosCluster
  readonly artifacts: RunArtifacts
  readonly timeoutMs: number
  readonly expectedTransactionIds: readonly string[]
}): Promise<ConvergenceResult> {
  const deadline = Date.now() + options.timeoutMs
  let last: readonly NodeSnapshot[] = []
  let stable = 0
  let previousSignature = ''
  let lastError: unknown
  let coverage = { admitted: 0, excluded: 0, unresolved: options.expectedTransactionIds.length }
  while (Date.now() < deadline) {
    try {
      last = await Promise.all(options.cluster.clients().map(({ name, client }) => snapshotNode(name, client)))
      const signature = last.map((snapshot) => `${snapshot.node}:${snapshot.stateDigest}:${snapshot.logDigest}:${snapshot.publishedOrderLength}`).join('|')
      const converged = same(last.map((snapshot) => snapshot.stateDigest)) &&
        same(last.map((snapshot) => snapshot.logDigest)) &&
        same(last.map((snapshot) => snapshot.publishedOrderLength)) &&
        last.every((snapshot) => !snapshot.replaying && snapshot.pendingPayloads === 0 && backlogSettled(snapshot) && !snapshot.materializationPending)
      stable = converged && signature === previousSignature ? stable + 1 : converged ? 1 : 0
      previousSignature = signature
      if (stable >= 3) {
        coverage = await transactionCoverage(options.cluster, options.expectedTransactionIds, last[0]?.logRows ?? [])
        if (coverage.unresolved === 0) break
      }
    } catch (error) { lastError = error; stable = 0 }
    await delay(500)
  }
  if (stable < 3 || coverage.unresolved > 0) {
    if (last.length > 0) {
      await options.artifacts.writeJson('snapshots.last.json', last)
      try { coverage = await transactionCoverage(options.cluster, options.expectedTransactionIds, last[0]?.logRows ?? []) } catch { /* Keep the last successful coverage. */ }
    }
    const nodes = last.map((snapshot) => `${snapshot.node}:status=${snapshot.status}${snapshot.lastErrorCode ? `(${snapshot.lastErrorCode})` : ''},state=${snapshot.stateDigest.slice(0, 10)},log=${snapshot.logDigest.slice(0, 10)},order=${snapshot.publishedOrderLength},peers=${snapshot.connectedPeers}/${snapshot.knownPeers},payloads=${snapshot.pendingPayloads},ingest=${snapshot.ingestionBacklog},materializing=${snapshot.materializationPending}`).join(';')
    const details = `stable=${stable},admitted=${coverage.admitted},excluded=${coverage.excluded},unresolved=${coverage.unresolved}${nodes.length > 0 ? `,nodes=[${nodes}]` : ''}${lastError instanceof Error ? `,lastError=${lastError.message}` : ''}`
    await options.artifacts.record({ type: 'invariant', phase: 'failure', name: 'convergence_timeout', details: { explanation: details } })
    throw new Error(`CHAOS_CONVERGENCE_TIMEOUT:${details}`)
  }

  const logRows = last[0]?.logRows ?? []
  const terminalOutcomes = logRows.every((row) => row[4] === 'accepted' || (typeof row[4] === 'string' && row[4].startsWith('rejected_')))
  const invariants = [
    { name: 'application_state_converged', passed: same(last.map((snapshot) => snapshot.stateDigest)) },
    { name: 'transaction_log_converged', passed: same(last.map((snapshot) => snapshot.logDigest)) },
    { name: 'transaction_order_length_converged', passed: same(last.map((snapshot) => snapshot.publishedOrderLength)) },
    {
      name: 'all_published_transactions_resolved',
      passed: coverage.unresolved === 0,
      details: `${coverage.admitted} admitted, ${coverage.excluded} excluded below validator watermark, ${coverage.unresolved} unresolved`,
    },
    { name: 'all_outcomes_terminal', passed: terminalOutcomes },
    { name: 'workload_made_progress', passed: options.expectedTransactionIds.length > 0, ...(options.expectedTransactionIds.length > 0 ? {} : { details: 'No transaction was published' }) },
  ]
  for (const invariant of invariants) {
    await options.artifacts.record({
      type: 'invariant', phase: invariant.passed ? 'success' : 'failure', name: invariant.name,
      ...(invariant.details === undefined ? {} : { details: { explanation: invariant.details } }),
    })
  }
  return { snapshots: last, invariants }
}

async function snapshotNode(
  node: NodeSnapshot['node'],
  client: ReturnType<ChaosCluster['client']>,
): Promise<NodeSnapshot> {
  const [status, replication, state, log] = await Promise.all([
    client.getStatus(),
    client.getReplicationStatus(),
    client.query(stateQuery()),
    client.query(transactionLogQuery()),
  ])
  if (!status.revision) throw new Error(`CHAOS_NODE_NOT_READY:${node}`)
  return {
    node,
    status: status.state,
    ...(status.lastErrorCode === undefined ? {} : { lastErrorCode: status.lastErrorCode }),
    stateDigest: state.canonical.resultDigest,
    logDigest: log.canonical.resultDigest,
    stateRows: state.result.rows.map(normalizeRow),
    logRows: log.result.rows.map(normalizeRow),
    eventSetRevision: status.revision.eventSetRevision,
    materializedRevision: status.revision.materializedRevision,
    publishedOrderLength: status.revision.publishedOrderLength,
    replaying: status.revision.replaying,
    connectedPeers: replication.connectedPeers,
    knownPeers: replication.knownPeers,
    pendingPayloads: replication.pendingPayloads,
    ingestionBacklog: replication.ingestionBacklog,
    materializationPending: replication.materializationPending,
  }
}

function normalizeRow(row: readonly DecodedLogicalValue[]): readonly unknown[] {
  return row.map((value) => value instanceof Uint8Array
    ? { bytes: Buffer.from(value).toString('base64url') }
    : typeof value === 'bigint' ? value.toString(10) : value)
}

function bytesText(value: unknown): string {
  if (typeof value === 'object' && value !== null && 'bytes' in value && typeof (value as { bytes?: unknown }).bytes === 'string') {
    return (value as { bytes: string }).bytes
  }
  return String(value)
}

async function transactionCoverage(
  cluster: ChaosCluster,
  transactionIds: readonly string[],
  logRows: readonly (readonly unknown[])[],
): Promise<{ admitted: number; excluded: number; unresolved: number }> {
  const admittedIds = new Set(logRows.map((row) => bytesText(row[0])))
  const missing = transactionIds.filter((id) => !admittedIds.has(Buffer.from(id).toString('base64url')))
  let excluded = 0
  await mapConcurrent(missing, 16, async (transactionId) => {
    for (const { client } of cluster.clients()) {
      try {
        const evidence = await client.getSettlementEvidence(transactionId)
        if (evidence.confidence === 'policy_watermark_reached') { excluded += 1; return }
      } catch { /* A peer may not have received this candidate yet. */ }
    }
  })
  return { admitted: transactionIds.length - missing.length, excluded, unresolved: missing.length - excluded }
}

async function mapConcurrent<T>(values: readonly T[], concurrency: number, visit: (value: T) => Promise<void>): Promise<void> {
  let index = 0
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (index < values.length) {
      const value = values[index++]
      if (value !== undefined) await visit(value)
    }
  }))
}

function same(values: readonly string[]): boolean { return values.length > 0 && values.every((value) => value === values[0]) }
// Every remote validator emits a heartbeat once per second. A small durable
// tail is therefore normal even in a converged cluster; large or growing tails
// still identify reducer backpressure (the stress regression exceeded 400).
function backlogSettled(snapshot: NodeSnapshot): boolean {
  return snapshot.ingestionBacklog <= Math.max(4, snapshot.knownPeers * 2)
}
function delay(milliseconds: number): Promise<void> { return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds)) }
