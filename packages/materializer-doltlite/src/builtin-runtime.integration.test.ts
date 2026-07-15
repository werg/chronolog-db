import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createCoreExecutionManifest } from '@chronolog/compiler-sqlite'
import { IrBuilder, values, type LogicalValue, type SchemaManifest } from '@chronolog/ir'
import { afterEach, describe, expect, it } from 'vitest'

import { readNativeEngineInfo } from './driver.js'
import { DeterministicMaterializer } from './materializer.js'

const executionManifest = createCoreExecutionManifest({
  profile: 'builtin-runtime-integration',
  engineDigest: readNativeEngineInfo().digest,
})
const schema: SchemaManifest = {
  version: 1,
  name: 'builtin_runtime',
  objects: [{
    kind: 'table', id: 1, name: 'extrema', declarationOrder: 0, withoutRowId: true,
    columns: [
      { id: 2, name: 'id', declarationOrder: 0, valueType: { logical: { kind: 'int64' }, nullable: false } },
      { id: 3, name: 'value', declarationOrder: 1, valueType: { logical: { kind: 'int64' }, nullable: false } },
    ],
    constraints: [{ kind: 'primary_key', id: 4, name: 'extrema_pk', columnIds: [2] }],
  }],
  seedRows: [{ tableId: 1, values: new Map<number, LogicalValue>([
    [2, { kind: 'int64', value: 1n }],
    [3, { kind: 'int64', value: -9_223_372_036_854_775_808n }],
  ]) }],
  functionIds: [], collationIds: [], moduleIds: [],
}
const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function path(): string {
  const directory = mkdtempSync(join(tmpdir(), 'chronolog-builtin-runtime-'))
  directories.push(directory)
  return join(directory, 'state.db')
}

describe('compiler-owned builtins on the real DoltLite runtime', () => {
  it('executes pinned text, blob, selection, and integer semantics', async () => {
    const materializer = await DeterministicMaterializer.open({
      path: path(), schemaManifest: schema, executionManifest,
    })
    try {
      const builder = new IrBuilder()
      const text = (value: string) => builder.literal(values.text(value))
      const integer = (value: bigint) => builder.literal(values.int64(value))
      const nullValue = () => builder.literal(values.null())
      const query = builder.query([
        builder.projection('length', builder.builtin('length', [text('Aé')])),
        builder.projection('octets', builder.builtin('octet_length', [text('Aé')])),
        builder.projection('lower', builder.builtin('lower', [text('ÄBC')])),
        builder.projection('upper', builder.builtin('upper', [text('äbc')])),
        builder.projection('trim', builder.builtin('trim', [text('xxhellox'), text('x')])),
        builder.projection('replace', builder.builtin('replace', [text('banana'), text('a'), text('o')])),
        builder.projection('instr', builder.builtin('instr', [text('banana'), text('na')])),
        builder.projection('substring', builder.builtin('substr', [text('AéZ'), integer(2n), integer(1n)])),
        builder.projection('blob_substring', builder.builtin('substring', [
          builder.literal(values.blob(Uint8Array.of(1, 2, 3, 4))), integer(2n), integer(2n),
        ])),
        builder.projection('hex', builder.builtin('hex', [builder.literal(values.blob(Uint8Array.of(0xab, 0)))])),
        builder.projection('hex_null', builder.builtin('hex', [nullValue()])),
        builder.projection('coalesce', builder.builtin('coalesce', [nullValue(), integer(9n)])),
        builder.projection('ifnull', builder.builtin('ifnull', [nullValue(), text('fallback')])),
        builder.projection('nullif', builder.builtin('nullif', [integer(7n), integer(7n)])),
        builder.projection('absolute', builder.builtin('abs', [integer(-7n)])),
        builder.projection('sign', builder.builtin('sign', [integer(-7n)])),
      ])
      expect((await materializer.queryIr(query)).result.rows).toEqual([[
        { kind: 'int64', value: 2n },
        { kind: 'int64', value: 3n },
        { kind: 'text', utf8: new TextEncoder().encode('Äbc') },
        { kind: 'text', utf8: new TextEncoder().encode('äBC') },
        { kind: 'text', utf8: new TextEncoder().encode('hello') },
        { kind: 'text', utf8: new TextEncoder().encode('bonono') },
        { kind: 'int64', value: 3n },
        { kind: 'text', utf8: new TextEncoder().encode('é') },
        { kind: 'blob', bytes: Uint8Array.of(2, 3) },
        { kind: 'text', utf8: new TextEncoder().encode('AB00') },
        { kind: 'text', utf8: new Uint8Array() },
        { kind: 'int64', value: 9n },
        { kind: 'text', utf8: new TextEncoder().encode('fallback') },
        { kind: 'null' },
        { kind: 'int64', value: 7n },
        { kind: 'int64', value: -1n },
      ]])
    } finally {
      materializer.close()
    }
  })

  it('normalizes literal and row-sourced minimum-Int64 abs overflow for consensus only', async () => {
    const materializer = await DeterministicMaterializer.open({
      path: path(), schemaManifest: schema, executionManifest,
    })
    try {
      const literalBuilder = new IrBuilder()
      const literal = literalBuilder.query([
        literalBuilder.projection('absolute', literalBuilder.builtin('abs', [
          literalBuilder.literal(values.int64(-9_223_372_036_854_775_808n)),
        ])),
      ])
      await expect(materializer.queryIr(literal)).rejects.toMatchObject({ code: 'SQL_EVALUATION_ERROR' })

      const rowBuilder = new IrBuilder()
      const rowValue = rowBuilder.query([
        rowBuilder.projection('absolute', rowBuilder.builtin('abs', [rowBuilder.column('value', 'e')])),
      ], { from: rowBuilder.table('extrema', 'e') })
      await expect(materializer.queryIr(rowValue)).rejects.toMatchObject({ code: 'SQL_EVALUATION_ERROR' })

      let localError: unknown
      try {
        materializer.localSql('SELECT abs(-9223372036854775808)')
      } catch (error) {
        localError = error
      }
      expect(localError).toMatchObject({ sqliteCode: 1 })
      expect(localError).not.toMatchObject({ code: 'SQL_EVALUATION_ERROR' })
    } finally {
      materializer.close()
    }
  })
})
