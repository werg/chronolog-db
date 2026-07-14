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
    CREATE TABLE chronolog_transactions (tx_id BLOB PRIMARY KEY, outcome TEXT NOT NULL);
    CREATE TABLE chronolog_materializer_metadata (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE chronolog_checkpoints (prefix_length INTEGER PRIMARY KEY);
  `)
  configureSqliteLimits(db)
  return db
}

function expectProfileViolation(db: DatabaseLike, sql: string, mode: 'local_read' | 'consensus_precondition' | 'consensus_mutation' = 'consensus_mutation'): void {
  expect(() => prepareProfiledStatement(db, sql, mode)).toThrowError(
    expect.objectContaining<Partial<SqlProfileError>>({ code: 'SQL_PROFILE_VIOLATION' }),
  )
}

describe('SQL authorization profile', () => {
  it('allows deterministic application DML and explicitly approved functions', () => {
    const db = database()
    try {
      withProfiledStatement(db, "UPDATE accounts SET value = lower(value) WHERE abs(id) = 1", 'consensus_mutation', (statement) => statement.run())
      const result = executeLocalSql(db, 'SELECT count(*), max(value) FROM accounts')
      expect(result.rows).toHaveLength(1)
    } finally {
      db.close()
    }
  })

  it('makes only the public transaction log readable among internal relations', () => {
    const db = database()
    try {
      expect(() => executeLocalSql(db, 'SELECT tx_id, outcome FROM chronolog_transactions')).not.toThrow()
      for (const sql of [
        'SELECT * FROM chronolog_materializer_metadata',
        'SELECT * FROM chronolog_checkpoints',
        'SELECT * FROM dolt_log',
        'SELECT * FROM dolt_status',
        'SELECT * FROM pragma_table_info',
        'SELECT * FROM sqlite_schema',
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

  it('denies DDL, transaction control, attachment, pragmas, maintenance, virtual tables and recursion', () => {
    const db = database()
    try {
      for (const sql of [
        'CREATE TABLE attack (id INTEGER)',
        'CREATE TRIGGER attack AFTER INSERT ON accounts BEGIN DELETE FROM accounts; END',
        'BEGIN',
        'SAVEPOINT attack',
        "ATTACH DATABASE ':memory:' AS attack",
        'DETACH DATABASE main',
        'PRAGMA writable_schema = ON',
        'PRAGMA journal_mode = OFF',
        'REINDEX',
        'ANALYZE',
        'CREATE VIRTUAL TABLE attack USING fts5(value)',
        'WITH RECURSIVE x(v) AS (VALUES(1) UNION ALL SELECT v+1 FROM x WHERE v<2) SELECT * FROM x',
      ]) expectProfileViolation(db, sql, sql.startsWith('WITH') ? 'local_read' : 'consensus_mutation')
    } finally {
      db.close()
    }
  })

  it('uses a positive function allowlist, including for new or overlooked Dolt functions', () => {
    const db = database()
    try {
      for (const expression of [
        'random()',
        'randomblob(8)',
        'current_timestamp',
        "datetime('now')",
        "timediff('2020-01-01', '2019-01-01')",
        'changes()',
        'last_insert_rowid()',
        'sqlite_version()',
        'active_branch()',
        "dolt_hashof_db('HEAD')",
        'dolt_version()',
        "load_extension('/tmp/attack')",
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
