import { describe, expect, it } from 'vitest'

import { IrBuilder, type SchemaManifest } from '@chronolog/ir'

import { compileQuery, compileSchema, createCoreExecutionManifest, type CompilerError } from './index.js'

const executionManifest = createCoreExecutionManifest({
  profile: 'ordering-safety-test',
  engineDigest: new Uint8Array(32),
})

const schema: SchemaManifest = {
  version: 1,
  name: 'ordering_safety',
  objects: [{
    kind: 'table', id: 1, name: 'items', declarationOrder: 0, withoutRowId: true,
    columns: [
      { id: 2, name: 'id', declarationOrder: 0, valueType: { logical: { kind: 'int64' }, nullable: false } },
      { id: 3, name: 'category', declarationOrder: 1, valueType: { logical: { kind: 'text', collation: 'binary' }, nullable: false } },
      { id: 4, name: 'priority', declarationOrder: 2, valueType: { logical: { kind: 'int64' }, nullable: false } },
    ],
    constraints: [{ kind: 'primary_key', id: 5, name: 'items_pk', columnIds: [2] }],
  }],
  seedRows: [],
  functionIds: [],
  collationIds: [],
  moduleIds: [],
}

describe('ordering safety', () => {
  it('rejects DISTINCT ordering by a value absent from the distinct row', () => {
    const builder = new IrBuilder(100)
    const query = builder.query([
      builder.projection('category', builder.column('category', 'item')),
    ], {
      from: builder.table('items', 'item'),
      distinct: true,
      orderBy: [builder.order(builder.column('priority', 'item'))],
      resultMode: { kind: 'ordered' },
    })

    expect(() => compileQuery(query, compileSchema(schema, executionManifest).catalog))
      .toThrowError(expect.objectContaining<Partial<CompilerError>>({
        code: 'IR_DISTINCT_ORDER_TERM_NOT_RESULT',
      }))
  })

  it('accepts DISTINCT ordering represented in the projected row', () => {
    const builder = new IrBuilder(200)
    const category = builder.column('category', 'item')
    const query = builder.query([
      builder.projection('category', category),
    ], {
      from: builder.table('items', 'item'),
      distinct: true,
      orderBy: [builder.order(builder.column('category'))],
      resultMode: { kind: 'ordered' },
    })

    expect(compileQuery(query, compileSchema(schema, executionManifest).catalog).sql)
      .toContain('SELECT DISTINCT')
  })
})
