import {
  ChronologClient,
  fromBase64Url,
  toBase64Url,
} from '@chronolog/client'
import {
  compileMutation,
  compileQuery,
  compileSchema,
} from '@chronolog/compiler-sqlite'
import {
  decodeQuery,
  encodeCanonicalQueryResult,
  encodeQuery,
  type CanonicalQueryResult,
  type ExecutionManifest,
  type SchemaManifest,
} from '@chronolog/ir'
import {
  InProcessRpcTransport,
  type ChronologRpcService,
} from '@chronolog/rpc'
import { DatabaseSync } from '@dolthub/doltlite'
import { describe, expect, it } from 'vitest'

import { defineLoweredMutation, defineLoweredQuery } from './client-adapter.js'
import { SqliteConsensusFrontend } from './frontend.js'
import { SqlFrontendError } from './types.js'

const int = { logical: { kind: 'int64' as const }, nullable: false }
const text = { logical: { kind: 'text' as const, collation: 'binary' as const }, nullable: false }
const json = { logical: { kind: 'json' as const }, nullable: false }

const manifest: ExecutionManifest = {
  version: 1,
  profile: 'sql-frontend-test-v1',
  engine: 'doltlite-test',
  engineDigest: new Uint8Array(32),
  functions: [],
  collations: [],
  modules: [],
  features: { decimal: true, json: true, vector: false, fts: false, spatial: false, wasm: false },
  resources: {
    maxProgramNodes: 10_000,
    maxExpressionDepth: 64,
    maxQueryRows: 10_000,
    maxResultBytes: 1_000_000,
    maxJsonDepth: 64,
    maxVectorDimensions: 1_024,
    maxRuleDepth: 0,
    maxWasmFuel: 0n,
  },
}

const schema: SchemaManifest = {
  version: 1,
  name: 'frontend-test',
  objects: [{
    kind: 'table',
    id: 1,
    name: 'accounts',
    declarationOrder: 0,
    withoutRowId: true,
    columns: [
      { id: 2, name: 'id', declarationOrder: 0, valueType: int },
      { id: 3, name: 'balance', declarationOrder: 1, valueType: int },
      { id: 4, name: 'owner', declarationOrder: 2, valueType: text },
    ],
    constraints: [{ kind: 'primary_key', id: 5, name: 'accounts_pk', columnIds: [2] }],
  }],
  seedRows: [],
  functionIds: [],
  collationIds: [],
  moduleIds: [],
}

function frontend(): SqliteConsensusFrontend {
  return new SqliteConsensusFrontend({ schema, executionManifest: manifest })
}

describe('SQLite consensus frontend', () => {
  it('round-trips an external-builder-shaped ordered SELECT through the real compiler', () => {
    const query = frontend().lowerQuery({
      sql: 'SELECT a.id, lower(a.owner) AS normalized FROM accounts AS a WHERE a.id = ? ORDER BY a.id',
      parameters: [7n],
    })
    const compiled = compileQuery(query, compileSchema(schema, manifest).catalog)
    expect(query.resultMode).toEqual({ kind: 'ordered' })
    expect(compiled.sql).toContain(
      'SELECT "a"."id" AS "chronolog_p_3", "lower"("a"."owner") AS "chronolog_p_6" FROM "accounts" AS "a" WHERE ("a"."id" = ?1) ORDER BY "a"."id" ASC NULLS FIRST',
    )
    expect(compiled.parameters[0]?.source).toEqual({ kind: 'literal', value: { kind: 'int64', value: 7n } })
  })

  it('lowers compiler-owned deterministic builtins without manifest registration', () => {
    expect(manifest.functions).toEqual([])
    expect(schema.functionIds).toEqual([])

    const query = frontend().lowerQuery({
      sql: `
        SELECT
          length(owner) AS text_length,
          length(X'ABCD') AS blob_length,
          hex(X'AB') AS encoded,
          sign(balance) AS signed,
          abs(balance) AS absolute,
          coalesce(NULL, balance) AS fallback,
          lower(NULL) AS null_text,
          coalesce(NULL, NULL) AS null_value
        FROM accounts
      `,
    })
    expect(query.projection.map((projection) => projection.expression)).toMatchObject([
      { kind: 'builtin', name: 'length' },
      { kind: 'builtin', name: 'length' },
      { kind: 'builtin', name: 'hex' },
      { kind: 'builtin', name: 'sign' },
      { kind: 'builtin', name: 'abs' },
      { kind: 'builtin', name: 'coalesce' },
      { kind: 'builtin', name: 'lower' },
      { kind: 'builtin', name: 'coalesce' },
    ])
    const compiled = compileQuery(query, compileSchema(schema, manifest).catalog)
    expect(compiled.sql).toContain('"length"("accounts"."owner")')
    expect(compiled.sql).toContain('"hex"(?2)')
    expect(compiled.sql).toContain('"sign"("accounts"."balance")')
    expect(compiled.sql).toContain('"abs"("accounts"."balance")')
    expect(compiled.sql).toContain('"coalesce"(?3, "accounts"."balance")')
    expect(compiled.columns.map((column) => column.valueType)).toEqual([
      { logical: { kind: 'int64' }, nullable: false },
      { logical: { kind: 'int64' }, nullable: false },
      { logical: { kind: 'text', collation: 'binary' }, nullable: false },
      { logical: { kind: 'int64' }, nullable: false },
      { logical: { kind: 'int64' }, nullable: false },
      { logical: { kind: 'int64' }, nullable: false },
      { logical: { kind: 'text', collation: 'binary' }, nullable: true },
      { logical: { kind: 'blob' }, nullable: true },
    ])

    const expanded = frontend().lowerQuery({
      sql: `
        SELECT
          char(65) AS characters,
          concat('account-', id) AS concatenated,
          concat_ws('-', owner, id) AS joined,
          if(id = 1, owner, 'other') AS selected,
          iif(id = 1, owner) AS optional,
          likelihood(owner, 0.125) AS likelihood_owner,
          likely(id) AS likely_id,
          unlikely(id) AS unlikely_id,
          glob('a*', owner) AS globbed,
          like('a%', owner) AS liked,
          min(id, balance) AS minimum,
          max(owner, 'z') AS maximum,
          quote(owner) AS quoted,
          typeof(owner) AS storage_type,
          unhex('AB-CD', '-') AS decoded,
          unicode(owner) AS code_point,
          unistr('A\\u00e9') AS unicode_text,
          unistr_quote(owner) AS display_literal,
          zeroblob(2) AS zeros
        FROM accounts
      `,
    })
    expect(expanded.projection.map((projection) => projection.expression)).toMatchObject([
      { kind: 'builtin', name: 'char' },
      { kind: 'builtin', name: 'concat' },
      { kind: 'builtin', name: 'concat_ws' },
      { kind: 'builtin', name: 'if' },
      { kind: 'builtin', name: 'iif' },
      { kind: 'builtin', name: 'likelihood' },
      { kind: 'builtin', name: 'likely' },
      { kind: 'builtin', name: 'unlikely' },
      { kind: 'builtin', name: 'glob' },
      { kind: 'builtin', name: 'like' },
      { kind: 'builtin', name: 'min' },
      { kind: 'builtin', name: 'max' },
      { kind: 'builtin', name: 'quote' },
      { kind: 'builtin', name: 'typeof' },
      { kind: 'builtin', name: 'unhex' },
      { kind: 'builtin', name: 'unicode' },
      { kind: 'builtin', name: 'unistr' },
      { kind: 'builtin', name: 'unistr_quote' },
      { kind: 'builtin', name: 'zeroblob' },
    ])
    expect(compileQuery(expanded, compileSchema(schema, manifest).catalog).sql).toContain(
      '"zeroblob"(?13)',
    )
    expect(compileQuery(expanded, compileSchema(schema, manifest).catalog).sql).toContain(
      '"likelihood"("accounts"."owner", 0.125)',
    )

    for (const [sql, feature] of [
      ['SELECT length()', 'IR_BUILTIN_ARITY'],
      ['SELECT lower(1)', 'IR_BUILTIN_ARGUMENT_TYPE'],
      ['SELECT likelihood(1, 1)', 'IR_BUILTIN_ARGUMENT_TYPE'],
      ['SELECT likelihood(1, 1.1)', 'IR_BUILTIN_ARGUMENT_TYPE'],
      ["SELECT coalesce(1, 'text')", 'IR_BUILTIN_ARGUMENT_TYPE'],
      ["SELECT if('truthy', 1)", 'IR_BUILTIN_ARGUMENT_TYPE'],
      ["SELECT min(1, 'text')", 'IR_BUILTIN_ARGUMENT_TYPE'],
      ["SELECT zeroblob('2')", 'IR_BUILTIN_ARGUMENT_TYPE'],
    ] as const) {
      try {
        frontend().lowerQuery({ sql })
        throw new Error(`Expected ${sql} to fail`) // pragma: allowlist secret
      } catch (error) {
        expect(error).toMatchObject({
          name: 'SqlFrontendError',
          code: 'SQL_FEATURE_UNSUPPORTED',
          feature,
        })
      }
    }
  })

  it('round-trips named INSERT, UPDATE, and DELETE parameters through command compilation', () => {
    const sql = frontend()
    const catalog = compileSchema(schema, manifest).catalog
    const insert = sql.lowerCommand({
      sql: 'INSERT INTO accounts (id, balance, owner) VALUES (:id, :balance, :owner)',
      parameters: { id: 8n, balance: 40n, owner: 'bob' },
    })
    const update = sql.lowerCommand({
      sql: 'UPDATE accounts SET owner = :owner WHERE id = :id',
      parameters: { owner: 'robert', id: 8n },
    })
    const remove = sql.lowerCommand({
      sql: 'DELETE FROM accounts WHERE id = ?',
      parameters: [8n],
    })
    expect(compileMutation(insert, catalog).sql).toContain('INSERT INTO "accounts"')
    expect(compileMutation(update, catalog).sql).toBe(
      'UPDATE "accounts" AS "accounts" SET "owner" = ?1 WHERE ("accounts"."id" = ?2)',
    )
    expect(compileMutation(remove, catalog).sql).toBe(
      'DELETE FROM "accounts" AS "accounts" WHERE ("accounts"."id" = ?1)',
    )

    const insertSelect = sql.lowerCommand({
      sql: 'INSERT OR IGNORE INTO accounts (id, balance, owner) SELECT id, balance, owner FROM accounts',
    })
    expect(compileMutation(insertSelect, catalog).sql).toContain(
      'INSERT OR IGNORE INTO "accounts"',
    )
    expect(compileMutation(insertSelect, catalog).sql).toContain(
      'ORDER BY 1 ASC NULLS FIRST, 2 ASC NULLS FIRST, 3 ASC NULLS FIRST',
    )

    const defaultValues = sql.lowerCommand({
      sql: 'INSERT OR IGNORE INTO accounts DEFAULT VALUES',
    })
    expect(defaultValues).toMatchObject({ columns: [], rows: [[]], conflict: 'ignore' })
    expect(compileMutation(defaultValues, catalog).sql).toBe(
      'INSERT OR IGNORE INTO "accounts" DEFAULT VALUES',
    )
    const replace = sql.lowerCommand({
      sql: 'REPLACE INTO accounts (id, balance, owner) VALUES (?, ?, ?)',
      parameters: [9n, 60n, 'carol'],
    })
    expect(compileMutation(replace, catalog).sql).toContain(
      'INSERT OR REPLACE INTO "accounts"',
    )

    const aliasedUpdate = sql.lowerCommand({
      sql: 'UPDATE accounts AS account SET balance = ? WHERE account.id = ?',
      parameters: [50n, 8n],
    })
    expect(compileMutation(aliasedUpdate, catalog).sql).toContain(
      'UPDATE "accounts" AS "account" SET "balance" = ?1 WHERE ("account"."id" = ?2)',
    )

    const conflictUpdate = sql.lowerCommand({
      sql: 'UPDATE OR REPLACE accounts AS account SET balance = ? WHERE account.id = ?',
      parameters: [51n, 8n],
    })
    expect(compileMutation(conflictUpdate, catalog).sql).toContain(
      'UPDATE OR REPLACE "accounts" AS "account" SET "balance" = ?1',
    )
    const mainQualified = sql.lowerCommand({
      sql: 'UPDATE main.accounts SET balance = ? WHERE id = ?',
      parameters: [52n, 8n],
    })
    expect(compileMutation(mainQualified, catalog).sql).toContain(
      'UPDATE "accounts" AS "accounts" SET "balance" = ?1',
    )

    const aliasedDelete = sql.lowerCommand({
      sql: 'DELETE FROM accounts AS account WHERE account.id = ?',
      parameters: [8n],
    })
    expect(compileMutation(aliasedDelete, catalog).sql).toContain(
      'DELETE FROM "accounts" AS "account" WHERE ("account"."id" = ?1)',
    )
  })

  it('lowers mutation CTEs, including recursive CTEs and IN table shorthand', () => {
    const sql = frontend()
    const catalog = compileSchema(schema, manifest).catalog
    const insert = sql.lowerCommand({
      sql: `
        WITH copied(id, balance, owner) AS (
          SELECT id + 100, balance, owner FROM accounts WHERE id = 1
        )
        INSERT INTO accounts (id, balance, owner)
        SELECT id, balance, owner FROM copied
      `,
    })
    expect(insert).toMatchObject({ ctes: [{ name: 'copied' }], source: {} })
    expect(compileMutation(insert, catalog).sql).toContain(
      'WITH "copied" ("id", "balance", "owner") AS',
    )

    const update = sql.lowerCommand({
      sql: `
        WITH picked(id) AS (SELECT id FROM accounts WHERE balance > 0)
        UPDATE accounts SET balance = 0 WHERE id IN picked
      `,
    })
    expect(update).toMatchObject({ ctes: [{ name: 'picked' }] })
    expect(compileMutation(update, catalog).sql).toContain(
      'WITH "picked" ("id") AS',
    )

    const remove = sql.lowerCommand({
      sql: `
        WITH RECURSIVE ids(id) AS (
          SELECT 1 UNION ALL SELECT id + 1 FROM ids WHERE id < 3
        )
        DELETE FROM accounts WHERE id IN ids
      `,
    })
    expect(remove).toMatchObject({ recursive: true, ctes: [{ name: 'ids' }] })
    expect(compileMutation(remove, catalog).sql).toContain(
      'WITH RECURSIVE "ids" ("id") AS',
    )
  })

  it('lowers modern UPSERT chains, stable conflict targets, and excluded values', () => {
    const sql = frontend()
    const catalog = compileSchema(schema, manifest).catalog
    const mutation = sql.lowerCommand({
      sql: `
        INSERT INTO accounts (id, balance, owner) VALUES (?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          balance = excluded.balance,
          owner = excluded.owner
        WHERE accounts.id = excluded.id
        ON CONFLICT DO NOTHING
      `,
      parameters: [1n, 10n, 'alice'],
    })
    expect(mutation).toMatchObject({
      upsertClauses: [
        {
          target: { constraintId: 5 },
          action: 'update',
          assignments: [
            { column: 'balance', value: { kind: 'old_new', scope: 'new', column: 'balance' } },
            { column: 'owner', value: { kind: 'old_new', scope: 'new', column: 'owner' } },
          ],
        },
        { action: 'nothing' },
      ],
    })
    const compiled = compileMutation(mutation, catalog)
    expect(compiled.sql).toContain(
      'ON CONFLICT ("id") DO UPDATE SET "balance" = "excluded"."balance", "owner" = "excluded"."owner"',
    )
    expect(compiled.sql).toContain('ON CONFLICT DO NOTHING')
  })

  it('resolves expression and partial-index UPSERT targets from the schema manifest', () => {
    const indexedSchema: SchemaManifest = {
      ...schema,
      name: 'frontend-indexed-upsert',
      objects: [
        ...schema.objects,
        {
          kind: 'index', id: 6, name: 'accounts_owner_present', declarationOrder: 1,
          tableId: 1, unique: true,
          expressions: [{ kind: 'column', id: 7, relation: 'accounts', name: 'owner' }],
          where: {
            kind: 'unary', id: 8, operator: 'is_not_null',
            operand: { kind: 'column', id: 9, relation: 'accounts', name: 'owner' },
          },
        },
      ],
    }
    const sql = new SqliteConsensusFrontend({ schema: indexedSchema, executionManifest: manifest })
    const mutation = sql.lowerCommand({
      sql: `
        INSERT INTO accounts (id, balance, owner) VALUES (1, 10, 'alice')
        ON CONFLICT(owner) WHERE owner IS NOT NULL DO NOTHING
      `,
    })
    expect(mutation).toMatchObject({
      upsertClauses: [{ target: { indexId: 6 }, action: 'nothing' }],
    })
    expect(compileMutation(mutation, compileSchema(indexedSchema, manifest).catalog).sql).toContain(
      'ON CONFLICT ("owner") WHERE ("owner" IS NOT NULL) DO NOTHING',
    )
  })

  it('lowers UPDATE FROM and row-value SET with simultaneous RHS semantics', () => {
    const sql = frontend()
    const catalog = compileSchema(schema, manifest).catalog
    const from = sql.lowerCommand({
      sql: `
        UPDATE accounts AS target
        SET balance = source.balance, owner = source.owner
        FROM accounts AS source
        WHERE target.id = source.id
      `,
    })
    expect(from).toMatchObject({
      from: { projection: expect.any(Array) },
      fromAlias: '__chronolog_update_from',
    })
    const compiledFrom = compileMutation(from, catalog)
    expect(compiledFrom.sql).toContain(' FROM (SELECT ')
    expect(compiledFrom.sql).toContain('AS "__chronolog_update_from"')
    expect(compiledFrom.sql).toContain('WHERE ("target"."id" = "__chronolog_update_from".')

    const row = sql.lowerCommand({
      sql: 'UPDATE accounts SET (balance, owner) = (?, ?) WHERE id = ?',
      parameters: [20n, 'bob', 1n],
    })
    expect(row).toMatchObject({
      assignments: [
        { column: 'balance', value: { kind: 'literal' } },
        { column: 'owner', value: { kind: 'literal' } },
      ],
    })
    expect(compileMutation(row, catalog).sql).toContain(
      'SET "balance" = ?1, "owner" = ?2',
    )

    const subqueryRow = sql.lowerCommand({
      sql: `
        UPDATE accounts AS target
        SET (balance, owner) = (
          SELECT source.balance, source.owner FROM accounts AS source WHERE source.id = ?
        )
        WHERE target.id = ?
      `,
      parameters: [2n, 1n],
    })
    expect(subqueryRow).toMatchObject({
      assignments: [
        { column: 'balance', value: { kind: 'scalar_subquery' } },
        { column: 'owner', value: { kind: 'scalar_subquery' } },
      ],
    })
    expect(compileMutation(subqueryRow, catalog).sql).toContain('SET "balance" = (SELECT')
  })

  it('selects every row-value SET component from one identically ordered tuple', () => {
    const tupleSchema: SchemaManifest = {
      ...schema,
      name: 'row-assignment-tuples',
      objects: [
        {
          kind: 'table', id: 400, name: 'targets', declarationOrder: 0, withoutRowId: true,
          columns: [
            { id: 401, name: 'id', declarationOrder: 0, valueType: int },
            { id: 402, name: 'balance', declarationOrder: 1, valueType: int },
            { id: 403, name: 'owner', declarationOrder: 2, valueType: text },
          ],
          constraints: [{ kind: 'primary_key', id: 404, name: 'targets_pk', columnIds: [401] }],
        },
        {
          kind: 'table', id: 410, name: 'sources', declarationOrder: 1, withoutRowId: true,
          columns: [
            { id: 411, name: 'id', declarationOrder: 0, valueType: int },
            { id: 412, name: 'balance', declarationOrder: 1, valueType: int },
            { id: 413, name: 'owner', declarationOrder: 2, valueType: text },
          ],
          constraints: [{ kind: 'primary_key', id: 414, name: 'sources_pk', columnIds: [411] }],
        },
      ],
    }
    const sql = new SqliteConsensusFrontend({ schema: tupleSchema, executionManifest: manifest })
    const catalog = compileSchema(tupleSchema, manifest).catalog
    const authored = compileMutation(sql.lowerCommand({
      sql: `
        UPDATE targets SET (balance, owner) = (
          SELECT balance, owner FROM sources ORDER BY id DESC
        )
      `,
    }), catalog)
    const canonical = compileMutation(sql.lowerCommand({
      sql: 'UPDATE targets SET (balance, owner) = (SELECT balance, owner FROM sources)',
    }), catalog)

    expect(authored.sql.match(
      /ORDER BY "sources"\."id" DESC NULLS LAST, 1 ASC NULLS FIRST, 2 ASC NULLS FIRST LIMIT 1/gu,
    )).toHaveLength(2)
    expect(canonical.sql.match(
      /ORDER BY 1 ASC NULLS FIRST, 2 ASC NULLS FIRST LIMIT 1/gu,
    )).toHaveLength(2)

    const database = new DatabaseSync(':memory:')
    try {
      database.exec(`
        CREATE TABLE targets (id INTEGER PRIMARY KEY, balance INTEGER NOT NULL, owner TEXT NOT NULL);
        CREATE TABLE sources (id INTEGER PRIMARY KEY, balance INTEGER NOT NULL, owner TEXT NOT NULL);
        INSERT INTO targets VALUES (1, 0, 'unset');
        INSERT INTO sources VALUES (1, 1, 'z'), (2, 100, 'a');
      `)
      database.prepare(authored.sql).run()
      expect(database.prepare('SELECT balance, owner FROM targets').get()).toEqual({
        balance: 100,
        owner: 'a',
      })
      database.exec("UPDATE targets SET balance = 0, owner = 'unset'")
      database.prepare(canonical.sql).run()
      expect(database.prepare('SELECT balance, owner FROM targets').get()).toEqual({
        balance: 1,
        owner: 'z',
      })
    } finally {
      database.close()
    }
  })

  it('matches SQLite expression and duplicate-column names at relation boundaries', () => {
    const sql = frontend()
    const catalog = compileSchema(schema, manifest).catalog
    const topLevelText = 'SELECT 1 /* exact */ + 2, id, id, (id) FROM accounts'
    const derivedText = 'SELECT * FROM (SELECT 1 AS id, 2 AS id, 3 AS "id:1", 4 AS id)'
    const unaliasedDerivedText = 'SELECT nested."1 + 2" FROM (SELECT 1 + 2) AS nested'
    const cteText = 'WITH named(a, a) AS (SELECT 1, 2) SELECT * FROM named'
    const topLevel = compileQuery(sql.lowerQuery({ sql: topLevelText }), catalog)
    const derived = compileQuery(sql.lowerQuery({ sql: derivedText }), catalog)
    const unaliasedDerived = compileQuery(sql.lowerQuery({ sql: unaliasedDerivedText }), catalog)
    const cte = compileQuery(sql.lowerQuery({ sql: cteText }), catalog)

    const database = new DatabaseSync(':memory:')
    try {
      database.exec('CREATE TABLE accounts (id INTEGER PRIMARY KEY, balance INTEGER, owner TEXT)')
      const sqliteNames = (statement: string): string[] =>
        database.prepare(statement).columns().map((column) => {
          if (column.name === null) throw new Error('SQLite result column unexpectedly has no name')
          return column.name
        })
      expect(topLevel.columns.map((column) => column.name)).toEqual(sqliteNames(topLevelText))
      expect(topLevel.columns.map((column) => column.name)).toEqual([
        '1 /* exact */ + 2', 'id', 'id', 'id',
      ])
      expect(derived.columns.map((column) => column.name)).toEqual(sqliteNames(derivedText))
      expect(derived.columns.map((column) => column.name)).toEqual(['id', 'id:1', 'id:2', 'id:3'])
      expect(unaliasedDerived.columns.map((column) => column.name)).toEqual(
        sqliteNames(unaliasedDerivedText),
      )
      expect(unaliasedDerived.columns.map((column) => column.name)).toEqual(['1 + 2'])
      expect(cte.columns.map((column) => column.name)).toEqual(sqliteNames(cteText))
      expect(cte.columns.map((column) => column.name)).toEqual(['a', 'a:1'])
    } finally {
      database.close()
    }
  })

  it('retains aggregate ORDER BY for SQLite evaluation and exact name resolution', () => {
    const query = frontend().lowerQuery({
      sql: 'SELECT min(balance ORDER BY owner DESC), count(id ORDER BY owner) FROM accounts',
    })
    expect(query.projection.map((projection) => projection.expression)).toMatchObject([
      { kind: 'aggregate', operation: 'min' },
      { kind: 'aggregate', operation: 'count' },
    ])
    const compiled = compileQuery(query, compileSchema(schema, manifest).catalog)
    expect(compiled.sql).toContain(
      'MIN("accounts"."balance" ORDER BY "accounts"."owner" DESC NULLS LAST)',
    )
    expect(compiled.sql).toContain(
      'COUNT("accounts"."id" ORDER BY "accounts"."owner" ASC NULLS FIRST)',
    )
    expect(() => frontend().lowerQuery({
      sql: 'SELECT count(id ORDER BY nosuch) FROM accounts',
    })).toThrowError(expect.objectContaining({ feature: 'IR_UNKNOWN_COLUMN' }))
    expect(() => frontend().lowerQuery({
      sql: 'SELECT lower(owner ORDER BY id) FROM accounts',
    })).toThrowError(expect.objectContaining({
      feature: 'ORDER BY on non-aggregate function lower',
    }))
    expect(() => frontend().lowerQuery({
      sql: 'SELECT count(id ORDER BY owner) OVER () FROM accounts',
    })).toThrowError(expect.objectContaining({
      feature: 'aggregate argument ORDER BY in a window function',
    }))
  })

  it('preserves ordinary quoted SQLite identifiers and names unaliased expressions deterministically', () => {
    const quotedSchema: SchemaManifest = {
      ...schema,
      name: 'quoted',
      functionIds: [],
      objects: [{
        kind: 'table', id: 200, name: 'select table', declarationOrder: 0, withoutRowId: true,
        columns: [
          { id: 201, name: 'user id', declarationOrder: 0, valueType: int },
          { id: 202, name: 'from', declarationOrder: 1, valueType: text },
        ],
        constraints: [{ kind: 'primary_key', id: 203, name: 'primary key', columnIds: [201] }],
      }],
    }
    const quotedManifest = { ...manifest, functions: [] }
    const sql = new SqliteConsensusFrontend({ schema: quotedSchema, executionManifest: quotedManifest })
    const query = sql.lowerQuery({
      sql: 'SELECT q."user id", q."from", 1 FROM "select table" AS q WHERE q."user id" = ? ORDER BY q."user id"',
      parameters: [7n],
    })
    expect(query.projection.map((projection) => projection.name)).toEqual(['user id', 'from', '1'])
    const compiled = compileQuery(query, compileSchema(quotedSchema, quotedManifest).catalog)
    expect(compiled.sql).toContain('FROM "select table" AS "q"')
    expect(compiled.sql).toContain('"q"."user id"')
  })

  it('round-trips CTE, UNION ALL, IN, and a proven correlated scalar subquery', () => {
    const sql = frontend()
    const catalog = compileSchema(schema, manifest).catalog
    const compound = sql.lowerQuery({
      sql: 'WITH selected AS (SELECT id, owner FROM accounts WHERE id IN (?, ?)) SELECT owner FROM selected UNION ALL SELECT owner FROM accounts WHERE id = ?',
      parameters: [1n, 2n, 3n],
    })
    const correlated = sql.lowerQuery({
      sql: 'SELECT (SELECT owner FROM accounts AS inner_a WHERE inner_a.id = outer_a.id) AS owner FROM accounts AS outer_a',
    })
    expect(compileQuery(compound, catalog).sql).toContain('WITH "selected"')
    expect(compileQuery(compound, catalog).sql).toContain('UNION ALL')
    expect(compileQuery(correlated, catalog).sql).toContain('SELECT "inner_a"."owner"')

    const correlatedCte = sql.lowerQuery({
      sql: `
        SELECT (
          WITH captured AS (SELECT outer_a.id AS x)
          SELECT x FROM captured
        ) AS captured_id
        FROM accounts AS outer_a
      `,
    })
    expect(correlatedCte.projection[0]?.expression).toMatchObject({
      kind: 'scalar_subquery',
      query: {
        ctes: [{ query: { projection: [{ expression: { kind: 'column', relation: 'outer_a' } }] } }],
      },
    })
    expect(compileQuery(correlatedCte, catalog).sql).toContain('WITH "captured" ("x") AS')
  })

  it('uses SQLite clause-specific alias precedence and rejects invalid ordinals', () => {
    const sql = frontend()
    const catalog = compileSchema(schema, manifest).catalog
    const text = `
      SELECT count(*) AS owner
      FROM accounts
      GROUP BY owner
      ORDER BY owner
    `
    const query = sql.lowerQuery({ sql: text })
    expect(query.groupBy).toMatchObject([{ kind: 'column', relation: 'accounts', name: 'owner' }])
    expect(query.orderBy).toMatchObject([{ expression: { kind: 'aggregate', operation: 'count' } }])
    const compiled = compileQuery(query, catalog)
    expect(compiled.sql).toContain('GROUP BY "accounts"."owner"')
    expect(compiled.sql).toContain('ORDER BY COUNT(*) ASC NULLS FIRST')

    const localAlias = sql.lowerQuery({
      sql: 'SELECT (SELECT 1 AS owner GROUP BY owner) AS grouped FROM accounts',
    })
    expect(localAlias.projection[0]?.expression).toMatchObject({
      kind: 'scalar_subquery',
      query: { groupBy: [{ kind: 'literal', value: { kind: 'int64', value: 1n } }] },
    })

    const database = new DatabaseSync(':memory:')
    try {
      database.exec(`
        CREATE TABLE accounts (id INTEGER PRIMARY KEY, balance INTEGER, owner TEXT);
        INSERT INTO accounts VALUES (1, 0, 'a'), (2, 0, 'a'), (3, 0, 'b');
      `)
      expect(database.prepare(text).all()).toEqual([{ owner: 1 }, { owner: 2 }])
    } finally {
      database.close()
    }

    for (const [clause, syntax, ordinal] of [
      ['ORDER BY', '0', '0'], ['ORDER BY', '2', '2'],
      ['GROUP BY', '0', '0'], ['GROUP BY', '2', '2'],
      ['ORDER BY', '0x2', '2'], ['GROUP BY', '+2', '2'],
      ['ORDER BY', '-1', '-1'],
    ] as const) {
      expect(() => sql.lowerQuery({
        sql: `SELECT id FROM accounts ${clause} ${syntax}`,
      })).toThrowError(expect.objectContaining({
        feature: `${clause} ordinal ${ordinal} outside 1..1`,
      }))
    }
  })

  it('uses result aliases as expression fallback in WHERE, JOIN ON, HAVING, ORDER BY, and GROUP BY', () => {
    const sql = frontend()
    const catalog = compileSchema(schema, manifest).catalog

    const filteredText = `
      SELECT balance + 1 AS adjusted
      FROM accounts
      WHERE adjusted > 10
      ORDER BY adjusted + 1
    `
    const filtered = sql.lowerQuery({ sql: filteredText })
    expect(filtered.where).toMatchObject({
      kind: 'binary',
      operator: 'gt',
      left: { kind: 'binary', operator: 'add' },
    })
    expect(filtered.orderBy).toMatchObject([{
      expression: { kind: 'binary', operator: 'add', left: { kind: 'binary', operator: 'add' } },
    }])
    const filteredSql = compileQuery(filtered, catalog).sql
    expect(filteredSql).toContain('WHERE ((CASE WHEN "accounts"."balance" IS NULL')
    expect(filteredSql).toContain('ORDER BY (CASE WHEN (CASE WHEN "accounts"."balance" IS NULL')

    const collision = sql.lowerQuery({
      sql: `SELECT balance + 1 AS owner FROM accounts WHERE owner = 'alice' ORDER BY owner || 'x'`,
    })
    expect(collision.where).toMatchObject({
      left: { kind: 'column', relation: 'accounts', name: 'owner' },
    })
    expect(collision.orderBy).toMatchObject([{
      expression: {
        kind: 'binary',
        operator: 'concat',
        left: { kind: 'column', relation: 'accounts', name: 'owner' },
      },
    }])

    const groupedText = `
      SELECT owner, count(*) AS n
      FROM accounts
      GROUP BY owner
      HAVING n > 1
      ORDER BY owner
    `
    const grouped = sql.lowerQuery({ sql: groupedText })
    expect(grouped.having).toMatchObject({
      kind: 'binary',
      operator: 'gt',
      left: { kind: 'aggregate', operation: 'count' },
    })

    const groupedExpression = sql.lowerQuery({
      sql: 'SELECT 1 AS grouped_value GROUP BY grouped_value + 1',
    })
    expect(groupedExpression.groupBy).toMatchObject([{
      kind: 'binary',
      operator: 'add',
      left: { kind: 'literal', value: { kind: 'int64', value: 1n } },
    }])

    const joinedText = `
      SELECT left_a.id + right_a.id AS total
      FROM accounts AS left_a JOIN accounts AS right_a ON total = 3
      ORDER BY total
    `
    const joined = sql.lowerQuery({ sql: joinedText })
    expect(joined.joins[0]?.on).toMatchObject({
      kind: 'binary',
      operator: 'eq',
      left: { kind: 'binary', operator: 'add' },
    })

    const database = new DatabaseSync(':memory:')
    try {
      database.exec(`
        CREATE TABLE accounts (id INTEGER PRIMARY KEY, balance INTEGER, owner TEXT);
        INSERT INTO accounts VALUES (1, 10, 'alice'), (2, 20, 'alice'), (3, 30, 'bob');
      `)
      expect(database.prepare(filteredText).all()).toEqual([
        { adjusted: 11 }, { adjusted: 21 }, { adjusted: 31 },
      ])
      expect(database.prepare(groupedText).all()).toEqual([{ owner: 'alice', n: 2 }])
      expect(database.prepare(joinedText).all()).toEqual([{ total: 3 }, { total: 3 }])
    } finally {
      database.close()
    }
  })

  it('resolves compound ORDER BY aliases and expressions across arms left-to-right', () => {
    const sql = frontend()
    const catalog = compileSchema(schema, manifest).catalog
    for (const [text, ordinal] of [
      ['SELECT 1 AS a UNION ALL SELECT 2 AS b ORDER BY b', 1n],
      ['SELECT 1 AS a, 9 AS q UNION ALL SELECT 3 AS b, 2 + 0 AS c ORDER BY 2 + 0', 2n],
      ['SELECT 9 AS x, 1 AS y UNION ALL SELECT 0 AS y, 8 AS x ORDER BY y', 2n],
    ] as const) {
      const query = sql.lowerQuery({ sql: text })
      expect(query.orderBy).toMatchObject([{
        expression: { kind: 'literal', value: { kind: 'int64', value: ordinal } },
      }])
      expect(compileQuery(query, catalog).sql).toContain(
        `ORDER BY ${ordinal.toString()} ASC NULLS FIRST`,
      )
      const database = new DatabaseSync(':memory:')
      try {
        const rows = database.prepare(text).all()
        if (text.startsWith('SELECT 9 AS x')) {
          expect(rows).toEqual([{ x: 9, y: 1 }, { x: 0, y: 8 }])
        }
      } finally {
        database.close()
      }
    }
  })

  it('matches compound ORDER BY parameters by SQLite slot identity, never bound value', () => {
    const sql = frontend()
    const matching = sql.lowerQuery({
      sql: 'SELECT ?1 UNION ALL SELECT 2 ORDER BY ?1',
      parameters: [7n],
    })
    expect(matching.orderBy).toMatchObject([{
      expression: { kind: 'literal', value: { kind: 'int64', value: 1n } },
    }])

    for (const parameters of [[7n, 7n], [7n, 8n]] as const) {
      expect(() => sql.lowerQuery({
        sql: 'SELECT ?1 UNION ALL SELECT 2 ORDER BY ?2',
        parameters,
      })).toThrowError(expect.objectContaining({
        feature: 'compound ORDER BY term that does not match any result column',
      }))
    }
    expect(() => sql.lowerQuery({
      sql: 'SELECT ?1 UNION ALL SELECT 2 ORDER BY 7.0',
      parameters: [7n],
    })).toThrowError(expect.objectContaining({
      feature: 'compound ORDER BY term that does not match any result column',
    }))
  })

  it('resolves standard ORDER BY projection aliases and ordinals, including compounds', () => {
    const sql = frontend()
    const catalog = compileSchema(schema, manifest).catalog
    const ordered = sql.lowerQuery({
      sql: 'SELECT lower(owner) AS normalized, id AS account_id FROM accounts ORDER BY normalized DESC, 2 NULLS LAST',
    })
    expect(ordered.orderBy).toMatchObject([
      { expression: { kind: 'builtin', name: 'lower' }, direction: 'desc' },
      { expression: { kind: 'column', name: 'id' }, direction: 'asc', nulls: 'last' },
    ])
    expect(compileQuery(ordered, catalog).sql).toContain(
      'ORDER BY "lower"("accounts"."owner") DESC NULLS LAST, "accounts"."id" ASC NULLS LAST',
    )

    const compound = sql.lowerQuery({
      sql: 'SELECT owner AS name, id FROM accounts UNION ALL SELECT owner, id FROM accounts ORDER BY name NULLS LAST, 2 DESC LIMIT ?',
      parameters: [4n],
    })
    expect(compound.orderBy).toMatchObject([
      { expression: { kind: 'literal', value: { kind: 'int64', value: 1n } }, nulls: 'last' },
      { expression: { kind: 'literal', value: { kind: 'int64', value: 2n } }, direction: 'desc' },
    ])
    const compiled = compileQuery(compound, catalog)
    expect(compiled.sql).toContain('UNION ALL')
    expect(compiled.sql).toContain('ORDER BY 1 ASC NULLS LAST, 2 DESC NULLS LAST LIMIT 4')
  })

  it('lowers top-level INTERSECT/EXCEPT through the canonical compound IR', () => {
    const sql = frontend()
    const query = sql.lowerQuery({
      sql: 'SELECT id FROM accounts INTERSECT SELECT id FROM accounts EXCEPT SELECT id FROM accounts ORDER BY 1',
    })
    expect(query.compounds.map((compound) => compound.operator)).toEqual(['intersect', 'except'])
    const compiled = compileQuery(query, compileSchema(schema, manifest).catalog)
    expect(compiled.sql).toContain(' INTERSECT ')
    expect(compiled.sql).toContain(' EXCEPT ')
    expect(compiled.sql).toContain('ORDER BY 1 ASC NULLS FIRST')
  })

  it('preserves nested compounds and nested NULLS placement without rewriting SQL tokens', () => {
    const query = frontend().lowerQuery({
      sql: `
        SELECT nested.id
        FROM (
          SELECT id FROM accounts
          INTERSECT SELECT id FROM accounts
          EXCEPT SELECT id FROM accounts
          ORDER BY id DESC NULLS LAST
          LIMIT 3
        ) AS nested
        ORDER BY nested.id NULLS FIRST
      `,
    })
    const nested = query.from?.kind === 'subquery' ? query.from.query : undefined
    expect(nested?.compounds.map((compound) => compound.operator)).toEqual(['intersect', 'except'])
    expect(nested?.orderBy).toMatchObject([{ direction: 'desc', nulls: 'last' }])
    expect(query.orderBy).toMatchObject([{ direction: 'asc', nulls: 'first' }])
    const compiled = compileQuery(query, compileSchema(schema, manifest).catalog)
    expect(compiled.sql).toContain(' INTERSECT ')
    expect(compiled.sql).toContain(' EXCEPT ')
    expect(compiled.sql).toContain('DESC NULLS LAST LIMIT 3')
  })

  it('lowers recursive CTEs against their anchor-derived typed self scope', () => {
    const query = frontend().lowerQuery({
      sql: `
        WITH RECURSIVE ids(id) AS (
          SELECT 1
          UNION ALL
          SELECT id + 1 FROM ids WHERE id < 3
        )
        SELECT id FROM ids ORDER BY id
      `,
    })
    expect(query).toMatchObject({
      recursive: true,
      ctes: [{ name: 'ids', query: { compounds: [{ operator: 'union_all' }] } }],
    })
    expect(compileQuery(query, compileSchema(schema, manifest).catalog).sql).toContain(
      'WITH RECURSIVE "ids" ("id") AS',
    )

    const nullAnchor = frontend().lowerQuery({
      sql: `
        WITH RECURSIVE c(x) AS (
          SELECT NULL
          UNION ALL SELECT 1
          UNION ALL SELECT x + 1 FROM c WHERE x < 3
        )
        SELECT x FROM c ORDER BY x
      `,
    })
    expect(nullAnchor.ctes[0]?.query.compounds).toHaveLength(2)
    expect(compileQuery(nullAnchor, compileSchema(schema, manifest).catalog).sql).toContain(
      'WITH RECURSIVE "c" ("x") AS',
    )
  })

  it('resolves forward CTE references before same-named physical tables', () => {
    const shadowedSchema: SchemaManifest = {
      ...schema,
      name: 'forward-cte-shadowing',
      objects: [
        ...schema.objects,
        {
          kind: 'table', id: 20, name: 'later', declarationOrder: 1, withoutRowId: true,
          columns: [{ id: 21, name: 'physical_only', declarationOrder: 0, valueType: int }],
          constraints: [{ kind: 'primary_key', id: 22, name: 'later_pk', columnIds: [21] }],
        },
      ],
    }
    const query = new SqliteConsensusFrontend({
      schema: shadowedSchema,
      executionManifest: manifest,
    }).lowerQuery({
      sql: `
        WITH first AS (SELECT id FROM later),
             later(id) AS (SELECT id FROM accounts)
        SELECT id FROM first
      `,
    })
    expect(query.ctes.map((cte) => cte.name)).toEqual(['later', 'first'])
    expect(query.ctes[1]?.query.from).toMatchObject({ kind: 'cte', name: 'later' })
    expect(compileQuery(query, compileSchema(shadowedSchema, manifest).catalog).sql).toContain(
      'WITH "later" ("id") AS',
    )
  })

  it('lowers row-value comparisons and membership with SQLite null semantics intact', () => {
    const query = frontend().lowerQuery({
      sql: 'SELECT id FROM accounts WHERE (id, balance) = (?1, ?2) OR (id, balance) IN ((?3, ?4), (?5, ?6))',
      parameters: [1n, 10n, 2n, 20n, 3n, 30n],
    })
    expect(query.where).toMatchObject({
      kind: 'binary',
      operator: 'or',
      left: { operator: 'eq', left: { kind: 'row' }, right: { kind: 'row' } },
      right: { kind: 'membership', value: { kind: 'row' }, values: [{ kind: 'row' }, { kind: 'row' }] },
    })
    const compiled = compileQuery(query, compileSchema(schema, manifest).catalog)
    expect(compiled.sql).toContain('(("accounts"."id", "accounts"."balance") = (?1, ?2))')
    expect(compiled.sql).toContain('IN ((?3, ?4), (?5, ?6))')
  })

  it('lowers dynamic JSON path expressions and preserves JSON-valued extraction', () => {
    const jsonSchema: SchemaManifest = {
      ...schema,
      name: 'json-frontend',
      objects: [{
        kind: 'table', id: 300, name: 'documents', declarationOrder: 0, withoutRowId: true,
        columns: [
          { id: 301, name: 'id', declarationOrder: 0, valueType: int },
          { id: 302, name: 'document', declarationOrder: 1, valueType: json },
          { id: 303, name: 'path', declarationOrder: 2, valueType: text },
        ],
        constraints: [{ kind: 'primary_key', id: 304, name: 'documents_pk', columnIds: [301] }],
      }],
    }
    const sql = new SqliteConsensusFrontend({ schema: jsonSchema, executionManifest: manifest })
    const query = sql.lowerQuery({
      sql: 'SELECT json_extract(document, path) AS by_column, document -> :path AS by_parameter, json_type(document, path) AS kind FROM documents',
      parameters: { path: '$.owner' },
    })
    expect(query.projection.map((projection) => projection.expression)).toMatchObject([
      { kind: 'json', operation: 'extract', pathExpression: { kind: 'column', name: 'path' } },
      { kind: 'json', operation: 'extract', pathExpression: { kind: 'literal' } },
      { kind: 'json', operation: 'type', pathExpression: { kind: 'column', name: 'path' } },
    ])
    const compiled = compileQuery(query, compileSchema(jsonSchema, manifest).catalog)
    expect(compiled.sql).toContain('("documents"."document" -> "documents"."path")')
    expect(compiled.sql).toContain('json_type("documents"."document", "documents"."path")')
  })

  it('lowers named and inline windows, filters, frames, and precise supported built-ins', () => {
    const query = frontend().lowerQuery({
      sql: `
        SELECT
          row_number() OVER (ORDER BY owner NULLS LAST) AS row_index,
          rank() OVER owners AS owner_rank,
          dense_rank() OVER owners AS dense_owner_rank,
          count(*) FILTER (WHERE balance > 0) OVER owners AS positives,
          lag(balance, 1, 0) OVER (
            PARTITION BY owner ORDER BY id
            ROWS BETWEEN 1 PRECEDING AND CURRENT ROW
          ) AS previous_balance
        FROM accounts
        WINDOW owners AS (ORDER BY owner GROUPS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
      `,
    })
    expect(query.windows).toMatchObject([{
      name: 'owners',
      orderBy: [{ nulls: 'first' }],
      frame: { mode: 'groups', start: { type: 'unbounded_preceding' }, end: { type: 'current_row' } },
    }])
    expect(query.projection.map((projection) => projection.expression)).toMatchObject([
      { kind: 'window', operation: 'row_number' },
      { kind: 'window', operation: 'rank', window: 'owners' },
      { kind: 'window', operation: 'dense_rank', window: 'owners' },
      { kind: 'window', operation: 'count', filter: { kind: 'binary', operator: 'gt' } },
      { kind: 'window', operation: 'lag', window: { frame: { mode: 'rows' } } },
    ])
    const compiled = compileQuery(query, compileSchema(schema, manifest).catalog)
    expect(compiled.sql).toContain('ROW_NUMBER() OVER (ORDER BY "accounts"."owner" ASC NULLS LAST')
    expect(compiled.sql).toContain('COUNT(*) FILTER (WHERE ("accounts"."balance" > ?1)) OVER "owners"')
    // SQLite ignores frames on LAG. The compiler omits this inert frame before
    // adding deterministic tie terms, while retaining the aggregate window's frame.
    expect(compiled.sql).not.toContain('ROWS BETWEEN')
    expect(compiled.sql).toContain('GROUPS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW')

    expect(() => frontend().lowerQuery({
      sql: 'SELECT percent_rank() OVER (ORDER BY id) FROM accounts',
    })).toThrowError(expect.objectContaining({
      feature: expect.stringContaining('floating-point result profile'),
    }))
  })

  it('supports simple CASE, CTE column lists, and standard outer/cross join spellings', () => {
    const sql = frontend()
    const query = sql.lowerQuery({
      sql: `
        WITH picked(account_id, account_owner) AS (
          SELECT id, owner FROM accounts
        )
        SELECT CASE p.account_owner
          WHEN ?1 THEN ?2
          WHEN ?3 THEN ?4
          ELSE ?5
        END AS owner_rank
        FROM picked AS p
      `,
      parameters: ['alice', 1n, 'bob', 2n, 3n],
    })
    expect(query.ctes[0]?.query.projection.map((projection) => projection.name)).toEqual([
      'account_id',
      'account_owner',
    ])
    expect(query.projection[0]?.expression).toMatchObject({
      kind: 'conditional',
      branches: [
        { when: { kind: 'binary', operator: 'eq' } },
        { when: { kind: 'binary', operator: 'eq' } },
      ],
    })
    const compiled = compileQuery(query, compileSchema(schema, manifest).catalog)
    expect(compiled.sql).toContain('WITH "picked" ("account_id", "account_owner") AS')
    expect(compiled.sql).toContain('CASE WHEN')

    const joined = sql.lowerQuery({
      sql: 'SELECT a.id FROM accounts AS a LEFT OUTER JOIN accounts AS b ON a.id = b.id',
    })
    expect(compileQuery(joined, compileSchema(schema, manifest).catalog).sql).toContain(
      'LEFT JOIN "accounts" AS "b" ON ("a"."id" = "b"."id")',
    )

    const crossed = sql.lowerQuery({
      sql: 'SELECT a.id, b.id FROM accounts AS a CROSS JOIN accounts AS b',
    })
    expect(crossed.joins).toMatchObject([{ kind: 'cross' }])
    expect(compileQuery(crossed, compileSchema(schema, manifest).catalog).sql).toContain(
      'CROSS JOIN "accounts" AS "b"',
    )

    const constrainedCross = sql.lowerQuery({
      sql: 'SELECT a.id, b.id FROM accounts AS a CROSS JOIN accounts AS b ON a.id = b.id',
    })
    expect(constrainedCross.joins).toMatchObject([{
      kind: 'cross', on: { kind: 'binary', operator: 'eq' },
    }])

    const usingCross = sql.lowerQuery({
      sql: 'SELECT id FROM accounts AS a CROSS JOIN accounts AS b USING (id)',
    })
    expect(usingCross.joins).toMatchObject([{ kind: 'cross', using: ['id'] }])

    const unaliasedDerived = sql.lowerQuery({
      sql: 'SELECT id FROM (SELECT id FROM accounts)',
    })
    expect(unaliasedDerived.from).toMatchObject({
      kind: 'subquery',
      alias: '__chronolog_derived_1',
    })
    expect(compileQuery(unaliasedDerived, compileSchema(schema, manifest).catalog).sql).toContain(
      'AS "__chronolog_derived_1"',
    )
  })

  it('preserves parenthesized join grouping, aliases, qualifiers, and star visibility', () => {
    const sql = frontend()
    const catalog = compileSchema(schema, manifest).catalog
    const nestedText = `
      SELECT a.id AS a_id, b.id AS b_id, c.id AS c_id
      FROM accounts AS a
      LEFT JOIN (
        accounts AS b JOIN accounts AS c ON b.id = c.id AND c.id = 1
      ) ON a.id = b.id
      ORDER BY a.id
    `
    const nested = sql.lowerQuery({ sql: nestedText })
    expect(nested.joins[0]).toMatchObject({
      kind: 'left',
      relation: { kind: 'subquery', alias: '__chronolog_join_group_2' },
      on: {
        kind: 'binary',
        right: { kind: 'column', relation: '__chronolog_join_group_2' },
      },
    })
    expect(nested.projection.map((projection) => projection.expression)).toMatchObject([
      { kind: 'column', relation: 'a', name: 'id' },
      { kind: 'column', relation: '__chronolog_join_group_2' },
      { kind: 'column', relation: '__chronolog_join_group_2' },
    ])
    const compiledNested = compileQuery(nested, catalog).sql
    expect(compiledNested).toContain('LEFT JOIN (SELECT')
    expect(compiledNested).toContain('INNER JOIN "accounts" AS "c"')

    const qualifiedStars = sql.lowerQuery({
      sql: `
        SELECT b.*, c.*
        FROM accounts AS a LEFT JOIN (
          accounts AS b JOIN accounts AS c ON b.id = c.id
        ) ON a.id = b.id
      `,
    })
    expect(qualifiedStars.projection.map((projection) => projection.name)).toEqual([
      'id', 'balance', 'owner', 'id', 'balance', 'owner',
    ])
    expect(qualifiedStars.projection.every((projection) =>
      projection.expression.kind === 'column' &&
      projection.expression.relation === '__chronolog_join_group_2')).toBe(true)

    const aliasedText = `
      SELECT joined.id, joined.balance, joined.owner
      FROM accounts AS a LEFT JOIN (
        accounts AS b NATURAL JOIN accounts AS c
      ) AS joined ON a.id = joined.id
      ORDER BY a.id
    `
    const aliased = sql.lowerQuery({ sql: aliasedText })
    expect(aliased.projection.map((projection) => projection.name)).toEqual([
      'id', 'balance', 'owner',
    ])
    expect(aliased.projection.every((projection) =>
      projection.expression.kind === 'column' &&
      projection.expression.relation === 'joined')).toBe(true)
    expect(() => sql.lowerQuery({
      sql: `SELECT joined.* FROM (accounts AS b NATURAL JOIN accounts AS c) AS joined`,
    })).toThrowError(expect.objectContaining({ feature: 'unknown star qualifier joined' }))

    const database = new DatabaseSync(':memory:')
    try {
      database.exec(`
        CREATE TABLE accounts (id INTEGER PRIMARY KEY, balance INTEGER, owner TEXT);
        INSERT INTO accounts VALUES (1, 10, 'alice'), (2, 20, 'bob'), (3, 30, 'carol');
      `)
      expect(database.prepare(nestedText).all()).toEqual([
        { a_id: 1, b_id: 1, c_id: 1 },
        { a_id: 2, b_id: null, c_id: null },
        { a_id: 3, b_id: null, c_id: null },
      ])
      expect(database.prepare(aliasedText).all()).toHaveLength(3)
    } finally {
      database.close()
    }
  })

  it('lowers unconstrained, outer, NATURAL, and USING joins with SQLite merged-column semantics', () => {
    const sql = frontend()
    const catalog = compileSchema(schema, manifest).catalog
    const inner = sql.lowerQuery({
      sql: 'SELECT a.id, b.id FROM accounts AS a JOIN accounts AS b',
    })
    const left = sql.lowerQuery({
      sql: 'SELECT a.id, b.id FROM accounts AS a LEFT JOIN accounts AS b',
    })
    expect(compileQuery(inner, catalog).sql).toContain('INNER JOIN "accounts" AS "b"')
    expect(compileQuery(left, catalog).sql).toContain('LEFT JOIN "accounts" AS "b"')
    expect(inner.joins[0]).not.toHaveProperty('on')
    expect(left.joins[0]).not.toHaveProperty('on')

    const ordinaryIdentifier = sql.lowerQuery({
      sql: 'SELECT a.id AS natural FROM accounts a JOIN accounts other',
    })
    expect(ordinaryIdentifier.projection[0]).toMatchObject({
      name: 'natural', expression: { kind: 'column', name: 'id' },
    })

    const natural = sql.lowerQuery({
      sql: 'SELECT id FROM accounts NATURAL JOIN accounts AS other',
    })
    expect(natural.joins[0]).toMatchObject({
      kind: 'inner', using: ['id', 'balance', 'owner'],
    })
    expect(natural.projection[0]?.expression).toMatchObject({ kind: 'column', name: 'id' })

    const using = sql.lowerQuery({
      sql: 'SELECT * FROM accounts AS a FULL OUTER JOIN accounts AS b USING (id)',
    })
    expect(using.joins[0]).toMatchObject({ kind: 'full', using: ['id'] })
    expect(using.projection.map((projection) => projection.name)).toEqual([
      'id', 'balance', 'owner', 'balance', 'owner',
    ])
    expect(using.projection[0]?.expression).toMatchObject({ kind: 'builtin', name: 'coalesce' })
    expect(compileQuery(using, catalog).sql).toContain('FULL JOIN "accounts" AS "b" USING ("id")')

    const right = sql.lowerQuery({
      sql: 'SELECT id FROM accounts AS a RIGHT JOIN accounts AS b USING (id)',
    })
    expect(right.joins[0]).toMatchObject({ kind: 'right', using: ['id'] })
    expect(right.projection[0]?.expression).toMatchObject({ kind: 'column', relation: 'b', name: 'id' })
  })

  it('accepts deterministic SQLite expression spellings omitted by the parser grammar', () => {
    const sql = frontend()
    const query = sql.lowerQuery({
      sql: `
        SELECT ALL
          +balance AS positive,
          0xffffffffffffffff AS negative_one,
          owner ISNULL AS absent,
          owner NOTNULL AS present,
          CAST(balance AS BIGINT) AS wide,
          CAST(balance AS VARCHAR(10)) AS text_balance
        FROM accounts
      `,
    })
    expect(query.projection.map((projection) => projection.expression)).toMatchObject([
      { kind: 'column', name: 'balance' },
      { kind: 'literal', value: { kind: 'int64', value: -1n } },
      { kind: 'unary', operator: 'is_null' },
      { kind: 'unary', operator: 'is_not_null' },
      { kind: 'cast', target: { kind: 'int64' } },
      { kind: 'cast', target: { kind: 'text', collation: 'binary' } },
    ])
    const compiled = compileQuery(query, compileSchema(schema, manifest).catalog)
    expect(compiled.parameters[0]?.source).toEqual({
      kind: 'literal',
      value: { kind: 'int64', value: -1n },
    })
    expect(compiled.sql).toContain('CAST("accounts"."balance" AS TEXT)')

    const notNull = sql.lowerQuery({
      sql: 'SELECT owner NOT NULL AS present FROM accounts',
    })
    expect(notNull.projection[0]?.expression).toMatchObject({ kind: 'unary', operator: 'is_not_null' })
  })

  it('uses SQLite rightmost-wins semantics for repeated UPDATE targets', () => {
    const mutation = frontend().lowerCommand({
      sql: 'UPDATE accounts SET balance = ?, balance = ? WHERE id = ?',
      parameters: [10n, 20n, 7n],
    })
    const compiled = compileMutation(mutation, compileSchema(schema, manifest).catalog)
    expect(compiled.sql).toBe(
      'UPDATE "accounts" AS "accounts" SET "balance" = ?1 WHERE ("accounts"."id" = ?2)',
    )
    expect(compiled.parameters.map((parameter) => parameter.source)).toEqual([
      { kind: 'literal', value: { kind: 'int64', value: 20n } },
      { kind: 'literal', value: { kind: 'int64', value: 7n } },
    ])
  })

  it('preserves DISTINCT as SQL semantics before nesting, ordering, and pagination', () => {
    const sql = frontend()
    const query = sql.lowerQuery({
      sql: 'SELECT distinct_owner.owner FROM (SELECT DISTINCT owner FROM accounts) AS distinct_owner',
    })
    expect(query.from).toMatchObject({
      kind: 'subquery',
      query: { distinct: true },
    })
    expect(decodeQuery(encodeQuery(query)).from).toMatchObject({
      kind: 'subquery',
      query: { distinct: true },
    })
    expect(compileQuery(query, compileSchema(schema, manifest).catalog).sql).toContain(
      'FROM (SELECT DISTINCT "accounts"."owner"',
    )

    const paged = sql.lowerQuery({
      sql: 'SELECT DISTINCT id FROM accounts ORDER BY id NULLS LAST LIMIT ? OFFSET ?',
      parameters: [2n, 1n],
    })
    expect(paged).toMatchObject({
      distinct: true,
      page: { limit: 2, offset: 1 },
      orderBy: [{ direction: 'asc', nulls: 'last' }],
    })
    expect(compileQuery(paged, compileSchema(schema, manifest).catalog).sql).toContain(
      'SELECT DISTINCT "accounts"."id"',
    )
  })

  it('lowers BETWEEN and SQLite LIKE while preserving three-valued boolean semantics', () => {
    const sql = frontend()
    const query = sql.lowerQuery({
      sql: 'SELECT id FROM accounts WHERE balance BETWEEN ?1 AND ?2 AND owner NOT LIKE ?3 ESCAPE ?4',
      parameters: [10n, 20n, 'sys!_%', '!'],
    })
    expect(query.where).toMatchObject({
      kind: 'binary',
      operator: 'and',
      left: {
        kind: 'binary',
        operator: 'and',
        left: { operator: 'gte' },
        right: { operator: 'lte' },
      },
      right: { kind: 'binary', operator: 'not_like', escape: { kind: 'literal' } },
    })
    expect(decodeQuery(encodeQuery(query)).where).toMatchObject({
      right: { kind: 'binary', operator: 'not_like', escape: { kind: 'literal' } },
    })
    const compiled = compileQuery(query, compileSchema(schema, manifest).catalog)
    expect(compiled.sql).toContain('("accounts"."owner" NOT LIKE ?3 ESCAPE ?4)')

    const negated = sql.lowerQuery({
      sql: 'SELECT id FROM accounts WHERE balance NOT BETWEEN ? AND ?',
      parameters: [10n, 20n],
    })
    expect(negated.where).toMatchObject({ kind: 'unary', operator: 'not' })

    const distinctFrom = sql.lowerQuery({
      sql: 'SELECT id FROM accounts WHERE owner IS DISTINCT FROM ?1 OR owner IS NOT DISTINCT FROM ?2',
      parameters: ['alice', 'bob'],
    })
    expect(distinctFrom.where).toMatchObject({
      kind: 'binary',
      operator: 'or',
      left: { kind: 'binary', operator: 'is_not' },
      right: { kind: 'binary', operator: 'is' },
    })
  })

  it('lowers SQLite GLOB/NOT GLOB with binary text and bound-pattern semantics', () => {
    const sql = frontend()
    const query = sql.lowerQuery({
      sql: 'SELECT owner GLOB ?1 AS matches, owner NOT GLOB ?2 AS excluded, NULL GLOB ?3 AS unknown FROM accounts',
      parameters: ['a*', 'b*', 'c*'],
    })
    expect(query.projection.map((projection) => projection.expression)).toMatchObject([
      { kind: 'binary', operator: 'glob' },
      { kind: 'binary', operator: 'not_glob' },
      { kind: 'binary', operator: 'glob' },
    ])
    expect(decodeQuery(encodeQuery(query)).projection.map((projection) => projection.expression)).toMatchObject([
      { kind: 'binary', operator: 'glob' },
      { kind: 'binary', operator: 'not_glob' },
      { kind: 'binary', operator: 'glob' },
    ])
    const compiled = compileQuery(query, compileSchema(schema, manifest).catalog)
    expect(compiled.sql).toContain('("accounts"."owner" GLOB ?1)')
    expect(compiled.sql).toContain('("accounts"."owner" NOT GLOB ?2)')
    expect(compiled.columns.map((column) => column.valueType)).toEqual([
      { logical: { kind: 'boolean' }, nullable: false },
      { logical: { kind: 'boolean' }, nullable: false },
      { logical: { kind: 'boolean' }, nullable: true },
    ])

    expect(() => sql.lowerQuery({ sql: "SELECT balance GLOB '1' FROM accounts" })).toThrowError(
      expect.objectContaining({ feature: 'IR_TEXT_OPERAND_REQUIRED' }),
    )
    expect(() => sql.lowerQuery({ sql: "SELECT owner NOT RLIKE 'a*' FROM accounts" })).toThrowError(
      expect.objectContaining({ feature: 'RLIKE' }),
    )
  })

  it('lowers SQLite BINARY, NOCASE, and RTRIM collations explicitly', () => {
    const sql = frontend()
    const query = sql.lowerQuery({
      sql: 'SELECT owner COLLATE BINARY AS owner, owner COLLATE NOCASE AS folded, owner COLLATE RTRIM AS trimmed FROM accounts WHERE owner COLLATE binary LIKE ?',
      parameters: ['a%'],
    })
    const compiled = compileQuery(query, compileSchema(schema, manifest).catalog)
    expect(compiled.sql).toContain('(("accounts"."owner" COLLATE BINARY) LIKE ?1)')
    expect(query.projection.map((projection) => projection.expression)).toMatchObject([
      { kind: 'collate', collation: 'binary' },
      { kind: 'collate', collation: 'nocase' },
      { kind: 'collate', collation: 'rtrim' },
    ])
    expect(compiled.sql).toContain('COLLATE NOCASE')
    expect(compiled.sql).toContain('COLLATE RTRIM')
  })

  it('binds numbered slots lexically and canonicalizes parameterized LIMIT/OFFSET values', () => {
    const sql = frontend()
    const query = sql.lowerQuery({
      sql: 'SELECT ?2 AS second, ?1 AS first FROM accounts WHERE id = ?3 ORDER BY id DESC NULLS FIRST LIMIT ?4 OFFSET ?5',
      parameters: [11n, 22n, 7n, 2n, 1n],
    })
    expect(query.projection.map((projection) => projection.expression)).toMatchObject([
      { kind: 'literal', value: { kind: 'int64', value: 22n } },
      { kind: 'literal', value: { kind: 'int64', value: 11n } },
    ])
    expect(query.page).toEqual({ limit: 2, offset: 1 })
    expect(query.orderBy[0]).toMatchObject({ direction: 'desc', nulls: 'first' })
    const compiled = compileQuery(query, compileSchema(schema, manifest).catalog)
    expect(compiled.sql).toContain('ORDER BY "accounts"."id" DESC NULLS FIRST')
    expect(compiled.sql).toContain('LIMIT 2 OFFSET 1')

    const traversal = sql.lowerQuery({
      sql: 'SELECT ? AS outer_value FROM (SELECT ? AS inner_value) AS nested',
      parameters: [1n, 2n],
    })
    expect(traversal.projection[0]?.expression).toMatchObject({ value: { kind: 'int64', value: 1n } })
    expect(traversal.from).toMatchObject({
      kind: 'subquery',
      query: { projection: [{ expression: { value: { kind: 'int64', value: 2n } } }] },
    })

    const partialOrder = sql.lowerQuery({
      sql: 'SELECT id FROM accounts ORDER BY owner LIMIT ?',
      parameters: [3n],
    })
    expect(partialOrder.orderBy).toHaveLength(1)
    expect(compileQuery(partialOrder, compileSchema(schema, manifest).catalog).sql).toContain(
      'ORDER BY "accounts"."owner" ASC NULLS FIRST, 1 ASC NULLS FIRST LIMIT 3',
    )

    const implicitOrder = sql.lowerQuery({
      sql: 'SELECT id FROM accounts LIMIT :limit',
      parameters: { limit: 3n },
    })
    expect(implicitOrder.orderBy).toHaveLength(0)
    expect(compileQuery(implicitOrder, compileSchema(schema, manifest).catalog).sql).toContain(
      'ORDER BY 1 ASC NULLS FIRST LIMIT 3',
    )

    const quotedQuestion = sql.lowerQuery({
      sql: "SELECT '?2 NULLS LAST' AS literal, ?1 AS bound /* ?3 NULLS FIRST */",
      parameters: ['value'],
    })
    expect(quotedQuestion.projection[0]?.expression).toMatchObject({
      value: { kind: 'text' },
    })
    expect(quotedQuestion.projection[1]?.expression).toMatchObject({
      value: { kind: 'text' },
    })

    const sparseNumbered = sql.lowerQuery({ sql: 'SELECT ?2 AS value', parameters: [0n, 9n] })
    expect(sparseNumbered.projection[0]?.expression).toMatchObject({
      value: { kind: 'int64', value: 9n },
    })

    const nextAfterNumbered = sql.lowerQuery({
      sql: 'SELECT ?2 AS second, ? AS third, ?1 AS first',
      parameters: [1n, 2n, 3n],
    })
    expect(nextAfterNumbered.projection.map((projection) => projection.expression)).toMatchObject([
      { value: { kind: 'int64', value: 2n } },
      { value: { kind: 'int64', value: 3n } },
      { value: { kind: 'int64', value: 1n } },
    ])

    const exactNamed = sql.lowerQuery({
      sql: 'SELECT :x AS colon, @x AS at_name, $x AS dollar',
      parameters: { ':x': 1n, '@x': 2n, '$x': 3n },
    })
    expect(exactNamed.projection.map((projection) => projection.expression)).toMatchObject([
      { value: { kind: 'int64', value: 1n } },
      { value: { kind: 'int64', value: 2n } },
      { value: { kind: 'int64', value: 3n } },
    ])
    expect(() => sql.lowerQuery({
      sql: 'SELECT :x, @x', parameters: { x: 1n },
    })).toThrowError(expect.objectContaining({ code: 'SQL_PARAMETER_MODE_MISMATCH' }))

    const aliasedOrder = sql.lowerQuery({
      sql: 'SELECT balance AS amount, id FROM accounts ORDER BY amount DESC, 2 ASC',
    })
    expect(compileQuery(aliasedOrder, compileSchema(schema, manifest).catalog).sql).toContain(
      'ORDER BY "accounts"."balance" DESC NULLS LAST, "accounts"."id" ASC NULLS FIRST',
    )

    const compoundAliasOrder = sql.lowerQuery({
      sql: 'SELECT id AS value FROM accounts UNION ALL SELECT ? AS value ORDER BY value DESC',
      parameters: [9n],
    })
    expect(compileQuery(compoundAliasOrder, compileSchema(schema, manifest).catalog).sql).toContain(
      'ORDER BY 1 DESC NULLS LAST',
    )
  })

  it('supports exact COUNT/MIN/MAX aggregate syntax and fails closed on unsafe variants', () => {
    const sql = frontend()
    const query = sql.lowerQuery({
      sql: 'SELECT count(*) AS rows, count() AS rows_zero_arg, count(DISTINCT owner) AS owners, min(balance) AS minimum, max(balance) AS maximum FROM accounts',
    })
    expect(query.projection.map((projection) => projection.expression)).toMatchObject([
      { kind: 'aggregate', operation: 'count', distinct: false },
      { kind: 'aggregate', operation: 'count', distinct: false },
      { kind: 'aggregate', operation: 'count', distinct: true },
      { kind: 'aggregate', operation: 'min', distinct: false },
      { kind: 'aggregate', operation: 'max', distinct: false },
    ])
    expect(compileQuery(query, compileSchema(schema, manifest).catalog).sql).toContain(
      'COUNT(*) AS',
    )
    const filtered = sql.lowerQuery({
      sql: 'SELECT count(*) FILTER (WHERE balance > ?1) AS positive, min(balance) FILTER (WHERE owner LIKE ?2) AS minimum FROM accounts',
      parameters: [0n, 'a%'],
    })
    expect(filtered.projection.map((projection) => projection.expression)).toMatchObject([
      { kind: 'aggregate', operation: 'count', filter: { kind: 'binary', operator: 'gt' } },
      { kind: 'aggregate', operation: 'min', filter: { kind: 'binary', operator: 'like' } },
    ])
    expect(compileQuery(filtered, compileSchema(schema, manifest).catalog).sql).toContain(
      'COUNT(*) FILTER (WHERE ("accounts"."balance" > ?1))',
    )
    const grouped = sql.lowerQuery({
      sql: 'SELECT owner AS owner_key, count(*) AS rows FROM accounts GROUP BY owner_key, 1',
    })
    expect(grouped.groupBy).toMatchObject([
      { kind: 'column', name: 'owner' },
      { kind: 'column', name: 'owner' },
    ])
    expect(compileQuery(grouped, compileSchema(schema, manifest).catalog).sql).toContain(
      'GROUP BY "accounts"."owner", "accounts"."owner"',
    )
    const booleanAggregates = sql.lowerQuery({
      sql: 'SELECT every(balance > 0) FILTER (WHERE owner IS NOT NULL) AS all_positive, bool_or(balance = 0) FILTER (WHERE owner IS NOT NULL) AS any_zero, some(balance > 0) AS some_positive FROM accounts',
    })
    expect(booleanAggregates.projection.map((projection) => projection.expression)).toMatchObject([
      { kind: 'aggregate', operation: 'every', filter: { kind: 'unary', operator: 'is_not_null' } },
      { kind: 'aggregate', operation: 'any', filter: { kind: 'unary', operator: 'is_not_null' } },
      { kind: 'aggregate', operation: 'any' },
    ])
    expect(compileQuery(booleanAggregates, compileSchema(schema, manifest).catalog).sql).toContain(
      'MIN(("accounts"."balance" > ?1))',
    )
    for (const input of [
      { sql: 'SELECT sum(balance) FROM accounts' },
      { sql: 'SELECT count(*) FILTER (WHERE balance) FROM accounts' },
      { sql: 'SELECT id FROM accounts ORDER BY id NULLS LAST LIMIT ?', parameters: [-1n] },
      { sql: 'SELECT ?2', parameters: [1n, 2n, 3n] },
      { sql: 'SELECT id FROM accounts WHERE id BETWEEN ? AND ?', parameters: [1n] },
    ]) {
      expect(() => sql.lowerQuery(input)).toThrow(SqlFrontendError)
    }
  })

  it('fails closed for uncompiled features, parameter mistakes, and unproven ordering', () => {
    const sql = frontend()
    for (const input of [
      { sql: 'SELECT id FROM accounts; SELECT id FROM accounts' },
      { sql: 'SELECT id FROM accounts', parameters: [1n] },
    ]) {
      expect(() => sql.lowerQuery(input)).toThrow(SqlFrontendError)
    }
  })

  it('lowers checked integer arithmetic and SQLite bitwise operators', () => {
    const query = frontend().lowerQuery({
      sql: 'SELECT -balance AS negated, balance + ? AS added, balance / 2 AS divided, balance % 2 AS remainder, balance & 3 AS masked, balance | 3 AS combined, balance << 1 AS shifted FROM accounts',
      parameters: [1n],
    })
    expect(query.projection.map((projection) => projection.expression)).toMatchObject([
      { kind: 'unary', operator: 'negate' },
      { kind: 'binary', operator: 'add' },
      { kind: 'binary', operator: 'divide' },
      { kind: 'binary', operator: 'modulo' },
      { kind: 'binary', operator: 'bit_and' },
      { kind: 'binary', operator: 'bit_or' },
      { kind: 'binary', operator: 'shift_left' },
    ])
    const compiled = compileQuery(query, compileSchema(schema, manifest).catalog)
    expect(compiled.sql).toContain("typeof((\"accounts\".\"balance\" + ?1)) <> 'integer'")
    expect(compiled.sql).toContain('("accounts"."balance" & ?4)')
  })

  it('keeps preconditions mandatory in the canonical program wrapper', () => {
    const sql = frontend()
    const mutation = sql.lowerCommand({
      sql: 'UPDATE accounts SET owner = ? WHERE id = ?',
      parameters: ['alice', 1n],
    })
    expect(() => sql.program([], [mutation])).toThrowError(
      expect.objectContaining({ code: 'SQL_PRECONDITION_REQUIRED' }),
    )
    const assertion = sql.lowerAssertion({ sql: 'SELECT ? = ? AS ok', parameters: [1n, 1n] })
    expect(sql.program([assertion], [mutation]).preconditions).toHaveLength(1)
  })

  it('plugs compiled SQL into observe/update while the client still requires an expectation', async () => {
    const sql = frontend()
    const query = defineLoweredQuery(sql.lowerQuery({
      sql: 'SELECT balance FROM accounts WHERE id = ?',
      parameters: [7n],
    }), {
      schemaDigest: 'schema-1',
      executionManifestDigest: 'manifest-1',
      decodeResult: (result) => result.rows,
    })
    const mutation = defineLoweredMutation(sql.lowerCommand({
      sql: 'UPDATE accounts SET owner = ? WHERE id = ?',
      parameters: ['bob', 7n],
    }))
    const calls: string[] = []
    const client = clientFor(service({
      beginDraft: async () => beginResponse(),
      observeIr: async (request) => {
        calls.push('observe')
        return observedResult(request.queryIr)
      },
      addExpectation: async () => { calls.push('expect'); return draftResponse(1, 0) },
      addMutationIr: async () => { calls.push('update'); return draftResponse(1, 1) },
      validateDraft: async () => { calls.push('validate'); return draftResponse(1, 1) },
      publishDraft: async () => { calls.push('publish'); return publication() },
    }))

    await expect(client.transaction((draft) => {
      draft.mutate(mutation)
    })).rejects.toThrow('requires a precondition')

    await expect(client.transaction(async (draft) => {
      const observed = await draft.observe(query)
      draft.expect(observed)
      draft.mutate(mutation)
    })).resolves.toMatchObject({ transactionId: 'tx-1' })
    expect(calls).toEqual(['update', 'observe', 'expect', 'update', 'validate', 'publish'])
  })
})

function revision() {
  return {
    groupId: 'group-1', eventSetRevision: '5', materializedRevision: '5', publishedOrderLength: '5',
    schemaDigest: 'schema-1', executionManifestDigest: 'manifest-1', replaying: false,
  }
}

function beginResponse() {
  return {
    draftId: 'draft-1', pinnedRevision: revision(), schemaDigest: 'schema-1',
    executionManifestDigest: 'manifest-1', reservedAuthorTimestampMs: '100', transactionNonce: 'AA',
    expiresAt: 'later',
  }
}

function draftResponse(preconditionCount: number, mutationCount: number) {
  return { draftId: 'draft-1', draftRevision: '1', preconditionCount, mutationCount, diagnostics: [], expiresAt: 'later' }
}

function publication() {
  return {
    transactionId: 'tx-1', candidateDigest: 'candidate-1', authorTimestampMs: '100',
    transactionNonce: 'AA', schemaDigest: 'schema-1', executionManifestDigest: 'manifest-1',
    durableLocalAppend: true as const, publishedAt: 'later',
  }
}

function observedResult(encodedQuery: string) {
  const query = decodeQuery(fromBase64Url(encodedQuery))
  const projection = query.projection[0]!
  const result: CanonicalQueryResult = {
    resultMode: query.resultMode,
    columns: [{ id: projection.id, name: projection.name, valueType: int }],
    rows: [[{ kind: 'int64', value: 20n }]],
  }
  return {
    observationId: 'observation-1', observationToken: 'token-1', revision: revision(),
    queryDigest: 'query-1', dependsOnContext: [],
    schema: [{ id: projection.id, name: projection.name, logicalType: 'int64' as const, nullable: false }],
    resultMode: query.resultMode.kind,
    canonicalResult: toBase64Url(encodeCanonicalQueryResult(result)),
    resultDigest: 'result-1', displayRows: [[{ kind: 'int64' as const, value: '20' }]],
    displayTruncated: false,
  }
}

function service(overrides: Partial<ChronologRpcService>): ChronologRpcService {
  const missing = async () => { throw new Error('not implemented in test') }
  const missingStream = async function* () { throw new Error('not implemented in test') }
  return {
    getStatus: missing, streamStatus: missingStream, executeIr: missing, liveIr: missingStream, localSql: missing,
    beginDraft: missing, observeIr: missing, addAssertionIr: missing, addExpectation: missing,
    addMutationIr: missing, validateDraft: missing, rebaseDraft: missing,
    cancelDraft: async (request) => ({ draftId: request.draftId, cancelled: true }), publishDraft: missing,
    getOutcome: missing, streamOutcome: missingStream, getSettlementEvidence: missing,
    streamSettlementEvidence: missingStream, getValidatorWatermark: missing, getReplicationStatus: missing,
    streamReplicationStatus: missingStream, ...overrides,
  }
}

function clientFor(rpcService: ChronologRpcService): ChronologClient {
  let request = 0
  return new ChronologClient({
    groupId: 'group-1',
    bindings: { schemaDigest: 'schema-1', executionManifestDigest: 'manifest-1' },
    transport: new InProcessRpcTransport(rpcService),
    requestId: () => `request-${++request}`,
  })
}
