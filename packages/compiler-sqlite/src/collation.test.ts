import { describe, expect, it } from 'vitest'

import { IrBuilder, values, type SchemaManifest } from '@chronolog/ir'

import { compileMutation, compileQuery, compileSchema, createCoreExecutionManifest } from './index.js'

const manifest = createCoreExecutionManifest({
  profile: 'collation-test',
  engineDigest: new Uint8Array(32),
})

const schema: SchemaManifest = {
  version: 1,
  name: 'collations',
  objects: [{
    kind: 'table', id: 1, name: 'people', declarationOrder: 0, withoutRowId: true,
    columns: [
      { id: 2, name: 'id', declarationOrder: 0, valueType: { logical: { kind: 'int64' }, nullable: false } },
      { id: 3, name: 'name', declarationOrder: 1, valueType: { logical: { kind: 'text', collation: 'nocase' }, nullable: false } },
    ],
    constraints: [{ kind: 'primary_key', id: 4, name: 'people_pk', columnIds: [2] }],
  }],
  seedRows: [], functionIds: [], collationIds: [], moduleIds: [],
}

describe('SQLite collations', () => {
  it('preserves built-in column and expression collations', () => {
    const compiledSchema = compileSchema(schema, manifest)
    expect(compiledSchema.statements[0]?.sql).toContain('"name" TEXT COLLATE NOCASE NOT NULL')

    const builder = new IrBuilder(100)
    const expression = builder.collate(builder.column('name', 'person'), 'rtrim')
    const query = builder.query([builder.projection('name', expression)], {
      from: builder.table('people', 'person'),
      orderBy: [builder.order(expression)],
      resultMode: { kind: 'ordered' },
    })
    const compiled = compileQuery(query, compiledSchema.catalog)
    expect(compiled.sql).toContain('("person"."name" COLLATE RTRIM)')
    expect(compiled.sql).toContain('"chronolog_p_102" COLLATE BINARY ASC NULLS FIRST')
    expect(compiled.columns[0]?.valueType).toEqual({
      logical: { kind: 'text', collation: 'rtrim' }, nullable: false,
    })
  })

  it('does not let collation-equal byte-distinct values choose arbitrary representatives', () => {
    const catalog = compileSchema(schema, manifest).catalog
    const builder = new IrBuilder(300)
    const name = builder.column('name', 'person')
    const projection = builder.projection('name', name)

    expect(() => compileQuery(builder.query([projection], {
      from: builder.table('people', 'person'), distinct: true,
    }), catalog)).toThrowError(expect.objectContaining({
      code: 'IR_DISTINCT_COLLATION_REPRESENTATIVE_REQUIRED',
    }))

    expect(() => compileQuery(builder.query([projection], {
      from: builder.table('people', 'person'), groupBy: [name],
    }), catalog)).toThrowError(expect.objectContaining({
      code: 'IR_GROUP_COLLATION_REPRESENTATIVE_REQUIRED',
    }))

    expect(() => compileQuery(builder.query([
      builder.projection('minimum', builder.aggregate('min', name)),
    ], { from: builder.table('people', 'person') }), catalog)).toThrowError(
      expect.objectContaining({ code: 'IR_AGGREGATE_COLLATION_REPRESENTATIVE_REQUIRED' }),
    )
  })

  it('uses binary byte ties for observable UPSERT source visitation', () => {
    const catalog = compileSchema(schema, manifest).catalog
    const builder = new IrBuilder(400)
    const source = builder.query([
      builder.projection('id', builder.column('id', 'source')),
      builder.projection('name', builder.column('name', 'source')),
    ], { from: builder.table('people', 'source') })
    const mutation = builder.insertSelect('people', ['id', 'name'], source, {
      upsertClauses: [builder.upsertDoUpdate([
        builder.assignment('name', builder.oldNew('new', 'name')),
      ], builder.upsertConstraintTarget(4))],
    })
    expect(compileMutation(mutation, catalog).sql).toContain(
      '."chronolog_p_403" COLLATE BINARY ASC NULLS FIRST',
    )
  })

  it('treats collation as comparison metadata rather than stored-value type identity', () => {
    const catalog = compileSchema(schema, manifest).catalog
    const builder = new IrBuilder(500)
    const name = builder.column('name', 'person')
    const empty = builder.literal(values.text(''))
    const explicitEmpty = builder.collate(builder.literal(values.text('')), 'rtrim')
    const query = builder.query([
      builder.projection('cast_name', builder.cast(name, { kind: 'text', collation: 'binary' })),
      builder.projection('coalesced', builder.builtin('coalesce', [name, empty])),
      builder.projection('conditional', builder.conditional([
        builder.branch(builder.literal(values.boolean(true)), name),
      ], empty)),
      builder.projection('explicit', builder.builtin('coalesce', [name, explicitEmpty])),
      builder.projection('likely_name', builder.builtin('likely', [name])),
      builder.projection('member', builder.membership(name, [builder.literal(values.text('ALICE'))])),
      builder.projection('row_equal', builder.binary(
        'eq',
        builder.row([name, builder.column('id', 'person')]),
        builder.row([builder.literal(values.text('ALICE')), builder.literal(values.int64(1n))]),
      )),
    ], { from: builder.table('people', 'person') })
    const compiled = compileQuery(query, catalog)

    expect(compiled.columns.map((column) => column.valueType)).toEqual([
      { logical: { kind: 'text', collation: 'nocase' }, nullable: false },
      { logical: { kind: 'text', collation: 'binary' }, nullable: false },
      { logical: { kind: 'text', collation: 'binary' }, nullable: false },
      { logical: { kind: 'text', collation: 'rtrim' }, nullable: false },
      { logical: { kind: 'text', collation: 'binary' }, nullable: false },
      { logical: { kind: 'boolean' }, nullable: false },
      { logical: { kind: 'boolean' }, nullable: false },
    ])

    const source = builder.query([
      builder.projection('id', builder.literal(values.int64(2n))),
      builder.projection('name', builder.literal(values.text('binary source'))),
    ])
    expect(() => compileMutation(builder.insertSelect('people', ['id', 'name'], source), catalog))
      .not.toThrow()
    expect(() => compileMutation(builder.update('people', [
      builder.assignment('name', builder.builtin('lower', [builder.column('name', 'people')])),
    ]), catalog)).not.toThrow()
  })

  it('resolves manifest-registered collations by stable ID', () => {
    const registeredManifest = {
      ...manifest,
      collations: [{ id: 9, name: 'reverse_text', implementationDigest: new Uint8Array(32) }],
    }
    const registeredSchema: SchemaManifest = {
      ...schema,
      collationIds: [9],
      objects: schema.objects.map((object) => object.kind !== 'table' ? object : ({
        ...object,
        columns: object.columns.map((column) => column.name !== 'name' ? column : ({
          ...column,
          valueType: { ...column.valueType, logical: { kind: 'text', collation: 'registered:9' } },
        })),
      })),
    }
    const compiled = compileSchema(registeredSchema, registeredManifest)
    expect(compiled.statements[0]?.sql).toContain('COLLATE "reverse_text"')
  })
})
