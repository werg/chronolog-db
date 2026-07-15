import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createCoreExecutionManifest } from '@chronolog/compiler-sqlite'
import type { AggregateExpr, Expr, LogicalValue, Query, SchemaManifest } from '@chronolog/ir'
import { afterEach, describe, expect, it } from 'vitest'

import { readNativeEngineInfo } from './driver.js'
import { DeterministicMaterializer } from './materializer.js'

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const executionManifest = createCoreExecutionManifest({
  profile: 'aggregate-runtime-integration',
  engineDigest: readNativeEngineInfo().digest,
})
const schema: SchemaManifest = {
  version: 1,
  name: 'aggregate_runtime',
  objects: [{
    kind: 'table', id: 1, name: 'measurements', declarationOrder: 0, withoutRowId: true,
    columns: [
      { id: 2, name: 'id', declarationOrder: 0, valueType: { logical: { kind: 'int64' }, nullable: false } },
      { id: 3, name: 'category', declarationOrder: 1, valueType: { logical: { kind: 'text', collation: 'binary' }, nullable: false } },
      { id: 4, name: 'reading', declarationOrder: 2, valueType: { logical: { kind: 'int64' }, nullable: true } },
    ],
    constraints: [{ kind: 'primary_key', id: 5, name: 'measurements_pk', columnIds: [2] }],
  }],
  seedRows: [
    seed(1, 'a', 5n),
    seed(2, 'a', 5n),
    seed(3, 'a', null),
    seed(4, 'b', 3n),
  ],
  functionIds: [], collationIds: [], moduleIds: [],
}

function seed(id: number, category: string, reading: bigint | null): SchemaManifest['seedRows'][number] {
  return { tableId: 1, values: new Map<number, LogicalValue>([
    [2, { kind: 'int64', value: BigInt(id) }],
    [3, { kind: 'text', utf8: encoder.encode(category) }],
    [4, reading === null ? { kind: 'null' } : { kind: 'int64', value: reading }],
  ]) }
}

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function path(): string {
  const directory = mkdtempSync(join(tmpdir(), 'chronolog-aggregate-runtime-'))
  directories.push(directory)
  return join(directory, 'state.db')
}

const column = (id: number, name: string): Expr => ({ kind: 'column', id, relation: 'm', name })
const count = (id: number, value?: Expr, distinct = false): AggregateExpr => ({
  kind: 'aggregate', id, operation: 'count', distinct, ...(value === undefined ? {} : { value }),
})
const extremum = (id: number, operation: 'min' | 'max', value: Expr): Expr => ({
  kind: 'aggregate', id, operation, value, distinct: false,
})

function query(projection: Query['projection'], options: Partial<Query> = {}): Query {
  return {
    id: 100, ctes: [], joins: [], groupBy: [], windows: [], compounds: [], orderBy: [],
    from: { kind: 'table', id: 101, name: 'measurements', alias: 'm' },
    projection, resultMode: { kind: 'multiset' }, ...options,
  }
}

describe('canonical aggregates on the real DoltLite runtime', () => {
  it('executes grouped count/min/max with null and distinct semantics', async () => {
    const materializer = await DeterministicMaterializer.open({
      path: path(), schemaManifest: schema, executionManifest,
    })
    try {
      const grouped = query([
        { id: 110, name: 'category', expression: column(111, 'category') },
        { id: 112, name: 'rows', expression: count(113) },
        { id: 114, name: 'present', expression: count(115, column(116, 'reading')) },
        { id: 117, name: 'distinct_present', expression: count(118, column(119, 'reading'), true) },
        { id: 120, name: 'minimum', expression: extremum(121, 'min', column(122, 'reading')) },
        { id: 123, name: 'maximum', expression: extremum(124, 'max', column(125, 'reading')) },
        { id: 131, name: 'missing', expression: {
          ...count(132),
          filter: { kind: 'unary', id: 133, operator: 'is_null', operand: column(134, 'reading') },
        } },
      ], {
        groupBy: [column(126, 'category')],
        having: {
          kind: 'binary', id: 127, operator: 'gte', left: count(128, column(129, 'reading')),
          right: { kind: 'literal', id: 130, value: { kind: 'int64', value: 1n } },
        },
      })
      const result = (await materializer.queryIr(grouped)).result
      const rows = new Map(result.rows.map((row) => {
        const category = row[0]
        if (category?.kind !== 'text') throw new Error('test category type')
        return [decoder.decode(category.utf8), row]
      }))
      expect(rows.get('a')).toEqual([
        { kind: 'text', utf8: encoder.encode('a') },
        { kind: 'int64', value: 3n },
        { kind: 'int64', value: 2n },
        { kind: 'int64', value: 1n },
        { kind: 'int64', value: 5n },
        { kind: 'int64', value: 5n },
        { kind: 'int64', value: 1n },
      ])
      expect(rows.get('b')).toEqual([
        { kind: 'text', utf8: encoder.encode('b') },
        { kind: 'int64', value: 1n },
        { kind: 'int64', value: 1n },
        { kind: 'int64', value: 1n },
        { kind: 'int64', value: 3n },
        { kind: 'int64', value: 3n },
        { kind: 'int64', value: 0n },
      ])
    } finally {
      materializer.close()
    }
  })

  it('returns non-null zero count and nullable extrema for an empty input', async () => {
    const materializer = await DeterministicMaterializer.open({
      path: path(), schemaManifest: schema, executionManifest,
    })
    try {
      const empty = query([
        { id: 140, name: 'rows', expression: count(141) },
        { id: 142, name: 'minimum', expression: extremum(143, 'min', column(144, 'reading')) },
        { id: 145, name: 'maximum_category', expression: extremum(146, 'max', column(147, 'category')) },
      ], {
        where: {
          kind: 'binary', id: 148, operator: 'eq', left: column(149, 'category'),
          right: { kind: 'literal', id: 150, value: { kind: 'text', utf8: encoder.encode('missing') } },
        },
      })
      expect((await materializer.queryIr(empty)).result.rows).toEqual([[
        { kind: 'int64', value: 0n },
        { kind: 'null' },
        { kind: 'null' },
      ]])
    } finally {
      materializer.close()
    }
  })

  it('executes order-independent Boolean every/any with SQL null semantics', async () => {
    const materializer = await DeterministicMaterializer.open({
      path: path(), schemaManifest: schema, executionManifest,
    })
    try {
      const positive: Expr = {
        kind: 'binary', id: 200, operator: 'gt', left: column(201, 'reading'),
        right: { kind: 'literal', id: 202, value: { kind: 'int64', value: 3n } },
      }
      const result = (await materializer.queryIr(query([
        { id: 203, name: 'all_positive', expression: {
          kind: 'aggregate', id: 204, operation: 'every', value: positive, distinct: false,
        } },
        { id: 205, name: 'any_positive', expression: {
          kind: 'aggregate', id: 206, operation: 'any', value: positive, distinct: false,
        } },
        { id: 207, name: 'all_unknown', expression: {
          kind: 'aggregate', id: 208, operation: 'every',
          value: { kind: 'literal', id: 209, value: { kind: 'null' } }, distinct: false,
        } },
      ]))).result
      expect(result.rows).toEqual([[
        { kind: 'boolean', value: false },
        { kind: 'boolean', value: true },
        { kind: 'null' },
      ]])
    } finally {
      materializer.close()
    }
  })
})
