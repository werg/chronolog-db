import { bytesToHex, decodeCanonicalCbor, encodeCanonicalCbor } from '@chronolog/canonical'
import { describe, expect, it } from 'vitest'

import {
  IR_DECODE_LIMITS, IrBuilder, SchemaBuilder, canonicalJsonFromText, canonicalJsonToText,
  collectContextDependencies, decodeExecutionManifest, decodeLogicalValue, decodeQuery,
  decodeSchemaManifest, decodeTransactionProgram, digestExecutionManifest, digestSchemaManifest,
  encodeExecutionManifest, encodeLogicalValue, encodeQuery, encodeSchemaManifest,
  encodeTransactionProgram, logicalTypes, portableExecutionManifestFixture,
  portableSchemaManifestFixture, portableTransactionProgramFixture, queryFromCanonicalCbor,
  queryToCanonicalCbor, transactionLogQueryFixture, validateQuery, validateTransactionProgram, values,
  type Query, type TransactionProgram,
} from './index.js'

describe('logical values and canonical JSON', () => {
  it('has stable logical-value boundary golden bytes', () => {
    expect(bytesToHex(encodeLogicalValue({ kind: 'int64', value: (1n << 63n) - 1n }))).toBe('82021b7fffffffffffffff')
    expect(decodeLogicalValue(encodeLogicalValue({ kind: 'int64', value: -(1n << 63n) }))).toEqual({ kind: 'int64', value: -(1n << 63n) })
    expect(() => encodeLogicalValue({ kind: 'timestamp_ms', value: -1n })).toThrow()
  })

  it('copies caller-owned byte arrays in public constructors', () => {
    const source = Uint8Array.of(1, 2, 3)
    const value = values.blob(source)
    source[0] = 9
    expect(value).toEqual({ kind: 'blob', bytes: Uint8Array.of(1, 2, 3) })
    expect(Object.isFrozen(value)).toBe(true)
  })

  it('parses and emits exact JSON with UTF-8 key ordering', () => {
    const parsed = canonicalJsonFromText('{"z":9007199254740993,"a":1.2300,"music":"𝄞"}')
    expect(canonicalJsonToText(parsed)).toBe('{"a":1.23,"music":"𝄞","z":9007199254740993}')
    expect(() => canonicalJsonFromText('{"a":1,"a":2}')).toThrow(/duplicate/i)
    expect(() => canonicalJsonFromText('{"a":1e-100}')).toThrow(/scale/i)
    expect(() => canonicalJsonFromText('"\\ud800"')).toThrow()
  })
})

describe('IR codecs and validation', () => {
  it('round-trips a deterministic program including metadata', () => {
    const fixture = portableTransactionProgramFixture()
    const first = encodeTransactionProgram(fixture)
    const second = encodeTransactionProgram(fixture)
    expect(first).toEqual(second)
    expect(decodeTransactionProgram(first)).toEqual(fixture)
  })

  it('rejects malformed tagged AST fields', () => {
    const encoded = queryToCanonicalCbor(transactionLogQueryFixture()) as readonly unknown[]
    const fields = new Map(encoded[1] as ReadonlyMap<bigint, never>)
    fields.set(99n, null as never)
    const malformed = encodeCanonicalCbor([encoded[0] as bigint, fields])
    expect(() => queryFromCanonicalCbor(decodeCanonicalCbor(malformed, IR_DECODE_LIMITS))).toThrow(/unknown field/i)
  })

  it('requires both preconditions and mutations and rejects draft parameters when signing', () => {
    const valid = portableTransactionProgramFixture()
    expect(validateTransactionProgram({ ...valid, preconditions: [] }).diagnostics.map((item) => item.code)).toContain('PRECONDITION_REQUIRED')
    expect(validateTransactionProgram({ ...valid, mutations: [] }).diagnostics.map((item) => item.code)).toContain('MUTATION_REQUIRED')
    const parameterized = structuredClone(valid) as TransactionProgram
    const query = parameterized.preconditions[0]!.query
    ;(query.projection[0]! as { expression: unknown }).expression = { kind: 'parameter', id: 4, name: 'answer', valueType: { logical: { kind: 'int64' }, nullable: false } }
    expect(validateTransactionProgram(parameterized).diagnostics.map((item) => item.code)).toContain('DRAFT_PARAMETER_UNSUBSTITUTED')
  })

  it('round-trips client parameters without confusing logical types and values', () => {
    const query: Query = {
      id: 1, ctes: [], joins: [], groupBy: [], windows: [], compounds: [], orderBy: [],
      projection: [{ id: 2, name: 'value', expression: { kind: 'parameter', id: 3, name: 'input', valueType: { logical: { kind: 'int64' }, nullable: false } } }],
      resultMode: { kind: 'scalar' },
    }
    expect(decodeQuery(encodeQuery(query))).toEqual(query)
  })

  it('supports only the explicit read-only transaction-log relation', () => {
    const query = transactionLogQueryFixture()
    expect(validateQuery(query).ok).toBe(true)
    expect(decodeQuery(encodeQuery(query))).toEqual(query)
    const genericReserved = { ...query, from: { kind: 'table' as const, id: 21, name: 'chronolog_transactions' } }
    const program = portableTransactionProgramFixture()
    expect(validateTransactionProgram({ ...program, preconditions: [{ kind: 'assert', id: 1, query: genericReserved, unknownIsFailure: true }] }).diagnostics.map((item) => item.code)).toContain('RESERVED_OBJECT_ACCESS')
  })

  it('detects duplicate IDs across auxiliary query nodes', () => {
    const program = portableTransactionProgramFixture()
    const query = program.preconditions[0]!.query
    const duplicate = { ...query, projection: [{ ...query.projection[0]!, id: query.id }] }
    expect(validateTransactionProgram({ ...program, preconditions: [{ kind: 'assert', id: 1, query: duplicate, unknownIsFailure: true }] }).diagnostics.map((item) => item.code)).toContain('DUPLICATE_NODE_ID')
  })

  it('collects explicit context and labeled entropy dependencies', () => {
    const builder = new IrBuilder(100)
    const expression = builder.binary('eq', builder.context('author_timestamp_ms'), { kind: 'entropy', id: builder.id(), label: 'nonce/sample', index: 0, length: 8 })
    expect(collectContextDependencies(expression)).toEqual(['author_timestamp_ms', 'transaction_nonce'])
  })

  it('round-trips schema seed numeric maps and manifest codecs', () => {
    const schema = portableSchemaManifestFixture()
    const decodedSchema = decodeSchemaManifest(encodeSchemaManifest(schema))
    expect(decodedSchema).toEqual(schema)
    expect([...decodedSchema.seedRows[0]!.values.keys()]).toEqual([2, 3])
    const manifest = portableExecutionManifestFixture()
    expect(decodeExecutionManifest(encodeExecutionManifest(manifest))).toEqual(manifest)
  })

  it('changes digests when semantic manifest or schema content changes', async () => {
    const schema = portableSchemaManifestFixture()
    const changedSchema = { ...schema, name: 'fixture_changed' }
    expect(await digestSchemaManifest(schema)).not.toEqual(await digestSchemaManifest(changedSchema))
    const manifest = portableExecutionManifestFixture()
    expect(await digestExecutionManifest(manifest)).not.toEqual(await digestExecutionManifest({ ...manifest, profile: 'changed' }))
  })

  it('builds an immutable schema with deterministic IDs', () => {
    const builder = new SchemaBuilder(10)
    const id = builder.column('id', builder.type(logicalTypes.int64()))
    const pk = builder.primaryKey('things_pk', [id])
    const table = builder.table('things', [id], [pk])
    const schema = builder.schema('app', [table], [builder.seed(table, new Map([[id, values.int64(1n)]]))])
    expect([id.id, pk.id, table.id]).toEqual([10, 11, 12])
    expect(Object.isFrozen(schema)).toBe(true)
  })
})
