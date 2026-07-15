import { describe, expect, it } from 'vitest'

import { IrBuilder, type SchemaManifest } from '@chronolog/ir'

import { compileQuery, compileSchema, createCoreExecutionManifest } from './index.js'

const executionManifest = createCoreExecutionManifest({
  profile: 'join-test',
  engineDigest: new Uint8Array(32),
})

const schema: SchemaManifest = {
  version: 1,
  name: 'joins',
  objects: [
    {
      kind: 'table', id: 1, name: 'parents', declarationOrder: 0, withoutRowId: true,
      columns: [
        { id: 2, name: 'id', declarationOrder: 0, valueType: { logical: { kind: 'int64' }, nullable: false } },
      ],
      constraints: [{ kind: 'primary_key', id: 3, name: 'parents_pk', columnIds: [2] }],
    },
    {
      kind: 'table', id: 4, name: 'children', declarationOrder: 1, withoutRowId: true,
      columns: [
        { id: 5, name: 'id', declarationOrder: 0, valueType: { logical: { kind: 'int64' }, nullable: false } },
        { id: 6, name: 'label', declarationOrder: 1, valueType: { logical: { kind: 'text', collation: 'binary' }, nullable: false } },
      ],
      constraints: [{ kind: 'primary_key', id: 7, name: 'children_pk', columnIds: [5] }],
    },
  ],
  seedRows: [],
  functionIds: [],
  collationIds: [],
  moduleIds: [],
}

describe('outer joins', () => {
  it('marks columns from the null-extended side nullable', () => {
    const builder = new IrBuilder(100)
    const query = builder.query([
      builder.projection('child_label', builder.column('label', 'child')),
    ], {
      from: builder.table('parents', 'parent'),
      joins: [builder.join(
        'left',
        builder.table('children', 'child'),
        builder.binary('eq', builder.column('id', 'parent'), builder.column('id', 'child')),
      )],
      resultMode: { kind: 'multiset' },
    })

    const compiled = compileQuery(query, compileSchema(schema, executionManifest).catalog)

    expect(compiled.sql).toContain('LEFT JOIN')
    expect(compiled.columns[0]?.valueType).toEqual({
      logical: { kind: 'text', collation: 'binary' },
      nullable: true,
    })
  })

  it('models RIGHT and FULL null extension and renders USING directly', () => {
    const rightBuilder = new IrBuilder(200)
    const right = rightBuilder.query([
      rightBuilder.projection('parent_id', rightBuilder.column('id', 'parent')),
      rightBuilder.projection('child_label', rightBuilder.column('label', 'child')),
    ], {
      from: rightBuilder.table('parents', 'parent'),
      joins: [rightBuilder.join('right', rightBuilder.table('children', 'child'), undefined, ['id'])],
    })
    const rightCompiled = compileQuery(right, compileSchema(schema, executionManifest).catalog)
    expect(rightCompiled.sql).toContain('RIGHT JOIN "children" AS "child" USING ("id")')
    expect(rightCompiled.columns.map((column) => column.valueType.nullable)).toEqual([true, false])

    const fullBuilder = new IrBuilder(300)
    const full = fullBuilder.query([
      fullBuilder.projection('parent_id', fullBuilder.column('id', 'parent')),
      fullBuilder.projection('child_label', fullBuilder.column('label', 'child')),
    ], {
      from: fullBuilder.table('parents', 'parent'),
      joins: [fullBuilder.join('full', fullBuilder.table('children', 'child'), undefined, ['id'])],
    })
    const fullCompiled = compileQuery(full, compileSchema(schema, executionManifest).catalog)
    expect(fullCompiled.sql).toContain('FULL JOIN "children" AS "child" USING ("id")')
    expect(fullCompiled.columns.map((column) => column.valueType.nullable)).toEqual([true, true])
  })

  it('treats an explicit alias as hiding the original table name', () => {
    const builder = new IrBuilder(400)
    const query = builder.query([
      builder.projection('id', builder.column('id', 'parents')),
    ], {
      from: builder.table('parents', 'parents'),
      joins: [builder.join('inner', builder.table('parents', 'other'), undefined, ['id'])],
    })
    expect(() => compileQuery(query, compileSchema(schema, executionManifest).catalog)).not.toThrow()
  })

  it('preserves SQLite CROSS JOIN constraints', () => {
    const builder = new IrBuilder(500)
    const query = builder.query([
      builder.projection('label', builder.column('label', 'child')),
    ], {
      from: builder.table('parents', 'parent'),
      joins: [builder.join(
        'cross',
        builder.table('children', 'child'),
        builder.binary('eq', builder.column('id', 'parent'), builder.column('id', 'child')),
      )],
    })

    expect(compileQuery(query, compileSchema(schema, executionManifest).catalog).sql).toContain(
      'CROSS JOIN "children" AS "child" ON ("parent"."id" = "child"."id")',
    )
  })
})
