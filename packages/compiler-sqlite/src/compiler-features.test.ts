import type { ExecutionManifest, Expr, Query, SchemaManifest } from '@chronolog/ir'
import { describe, expect, it } from 'vitest'

import { compileQuery, compileSchema, createCoreExecutionManifest } from './index.js'

const text = (id: number, value: string): Expr => ({
  kind: 'literal',
  id,
  value: { kind: 'text', utf8: new TextEncoder().encode(value) },
})

const integer = (id: number, value: bigint): Expr => ({
  kind: 'literal',
  id,
  value: { kind: 'int64', value },
})

const schema: SchemaManifest = {
  version: 1,
  name: 'compiler_features',
  objects: [{
    kind: 'table',
    id: 1,
    name: 'accounts',
    declarationOrder: 0,
    withoutRowId: true,
    columns: [
      { id: 2, name: 'id', declarationOrder: 0, valueType: { logical: { kind: 'int64' }, nullable: false } },
      { id: 3, name: 'balance', declarationOrder: 1, valueType: { logical: { kind: 'int64' }, nullable: false } },
    ],
    constraints: [{ kind: 'primary_key', id: 4, name: 'accounts_pk', columnIds: [2] }],
  }],
  seedRows: [],
  functionIds: [],
  collationIds: [],
  moduleIds: [],
}

const manifest = createCoreExecutionManifest({
  profile: 'compiler-features',
  engineDigest: new Uint8Array(32),
})

const emptyQuery = (id: number, projection: Query['projection']): Query => ({
  id,
  ctes: [],
  joins: [],
  groupBy: [],
  projection,
  windows: [],
  compounds: [],
  orderBy: [],
  resultMode: { kind: 'multiset' },
})

describe('expanded deterministic SQLite lowering', () => {
  it('renders correlated subqueries and exposes named columns from derived relations', () => {
    const correlated: Query = {
      id: 100,
      ctes: [],
      from: { kind: 'table', id: 101, name: 'accounts', alias: 'outer_account' },
      joins: [],
      groupBy: [],
      projection: [{
        id: 102,
        name: 'present',
        expression: {
          kind: 'exists',
          id: 103,
          negated: false,
          query: {
            ...emptyQuery(104, [{ id: 105, name: 'one', expression: integer(106, 1n) }]),
            from: { kind: 'table', id: 107, name: 'accounts', alias: 'inner_account' },
            where: {
              kind: 'binary',
              id: 108,
              operator: 'eq',
              left: { kind: 'column', id: 109, relation: 'inner_account', name: 'id' },
              right: { kind: 'column', id: 110, relation: 'outer_account', name: 'id' },
            },
          },
        },
      }],
      windows: [],
      compounds: [],
      orderBy: [],
      resultMode: { kind: 'multiset' },
    }
    expect(compileQuery(correlated, compileSchema(schema, manifest).catalog).sql).toBe(
      'SELECT (EXISTS (SELECT ?1 AS "chronolog_p_105" FROM "accounts" AS "inner_account" WHERE ("inner_account"."id" = "outer_account"."id"))) AS "chronolog_p_102" FROM "accounts" AS "outer_account"',
    )

    const lexical: Query = {
      ...emptyQuery(111, [{
        id: 112,
        name: 'inner_balance',
        expression: {
          kind: 'scalar_subquery',
          id: 113,
          query: {
            ...emptyQuery(114, [{
              id: 115,
              name: 'balance',
              expression: { kind: 'column', id: 116, name: 'balance' },
            }]),
            from: { kind: 'table', id: 117, name: 'accounts', alias: 'inner_account' },
            where: {
              kind: 'binary',
              id: 118,
              operator: 'eq',
              left: { kind: 'column', id: 119, relation: 'inner_account', name: 'id' },
              right: { kind: 'column', id: 120, relation: 'outer_account', name: 'id' },
            },
          },
        },
      }]),
      from: { kind: 'table', id: 121, name: 'accounts', alias: 'outer_account' },
    }
    expect(compileQuery(lexical, compileSchema(schema, manifest).catalog).sql).toContain(
      'SELECT "inner_account"."balance" AS "chronolog_p_115" FROM "accounts" AS "inner_account"',
    )

    const derived = emptyQuery(120, [{
      id: 121,
      name: 'amount',
      expression: { kind: 'column', id: 122, relation: 'account', name: 'balance' },
    }])
    const query: Query = {
      ...emptyQuery(123, [{
        id: 124,
        name: 'copied_amount',
        expression: { kind: 'column', id: 125, relation: 'derived', name: 'amount' },
      }]),
      from: {
        kind: 'subquery',
        id: 126,
        alias: 'derived',
        query: { ...derived, from: { kind: 'table', id: 127, name: 'accounts', alias: 'account' } },
      },
    }
    expect(compileQuery(query, compileSchema(schema, manifest).catalog).sql).toBe(
      'SELECT "derived"."amount" AS "chronolog_p_124" FROM (SELECT "chronolog_subquery_126"."chronolog_p_121" AS "amount" FROM (SELECT "account"."balance" AS "chronolog_p_121" FROM "accounts" AS "account") AS "chronolog_subquery_126") AS "derived"',
    )
  })

  it('renders nonrecursive CTEs and all unordered compound operators', () => {
    const cteQuery: Query = {
      ...emptyQuery(200, [{
        id: 201,
        name: 'id',
        expression: { kind: 'column', id: 202, relation: 'account', name: 'id' },
      }]),
      from: { kind: 'table', id: 203, name: 'accounts', alias: 'account' },
    }
    const query: Query = {
      ...emptyQuery(204, [{
        id: 205,
        name: 'id',
        expression: { kind: 'column', id: 206, relation: 'selected', name: 'id' },
      }]),
      ctes: [{ id: 207, name: 'selected_accounts', query: cteQuery, materialized: 'materialized' }],
      from: { kind: 'cte', id: 208, name: 'selected_accounts', alias: 'selected' },
      compounds: [
        { id: 209, operator: 'union_all', query: emptyQuery(210, [{ id: 211, name: 'id', expression: integer(212, 2n) }]) },
        { id: 213, operator: 'union', query: emptyQuery(214, [{ id: 215, name: 'id', expression: integer(216, 3n) }]) },
        { id: 217, operator: 'intersect', query: emptyQuery(218, [{ id: 219, name: 'id', expression: integer(220, 4n) }]) },
        { id: 221, operator: 'except', query: emptyQuery(222, [{ id: 223, name: 'id', expression: integer(224, 5n) }]) },
      ],
    }
    const compiled = compileQuery(query, compileSchema(schema, manifest).catalog)
    expect(compiled.sql).toContain(
      'WITH "selected_accounts" ("id") AS MATERIALIZED (SELECT "account"."id" AS "chronolog_p_201" FROM "accounts" AS "account")',
    )
    expect(compiled.sql).toContain(' UNION ALL SELECT ')
    expect(compiled.sql).toContain(' UNION SELECT ')
    expect(compiled.sql).toContain(' INTERSECT SELECT ')
    expect(compiled.sql).toContain(' EXCEPT SELECT ')
    expect(compiled.parameters.map((parameter) => parameter.source)).toEqual([
      { kind: 'literal', value: { kind: 'int64', value: 2n } },
      { kind: 'literal', value: { kind: 'int64', value: 3n } },
      { kind: 'literal', value: { kind: 'int64', value: 4n } },
      { kind: 'literal', value: { kind: 'int64', value: 5n } },
    ])

    const orderedCompound = compileQuery({
      ...query,
      resultMode: { kind: 'ordered' },
      orderBy: [{
        id: 225,
        expression: query.projection[0]!.expression,
        direction: 'desc',
        nulls: 'last',
      }],
      page: { limit: 2 },
    }, compileSchema(schema, manifest).catalog)
    expect(orderedCompound.sql).toContain(' ORDER BY 1 DESC NULLS LAST LIMIT 2')
  })

  it('binds recursive CTE self-references from the typed anchor projection', () => {
    const recursiveArm: Query = {
      ...emptyQuery(240, [{
        id: 241,
        name: 'n',
        expression: {
          kind: 'binary', id: 242, operator: 'add',
          left: { kind: 'column', id: 243, name: 'n', relation: 'numbers' },
          right: integer(244, 1n),
        },
      }]),
      from: { kind: 'cte', id: 245, name: 'numbers' },
      where: {
        kind: 'binary', id: 246, operator: 'lt',
        left: { kind: 'column', id: 247, name: 'n', relation: 'numbers' },
        right: integer(248, 3n),
      },
    }
    const cteQuery: Query = {
      ...emptyQuery(249, [{ id: 250, name: 'n', expression: integer(251, 1n) }]),
      compounds: [{ id: 252, operator: 'union_all', query: recursiveArm }],
    }
    const query: Query = {
      ...emptyQuery(253, [{
        id: 254, name: 'n', expression: { kind: 'column', id: 255, name: 'n', relation: 'numbers' },
      }]),
      recursive: true,
      ctes: [{ id: 256, name: 'numbers', query: cteQuery, materialized: 'default' }],
      from: { kind: 'cte', id: 257, name: 'numbers' },
    }
    const compiled = compileQuery(query, compileSchema(schema, manifest).catalog)
    expect(compiled.sql).toContain('WITH RECURSIVE "numbers" ("n") AS (')
    expect(compiled.sql).toContain('FROM "numbers" AS "numbers"')
    expect(compiled.sql).not.toContain('FROM (SELECT')
    expect(compiled.sql).toContain('ORDER BY 1 ASC NULLS FIRST')
    expect(compiled.columns[0]?.valueType).toEqual({ logical: { kind: 'int64' }, nullable: false })

    const compileRecursiveArm = (arm: Query, operator: 'union_all' | 'union' | 'intersect' = 'union_all') =>
      compileQuery({
        ...query,
        ctes: [{
          ...query.ctes[0]!,
          query: { ...cteQuery, compounds: [{ id: 258, operator, query: arm }] },
        }],
      }, compileSchema(schema, manifest).catalog)
    expect(() => compileRecursiveArm(recursiveArm, 'intersect')).toThrowError(
      expect.objectContaining({ code: 'IR_RECURSIVE_CTE_OPERATOR' }),
    )
    expect(() => compileRecursiveArm({
      ...recursiveArm,
      joins: [{ id: 259, kind: 'inner', relation: { kind: 'cte', id: 260, name: 'numbers' } }],
    })).toThrowError(expect.objectContaining({ code: 'IR_RECURSIVE_CTE_REFERENCE_SHAPE' }))
    const { from: _recursiveFrom, ...recursiveWithoutFrom } = recursiveArm
    expect(() => compileRecursiveArm({
      ...recursiveWithoutFrom,
      projection: [{
        id: 261, name: 'n', expression: {
          kind: 'scalar_subquery', id: 262,
          query: {
            ...emptyQuery(263, [{
              id: 264, name: 'n', expression: { kind: 'column', id: 265, name: 'n', relation: 'numbers' },
            }]),
            from: { kind: 'cte', id: 266, name: 'numbers' },
          },
        },
      }],
    })).toThrowError(expect.objectContaining({ code: 'IR_RECURSIVE_CTE_REFERENCE_SHAPE' }))
    expect(() => compileRecursiveArm({
      ...recursiveArm,
      projection: [{
        id: 267, name: 'n', expression: {
          kind: 'aggregate', id: 268, operation: 'max', distinct: false,
          value: { kind: 'column', id: 269, name: 'n', relation: 'numbers' },
        },
      }],
    })).toThrowError(expect.objectContaining({ code: 'IR_RECURSIVE_CTE_AGGREGATE_WINDOW' }))
  })

  it('renders safe casts, bitwise operations, and manifest-registered pure functions', () => {
    const textType = { logical: { kind: 'text' as const, collation: 'binary' as const }, nullable: false }
    const withFunction: ExecutionManifest = {
      ...manifest,
      functions: [{
        id: 300,
        name: 'lower',
        arguments: [textType],
        result: textType,
        effect: 'pure',
        implementationDigest: new Uint8Array(32),
      }],
    }
    const withFunctionSchema = { ...schema, functionIds: [300] }
    const query = emptyQuery(301, [
      { id: 302, name: 'lowered', expression: { kind: 'function', id: 303, functionId: 300, args: [text(304, 'LOUD')] } },
      { id: 305, name: 'as_text', expression: { kind: 'cast', id: 306, value: integer(307, 42n), target: { kind: 'text', collation: 'binary' } } },
      { id: 308, name: 'masked', expression: { kind: 'binary', id: 309, operator: 'bit_and', left: integer(310, 7n), right: integer(311, 3n) } },
    ])
    expect(compileQuery(query, compileSchema(withFunctionSchema, withFunction).catalog).sql).toBe(
      'SELECT "lower"(?1) AS "chronolog_p_302", CAST(?2 AS TEXT) AS "chronolog_p_305", (?3 & ?4) AS "chronolog_p_308"',
    )
    const invalid = emptyQuery(312, [{
      id: 313,
      name: 'invalid',
      expression: { kind: 'cast', id: 314, value: text(315, '1'), target: { kind: 'int64' } },
    }])
    expect(() => compileQuery(invalid, compileSchema(schema, manifest).catalog)).toThrowError(
      expect.objectContaining({ code: 'IR_CAST_UNSUPPORTED' }),
    )

    const falselyPure: ExecutionManifest = {
      ...manifest,
      functions: [{
        id: 320,
        name: 'random',
        arguments: [],
        result: { logical: { kind: 'int64' }, nullable: false },
        effect: 'pure',
        implementationDigest: new Uint8Array(32),
      }],
    }
    const randomQuery = emptyQuery(321, [{
      id: 322,
      name: 'value',
      expression: { kind: 'function', id: 323, functionId: 320, args: [] },
    }])
    expect(() => compileQuery(
      randomQuery,
      compileSchema({ ...schema, functionIds: [320] }, falselyPure).catalog,
    )).toThrowError(expect.objectContaining({ code: 'IR_FUNCTION_UNSUPPORTED_BY_ENGINE' }))

    const wrongArity: ExecutionManifest = {
      ...manifest,
      functions: [{
        id: 328,
        name: 'lower',
        arguments: [textType, textType],
        result: textType,
        effect: 'pure',
        implementationDigest: new Uint8Array(32),
      }],
    }
    expect(() => compileQuery(
      emptyQuery(329, [{
        id: 330,
        name: 'lowered',
        expression: { kind: 'function', id: 331, functionId: 328, args: [text(332, 'A'), text(333, 'B')] },
      }]),
      compileSchema({ ...schema, functionIds: [328] }, wrongArity).catalog,
    )).toThrowError(expect.objectContaining({ code: 'IR_FUNCTION_UNSUPPORTED_BY_ENGINE' }))

    const aggregateAsScalar: ExecutionManifest = {
      ...manifest,
      functions: [{
        id: 324,
        name: 'count',
        arguments: [],
        result: { logical: { kind: 'int64' }, nullable: false },
        effect: 'pure',
        implementationDigest: new Uint8Array(32),
      }],
    }
    expect(() => compileQuery(
      emptyQuery(325, [{
        id: 326,
        name: 'count',
        expression: { kind: 'function', id: 327, functionId: 324, args: [] },
      }]),
      compileSchema({ ...schema, functionIds: [324] }, aggregateAsScalar).catalog,
    )).toThrowError(expect.objectContaining({ code: 'IR_FUNCTION_UNSUPPORTED_BY_ENGINE' }))
  })

  it('deterministically completes arbitrary scalar subqueries and accepts unique-key lookups', () => {
    const unbounded = emptyQuery(330, [{
      id: 331,
      name: 'balance',
      expression: { kind: 'column', id: 332, relation: 'account', name: 'balance' },
    }])
    const rejected = emptyQuery(333, [{
      id: 334,
      name: 'balance',
      expression: {
        kind: 'scalar_subquery',
        id: 335,
        query: { ...unbounded, from: { kind: 'table', id: 336, name: 'accounts', alias: 'account' } },
      },
    }])
    expect(compileQuery(rejected, compileSchema(schema, manifest).catalog).sql).toContain(
      'ORDER BY 1 ASC NULLS FIRST LIMIT 1',
    )

    const lookup: Query = {
      ...unbounded,
      from: { kind: 'table', id: 337, name: 'accounts', alias: 'account' },
      where: {
        kind: 'binary',
        id: 338,
        operator: 'eq',
        left: { kind: 'column', id: 339, relation: 'account', name: 'id' },
        right: integer(340, 1n),
      },
    }
    const accepted = emptyQuery(341, [{
      id: 342,
      name: 'balance',
      expression: { kind: 'scalar_subquery', id: 343, query: lookup },
    }])
    expect(compileQuery(accepted, compileSchema(schema, manifest).catalog).columns[0]?.valueType).toEqual({
      logical: { kind: 'int64' },
      nullable: true,
    })
  })

  it('checks IN query shape and widens nullable compound results', () => {
    const twoColumns = emptyQuery(350, [
      { id: 351, name: 'a', expression: integer(352, 1n) },
      { id: 353, name: 'b', expression: integer(354, 2n) },
    ])
    const invalidMembership = emptyQuery(355, [{
      id: 356,
      name: 'present',
      expression: {
        kind: 'membership',
        id: 357,
        value: integer(358, 1n),
        query: twoColumns,
        negated: false,
      },
    }])
    expect(() => compileQuery(invalidMembership, compileSchema(schema, manifest).catalog)).toThrowError(
      expect.objectContaining({ code: 'IR_MEMBERSHIP_QUERY_WIDTH' }),
    )

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
    const compound: Query = {
      ...emptyQuery(367, [{ id: 368, name: 'value', expression: integer(369, 1n) }]),
      compounds: [{ id: 370, operator: 'union_all', query: nullableArm }],
    }
    expect(compileQuery(compound, compileSchema(schema, manifest).catalog).columns[0]?.valueType.nullable).toBe(true)
  })

  it('retains the left text collation across UNION ALL without rejecting the right arm', () => {
    const left: Query = {
      ...emptyQuery(371, [{
        id: 372,
        name: 'value',
        expression: {
          kind: 'collate', id: 373, expression: text(374, 'left'), collation: 'nocase',
        },
      }]),
      compounds: [{
        id: 375,
        operator: 'union_all',
        query: emptyQuery(376, [{ id: 377, name: 'value', expression: text(378, 'right') }]),
      }],
    }

    expect(compileQuery(left, compileSchema(schema, manifest).catalog).columns[0]?.valueType).toEqual({
      logical: { kind: 'text', collation: 'nocase' },
      nullable: false,
    })
  })

  it('threads enclosing query scopes into CTEs inside correlated subqueries', () => {
    const cteBody = emptyQuery(379, [{
      id: 380,
      name: 'id',
      expression: { kind: 'column', id: 381, relation: 'outer_account', name: 'id' },
    }])
    const scalar = {
      ...emptyQuery(382, [{
        id: 383,
        name: 'id',
        expression: { kind: 'column', id: 384, relation: 'captured', name: 'id' },
      }]),
      ctes: [{ id: 385, name: 'captured', query: cteBody, materialized: 'default' as const }],
      from: { kind: 'cte', id: 386, name: 'captured' } as const,
    }
    const query: Query = {
      ...emptyQuery(387, [{
        id: 388,
        name: 'captured_id',
        expression: { kind: 'scalar_subquery', id: 389, query: scalar },
      }]),
      from: { kind: 'table', id: 390, name: 'accounts', alias: 'outer_account' },
    }

    const compiled = compileQuery(query, compileSchema(schema, manifest).catalog)
    expect(compiled.sql).toContain('WITH "captured" ("id") AS (SELECT "outer_account"."id"')
    expect(compiled.columns[0]?.valueType).toEqual({ logical: { kind: 'int64' }, nullable: true })
  })

  it('renders canonical JSON1 operations and constant-folds exact merge patch', () => {
    const json = (id: number, value: Extract<Expr, { kind: 'literal' }>['value']): Expr => ({ kind: 'literal', id, value })
    const document = json(400, { kind: 'json', value: new Map([['a', 1n]]) })
    const query = emptyQuery(401, [
      { id: 402, name: 'extracted', expression: { kind: 'json', id: 403, operation: 'extract', args: [document], path: '$.a' } },
      { id: 404, name: 'json_type', expression: { kind: 'json', id: 405, operation: 'type', args: [document], path: '$.a' } },
      { id: 406, name: 'array_value', expression: { kind: 'json', id: 407, operation: 'array', args: [integer(408, 9n), text(409, 'x')] } },
      { id: 410, name: 'object_value', expression: { kind: 'json', id: 411, operation: 'object', args: [text(412, 'z'), integer(413, 1n), text(414, 'a'), integer(415, 2n)] } },
      { id: 416, name: 'merged', expression: { kind: 'json', id: 417, operation: 'merge', args: [
        json(418, { kind: 'json', value: new Map([['z', 1n]]) }),
        json(419, { kind: 'json', value: new Map([['a', 2n]]) }),
      ] } },
      { id: 420, name: 'dynamic_path', expression: {
        kind: 'json', id: 421, operation: 'extract', args: [document], pathExpression: text(422, '$.a'),
      } },
    ])
    const compiled = compileQuery(query, compileSchema(schema, manifest).catalog)
    expect(compiled.sql).toContain('(?1 -> \'$.a\') AS "chronolog_p_402"')
    expect(compiled.sql).toContain('json_type(?2, \'$.a\') AS "chronolog_p_404"')
    expect(compiled.sql).toContain('json_array(?3, ?4) AS "chronolog_p_406"')
    expect(compiled.sql).toContain('json_object(?5, ?6, ?7, ?8) AS "chronolog_p_410"')
    expect(compiled.sql).toContain('(?10 -> ?11) AS "chronolog_p_420"')
    expect(compiled.parameters[4]?.source).toEqual({ kind: 'literal', value: { kind: 'text', utf8: new TextEncoder().encode('a') } })
    expect(compiled.parameters[8]?.source).toEqual({
      kind: 'literal',
      value: { kind: 'json', value: new Map([['a', 2n], ['z', 1n]]) },
    })
    expect(compiled.columns[0]?.valueType).toEqual({ logical: { kind: 'json' }, nullable: true })
    expect(compiled.columns[1]?.valueType).toEqual({ logical: { kind: 'text', collation: 'binary' }, nullable: true })
  })

  it('lowers checked integer arithmetic without exposing SQLite REAL promotion', () => {
    const query = emptyQuery(500, [{
      id: 501,
      name: 'checked_sum',
      expression: { kind: 'binary', id: 502, operator: 'add', left: integer(503, 1n), right: integer(504, 2n) },
    }])
    const compiled = compileQuery(query, compileSchema(schema, manifest).catalog)
    expect(compiled.sql).toContain("WHEN typeof((?1 + ?2)) <> 'integer' THEN \"abs\"(-9223372036854775808)")
    expect(compiled.columns[0]?.valueType).toEqual({ logical: { kind: 'int64' }, nullable: false })
  })

  it('renders typed SQLite row comparisons and row-valued membership', () => {
    const row = (id: number, items: readonly Expr[]): Expr => ({ kind: 'row', id, items })
    const source = {
      ...emptyQuery(610, [
        { id: 611, name: 'id', expression: { kind: 'column', id: 612, name: 'id', relation: 'source' } },
        { id: 613, name: 'balance', expression: { kind: 'column', id: 614, name: 'balance', relation: 'source' } },
      ]),
      from: { kind: 'table', id: 615, name: 'accounts', alias: 'source' } as const,
    }
    const left = row(616, [
      { kind: 'column', id: 617, name: 'id', relation: 'account' },
      { kind: 'column', id: 618, name: 'balance', relation: 'account' },
    ])
    const query: Query = {
      ...emptyQuery(619, [
        { id: 620, name: 'same', expression: {
          kind: 'binary', id: 621, operator: 'eq', left,
          right: row(622, [integer(623, 1n), integer(624, 2n)]),
        } },
        { id: 625, name: 'listed', expression: {
          kind: 'membership', id: 626, value: left,
          values: [row(627, [integer(628, 1n), integer(629, 2n)])], negated: false,
        } },
        { id: 630, name: 'selected', expression: {
          kind: 'membership', id: 631, value: left, query: source, negated: false,
        } },
      ]),
      from: { kind: 'table', id: 632, name: 'accounts', alias: 'account' },
    }
    const compiled = compileQuery(query, compileSchema(schema, manifest).catalog)
    expect(compiled.sql).toContain('(("account"."id", "account"."balance") = (?1, ?2))')
    expect(compiled.sql).toContain('("account"."id", "account"."balance") IN ((?3, ?4))')
    expect(compiled.sql).toContain('("account"."id", "account"."balance") IN (SELECT')
    expect(compiled.columns.map((column) => column.valueType)).toEqual([
      { logical: { kind: 'boolean' }, nullable: false },
      { logical: { kind: 'boolean' }, nullable: false },
      { logical: { kind: 'boolean' }, nullable: false },
    ])
  })
})
