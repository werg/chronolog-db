import type { NodeStatus } from '@chronolog/node-core'

export interface DaemonHealth {
  readonly ok: boolean
  readonly state: 'ready' | 'replaying' | 'degraded' | 'stopping'
  readonly materializedRevision: string
  readonly orderLength: number
  readonly materializationPending: boolean
  readonly feedsWithGaps: number
  readonly lastError?: string
}

export function daemonHealth(status: NodeStatus, stopping = false): DaemonHealth {
  const feedsWithGaps = status.transport.feedsWithGaps ?? 0
  const degraded = status.lastError !== undefined || status.transport.lastCatchUpError !== undefined ||
    feedsWithGaps > 0 || status.quarantinedFeeds.length > 0
  const state = stopping
    ? 'stopping'
    : degraded
      ? 'degraded'
      : status.materializationPending
        ? 'replaying'
        : 'ready'
  return {
    ok: state === 'ready' || state === 'replaying',
    state,
    materializedRevision: status.materializedRevision.toString(),
    orderLength: status.orderLength,
    materializationPending: status.materializationPending,
    feedsWithGaps,
    ...(status.lastError === undefined && status.transport.lastCatchUpError === undefined ? {} : {
      lastError: status.lastError ?? status.transport.lastCatchUpError,
    }),
  }
}

export function prometheusMetrics(status: NodeStatus): string {
  const memory = process.memoryUsage()
  const health = daemonHealth(status)
  return `${[
    '# HELP chronolog_up Whether the daemon is operational.',
    '# TYPE chronolog_up gauge',
    `chronolog_up ${health.ok ? 1 : 0}`,
    '# HELP chronolog_materialized_revision Current materialized revision.',
    '# TYPE chronolog_materialized_revision gauge',
    `chronolog_materialized_revision ${status.materializedRevision.toString()}`,
    '# HELP chronolog_order_length Number of transactions in canonical order.',
    '# TYPE chronolog_order_length gauge',
    `chronolog_order_length ${status.orderLength}`,
    '# HELP chronolog_candidates Candidate records known locally.',
    '# TYPE chronolog_candidates gauge',
    `chronolog_candidates ${status.candidates}`,
    '# HELP chronolog_admitted Admitted transactions known locally.',
    '# TYPE chronolog_admitted gauge',
    `chronolog_admitted ${status.admitted}`,
    '# HELP chronolog_transport_records Durable transport records processed.',
    '# TYPE chronolog_transport_records counter',
    `chronolog_transport_records ${status.processedTransportRecords}`,
    '# HELP chronolog_materialization_pending Whether replay work is pending.',
    '# TYPE chronolog_materialization_pending gauge',
    `chronolog_materialization_pending ${status.materializationPending ? 1 : 0}`,
    '# HELP chronolog_transport_feeds_with_gaps Replicated feeds with missing prefixes.',
    '# TYPE chronolog_transport_feeds_with_gaps gauge',
    `chronolog_transport_feeds_with_gaps ${status.transport.feedsWithGaps ?? 0}`,
    '# HELP chronolog_quarantined_feeds Feeds quarantined after continuity conflicts.',
    '# TYPE chronolog_quarantined_feeds gauge',
    `chronolog_quarantined_feeds ${status.quarantinedFeeds.length}`,
    '# HELP process_resident_memory_bytes Resident memory used by chronologd.',
    '# TYPE process_resident_memory_bytes gauge',
    `process_resident_memory_bytes ${memory.rss}`,
    '# HELP process_heap_used_bytes JavaScript heap used by chronologd.',
    '# TYPE process_heap_used_bytes gauge',
    `process_heap_used_bytes ${memory.heapUsed}`,
  ].join('\n')}\n`
}
