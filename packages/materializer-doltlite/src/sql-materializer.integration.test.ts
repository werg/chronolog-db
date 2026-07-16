import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createCoreExecutionManifest } from '@chronolog/compiler-sqlite'
import {
  encodeTransactionCore,
  numberToSqlRealBinding,
  transactionDigest,
  utf8,
  type SqlBinding,
  type SqlTransactionProgram,
  type TransactionCore,
} from '@chronolog/protocol'
import { afterEach, describe, expect, it } from 'vitest'

import { readNativeEngineInfo } from './driver.js'
import { DeterministicMaterializer } from './materializer.js'
import type { AdmittedTransaction } from './types.js'

const directories: string[] = []
afterEach(async () => Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))))

describe('SQL-first DoltLite materialization', () => {
  it('executes DDL and DML sequentially, persists RETURNING, and verifies it on reopen', async () => {
    const { path, manifest } = await fixture()
    let materializer = await DeterministicMaterializer.open({ path, executionManifest: manifest, checkpointEvery: 1 })
    const bootstrap = await transaction(1n, 'bootstrap', {
      version: 1,
      preconditions: [truePrecondition()],
      body: [
        statement('CREATE TABLE accounts (id INTEGER PRIMARY KEY, value TEXT NOT NULL) STRICT'),
        statement('INSERT INTO accounts (id, value) VALUES (?, ?) RETURNING id, value', [integer(1, 2n), text(2, 'two')]),
        statement('SELECT id, value FROM accounts ORDER BY id'),
      ],
    }, materializer.executionManifestDigest)

    await materializer.materialize([bootstrap])
    expect(materializer.outcome(bootstrap.txId)?.outcome).toBe('accepted')
    expect(materializer.localSql('SELECT id, value FROM accounts').rows).toEqual([[
      { kind: 'integer', value: '2' }, { kind: 'text', value: 'two' },
    ]])
    const envelope = materializer.transactionResult(bootstrap.txId)
    expect(envelope?.statements.map((item) => item.statementClass)).toEqual(['schema', 'insert', 'read'])
    expect(envelope?.statements[1]?.affectedRows).toBe(1n)
    expect(envelope?.statements[1]?.result?.mode).toBe('multiset')
    const storedDigest = materializer.outcome(bootstrap.txId)?.resultDigest
    materializer.close()

    materializer = await DeterministicMaterializer.open({ path, executionManifest: manifest, checkpointEvery: 1 })
    expect(materializer.outcome(bootstrap.txId)?.resultDigest).toEqual(storedDigest)
    expect(materializer.transactionResult(bootstrap.txId)).toEqual(envelope)
    const observedCatalog = await materializer.observe(
      statement("SELECT name FROM pragma_table_info('accounts') ORDER BY cid"),
      { resultMode: 'ordered' },
    )
    expect(observedCatalog.result.rows).toHaveLength(2)
    materializer.close()
  })

  it('binds canonical finite REAL values and replays their exact result', async () => {
    const { path, manifest } = await fixture()
    let materializer = await DeterministicMaterializer.open({ path, executionManifest: manifest, checkpointEvery: 1 })
    const realValue = numberToSqlRealBinding(1.25)
    const write = await transaction(1n, 'real-binding', {
      version: 1,
      preconditions: [{
        id: 2,
        query: statement('SELECT typeof(?) = \'real\'', [{ parameter: { kind: 'index', index: 1 }, value: realValue }]),
        resultMode: 'scalar',
        expectation: { kind: 'assert_true' },
      }],
      body: [
        statement('CREATE TABLE measurements (id INTEGER PRIMARY KEY, value REAL NOT NULL) STRICT'),
        statement('INSERT INTO measurements VALUES (1, ?) RETURNING value', [
          { parameter: { kind: 'index', index: 1 }, value: realValue },
        ]),
      ],
    }, materializer.executionManifestDigest)
    await materializer.materialize([write])
    expect(materializer.outcome(write.txId)?.outcome).toBe('accepted')
    expect(materializer.transactionResult(write.txId)?.statements[1]?.result?.rows).toEqual([[
      numberToSqlRealBinding(1.25),
    ]])
    materializer.close()

    materializer = await DeterministicMaterializer.open({ path, executionManifest: manifest, checkpointEvery: 1 })
    expect(materializer.transactionResult(write.txId)?.statements[1]?.result?.rows).toEqual([[
      numberToSqlRealBinding(1.25),
    ]])
    materializer.close()
  })

  it('executes and replays syntactically singleton row-choice forms while faulting unproven input', async () => {
    const { path, manifest } = await fixture()
    let materializer = await DeterministicMaterializer.open({ path, executionManifest: manifest, checkpointEvery: 1 })
    const proven = await transaction(1n, 'proven-row-choice', {
      version: 1,
      preconditions: [{
        id: 3,
        query: statement('SELECT (SELECT 1) LIMIT 1'),
        resultMode: 'scalar',
        expectation: { kind: 'assert_true' },
      }],
      body: [
        statement('CREATE TABLE selected_accounts (id INTEGER PRIMARY KEY, value TEXT NOT NULL) STRICT'),
        statement("INSERT INTO selected_accounts SELECT 1, 'one' RETURNING id, value"),
        statement("UPDATE selected_accounts SET value = source.value FROM (SELECT 'updated' AS value) AS source RETURNING id, value"),
        statement("UPDATE OR ABORT selected_accounts SET value = 'final' WHERE id = 1"),
        statement("CREATE TABLE singleton_snapshot AS SELECT 1 AS id, (SELECT 'final') AS value LIMIT 1"),
        statement('SELECT (SELECT value) FROM singleton_snapshot'),
      ],
    }, materializer.executionManifestDigest)
    await materializer.materialize([proven])
    expect(materializer.outcome(proven.txId)?.outcome).toBe('accepted')
    expect(materializer.transactionResult(proven.txId)?.statements[1]).toMatchObject({
      affectedRows: 1n,
      result: { rows: [[{ kind: 'integer', value: 1n }, { kind: 'text', utf8: utf8('one') }]] },
    })
    expect(materializer.transactionResult(proven.txId)?.statements[2]).toMatchObject({
      affectedRows: 1n,
      result: { rows: [[{ kind: 'integer', value: 1n }, { kind: 'text', utf8: utf8('updated') }]] },
    })
    expect(materializer.transactionResult(proven.txId)?.statements[5]?.result?.rows).toEqual([[
      { kind: 'text', utf8: utf8('final') },
    ]])

    const fault = await transaction(2n, 'unproven-row-choice', {
      version: 1,
      preconditions: [truePrecondition()],
      body: [
        statement('CREATE TABLE row_choice_rollback (id INTEGER PRIMARY KEY) STRICT'),
        statement('INSERT INTO selected_accounts SELECT id, value FROM selected_accounts'),
      ],
    }, materializer.executionManifestDigest)
    await expect(materializer.materialize([proven, fault])).rejects.toMatchObject({
      code: 'SQL_INSERT_SELECT_TEMPORARILY_GATED',
    })
    expect(materializer.outcome(fault.txId)).toBeNull()
    expect(() => materializer.localSql('SELECT * FROM row_choice_rollback')).toThrow()
    materializer.close()

    materializer = await DeterministicMaterializer.open({ path, executionManifest: manifest, checkpointEvery: 1 })
    expect(materializer.localSql('SELECT id, value FROM selected_accounts')).toMatchObject({
      columns: [{ name: 'id' }, { name: 'value' }],
      rows: [[{ kind: 'integer', value: '1' }, { kind: 'text', value: 'final' }]],
    })
    expect(materializer.transactionResult(proven.txId)?.statements[5]?.result?.rows).toEqual([[
      { kind: 'text', utf8: utf8('final') },
    ]])
    materializer.close()
  })

  it('canonicalizes representative-stable aggregates, compounds, and peer windows across replay', async () => {
    const { path, manifest } = await fixture()
    let materializer = await DeterministicMaterializer.open({ path, executionManifest: manifest, checkpointEvery: 1 })
    const aggregate = await transaction(1n, 'aggregate-representatives', {
      version: 1,
      preconditions: [truePrecondition()],
      body: [
        statement('CREATE TABLE aggregate_values (value)'),
        statement("INSERT INTO aggregate_values VALUES (NULL), (NULL), (1), (1.0), ('a'), ('a'), ('A')"),
        statement('SELECT DISTINCT typeof(value) AS storage_type FROM aggregate_values'),
        statement('SELECT typeof(value) AS storage_type, count(*) AS total FROM aggregate_values GROUP BY typeof(value)'),
        statement('SELECT min(typeof(value)) AS minimum_type, max(typeof(value)) AS maximum_type FROM aggregate_values'),
        statement('SELECT typeof(value) AS storage_type FROM aggregate_values UNION SELECT typeof(value) FROM aggregate_values'),
        statement('SELECT rank() OVER (ORDER BY typeof(value)) AS peer_rank, typeof(value) AS storage_type FROM aggregate_values'),
        statement('SELECT dense_rank() OVER (ORDER BY typeof(value)) AS peer_rank, typeof(value) AS storage_type FROM aggregate_values'),
        statement('SELECT group_concat(CAST(value AS TEXT) ORDER BY CAST(value AS TEXT)) AS joined FROM aggregate_values'),
      ],
    }, materializer.executionManifestDigest)
    await materializer.materialize([aggregate])
    expect(materializer.outcome(aggregate.txId)?.outcome).toBe('accepted')
    const results = materializer.transactionResult(aggregate.txId)!.statements
    expect(results[2]?.result?.rows.map((row) => canonicalText(row[0]!)).sort()).toEqual([
      'integer', 'null', 'real', 'text',
    ])
    expect(Object.fromEntries(results[3]!.result!.rows.map((row) => [
      canonicalText(row[0]!), canonicalInteger(row[1]!),
    ]))).toEqual({ integer: 1n, null: 2n, real: 1n, text: 3n })
    expect(results[4]?.result?.rows).toEqual([[
      { kind: 'text', utf8: utf8('integer') },
      { kind: 'text', utf8: utf8('text') },
    ]])
    expect(results[5]?.result?.rows).toEqual(results[2]?.result?.rows)
    expect(results[6]?.result?.rows).toEqual([
      [{ kind: 'integer', value: 1n }, { kind: 'text', utf8: utf8('integer') }],
      [{ kind: 'integer', value: 2n }, { kind: 'text', utf8: utf8('null') }],
      [{ kind: 'integer', value: 2n }, { kind: 'text', utf8: utf8('null') }],
      [{ kind: 'integer', value: 4n }, { kind: 'text', utf8: utf8('real') }],
      [{ kind: 'integer', value: 5n }, { kind: 'text', utf8: utf8('text') }],
      [{ kind: 'integer', value: 5n }, { kind: 'text', utf8: utf8('text') }],
      [{ kind: 'integer', value: 5n }, { kind: 'text', utf8: utf8('text') }],
    ])
    expect(results[7]?.result?.rows).toEqual([
      [{ kind: 'integer', value: 1n }, { kind: 'text', utf8: utf8('integer') }],
      [{ kind: 'integer', value: 2n }, { kind: 'text', utf8: utf8('null') }],
      [{ kind: 'integer', value: 2n }, { kind: 'text', utf8: utf8('null') }],
      [{ kind: 'integer', value: 3n }, { kind: 'text', utf8: utf8('real') }],
      [{ kind: 'integer', value: 4n }, { kind: 'text', utf8: utf8('text') }],
      [{ kind: 'integer', value: 4n }, { kind: 'text', utf8: utf8('text') }],
      [{ kind: 'integer', value: 4n }, { kind: 'text', utf8: utf8('text') }],
    ])
    expect(results[8]?.result?.rows).toEqual([[
      { kind: 'text', utf8: utf8('1,1.0,A,a,a') },
    ]])
    const envelope = materializer.transactionResult(aggregate.txId)
    materializer.close()

    materializer = await DeterministicMaterializer.open({ path, executionManifest: manifest, checkpointEvery: 1 })
    expect(materializer.transactionResult(aggregate.txId)).toEqual(envelope)
    materializer.close()
  })

  it('replays pinned JSON arrows and deterministic trigger RAISE actions', async () => {
    const { path, manifest } = await fixture()
    let materializer = await DeterministicMaterializer.open({ path, executionManifest: manifest, checkpointEvery: 1 })
    const setup = await transaction(1n, 'json-raise-setup', {
      version: 1,
      preconditions: [truePrecondition()],
      body: [
        statement('CREATE TABLE guarded_json (id INTEGER PRIMARY KEY, payload TEXT NOT NULL) STRICT'),
        statement("CREATE TRIGGER guarded_json_ignore BEFORE INSERT ON guarded_json WHEN NEW.id = 0 BEGIN SELECT RAISE(IGNORE); END"),
        statement("CREATE TRIGGER guarded_json_abort BEFORE INSERT ON guarded_json WHEN NEW.id < 0 BEGIN SELECT RAISE(ABORT, 'negative id'); END"),
        statement("INSERT INTO guarded_json VALUES (0, '{\"ignored\":true}') RETURNING id"),
        statement("INSERT INTO guarded_json VALUES (1, '{\"answer\":42}')"),
        statement("SELECT payload -> '$.answer' AS json_value, payload ->> '$.answer' AS sql_value FROM guarded_json"),
      ],
    }, materializer.executionManifestDigest)
    await materializer.materialize([setup])
    expect(materializer.outcome(setup.txId)?.outcome).toBe('accepted')
    expect(materializer.transactionResult(setup.txId)?.statements[3]).toMatchObject({
      affectedRows: 0n,
      result: { rows: [] },
    })
    expect(materializer.transactionResult(setup.txId)?.statements[5]?.result?.rows).toEqual([[
      { kind: 'text', utf8: utf8('42') },
      { kind: 'integer', value: 42n },
    ]])

    const rejected = await transaction(2n, 'json-raise-rejected', {
      version: 1,
      preconditions: [truePrecondition()],
      body: [statement("INSERT INTO guarded_json VALUES (-1, '{\"bad\":true}')")],
    }, materializer.executionManifestDigest)
    await materializer.materialize([setup, rejected])
    expect(materializer.outcome(rejected.txId)).toMatchObject({
      outcome: 'rejected_execution',
      rejectionCode: 'SQL_CONSTRAINT_VIOLATION',
      failingStatementIndex: 0,
    })
    expect(materializer.localSql('SELECT id FROM guarded_json').rows).toEqual([[
      { kind: 'integer', value: '1' },
    ]])
    const envelope = materializer.transactionResult(setup.txId)
    materializer.close()

    materializer = await DeterministicMaterializer.open({ path, executionManifest: manifest, checkpointEvery: 1 })
    expect(materializer.transactionResult(setup.txId)).toEqual(envelope)
    expect(materializer.outcome(rejected.txId)?.rejectionCode).toBe('SQL_CONSTRAINT_VIOLATION')
    materializer.close()
  })

  it('rolls back schema and data on deterministic rejection and replays late predecessors', async () => {
    const { path, manifest } = await fixture()
    const materializer = await DeterministicMaterializer.open({ path, executionManifest: manifest, checkpointEvery: 1 })
    const bootstrap = await transaction(1n, 'bootstrap', {
      version: 1,
      preconditions: [truePrecondition()],
      body: [
        statement('CREATE TABLE accounts (id INTEGER PRIMARY KEY, balance INTEGER NOT NULL) STRICT'),
        statement('INSERT INTO accounts VALUES (?, ?)', [integer(1, 1n), integer(2, 100n)]),
      ],
    }, materializer.executionManifestDigest)
    const later = await transaction(20n, 'later', updateProgram(100n, 90n), materializer.executionManifestDigest)
    const predecessor = await transaction(10n, 'predecessor', updateProgram(100n, 5n), materializer.executionManifestDigest)
    await materializer.materialize([bootstrap, later])
    expect(materializer.outcome(later.txId)?.outcome).toBe('accepted')
    await materializer.materialize([bootstrap, predecessor, later])
    expect(materializer.localSql('SELECT balance FROM accounts WHERE id = 1').rows[0]?.[0]).toEqual({ kind: 'integer', value: '5' })
    expect(materializer.outcome(later.txId)).toMatchObject({
      outcome: 'rejected_precondition',
      rejectionCode: 'SQL_ASSERTION_FALSE',
      failurePhase: 'precondition',
      failingPreconditionIndex: 0,
    })

    const rejected = await transaction(30n, 'rollback-ddl', {
      version: 1,
      preconditions: [truePrecondition()],
      body: [
        statement('CREATE TABLE transient_table (id INTEGER PRIMARY KEY) STRICT'),
        statement('INSERT INTO transient_table VALUES (1), (1)'),
      ],
    }, materializer.executionManifestDigest)
    await materializer.materialize([bootstrap, predecessor, later, rejected])
    expect(materializer.outcome(rejected.txId)).toMatchObject({
      outcome: 'rejected_execution', rejectionCode: 'SQL_CONSTRAINT_VIOLATION', failurePhase: 'statement', failingStatementIndex: 1,
    })
    expect(() => materializer.localSql('SELECT * FROM transient_table')).toThrow()
    expect(() => materializer.localSql('DELETE FROM accounts')).toThrow()
    materializer.close()
  })

  it('replays indexes, views, triggers, and ALTER/DROP catalog changes across reopen', async () => {
    const { path, manifest } = await fixture()
    let materializer = await DeterministicMaterializer.open({ path, executionManifest: manifest, checkpointEvery: 1 })
    const ddl = await transaction(1n, 'ddl-lifecycle', {
      version: 1,
      preconditions: [truePrecondition()],
      body: [
        statement('CREATE TABLE events (id INTEGER PRIMARY KEY, value TEXT NOT NULL) STRICT'),
        statement('CREATE TABLE event_audit (event_id INTEGER NOT NULL, old_value TEXT NOT NULL) STRICT'),
        statement('CREATE INDEX events_value_idx ON events(value)'),
        statement('CREATE VIEW event_values AS SELECT id, value FROM events'),
        statement('CREATE TRIGGER events_audit AFTER UPDATE OF value ON events BEGIN INSERT INTO event_audit VALUES (OLD.id, OLD.value); END'),
        statement("INSERT INTO events VALUES (1, 'before')"),
        statement('ALTER TABLE events ADD COLUMN note TEXT'),
        statement("UPDATE events SET value = 'after', note = 'kept' WHERE id = 1"),
      ],
    }, materializer.executionManifestDigest)
    await materializer.materialize([ddl])
    expect(materializer.outcome(ddl.txId)).toMatchObject({
      outcome: 'accepted', rejectionCode: null, failingStatementIndex: null,
    })
    materializer.close()

    materializer = await DeterministicMaterializer.open({ path, executionManifest: manifest, checkpointEvery: 1 })
    expect(materializer.localSql('SELECT id, value FROM event_values').rows).toEqual([[
      { kind: 'integer', value: '1' }, { kind: 'text', value: 'after' },
    ]])
    expect(materializer.localSql('SELECT event_id, old_value FROM event_audit').rows).toEqual([[
      { kind: 'integer', value: '1' }, { kind: 'text', value: 'before' },
    ]])
    expect(materializer.localSql("SELECT name FROM pragma_index_list('events') WHERE name = 'events_value_idx'").rows).toHaveLength(1)

    const drop = await transaction(2n, 'ddl-drop', {
      version: 1,
      preconditions: [truePrecondition()],
      body: [
        statement('DROP TRIGGER events_audit'),
        statement('DROP VIEW event_values'),
        statement('DROP INDEX events_value_idx'),
        statement('ALTER TABLE events RENAME COLUMN note TO memo'),
      ],
    }, materializer.executionManifestDigest)
    await materializer.materialize([ddl, drop])
    expect(materializer.outcome(drop.txId)).toMatchObject({
      outcome: 'accepted', rejectionCode: null, failingStatementIndex: null,
    })
    materializer.close()

    materializer = await DeterministicMaterializer.open({ path, executionManifest: manifest, checkpointEvery: 1 })
    expect(materializer.localSql("SELECT name FROM pragma_table_info('events') ORDER BY cid").rows).toEqual([
      [{ kind: 'text', value: 'id' }],
      [{ kind: 'text', value: 'value' }],
      [{ kind: 'text', value: 'memo' }],
    ])
    expect(materializer.localSql("SELECT name FROM pragma_table_list WHERE schema = 'main' AND name IN ('event_audit', 'event_values') ORDER BY name").rows).toEqual([
      [{ kind: 'text', value: 'event_audit' }],
    ])
    materializer.close()
  })

  it('leaves schema unchanged after a failed precondition and can replay rejected to accepted', async () => {
    const { path, manifest } = await fixture()
    const materializer = await DeterministicMaterializer.open({ path, executionManifest: manifest, checkpointEvery: 1 })
    const bootstrap = await transaction(1n, 'bootstrap-fifty', {
      version: 1,
      preconditions: [truePrecondition()],
      body: [
        statement('CREATE TABLE accounts (id INTEGER PRIMARY KEY, balance INTEGER NOT NULL) STRICT'),
        statement('INSERT INTO accounts VALUES (1, 50)'),
      ],
    }, materializer.executionManifestDigest)
    const rejectedDdl = await transaction(5n, 'failed-ddl-precondition', {
      version: 1,
      preconditions: [{ id: 9, query: statement('SELECT 0'), resultMode: 'scalar', expectation: { kind: 'assert_true' } }],
      body: [statement('CREATE TABLE must_not_exist (id INTEGER PRIMARY KEY) STRICT')],
    }, materializer.executionManifestDigest)
    const later = await transaction(20n, 'becomes-accepted', updateProgram(100n, 90n), materializer.executionManifestDigest)
    await materializer.materialize([bootstrap, rejectedDdl, later])
    expect(materializer.outcome(rejectedDdl.txId)?.outcome).toBe('rejected_precondition')
    expect(() => materializer.localSql('SELECT * FROM must_not_exist')).toThrow()
    expect(materializer.outcome(later.txId)?.outcome).toBe('rejected_precondition')

    const predecessor = await transaction(10n, 'sets-one-hundred', updateProgram(50n, 100n), materializer.executionManifestDigest)
    await materializer.materialize([bootstrap, rejectedDdl, predecessor, later])
    expect(materializer.outcome(predecessor.txId)?.outcome).toBe('accepted')
    expect(materializer.outcome(later.txId)?.outcome).toBe('accepted')
    expect(materializer.localSql('SELECT balance FROM accounts WHERE id = 1').rows[0]?.[0]).toEqual({ kind: 'integer', value: '90' })
    materializer.close()
  })

  it('executes the conservative ordered rowid mutation subset through a frozen target vector', async () => {
    const { path, manifest } = await fixture()
    const materializer = await DeterministicMaterializer.open({ path, executionManifest: manifest })
    const ordered = await transaction(1n, 'ordered-rowid-update', {
      version: 1,
      preconditions: [truePrecondition()],
      body: [
        statement('CREATE TABLE ranked (id INTEGER PRIMARY KEY, score INTEGER NOT NULL, picked INTEGER NOT NULL) STRICT'),
        statement('INSERT INTO ranked VALUES (1, 10, 0), (2, 20, 0), (3, 10, 0), (4, 30, 0)'),
        statement(
          'UPDATE ranked SET picked = :picked WHERE picked = 0 RETURNING id ORDER BY score DESC LIMIT 2 OFFSET 1',
          [{ parameter: { kind: 'name', name: ':picked' }, value: { kind: 'int64', value: 1n } }],
        ),
        statement('DELETE FROM ranked RETURNING id ORDER BY score LIMIT ?', [integer(1, 0n)]),
      ],
    }, materializer.executionManifestDigest)
    await materializer.materialize([ordered])
    expect(materializer.outcome(ordered.txId)).toMatchObject({ outcome: 'accepted', rejectionCode: null })
    expect(materializer.localSql('SELECT id FROM ranked WHERE picked = 1 ORDER BY id').rows).toEqual([
      [{ kind: 'integer', value: '1' }],
      [{ kind: 'integer', value: '2' }],
    ])
    const result = materializer.transactionResult(ordered.txId)?.statements[2]
    expect(result?.affectedRows).toBe(2n)
    expect(result?.result?.mode).toBe('multiset')
    expect(result?.result?.rows.map((row) => row[0])).toEqual([
      { kind: 'integer', value: 1n },
      { kind: 'integer', value: 2n },
    ])
    expect(materializer.transactionResult(ordered.txId)?.statements[3]).toMatchObject({
      affectedRows: 0n,
      result: { mode: 'multiset', rows: [] },
    })
    materializer.close()
  })

  it('charges precondition and body rows against one transaction result budget', async () => {
    const { path, manifest } = await fixture({ maxTransactionResultRows: 1 })
    const materializer = await DeterministicMaterializer.open({ path, executionManifest: manifest })
    const limited = await transaction(1n, 'aggregate-result-limit', {
      version: 1,
      preconditions: [truePrecondition()],
      body: [
        statement('CREATE TABLE limited_values (id INTEGER PRIMARY KEY) STRICT'),
        statement('INSERT INTO limited_values VALUES (1) RETURNING id'),
      ],
    }, materializer.executionManifestDigest)
    await materializer.materialize([limited])
    expect(materializer.outcome(limited.txId)).toMatchObject({
      outcome: 'rejected_execution',
      rejectionCode: 'SQL_TRANSACTION_RESULT_ROW_LIMIT',
      failurePhase: 'statement',
      failingStatementIndex: 1,
      resultEnvelope: null,
      resultDigest: null,
    })
    expect(() => materializer.localSql('SELECT * FROM limited_values')).toThrow()
    materializer.close()
  })

  it('uses the complete declared primary key for ordered WITHOUT ROWID deletion', async () => {
    const { path, manifest } = await fixture()
    const materializer = await DeterministicMaterializer.open({ path, executionManifest: manifest })
    const ordered = await transaction(1n, 'ordered-without-rowid-delete', {
      version: 1,
      preconditions: [truePrecondition()],
      body: [
        statement('CREATE TABLE queue (tenant TEXT COLLATE NOCASE, id INTEGER, score INTEGER NOT NULL, PRIMARY KEY (tenant DESC, id)) WITHOUT ROWID, STRICT'),
        statement("INSERT INTO queue VALUES ('a', 1, 10), ('A', 2, 30), ('b', 1, 20)"),
        statement('DELETE FROM queue WHERE score >= 0 RETURNING tenant, id ORDER BY score DESC LIMIT 1'),
      ],
    }, materializer.executionManifestDigest)
    await materializer.materialize([ordered])
    expect(materializer.outcome(ordered.txId)).toMatchObject({ outcome: 'accepted', rejectionCode: null })
    expect(materializer.localSql('SELECT tenant, id FROM queue ORDER BY score DESC').rows).toEqual([
      [{ kind: 'text', value: 'b' }, { kind: 'integer', value: '1' }],
      [{ kind: 'text', value: 'a' }, { kind: 'integer', value: '1' }],
    ])
    expect(materializer.transactionResult(ordered.txId)?.statements[2]?.result?.rows).toEqual([[
      { kind: 'text', utf8: utf8('A') },
      { kind: 'integer', value: 2n },
    ]])
    materializer.close()
  })
})

function updateProgram(expected: bigint, next: bigint): SqlTransactionProgram {
  return {
    version: 1,
    preconditions: [{
      id: 11,
      query: statement('SELECT balance = ? FROM accounts WHERE id = 1', [integer(1, expected)]),
      resultMode: 'scalar',
      expectation: { kind: 'assert_true' },
    }],
    body: [statement('UPDATE accounts SET balance = ? WHERE id = 1', [integer(1, next)])],
  }
}

function truePrecondition() {
  return { id: 1, query: statement('SELECT 1'), resultMode: 'scalar' as const, expectation: { kind: 'assert_true' as const } }
}
function statement(sql: string, bindings: readonly SqlBinding[] = []) { return { sql, bindings } }
function integer(index: number, value: bigint): SqlBinding { return { parameter: { kind: 'index', index }, value: { kind: 'int64', value } } }
function text(index: number, value: string): SqlBinding { return { parameter: { kind: 'index', index }, value: { kind: 'text', utf8: utf8(value) } } }

async function fixture(resources: Parameters<typeof createCoreExecutionManifest>[0]['resources'] = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'chronolog-sql-materializer-'))
  directories.push(directory)
  const native = readNativeEngineInfo()
  return {
    path: join(directory, 'application.db'),
    manifest: createCoreExecutionManifest({ profile: 'chronolog-core-portable', engine: native.descriptor, engineDigest: native.digest, resources }),
  }
}

async function transaction(
  timestamp: bigint,
  id: string,
  program: SqlTransactionProgram,
  executionManifestDigest: Uint8Array,
): Promise<AdmittedTransaction> {
  const core: TransactionCore = {
    groupId: bytes32(1), membershipRevision: bytes32(2), validationPolicy: bytes32(3), authorId: bytes32(4),
    authorTimestampMs: timestamp, nonce: bytes32(Number(timestamp) + 10), executionManifestDigest, program,
  }
  const canonicalCandidate = encodeTransactionCore(core)
  return {
    txId: utf8(id),
    authorFeedSequence: timestamp,
    candidateDigest: await transactionDigest(canonicalCandidate),
    canonicalCandidate,
    core,
  }
}
function bytes32(seed: number): Uint8Array { return Uint8Array.from({ length: 32 }, (_value, index) => (seed + index) & 0xff) }

function canonicalText(value: { readonly kind: string }): string {
  if (value.kind !== 'text' || !('utf8' in value) || !(value.utf8 instanceof Uint8Array)) throw new Error('expected canonical text')
  return new TextDecoder().decode(value.utf8)
}

function canonicalInteger(value: { readonly kind: string }): bigint {
  if (value.kind !== 'integer' || !('value' in value) || typeof value.value !== 'bigint') throw new Error('expected canonical integer')
  return value.value
}
