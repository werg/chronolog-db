import { describe, expect, it } from 'vitest'

import { decodeQuery, encodeQuery, IrBuilder, validateQuery, values } from './index.js'

describe('canonical aggregate IR', () => {
  it('round-trips aggregate nodes through the signed codec', () => {
    const builder = new IrBuilder()
    const expression = builder.aggregate(
      'count',
      builder.literal(values.int64(1n)),
      true,
      builder.literal(values.boolean(true)),
      [builder.order(builder.literal(values.int64(2n)), 'desc', 'last')],
    )
    const query = builder.query([builder.projection('count', expression)])
    expect(decodeQuery(encodeQuery(query))).toEqual(query)
  })

  it('requires an argument for DISTINCT count and min/max', () => {
    const builder = new IrBuilder()
    for (const expression of [
      { kind: 'aggregate' as const, id: builder.id(), operation: 'count' as const, distinct: true },
      { kind: 'aggregate' as const, id: builder.id(), operation: 'min' as const, distinct: false },
      { kind: 'aggregate' as const, id: builder.id(), operation: 'every' as const, distinct: false },
      { kind: 'aggregate' as const, id: builder.id(), operation: 'any' as const, distinct: false },
    ]) {
      const query = builder.query([builder.projection('invalid', expression)])
      expect(validateQuery(query).diagnostics).toEqual([
        expect.objectContaining({ code: 'AGGREGATE_ARGUMENT_REQUIRED', nodeId: expression.id }),
      ])
    }
  })
})
