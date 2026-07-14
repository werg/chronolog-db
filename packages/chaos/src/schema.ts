import { defineMutation, defineQuery, type DecodedCanonicalResult, type Mutation, type Query as ClientQuery } from '@chronolog/client'
import {
  affectedRows,
  encodeMutation,
  encodeQuery,
  IrBuilder,
  logicalTypes,
  resultModes,
  SchemaBuilder,
  values,
  type SchemaManifest,
} from '@chronolog/ir'

export function chaosSchema(accountCount: number): SchemaManifest {
  const builder = new SchemaBuilder()
  const id = builder.column('id', builder.type(logicalTypes.int64()))
  const balance = builder.column('balance', builder.type(logicalTypes.int64()))
  const table = builder.table('accounts', [id, balance], [builder.primaryKey('accounts_pk', [id])])
  const seeds = Array.from({ length: accountCount }, (_value, index) =>
    builder.seed(table, new Map([[id, values.int64(BigInt(index))], [balance, values.int64(0n)]])))
  return builder.schema('chaos_accounts', [table], seeds)
}

export function balanceQuery(account: number): ClientQuery<bigint, 'scalar'> {
  const builder = new IrBuilder(1_000 + account * 100)
  const query = builder.query(
    [builder.projection('balance', builder.column('balance', 'account'))],
    {
      from: builder.table('accounts', 'account'),
      where: builder.binary('eq', builder.column('id', 'account'), builder.literal(values.int64(BigInt(account)))),
      resultMode: resultModes.scalar(),
    },
  )
  return defineQuery({
    canonicalBytes: encodeQuery(query),
    resultMode: 'scalar',
    decodeResult: (result) => {
      const value = result.rows[0]?.[0]
      if (typeof value !== 'bigint') throw new Error('CHAOS_BALANCE_RESULT_INVALID')
      return value
    },
  })
}

export function balanceUpdate(account: number, value: bigint): Mutation<'update'> {
  const builder = new IrBuilder(1_000_000)
  const mutation = builder.update(
    'accounts',
    [builder.assignment('balance', builder.literal(values.int64(value)))],
    {
      where: builder.binary('eq', builder.column('id'), builder.literal(values.int64(BigInt(account)))),
      affectedRows: affectedRows.exactly(1n),
      label: 'chaos.balance_update',
    },
  )
  return defineMutation('update', encodeMutation(mutation), 'chaos.balance_update')
}

export function stateQuery(): ClientQuery<DecodedCanonicalResult, 'ordered'> {
  const builder = new IrBuilder()
  const query = builder.query([
    builder.projection('id', builder.column('id', 'account')),
    builder.projection('balance', builder.column('balance', 'account')),
  ], {
    from: builder.table('accounts', 'account'),
    orderBy: [builder.order(builder.column('id', 'account'), 'asc', 'last', true)],
    resultMode: resultModes.ordered(),
  })
  return defineQuery({ canonicalBytes: encodeQuery(query), resultMode: 'ordered', decodeResult: (result) => result })
}

export function transactionLogQuery(): ClientQuery<DecodedCanonicalResult, 'ordered'> {
  const builder = new IrBuilder()
  const query = builder.query([
    builder.projection('tx_id', builder.column('tx_id', 'log')),
    builder.projection('order_index', builder.column('order_index', 'log')),
    builder.projection('author_id', builder.column('author_id', 'log')),
    builder.projection('author_timestamp_ms', builder.column('author_timestamp_ms', 'log')),
    builder.projection('outcome', builder.column('outcome', 'log')),
    builder.projection('rejection_code', builder.column('rejection_code', 'log')),
    builder.projection('result_digest', builder.column('result_digest', 'log')),
  ], {
    from: builder.transactionLog('log'),
    orderBy: [
      builder.order(builder.column('order_index', 'log')),
      builder.order(builder.column('tx_id', 'log'), 'asc', 'last', true),
    ],
    resultMode: resultModes.ordered(),
  })
  return defineQuery({ canonicalBytes: encodeQuery(query), resultMode: 'ordered', decodeResult: (result) => result })
}
