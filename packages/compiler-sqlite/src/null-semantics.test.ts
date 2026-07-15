import { describe, expect, it } from 'vitest'

import { IrBuilder, values, type SchemaManifest } from '@chronolog/ir'

import { compileQuery, compileSchema, createCoreExecutionManifest } from './index.js'

const executionManifest = createCoreExecutionManifest({
  profile: 'null-semantics-test',
  engineDigest: new Uint8Array(32),
})

const schema: SchemaManifest = {
  version: 1,
  name: 'null_semantics',
  objects: [],
  seedRows: [],
  functionIds: [],
  collationIds: [],
  moduleIds: [],
}

const catalog = compileSchema(schema, executionManifest).catalog

describe('polymorphic SQL NULL', () => {
  it('infers CASE result type from non-null arms', () => {
    const builder = new IrBuilder(1)
    const expression = builder.conditional([
      builder.branch(
        builder.literal(values.boolean(true)),
        builder.literal(values.int64(7n)),
      ),
    ], builder.literal(values.null()))

    const compiled = compileQuery(builder.query([
      builder.projection('value', expression),
    ], { resultMode: { kind: 'scalar' } }), catalog)

    expect(compiled.columns[0]?.valueType).toEqual({
      logical: { kind: 'int64' },
      nullable: true,
    })
  })

  it('permits NULL in ordinary comparisons', () => {
    const builder = new IrBuilder(20)
    const comparison = builder.binary(
      'eq',
      builder.literal(values.int64(1n)),
      builder.literal(values.null()),
    )

    const compiled = compileQuery(builder.query([
      builder.projection('matches', comparison),
    ], { resultMode: { kind: 'scalar' } }), catalog)

    expect(compiled.columns[0]?.valueType).toEqual({
      logical: { kind: 'boolean' },
      nullable: true,
    })
  })

  it('infers compound result type from a non-null arm', () => {
    const builder = new IrBuilder(40)
    const base = builder.query([
      builder.projection('value', builder.literal(values.null())),
    ], { resultMode: { kind: 'multiset' } })
    const arm = builder.query([
      builder.projection('value', builder.literal(values.int64(9n))),
    ], { resultMode: { kind: 'multiset' } })

    const compiled = compileQuery({
      ...base,
      compounds: [builder.compound('union_all', arm)],
    }, catalog)

    expect(compiled.columns[0]?.valueType).toEqual({
      logical: { kind: 'int64' },
      nullable: true,
    })
  })
})
