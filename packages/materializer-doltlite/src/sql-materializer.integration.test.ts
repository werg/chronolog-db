import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createCoreExecutionManifest } from '@chronolog/compiler-sqlite'
import {
  encodeTransactionCore,
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

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'chronolog-sql-materializer-'))
  directories.push(directory)
  const native = readNativeEngineInfo()
  return {
    path: join(directory, 'application.db'),
    manifest: createCoreExecutionManifest({ profile: 'chronolog-core-portable', engine: native.descriptor, engineDigest: native.digest }),
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
