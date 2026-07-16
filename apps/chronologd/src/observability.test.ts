import { describe, expect, it } from 'vitest'

import { daemonHealth, prometheusMetrics } from './observability.js'

describe('daemon observability', () => {
  it('reports replay as available and feed gaps as degraded', () => {
    expect(daemonHealth(status({ materializationPending: true }))).toMatchObject({
      ok: true,
      state: 'replaying',
    })
    expect(daemonHealth(status({ feedsWithGaps: 1 }))).toMatchObject({
      ok: false,
      state: 'degraded',
      feedsWithGaps: 1,
    })
  })

  it('renders bounded label-free Prometheus metrics', () => {
    const metrics = prometheusMetrics(status({}))
    expect(metrics).toContain('chronolog_materialized_revision 7\n')
    expect(metrics).toContain('chronolog_order_length 11\n')
    expect(metrics).not.toContain('{')
  })
})

function status(overrides: { readonly materializationPending?: boolean; readonly feedsWithGaps?: number }) {
  return {
    started: true,
    closed: false,
    eventSetRevision: 9n,
    candidates: 12,
    admitted: 11,
    processedTransportRecords: 20,
    materializationPending: overrides.materializationPending ?? false,
    materializedRevision: 7n,
    orderLength: 11,
    executionManifestDigest: new Uint8Array(32),
    validating: true,
    quarantinedFeeds: [],
    transport: {
      identity: '@node.ed25519',
      records: 20,
      closed: false,
      peers: [],
      feedsWithGaps: overrides.feedsWithGaps ?? 0,
    },
  }
}
