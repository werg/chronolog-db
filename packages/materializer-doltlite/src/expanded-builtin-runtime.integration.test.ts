import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createCoreExecutionManifest } from '@chronolog/compiler-sqlite'
import { IrBuilder, values, type Expr, type SchemaManifest } from '@chronolog/ir'
import { afterEach, describe, expect, it } from 'vitest'

import { readNativeEngineInfo } from './driver.js'
import { DeterministicMaterializer } from './materializer.js'

const executionManifest = createCoreExecutionManifest({
  profile: 'expanded-builtin-runtime-integration',
  engineDigest: readNativeEngineInfo().digest,
})
const schema: SchemaManifest = {
  version: 1,
  name: 'expanded_builtin_runtime',
  objects: [],
  seedRows: [],
  functionIds: [],
  collationIds: [],
  moduleIds: [],
}
const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function path(): string {
  const directory = mkdtempSync(join(tmpdir(), 'chronolog-expanded-builtin-runtime-'))
  directories.push(directory)
  return join(directory, 'state.db')
}

describe('expanded compiler-owned builtins on the real DoltLite runtime', () => {
  it('returns canonical exact values for the expanded SQLite 3.54 surface', async () => {
    const materializer = await DeterministicMaterializer.open({
      path: path(), schemaManifest: schema, executionManifest,
    })
    try {
      const builder = new IrBuilder()
      const nullValue = (): Expr => builder.literal(values.null())
      const integer = (value: bigint): Expr => builder.literal(values.int64(value))
      const text = (value: string): Expr => builder.literal(values.text(value))
      const query = builder.query([
        builder.projection('characters', builder.builtin('char', [integer(65n), nullValue()])),
        builder.projection('concatenated', builder.builtin('concat', [text('a'), integer(1n), nullValue()])),
        builder.projection('joined', builder.builtin('concat_ws', [text('-'), text('a'), nullValue(), text('b')])),
        builder.projection('selected', builder.builtin('if', [integer(1n), text('yes'), text('no')])),
        builder.projection('optional', builder.builtin('iif', [integer(0n), integer(7n)])),
        builder.projection('likely', builder.builtin('likely', [integer(1n)])),
        builder.projection('unlikely', builder.builtin('unlikely', [nullValue()])),
        builder.projection('glob', builder.builtin('glob', [text('a*'), text('abc')])),
        builder.projection('like', builder.builtin('like', [text('a%'), text('abc')])),
        builder.projection('minimum', builder.builtin('min', [integer(2n), integer(1n)])),
        builder.projection('maximum', builder.builtin('max', [integer(2n), nullValue(), integer(1n)])),
        builder.projection('quoted', builder.builtin('quote', [
          builder.literal(values.blob(Uint8Array.of(0xab))),
        ])),
        builder.projection('storage_type', builder.builtin('typeof', [nullValue()])),
        builder.projection('decoded', builder.builtin('unhex', [text('AB-CD'), text('-')])),
        builder.projection('code_point', builder.builtin('unicode', [text('é')])),
        builder.projection('unicode_text', builder.builtin('unistr', [text('A\\u00e9')])),
        builder.projection('display_literal', builder.builtin('unistr_quote', [text('\u0001')])),
        builder.projection('zeros', builder.builtin('zeroblob', [integer(3n)])),
      ])
      expect((await materializer.queryIr(query)).result.rows).toEqual([[
        values.text('A\u0000'),
        values.text('a1'),
        values.text('a-b'),
        values.text('yes'),
        values.null(),
        values.int64(1n),
        values.null(),
        values.boolean(true),
        values.boolean(true),
        values.int64(1n),
        values.null(),
        values.text("X'AB'"),
        values.text('null'),
        values.blob(Uint8Array.of(0xab, 0xcd)),
        values.int64(233n),
        values.text('Aé'),
        values.text("unistr('\\u0001')"),
        values.blob(Uint8Array.of(0, 0, 0)),
      ]])
    } finally {
      materializer.close()
    }
  })

  it('normalizes deterministic builtin evaluation failures for consensus only', async () => {
    const materializer = await DeterministicMaterializer.open({
      path: path(), schemaManifest: schema, executionManifest,
    })
    try {
      const builder = new IrBuilder()
      const query = builder.query([
        builder.projection('invalid', builder.builtin('unistr', [
          builder.literal(values.text('\\q')),
        ])),
      ])
      await expect(materializer.queryIr(query)).rejects.toMatchObject({
        code: 'SQL_EVALUATION_ERROR',
      })

      let localError: unknown
      try {
        materializer.localSql("SELECT unistr('\\q')")
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
