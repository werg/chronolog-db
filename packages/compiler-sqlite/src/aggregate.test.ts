import type { AggregateExpr, ExecutionManifest, Expr, Query, SchemaManifest } from '@chronolog/ir'
import { describe, expect, it } from 'vitest'

import { compileQuery, compileSchema } from './index.js'
import type { CompilerError } from './index.js'

const manifest: ExecutionManifest = {
  version: 1,
  profile: 'aggregate-test',
  engine: 'doltlite-test',
  engineDigest: new Uint8Array(32),
  functions: [], collations: [], modules: [],
  features: { decimal: true, json: false, vector: false, fts: false, spatial: false, wasm: false },
  resources: {
    maxProgramNodes: 1_000, maxExpressionDepth: 32, maxQueryRows: 1_000,
    maxResultBytes: 1_000_000, maxJsonDepth: 32, maxVectorDimensions: 0,
    maxRuleDepth: 0, maxWasmFuel: 0n,
  },
}

const schema: SchemaManifest = {
  version: 1,
  name: 'aggregate_test',
  objects: [{
    kind: 'table', id: 1, name: 'measurements', declarationOrder: 0, withoutRowId: true,
    columns: [
      { id: 2, name: 'id', declarationOrder: 0, valueType: { logical: { kind: 'int64' }, nullable: false } },
      { id: 3, name: 'category', declarationOrder: 1, valueType: { logical: { kind: 'text', collation: 'binary' }, nullable: false } },
      { id: 4, name: 'reading', declarationOrder: 2, valueType: { logical: { kind: 'int64' }, nullable: true } },
      { id: 5, name: 'exact', declarationOrder: 3, valueType: { logical: { kind: 'decimal', precision: 20, scale: 4 }, nullable: false } },
    ],
    constraints: [{ kind: 'primary_key', id: 6, name: 'measurements_pk', columnIds: [2] }],
  }],
  seedRows: [], functionIds: [], collationIds: [], moduleIds: [],
}

const catalog = compileSchema(schema, manifest).catalog
const column = (id: number, name: string): Expr => ({ kind: 'column', id, relation: 'm', name })
const count = (id: number, value?: Expr, distinct = false): AggregateExpr => ({
  kind: 'aggregate', id, operation: 'count', distinct, ...(value === undefined ? {} : { value }),
})
const aggregate = (id: number, operation: 'min' | 'max', value: Expr): Expr => ({
  kind: 'aggregate', id, operation, value, distinct: false,
})

function query(projection: Query['projection'], options: Partial<Query> = {}): Query {
  return {
    id: 100, ctes: [], joins: [], groupBy: [], windows: [], compounds: [], orderBy: [],
    from: { kind: 'table', id: 101, name: 'measurements', alias: 'm' },
    projection, resultMode: { kind: 'multiset' }, ...options,
  }
}

describe('deterministic aggregate compilation', () => {
  it('lowers count, distinct count, min, max, grouping, and having with exact result types', () => {
    const category = column(110, 'category')
    const compiled = compileQuery(query([
      { id: 111, name: 'category', expression: column(112, 'category') },
      { id: 113, name: 'rows', expression: count(114) },
      { id: 115, name: 'present', expression: count(116, column(117, 'reading')) },
      { id: 118, name: 'distinct_present', expression: count(119, column(120, 'reading'), true) },
      { id: 121, name: 'minimum', expression: aggregate(122, 'min', column(123, 'reading')) },
      { id: 124, name: 'maximum', expression: aggregate(125, 'max', column(126, 'reading')) },
      { id: 131, name: 'filtered', expression: {
        ...count(132),
        filter: { kind: 'unary', id: 133, operator: 'is_not_null', operand: column(134, 'reading') },
      } },
    ], {
      groupBy: [category],
      having: {
        kind: 'binary', id: 127, operator: 'gte',
        left: count(128),
        right: { kind: 'literal', id: 129, value: { kind: 'int64', value: 1n } },
      },
    }), catalog)

    expect(compiled.sql).toContain(
      'COUNT(*) AS "chronolog_p_113", COUNT("m"."reading") AS "chronolog_p_115", COUNT(DISTINCT "m"."reading") AS "chronolog_p_118"',
    )
    expect(compiled.sql).toContain('MIN("m"."reading") AS "chronolog_p_121", MAX("m"."reading") AS "chronolog_p_124"')
    expect(compiled.sql).toContain('COUNT(*) FILTER (WHERE ("m"."reading" IS NOT NULL)) AS "chronolog_p_131"')
    expect(compiled.sql).toContain('GROUP BY "m"."category" HAVING (COUNT(*) >= ?1)')
    expect(compiled.columns.map((result) => result.valueType)).toEqual([
      { logical: { kind: 'text', collation: 'binary' }, nullable: false },
      { logical: { kind: 'int64' }, nullable: false },
      { logical: { kind: 'int64' }, nullable: false },
      { logical: { kind: 'int64' }, nullable: false },
      { logical: { kind: 'int64' }, nullable: true },
      { logical: { kind: 'int64' }, nullable: true },
      { logical: { kind: 'int64' }, nullable: false },
    ])
  })

  it('accepts resolved grouping equivalence and non-null key functional dependencies', () => {
    const grouped = query([
      { id: 135, name: 'reading', expression: column(136, 'reading') },
      { id: 137, name: 'rows', expression: count(138) },
    ], {
      groupBy: [{ kind: 'column', id: 139, name: 'id' }],
    })
    expect(() => compileQuery(grouped, catalog)).not.toThrow()
  })

  it('treats an ungrouped aggregate query as a proven scalar subquery', () => {
    const inner = query([{ id: 140, name: 'rows', expression: count(141) }], { resultMode: { kind: 'scalar' } })
    const outer: Query = {
      id: 142, ctes: [], joins: [], groupBy: [], windows: [], compounds: [], orderBy: [],
      projection: [{ id: 143, name: 'rows', expression: { kind: 'scalar_subquery', id: 144, query: inner } }],
      resultMode: { kind: 'scalar' },
    }
    expect(compileQuery(outer, catalog).columns[0]?.valueType).toEqual({
      logical: { kind: 'int64' }, nullable: true,
    })
  })

  it('lowers order-independent Boolean aggregates and accepts a NULL filter', () => {
    const predicate: Expr = {
      kind: 'binary', id: 140, operator: 'gt', left: column(141, 'reading'),
      right: { kind: 'literal', id: 142, value: { kind: 'int64', value: 0n } },
    }
    const compiled = compileQuery(query([
      { id: 143, name: 'all_positive', expression: {
        kind: 'aggregate', id: 144, operation: 'every', value: predicate, distinct: false,
      } },
      { id: 145, name: 'any_positive', expression: {
        kind: 'aggregate', id: 146, operation: 'any', value: predicate, distinct: false,
      } },
      { id: 147, name: 'filtered_out', expression: {
        ...count(148), filter: { kind: 'literal', id: 149, value: { kind: 'null' } },
      } },
    ]), catalog)
    expect(compiled.sql).toContain('MIN(("m"."reading" > ?1))')
    expect(compiled.sql).toContain('MAX(("m"."reading" > ?2))')
    expect(compiled.sql).toContain('COUNT(*) FILTER (WHERE ?3)')
    expect(compiled.columns.map((column) => column.valueType)).toEqual([
      { logical: { kind: 'boolean' }, nullable: true },
      { logical: { kind: 'boolean' }, nullable: true },
      { logical: { kind: 'int64' }, nullable: false },
    ])
  })

  it('retains name resolution and evaluation for zero-argument count ordering', () => {
    const orderedCount: AggregateExpr = {
      ...count(149),
      orderBy: [{
        id: 150,
        expression: column(151, 'reading'),
        direction: 'desc',
        nulls: 'last',
      }],
    }
    const compiled = compileQuery(query([
      { id: 152, name: 'rows', expression: orderedCount },
    ]), catalog)

    expect(compiled.sql).toContain('COUNT(ORDER BY "m"."reading" DESC NULLS LAST)')
    expect(compiled.columns[0]?.valueType).toEqual({
      logical: { kind: 'int64' }, nullable: false,
    })
  })

  it('rejects non-grouped columns, illegal placement, nesting, and storage-incorrect min/max', () => {
    const failures: readonly [Query, string][] = [
      [query([
        { id: 150, name: 'category', expression: column(151, 'category') },
        { id: 152, name: 'rows', expression: count(153) },
      ]), 'IR_BARE_COLUMN_OUTSIDE_GROUP'],
      [query([{ id: 154, name: 'rows', expression: count(155) }], { where: count(156) }), 'IR_AGGREGATE_CONTEXT_INVALID'],
      [query([{ id: 157, name: 'nested', expression: count(158, count(159)) }]), 'IR_NESTED_AGGREGATE'],
      [query([{ id: 160, name: 'minimum', expression: aggregate(161, 'min', column(162, 'exact')) }]), 'IR_AGGREGATE_TYPE_UNSUPPORTED'],
      [query([{ id: 163, name: 'filtered', expression: {
        ...count(164), filter: column(165, 'reading'),
      } }]), 'IR_AGGREGATE_FILTER_BOOLEAN_REQUIRED'],
    ]
    for (const [input, code] of failures) {
      expect(() => compileQuery(input, catalog)).toThrowError(
        expect.objectContaining<Partial<CompilerError>>({ code }),
      )
    }
  })

  it('does not bind a discarded explicit compound-order expression', () => {
    const literal = (id: number, value: bigint): Expr => ({ kind: 'literal', id, value: { kind: 'int64', value } })
    const arm = (id: number, projectionId: number, value: bigint): Query => ({
      id, ctes: [], joins: [], groupBy: [], windows: [], compounds: [], orderBy: [],
      projection: [{ id: projectionId, name: 'value', expression: literal(projectionId + 1, value) }],
      resultMode: { kind: 'multiset' },
    })
    const compound: Query = {
      ...arm(170, 171, 1n),
      compounds: [{ id: 173, operator: 'union_all', query: arm(174, 175, 2n) }],
      orderBy: [{ id: 177, expression: literal(178, 1n), direction: 'asc', nulls: 'last' }],
    }
    const compiled = compileQuery(compound, catalog)
    expect(compiled.parameters.map((parameter) => parameter.ordinal)).toEqual([1, 2])
    expect(compiled.sql).not.toContain('?3')
    expect(compiled.sql).toContain('ORDER BY 1 ASC NULLS LAST')
  })
})
