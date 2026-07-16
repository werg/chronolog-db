import { createHash } from 'node:crypto'

import { isChronologRpcError, type DecodedLocalSqlValue } from '@chronolog/client'

import type { RunArtifacts } from './artifacts.js'
import type { ChaosCluster } from './cluster.js'
import { schemaQuery, stateQuery, transactionLogQuery } from './schema.js'
import type { NodeSnapshot, WorkloadExpectation } from './types.js'

interface InvariantResult {
  readonly name: string
  readonly passed: boolean
  readonly details?: string
}

export interface ConvergenceResult {
  readonly snapshots: readonly NodeSnapshot[]
  readonly invariants: readonly InvariantResult[]
}

export async function waitForConvergence(options: {
  readonly cluster: ChaosCluster
  readonly artifacts: RunArtifacts
  readonly timeoutMs: number
  readonly expectations: readonly WorkloadExpectation[]
  readonly resultSampleSize: number
}): Promise<ConvergenceResult> {
  const transactionIds = options.expectations.map((expectation) => expectation.transactionId)
  const deadline = Date.now() + options.timeoutMs
  let last: readonly NodeSnapshot[] = []
  let stable = 0
  let previousSignature = ''
  let lastError: unknown
  let coverage = { admitted: 0, excluded: 0, unresolved: transactionIds.length }
  while (Date.now() < deadline) {
    try {
      last = await Promise.all(options.cluster.clients().map(({ name, client }) => snapshotNode(name, client)))
      const signature = last.map((snapshot) => `${snapshot.node}:${snapshot.stateDigest}:${snapshot.schemaDigest}:${snapshot.logDigest}:${snapshot.publishedOrderLength}`).join('|')
      const converged = same(last.map((snapshot) => snapshot.stateDigest)) &&
        same(last.map((snapshot) => snapshot.schemaDigest)) &&
        same(last.map((snapshot) => snapshot.logDigest)) &&
        same(last.map((snapshot) => snapshot.publishedOrderLength)) &&
        last.every((snapshot) => !snapshot.replaying && snapshot.pendingPayloads === 0 && backlogSettled(snapshot) && !snapshot.materializationPending)
      stable = converged && signature === previousSignature ? stable + 1 : converged ? 1 : 0
      previousSignature = signature
      if (stable >= 3) {
        coverage = await transactionCoverage(options.cluster, transactionIds, last[0]?.logRows ?? [])
        if (coverage.unresolved === 0) break
      }
    } catch (error) { lastError = error; stable = 0 }
    await delay(500)
  }
  if (stable < 3 || coverage.unresolved > 0) {
    if (last.length > 0) {
      await options.artifacts.writeJson('snapshots.last.json', last)
      try { coverage = await transactionCoverage(options.cluster, transactionIds, last[0]?.logRows ?? []) } catch { /* Keep the last successful coverage. */ }
    }
    const nodes = last.map((snapshot) => `${snapshot.node}:status=${snapshot.status}${snapshot.lastErrorCode ? `(${snapshot.lastErrorCode})` : ''},state=${snapshot.stateDigest.slice(0, 10)},schema=${snapshot.schemaDigest.slice(0, 10)},log=${snapshot.logDigest.slice(0, 10)},order=${snapshot.publishedOrderLength},peers=${snapshot.connectedPeers}/${snapshot.knownPeers},payloads=${snapshot.pendingPayloads},ingest=${snapshot.ingestionBacklog},materializing=${snapshot.materializationPending}`).join(';')
    const details = `stable=${stable},admitted=${coverage.admitted},excluded=${coverage.excluded},unresolved=${coverage.unresolved}${nodes.length > 0 ? `,nodes=[${nodes}]` : ''}${lastError instanceof Error ? `,lastError=${lastError.message}` : ''}`
    await options.artifacts.record({ type: 'invariant', phase: 'failure', name: 'convergence_timeout', details: { explanation: details } })
    throw new Error(`CHAOS_CONVERGENCE_TIMEOUT:${details}`)
  }

  const snapshot = last[0]!
  const logRows = snapshot.logRows
  const terminalOutcomes = logRows.every((row) => row[4] === 'accepted' || (typeof row[4] === 'string' && row[4].startsWith('rejected_')))
  const ledger = checkLedgerConsistency(snapshot.stateRows)
  const envelopes = checkResultEnvelopeMetadata(logRows)
  const outcomes = checkExpectedOutcomes(options.expectations, logRows)
  const rollback = checkRollbackSentinels(snapshot.stateRows)
  const migrations = checkMigrationConsistency(snapshot.stateRows, snapshot.schemaRows, options.expectations, logRows)
  const resultRetrieval = await checkTransactionResults(options.cluster, options.expectations, logRows, options.resultSampleSize)
  const invariants: InvariantResult[] = [
    { name: 'application_state_converged', passed: same(last.map((value) => value.stateDigest)) },
    { name: 'application_schema_converged', passed: same(last.map((value) => value.schemaDigest)) },
    { name: 'transaction_log_converged', passed: same(last.map((value) => value.logDigest)) },
    { name: 'transaction_order_length_converged', passed: same(last.map((value) => value.publishedOrderLength)) },
    {
      name: 'all_published_transactions_resolved',
      passed: coverage.unresolved === 0,
      details: `${coverage.admitted} admitted, ${coverage.excluded} excluded below validator watermark, ${coverage.unresolved} unresolved`,
    },
    { name: 'all_outcomes_terminal', passed: terminalOutcomes },
    { name: 'ledger_matches_account_balances_and_versions', ...ledger },
    { name: 'result_envelope_metadata_is_well_formed', ...envelopes },
    { name: 'workload_outcomes_match_intent', ...outcomes },
    { name: 'rejected_transactions_rolled_back', ...rollback },
    { name: 'migrations_and_mixed_schema_clients_are_consistent', ...migrations },
    { name: 'sampled_transaction_results_match_outcomes', ...resultRetrieval },
    { name: 'workload_made_progress', passed: transactionIds.length > 0, ...(transactionIds.length > 0 ? {} : { details: 'No transaction was published' }) },
  ]
  for (const invariant of invariants) {
    await options.artifacts.record({
      type: 'invariant', phase: invariant.passed ? 'success' : 'failure', name: invariant.name,
      ...(invariant.details === undefined ? {} : { details: { explanation: invariant.details } }),
    })
  }
  return { snapshots: last, invariants }
}

async function snapshotNode(
  node: NodeSnapshot['node'],
  client: ReturnType<ChaosCluster['client']>,
): Promise<NodeSnapshot> {
  const [status, replication, state, schema, log] = await Promise.all([
    client.getStatus(),
    client.getReplicationStatus(),
    client.query(stateQuery().sql),
    client.query(schemaQuery().sql),
    client.query(transactionLogQuery().sql),
  ])
  if (!status.revision) throw new Error(`CHAOS_NODE_NOT_READY:${node}`)
  return {
    node,
    status: status.state,
    ...(status.lastErrorCode === undefined ? {} : { lastErrorCode: status.lastErrorCode }),
    stateDigest: rowsDigest(state.result.rows),
    schemaDigest: rowsDigest(schema.result.rows),
    logDigest: rowsDigest(log.result.rows),
    stateRows: state.result.rows.map(normalizeRow),
    schemaRows: schema.result.rows.map(normalizeRow),
    logRows: log.result.rows.map(normalizeRow),
    eventSetRevision: status.revision.eventSetRevision,
    materializedRevision: status.revision.materializedRevision,
    publishedOrderLength: status.revision.publishedOrderLength,
    replaying: status.revision.replaying,
    connectedPeers: replication.connectedPeers,
    knownPeers: replication.knownPeers,
    pendingPayloads: replication.pendingPayloads,
    ingestionBacklog: replication.ingestionBacklog,
    materializationPending: replication.materializationPending,
  }
}

export function checkLedgerConsistency(stateRows: readonly (readonly unknown[])[]): Pick<InvariantResult, 'passed' | 'details'> {
  const accounts = new Map<string, { balance: bigint; version: bigint }>()
  const ledger = new Map<string, { delta: bigint; entries: bigint }>()
  try {
    for (const row of stateRows) {
      if (row[0] === '0') accounts.set(String(row[1]), { balance: BigInt(String(row[3])), version: BigInt(String(row[4])) })
      if (row[0] === '1') {
        const account = String(row[3])
        const current = ledger.get(account) ?? { delta: 0n, entries: 0n }
        current.delta += BigInt(String(row[4]))
        if (row[1] !== '__reserved_constraint_key__') current.entries += 1n
        ledger.set(account, current)
      }
    }
  } catch (error) {
    return { passed: false, details: `Could not decode state rows: ${error instanceof Error ? error.message : String(error)}` }
  }
  const mismatches: string[] = []
  for (const [account, actual] of accounts) {
    const expected = ledger.get(account) ?? { delta: 0n, entries: 0n }
    if (actual.balance !== expected.delta || actual.version !== expected.entries) {
      mismatches.push(`${account}: balance=${actual.balance}/${expected.delta}, version=${actual.version}/${expected.entries}`)
    }
  }
  return mismatches.length === 0
    ? { passed: accounts.size > 0, details: `${accounts.size} accounts reconciled against ${[...ledger.values()].reduce((sum, row) => sum + Number(row.entries), 0)} ledger legs` }
    : { passed: false, details: mismatches.slice(0, 8).join('; ') }
}

function checkResultEnvelopeMetadata(logRows: readonly (readonly unknown[])[]): Pick<InvariantResult, 'passed' | 'details'> {
  const malformed = logRows.filter((row) => row[4] === 'accepted'
    ? row[5] !== null || row[6] === null || row[7] !== '1' || typeof row[8] !== 'string' || BigInt(row[8]) <= 0n || row.slice(9).some((value) => value !== null)
    : row[6] !== null || row[7] !== null || row[8] !== null || row[5] === null || !validFailureAttribution(row))
  return malformed.length === 0
    ? { passed: true, details: `${logRows.length} terminal rows checked` }
    : { passed: false, details: `${malformed.length} malformed rows; first tx=${bytesText(malformed[0]?.[0])}` }
}

function validFailureAttribution(row: readonly unknown[]): boolean {
  if (row[9] === 'precondition') return row[10] !== null && row[11] !== null && row[12] === null && row[13] === null && row[14] === null
  if (row[9] === 'statement') return row[10] === null && row[11] === null && row[12] !== null
  if (row[9] === 'finalize') return row[10] === null && row[11] === null && row[12] === null
  return false
}

function checkExpectedOutcomes(expectations: readonly WorkloadExpectation[], logRows: readonly (readonly unknown[])[]): Pick<InvariantResult, 'passed' | 'details'> {
  const byId = new Map(logRows.map((row) => [bytesText(row[0]), row]))
  const mismatches: string[] = []
  let checked = 0
  for (const expectation of expectations) {
    const row = byId.get(Buffer.from(expectation.transactionId).toString('base64url'))
    if (row === undefined) continue
    checked += 1
    const outcome = String(row[4])
    if (!expectation.allowedOutcomes.includes(outcome as WorkloadExpectation['allowedOutcomes'][number])) {
      mismatches.push(`${expectation.operation}:${outcome}`)
    } else if (expectation.rejectionCode !== undefined && row[5] !== expectation.rejectionCode) {
      mismatches.push(`${expectation.operation}:${outcome}/${String(row[5])}`)
    } else if (expectation.failingStatementIndex !== undefined && row[12] !== String(expectation.failingStatementIndex)) {
      mismatches.push(`${expectation.operation}:${outcome}/statement-${String(row[12])}`)
    }
  }
  return mismatches.length === 0
    ? { passed: true, details: `${checked} admitted workload outcomes checked` }
    : { passed: false, details: `${mismatches.length} unexpected outcomes: ${mismatches.slice(0, 8).join(', ')}` }
}

function checkRollbackSentinels(stateRows: readonly (readonly unknown[])[]): Pick<InvariantResult, 'passed' | 'details'> {
  const accounts = stateRows.filter((row) => row[0] === '0')
  const polluted = accounts.filter((row) => BigInt(String(row[5])) >= 1_000_000n)
  const reserved = stateRows.filter((row) => row[0] === '1' && row[1] === '__reserved_constraint_key__')
  const passed = polluted.length === 0 && reserved.length === 1
  return { passed, details: passed ? 'No rejection sentinel escaped rollback' : `${polluted.length} polluted accounts, ${reserved.length} reserved ledger rows` }
}

export function checkMigrationConsistency(
  stateRows: readonly (readonly unknown[])[],
  schemaRows: readonly (readonly unknown[])[],
  expectations: readonly WorkloadExpectation[],
  logRows: readonly (readonly unknown[])[],
): Pick<InvariantResult, 'passed' | 'details'> {
  const schemaNames = new Set(schemaRows.map((row) => String(row[1])))
  const profiles = new Map(stateRows.filter((row) => row[0] === '3').map((row) => [String(row[1]), row]))
  const audits = new Map(stateRows.filter((row) => row[0] === '4').map((row) => [String(row[1]), row]))
  const migrations = new Set(stateRows.filter((row) => row[0] === '5').map((row) => `${String(row[1])}:${String(row[2])}`))
  const logById = new Map(logRows.map((row) => [bytesText(row[0]), row]))
  const failures: string[] = []
  for (const required of ['chaos_profiles_display_name_idx', 'chaos_profiles_current', 'chaos_profiles_insert_audit']) {
    if (!schemaNames.has(required)) failures.push(`base schema missing ${required}`)
  }
  if (!migrations.has('profiles:1') || !migrations.has('profiles:2')) failures.push('profiles migration history is incomplete')
  let chains = 0
  let rollbacks = 0
  let legacyClients = 0
  let currentClients = 0
  for (const expectation of expectations) {
    const log = logById.get(transactionKey(expectation.transactionId))
    if (log === undefined) continue
    const accepted = log[4] === 'accepted'
    if (expectation.operation === 'migration_chain' && accepted) {
      chains += 1
      const prefix = expectation.migrationPrefix!
      for (const name of [`${prefix}_items`, `${prefix}_audit`, `${prefix}_current_idx`, `${prefix}_current_view`, `${prefix}_current_trigger`]) {
        if (!schemaNames.has(name)) failures.push(`${prefix} missing ${name}`)
      }
      for (const retired of [`${prefix}_legacy_idx`, `${prefix}_legacy_view`, `${prefix}_legacy_trigger`]) {
        if (schemaNames.has(retired)) failures.push(`${prefix} retained ${retired}`)
      }
      if (!migrations.has(`${prefix}:1`) || !migrations.has(`${prefix}:2`)) failures.push(`${prefix} migration history is incomplete`)
    }
    if (expectation.operation === 'migration_rollback') {
      rollbacks += 1
      const prefix = expectation.migrationPrefix!
      if ([...schemaNames].some((name) => name.startsWith(prefix)) || [...migrations].some((value) => value.startsWith(`${prefix}:`))) {
        failures.push(`${prefix} leaked rolled-back schema or history`)
      }
    }
    if ((expectation.operation === 'legacy_client_write' || expectation.operation === 'current_client_write') && accepted) {
      const profile = profiles.get(expectation.operationId)
      const audit = audits.get(expectation.operationId)
      const current = expectation.operation === 'current_client_write'
      if (current) currentClients += 1
      else legacyClients += 1
      if (profile === undefined || profile[2] !== '2') failures.push(`${expectation.operationId} missing v2-compatible profile`)
      if (audit === undefined || audit[2] !== '2' || audit[3] !== (current ? '1' : '0')) failures.push(`${expectation.operationId} has invalid migration audit`)
      if (typeof profile?.[6] !== 'string' || (current ? !profile[6].includes('@example.test') : !profile[6].endsWith('|'))) {
        failures.push(`${expectation.operationId} has invalid legacy/current projection`)
      }
    }
  }
  if (chains === 0) failures.push('no migration chain was admitted')
  if (rollbacks === 0) failures.push('no rollback migration was admitted')
  if (legacyClients === 0) failures.push('no legacy-schema client write was accepted')
  if (currentClients === 0) failures.push('no current-schema client write was accepted')
  const checked = `${chains} chains, ${rollbacks} rollbacks, ${legacyClients} legacy and ${currentClients} current writes`
  return failures.length === 0
    ? { passed: true, details: checked }
    : { passed: false, details: `${checked}; ${failures.slice(0, 10).join('; ')}` }
}

async function checkTransactionResults(
  cluster: ChaosCluster,
  expectations: readonly WorkloadExpectation[],
  logRows: readonly (readonly unknown[])[],
  sampleSize: number,
): Promise<Pick<InvariantResult, 'passed' | 'details'>> {
  const logById = new Map(logRows.map((row) => [bytesText(row[0]), row]))
  const admitted = expectations.filter((expectation) => logById.has(transactionKey(expectation.transactionId)))
  const accepted = admitted.filter((expectation) => logById.get(transactionKey(expectation.transactionId))?.[4] === 'accepted')
  const rejected = admitted.filter((expectation) => logById.get(transactionKey(expectation.transactionId))?.[4] !== 'accepted')
  const sample = stratifiedSample(accepted, rejected, sampleSize)
  const failures: string[] = []
  const client = cluster.clients()[0]?.client
  if (client === undefined) return { passed: false, details: 'No client available for result retrieval' }
  await mapConcurrent(sample, 8, async (expectation) => {
    const row = logById.get(transactionKey(expectation.transactionId))!
    const outcome = row[4]
    try {
      const result = await client.getTransactionResult(expectation.transactionId)
      if (outcome !== 'accepted') failures.push(`${expectation.operation}:rejected result was retrievable`)
      else {
        const shapeError = validateAcceptedEnvelope(expectation, result.envelope)
        if (result.envelope.version !== 1 || result.digest.length === 0) failures.push(`${expectation.operation}:invalid accepted envelope`)
        else if (result.digest !== bytesText(row[6])) failures.push(`${expectation.operation}:RPC/protected-log digest mismatch`)
        else if (shapeError !== undefined) failures.push(`${expectation.operation}:${shapeError}`)
      }
    } catch (error) {
      if (outcome === 'accepted' || !isChronologRpcError(error) || error.code !== 'result_not_available') {
        failures.push(`${expectation.operation}:${error instanceof Error ? error.message : String(error)}`)
      }
    }
  })
  return failures.length === 0
    ? { passed: true, details: `${sample.length} results checked (${sample.filter((value) => accepted.includes(value)).length} accepted)` }
    : { passed: false, details: `${failures.length} retrieval failures: ${failures.slice(0, 8).join('; ')}` }
}

function stratifiedSample<T extends WorkloadExpectation>(accepted: readonly T[], rejected: readonly T[], limit: number): T[] {
  const result: T[] = []
  const remaining = new Set([...accepted, ...rejected])
  for (const candidate of [...accepted, ...rejected]) {
    if (result.some((value) => value.operation === candidate.operation)) continue
    result.push(candidate)
    remaining.delete(candidate)
    if (result.length === limit) return result
  }
  const acceptedRemaining = accepted.filter((value) => remaining.has(value))
  const rejectedRemaining = rejected.filter((value) => remaining.has(value))
  for (let index = 0; result.length < limit && index < Math.max(acceptedRemaining.length, rejectedRemaining.length); index += 1) {
    if (acceptedRemaining[index] !== undefined) result.push(acceptedRemaining[index]!)
    if (result.length < limit && rejectedRemaining[index] !== undefined) result.push(rejectedRemaining[index]!)
  }
  return result
}

function validateAcceptedEnvelope(
  expectation: WorkloadExpectation,
  envelope: Awaited<ReturnType<ReturnType<ChaosCluster['client']>['getTransactionResult']>>['envelope'],
): string | undefined {
  const expected = expectedEnvelopeShape(expectation.operation)
  if (envelope.preconditions.length !== expected.preconditions) return `expected ${expected.preconditions} preconditions, received ${envelope.preconditions.length}`
  if (envelope.statements.length !== expected.classes.length) return `expected ${expected.classes.length} statements, received ${envelope.statements.length}`
  for (let index = 0; index < expected.classes.length; index += 1) {
    const statement = envelope.statements[index]!
    if (statement.index !== index || statement.statementClass !== expected.classes[index]) return `statement ${index} class/index mismatch`
    const resultMode = statement.result === null ? null : statement.result.mode
    if (resultMode !== expected.modes[index]) return `statement ${index} result mode ${resultMode ?? 'null'} != ${expected.modes[index] ?? 'null'}`
  }
  if (expectation.operation === 'empty_returning' && envelope.statements[0]?.result?.rows.length !== 0) return 'empty RETURNING produced rows'
  if (expectation.operation === 'document_insert' && envelope.statements[0]?.result?.rows.length !== 1) return 'document RETURNING did not produce one row'
  if (expectation.operation === 'balance_update' && envelope.statements.some((statement) => statement.result?.rows.length !== 1)) return 'balance statement did not return one row'
  if (expectation.operation === 'transfer' && envelope.statements.some((statement) => statement.result?.rows.length !== 1)) return 'transfer statement did not return one row'
  if (expectation.operation === 'ddl_sequence' && envelope.statements[2]?.result?.rows.length !== 3) return 'DDL table_info did not return three columns'
  if (expectation.operation === 'migration_chain') {
    if (envelope.statements[8]?.result?.rows.length !== 2) return 'migration backfill did not return two rows'
    if (envelope.statements[18]?.result?.rows.length !== 3) return 'migrated table query did not return three rows'
    if (envelope.statements[19]?.result?.rows.length !== 1) return 'replacement trigger did not write one audit row'
  }
  return undefined
}

function expectedEnvelopeShape(operation: WorkloadExpectation['operation']): {
  readonly preconditions: number
  readonly classes: readonly ('read' | 'insert' | 'update' | 'schema')[]
  readonly modes: readonly ('ordered' | 'multiset' | null)[]
} {
  switch (operation) {
    case 'migration_chain': return {
      preconditions: 1,
      classes: ['schema', 'insert', 'insert', 'schema', 'schema', 'schema', 'schema', 'schema', 'update', 'schema', 'schema', 'schema', 'schema', 'schema', 'schema', 'schema', 'insert', 'insert', 'read', 'read'],
      modes: [null, 'multiset', null, null, null, null, null, null, 'multiset', null, null, null, null, null, null, null, null, 'multiset', 'ordered', 'ordered'],
    }
    case 'legacy_client_write': case 'current_client_write': return { preconditions: 1, classes: ['insert'], modes: ['multiset'] }
    case 'balance_update': return { preconditions: 1, classes: ['update', 'insert'], modes: ['multiset', 'multiset'] }
    case 'transfer': return { preconditions: 2, classes: ['update', 'update', 'insert', 'insert'], modes: ['multiset', 'multiset', 'multiset', 'multiset'] }
    case 'ordered_touch': case 'empty_returning': return { preconditions: 1, classes: ['update'], modes: ['multiset'] }
    case 'document_insert': return { preconditions: 1, classes: ['insert'], modes: ['multiset'] }
    case 'ddl_sequence': return { preconditions: 1, classes: ['schema', 'schema', 'read'], modes: [null, null, 'ordered'] }
    case 'migration_rollback': case 'precondition_rejection': case 'constraint_rejection': throw new Error(`Rejected operation unexpectedly accepted: ${operation}`)
  }
}

function transactionKey(transactionId: string): string { return Buffer.from(transactionId).toString('base64url') }

function normalizeRow(row: readonly DecodedLocalSqlValue[]): readonly unknown[] {
  return row.map((value) => value instanceof Uint8Array
    ? { bytes: Buffer.from(value).toString('base64url') }
    : typeof value === 'bigint' ? value.toString(10) : value)
}

function rowsDigest(rows: readonly (readonly DecodedLocalSqlValue[])[]): string {
  return createHash('sha256').update(JSON.stringify(rows.map(normalizeRow))).digest('base64url')
}

function bytesText(value: unknown): string {
  if (typeof value === 'object' && value !== null && 'bytes' in value && typeof (value as { bytes?: unknown }).bytes === 'string') {
    return (value as { bytes: string }).bytes
  }
  return String(value)
}

async function transactionCoverage(
  cluster: ChaosCluster,
  transactionIds: readonly string[],
  logRows: readonly (readonly unknown[])[],
): Promise<{ admitted: number; excluded: number; unresolved: number }> {
  const admittedIds = new Set(logRows.map((row) => bytesText(row[0])))
  const missing = transactionIds.filter((id) => !admittedIds.has(Buffer.from(id).toString('base64url')))
  let excluded = 0
  await mapConcurrent(missing, 16, async (transactionId) => {
    for (const { client } of cluster.clients()) {
      try {
        const evidence = await client.getSettlementEvidence(transactionId)
        if (evidence.confidence === 'policy_watermark_reached') { excluded += 1; return }
      } catch { /* A peer may not have received this candidate yet. */ }
    }
  })
  return { admitted: transactionIds.length - missing.length, excluded, unresolved: missing.length - excluded }
}

async function mapConcurrent<T>(values: readonly T[], concurrency: number, visit: (value: T) => Promise<void>): Promise<void> {
  let index = 0
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (index < values.length) {
      const value = values[index++]
      if (value !== undefined) await visit(value)
    }
  }))
}

function same(values: readonly string[]): boolean { return values.length > 0 && values.every((value) => value === values[0]) }
// Every remote validator emits a heartbeat once per second. A small durable
// tail is therefore normal even in a converged cluster; large or growing tails
// still identify reducer backpressure (the stress regression exceeded 400).
function backlogSettled(snapshot: NodeSnapshot): boolean {
  return snapshot.ingestionBacklog <= Math.max(4, snapshot.knownPeers * 2)
}
function delay(milliseconds: number): Promise<void> { return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds)) }
