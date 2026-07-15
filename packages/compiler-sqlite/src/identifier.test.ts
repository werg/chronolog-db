import type { ExecutionManifest, Query, SchemaManifest } from '@chronolog/ir'
import { describe, expect, it } from 'vitest'

import { compileMutation, compileQuery, compileSchema } from './index.js'

const manifest: ExecutionManifest = {
  version: 1,
  profile: 'identifier-test',
  engine: 'doltlite-test',
  engineDigest: new Uint8Array(32),
  functions: [], collations: [], modules: [],
  features: { decimal: false, json: false, vector: false, fts: false, spatial: false, wasm: false },
  resources: {
    maxProgramNodes: 1_000, maxExpressionDepth: 32, maxQueryRows: 1_000,
    maxResultBytes: 1_000_000, maxJsonDepth: 32, maxVectorDimensions: 0,
    maxRuleDepth: 0, maxWasmFuel: 0n,
  },
}

function quotedSchema(): SchemaManifest {
  return {
    version: 1,
    name: 'App Schema',
    objects: [{
      kind: 'table', id: 1, name: 'Order Details', declarationOrder: 0, withoutRowId: true,
      columns: [
        { id: 2, name: 'Primary ID', declarationOrder: 0, valueType: { logical: { kind: 'int64' }, nullable: false } },
        { id: 3, name: 'select', declarationOrder: 1, valueType: { logical: { kind: 'text', collation: 'binary' }, nullable: false } },
        { id: 4, name: 'display"name', declarationOrder: 2, valueType: { logical: { kind: 'text', collation: 'binary' }, nullable: true } },
        { id: 5, name: 'é', declarationOrder: 3, valueType: { logical: { kind: 'int64' }, nullable: false } },
        { id: 6, name: 'É', declarationOrder: 4, valueType: { logical: { kind: 'int64' }, nullable: false } },
      ],
      constraints: [{ kind: 'primary_key', id: 7, name: 'Primary Key', columnIds: [2] }],
    }],
    seedRows: [], functionIds: [], collationIds: [], moduleIds: [],
  }
}

describe('SQLite compiler identifier semantics', () => {
  it('quotes arbitrary SQL names and resolves them with SQLite case rules', () => {
    const compiled = compileSchema(quotedSchema(), manifest)
    expect(compiled.statements[0]?.sql).toBe(
      'CREATE TABLE "Order Details" ("Primary ID" INTEGER NOT NULL, "select" TEXT NOT NULL, "display""name" TEXT, "é" INTEGER NOT NULL, "É" INTEGER NOT NULL, CONSTRAINT "Primary Key" PRIMARY KEY ("Primary ID")) STRICT, WITHOUT ROWID',
    )
    const table = compiled.catalog.tableByName('order DETAILS')
    expect(table.name).toBe('Order Details')
    expect(compiled.catalog.column(table, 'primary id').name).toBe('Primary ID')
    expect(compiled.catalog.column(table, 'é').name).toBe('é')
    expect(compiled.catalog.column(table, 'É').name).toBe('É')
  })

  it('resolves case-insensitive table, alias, and column references to declared spellings', () => {
    const query: Query = {
      id: 10, ctes: [], joins: [], groupBy: [], windows: [], compounds: [], orderBy: [],
      from: { kind: 'table', id: 11, name: 'order details', alias: 'Line Item' },
      projection: [{
        id: 12,
        name: 'Selected Value',
        expression: { kind: 'column', id: 13, relation: 'line ITEM', name: 'SELECT' },
      }],
      resultMode: { kind: 'scalar' },
    }
    expect(compileQuery(query, compileSchema(quotedSchema(), manifest).catalog).sql).toBe(
      'SELECT "Line Item"."select" AS "chronolog_p_12" FROM "Order Details" AS "Line Item"',
    )
  })

  it('rejects SQLite-colliding object and column names before rendering', () => {
    const schema = quotedSchema()
    expect(() => compileSchema({
      ...schema,
      objects: [...schema.objects, { ...schema.objects[0]!, id: 20, name: 'order details' }],
    }, manifest)).toThrow(/Duplicate schema object name/)

    expect(() => compileSchema({
      ...schema,
      objects: schema.objects.map((object) => object.kind === 'table'
        ? { ...object, columns: [...object.columns, { ...object.columns[0]!, id: 21, name: 'primary id' }] }
        : object),
    }, manifest)).toThrow(/Duplicate column name/)
  })

  it('treats differently-cased mutation columns as duplicate references', () => {
    const catalog = compileSchema(quotedSchema(), manifest).catalog
    expect(() => compileMutation({
      kind: 'insert',
      id: 30,
      target: { kind: 'name', name: 'ORDER DETAILS' },
      affectedRows: { kind: 'unconstrained' },
      columns: ['Primary ID', 'primary id'],
      rows: [[
        { kind: 'literal', id: 31, value: { kind: 'int64', value: 1n } },
        { kind: 'literal', id: 32, value: { kind: 'int64', value: 2n } },
      ]],
      conflict: 'error',
    }, catalog)).toThrowError(expect.objectContaining({ code: 'IR_DUPLICATE_MUTATION_COLUMN' }))
  })
})
