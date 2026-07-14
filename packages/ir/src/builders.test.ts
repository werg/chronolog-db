import { describe, expect, it } from 'vitest'

import {
  IrBuilder, affectedRows, decodeQuery, decodeTransactionProgram, encodeQuery,
  encodeTransactionProgram, logicalTypes, resultModes, validateTransactionProgram, values,
  type Query, type Relation,
} from './index.js'

describe('IrBuilder expressions and relational queries', () => {
  it('allocates stable IDs only for ID-bearing nodes', () => {
    const builder = new IrBuilder(50)
    const parameter = builder.parameter('input', { logical: logicalTypes.int64(), nullable: false })
    const unary = builder.unary('negate', parameter)
    const branch = builder.branch(builder.literal(values.boolean(true)), unary)
    const conditional = builder.conditional([branch], builder.literal(values.int64(0n)))
    const table = builder.table('items', 'i')
    const projection = builder.projection('value', conditional)
    const page = builder.page(10, 2)
    const query = builder.query([projection], { from: table, page, orderBy: [builder.order(builder.column('id', 'i'), 'asc', 'last', true)], resultMode: resultModes.ordered() })

    expect(parameter.id).toBe(50)
    expect(unary.id).toBe(51)
    expect(branch).not.toHaveProperty('id')
    expect(conditional.id).toBe(54)
    expect(table.id).toBe(55)
    expect(projection.id).toBe(56)
    expect(page).not.toHaveProperty('id')
    expect(query.id).toBe(59)
  })

  it('round-trips all expression helpers and keeps caller arrays immutable', () => {
    const builder = new IrBuilder()
    const scalarQuery = scalar(builder, values.int64(1n), 'one')
    const functionArgs = [builder.literal(values.int64(2n))]
    const expressions = [
      builder.parameter('parameter', { logical: logicalTypes.text(), nullable: true }),
      builder.oldNew('old', 'value'),
      builder.unary('not', builder.literal(values.boolean(false))),
      builder.binary('add', builder.literal(values.int64(1n)), builder.literal(values.int64(2n))),
      builder.conditional([builder.branch(builder.literal(values.boolean(true)), builder.literal(values.text('yes')))], builder.literal(values.text('no'))),
      builder.cast(builder.literal(values.int64(3n)), logicalTypes.decimal(10, 2)),
      builder.functionCall(7, functionArgs),
      builder.jsonOperation('extract', [builder.literal(values.json(new Map([['a', 1n]])))], '$.a'),
      builder.scalarSubquery(scalarQuery),
      builder.exists(scalar(builder, values.boolean(true), 'present'), true),
      builder.membership(builder.literal(values.int64(1n)), [builder.literal(values.int64(1n)), builder.literal(values.int64(2n))]),
      builder.membership(builder.literal(values.int64(1n)), scalar(builder, values.int64(1n), 'member'), true),
      builder.entropy('test/sample', 2, 16),
    ]
    functionArgs.push(builder.literal(values.int64(999n)))
    const projections = expressions.map((expression, index) => builder.projection(`v${index}`, expression))
    const query = builder.query(projections, { from: builder.table('items', 'i'), resultMode: resultModes.multiset() })

    expect((expressions[6] as { readonly args: readonly unknown[] }).args).toHaveLength(1)
    expect(decodeQuery(encodeQuery(query))).toEqual(query)
    expect(Object.isFrozen(query)).toBe(true)
    expect(Object.isFrozen(query.projection)).toBe(true)
    expect(Object.isFrozen(query.projection[0]!.expression)).toBe(true)
  })

  it('round-trips every relation and advanced query option', () => {
    const builder = new IrBuilder()
    const nested = scalar(builder, values.int64(1n), 'nested')
    const relations: Relation[] = [
      builder.view('active_items', 'v'),
      builder.subquery(nested, 'sq'),
      builder.cteReference('recent', 'r'),
      builder.tableFunction(9, [builder.literal(values.int64(1n))], 'tf'),
      builder.fts(10, builder.literal(values.text('needle')), 'fts'),
      builder.vectorSearch(11, builder.literal(values.vector('f32', 1, new Uint8Array(4))), 5, 'vec'),
      builder.spatialSearch(12, builder.literal(values.boolean(true)), 'geo'),
      builder.transactionLog('tx'),
    ]
    const joins = relations.map((relation) => builder.join('cross', relation))
    const cteQuery = scalar(builder, values.int64(2n), 'id')
    const cte = builder.cte('recent', cteQuery, 'materialized')
    const windowOrder = builder.order(builder.literal(values.int64(1n)), 'asc', 'last', true)
    const window = builder.window('ranked', [builder.literal(values.int64(1n))], [windowOrder])
    const compound = builder.compound('union_all', scalar(builder, values.int64(3n), 'id'))
    const finalOrder = builder.order(builder.column('id', 'base'), 'asc', 'last', true)
    const joinInput = [...joins]
    const query = builder.query([builder.projection('id', builder.column('id', 'base'))], {
      ctes: [cte], from: builder.table('items', 'base'), joins: joinInput,
      where: builder.literal(values.boolean(true)), groupBy: [builder.column('id', 'base')],
      having: builder.literal(values.boolean(true)), windows: [window], compounds: [compound],
      orderBy: [finalOrder], page: builder.page(25, 5), resultMode: resultModes.ordered(),
    })
    joinInput.length = 0

    expect(query.joins).toHaveLength(relations.length)
    expect(decodeQuery(encodeQuery(query))).toEqual(query)
  })
})

describe('IrBuilder mutations and preconditions', () => {
  it('builds and round-trips every mutation variant with unique IDs', () => {
    const builder = new IrBuilder()
    const assertion = builder.assertion(scalar(builder, values.boolean(true), 'ok'))
    const insert = builder.insert('items', ['id'], [[builder.literal(values.int64(1n))]], {
      conflict: 'ignore', affectedRows: affectedRows.exactly(1n), label: 'insert-item',
    })
    const update = builder.update(1, [builder.assignment('value', builder.literal(values.text('updated')))], {
      where: builder.binary('eq', builder.column('id'), builder.literal(values.int64(1n))),
      affectedRows: affectedRows.atMost(1n),
    })
    const deletion = builder.delete({ kind: 'name', name: 'expired_items' }, {
      where: builder.literal(values.boolean(false)), affectedRows: affectedRows.range(0n, 5n),
    })
    const upsert = builder.upsert('items', ['id', 'value'], [builder.literal(values.int64(2n)), builder.literal(values.text('new'))], 'items_pk', [
      builder.assignment('value', builder.literal(values.text('replaced'))),
    ], { affectedRows: affectedRows.atLeast(1n) })
    const source = scalar(builder, values.int64(3n), 'id')
    const clause = builder.mergeClause('matched', 'update', [builder.assignment('value', builder.literal(values.text('merged')))], builder.literal(values.boolean(true)))
    const merge = builder.merge('items', source, builder.literal(values.boolean(true)), [clause], { affectedRows: affectedRows.unconstrained() })
    const stateful = builder.statefulCall(5, 8, [builder.literal(values.int64(9n))], { affectedRows: affectedRows.exactly(1n) })
    const program = builder.program([assertion], [insert, update, deletion, upsert, merge, stateful], new Map([['intent', Uint8Array.of(1, 2)]]))

    expect(validateTransactionProgram(program).ok).toBe(true)
    expect(decodeTransactionProgram(encodeTransactionProgram(program))).toEqual(program)
    const built = builder.build(program).program
    expect(Object.isFrozen(built)).toBe(true)
    expect(Object.isFrozen(built.mutations)).toBe(true)
    expect(Object.isFrozen(built.mutations[0])).toBe(true)
  })

  it('builds inline and digest expectations and copies digest bytes', () => {
    const builder = new IrBuilder()
    const query = scalar(builder, values.int64(7n), 'value')
    const resultColumn = builder.resultColumn('value', { logical: logicalTypes.int64(), nullable: false })
    const inlineResult = builder.queryResult(resultModes.scalar(), [resultColumn], [[values.int64(7n)]])
    const inlineExpectation = builder.expectInline(query, inlineResult)
    const digest = new Uint8Array(32).fill(4)
    const digestExpectation = builder.expectResultDigest(scalar(builder, values.int64(8n), 'value'), digest, resultModes.scalar(), [builder.resultColumn('value', { logical: logicalTypes.int64(), nullable: false })])
    digest[0] = 99
    const mutation = builder.insert('items', ['id'], [[builder.literal(values.int64(7n))]], affectedRows.exactly(1n))
    const program = builder.program([inlineExpectation, digestExpectation], [mutation])

    expect(digestExpectation.kind).toBe('expect')
    if (digestExpectation.kind === 'expect' && digestExpectation.expected.kind === 'digest') expect(digestExpectation.expected.digest[0]).toBe(4)
    expect(decodeTransactionProgram(encodeTransactionProgram(program))).toEqual(program)
  })

  it('provides closed, immutable affected-row helpers', () => {
    expect(affectedRows.unconstrained()).toEqual({ kind: 'unconstrained' })
    expect(affectedRows.exactly(2n)).toEqual({ kind: 'exactly', count: 2n })
    expect(affectedRows.atLeast(2n)).toEqual({ kind: 'at_least', count: 2n })
    expect(affectedRows.atMost(3n)).toEqual({ kind: 'at_most', count: 3n })
    expect(affectedRows.range(2n, 4n)).toEqual({ kind: 'range', minimum: 2n, maximum: 4n })
    expect(Object.isFrozen(affectedRows.range(0n, 1n))).toBe(true)
  })
})

function scalar(builder: IrBuilder, value: ReturnType<typeof values.int64>  , name: string): Query
function scalar(builder: IrBuilder, value: Parameters<IrBuilder['literal']>[0], name: string): Query
function scalar(builder: IrBuilder, value: Parameters<IrBuilder['literal']>[0], name: string): Query {
  return builder.query([builder.projection(name, builder.literal(value))], { resultMode: resultModes.scalar() })
}
