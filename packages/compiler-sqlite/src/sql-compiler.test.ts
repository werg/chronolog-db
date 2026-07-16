import { describe, expect, it } from 'vitest'

import {
  compileSqlProgram,
  compileSqlStatement,
  completeOrderedResultSql,
  orderedSqlBindingValues,
  type SqlCompilerError,
} from './sql-compiler.js'
import { createCoreExecutionManifest } from './manifest.js'

describe('deterministic SQL compiler', () => {
  it('does not let the core manifest advertise unavailable extension profiles', () => {
    const engineDigest = new Uint8Array(32)
    expect(createCoreExecutionManifest({ profile: 'test', engineDigest }).features).toEqual({
      decimal: true, json: true, vector: true, fts: false, spatial: false, wasm: false,
    })
    expect(() => createCoreExecutionManifest({
      profile: 'test', engineDigest, features: { fts: true },
    })).toThrowError(expect.objectContaining({ code: 'EXECUTION_FEATURE_UNAVAILABLE' }))
  })

  it('preserves exact source and SQLite parameter numbering', () => {
    const source = {
      sql: 'UPDATE accounts SET value = ?2 WHERE id = :id AND shard = ?',
      bindings: [
        { parameter: { kind: 'index' as const, index: 2 }, value: { kind: 'text' as const, utf8: new TextEncoder().encode('next') } },
        { parameter: { kind: 'name' as const, name: ':id' }, value: { kind: 'int64' as const, value: 7n } },
        { parameter: { kind: 'index' as const, index: 4 }, value: { kind: 'int64' as const, value: 3n } },
      ],
    }
    const compiled = compileSqlStatement(source, 'body')
    expect(compiled.source.sql).toBe(source.sql)
    expect(compiled.maximumParameterIndex).toBe(4)
    expect(orderedSqlBindingValues(compiled).map((value) => value.kind)).toEqual(['null', 'text', 'int64', 'int64'])
  })

  it('accepts sequential DDL, DML, SELECT, and RETURNING statement classes', () => {
    const compiled = compileSqlProgram({
      version: 1,
      preconditions: [{ id: 1, query: { sql: 'SELECT 1', bindings: [] }, resultMode: 'scalar', expectation: { kind: 'assert_true' } }],
      body: [
        { sql: 'CREATE TABLE accounts (id INTEGER PRIMARY KEY, value TEXT) STRICT', bindings: [] },
        { sql: 'INSERT INTO accounts VALUES (1, \'one\') RETURNING id', bindings: [] },
        { sql: 'SELECT id FROM accounts ORDER BY id', bindings: [] },
      ],
    })
    expect(compiled.body.map((item) => item.statementClass)).toEqual(['schema', 'insert', 'read'])
    expect(compiled.body[1]?.resultMode).toBe('multiset')
    expect(compiled.body[2]?.resultMode).toBe('ordered')
  })

  it('admits row-choice forms only with a syntactic at-most-one-row proof', () => {
    const statements = [
      'SELECT (SELECT 1 WHERE 1) LIMIT 1',
      "INSERT INTO accounts (id, value) SELECT 1, 'one' WHERE 1",
      "CREATE TABLE singleton_copy AS SELECT 1 AS id, 'one' AS value",
      "UPDATE accounts SET value = source.value FROM (SELECT 'next' AS value) AS source",
      "UPDATE OR ABORT accounts SET value = 'next' WHERE id = 1",
    ]
    expect(statements.map((sql) => compileSqlStatement({ sql, bindings: [] }, 'body').statementClass)).toEqual([
      'read', 'insert', 'schema', 'update', 'update',
    ])
  })

  it('admits representative- and peer-stable aggregate, compound, and window shapes', () => {
    const statements = [
      'SELECT DISTINCT typeof(value) FROM accounts',
      'SELECT typeof(value), count(*) FROM accounts GROUP BY typeof(value)',
      'SELECT min(typeof(value)), max(typeof(value)) FROM accounts',
      'SELECT typeof(value) FROM accounts UNION SELECT typeof(value) FROM archived_accounts',
      'SELECT rank() OVER (ORDER BY value), value FROM accounts',
      'SELECT dense_rank() OVER (ORDER BY value), value FROM accounts',
      'SELECT group_concat(value ORDER BY value) FROM accounts',
    ]
    expect(statements.map((sql) => compileSqlStatement({ sql, bindings: [] }, 'body').statementClass)).toEqual(
      Array.from({ length: statements.length }, () => 'read'),
    )
  })

  it('adds binary result-column ties after authored outer ordering', () => {
    const compiled = compileSqlStatement({
      sql: 'SELECT id, name FROM accounts ORDER BY name COLLATE NOCASE DESC NULLS LAST LIMIT 5',
      bindings: [],
    }, 'precondition')
    expect(completeOrderedResultSql(compiled, 2)).toBe(
      'SELECT id, name FROM accounts ORDER BY name COLLATE NOCASE DESC NULLS LAST, 1 COLLATE BINARY, 2 COLLATE BINARY LIMIT 5',
    )
  })

  it('lowers ordered mutation syntax into private frozen-rowid operations', () => {
    const compiled = compileSqlStatement({
      sql: 'UPDATE accounts SET value = ? WHERE active = ? RETURNING id ORDER BY score DESC LIMIT ? OFFSET ?',
      bindings: [
        { parameter: { kind: 'index', index: 1 }, value: { kind: 'text', utf8: new TextEncoder().encode('next') } },
        { parameter: { kind: 'index', index: 2 }, value: { kind: 'int64', value: 1n } },
        { parameter: { kind: 'index', index: 3 }, value: { kind: 'int64', value: 2n } },
        { parameter: { kind: 'index', index: 4 }, value: { kind: 'int64', value: 1n } },
      ],
    }, 'body')
    expect(compiled.orderedMutation?.selectionSqlTemplate).toBe(
      'SELECT __chronolog_ordered_identity_columns__ FROM "accounts" WHERE active = ?2 ORDER BY score DESC, __chronolog_ordered_identity_order__ LIMIT ?3 OFFSET ?4',
    )
    expect(compiled.orderedMutation?.selectionMaximumParameterIndex).toBe(4)
    expect(compiled.orderedMutation?.mutationSqlTemplate).toBe(
      'UPDATE accounts SET value = ?1 WHERE __chronolog_ordered_target_predicate__ RETURNING id',
    )
  })

  it('preserves SQLite named-parameter tokens in ordered mutations', () => {
    const unicode = compileSqlStatement({
      sql: 'UPDATE accounts SET value = :nächster WHERE active = 1 ORDER BY score LIMIT 1',
      bindings: [{
        parameter: { kind: 'name', name: ':nächster' },
        value: { kind: 'text', utf8: new TextEncoder().encode('next') },
      }],
    }, 'body')
    expect(unicode.maximumParameterIndex).toBe(1)
    expect(unicode.orderedMutation?.selectionMaximumParameterIndex).toBe(0)
    expect(unicode.orderedMutation?.mutationSqlTemplate).toContain('SET value = ?1')

    const tcl = compileSqlStatement({
      sql: 'DELETE FROM accounts WHERE owner = $tenant::scope(primary) ORDER BY score LIMIT 1',
      bindings: [{
        parameter: { kind: 'name', name: '$tenant::scope(primary)' },
        value: { kind: 'int64', value: 7n },
      }],
    }, 'body')
    expect(tcl.parameters).toEqual([{
      index: 1,
      names: ['$tenant::scope(primary)'],
      referenced: true,
    }])
    expect(tcl.orderedMutation?.selectionSqlTemplate).toContain('owner = ?1')
    expect(tcl.orderedMutation?.selectionMaximumParameterIndex).toBe(1)
  })

  it.each([
    ['BEGIN', 'SQL_STATEMENT_PROHIBITED'],
    ['SELECT random()', 'SQL_FUNCTION_TEMPORARILY_GATED'],
    ["SELECT datetime('now')", 'SQL_AMBIENT_TIME_PROHIBITED'],
    ["SELECT datetime(?)", 'SQL_AMBIENT_TIME_PROHIBITED'],
    ['SELECT (SELECT id FROM accounts)', 'SQL_SCALAR_SUBQUERY_TEMPORARILY_GATED'],
    ['SELECT id FROM accounts LIMIT 1', 'SQL_UNORDERED_LIMIT_TEMPORARILY_GATED'],
    ['INSERT INTO accounts SELECT * FROM archived_accounts', 'SQL_INSERT_SELECT_TEMPORARILY_GATED'],
    ['UPDATE accounts SET value = source.value FROM source WHERE source.id = accounts.id', 'SQL_ORDER_SENSITIVE_UPDATE_TEMPORARILY_GATED'],
    ['CREATE TABLE copied AS SELECT id FROM accounts', 'SQL_CREATE_TABLE_AS_SELECT_TEMPORARILY_GATED'],
    ["UPDATE OR REPLACE accounts SET value = 'next'", 'SQL_ORDER_SENSITIVE_UPDATE_TEMPORARILY_GATED'],
    ['SELECT DISTINCT value FROM accounts', 'SQL_CANONICAL_REPRESENTATIVE_TEMPORARILY_GATED'],
    ['SELECT value, id FROM accounts GROUP BY value', 'SQL_CANONICAL_REPRESENTATIVE_TEMPORARILY_GATED'],
    ['SELECT min(value) FROM accounts', 'SQL_CANONICAL_REPRESENTATIVE_TEMPORARILY_GATED'],
    ['SELECT value FROM accounts UNION SELECT value FROM archived_accounts', 'SQL_CANONICAL_REPRESENTATIVE_TEMPORARILY_GATED'],
    ['SELECT row_number() OVER (ORDER BY value), value FROM accounts', 'SQL_WINDOW_TEMPORARILY_GATED'],
    ['SELECT group_concat(value ORDER BY id) FROM accounts', 'SQL_FUNCTION_TEMPORARILY_GATED'],
    ['SELECT value COLLATE application_custom FROM accounts', 'SQL_COLLATION_NOT_REGISTERED'],
    ['CREATE TABLE custom_collation (value TEXT COLLATE application_custom)', 'SQL_COLLATION_NOT_REGISTERED'],
    ['CREATE VIRTUAL TABLE search_docs USING fts5(body)', 'SQL_VIRTUAL_TABLE_TEMPORARILY_GATED'],
    ['CREATE TEMP TABLE x (id)', 'SQL_TEMP_OBJECT_PROHIBITED'],
    ['DROP TABLE chronolog_transactions', 'SQL_PROTECTED_OBJECT_NAME'],
    ['SELECT * FROM dolt_log', 'SQL_PROTECTED_OBJECT_READ'],
    ['CREATE INDEX attack ON chronolog_transactions(outcome)', 'SQL_PROTECTED_OBJECT_WRITE'],
    ['CREATE TRIGGER attack AFTER INSERT ON accounts BEGIN DELETE FROM chronolog_transactions; END', 'SQL_PROTECTED_OBJECT_WRITE'],
    ['SELECT 1; SELECT 2', 'SQL_MULTIPLE_STATEMENTS'],
  ])('rejects %s with %s', (sql, code) => {
    expect(() => compileSqlStatement({ sql, bindings: [] }, 'body')).toThrowError(
      expect.objectContaining<Partial<SqlCompilerError>>({ code }),
    )
  })

  it('admits deterministic JSON arrows and trigger RAISE while gating transaction rollback', () => {
    expect(compileSqlStatement({
      sql: "SELECT json('{\"id\":1}') ->> '$.id'",
      bindings: [],
    }, 'body').statementClass).toBe('read')
    expect(compileSqlStatement({
      sql: 'CREATE TRIGGER check_value BEFORE INSERT ON accounts BEGIN SELECT RAISE(ABORT, \'bad\'); END',
      bindings: [],
    }, 'body').statementClass).toBe('schema')
    expect(() => compileSqlStatement({
      sql: 'CREATE TRIGGER rollback_value BEFORE INSERT ON accounts BEGIN SELECT RAISE(ROLLBACK, \'bad\'); END',
      bindings: [],
    }, 'body')).toThrowError(expect.objectContaining({ code: 'SQL_RAISE_TEMPORARILY_GATED' }))
  })

  it('requires at least one effect-capable body statement', () => {
    expect(() => compileSqlProgram({
      version: 1,
      preconditions: [{ id: 1, query: { sql: 'SELECT 1', bindings: [] }, resultMode: 'scalar', expectation: { kind: 'assert_true' } }],
      body: [{ sql: 'SELECT 1', bindings: [] }],
    })).toThrowError(expect.objectContaining({ code: 'SQL_EFFECT_CAPABLE_STATEMENT_REQUIRED' }))
  })
})
