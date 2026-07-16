import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

import { ChronologClient, type ClientSqlBindings, type ClientSqlValue } from '@chronolog/client'
import {
  MigrationManager,
  defineMigration,
  diffCatalogs,
  generateTypeScriptBindings,
  inspectCatalog,
  type MigrationDefinition,
} from '@chronolog/migrations'
import { HttpRpcTransport } from '@chronolog/rpc'

interface SqlSpec {
  readonly sql: string
  readonly bindings?: readonly JsonSqlValue[] | Readonly<Record<string, JsonSqlValue>>
  readonly label?: string
}
interface ObservationSpec extends SqlSpec { readonly expect?: boolean; readonly resultMode?: 'scalar' | 'ordered' | 'multiset' | 'set' }
interface TransactionSpec {
  readonly assertions?: readonly SqlSpec[]
  readonly observations?: readonly ObservationSpec[]
  readonly statements: readonly SqlSpec[]
  readonly wait?: boolean
  readonly idempotencyKey?: string
}
interface MigrationSpec {
  readonly component: string
  readonly id: string
  readonly version: number
  readonly checksum?: string
  readonly statements: readonly SqlSpec[]
}
type JsonSqlValue = null | boolean | number | string | { readonly $int64: string } | { readonly $blob: string }
interface CapabilitySpec {
  readonly subjectId: string
  readonly signingPublicKey: string
  readonly transportAuthor?: string
  readonly role: 'reader' | 'writer' | 'validator' | 'administrator' | 'schema-administrator'
  readonly validUntilRevision?: string
  readonly organization?: string
  readonly validatorClass?: string
  readonly minimumAuthorTimestampMs?: string
  readonly readerScope?: 'snapshot' | 'audit'
  readonly hpkePublicKey?: string
}

const args = process.argv.slice(2)
const command = args.shift()
if (command === undefined || command === 'help' || command === '--help') usage(command === undefined ? 1 : 0)

const defaults = await localDefaults()
const groupId = process.env.CHRONOLOG_GROUP_ID ?? defaults.groupId
if (groupId === undefined) throw new Error('Set CHRONOLOG_GROUP_ID or start chronologd with the default data directory')
const baseUrl = process.env.CHRONOLOG_URL ?? 'http://127.0.0.1:8787'
const transport = new HttpRpcTransport({
  baseUrl,
  ...(process.env.CHRONOLOG_TOKEN === undefined ? {} : { token: process.env.CHRONOLOG_TOKEN }),
})
const client = new ChronologClient({
  groupId,
  transport,
})

try {
  switch (command) {
    case 'status': output(await client.getStatus()); break
    case 'query': {
      const sql = requiredArg(args.shift(), 'query SQL [PARAMETERS_JSON]')
      const parameters = args[0] === undefined ? [] : jsonBindings(JSON.parse(args[0]))
      if (!Array.isArray(parameters)) throw new Error('Local query parameters must be a JSON array')
      output(await client.query(sql, parameters))
      break
    }
    case 'transact': {
      const spec = JSON.parse(await inlineOrFile(requiredArg(args.shift(), 'transact SPEC_JSON_OR_@FILE'))) as TransactionSpec
      if (!Array.isArray(spec.statements) || spec.statements.length === 0) throw new Error('Transaction spec requires statements')
      const handle = await client.transaction(async (tx) => {
        for (const assertion of spec.assertions ?? []) tx.assert(assertion.sql, jsonBindings(assertion.bindings ?? []), labelOptions(assertion.label))
        for (const observation of spec.observations ?? []) {
          const observed = await tx.observe(observation.sql, jsonBindings(observation.bindings ?? []), {
            resultMode: observation.resultMode ?? 'ordered',
            ...labelOptions(observation.label),
          })
          if (observation.expect !== false) tx.expect(observed, labelOptions(observation.label))
        }
        tx.exec(spec.statements.map((statement) => ({ sql: statement.sql, parameters: jsonBindings(statement.bindings ?? []) })))
      }, spec.idempotencyKey === undefined ? {} : { idempotencyKey: spec.idempotencyKey })
      output(spec.wait === true ? { publication: handle.publication, outcome: await waitForOutcome(handle.transactionId) } : handle.publication)
      break
    }
    case 'outcome': output(await client.getTransactionOutcome(requiredArg(args.shift(), 'outcome TRANSACTION_ID'))); break
    case 'result': output(await client.getTransactionResult(requiredArg(args.shift(), 'result TRANSACTION_ID'))); break
    case 'evidence': output(await client.getSettlementEvidence(requiredArg(args.shift(), 'evidence TRANSACTION_ID'))); break
    case 'watermark': output(await client.validatorWatermark()); break
    case 'replication': output(await client.getReplicationStatus()); break
    case 'doctor': {
      const [healthResponse, status, replication] = await Promise.all([
        fetch(`${baseUrl.replace(/\/$/u, '')}/health`),
        client.getStatus(),
        client.getReplicationStatus(),
      ])
      const health = await healthResponse.json() as { readonly ok?: unknown; readonly lastError?: unknown }
      let governance: unknown
      try { governance = await transport.unary('governance.getStatus', { groupId, requestId: randomUUID() }) }
      catch (error) { governance = { unavailable: error instanceof Error ? error.message : String(error) } }
      const checks = {
        health: healthResponse.ok && health.ok === true,
        nodeReady: status.state === 'ready' && status.writable,
        replication: replication.feedsWithGaps === 0 && replication.quarantinedFeeds.length === 0 && replication.state !== 'degraded',
        governance: typeof governance === 'object' && governance !== null && !('unavailable' in governance),
      }
      const ok = Object.values(checks).every(Boolean)
      output({ ok, checks, status, replication, governance, health })
      if (!ok) process.exitCode = 2
      break
    }
    case 'governance': {
      const operation = requiredArg(args.shift(), 'governance <status|grant|revoke|rotate|history|recover> ...')
      const base = { groupId, requestId: randomUUID() }
      if (operation === 'status') output(await transport.unary('governance.getStatus', base))
      else if (operation === 'grant') {
        const spec = JSON.parse(await inlineOrFile(requiredArg(args.shift(), 'governance grant SPEC_JSON_OR_@FILE'))) as CapabilitySpec
        output(await transport.unary('governance.grantCapability', { ...base, ...spec }))
      } else if (operation === 'revoke') {
        if (args.length === 0) throw new Error('Usage: chronolog governance revoke CAPABILITY_ID [...]')
        output(await transport.unary('governance.revokeCapabilities', { ...base, capabilityIds: args }))
      } else if (operation === 'rotate') {
        output(await transport.unary('governance.rotateEpoch', base))
      } else if (operation === 'history') {
        output(await transport.unary('governance.grantHistoricalAccess', {
          ...base,
          subjectId: requiredArg(args.shift(), 'governance history SUBJECT_ID'),
        }))
      } else if (operation === 'recover') {
        const encoded = (await inlineOrFile(requiredArg(args.shift(), 'governance recover BASE64URL_OR_@FILE'))).trim()
        output(await transport.unary('governance.publishRecovery', { ...base, canonicalRecoveryRecord: encoded }))
      } else throw new Error(`Unknown governance operation: ${operation}`)
      break
    }
    case 'migrations': {
      const migrations = new MigrationManager(client)
      const operation = requiredArg(args.shift(), 'migrations <status|apply|wait> ...')
      if (operation === 'wait') {
        const transactionId = requiredArg(args.shift(), 'migrations wait TRANSACTION_ID [--watermark]')
        output(await migrations.wait(transactionId, { requireWatermark: args.includes('--watermark') }))
        break
      }
      const migration = await migrationFrom(requiredArg(args.shift(), `migrations ${operation} SPEC_JSON_OR_@FILE`))
      if (operation === 'status') output(await migrations.status(migration))
      else if (operation === 'apply') output(await migrations.apply(migration, { requireWatermark: args.includes('--watermark') }))
      else throw new Error(`Unknown migrations operation: ${operation}`)
      break
    }
    case 'catalog': {
      const operation = requiredArg(args.shift(), 'catalog <inspect|diff|bindings> ...')
      if (operation === 'diff') {
        const before = await inspectCatalog(client, requiredArg(args.shift(), 'catalog diff FROM_REVISION TO_REVISION'))
        const after = await inspectCatalog(client, requiredArg(args.shift(), 'catalog diff FROM_REVISION TO_REVISION'))
        output(diffCatalogs(before, after))
      } else {
        const snapshot = await inspectCatalog(client, args.shift())
        if (operation === 'inspect') output(snapshot)
        else if (operation === 'bindings') process.stdout.write(generateTypeScriptBindings(snapshot))
        else throw new Error(`Unknown catalog operation: ${operation}`)
      }
      break
    }
    default: process.stderr.write(`Unknown command: ${command}\n`); usage(1)
  }
} finally {
  await client.close()
}

function jsonBindings(value: unknown): ClientSqlBindings {
  if (Array.isArray(value)) return value.map(jsonValue)
  if (typeof value !== 'object' || value === null) throw new Error('SQL bindings must be an array or object')
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsonValue(item)]))
}

function jsonValue(value: unknown): ClientSqlValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') return value
  if (typeof value !== 'object') throw new Error('Unsupported SQL binding value')
  if ('$int64' in value && typeof value.$int64 === 'string') return BigInt(value.$int64)
  if ('$blob' in value && typeof value.$blob === 'string') return Uint8Array.from(Buffer.from(value.$blob, 'base64url'))
  throw new Error('Unsupported SQL binding value')
}

async function waitForOutcome(transactionId: string) {
  const deadline = Date.now() + 30_000
  while (true) {
    const outcome = await client.getTransactionOutcome(transactionId)
    if (outcome.outcome.type !== 'pending' || Date.now() >= deadline) return outcome
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

async function localDefaults(): Promise<{ readonly groupId?: string }> {
  try {
    const dataDirectory = process.env.CHRONOLOG_DATA_DIR ?? '.chronolog'
    const config = JSON.parse(await readFile(join(dataDirectory, 'config.json'), 'utf8')) as { readonly groupId?: string }
    return config.groupId === undefined ? {} : { groupId: Buffer.from(config.groupId, 'base64').toString('base64url') }
  } catch { return {} }
}

async function inlineOrFile(value: string): Promise<string> { return value.startsWith('@') ? readFile(value.slice(1), 'utf8') : value }
async function migrationFrom(value: string): Promise<MigrationDefinition> {
  const raw: unknown = JSON.parse(await inlineOrFile(value))
  if (typeof raw !== 'object' || raw === null) throw new Error('Migration spec must be an object')
  const spec = raw as Omit<MigrationSpec, 'statements'> & { readonly statements?: unknown }
  if (!Array.isArray(spec.statements)) throw new Error('Migration spec requires statements')
  const statements = (spec.statements as readonly unknown[]).map((rawStatement) => {
    if (typeof rawStatement !== 'object' || rawStatement === null || typeof (rawStatement as { sql?: unknown }).sql !== 'string') {
      throw new Error('Migration statements require SQL')
    }
    const statement = rawStatement as SqlSpec
    return { sql: statement.sql, parameters: jsonBindings(statement.bindings ?? []) }
  })
  return defineMigration({
    component: spec.component,
    id: spec.id,
    version: spec.version,
    statements,
    ...(spec.checksum === undefined ? {} : { checksum: spec.checksum }),
  })
}
function requiredArg(value: string | undefined, usageText: string): string { if (value === undefined) throw new Error(`Usage: chronolog ${usageText}`); return value }
function labelOptions(label?: string): { readonly applicationLabel?: string } { return label === undefined ? {} : { applicationLabel: label } }
function output(value: unknown): void { process.stdout.write(`${JSON.stringify(value, jsonReplacer, 2)}\n`) }
function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString(10)
  if (value instanceof Uint8Array) return Buffer.from(value).toString('base64url')
  return value
}
function usage(code: number): never {
  process.stderr.write('Usage: chronolog <status|doctor|query|transact|outcome|result|evidence|watermark|replication|governance|migrations|catalog> ...\n')
  process.exit(code)
}
