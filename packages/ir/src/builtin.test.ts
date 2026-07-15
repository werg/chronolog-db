import { describe, expect, it } from 'vitest'

import { decodeQuery, encodeQuery, IrBuilder, validateQuery, values } from './index.js'
import type { Expr } from './types.js'

describe('compiler-owned builtin function IR', () => {
  it('round-trips a builtin call without a schema function registration', () => {
    const builder = new IrBuilder()
    const query = builder.query([
      builder.projection('length', builder.builtin('length', [builder.literal(values.text('Aé'))])),
    ])
    expect(decodeQuery(encodeQuery(query))).toEqual(query)
  })

  it('rejects names outside the closed builtin registry', () => {
    const builder = new IrBuilder()
    const invalid = {
      kind: 'builtin', id: builder.id(), name: 'format', args: [],
    } as unknown as Expr
    const query = builder.query([builder.projection('invalid', invalid)])
    expect(validateQuery(query).diagnostics).toEqual([
      expect.objectContaining({ code: 'BUILTIN_FUNCTION_INVALID', nodeId: invalid.id }),
    ])
  })
})
