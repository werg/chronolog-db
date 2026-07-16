import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ChronologClient, DraftStatementHandle } from '@chronolog/client'
import { createCoreExecutionManifest } from '@chronolog/compiler-sqlite'
import {
  DeterministicMaterializer,
  createDoltLiteMaterializationRuntime,
  readNativeEngineInfo,
} from '@chronolog/materializer-doltlite'
import {
  MigrationManager,
  defineMigration,
  diffCatalogs,
  generateTypeScriptBindings,
  inspectCatalog,
  schemaVersionAssumption,
} from '@chronolog/migrations'
import { ChronologNode, type MembershipResolver } from '@chronolog/node-core'
import { equalBytes, generateEd25519KeyPair } from '@chronolog/protocol'
import { InProcessRpcTransport, NodeRpcService } from '@chronolog/rpc'
import { MemoryTransportNetwork } from '@chronolog/transport-ssb'
import { afterEach, describe, expect, it } from 'vitest'

import { chaosBootstrapStatements, schemaVersionPrecondition } from '../packages/chaos/src/schema.js'
import { migrationChainStatements, migrationRollbackStatements } from '../packages/chaos/src/workload.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

describe('SQL client → RPC → node → reducer', () => {
  it('publishes observation-backed SQL and retrieves the accepted RETURNING envelope', async () => {
    const { client, node } = await runtime()
    const bootstrap = await client.transaction((tx) => {
      tx.assert('SELECT 1')
      tx.exec([
        { sql: 'CREATE TABLE accounts (id INTEGER PRIMARY KEY, balance INTEGER NOT NULL) STRICT' },
        { sql: 'INSERT INTO accounts VALUES (:id, :balance)', parameters: { id: 1n, balance: 100n } },
      ])
    })
    expect((await terminal(client, bootstrap.transactionId)).outcome.type).toBe('accepted')
    expect((await client.query('SELECT balance FROM accounts WHERE id = ?', [1n])).result.rows).toEqual([[100n]])

    let statementHandle: DraftStatementHandle | undefined
    const update = await client.transaction(async (tx) => {
      const observed = await tx.observe(
        'SELECT balance FROM accounts WHERE id = :id',
        { id: 1n },
        { resultMode: 'scalar', applicationLabel: 'account balance' },
      )
      expect(observed.result.rows).toEqual([[100n]])
      tx.expect(observed)
      statementHandle = tx.exec(
        'UPDATE accounts SET balance = :next WHERE id = :id RETURNING id, balance',
        { next: 90n, id: 1n },
      )
    })
    const outcome = await terminal(client, update.transactionId)
    expect(outcome.outcome).toMatchObject({ type: 'accepted', result: { envelopeVersion: 1 } })
    const accepted = await update.getResult({ atMaterializedRevision: outcome.materializedRevision })
    const statement = update.statement(accepted, statementHandle!)
    expect(statement).toMatchObject({ index: 0, statementClass: 'update', affectedRows: 1n })
    expect(statement.result?.mode).toBe('multiset')
    expect(statement.result?.rows).toEqual([[
      { kind: 'integer', value: 1n },
      { kind: 'integer', value: 90n },
    ]])
    expect(() => update.statement(accepted, new DraftStatementHandle('another-draft', 0))).toThrow(
      'different transaction draft',
    )
    expect((await client.query('SELECT balance FROM accounts WHERE id = ?', [1n])).result.rows).toEqual([[90n]])

    const core = node.candidateCore(new TextEncoder().encode(update.transactionId))
    expect(core?.program.body[0]?.sql).toBe('UPDATE accounts SET balance = :next WHERE id = :id RETURNING id, balance')
    expect(core).not.toHaveProperty('schemaDigest')
  })

  it('preserves no-result, empty-result, Null-row, affected-count, handle, and revision distinctions', async () => {
    const { client } = await runtime()
    let handles: readonly DraftStatementHandle[] = []
    const transaction = await client.transaction((tx) => {
      tx.assert('SELECT 1')
      handles = tx.exec([
        { sql: 'CREATE TABLE result_shapes (id INTEGER PRIMARY KEY, value TEXT) STRICT' },
        { sql: "INSERT INTO result_shapes VALUES (1, 'one')" },
        { sql: 'UPDATE result_shapes SET value = value WHERE id = 99 RETURNING value' },
        { sql: 'SELECT NULL AS absent_value' },
        { sql: "UPDATE result_shapes SET value = 'next' WHERE id = 1" },
      ])
    })
    const outcome = await terminal(client, transaction.transactionId)
    expect(outcome.outcome.type).toBe('accepted')
    const snapshot = await transaction.getResult({ atMaterializedRevision: outcome.materializedRevision })

    expect(transaction.statement(snapshot, handles[0]!)).toMatchObject({
      index: 0, statementClass: 'schema', affectedRows: null, result: null,
    })
    expect(transaction.statement(snapshot, handles[1]!)).toMatchObject({
      index: 1, statementClass: 'insert', affectedRows: 1n, result: null,
    })
    expect(transaction.statement(snapshot, handles[2]!)).toMatchObject({
      index: 2, statementClass: 'update', affectedRows: 0n,
      result: { mode: 'multiset', rows: [] },
    })
    expect(transaction.statement(snapshot, handles[3]!)).toMatchObject({
      index: 3, statementClass: 'read', affectedRows: null,
      result: { mode: 'multiset', rows: [[{ kind: 'null' }]] },
    })
    expect(transaction.statement(snapshot, handles[4]!)).toMatchObject({
      index: 4, statementClass: 'update', affectedRows: 1n, result: null,
    })

    let invalidated: DraftStatementHandle | undefined
    await expect(client.transaction((tx) => {
      tx.assert('SELECT 1')
      invalidated = tx.exec('SELECT 1')
    })).rejects.toMatchObject({ code: 'protocol_rejected' })
    expect(() => invalidated!.statementIndex).toThrow('no longer valid')

    const advancing = await client.transaction((tx) => {
      tx.assert('SELECT 1')
      tx.exec("UPDATE result_shapes SET value = 'latest' WHERE id = 1")
    })
    await terminal(client, advancing.transactionId)
    await expect(transaction.getResult({ atMaterializedRevision: outcome.materializedRevision })).rejects.toMatchObject({
      code: 'revision_not_retained',
    })
    const currentSnapshot = await transaction.getResult()
    expect(currentSnapshot.digest).toBe(snapshot.digest)
    expect(currentSnapshot.revision.materializedRevision).not.toBe(snapshot.revision.materializedRevision)
  })

  it('attributes precondition and statement failures, rolls back partial work, and exposes no rejected result', async () => {
    const { client } = await runtime()
    const bootstrap = await client.transaction((tx) => {
      tx.assert('SELECT 1')
      tx.exec([
        { sql: 'CREATE TABLE guarded_values (id INTEGER PRIMARY KEY, value INTEGER NOT NULL) STRICT' },
        { sql: 'INSERT INTO guarded_values VALUES (1, 10)' },
      ])
    })
    await terminal(client, bootstrap.transactionId)

    const failedStatement = await client.transaction((tx) => {
      tx.assert('SELECT 1')
      tx.exec([
        { sql: 'UPDATE guarded_values SET value = 20 WHERE id = 1 RETURNING value' },
        { sql: 'INSERT INTO guarded_values VALUES (1, 30)' },
      ])
    })
    const statementOutcome = await terminal(client, failedStatement.transactionId)
    expect(statementOutcome.outcome).toEqual({
      type: 'rejected',
      attribution: {
        phase: 'statement',
        code: 'SQL_CONSTRAINT_VIOLATION',
        preconditionId: null,
        preconditionIndex: null,
        statementIndex: 1,
        constraintIdentity: null,
        triggerIdentity: null,
      },
    })
    await expect(failedStatement.getResult()).rejects.toMatchObject({ code: 'result_not_available' })
    expect((await client.query('SELECT value FROM guarded_values WHERE id = 1')).result.rows).toEqual([[10n]])

    const failedPrecondition = await client.transaction((tx) => {
      tx.assert('SELECT value = 99 FROM guarded_values WHERE id = 1', [], { applicationLabel: 'value must be 99' })
      tx.exec('UPDATE guarded_values SET value = 99 WHERE id = 1')
    })
    const preconditionOutcome = await terminal(client, failedPrecondition.transactionId)
    expect(preconditionOutcome.outcome).toMatchObject({
      type: 'rejected',
      attribution: {
        phase: 'precondition',
        code: 'SQL_ASSERTION_FALSE',
        preconditionIndex: 0,
        statementIndex: null,
        constraintIdentity: null,
        triggerIdentity: null,
        applicationLabel: 'value must be 99',
      },
    })
    if (preconditionOutcome.outcome.type === 'rejected') {
      expect(preconditionOutcome.outcome.attribution.preconditionId).not.toBeNull()
    }
    await expect(failedPrecondition.getResult()).rejects.toMatchObject({ code: 'result_not_available' })
    expect((await client.query('SELECT value FROM guarded_values WHERE id = 1')).result.rows).toEqual([[10n]])
  })

  it('round-trips every portable SQLite storage class and keeps local display truncation non-consensus', async () => {
    const { client } = await runtime()
    let returning: DraftStatementHandle | undefined
    const transaction = await client.transaction((tx) => {
      tx.assert('SELECT 1')
      tx.exec('CREATE TABLE dynamic_values (value)')
      returning = tx.exec(
        "INSERT INTO dynamic_values VALUES (NULL), (42), (1.5), ('Grüße'), (X'00FF') RETURNING value",
      )
      tx.exec('ALTER TABLE dynamic_values ADD COLUMN note TEXT')
    })
    const outcome = await terminal(client, transaction.transactionId)
    const snapshot = await transaction.getResult({ atMaterializedRevision: outcome.materializedRevision })
    const statement = transaction.statement(snapshot, returning!)
    expect(statement.result).toMatchObject({
      mode: 'multiset',
      columns: [{ type: { kind: 'dynamic' }, nullable: 'unknown' }],
    })
    expect(statement.result?.rows).toEqual([
      [{ kind: 'null' }],
      [{ kind: 'integer', value: 42n }],
      [{ kind: 'real', bits: Uint8Array.of(63, 248, 0, 0, 0, 0, 0, 0) }],
      [{ kind: 'text', utf8: new TextEncoder().encode('Grüße') }],
      [{ kind: 'blob', bytes: Uint8Array.of(0, 255) }],
    ])

    const complete = await client.query('SELECT value, note FROM dynamic_values ORDER BY rowid')
    expect(complete.result.rows).toEqual([
      [null, null], [42n, null], [1.5, null], ['Grüße', null], [Uint8Array.of(0, 255), null],
    ])
    const displayLimited = await client.query('SELECT value FROM dynamic_values ORDER BY rowid', [], { maxRows: 2 })
    expect(displayLimited.result.rows).toEqual([[null], [42n]])
    expect(displayLimited.result.truncated).toBe(true)
    expect((await transaction.getResult()).digest).toBe(snapshot.digest)
  })

  it('executes ordered target subsets end to end and reports a runtime safety gate by statement index', async () => {
    const { client } = await runtime()
    const bootstrap = await client.transaction((tx) => {
      tx.assert('SELECT 1')
      tx.exec([
        { sql: 'CREATE TABLE ranked_live (id INTEGER PRIMARY KEY, score INTEGER NOT NULL, picked INTEGER NOT NULL) STRICT' },
        { sql: 'INSERT INTO ranked_live VALUES (1, 10, 0), (2, 20, 0), (3, 10, 0), (4, 30, 0)' },
      ])
    })
    await terminal(client, bootstrap.transactionId)

    let orderedHandle: DraftStatementHandle | undefined
    const ordered = await client.transaction((tx) => {
      tx.assert('SELECT 1')
      orderedHandle = tx.exec(
        'UPDATE ranked_live SET picked = 1 WHERE picked = 0 RETURNING id ORDER BY score DESC LIMIT ? OFFSET ?',
        [2n, 1n],
      )
    })
    const orderedOutcome = await terminal(client, ordered.transactionId)
    const orderedResult = await ordered.getResult({ atMaterializedRevision: orderedOutcome.materializedRevision })
    expect(ordered.statement(orderedResult, orderedHandle!)).toMatchObject({
      affectedRows: 2n,
      result: {
        mode: 'multiset',
        rows: [[{ kind: 'integer', value: 1n }], [{ kind: 'integer', value: 2n }]],
      },
    })
    expect((await client.query('SELECT id FROM ranked_live WHERE picked = 1 ORDER BY id')).result.rows).toEqual([[1n], [2n]])

    const trigger = await client.transaction((tx) => {
      tx.assert('SELECT 1')
      tx.exec('CREATE TRIGGER ranked_live_audit AFTER UPDATE ON ranked_live BEGIN SELECT 1; END')
    })
    await terminal(client, trigger.transactionId)
    const gated = await client.transaction((tx) => {
      tx.assert('SELECT 1')
      tx.exec('UPDATE ranked_live SET picked = 0 ORDER BY score LIMIT 1')
    })
    expect((await terminal(client, gated.transactionId)).outcome).toMatchObject({
      type: 'rejected',
      attribution: {
        phase: 'statement',
        code: 'SQL_ORDERED_MUTATION_TRIGGER_GATED',
        statementIndex: 0,
      },
    })
    expect((await client.query('SELECT id FROM ranked_live WHERE picked = 1 ORDER BY id')).result.rows).toEqual([[1n], [2n]])
  })

  it('runs versioned migrations, schema assumptions, mixed clients, and atomic migration rollback end to end', async () => {
    const { client } = await runtime()
    const bootstrap = await client.transaction((tx) => {
      tx.assert('SELECT 1')
      tx.exec(chaosBootstrapStatements(2))
    })
    expect((await terminal(client, bootstrap.transactionId)).outcome.type).toBe('accepted')

    const prefix = 'chaos_migrate_e2e'
    const schema = schemaVersionPrecondition('profiles', 2)
    const migration = await client.transaction((tx) => {
      tx.assert(schema.sql, schema.parameters, { applicationLabel: schema.applicationLabel })
      tx.exec(migrationChainStatements(prefix))
    })
    const migrationOutcome = await terminal(client, migration.transactionId)
    expect(migrationOutcome.outcome.type).toBe('accepted')
    const migrationResult = await migration.getResult()
    expect(migrationResult.envelope.statements).toHaveLength(20)
    expect(migrationResult.envelope.statements[8]?.result?.rows).toHaveLength(2)
    expect(migrationResult.envelope.statements[18]?.result?.rows).toHaveLength(3)
    expect(migrationResult.envelope.statements[19]?.result?.rows).toHaveLength(1)
    expect((await client.query(
      'SELECT version FROM chaos_schema_migrations WHERE component = ? ORDER BY version',
      [prefix],
    )).result.rows).toEqual([[1n], [2n]])
    expect((await client.query(
      "SELECT name FROM sqlite_schema WHERE name LIKE 'chaos_migrate_e2e_%' ORDER BY name",
    )).result.rows.map((row) => row[0])).toEqual([
      `${prefix}_audit`,
      `${prefix}_current_idx`,
      `${prefix}_current_trigger`,
      `${prefix}_current_view`,
      `${prefix}_items`,
    ])

    const legacySchema = schemaVersionPrecondition('profiles', 1)
    const legacy = await client.transaction((tx) => {
      tx.assert(legacySchema.sql, legacySchema.parameters, { applicationLabel: legacySchema.applicationLabel })
      tx.exec("INSERT INTO chaos_profiles (profile_id, display_name) VALUES ('legacy-e2e', 'Legacy')")
    })
    const current = await client.transaction((tx) => {
      tx.assert(schema.sql, schema.parameters, { applicationLabel: schema.applicationLabel })
      tx.exec("INSERT INTO chaos_profiles (profile_id, display_name, email, schema_version) VALUES ('current-e2e', 'Current', 'current@example.test', 2)")
    })
    expect((await terminal(client, legacy.transactionId)).outcome.type).toBe('accepted')
    expect((await terminal(client, current.transactionId)).outcome.type).toBe('accepted')
    expect((await client.query('SELECT profile_id, schema_version, email_seen FROM chaos_profile_audit ORDER BY profile_id')).result.rows).toEqual([
      ['current-e2e', 2n, 1n],
      ['legacy-e2e', 2n, 0n],
    ])

    const rollbackPrefix = 'chaos_rollback_e2e'
    const rollback = await client.transaction((tx) => {
      tx.assert(schema.sql, schema.parameters, { applicationLabel: schema.applicationLabel })
      tx.exec(migrationRollbackStatements(rollbackPrefix))
    })
    expect((await terminal(client, rollback.transactionId)).outcome).toMatchObject({
      type: 'rejected',
      attribution: { phase: 'statement', code: 'SQL_CONSTRAINT_VIOLATION', statementIndex: 5 },
    })
    await expect(rollback.getResult()).rejects.toMatchObject({ code: 'result_not_available' })
    expect((await client.query('SELECT name FROM sqlite_schema WHERE name LIKE ?', [`${rollbackPrefix}%`])).result.rows).toEqual([])
    expect((await client.query('SELECT version FROM chaos_schema_migrations WHERE component = ?', [rollbackPrefix])).result.rows).toEqual([])
  })

  it('applies application migrations idempotently, detects conflicts, and exposes pinned catalog changes', async () => {
    const { client } = await runtime()
    const manager = new MigrationManager(client)
    const first = defineMigration({
      component: 'profiles',
      id: 'profiles-v1',
      version: 1,
      statements: [
        { sql: 'CREATE TABLE profiles (id INTEGER PRIMARY KEY, display_name TEXT NOT NULL) STRICT' },
        { sql: "INSERT INTO profiles VALUES (1, 'Ada')" },
      ],
    })
    const [firstApply, concurrentApply] = await Promise.all([manager.apply(first), manager.apply(first)])
    expect([firstApply.state, concurrentApply.state].every((state) => state === 'accepted' || state === 'already_applied')).toBe(true)
    expect([firstApply.state, concurrentApply.state]).toContain('accepted')
    await expect(manager.apply(first)).resolves.toMatchObject({ state: 'already_applied' })

    const before = await inspectCatalog(client)
    const migrationChanges = manager.migrationChanges()
    const schemaChanges = manager.schemaChanges()
    const unsubscribeMigrations = migrationChanges.subscribe(() => undefined)
    const unsubscribeSchema = schemaChanges.subscribe(() => undefined)
    const second = defineMigration({
      component: 'profiles',
      id: 'profiles-v2-email',
      version: 2,
      statements: [
        { sql: 'ALTER TABLE profiles ADD COLUMN email TEXT' },
        { sql: "UPDATE profiles SET email = 'ada@example.test' WHERE id = 1" },
      ],
    })
    expect((await manager.apply(second)).state).toBe('accepted')
    await waitFor(() => migrationChanges.getSnapshot().value?.result?.rows.some((row) => row[2] === 2n) === true)
    await waitFor(() => schemaChanges.getSnapshot().value?.revision.materializedRevision !== before.revision.materializedRevision)

    const after = await inspectCatalog(client)
    expect(diffCatalogs(before, after).changed.map((change) => change.after.name)).toContain('profiles')
    expect(generateTypeScriptBindings(after)).toContain('readonly "email": string | null')

    const exact = schemaVersionAssumption('profiles', { exact: 2, checksum: second.checksum })
    const minimum = schemaVersionAssumption('profiles', { minimum: 1 })
    const oldClient = await client.transaction((tx) => {
      tx.assert(minimum.sql, minimum.parameters ?? [], { applicationLabel: minimum.applicationLabel })
      tx.exec("INSERT INTO profiles (id, display_name) VALUES (2, 'Grace')")
    })
    const newClient = await client.transaction((tx) => {
      tx.assert(exact.sql, exact.parameters ?? [], { applicationLabel: exact.applicationLabel })
      tx.exec("INSERT INTO profiles (id, display_name, email) VALUES (3, 'Lin', 'lin@example.test')")
    })
    expect((await terminal(client, oldClient.transactionId)).outcome.type).toBe('accepted')
    expect((await terminal(client, newClient.transactionId)).outcome.type).toBe('accepted')

    const conflicting = defineMigration({
      component: 'profiles', id: 'profiles-v2-email', version: 2,
      statements: [{ sql: 'ALTER TABLE profiles ADD COLUMN email BLOB' }],
    })
    await expect(manager.apply(conflicting)).resolves.toMatchObject({ state: 'conflicting_checksum' })

    const rejected = defineMigration({
      component: 'profiles', id: 'profiles-v3-rejected', version: 3,
      statements: [
        { sql: 'CREATE TABLE migration_must_rollback (id INTEGER PRIMARY KEY) STRICT' },
        { sql: 'INSERT INTO migration_must_rollback VALUES (1), (1)' },
      ],
    })
    await expect(manager.apply(rejected)).resolves.toMatchObject({ state: 'rejected' })
    expect((await client.query("SELECT name FROM sqlite_schema WHERE name = 'migration_must_rollback'")).result.rows).toEqual([])
    expect((await manager.status(rejected)).state).toBe('pending')
    unsubscribeMigrations()
    unsubscribeSchema()
    migrationChanges.dispose()
    schemaChanges.dispose()
  })

  it('publishes replay changes through live SQL, outcome resources, and revisioned result availability', async () => {
    let now = 10_000
    const { client, node } = await runtime({ clockNow: () => now })
    const bootstrap = await client.transaction((tx) => {
      tx.assert('SELECT 1')
      tx.exec([
        { sql: 'CREATE TABLE replay_accounts (id INTEGER PRIMARY KEY, balance INTEGER NOT NULL) STRICT' },
        { sql: 'INSERT INTO replay_accounts VALUES (1, 100)' },
      ])
    })
    await terminal(client, bootstrap.transactionId)

    const live = client.liveQuery('SELECT balance FROM replay_accounts WHERE id = 1')
    const unsubscribeLive = live.subscribe(() => undefined)
    await waitFor(() => live.getSnapshot().value?.result?.rows[0]?.[0] === 100n)

    now += 1
    const later = await client.transaction((tx) => {
      tx.assert('SELECT balance = 100 FROM replay_accounts WHERE id = 1')
      tx.exec('UPDATE replay_accounts SET balance = 90 WHERE id = 1 RETURNING balance')
    })
    const accepted = await terminal(client, later.transactionId)
    expect(accepted.outcome.type).toBe('accepted')
    const acceptedResult = await later.getResult({ atMaterializedRevision: accepted.materializedRevision })
    expect(acceptedResult.envelope.statements[0]?.result?.rows).toEqual([[{ kind: 'integer', value: 90n }]])
    await waitFor(() => live.getSnapshot().value?.result?.rows[0]?.[0] === 90n)

    const outcomeResource = later.outcome
    const unsubscribeOutcome = outcomeResource.subscribe(() => undefined)
    await waitFor(() => outcomeResource.getSnapshot().value?.outcome.type === 'accepted')

    const bootstrapTimestamp = node.candidateCore(new TextEncoder().encode(bootstrap.transactionId))!.authorTimestampMs
    const predecessor = await node.publish({
      authorTimestampMs: bootstrapTimestamp,
      program: {
        version: 1,
        preconditions: [{
          id: 700,
          query: { sql: 'SELECT 1', bindings: [] },
          resultMode: 'scalar',
          expectation: { kind: 'assert_true' },
        }],
        body: [{ sql: 'UPDATE replay_accounts SET balance = 80 WHERE id = 1', bindings: [] }],
      },
    })
    expect((await terminal(client, predecessor.txIdText)).outcome.type).toBe('accepted')
    await waitFor(() => outcomeResource.getSnapshot().value?.outcome.type === 'rejected')
    expect(outcomeResource.getSnapshot().value).toMatchObject({
      changedByReplay: true,
      outcome: { type: 'rejected', attribution: { phase: 'precondition', code: 'SQL_ASSERTION_FALSE' } },
    })
    await waitFor(() => live.getSnapshot().value?.result?.rows[0]?.[0] === 80n)
    await expect(later.getResult()).rejects.toMatchObject({ code: 'result_not_available' })
    expect((await client.query('SELECT balance FROM replay_accounts WHERE id = 1')).result.rows).toEqual([[80n]])

    unsubscribeOutcome()
    unsubscribeLive()
  })
})

async function terminal(client: ChronologClient, transactionId: string) {
  const deadline = Date.now() + 5_000
  while (true) {
    const outcome = await client.getTransactionOutcome(transactionId)
    if (outcome.outcome.type !== 'pending') return outcome
    if (Date.now() >= deadline) throw new Error('transaction did not settle')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition did not become true')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

async function runtime(options: { readonly clockNow?: () => number } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'chronolog-sql-client-'))
  const identity = await generateEd25519KeyPair()
  const groupId = bytes32(1)
  const membershipRevision = bytes32(2)
  const validationPolicy = bytes32(3)
  const capability = bytes32(4)
  const native = readNativeEngineInfo()
  const materializer = await DeterministicMaterializer.open({
    path: join(directory, 'application.db'),
    executionManifest: createCoreExecutionManifest({ profile: 'chronolog-core-portable', engine: native.descriptor, engineDigest: native.digest }),
  })
  const membership: MembershipResolver = {
    canWrite: ({ writerId }) => equalBytes(writerId, identity.publicKeyBytes),
    canValidate: ({ validatorId, validatorCapability }) => equalBytes(validatorId, identity.publicKeyBytes) && equalBytes(validatorCapability, capability),
    threshold: () => 1,
  }
  const node = new ChronologNode({
    groupId, membershipRevision, validationPolicy, identity,
    transport: new MemoryTransportNetwork().createNode('sql-client'),
    materialization: createDoltLiteMaterializationRuntime(materializer),
    membership,
    ...(options.clockNow === undefined ? {} : { clock: { now: options.clockNow } }),
    validator: { capabilityId: capability, cutoffLagMs: Number.MAX_SAFE_INTEGER },
  })
  await node.start()
  const client = new ChronologClient({
    groupId: Buffer.from(groupId).toString('base64url'),
    transport: new InProcessRpcTransport(new NodeRpcService({ node })),
    bindings: { executionManifestDigest: Buffer.from(materializer.executionManifestDigest).toString('base64url') },
  })
  cleanup.push(async () => { await client.close(); await node.close(); await rm(directory, { recursive: true, force: true }) })
  return { client, node }
}
function bytes32(seed: number): Uint8Array { return Uint8Array.from({ length: 32 }, (_value, index) => (seed + index) & 0xff) }
