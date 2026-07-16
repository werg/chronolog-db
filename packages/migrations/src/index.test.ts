import { describe, expect, it } from 'vitest'

import type { ChronologClient, RevisionMetadata, SettlementEvidence, TransactionOutcome } from '@chronolog/client'

import {
  MigrationManager,
  defineMigration,
  diffCatalogs,
  generateTypeScriptBindings,
  migrationChecksum,
  schemaVersionAssumption,
  type CatalogSnapshot,
} from './index.js'

const revision: RevisionMetadata = {
  groupId: 'group',
  eventSetRevision: '10',
  materializedRevision: '7',
  publishedOrderLength: '3',
  executionManifestDigest: 'manifest',
  replaying: false,
}

describe('application migrations', () => {
  it('checksums the exact statement bundle and rejects edited declared checksums', () => {
    const input = {
      component: 'accounts',
      id: 'add-email',
      version: 2,
      statements: [{ sql: 'ALTER TABLE accounts ADD COLUMN email TEXT' }],
    } as const
    const migration = defineMigration(input)
    expect(migration.checksum).toMatch(/^[0-9a-f]{64}$/)
    expect(migrationChecksum(input)).toBe(migration.checksum)
    expect(migrationChecksum({ ...input, statements: [{ sql: 'ALTER TABLE accounts ADD COLUMN email BLOB' }] })).not.toBe(migration.checksum)
    expect(() => defineMigration({ ...input, checksum: 'edited' })).toThrowError('MIGRATION_CHECKSUM_INVALID')
  })

  it('builds exact and minimum signed schema assumptions', () => {
    expect(schemaVersionAssumption('accounts', { exact: 2, checksum: 'abc' })).toEqual({
      sql: 'SELECT EXISTS (SELECT 1 FROM application_migrations WHERE component = ? AND version = ? AND checksum = ?)',
      parameters: ['accounts', 2n, 'abc'],
      applicationLabel: 'schema.accounts.exact.2',
    })
    expect(schemaVersionAssumption('accounts', { minimum: 2 })).toMatchObject({
      parameters: [2n, 'accounts'],
      applicationLabel: 'schema.accounts.minimum.2',
    })
  })

  it('treats a concurrent identical winner as safely applied', async () => {
    const migration = defineMigration({
      component: 'accounts', id: 'create', version: 1,
      statements: [{ sql: 'CREATE TABLE accounts (id INTEGER PRIMARY KEY) STRICT' }],
    })
    let historyExists = false
    const rejected = outcome('rejected')
    const client = {
      async query(sql: string) {
        if (sql.includes('sqlite_schema')) return query([[historyExists ? 1n : 0n]])
        return query(historyExists ? [['accounts', 'create', 1n, migration.checksum, 100n]] : [])
      },
      async transaction(build: (draft: unknown) => Promise<void>) {
        const draft = {
          reservedAuthorTimestampMs: 101n,
          assert() { return this },
          exec() { return { statementIndex: 0 } },
        }
        await build(draft)
        historyExists = true
        return { transactionId: 'loser', dispose() {} }
      },
      async getTransactionOutcome() { return rejected },
      async getSettlementEvidence() { return evidence(rejected, 'provisional') },
    } as unknown as ChronologClient

    await expect(new MigrationManager(client).apply(migration, { timeoutMs: 100 })).resolves.toMatchObject({
      state: 'already_applied',
      status: { state: 'applied', entry: { checksum: migration.checksum } },
    })
  })

  it('reports a conflicting checksum after a concurrent winner', async () => {
    const migration = defineMigration({
      component: 'accounts', id: 'create', version: 1,
      statements: [{ sql: 'CREATE TABLE accounts (id INTEGER PRIMARY KEY) STRICT' }],
    })
    let historyExists = false
    const rejected = outcome('rejected')
    const client = {
      async query(sql: string) {
        if (sql.includes('sqlite_schema')) return query([[historyExists ? 1n : 0n]])
        return query(historyExists ? [['accounts', 'create', 1n, 'different', 100n]] : [])
      },
      async transaction(build: (draft: unknown) => Promise<void>) {
        await build({ reservedAuthorTimestampMs: 101n, assert() {}, exec() {} })
        historyExists = true
        return { transactionId: 'loser', dispose() {} }
      },
      async getTransactionOutcome() { return rejected },
      async getSettlementEvidence() { return evidence(rejected, 'provisional') },
    } as unknown as ChronologClient

    await expect(new MigrationManager(client).apply(migration, { timeoutMs: 100 })).resolves.toMatchObject({
      state: 'conflicting_checksum',
      status: { actual: 'different', expected: migration.checksum },
    })
  })
})

describe('revisioned catalog tooling', () => {
  it('diffs pinned catalogs and emits advisory TypeScript bindings', () => {
    const before = snapshot('5', [{
      type: 'table', name: 'accounts', tableName: 'accounts', sql: 'CREATE TABLE accounts (id INTEGER)',
      columns: [{ cid: 0, name: 'id', declaredType: 'INTEGER', notNull: true, defaultSql: null, primaryKeyOrdinal: 1, hidden: 0 }],
    }])
    const after = snapshot('7', [{
      type: 'table', name: 'accounts', tableName: 'accounts', sql: 'CREATE TABLE accounts (id INTEGER, email TEXT)',
      columns: [
        { cid: 0, name: 'id', declaredType: 'INTEGER', notNull: true, defaultSql: null, primaryKeyOrdinal: 1, hidden: 0 },
        { cid: 1, name: 'email', declaredType: 'TEXT', notNull: false, defaultSql: null, primaryKeyOrdinal: 0, hidden: 0 },
      ],
    }])
    expect(diffCatalogs(before, after)).toMatchObject({ fromRevision: '5', toRevision: '7', added: [], removed: [], changed: [{ before: { name: 'accounts' }, after: { name: 'accounts' } }] })
    expect(generateTypeScriptBindings(after)).toContain('readonly "email": string | null')
    expect(generateTypeScriptBindings(after)).toContain('// Generated advisory bindings')
  })
})

function query(rows: readonly (readonly unknown[])[]) {
  return { revision, result: { rows, columns: [], truncated: false, consensusSafe: false, raw: { rows: [], columns: [], truncated: false, consensusSafe: false } } }
}

function outcome(type: 'accepted' | 'rejected'): TransactionOutcome {
  return {
    transactionId: 'loser',
    phase: type,
    outcome: type === 'accepted'
      ? { type: 'accepted', result: { envelopeVersion: 1, digest: 'digest', byteLength: 1 } }
      : { type: 'rejected', attribution: { phase: 'precondition', code: 'SQL_ASSERTION_FALSE', preconditionId: 1, preconditionIndex: 0, statementIndex: null, constraintIdentity: null, triggerIdentity: null } },
    eventSetRevision: '11',
    materializedRevision: '8',
    changedByReplay: false,
    admissible: true,
    observedAt: '2026-01-01T00:00:00.000Z',
  }
}

function evidence(result: TransactionOutcome, confidence: SettlementEvidence['confidence']): SettlementEvidence {
  return {
    transactionId: result.transactionId,
    outcome: result,
    evidenceRevision: '11',
    orderKey: 'order',
    authorTimestamp: '1',
    validationPolicyId: 'policy',
    membershipRevision: 'membership',
    blockingHeartbeats: [],
    unresolvedReferences: [],
    historyReopeningEvents: [],
    confidence,
    calculatedAt: '2026-01-01T00:00:00.000Z',
  }
}

function snapshot(materializedRevision: string, objects: CatalogSnapshot['objects']): CatalogSnapshot {
  return { revision: { ...revision, materializedRevision }, objects, digest: materializedRevision.padStart(64, '0') }
}
