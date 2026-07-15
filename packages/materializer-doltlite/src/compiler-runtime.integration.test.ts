import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createCoreExecutionManifest } from '@chronolog/compiler-sqlite'
import { IrBuilder, values, type CanonicalJsonValue, type ExecutionManifest, type Expr, type Query, type SchemaManifest } from '@chronolog/ir'
import { afterEach, describe, expect, it } from 'vitest'

import { readNativeEngineInfo } from './driver.js'
import { DeterministicMaterializer } from './materializer.js'

const encoder = new TextEncoder()
const textType = { logical: { kind: 'text' as const, collation: 'binary' as const }, nullable: false }
const baseManifest = createCoreExecutionManifest({
  profile: 'compiler-runtime-integration',
  engineDigest: readNativeEngineInfo().digest,
})
const executionManifest: ExecutionManifest = {
  ...baseManifest,
  functions: [
    {
      id: 100,
      name: 'lower',
      arguments: [textType],
      result: textType,
      effect: 'pure',
      implementationDigest: new Uint8Array(32),
    },
    {
      id: 101,
      name: 'random',
      arguments: [],
      result: { logical: { kind: 'int64' }, nullable: false },
      effect: 'pure',
      implementationDigest: new Uint8Array(32),
    },
  ],
}

const schema: SchemaManifest = {
  version: 1,
  name: 'compiler_runtime',
  objects: [{
    kind: 'table',
    id: 1,
    name: 'accounts',
    declarationOrder: 0,
    withoutRowId: true,
    columns: [
      { id: 2, name: 'id', declarationOrder: 0, valueType: { logical: { kind: 'int64' }, nullable: false } },
      { id: 3, name: 'balance', declarationOrder: 1, valueType: { logical: { kind: 'int64' }, nullable: false } },
      { id: 4, name: 'label', declarationOrder: 2, valueType: textType },
    ],
    constraints: [{ kind: 'primary_key', id: 5, name: 'accounts_pk', columnIds: [2] }],
  }],
  seedRows: [
    { tableId: 1, values: new Map([
      [2, { kind: 'int64', value: 1n }],
      [3, { kind: 'int64', value: 7n }],
      [4, { kind: 'text', utf8: encoder.encode('ALPHA') }],
    ]) },
    { tableId: 1, values: new Map([
      [2, { kind: 'int64', value: 2n }],
      [3, { kind: 'int64', value: 3n }],
      [4, { kind: 'text', utf8: encoder.encode('Beta') }],
    ]) },
  ],
  functionIds: [100, 101],
  collationIds: [],
  moduleIds: [],
}

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function path(): string {
  const directory = mkdtempSync(join(tmpdir(), 'chronolog-compiler-runtime-'))
  directories.push(directory)
  return join(directory, 'state.db')
}

function integer(id: number, value: bigint): Expr {
  return { kind: 'literal', id, value: { kind: 'int64', value } }
}

function text(id: number, value: string): Expr {
  return { kind: 'literal', id, value: { kind: 'text', utf8: encoder.encode(value) } }
}

function emptyQuery(id: number, projection: Query['projection']): Query {
  return {
    id,
    ctes: [],
    joins: [],
    groupBy: [],
    projection,
    windows: [],
    compounds: [],
    orderBy: [],
    resultMode: { kind: 'multiset' },
  }
}

describe('expanded compiler features on the real DoltLite runtime', () => {
  it('executes correlated/derived/CTE/compound queries through the consensus profile', async () => {
    const materializer = await DeterministicMaterializer.open({
      path: path(),
      schemaManifest: schema,
      executionManifest,
    })
    try {
      const correlated: Query = {
        ...emptyQuery(200, [
          { id: 201, name: 'id', expression: { kind: 'column', id: 202, relation: 'outer_account', name: 'id' } },
          { id: 203, name: 'has_smaller', expression: {
            kind: 'exists',
            id: 204,
            negated: false,
            query: {
              ...emptyQuery(205, [{ id: 206, name: 'one', expression: integer(207, 1n) }]),
              from: { kind: 'table', id: 208, name: 'accounts', alias: 'inner_account' },
              where: {
                kind: 'binary',
                id: 209,
                operator: 'lt',
                left: { kind: 'column', id: 210, relation: 'inner_account', name: 'balance' },
                right: { kind: 'column', id: 211, relation: 'outer_account', name: 'balance' },
              },
            },
          } },
        ]),
        from: { kind: 'table', id: 212, name: 'accounts', alias: 'outer_account' },
      }
      expect((await materializer.queryIr(correlated)).result.rows).toEqual([
        [{ kind: 'int64', value: 1n }, { kind: 'boolean', value: true }],
        [{ kind: 'int64', value: 2n }, { kind: 'boolean', value: false }],
      ])

      const cteSource: Query = {
        ...emptyQuery(220, [{ id: 221, name: 'id', expression: { kind: 'column', id: 222, relation: 'account', name: 'id' } }]),
        from: { kind: 'table', id: 223, name: 'accounts', alias: 'account' },
        where: {
          kind: 'binary', id: 224, operator: 'eq',
          left: { kind: 'column', id: 225, relation: 'account', name: 'id' },
          right: integer(226, 1n),
        },
      }
      const compound: Query = {
        ...emptyQuery(227, [{ id: 228, name: 'id', expression: { kind: 'column', id: 229, relation: 'selected', name: 'id' } }]),
        ctes: [{ id: 230, name: 'selected_accounts', query: cteSource, materialized: 'materialized' }],
        from: { kind: 'cte', id: 231, name: 'selected_accounts', alias: 'selected' },
        compounds: [{
          id: 232,
          operator: 'union_all',
          query: emptyQuery(233, [{ id: 234, name: 'id', expression: integer(235, 2n) }]),
        }],
      }
      expect((await materializer.queryIr(compound)).result.rows).toEqual([
        [{ kind: 'int64', value: 1n }],
        [{ kind: 'int64', value: 2n }],
      ])

      const inner: Query = {
        ...emptyQuery(240, [{ id: 241, name: 'label', expression: { kind: 'column', id: 242, relation: 'account', name: 'label' } }]),
        from: { kind: 'table', id: 243, name: 'accounts', alias: 'account' },
        where: {
          kind: 'binary', id: 244, operator: 'eq',
          left: { kind: 'column', id: 245, relation: 'account', name: 'id' },
          right: integer(246, 2n),
        },
      }
      const derived: Query = {
        ...emptyQuery(247, [{ id: 248, name: 'label', expression: { kind: 'column', id: 249, relation: 'derived', name: 'label' } }]),
        from: { kind: 'subquery', id: 250, alias: 'derived', query: inner },
      }
      expect((await materializer.queryIr(derived)).result.rows).toEqual([
        [{ kind: 'text', utf8: encoder.encode('Beta') }],
      ])

      const automaticallyOrdered: Query = {
        ...emptyQuery(251, [{
          id: 252,
          name: 'balance',
          expression: { kind: 'column', id: 253, relation: 'account', name: 'balance' },
        }]),
        from: { kind: 'table', id: 254, name: 'accounts', alias: 'account' },
        resultMode: { kind: 'ordered' },
      }
      expect((await materializer.queryIr(automaticallyOrdered)).result.rows).toEqual([
        [{ kind: 'int64', value: 3n }],
        [{ kind: 'int64', value: 7n }],
      ])
    } finally {
      materializer.close()
    }
  })

  it('executes casts, bitwise operations, canonical JSON, IN, and an approved scalar function', async () => {
    const materializer = await DeterministicMaterializer.open({
      path: path(),
      schemaManifest: schema,
      executionManifest,
    })
    try {
      const operations = emptyQuery(300, [
        { id: 301, name: 'lowered', expression: { kind: 'function', id: 302, functionId: 100, args: [text(303, 'LOUD')] } },
        { id: 304, name: 'as_text', expression: { kind: 'cast', id: 305, value: integer(306, 42n), target: { kind: 'text', collation: 'binary' } } },
        { id: 307, name: 'masked', expression: { kind: 'binary', id: 308, operator: 'bit_and', left: integer(309, 7n), right: integer(310, 3n) } },
      ])
      expect((await materializer.queryIr(operations)).result.rows).toEqual([[
        { kind: 'text', utf8: encoder.encode('loud') },
        { kind: 'text', utf8: encoder.encode('42') },
        { kind: 'int64', value: 3n },
      ]])

      const document: CanonicalJsonValue = new Map([['a', 1n]])
      const jsonQuery = emptyQuery(320, [
        { id: 321, name: 'extracted', expression: { kind: 'json', id: 322, operation: 'extract', args: [{ kind: 'literal', id: 323, value: { kind: 'json', value: document } }], path: '$.a' } },
        { id: 324, name: 'type', expression: { kind: 'json', id: 325, operation: 'type', args: [{ kind: 'literal', id: 326, value: { kind: 'json', value: document } }], path: '$.a' } },
        { id: 327, name: 'array', expression: { kind: 'json', id: 328, operation: 'array', args: [integer(329, 9n), text(330, 'x')] } },
        { id: 331, name: 'object', expression: { kind: 'json', id: 332, operation: 'object', args: [text(333, 'z'), integer(334, 1n), text(335, 'a'), integer(336, 2n)] } },
      ])
      expect((await materializer.queryIr(jsonQuery)).result.rows).toEqual([[
        { kind: 'json', value: 1n },
        { kind: 'text', utf8: encoder.encode('integer') },
        { kind: 'json', value: [9n, 'x'] },
        { kind: 'json', value: new Map([['a', 2n], ['z', 1n]]) },
      ]])

      const membership = emptyQuery(340, [{
        id: 341,
        name: 'present',
        expression: {
          kind: 'membership',
          id: 342,
          value: integer(343, 2n),
          query: {
            ...emptyQuery(344, [{ id: 345, name: 'id', expression: { kind: 'column', id: 346, relation: 'account', name: 'id' } }]),
            from: { kind: 'table', id: 347, name: 'accounts', alias: 'account' },
          },
          negated: false,
        },
      }])
      expect((await materializer.queryIr(membership)).result.rows).toEqual([[
        { kind: 'boolean', value: true },
      ]])

      const nullableMembership = emptyQuery(350, [{
        id: 351,
        name: 'present',
        expression: {
          kind: 'membership',
          id: 352,
          value: integer(353, 1n),
          values: [
            { kind: 'literal', id: 354, value: { kind: 'null' } },
            integer(355, 2n),
          ],
          negated: false,
        },
      }])
      expect((await materializer.queryIr(nullableMembership)).result.rows).toEqual([[
        { kind: 'null' },
      ]])

      const nullableArm = emptyQuery(360, [{
        id: 361,
        name: 'value',
        expression: {
          kind: 'scalar_subquery',
          id: 362,
          query: {
            ...emptyQuery(363, [{ id: 364, name: 'value', expression: integer(365, 2n) }]),
            where: { kind: 'literal', id: 366, value: { kind: 'boolean', value: false } },
          },
        },
      }])
      const nullableCompound: Query = {
        ...emptyQuery(367, [{ id: 368, name: 'value', expression: integer(369, 1n) }]),
        compounds: [{ id: 370, operator: 'union_all', query: nullableArm }],
      }
      expect((await materializer.queryIr(nullableCompound)).result.rows).toEqual([
        [{ kind: 'null' }],
        [{ kind: 'int64', value: 1n }],
      ])
    } finally {
      materializer.close()
    }
  })

  it('executes recursive CTEs, windows, row values, dynamic JSON paths, and collations', async () => {
    const materializer = await DeterministicMaterializer.open({
      path: path(),
      schemaManifest: schema,
      executionManifest,
    })
    try {
      const recursiveBuilder = new IrBuilder(500)
      const anchor = recursiveBuilder.query([
        recursiveBuilder.projection('n', recursiveBuilder.literal(values.int64(1n))),
      ])
      const recursiveArm = recursiveBuilder.query([
        recursiveBuilder.projection('n', recursiveBuilder.binary(
          'add', recursiveBuilder.column('n', 'numbers'), recursiveBuilder.literal(values.int64(1n)),
        )),
      ], {
        from: recursiveBuilder.cteReference('numbers'),
        where: recursiveBuilder.binary(
          'lt', recursiveBuilder.column('n', 'numbers'), recursiveBuilder.literal(values.int64(3n)),
        ),
      })
      const cteQuery = {
        ...anchor,
        compounds: [recursiveBuilder.compound('union_all', recursiveArm)],
      }
      const recursive = recursiveBuilder.query([
        recursiveBuilder.projection('n', recursiveBuilder.column('n', 'numbers')),
      ], {
        recursive: true,
        ctes: [recursiveBuilder.cte('numbers', cteQuery)],
        from: recursiveBuilder.cteReference('numbers'),
        orderBy: [recursiveBuilder.order(recursiveBuilder.column('n', 'numbers'))],
        resultMode: { kind: 'ordered' },
      })
      expect((await materializer.queryIr(recursive)).result.rows).toEqual([
        [{ kind: 'int64', value: 1n }],
        [{ kind: 'int64', value: 2n }],
        [{ kind: 'int64', value: 3n }],
      ])

      const windowBuilder = new IrBuilder(600)
      const balanceOrder = windowBuilder.order(windowBuilder.column('balance', 'account'))
      const windowQuery = windowBuilder.query([
        windowBuilder.projection('id', windowBuilder.column('id', 'account')),
        windowBuilder.projection('row_number', windowBuilder.windowCall('row_number', [], 'by_balance')),
        windowBuilder.projection('rank', windowBuilder.windowCall('rank', [], 'by_balance')),
        windowBuilder.projection('running_count', windowBuilder.windowCall('count', [], {
          partitionBy: [],
          orderBy: [windowBuilder.order(windowBuilder.column('id', 'account'))],
          frame: {
            mode: 'rows',
            start: {
              type: 'preceding',
              offset: windowBuilder.binary(
                'add',
                windowBuilder.literal(values.int64(1n)),
                windowBuilder.literal(values.int64(1n)),
              ),
            },
            end: { type: 'current_row' },
          },
        })),
      ], {
        from: windowBuilder.table('accounts', 'account'),
        windows: [windowBuilder.window('by_balance', [], [balanceOrder])],
        orderBy: [windowBuilder.order(windowBuilder.column('id', 'account'))],
        resultMode: { kind: 'ordered' },
      })
      expect((await materializer.queryIr(windowQuery)).result.rows).toEqual([
        [
          { kind: 'int64', value: 1n }, { kind: 'int64', value: 2n },
          { kind: 'int64', value: 2n }, { kind: 'int64', value: 1n },
        ],
        [
          { kind: 'int64', value: 2n }, { kind: 'int64', value: 1n },
          { kind: 'int64', value: 1n }, { kind: 'int64', value: 2n },
        ],
      ])

      const expressionBuilder = new IrBuilder(700)
      const leftRow = expressionBuilder.row([
        expressionBuilder.literal(values.int64(1n)),
        expressionBuilder.literal(values.text('A')),
      ])
      const expressionQuery = expressionBuilder.query([
        expressionBuilder.projection('row_equal', expressionBuilder.binary(
          'eq', leftRow, expressionBuilder.row([
            expressionBuilder.literal(values.int64(1n)),
            expressionBuilder.literal(values.text('A')),
          ]),
        )),
        expressionBuilder.projection('nocase_equal', expressionBuilder.binary(
          'eq',
          expressionBuilder.collate(expressionBuilder.literal(values.text('a')), 'nocase'),
          expressionBuilder.literal(values.text('A')),
        )),
        expressionBuilder.projection('dynamic_json', expressionBuilder.jsonOperation(
          'extract',
          [expressionBuilder.literal(values.json(new Map([['a', 9n]])))],
          expressionBuilder.literal(values.text('$.a')),
        )),
      ])
      expect((await materializer.queryIr(expressionQuery)).result.rows).toEqual([[
        { kind: 'boolean', value: true },
        { kind: 'boolean', value: true },
        { kind: 'json', value: 9n },
      ]])
    } finally {
      materializer.close()
    }
  })

  it('matches SQLite collation precedence through casts, functions, and membership', async () => {
    const nocaseSchema: SchemaManifest = {
      ...schema,
      objects: schema.objects.map((object) => object.kind !== 'table' ? object : ({
        ...object,
        columns: object.columns.map((column) => column.name !== 'label' ? column : ({
          ...column,
          valueType: { logical: { kind: 'text', collation: 'nocase' }, nullable: false },
        })),
      })),
    }
    const materializer = await DeterministicMaterializer.open({
      path: path(),
      schemaManifest: nocaseSchema,
      executionManifest,
    })
    try {
      const builder = new IrBuilder(800)
      const label = builder.column('label', 'account')
      const lowerAlpha = builder.literal(values.text('alpha'))
      const query = builder.query([
        builder.projection('id', builder.column('id', 'account')),
        builder.projection('cast_equal', builder.binary(
          'eq', builder.cast(label, { kind: 'text', collation: 'binary' }), lowerAlpha,
        )),
        builder.projection('function_equal', builder.binary(
          'eq', builder.builtin('coalesce', [label, builder.literal(values.text(''))]), lowerAlpha,
        )),
        builder.projection('member', builder.membership(label, [lowerAlpha])),
      ], {
        from: builder.table('accounts', 'account'),
        orderBy: [builder.order(builder.column('id', 'account'))],
        resultMode: { kind: 'ordered' },
      })

      expect((await materializer.queryIr(query)).result.rows).toEqual([
        [
          { kind: 'int64', value: 1n },
          { kind: 'boolean', value: true },
          { kind: 'boolean', value: false },
          { kind: 'boolean', value: true },
        ],
        [
          { kind: 'int64', value: 2n },
          { kind: 'boolean', value: false },
          { kind: 'boolean', value: false },
          { kind: 'boolean', value: false },
        ],
      ])
    } finally {
      materializer.close()
    }
  })

  it('rejects falsely-pure ambient functions before the runtime authorizer is reached', async () => {
    const materializer = await DeterministicMaterializer.open({
      path: path(),
      schemaManifest: schema,
      executionManifest,
    })
    try {
      const randomQuery = emptyQuery(400, [{
        id: 401,
        name: 'random',
        expression: { kind: 'function', id: 402, functionId: 101, args: [] },
      }])
      expect(materializer.validateQuery(randomQuery)).toEqual([
        expect.objectContaining({ code: 'IR_FUNCTION_UNSUPPORTED_BY_ENGINE', nodeId: 402 }),
      ])
      await expect(materializer.queryIr(randomQuery)).rejects.toMatchObject({
        code: 'IR_FUNCTION_UNSUPPORTED_BY_ENGINE',
      })

      const unboundedScalar = emptyQuery(410, [{
        id: 411,
        name: 'balance',
        expression: {
          kind: 'scalar_subquery',
          id: 412,
          query: {
            ...emptyQuery(413, [{
              id: 414,
              name: 'balance',
              expression: { kind: 'column', id: 415, relation: 'account', name: 'balance' },
            }]),
            from: { kind: 'table', id: 416, name: 'accounts', alias: 'account' },
          },
        },
      }])
      expect(materializer.validateQuery(unboundedScalar)).toEqual([])
      expect((await materializer.queryIr(unboundedScalar)).result.rows).toEqual([[
        { kind: 'int64', value: 3n },
      ]])
    } finally {
      materializer.close()
    }
  })
})
