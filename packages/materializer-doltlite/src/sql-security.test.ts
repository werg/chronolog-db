import { DatabaseSync } from '@dolthub/doltlite'
import { describe, expect, it } from 'vitest'

import type {
  SqlProfileError} from './sql-profile.js';
import {
  assertNativeSecurityConfiguration,
  configureSqliteLimits,
  isOperationalSqliteError,
  prepareProfiledStatement,
  withProfiledStatement,
} from './sql-profile.js'
import { executeLocalSql } from './sql-values.js'
import type { DatabaseLike } from './types.js'

function database(): DatabaseLike {
  const db = new DatabaseSync(':memory:') as unknown as DatabaseLike
  assertNativeSecurityConfiguration(db.configureSecurity())
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA trusted_schema = OFF')
  db.exec(`
    CREATE TABLE accounts (id INTEGER PRIMARY KEY AUTOINCREMENT, value TEXT NOT NULL);
    INSERT INTO accounts VALUES (1, 'one'), (2, 'two');
    CREATE TABLE "DoltOn" (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO "DoltOn" VALUES (1, 'ordinary application table');
    CREATE TABLE chronolog_transactions (tx_id BLOB PRIMARY KEY, outcome TEXT NOT NULL);
    CREATE TABLE chronolog_materializer_metadata (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE chronolog_checkpoints (prefix_length INTEGER PRIMARY KEY);
  `)
  configureSqliteLimits(db)
  return db
}

function expectProfileViolation(db: DatabaseLike, sql: string, mode: 'local_read' | 'consensus_precondition' | 'consensus_body' = 'consensus_body'): void {
  expect(() => prepareProfiledStatement(db, sql, mode)).toThrowError(
    expect.objectContaining<Partial<SqlProfileError>>({ code: 'SQL_PROFILE_VIOLATION' }),
  )
}

describe('SQL authorization profile', () => {
  it('allows deterministic application DML and explicitly approved functions', () => {
    const db = database()
    try {
      withProfiledStatement(db, "UPDATE accounts SET value = lower(value) WHERE sign(id) = 1", 'consensus_body', (statement) => statement.run())
      withProfiledStatement(db, 'UPDATE "DoltOn" SET value = upper(value) WHERE id = 1', 'consensus_body', (statement) => statement.run())
      const result = executeLocalSql(db, 'SELECT count(*), max(value) FROM accounts')
      expect(result.rows).toHaveLength(1)
      expect(executeLocalSql(db, 'SELECT value FROM "DoltOn"').rows).toEqual([
        [{ kind: 'text', value: 'ORDINARY APPLICATION TABLE' }],
      ])
    } finally {
      db.close()
    }
  })

  it('makes only the public transaction log readable among internal relations', () => {
    const db = database()
    try {
      expect(() => executeLocalSql(db, 'SELECT tx_id, outcome FROM chronolog_transactions')).not.toThrow()
      expect(() => executeLocalSql(db, "SELECT name FROM pragma_table_info('accounts')")).not.toThrow()
      expect(() => executeLocalSql(db, "SELECT name FROM sqlite_schema WHERE type = 'table'")).not.toThrow()
      for (const sql of [
        'SELECT * FROM chronolog_materializer_metadata',
        'SELECT * FROM chronolog_checkpoints',
        'SELECT * FROM dolt_log',
        'SELECT * FROM dolt_status',
      ]) expectProfileViolation(db, sql, 'local_read')
    } finally {
      db.close()
    }
  })

  it('denies every mutation of reserved objects', () => {
    const db = database()
    try {
      for (const sql of [
        "INSERT INTO chronolog_transactions VALUES (x'01', 'accepted')",
        "UPDATE chronolog_transactions SET outcome = 'accepted'",
        'DELETE FROM chronolog_transactions',
        'DROP TABLE chronolog_transactions',
        'ALTER TABLE chronolog_transactions ADD COLUMN hidden TEXT',
        'CREATE INDEX chronolog_attack ON accounts(value)',
        'CREATE TABLE dolt_attack (id INTEGER)',
        'DELETE FROM sqlite_sequence',
      ]) expectProfileViolation(db, sql)
    } finally {
      db.close()
    }
  })

  it('allows application DDL and denies transaction control, attachment, stateful pragmas, maintenance and virtual tables', () => {
    const db = database()
    try {
      expect(() => prepareProfiledStatement(db, 'CREATE TABLE attack (id INTEGER)', 'consensus_body')).not.toThrow()
      expect(() => prepareProfiledStatement(
        db,
        'CREATE TRIGGER attack AFTER INSERT ON accounts BEGIN DELETE FROM accounts; END',
        'consensus_body',
      )).not.toThrow()
      for (const sql of [
        'CREATE TEMP TABLE attack (id INTEGER)',
        'BEGIN',
        'SAVEPOINT attack',
        "ATTACH DATABASE ':memory:' AS attack",
        'DETACH DATABASE main',
        'PRAGMA writable_schema = ON',
        'PRAGMA journal_mode = OFF',
        'REINDEX',
        'ANALYZE',
        'CREATE VIRTUAL TABLE attack USING fts5(value)',
      ]) expectProfileViolation(db, sql)
    } finally {
      db.close()
    }
  })

  it('uses a positive function allowlist for consensus SQL', () => {
    const db = database()
    try {
      for (const expression of [
        'random()',
        'randomblob(8)',
        'current_timestamp',
        'changes()',
        'last_insert_rowid()',
        'sqlite_version()',
        'active_branch()',
        "dolt_hashof_db('HEAD')",
        'dolt_version()',
        "load_extension('/tmp/attack')",
        "format('%s', 'x')",
        'round(1)',
        'sum(1)',
      ]) expectProfileViolation(db, `SELECT ${expression}`, 'consensus_precondition')
      expect(withProfiledStatement(
        db,
        "SELECT count(*), min(id), max(id), abs(id), sign(max(id)), value GLOB 't*', datetime('2000-01-01'), timediff('2020-01-01', '2019-01-01') FROM accounts GROUP BY value",
        'consensus_precondition',
        (statement) => statement.all(),
      )).toHaveLength(2)
      expect(withProfiledStatement(db, `
        SELECT
          char(65), concat('a', 1), concat_ws('-', 'a', 'b'),
          if(1, 'yes', 'no'), iif(0, 'yes', 'no'), likely(1), unlikely(0),
          glob('a*', 'abc'), like('a%', 'abc'), min(2, 1), max(2, 1),
          quote(x'ab'), typeof(NULL), unhex('ab-cd', '-'), unicode('é'),
          unistr('A\\u00e9'), unistr_quote(char(1)), zeroblob(3)
      `, 'consensus_precondition', (statement) => statement.all())).toHaveLength(1)
    } finally {
      db.close()
    }
  })

  it('allows bounded recursive CTEs in the consensus profile', () => {
    const db = database()
    try {
      const rows = withProfiledStatement(db, `
        WITH RECURSIVE numbers(value) AS (
          VALUES(1) UNION ALL SELECT value + 1 FROM numbers WHERE value < 3
        )
        SELECT value FROM numbers ORDER BY value
      `, 'consensus_precondition', (statement) => statement.all())
      expect(rows).toHaveLength(3)
    } finally {
      db.close()
    }
  })

  it('allows only the JSON1 functions emitted by the deterministic compiler profile', () => {
    const db = database()
    try {
      const rows = withProfiledStatement(db, `
        SELECT
          json('{"key":1}') -> '$.key',
          json_type(json('{"key":1}'), '$.key'),
          json_array(1, 2),
          json_object('key', 1)
      `, 'consensus_precondition', (statement) => statement.all())
      expect(rows).toHaveLength(1)
      expectProfileViolation(db, `SELECT json_extract('{"key":1}', '$.key')`, 'consensus_precondition')
      expectProfileViolation(db, `SELECT json_valid('{"key":1}')`, 'consensus_precondition')
    } finally {
      db.close()
    }
  })

  it('allows broad standard SQLite reads locally without weakening the consensus profile', () => {
    const db = database()
    try {
      const result = executeLocalSql(db, `
        WITH RECURSIVE numbers(value) AS (
          VALUES(1) UNION ALL SELECT value + 1 FROM numbers WHERE value < 3
        )
        SELECT
          datetime('now'),
          json_extract('{"value":"ordinary-sql"}', '$.value'),
          sqlite_version(),
          random(),
          sum(value) OVER ()
        FROM numbers
        ORDER BY value
      `)
      expect(result.rows).toHaveLength(3)
      expect(result.rows[0]?.[1]).toEqual({ kind: 'text', value: 'ordinary-sql' })
      expect(result.rows[0]?.[4]).toEqual({ kind: 'integer', value: '6' })

      for (const expression of [
        "load_extension('/tmp/attack')",
        'active_branch()',
        "dolt_hashof_db('HEAD')",
        'dolt_version()',
        'doltlite_engine()',
      ]) expectProfileViolation(db, `SELECT ${expression}`, 'local_read')
    } finally {
      db.close()
    }
  })

  it('uses the native UTF-8 tail offset without slicing a JS string by bytes', () => {
    const db = database()
    try {
      expect(() => prepareProfiledStatement(db, "SELECT 'é'; -- allowed trailing trivia", 'local_read')).not.toThrow()
      expect(() => prepareProfiledStatement(db, "SELECT 'é'; DELETE FROM accounts", 'local_read')).toThrowError(
        expect.objectContaining<Partial<SqlProfileError>>({ code: 'SQL_MULTIPLE_STATEMENTS' }),
      )
      expect(() => prepareProfiledStatement(db, 'SELECT 1\0; DELETE FROM accounts', 'local_read')).toThrowError(
        expect.objectContaining<Partial<SqlProfileError>>({ code: 'SQL_INVALID_SOURCE' }),
      )
    } finally {
      db.close()
    }
  })
})

describe('SQL resource and error boundaries', () => {
  it('turns a deterministic VM budget into a stable profile rejection', () => {
    const db = database()
    try {
      db.exec(`
        CREATE TABLE numbers (value INTEGER PRIMARY KEY);
        WITH RECURSIVE n(v) AS (VALUES(1) UNION ALL SELECT v + 1 FROM n WHERE v < 200)
        INSERT INTO numbers SELECT v FROM n;
      `)
      expect(() => executeLocalSql(
        db,
        'SELECT sum(a.value * b.value * c.value) FROM numbers a, numbers b, numbers c',
        [],
        { maxVmSteps: 1_000, progressGranularity: 100 },
      )).toThrowError(expect.objectContaining<Partial<SqlProfileError>>({ code: 'SQL_STEP_LIMIT' }))
    } finally {
      db.close()
    }
  })

  it('enforces deterministic result row and byte ceilings', () => {
    const db = database()
    try {
      expect(() => executeLocalSql(db, 'SELECT * FROM accounts ORDER BY id', [], { maxResultRows: 1 }))
        .toThrowError(expect.objectContaining<Partial<SqlProfileError>>({ code: 'SQL_RESULT_LIMIT' }))
      expect(() => executeLocalSql(db, "SELECT zeroblob(1000)", [], { maxResultBytes: 100 }))
        .toThrowError(expect.objectContaining<Partial<SqlProfileError>>({ code: 'SQL_RESULT_LIMIT' }))
    } finally {
      db.close()
    }
  })

  it('classifies local operational SQLite failures numerically', () => {
    expect(isOperationalSqliteError(Object.assign(new Error('constraint'), { sqliteCode: 19 }))).toBe(false)
    for (const sqliteCode of [5, 6, 7, 9, 10, 11, 13, 14, 26]) {
      const error = Object.assign(new Error(`sqlite ${sqliteCode}`), { sqliteCode })
      expect(isOperationalSqliteError(error)).toBe(true)
    }
  })

  it('verifies defensive mode and disabled double-quoted string literals', () => {
    const db = database()
    try {
      expect(() => prepareProfiledStatement(db, 'SELECT "not a column"', 'local_read')).toThrowError(
        expect.objectContaining<Partial<SqlProfileError>>({ code: 'SQL_PREPARE_FAILED' }),
      )
      db.exec('PRAGMA writable_schema = ON')
      const row = db.prepare('PRAGMA writable_schema').get()
      expect(Array.isArray(row) ? row[0] : row?.writable_schema).toBe(0)
    } finally {
      db.close()
    }
  })
})
