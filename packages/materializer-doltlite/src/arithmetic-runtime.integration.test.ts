import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createCoreExecutionManifest } from '@chronolog/compiler-sqlite'
import { IrBuilder, values, type Expr, type LogicalValue, type Query, type SchemaManifest } from '@chronolog/ir'
import { afterEach, describe, expect, it } from 'vitest'

import { readNativeEngineInfo } from './driver.js'
import { DeterministicMaterializer } from './materializer.js'

const executionManifest = createCoreExecutionManifest({
  profile: 'arithmetic-runtime-integration',
  engineDigest: readNativeEngineInfo().digest,
})
const schema: SchemaManifest = {
  version: 1,
  name: 'arithmetic_runtime',
  objects: [{
    kind: 'table', id: 1, name: 'numbers', declarationOrder: 0, withoutRowId: true,
    columns: [
      { id: 2, name: 'id', declarationOrder: 0, valueType: { logical: { kind: 'int64' }, nullable: false } },
      { id: 3, name: 'value', declarationOrder: 1, valueType: { logical: { kind: 'int64' }, nullable: false } },
    ],
    constraints: [{ kind: 'primary_key', id: 4, name: 'numbers_pk', columnIds: [2] }],
  }],
  seedRows: [
    seed(1n, 7n),
    seed(2n, 9_223_372_036_854_775_807n),
    seed(3n, -9_223_372_036_854_775_808n),
  ],
  functionIds: [], collationIds: [], moduleIds: [],
}

function seed(id: bigint, value: bigint): SchemaManifest['seedRows'][number] {
  return { tableId: 1, values: new Map<number, LogicalValue>([
    [2, { kind: 'int64', value: id }],
    [3, { kind: 'int64', value }],
  ]) }
}

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function path(): string {
  const directory = mkdtempSync(join(tmpdir(), 'chronolog-arithmetic-runtime-'))
  directories.push(directory)
  return join(directory, 'state.db')
}

function failingQuery(expression: (builder: IrBuilder) => Expr): Query {
  const builder = new IrBuilder()
  return builder.query([builder.projection('value', expression(builder))])
}

describe('checked integer arithmetic on the real DoltLite runtime', () => {
  it('executes exact arithmetic, bitwise XOR, checked shifts, and null propagation', async () => {
    const materializer = await DeterministicMaterializer.open({
      path: path(), schemaManifest: schema, executionManifest,
    })
    try {
      const builder = new IrBuilder()
      const integer = (value: bigint): Expr => builder.literal(values.int64(value))
      const binary = (operator: 'add' | 'subtract' | 'multiply' | 'divide' | 'modulo' | 'bit_xor' | 'shift_left' | 'shift_right', left: bigint, right: bigint): Expr =>
        builder.binary(operator, integer(left), integer(right))
      const query = builder.query([
        builder.projection('negate', builder.unary('negate', integer(-7n))),
        builder.projection('add', binary('add', 40n, 2n)),
        builder.projection('subtract', binary('subtract', 40n, 2n)),
        builder.projection('multiply', binary('multiply', -6n, 7n)),
        builder.projection('divide', binary('divide', -7n, 3n)),
        builder.projection('modulo', binary('modulo', -7n, 3n)),
        builder.projection('xor', binary('bit_xor', 6n, 3n)),
        builder.projection('left_shift', binary('shift_left', 3n, 2n)),
        builder.projection('right_shift', binary('shift_right', -8n, 2n)),
        builder.projection('timestamp_plus_duration', builder.binary(
          'add', builder.literal(values.timestampMs(1_000n)), builder.literal(values.durationMs(250n)),
        )),
        builder.projection('timestamp_difference', builder.binary(
          'subtract', builder.literal(values.timestampMs(1_000n)), builder.literal(values.timestampMs(250n)),
        )),
        builder.projection('scaled_duration', builder.binary(
          'multiply', builder.literal(values.durationMs(250n)), integer(3n),
        )),
        builder.projection('negated_duration', builder.unary(
          'negate', builder.literal(values.durationMs(250n)),
        )),
        builder.projection('null_add', builder.binary(
          'add', builder.literal(values.null()), integer(1n),
        )),
      ])
      expect((await materializer.queryIr(query)).result.rows).toEqual([[
        { kind: 'int64', value: 7n },
        { kind: 'int64', value: 42n },
        { kind: 'int64', value: 38n },
        { kind: 'int64', value: -42n },
        { kind: 'int64', value: -2n },
        { kind: 'int64', value: -1n },
        { kind: 'int64', value: 5n },
        { kind: 'int64', value: 12n },
        { kind: 'int64', value: -2n },
        { kind: 'timestamp_ms', value: 1_250n },
        { kind: 'duration_ms', value: 750n },
        { kind: 'duration_ms', value: 750n },
        { kind: 'duration_ms', value: -250n },
        { kind: 'null' },
      ]])
    } finally {
      materializer.close()
    }
  })

  it('rejects overflow, zero divisors, and invalid shifts deterministically', async () => {
    const materializer = await DeterministicMaterializer.open({
      path: path(), schemaManifest: schema, executionManifest,
    })
    try {
      const failures = [
        failingQuery((builder) => builder.binary('add',
          builder.literal(values.int64(9_223_372_036_854_775_807n)), builder.literal(values.int64(1n)))),
        failingQuery((builder) => builder.binary('subtract',
          builder.literal(values.int64(-9_223_372_036_854_775_808n)), builder.literal(values.int64(1n)))),
        failingQuery((builder) => builder.binary('multiply',
          builder.literal(values.int64(9_223_372_036_854_775_807n)), builder.literal(values.int64(2n)))),
        failingQuery((builder) => builder.binary('add',
          builder.literal(values.timestampMs(9_223_372_036_854_775_807n)), builder.literal(values.durationMs(1n)))),
        failingQuery((builder) => builder.unary('negate',
          builder.literal(values.int64(-9_223_372_036_854_775_808n)))),
        failingQuery((builder) => builder.binary('divide',
          builder.literal(values.int64(-9_223_372_036_854_775_808n)), builder.literal(values.int64(-1n)))),
        failingQuery((builder) => builder.binary('divide',
          builder.literal(values.int64(1n)), builder.literal(values.int64(0n)))),
        failingQuery((builder) => builder.binary('modulo',
          builder.literal(values.int64(1n)), builder.literal(values.int64(0n)))),
        failingQuery((builder) => builder.binary('shift_left',
          builder.literal(values.int64(1n)), builder.literal(values.int64(63n)))),
        failingQuery((builder) => builder.binary('shift_right',
          builder.literal(values.int64(1n)), builder.literal(values.int64(-1n)))),
      ]
      for (const query of failures) {
        await expect(materializer.queryIr(query)).rejects.toMatchObject({ code: 'SQL_EVALUATION_ERROR' })
      }

      const rowBuilder = new IrBuilder()
      const rowOverflow = rowBuilder.query([
        rowBuilder.projection('value', rowBuilder.binary(
          'add', rowBuilder.column('value', 'n'), rowBuilder.literal(values.int64(1n)),
        )),
      ], {
        from: rowBuilder.table('numbers', 'n'),
        where: rowBuilder.binary(
          'eq', rowBuilder.column('id', 'n'), rowBuilder.literal(values.int64(2n)),
        ),
      })
      await expect(materializer.queryIr(rowOverflow)).rejects.toMatchObject({ code: 'SQL_EVALUATION_ERROR' })
    } finally {
      materializer.close()
    }
  })
})
