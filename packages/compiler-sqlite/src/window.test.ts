import { describe, expect, it } from 'vitest'

import { IrBuilder, type SchemaManifest } from '@chronolog/ir'

import { compileQuery, compileSchema, createCoreExecutionManifest } from './index.js'

const schema: SchemaManifest = {
  version: 1,
  name: 'windows',
  objects: [{
    kind: 'table', id: 1, name: 'accounts', declarationOrder: 0, withoutRowId: true,
    columns: [
      { id: 2, name: 'id', declarationOrder: 0, valueType: { logical: { kind: 'int64' }, nullable: false } },
      { id: 3, name: 'balance', declarationOrder: 1, valueType: { logical: { kind: 'int64' }, nullable: false } },
    ],
    constraints: [{ kind: 'primary_key', id: 4, name: 'accounts_pk', columnIds: [2] }],
  }],
  seedRows: [], functionIds: [], collationIds: [], moduleIds: [],
}

const manifest = createCoreExecutionManifest({
  profile: 'window-test',
  engineDigest: new Uint8Array(32),
})

describe('deterministic window lowering', () => {
  it('preserves peer semantics for ranking and completes order-sensitive ties', () => {
    const builder = new IrBuilder(100)
    const order = builder.order(builder.column('balance', 'account'), 'asc', 'first')
    const named = builder.window('by_balance', [], [order])
    const query = builder.query([
      builder.projection('row_number', builder.windowCall('row_number', [], 'by_balance')),
      builder.projection('rank', builder.windowCall('rank', [], 'by_balance')),
      builder.projection('previous_balance', builder.windowCall(
        'lag', [builder.column('balance', 'account')], 'by_balance',
      )),
      builder.projection('running_count', builder.windowCall('count', [], {
        partitionBy: [],
        orderBy: [order],
        frame: {
          mode: 'rows',
          start: { type: 'unbounded_preceding' },
          end: { type: 'current_row' },
        },
      })),
    ], {
      from: builder.table('accounts', 'account'),
      windows: [named],
    })

    const compiled = compileQuery(query, compileSchema(schema, manifest).catalog)
    expect(compiled.sql).toContain(
      'ROW_NUMBER() OVER (ORDER BY "account"."balance" ASC NULLS FIRST, "account"."id" ASC NULLS FIRST, "account"."balance" ASC NULLS FIRST)',
    )
    expect(compiled.sql).toContain('RANK() OVER "by_balance"')
    expect(compiled.sql).toContain('LAG("account"."balance") OVER (ORDER BY')
    expect(compiled.sql).toContain('ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW')
    expect(compiled.sql).toContain('WINDOW "by_balance" AS (ORDER BY "account"."balance" ASC NULLS FIRST)')
    expect(compiled.columns.map((column) => column.valueType)).toEqual([
      { logical: { kind: 'int64' }, nullable: false },
      { logical: { kind: 'int64' }, nullable: false },
      { logical: { kind: 'int64' }, nullable: true },
      { logical: { kind: 'int64' }, nullable: false },
    ])
  })

  it('validates placement, named grouping keys, and frame boundaries', () => {
    const builder = new IrBuilder(200)
    const rowNumber = builder.windowCall('row_number', [], {
      partitionBy: [], orderBy: [],
    })
    const inWhere = builder.query([
      builder.projection('id', builder.column('id', 'account')),
    ], {
      from: builder.table('accounts', 'account'),
      where: rowNumber,
    })
    expect(() => compileQuery(inWhere, compileSchema(schema, manifest).catalog)).toThrowError(
      expect.objectContaining({ code: 'IR_WINDOW_CONTEXT_INVALID' }),
    )

    const named = builder.window('by_id', [], [
      builder.order(builder.column('id', 'account')),
    ])
    const ungroupedNamedKey = builder.query([
      builder.projection('balance', builder.column('balance', 'account')),
      builder.projection('row_number', builder.windowCall('row_number', [], 'by_id')),
    ], {
      from: builder.table('accounts', 'account'),
      groupBy: [builder.column('balance', 'account')],
      windows: [named],
    })
    expect(() => compileQuery(ungroupedNamedKey, compileSchema(schema, manifest).catalog)).toThrowError(
      expect.objectContaining({ code: 'IR_BARE_COLUMN_OUTSIDE_GROUP' }),
    )

    const invalidFrame = builder.windowCall('count', [], {
      partitionBy: [],
      orderBy: [builder.order(builder.column('id', 'account'))],
      frame: {
        mode: 'rows',
        start: { type: 'following', offset: builder.literal({ kind: 'int64', value: 1n }) },
        end: { type: 'preceding', offset: builder.literal({ kind: 'int64', value: 1n }) },
      },
    })
    const invalidFrameQuery = builder.query([
      builder.projection('count', invalidFrame),
    ], { from: builder.table('accounts', 'account') })
    expect(() => compileQuery(invalidFrameQuery, compileSchema(schema, manifest).catalog)).toThrowError(
      expect.objectContaining({ code: 'IR_WINDOW_FRAME_BOUNDS_INVALID' }),
    )
  })

  it('orders grouped rows by group keys and drops ignored built-in frames before tie completion', () => {
    const builder = new IrBuilder(300)
    const grouped = builder.query([
      builder.projection('balance', builder.column('balance', 'account')),
      builder.projection('row_number', builder.windowCall('row_number', [], {
        partitionBy: [], orderBy: [],
      })),
    ], {
      from: builder.table('accounts', 'account'),
      groupBy: [builder.column('balance', 'account')],
    })
    const groupedSql = compileQuery(grouped, compileSchema(schema, manifest).catalog).sql
    expect(groupedSql).toContain('ROW_NUMBER() OVER (ORDER BY "account"."balance" ASC NULLS FIRST)')
    expect(groupedSql).not.toContain('"account"."id" ASC NULLS FIRST')

    const range = builder.windowCall('lag', [builder.column('balance', 'account')], {
      partitionBy: [],
      orderBy: [builder.order(builder.column('id', 'account'))],
      frame: {
        mode: 'range',
        start: { type: 'preceding', offset: builder.literal({ kind: 'int64', value: 1n }) },
        end: { type: 'current_row' },
      },
    })
    const rangeQuery = builder.query([
      builder.projection('previous', range),
    ], { from: builder.table('accounts', 'account') })
    const rangeSql = compileQuery(rangeQuery, compileSchema(schema, manifest).catalog).sql
    expect(rangeSql).toContain('LAG("account"."balance") OVER (ORDER BY')
    expect(rangeSql).not.toContain(' RANGE ')
  })

  it('accepts non-row-dependent integer expressions as frame offsets', () => {
    const builder = new IrBuilder(400)
    const offset = builder.binary(
      'add',
      builder.literal({ kind: 'int64', value: 1n }),
      builder.literal({ kind: 'int64', value: 1n }),
    )
    const running = builder.windowCall('count', [], {
      partitionBy: [],
      orderBy: [builder.order(builder.column('id', 'account'))],
      frame: {
        mode: 'rows',
        start: { type: 'preceding', offset },
        end: { type: 'current_row' },
      },
    })
    const query = builder.query([
      builder.projection('running', running),
    ], { from: builder.table('accounts', 'account') })

    expect(compileQuery(query, compileSchema(schema, manifest).catalog).sql).toContain(
      'PRECEDING AND CURRENT ROW',
    )
  })
})
