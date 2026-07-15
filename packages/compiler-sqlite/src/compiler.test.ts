import type { ExecutionManifest, Query, SchemaManifest, TransactionProgram } from '@chronolog/ir'
import { describe, expect, it } from 'vitest'

import {
  compileManifestArtifacts,
  compileMutation,
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

  it('derives stable ordering from the projected logical row', () => {
    const query: Query = {
      ...balanceQuery,
      resultMode: { kind: 'ordered' },
      orderBy: [{
        id: 27,
        expression: { kind: 'column', id: 28, relation: 'a', name: 'balance' },
        direction: 'asc', nulls: 'first',
      }],
    }
    expect(compileQuery(query, compileSchema(schema, manifest).catalog).sql).toContain(
      'ORDER BY "a"."balance" ASC NULLS FIRST',
    )
    expect(compileQuery({ ...balanceQuery, resultMode: { kind: 'ordered' } },
      compileSchema(schema, manifest).catalog).sql).toContain('ORDER BY 1 ASC NULLS FIRST')
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

  it('fails unsupported schema and returning nodes before SQLite preparation', () => {
    expect(() => compileSchema({ ...schema, objects: [...schema.objects, { kind: 'view', id: 90, name: 'ambient', declarationOrder: 1, query: balanceQuery }] }, manifest))
      .toThrowError(CompilerError)
    const catalog = compileSchema(schema, manifest).catalog
    expect(() => compileMutation({ kind: 'insert', id: 94, target: { kind: 'name', name: 'accounts' }, affectedRows: { kind: 'unconstrained' }, columns: ['id'], rows: [[{ kind: 'literal', id: 95, value: { kind: 'int64', value: 2n } }]], conflict: 'replace', returning: balanceQuery }, catalog))
      .toThrowError(expect.objectContaining({ code: 'IR_RETURNING_UNSUPPORTED' }))
  })

  it('lowers SQLite conflict policies, aliases, INSERT SELECT, and named UPSERT actions', () => {
    const catalog = compileSchema(schema, manifest).catalog
    const orderedSource: Query = {
      id: 200,
      ctes: [], joins: [], groupBy: [], windows: [], compounds: [],
      from: { kind: 'table', id: 201, name: 'accounts', alias: 'source' },
      projection: [
        { id: 202, name: 'id', expression: { kind: 'column', id: 203, relation: 'source', name: 'id' } },
        { id: 204, name: 'balance', expression: { kind: 'column', id: 205, relation: 'source', name: 'balance' } },
        { id: 206, name: 'owner', expression: { kind: 'column', id: 207, relation: 'source', name: 'owner' } },
      ],
      orderBy: [{
        id: 208,
        expression: { kind: 'column', id: 209, relation: 'source', name: 'id' },
        direction: 'asc', nulls: 'first', canonicalRowTieBreaker: true,
      }],
      resultMode: { kind: 'ordered' },
    }
    const insertSelect = compileMutation({
      kind: 'insert', id: 210, target: { kind: 'name', name: 'accounts' }, alias: 'destination',
      affectedRows: { kind: 'unconstrained' }, columns: ['id', 'balance', 'owner'], rows: [],
      source: orderedSource, conflict: 'ignore',
    }, catalog)
    expect(insertSelect.sql).toBe(
      'INSERT OR IGNORE INTO "accounts" AS "destination" ("id", "balance", "owner") SELECT "source"."id" AS "chronolog_p_202", "source"."balance" AS "chronolog_p_204", "source"."owner" AS "chronolog_p_206" FROM "accounts" AS "source" ORDER BY "source"."id" ASC NULLS FIRST, 2 ASC NULLS FIRST, 3 ASC NULLS FIRST',
    )

    expect(compileMutation({
      kind: 'insert', id: 211, target: { kind: 'name', name: 'accounts' },
      affectedRows: { kind: 'exactly', count: 1n }, columns: ['id', 'balance', 'owner'],
      rows: [[
        { kind: 'literal', id: 212, value: { kind: 'int64', value: 1n } },
        { kind: 'literal', id: 213, value: { kind: 'int64', value: 5n } },
        { kind: 'literal', id: 214, value: { kind: 'text', utf8: new TextEncoder().encode('replacement') } },
      ]], conflict: 'replace',
    }, catalog).sql).toBe(
      'INSERT OR REPLACE INTO "accounts" ("id", "balance", "owner") VALUES (?1, ?2, ?3)',
    )

    expect(compileMutation({
      kind: 'upsert', id: 220, target: { kind: 'name', name: 'accounts' }, alias: 'target',
      affectedRows: { kind: 'at_most', count: 1n }, columns: ['id', 'balance', 'owner'],
      row: [
        { kind: 'literal', id: 221, value: { kind: 'int64', value: 3n } },
        { kind: 'literal', id: 222, value: { kind: 'int64', value: 7n } },
        { kind: 'literal', id: 223, value: { kind: 'text', utf8: new TextEncoder().encode('alice') } },
      ], constraint: 'accounts_owner_uq', updates: [],
    }, catalog).sql).toContain('ON CONFLICT ("owner") DO NOTHING')

    expect(compileMutation({
      kind: 'upsert', id: 230, target: { kind: 'name', name: 'accounts' }, alias: 'target',
      affectedRows: { kind: 'at_most', count: 1n }, columns: ['id', 'balance', 'owner'],
      row: [
        { kind: 'literal', id: 231, value: { kind: 'int64', value: 3n } },
        { kind: 'literal', id: 232, value: { kind: 'int64', value: 7n } },
        { kind: 'literal', id: 233, value: { kind: 'text', utf8: new TextEncoder().encode('alice') } },
      ], constraint: 'accounts_owner_uq',
      updates: [{
        column: 'balance',
        value: {
          kind: 'conditional', id: 234,
          branches: [{
            when: {
              kind: 'binary', id: 238, operator: 'gt',
              left: { kind: 'old_new', id: 239, scope: 'new', column: 'balance' },
              right: { kind: 'old_new', id: 240, scope: 'old', column: 'balance' },
            },
            then: { kind: 'old_new', id: 241, scope: 'new', column: 'balance' },
          }],
          otherwise: { kind: 'old_new', id: 242, scope: 'old', column: 'balance' },
        },
      }],
      where: {
        kind: 'binary', id: 235, operator: 'gt',
        left: { kind: 'old_new', id: 236, scope: 'new', column: 'balance' },
        right: { kind: 'old_new', id: 237, scope: 'old', column: 'balance' },
      },
    }, catalog).sql).toBe(
      'INSERT INTO "accounts" AS "target" ("id", "balance", "owner") VALUES (?1, ?2, ?3) ON CONFLICT ("owner") DO UPDATE SET "balance" = (CASE WHEN ("excluded"."balance" > "target"."balance") THEN "excluded"."balance" ELSE "target"."balance" END) WHERE ("excluded"."balance" > "target"."balance")',
    )

    expect(compileMutation({
      kind: 'update', id: 238, target: { kind: 'name', name: 'accounts' }, alias: 'account target',
      assignments: [{ column: 'balance', value: { kind: 'literal', id: 239, value: { kind: 'int64', value: 8n } } }],
      where: {
        kind: 'binary', id: 241, operator: 'eq',
        left: { kind: 'column', id: 242, relation: 'account target', name: 'id' },
        right: { kind: 'literal', id: 243, value: { kind: 'int64', value: 1n } },
      },
      affectedRows: { kind: 'at_most', count: 1n },
    }, catalog).sql).toBe(
      'UPDATE "accounts" AS "account target" SET "balance" = ?1 WHERE ("account target"."id" = ?2)',
    )

    expect(compileMutation({
      kind: 'delete', id: 244, target: { kind: 'name', name: 'accounts' }, alias: 'account target',
      where: {
        kind: 'binary', id: 245, operator: 'eq',
        left: { kind: 'column', id: 246, relation: 'account target', name: 'id' },
        right: { kind: 'literal', id: 247, value: { kind: 'int64', value: 99n } },
      },
      affectedRows: { kind: 'at_most', count: 1n },
    }, catalog).sql).toBe(
      'DELETE FROM "accounts" AS "account target" WHERE ("account target"."id" = ?1)',
    )

    expect(compileMutation({
      kind: 'insert', id: 240, target: { kind: 'name', name: 'accounts' },
      affectedRows: { kind: 'unconstrained' }, columns: ['id', 'balance', 'owner'], rows: [],
      source: { ...orderedSource, resultMode: { kind: 'multiset' }, orderBy: [] }, conflict: 'error',
    }, catalog).sql).toContain('ORDER BY 1 ASC NULLS FIRST, 2 ASC NULLS FIRST, 3 ASC NULLS FIRST')
  })

  it('lowers DEFAULT VALUES, deterministic UPSERT SELECT, singleton UPDATE conflicts, and scalar UPDATE FROM', () => {
    const catalog = compileSchema(schema, manifest).catalog
    expect(compileMutation({
      kind: 'insert', id: 400, target: { kind: 'name', name: 'accounts' }, alias: 'target',
      affectedRows: { kind: 'exactly', count: 1n }, columns: [], rows: [[]], conflict: 'ignore',
    }, catalog).sql).toBe('INSERT OR IGNORE INTO "accounts" AS "target" DEFAULT VALUES')

    const source: Query = {
      id: 410, ctes: [], joins: [], groupBy: [], windows: [], compounds: [], orderBy: [],
      from: { kind: 'table', id: 411, name: 'accounts', alias: 'source' },
      where: {
        kind: 'binary', id: 412, operator: 'eq',
        left: { kind: 'column', id: 413, relation: 'source', name: 'id' },
        right: { kind: 'literal', id: 414, value: { kind: 'int64', value: 1n } },
      },
      projection: [
        { id: 415, name: 'id', expression: { kind: 'column', id: 416, relation: 'source', name: 'id' } },
        { id: 417, name: 'balance', expression: { kind: 'column', id: 418, relation: 'source', name: 'balance' } },
        { id: 419, name: 'owner', expression: { kind: 'column', id: 420, relation: 'source', name: 'owner' } },
      ],
      resultMode: { kind: 'multiset' },
    }
    const upsert = compileMutation({
      kind: 'upsert', id: 421, target: { kind: 'name', name: 'accounts' }, alias: 'target',
      affectedRows: { kind: 'at_most', count: 1n }, columns: ['id', 'balance', 'owner'], row: [], source,
      constraint: 'accounts_pk', updates: [{
        column: 'balance', value: { kind: 'old_new', id: 422, scope: 'new', column: 'balance' },
      }],
    }, catalog)
    expect(upsert.sql).toContain('WHERE 1 ORDER BY 1 ASC NULLS FIRST, 2 ASC NULLS FIRST, 3 ASC NULLS FIRST ON CONFLICT ("id") DO UPDATE')

    const uniqueTarget = {
      kind: 'binary' as const, id: 430, operator: 'eq' as const,
      left: { kind: 'column' as const, id: 431, relation: 'target', name: 'id' },
      right: { kind: 'literal' as const, id: 432, value: { kind: 'int64' as const, value: 1n } },
    }
    expect(compileMutation({
      kind: 'update', id: 433, target: { kind: 'name', name: 'accounts' }, alias: 'target', conflict: 'ignore',
      affectedRows: { kind: 'at_most', count: 1n },
      assignments: [{ column: 'owner', value: { kind: 'literal', id: 434, value: { kind: 'text', utf8: new TextEncoder().encode('kept') } } }],
      where: uniqueTarget,
    }, catalog).sql).toContain('UPDATE OR IGNORE "accounts" AS "target"')
    expect(() => compileMutation({
      kind: 'update', id: 435, target: { kind: 'name', name: 'accounts' }, conflict: 'replace',
      affectedRows: { kind: 'unconstrained' },
      assignments: [{ column: 'balance', value: { kind: 'literal', id: 436, value: { kind: 'int64', value: 0n } } }],
    }, catalog)).toThrowError(expect.objectContaining({ code: 'IR_UPDATE_CONFLICT_ORDER_NOT_PROVEN' }))

    const updateFrom = compileMutation({
      kind: 'update', id: 440, target: { kind: 'name', name: 'accounts' }, alias: 'target',
      affectedRows: { kind: 'at_most', count: 1n }, from: source, fromAlias: 'snapshot',
      assignments: [{ column: 'balance', value: { kind: 'column', id: 441, relation: 'snapshot', name: 'balance' } }],
      where: uniqueTarget,
    }, catalog)
    expect(updateFrom.sql).toContain('"chronolog_update_source_440"."chronolog_p_417" AS "balance"')
    expect(updateFrom.sql).toContain('AS "snapshot" WHERE ("target"."id" = ?2)')
    const { where: _uniqueSourcePredicate, ...unboundedSource } = source
    expect(() => compileMutation({
      kind: 'update', id: 442, target: { kind: 'name', name: 'accounts' },
      affectedRows: { kind: 'unconstrained' }, from: unboundedSource, fromAlias: 'snapshot',
      assignments: [{ column: 'balance', value: { kind: 'column', id: 443, relation: 'snapshot', name: 'balance' } }],
    }, catalog)).toThrowError(expect.objectContaining({ code: 'IR_UPDATE_FROM_CARDINALITY_NOT_PROVEN' }))
  })

  it('renders ordered schema-ID UPSERT clauses for multi-row and SELECT inserts', () => {
    const indexedSchema: SchemaManifest = {
      ...schema,
      objects: [...schema.objects, {
        kind: 'index', id: 12, name: 'accounts_positive_balance_uq', declarationOrder: 1,
        tableId: 1, unique: true,
        expressions: [{ kind: 'column', id: 500, name: 'balance' }],
        where: {
          kind: 'binary', id: 501, operator: 'gt',
          left: { kind: 'column', id: 502, name: 'balance' },
          right: { kind: 'literal', id: 503, value: { kind: 'int64', value: 0n } },
        },
      }],
    }
    const catalog = compileSchema(indexedSchema, manifest).catalog
    const modern = compileMutation({
      kind: 'insert', id: 510, target: { kind: 'name', name: 'accounts' }, alias: 'target',
      columns: ['id', 'balance', 'owner'], conflict: 'ignore',
      rows: [
        [
          { kind: 'literal', id: 511, value: { kind: 'int64', value: 1n } },
          { kind: 'literal', id: 512, value: { kind: 'int64', value: 110n } },
          { kind: 'literal', id: 513, value: { kind: 'text', utf8: new TextEncoder().encode('alice') } },
        ],
        [
          { kind: 'literal', id: 514, value: { kind: 'int64', value: 2n } },
          { kind: 'literal', id: 515, value: { kind: 'int64', value: 200n } },
          { kind: 'literal', id: 516, value: { kind: 'text', utf8: new TextEncoder().encode('bob') } },
        ],
      ],
      upsertClauses: [
        {
          id: 517, target: { constraintId: 10 }, action: 'update',
          assignments: [{
            column: 'balance', value: { kind: 'old_new', id: 518, scope: 'new', column: 'balance' },
          }],
          where: {
            kind: 'binary', id: 519, operator: 'gt',
            left: { kind: 'old_new', id: 520, scope: 'new', column: 'balance' },
            right: { kind: 'old_new', id: 521, scope: 'old', column: 'balance' },
          },
        },
        { id: 522, target: { indexId: 12 }, action: 'nothing', assignments: [] },
        { id: 523, action: 'nothing', assignments: [] },
      ],
      affectedRows: { kind: 'unconstrained' },
    }, catalog)
    expect(modern.sql).toContain('INSERT OR IGNORE INTO "accounts" AS "target"')
    expect(modern.sql).toContain('VALUES (?1, ?2, ?3), (?4, ?5, ?6)')
    expect(modern.sql).toContain(
      'ON CONFLICT ("id") DO UPDATE SET "balance" = "excluded"."balance" WHERE ("excluded"."balance" > "target"."balance")',
    )
    expect(modern.sql).toContain(
      'ON CONFLICT ("balance") WHERE ("balance" > 0) DO NOTHING ON CONFLICT DO NOTHING',
    )

    const source: Query = {
      id: 530, ctes: [], joins: [], groupBy: [], windows: [], compounds: [], orderBy: [],
      from: { kind: 'table', id: 531, name: 'accounts', alias: 'source' },
      projection: [
        { id: 532, name: 'id', expression: { kind: 'column', id: 533, relation: 'source', name: 'id' } },
        { id: 534, name: 'balance', expression: { kind: 'column', id: 535, relation: 'source', name: 'balance' } },
        { id: 536, name: 'owner', expression: { kind: 'column', id: 537, relation: 'source', name: 'owner' } },
      ],
      resultMode: { kind: 'multiset' },
    }
    const insertSelect = compileMutation({
      kind: 'insert', id: 540, target: { kind: 'name', name: 'accounts' }, alias: 'target',
      columns: ['id', 'balance', 'owner'], rows: [], source, conflict: 'error',
      upsertClauses: [{
        id: 541, target: { constraintId: 10 }, action: 'update',
        assignments: [{
          column: 'balance', value: { kind: 'old_new', id: 542, scope: 'new', column: 'balance' },
        }],
      }],
      affectedRows: { kind: 'unconstrained' },
    }, catalog)
    expect(insertSelect.sql).toContain(
      'WHERE 1 ORDER BY 1 ASC NULLS FIRST, 2 ASC NULLS FIRST, 3 ASC NULLS FIRST',
    )
    expect(insertSelect.sql).toContain(
      'ON CONFLICT ("id") DO UPDATE SET "balance" = "excluded"."balance"',
    )

    const legacy = compileMutation({
      kind: 'upsert', id: 540, target: { kind: 'name', name: 'accounts' }, alias: 'target',
      columns: ['id', 'balance', 'owner'], row: [], source, constraint: 'accounts_pk',
      updates: [{
        column: 'balance', value: { kind: 'old_new', id: 543, scope: 'new', column: 'balance' },
      }],
      affectedRows: { kind: 'unconstrained' },
    }, catalog)
    expect(legacy.sql).toBe(insertSelect.sql)

    expect(() => compileMutation({
      kind: 'insert', id: 550, target: { kind: 'name', name: 'accounts' },
      columns: ['id', 'balance', 'owner'], conflict: 'error',
      rows: [[
        { kind: 'literal', id: 551, value: { kind: 'int64', value: 3n } },
        { kind: 'literal', id: 552, value: { kind: 'int64', value: 300n } },
        { kind: 'literal', id: 553, value: { kind: 'text', utf8: new TextEncoder().encode('carol') } },
      ]],
      upsertClauses: [
        { id: 554, action: 'nothing', assignments: [] },
        { id: 555, target: { constraintId: 10 }, action: 'nothing', assignments: [] },
      ],
      affectedRows: { kind: 'unconstrained' },
    }, catalog)).toThrowError(expect.objectContaining({ code: 'IR_UPSERT_TARGET_REQUIRED' }))

    expect(() => compileMutation({
      kind: 'insert', id: 551, target: { kind: 'name', name: 'accounts' },
      columns: ['id'], conflict: 'error',
      rows: [[{ kind: 'literal', id: 552, value: { kind: 'int64', value: 3n } }]],
      upsertClauses: [{
        id: 553,
        target: { constraintId: 10, indexId: 12 },
        action: 'nothing', assignments: [],
      }],
      affectedRows: { kind: 'unconstrained' },
    }, catalog)).toThrowError(expect.objectContaining({ code: 'IR_UPSERT_CONFLICT_TARGET_INVALID' }))

    expect(compileMutation({
      kind: 'insert', id: 556, target: { kind: 'name', name: 'accounts' }, alias: 'excluded',
      columns: ['id'], conflict: 'error',
      rows: [[{ kind: 'literal', id: 557, value: { kind: 'int64', value: 3n } }]],
      upsertClauses: [{ id: 558, target: { constraintId: 10 }, action: 'nothing', assignments: [] }],
      affectedRows: { kind: 'unconstrained' },
    }, catalog).sql).toContain('AS "excluded" ("id") VALUES (?1) ON CONFLICT ("id") DO NOTHING')

    expect(() => compileMutation({
      kind: 'insert', id: 559, target: { kind: 'name', name: 'accounts' }, alias: 'excluded',
      columns: ['id', 'balance'], conflict: 'error',
      rows: [[
        { kind: 'literal', id: 560, value: { kind: 'int64', value: 3n } },
        { kind: 'literal', id: 561, value: { kind: 'int64', value: 30n } },
      ]],
      upsertClauses: [{
        id: 562, target: { constraintId: 10 }, action: 'update',
        assignments: [{ column: 'balance', value: { kind: 'old_new', id: 563, scope: 'new', column: 'balance' } }],
      }],
      affectedRows: { kind: 'unconstrained' },
    }, catalog)).toThrowError(expect.objectContaining({ code: 'IR_UPSERT_ALIAS_RESERVED' }))

    const excludedTable = {
      ...schema.objects[0]!, name: 'excluded',
    }
    const excludedCatalog = compileSchema({ ...schema, objects: [excludedTable] }, manifest).catalog
    const excludedTarget = compileMutation({
      kind: 'insert', id: 564, target: { kind: 'name', name: 'excluded' },
      columns: ['id', 'balance'], conflict: 'error',
      rows: [[
        { kind: 'literal', id: 565, value: { kind: 'int64', value: 3n } },
        { kind: 'literal', id: 566, value: { kind: 'int64', value: 30n } },
      ]],
      upsertClauses: [{
        id: 567, target: { constraintId: 10 }, action: 'update',
        assignments: [{ column: 'balance', value: { kind: 'old_new', id: 568, scope: 'new', column: 'balance' } }],
      }],
      affectedRows: { kind: 'unconstrained' },
    }, excludedCatalog)
    expect(excludedTarget.sql).toContain(
      'INSERT INTO "excluded" AS "chronolog_upsert_target_564"',
    )
    expect(excludedTarget.sql).toContain('SET "balance" = "excluded"."balance"')
  })

  it('shares typed CTE scopes across INSERT, UPDATE, and DELETE mutations', () => {
    const catalog = compileSchema(schema, manifest).catalog
    const incomingQuery: Query = {
      id: 600, ctes: [], joins: [], groupBy: [], windows: [], compounds: [], orderBy: [],
      projection: [
        { id: 601, name: 'id', expression: { kind: 'literal', id: 602, value: { kind: 'int64', value: 7n } } },
        { id: 603, name: 'balance', expression: { kind: 'literal', id: 604, value: { kind: 'int64', value: 70n } } },
        { id: 605, name: 'owner', expression: { kind: 'literal', id: 606, value: { kind: 'text', utf8: new TextEncoder().encode('cte-owner') } } },
      ],
      resultMode: { kind: 'multiset' },
    }
    const incoming = { id: 607, name: 'incoming', query: incomingQuery, materialized: 'not_materialized' as const }
    const insertSource: Query = {
      id: 608, ctes: [], joins: [], groupBy: [], windows: [], compounds: [], orderBy: [],
      from: { kind: 'cte', id: 609, name: 'incoming', alias: 'source' },
      projection: [
        { id: 610, name: 'id', expression: { kind: 'column', id: 611, name: 'id', relation: 'source' } },
        { id: 612, name: 'balance', expression: { kind: 'column', id: 613, name: 'balance', relation: 'source' } },
        { id: 614, name: 'owner', expression: { kind: 'column', id: 615, name: 'owner', relation: 'source' } },
      ],
      resultMode: { kind: 'multiset' },
    }
    const insert = compileMutation({
      kind: 'insert', id: 616, target: { kind: 'name', name: 'accounts' },
      ctes: [incoming], columns: ['id', 'balance', 'owner'], rows: [], source: insertSource,
      conflict: 'error', affectedRows: { kind: 'exactly', count: 1n },
    }, catalog)
    expect(insert.sql).toContain(
      'WITH "incoming" ("id", "balance", "owner") AS NOT MATERIALIZED (SELECT ?1 AS "chronolog_p_601", ?2 AS "chronolog_p_603", ?3 AS "chronolog_p_605") INSERT INTO "accounts"',
    )
    expect(insert.sql).toContain('FROM "incoming" AS "source"')
    expect(insert.parameters.map((parameter) => parameter.ordinal)).toEqual([1, 2, 3])

    const replacementQuery: Query = {
      id: 620, ctes: [], joins: [], groupBy: [], windows: [], compounds: [], orderBy: [],
      projection: [{
        id: 621, name: 'balance',
        expression: { kind: 'literal', id: 622, value: { kind: 'int64', value: 91n } },
      }],
      resultMode: { kind: 'scalar' },
    }
    const replacement = { id: 623, name: 'replacement', query: replacementQuery, materialized: 'default' as const }
    const scalarReplacement: Query = {
      id: 624, ctes: [], joins: [], groupBy: [], windows: [], compounds: [], orderBy: [],
      from: { kind: 'cte', id: 625, name: 'replacement', alias: 'replacement' },
      projection: [{
        id: 626, name: 'balance',
        expression: { kind: 'column', id: 627, name: 'balance', relation: 'replacement' },
      }],
      resultMode: { kind: 'scalar' },
    }
    const update = compileMutation({
      kind: 'update', id: 628, target: { kind: 'name', name: 'accounts' }, alias: 'target',
      ctes: [replacement], assignments: [{
        column: 'balance', value: {
          kind: 'builtin', id: 629, name: 'coalesce', args: [
            { kind: 'scalar_subquery', id: 633, query: scalarReplacement },
            { kind: 'literal', id: 634, value: { kind: 'int64', value: 0n } },
          ],
        },
      }],
      where: {
        kind: 'binary', id: 630, operator: 'eq',
        left: { kind: 'column', id: 631, name: 'id', relation: 'target' },
        right: { kind: 'literal', id: 632, value: { kind: 'int64', value: 1n } },
      },
      affectedRows: { kind: 'at_most', count: 1n },
    }, catalog)
    expect(update.sql).toContain(
      'WITH "replacement" ("balance") AS (SELECT ?1 AS "chronolog_p_621") UPDATE "accounts"',
    )
    expect(update.sql).toContain('SET "balance" = "coalesce"((SELECT "replacement"."balance"')
    expect(update.sql).toContain('WHERE ("target"."id" = ?3)')

    const deleteCandidateQuery: Query = {
      id: 640, ctes: [], joins: [], groupBy: [], windows: [], compounds: [], orderBy: [],
      projection: [{
        id: 641, name: 'id',
        expression: { kind: 'literal', id: 642, value: { kind: 'int64', value: 99n } },
      }],
      resultMode: { kind: 'multiset' },
    }
    const deleteCandidate = { id: 643, name: 'delete_candidate', query: deleteCandidateQuery, materialized: 'default' as const }
    const deleteMembership: Query = {
      id: 644, ctes: [], joins: [], groupBy: [], windows: [], compounds: [], orderBy: [],
      from: { kind: 'cte', id: 645, name: 'delete_candidate', alias: 'candidate' },
      projection: [{
        id: 646, name: 'id', expression: { kind: 'column', id: 647, name: 'id', relation: 'candidate' },
      }],
      resultMode: { kind: 'multiset' },
    }
    const deletion = compileMutation({
      kind: 'delete', id: 648, target: { kind: 'name', name: 'accounts' }, alias: 'target',
      ctes: [deleteCandidate],
      where: {
        kind: 'membership', id: 649, negated: false,
        value: { kind: 'column', id: 650, name: 'id', relation: 'target' },
        query: deleteMembership,
      },
      affectedRows: { kind: 'at_most', count: 1n },
    }, catalog)
    expect(deletion.sql).toContain(
      'WITH "delete_candidate" ("id") AS (SELECT ?1 AS "chronolog_p_641") DELETE FROM "accounts"',
    )
    expect(deletion.sql).toContain('IN (SELECT "candidate"."id"')
  })

  it('compiles recursive mutation CTEs with typed self-references', () => {
    const catalog = compileSchema(schema, manifest).catalog
    const recursiveArm: Query = {
      id: 660, ctes: [], joins: [], groupBy: [], windows: [], compounds: [], orderBy: [],
      from: { kind: 'cte', id: 661, name: 'numbers' },
      where: {
        kind: 'binary', id: 662, operator: 'lt',
        left: { kind: 'column', id: 663, name: 'n', relation: 'numbers' },
        right: { kind: 'literal', id: 664, value: { kind: 'int64', value: 3n } },
      },
      projection: [{
        id: 665, name: 'n', expression: {
          kind: 'binary', id: 666, operator: 'add',
          left: { kind: 'column', id: 667, name: 'n', relation: 'numbers' },
          right: { kind: 'literal', id: 668, value: { kind: 'int64', value: 1n } },
        },
      }],
      resultMode: { kind: 'multiset' },
    }
    const numbersQuery: Query = {
      id: 669, ctes: [], joins: [], groupBy: [], windows: [], orderBy: [],
      projection: [{
        id: 670, name: 'n',
        expression: { kind: 'literal', id: 671, value: { kind: 'int64', value: 1n } },
      }],
      compounds: [{ id: 672, operator: 'union_all', query: recursiveArm }],
      resultMode: { kind: 'multiset' },
    }
    const source: Query = {
      id: 673, ctes: [], joins: [], groupBy: [], windows: [], compounds: [], orderBy: [],
      from: { kind: 'cte', id: 674, name: 'numbers' },
      projection: [{
        id: 675, name: 'id', expression: { kind: 'column', id: 676, name: 'n', relation: 'numbers' },
      }],
      resultMode: { kind: 'multiset' },
    }
    const compiled = compileMutation({
      kind: 'insert', id: 677, target: { kind: 'name', name: 'accounts' },
      ctes: [{ id: 678, name: 'numbers', query: numbersQuery, materialized: 'default' }],
      recursive: true, columns: ['id'], rows: [], source, conflict: 'ignore',
      affectedRows: { kind: 'unconstrained' },
    }, catalog)
    expect(compiled.sql).toContain('WITH RECURSIVE "numbers" ("n") AS (')
    expect(compiled.sql).toContain('FROM "numbers" AS "numbers"')
    expect(compiled.sql).toContain('INSERT OR IGNORE INTO "accounts" ("id")')
    expect(compiled.parameters.map((parameter) => parameter.source)).toEqual([
      { kind: 'literal', value: { kind: 'int64', value: 1n } },
      { kind: 'literal', value: { kind: 'int64', value: 1n } },
      { kind: 'literal', value: { kind: 'int64', value: 3n } },
    ])
    expect(() => compileMutation({
      kind: 'delete', id: 679, target: { kind: 'name', name: 'accounts' }, recursive: true,
      affectedRows: { kind: 'unconstrained' },
    }, catalog)).toThrowError(expect.objectContaining({ code: 'IR_RECURSIVE_CTE_REQUIRED' }))
  })

  it('commits canonical schema and execution manifest bytes to 32-byte digests', async () => {
    const artifacts = await compileManifestArtifacts(schema, manifest)
    expect(artifacts.schemaDigest).toHaveLength(32)
    expect(artifacts.executionManifestDigest).toHaveLength(32)
    expect(artifacts.canonicalSchema.length).toBeGreaterThan(0)
    expect(artifacts.canonicalExecutionManifest.length).toBeGreaterThan(0)
  })

  it('rejects window functions in mutation scalar contexts', () => {
    const catalog = compileSchema(schema, manifest).catalog
    expect(() => compileMutation({
      kind: 'update', id: 690, target: { kind: 'name', name: 'accounts' },
      assignments: [{
        column: 'balance',
        value: {
          kind: 'window', id: 691, operation: 'row_number', args: [],
          window: { partitionBy: [], orderBy: [] },
        },
      }],
      affectedRows: { kind: 'unconstrained' },
    }, catalog)).toThrowError(expect.objectContaining({ code: 'IR_WINDOW_CONTEXT_INVALID' }))
  })

  it('resolves overwritten assignment expressions without evaluating or binding them', () => {
    const catalog = compileSchema(schema, manifest).catalog
    expect(() => compileMutation({
      kind: 'update', id: 692, target: { kind: 'name', name: 'accounts' },
      assignments: [
        { column: 'balance', value: { kind: 'column', id: 693, name: 'missing' } },
        { column: 'balance', value: { kind: 'literal', id: 694, value: { kind: 'int64', value: 1n } } },
      ],
      affectedRows: { kind: 'unconstrained' },
    }, catalog)).toThrowError(expect.objectContaining({ code: 'IR_UNKNOWN_COLUMN' }))
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
