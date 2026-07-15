import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { ChronologClient, type ClientSqlBindings, type ClientSqlValue } from '@chronolog/client'
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
type JsonSqlValue = null | boolean | number | string | { readonly $int64: string } | { readonly $blob: string }

const args = process.argv.slice(2)
const command = args.shift()
if (command === undefined || command === 'help' || command === '--help') usage(command === undefined ? 1 : 0)

const defaults = await localDefaults()
const groupId = process.env.CHRONOLOG_GROUP_ID ?? defaults.groupId
if (groupId === undefined) throw new Error('Set CHRONOLOG_GROUP_ID or start chronologd with the default data directory')
const client = new ChronologClient({
  groupId,
  transport: new HttpRpcTransport({
    baseUrl: process.env.CHRONOLOG_URL ?? 'http://127.0.0.1:8787',
    ...(process.env.CHRONOLOG_TOKEN === undefined ? {} : { token: process.env.CHRONOLOG_TOKEN }),
  }),
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
function requiredArg(value: string | undefined, usageText: string): string { if (value === undefined) throw new Error(`Usage: chronolog ${usageText}`); return value }
function labelOptions(label?: string): { readonly applicationLabel?: string } { return label === undefined ? {} : { applicationLabel: label } }
function output(value: unknown): void { process.stdout.write(`${JSON.stringify(value, jsonReplacer, 2)}\n`) }
function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString(10)
  if (value instanceof Uint8Array) return Buffer.from(value).toString('base64url')
  return value
}
function usage(code: number): never {
  process.stderr.write('Usage: chronolog <status|query|transact|outcome|result|evidence|watermark|replication> ...\n')
  process.exit(code)
}
