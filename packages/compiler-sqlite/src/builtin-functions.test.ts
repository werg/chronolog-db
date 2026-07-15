import { IrBuilder, values, type ExecutionManifest, type Expr, type SchemaManifest } from '@chronolog/ir'
import { describe, expect, it } from 'vitest'

import { compileQuery, compileSchema, createCoreExecutionManifest } from './index.js'

const executionManifest = createCoreExecutionManifest({
  profile: 'builtin-functions-test',
  engineDigest: new Uint8Array(32),
})
const schema: SchemaManifest = {
  version: 1, name: 'builtin_functions', objects: [], seedRows: [],
  functionIds: [], collationIds: [], moduleIds: [],
}
const catalog = compileSchema(schema, executionManifest).catalog

describe('compiler-owned SQLite builtin functions', () => {
  it('renders common exact builtins and derives their logical result schemas', () => {
    const builder = new IrBuilder()
    const nullValue = (): Expr => builder.literal(values.null())
    const integer = (value: bigint): Expr => builder.literal(values.int64(value))
    const text = (value: string): Expr => builder.literal(values.text(value))
    const query = builder.query([
      builder.projection('length', builder.builtin('length', [text('Aé')])),
      builder.projection('octets', builder.builtin('octet_length', [text('Aé')])),
      builder.projection('lower', builder.builtin('lower', [text('LOUD')])),
      builder.projection('trim', builder.builtin('trim', [text(' x ')])),
      builder.projection('replace', builder.builtin('replace', [text('aba'), text('a'), text('o')])),
      builder.projection('instr', builder.builtin('instr', [text('banana'), text('na')])),
      builder.projection('substring', builder.builtin('substring', [text('abc'), integer(2n), integer(1n)])),
      builder.projection('hex', builder.builtin('hex', [builder.literal(values.blob(Uint8Array.of(0xab)))])),
      builder.projection('coalesced', builder.builtin('coalesce', [nullValue(), integer(7n)])),
      builder.projection('ifnull', builder.builtin('ifnull', [nullValue(), text('fallback')])),
      builder.projection('nullif', builder.builtin('nullif', [integer(7n), nullValue()])),
      builder.projection('absolute', builder.builtin('abs', [integer(-7n)])),
      builder.projection('sign', builder.builtin('sign', [integer(-7n)])),
    ])
    const compiled = compileQuery(query, catalog)
    expect(compiled.sql).toContain('"length"(?1)')
    expect(compiled.sql).toContain('"coalesce"(?14, ?15)')
    expect(compiled.columns.map((column) => column.valueType)).toEqual([
      { logical: { kind: 'int64' }, nullable: false },
      { logical: { kind: 'int64' }, nullable: false },
      { logical: { kind: 'text', collation: 'binary' }, nullable: false },
      { logical: { kind: 'text', collation: 'binary' }, nullable: false },
      { logical: { kind: 'text', collation: 'binary' }, nullable: false },
      { logical: { kind: 'int64' }, nullable: false },
      { logical: { kind: 'text', collation: 'binary' }, nullable: false },
      { logical: { kind: 'text', collation: 'binary' }, nullable: false },
      { logical: { kind: 'int64' }, nullable: false },
      { logical: { kind: 'text', collation: 'binary' }, nullable: false },
      { logical: { kind: 'int64' }, nullable: true },
      { logical: { kind: 'int64' }, nullable: false },
      { logical: { kind: 'int64' }, nullable: false },
    ])
  })

  it('keeps all-NULL polymorphic results typed as the canonical nullable-BLOB fallback', () => {
    const builder = new IrBuilder()
    const query = builder.query([
      builder.projection('value', builder.builtin('coalesce', [
        builder.literal(values.null()), builder.literal(values.null()),
      ])),
    ])
    expect(compileQuery(query, catalog).columns[0]?.valueType).toEqual({
      logical: { kind: 'blob' }, nullable: true,
    })
  })

  it('types the remaining exact SQLite 3.54 core scalar surface without manifest functions', () => {
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
      builder.projection('likelihood', builder.builtin('likelihood', [
        text('hinted'), builder.literal(values.decimal(125n, 3)),
      ])),
      builder.projection('likely', builder.builtin('likely', [integer(1n)])),
      builder.projection('unlikely', builder.builtin('unlikely', [nullValue()])),
      builder.projection('glob', builder.builtin('glob', [text('a*'), text('abc')])),
      builder.projection('like', builder.builtin('like', [text('a%'), text('abc')])),
      builder.projection('minimum', builder.builtin('min', [integer(2n), integer(1n)])),
      builder.projection('maximum', builder.builtin('max', [integer(2n), nullValue(), integer(1n)])),
      builder.projection('quoted', builder.builtin('quote', [builder.literal(values.blob(Uint8Array.of(0xab)))])),
      builder.projection('storage_type', builder.builtin('typeof', [nullValue()])),
      builder.projection('decoded', builder.builtin('unhex', [text('AB-CD'), text('-')])),
      builder.projection('code_point', builder.builtin('unicode', [text('é')])),
      builder.projection('unicode_text', builder.builtin('unistr', [text('A\\u00e9')])),
      builder.projection('display_literal', builder.builtin('unistr_quote', [text('\u0001')])),
      builder.projection('zeros', builder.builtin('zeroblob', [integer(3n)])),
    ])
    const compiled = compileQuery(query, catalog)
    expect(compiled.sql).toContain('"char"(?1, ?2)')
    expect(compiled.sql).toContain('"iif"(?13, ?14)')
    expect(compiled.sql).toContain('"likelihood"(?15, 0.125)')
    expect(compiled.sql).toContain('"unistr_quote"')
    expect(compiled.sql).toContain('"zeroblob"')
    expect(compiled.columns.map((column) => column.valueType)).toEqual([
      { logical: { kind: 'text', collation: 'binary' }, nullable: false },
      { logical: { kind: 'text', collation: 'binary' }, nullable: false },
      { logical: { kind: 'text', collation: 'binary' }, nullable: false },
      { logical: { kind: 'text', collation: 'binary' }, nullable: false },
      { logical: { kind: 'int64' }, nullable: true },
      { logical: { kind: 'text', collation: 'binary' }, nullable: false },
      { logical: { kind: 'int64' }, nullable: false },
      { logical: { kind: 'blob' }, nullable: true },
      { logical: { kind: 'boolean' }, nullable: false },
      { logical: { kind: 'boolean' }, nullable: false },
      { logical: { kind: 'int64' }, nullable: false },
      { logical: { kind: 'int64' }, nullable: true },
      { logical: { kind: 'text', collation: 'binary' }, nullable: false },
      { logical: { kind: 'text', collation: 'binary' }, nullable: false },
      { logical: { kind: 'blob' }, nullable: true },
      { logical: { kind: 'int64' }, nullable: true },
      { logical: { kind: 'text', collation: 'binary' }, nullable: false },
      { logical: { kind: 'text', collation: 'binary' }, nullable: false },
      { logical: { kind: 'blob' }, nullable: false },
    ])
  })

  it('rejects bad arities, incompatible polymorphic values, and implicit conversions', () => {
    const failures = [
      new IrBuilder().builtin('length', []),
      (() => { const b = new IrBuilder(); return b.builtin('coalesce', [b.literal(values.int64(1n)), b.literal(values.text('x'))]) })(),
      (() => { const b = new IrBuilder(); return b.builtin('lower', [b.literal(values.int64(1n))]) })(),
      (() => { const b = new IrBuilder(); return b.builtin('substr', [b.literal(values.text('x')), b.literal(values.text('1'))]) })(),
      (() => { const b = new IrBuilder(); return b.builtin('concat', [b.literal(values.blob(Uint8Array.of(1)))]) })(),
      (() => { const b = new IrBuilder(); return b.builtin('iif', [b.literal(values.text('yes')), b.literal(values.int64(1n))]) })(),
      (() => { const b = new IrBuilder(); return b.builtin('min', [b.literal(values.int64(1n)), b.literal(values.text('1'))]) })(),
      (() => { const b = new IrBuilder(); return b.builtin('zeroblob', [b.literal(values.text('3'))]) })(),
      (() => { const b = new IrBuilder(); return b.builtin('like', [b.literal(values.text('a%'))]) })(),
    ]
    for (const expression of failures) {
      const builder = new IrBuilder(100)
      const query = builder.query([builder.projection('invalid', expression)])
      expect(() => compileQuery(query, catalog)).toThrow()
    }
  })

  it('cannot re-admit abs through a manifest-registered scalar call', () => {
    const int64 = { logical: { kind: 'int64' as const }, nullable: false }
    const withAbs: ExecutionManifest = {
      ...executionManifest,
      functions: [{
        id: 500, name: 'abs', arguments: [int64], result: int64, effect: 'pure',
        implementationDigest: new Uint8Array(32),
      }],
    }
    const builder = new IrBuilder()
    const query = builder.query([
      builder.projection('absolute', builder.functionCall(500, [builder.literal(values.int64(-1n))])),
    ])
    expect(() => compileQuery(
      query,
      compileSchema({ ...schema, functionIds: [500] }, withAbs).catalog,
    )).toThrowError(expect.objectContaining({ code: 'IR_FUNCTION_UNSUPPORTED_BY_ENGINE' }))
  })
})
