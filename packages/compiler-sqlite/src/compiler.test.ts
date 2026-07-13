import type { ExecutionManifest, Query, SchemaManifest, TransactionProgram } from '@chronolog/ir'
import { describe, expect, it } from 'vitest'

import {
  compileManifestArtifacts,
  compileProgram,
  compileQuery,
  compileSchema,
  CompilerError,
  createCoreExecutionManifest,
} from './index.js'

const manifest: ExecutionManifest = {
  version: 1,
  profile: 'chronolog-core-test-v1',
  engine: 'doltlite-test',
  engineDigest: Uint8Array.from({ length: 32 }, (_, index) => index),
  functions: [], collations: [], modules: [],
  features: { decimal: false, json: false, vector: false, fts: false, spatial: false, wasm: false },
  resources: {
    maxProgramNodes: 1_000, maxExpressionDepth: 32, maxQueryRows: 1_000,
    maxResultBytes: 1_000_000, maxJsonDepth: 32, maxVectorDimensions: 0,
    maxRuleDepth: 0, maxWasmFuel: 0n,
  },
}

const schema: SchemaManifest = {
  version: 1,
  name: 'ledger',
  objects: [{
    kind: 'table', id: 1, name: 'accounts', declarationOrder: 0, withoutRowId: true,
    columns: [
      { id: 2, name: 'id', declarationOrder: 0, valueType: { logical: { kind: 'int64' }, nullable: false } },
      { id: 3, name: 'balance', declarationOrder: 1, valueType: { logical: { kind: 'int64' }, nullable: false }, defaultValue: { kind: 'int64', value: 0n } },
      { id: 4, name: 'owner', declarationOrder: 2, valueType: { logical: { kind: 'text', collation: 'binary' }, nullable: false } },
    ],
    constraints: [
      { kind: 'primary_key', id: 10, name: 'accounts_pk', columnIds: [2] },
      { kind: 'unique', id: 11, name: 'accounts_owner_uq', columnIds: [4] },
    ],
  }],
  seedRows: [{ tableId: 1, values: new Map([
    [2, { kind: 'int64', value: 1n }],
    [3, { kind: 'int64', value: 100n }],
    [4, { kind: 'text', utf8: new TextEncoder().encode('alice') }],
  ]) }],
  functionIds: [], collationIds: [], moduleIds: [],
}

const balanceQuery: Query = {
  id: 20, ctes: [], joins: [], groupBy: [], windows: [], compounds: [], orderBy: [],
  from: { kind: 'table', id: 21, name: 'accounts', alias: 'a' },
  where: { kind: 'binary', id: 22, operator: 'eq', left: { kind: 'column', id: 23, relation: 'a', name: 'id' }, right: { kind: 'literal', id: 24, value: { kind: 'int64', value: 1n } } },
  projection: [{ id: 25, name: 'balance', expression: { kind: 'column', id: 26, relation: 'a', name: 'balance' } }],
  resultMode: { kind: 'scalar' },
}

describe('SQLite IR compiler', () => {
  it('renders a strict schema and ordered seed plan without caller SQL', () => {
    const compiled = compileSchema(schema, manifest)
    expect(compiled.statements[0]?.sql).toBe(
      'CREATE TABLE "accounts" ("id" INTEGER NOT NULL, "balance" INTEGER NOT NULL DEFAULT 0, "owner" TEXT NOT NULL, CONSTRAINT "accounts_pk" PRIMARY KEY ("id"), CONSTRAINT "accounts_owner_uq" UNIQUE ("owner")) STRICT, WITHOUT ROWID',
    )
    expect(compiled.statements[1]).toMatchObject({
      sql: 'INSERT INTO "accounts" ("id", "balance", "owner") VALUES (?1, ?2, ?3)',
    })
  })

  it('renders canonical typed scalar queries and deterministic parameters', () => {
    const catalog = compileSchema(schema, manifest).catalog
    const query = compileQuery(balanceQuery, catalog)
    expect(query.sql).toBe('SELECT "a"."balance" AS "chronolog_p_25" FROM "accounts" AS "a" WHERE ("a"."id" = ?1)')
    expect(query.parameters).toEqual([
      expect.objectContaining({ ordinal: 1, source: { kind: 'literal', value: { kind: 'int64', value: 1n } } }),
    ])
    expect(query.columns).toEqual([{ id: 25, name: 'balance', valueType: { logical: { kind: 'int64' }, nullable: false } }])
  })

  it('does not trust an unproven canonical tie-breaker marker', () => {
    const query: Query = {
      ...balanceQuery,
      resultMode: { kind: 'ordered' },
      orderBy: [{
        id: 27,
        expression: { kind: 'column', id: 28, relation: 'a', name: 'balance' },
        direction: 'asc', nulls: 'first', canonicalRowTieBreaker: true,
      }],
    }
    expect(() => compileQuery(query, compileSchema(schema, manifest).catalog))
      .toThrowError(expect.objectContaining({ code: 'IR_TOTAL_ORDER_NOT_PROVEN' }))
  })

  it('lowers labeled entropy to a resolved BLOB parameter without SQLite randomness', () => {
    const query: Query = {
      id: 120, ctes: [], joins: [], groupBy: [], windows: [], compounds: [], orderBy: [],
      projection: [{
        id: 121,
        name: 'token',
        expression: { kind: 'entropy', id: 122, label: 'record/id', index: 7, length: 32 },
      }],
      resultMode: { kind: 'scalar' },
    }
    const compiled = compileQuery(query, compileSchema(schema, manifest).catalog)
    expect(compiled.sql).toBe('SELECT ?1 AS "chronolog_p_121"')
    expect(compiled.parameters).toEqual([{
      ordinal: 1,
      valueType: { logical: { kind: 'blob', maxBytes: 32 }, nullable: false },
      source: { kind: 'entropy', label: 'record/id', index: 7, length: 32 },
    }])
    expect(compiled.sql).not.toMatch(/random|entropy/iu)
    expect(() => compileQuery({
      ...query,
      projection: [{ ...query.projection[0]!, expression: { kind: 'entropy', id: 122, label: 'record/id', index: 7, length: 8_161 } }],
    }, compileSchema(schema, manifest).catalog)).toThrowError(
      expect.objectContaining({ code: 'IR_ENTROPY_REQUEST_INVALID' }),
    )
  })

  it('compiles core precondition, update, insert, delete and named upsert plans', () => {
    const program: TransactionProgram = {
      preconditions: [{ kind: 'expect', id: 30, query: balanceQuery, expected: {
        kind: 'inline', result: {
          resultMode: { kind: 'scalar' },
          columns: [{ id: 25, name: 'balance', valueType: { logical: { kind: 'int64' }, nullable: false } }],
          rows: [[{ kind: 'int64', value: 100n }]],
        },
      } }],
      mutations: [
        { kind: 'update', id: 40, target: { kind: 'name', name: 'accounts' }, affectedRows: { kind: 'exactly', count: 1n }, assignments: [{ column: 'balance', value: { kind: 'literal', id: 41, value: { kind: 'int64', value: 90n } } }], where: { kind: 'binary', id: 42, operator: 'eq', left: { kind: 'column', id: 43, name: 'id' }, right: { kind: 'literal', id: 44, value: { kind: 'int64', value: 1n } } } },
        { kind: 'insert', id: 50, target: { kind: 'id', objectId: 1 }, affectedRows: { kind: 'exactly', count: 1n }, columns: ['id', 'balance', 'owner'], rows: [[{ kind: 'literal', id: 51, value: { kind: 'int64', value: 2n } }, { kind: 'literal', id: 52, value: { kind: 'int64', value: 5n } }, { kind: 'literal', id: 53, value: { kind: 'text', utf8: new TextEncoder().encode('bob') } }]], conflict: 'error' },
        { kind: 'delete', id: 60, target: { kind: 'name', name: 'accounts' }, affectedRows: { kind: 'at_most', count: 1n }, where: { kind: 'binary', id: 61, operator: 'eq', left: { kind: 'column', id: 62, name: 'id' }, right: { kind: 'literal', id: 63, value: { kind: 'int64', value: 99n } } } },
        { kind: 'upsert', id: 70, target: { kind: 'name', name: 'accounts' }, affectedRows: { kind: 'exactly', count: 1n }, columns: ['id', 'balance', 'owner'], row: [{ kind: 'literal', id: 71, value: { kind: 'int64', value: 3n } }, { kind: 'literal', id: 72, value: { kind: 'int64', value: 7n } }, { kind: 'literal', id: 73, value: { kind: 'text', utf8: new TextEncoder().encode('alice') } }], constraint: 'accounts_owner_uq', updates: [{ column: 'balance', value: { kind: 'old_new', id: 74, scope: 'new', column: 'balance' } }] },
      ],
    }
    const compiled = compileProgram(program, compileSchema(schema, manifest).catalog)
    expect(compiled.mutations.map((mutation) => mutation.sql)).toEqual([
      'UPDATE "accounts" AS "accounts" SET "balance" = ?1 WHERE ("accounts"."id" = ?2)',
      'INSERT INTO "accounts" ("id", "balance", "owner") VALUES (?1, ?2, ?3)',
      'DELETE FROM "accounts" AS "accounts" WHERE ("accounts"."id" = ?1)',
      'INSERT INTO "accounts" AS "accounts" ("id", "balance", "owner") VALUES (?1, ?2, ?3) ON CONFLICT ("owner") DO UPDATE SET "balance" = "excluded"."balance"',
    ])
  })

  it('fails unsupported schema and mutation nodes before SQLite preparation', () => {
    expect(() => compileSchema({ ...schema, objects: [...schema.objects, { kind: 'view', id: 90, name: 'ambient', declarationOrder: 1, query: balanceQuery }] }, manifest))
      .toThrowError(CompilerError)
    const catalog = compileSchema(schema, manifest).catalog
    expect(() => compileProgram({ preconditions: [{ kind: 'assert', id: 91, query: { ...balanceQuery, projection: [{ id: 92, name: 'ok', expression: { kind: 'literal', id: 93, value: { kind: 'boolean', value: true } } }] }, unknownIsFailure: true }], mutations: [{ kind: 'insert', id: 94, target: { kind: 'name', name: 'accounts' }, affectedRows: { kind: 'unconstrained' }, columns: ['id'], rows: [[{ kind: 'literal', id: 95, value: { kind: 'int64', value: 2n } }]], conflict: 'replace' }] }, catalog))
      .toThrowError(CompilerError)
  })

  it('commits canonical schema and execution manifest bytes to 32-byte digests', async () => {
    const artifacts = await compileManifestArtifacts(schema, manifest)
    expect(artifacts.schemaDigest).toHaveLength(32)
    expect(artifacts.executionManifestDigest).toHaveLength(32)
    expect(artifacts.canonicalSchema.length).toBeGreaterThan(0)
    expect(artifacts.canonicalExecutionManifest.length).toBeGreaterThan(0)
  })

  it('lowers only the explicit protected transaction-log system relation', () => {
    const query: Query = {
      id: 100, ctes: [], joins: [], groupBy: [], windows: [], compounds: [], orderBy: [],
      from: { kind: 'system_relation', id: 101, relation: 'transaction_log', alias: 'log' },
      where: { kind: 'binary', id: 102, operator: 'eq', left: { kind: 'column', id: 103, relation: 'log', name: 'tx_id' }, right: { kind: 'literal', id: 104, value: { kind: 'blob', bytes: Uint8Array.of(1) } } },
      projection: [{ id: 105, name: 'outcome', expression: { kind: 'column', id: 106, relation: 'log', name: 'outcome' } }],
      resultMode: { kind: 'multiset' },
    }
    expect(compileQuery(query, compileSchema(schema, manifest).catalog).sql).toBe(
      'SELECT "log"."outcome" AS "chronolog_p_105" FROM "chronolog_transactions" AS "log" WHERE ("log"."tx_id" = ?1)',
    )
    expect(() => compileQuery({ ...query, from: { kind: 'table', id: 101, name: 'chronolog_transactions', alias: 'log' } }, compileSchema(schema, manifest).catalog))
      .toThrowError(CompilerError)
  })

  it('renders the enabled exact decimal, JSON and ordinary-vector storage subset', () => {
    const safe = createCoreExecutionManifest({ profile: 'safe-values', engineDigest: new Uint8Array(32) })
    const typed: SchemaManifest = {
      version: 1, name: 'typed', functionIds: [], collationIds: [], moduleIds: [], seedRows: [],
      objects: [{
        kind: 'table', id: 200, name: 'values_table', declarationOrder: 0, withoutRowId: true,
        columns: [
          { id: 201, name: 'id', declarationOrder: 0, valueType: { logical: { kind: 'int64' }, nullable: false } },
          { id: 202, name: 'amount', declarationOrder: 1, valueType: { logical: { kind: 'decimal', precision: 9, scale: 2 }, nullable: false } },
          { id: 203, name: 'payload', declarationOrder: 2, valueType: { logical: { kind: 'json' }, nullable: false } },
          { id: 204, name: 'vector_value', declarationOrder: 3, valueType: { logical: { kind: 'vector', element: 'i8', dimensions: 3 }, nullable: false } },
        ],
        constraints: [{ kind: 'primary_key', id: 205, name: 'values_pk', columnIds: [201] }],
      }],
    }
    expect(compileSchema(typed, safe).statements[0]?.sql).toContain(
      '"amount" TEXT NOT NULL CHECK (typeof("amount") = \'text\'), "payload" TEXT NOT NULL CHECK (typeof("payload") = \'text\'), "vector_value" BLOB NOT NULL CHECK (length("vector_value") = 3)',
    )
    expect(() => compileSchema(typed, { ...safe, features: { ...safe.features, json: false } }))
      .toThrowError(expect.objectContaining({ code: 'JSON_FEATURE_DISABLED' }))
    expect(() => compileSchema(typed, { ...safe, features: { ...safe.features, fts: true } }))
      .toThrowError(expect.objectContaining({ code: 'EXECUTION_FEATURE_UNSUPPORTED' }))
  })
})
