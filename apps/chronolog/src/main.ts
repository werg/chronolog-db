import { readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'

import {
  ChronologClient,
  defineMutation,
  defineQuery,
  fromBase64Url,
  generateSchemaBindingModule,
  type DecodedCanonicalResult,
  type MutationKind,
} from '@chronolog/client'
import { decodeMutation, decodeQuery, encodeLogicalValues, values, type LogicalValue } from '@chronolog/ir'
import { HttpRpcTransport } from '@chronolog/rpc'

interface QuerySpec {
  /** Unpadded base64url canonical IR, or @path to canonical CBOR bytes. */
  readonly ir: string
  readonly parameterNames?: readonly string[]
  readonly parameters?: readonly JsonLogicalValue[]
  readonly label?: string
}

interface ObservationSpec extends QuerySpec { readonly expect?: boolean }
interface MutationSpec {
  /** Must agree with the canonical mutation's kind. */
  readonly kind: MutationKind
  /** Unpadded base64url canonical IR, or @path to canonical CBOR bytes. */
  readonly ir: string
  readonly label?: string
}

interface TransactionSpec {
  readonly assertions?: readonly QuerySpec[]
  readonly observations?: readonly ObservationSpec[]
  readonly mutations: readonly MutationSpec[]
  readonly wait?: boolean
  readonly idempotencyKey?: string
}

type JsonLogicalValue =
  | null
  | boolean
  | string
  | { readonly $int64: string }
  | { readonly $decimal: { readonly coefficient: string; readonly scale: number } }
  | { readonly $blob: string }
  | { readonly $uuid: string }
  | { readonly $timestampMs: string }
  | { readonly $durationMs: string }
  | { readonly $json: unknown }
  | { readonly $vector: { readonly element: 'i8' | 'u8' | 'i16' | 'i32' | 'f32' | 'f64'; readonly dimensions: number; readonly base64: string } }

const args = process.argv.slice(2)
const command = args.shift()
if (!command || command === 'help' || command === '--help') usage(command ? 0 : 1)

if (command === 'schema-generate') {
  const schemaSource = requiredArg(args.shift(), 'schema-generate SCHEMA_CBOR OUTPUT_TS --execution-manifest EXECUTION_CBOR')
  const outputPath = requiredArg(args.shift(), 'schema-generate SCHEMA_CBOR OUTPUT_TS --execution-manifest EXECUTION_CBOR')
  const executionOption = requiredArg(args.shift(), 'schema-generate SCHEMA_CBOR OUTPUT_TS --execution-manifest EXECUTION_CBOR')
  const executionSource = requiredArg(args.shift(), 'schema-generate SCHEMA_CBOR OUTPUT_TS --execution-manifest EXECUTION_CBOR')
  if (args.length !== 0) throw new Error('schema-generate received unexpected arguments')
  const canonicalSchema = await loadCanonicalBytes(schemaSource)
  const generated = executionOption === '--execution-manifest'
    ? await generateSchemaBindingModule(canonicalSchema, {
        executionManifest: await loadCanonicalBytes(executionSource),
      })
    : executionOption === '--execution-digest' ? await generateSchemaBindingModule(canonicalSchema, {
        executionManifestDigest: executionSource,
      })
      : (() => { throw new Error('schema-generate requires --execution-manifest or --execution-digest') })()
  if (outputPath === '-') process.stdout.write(generated.source)
  else await writeFile(resolve(outputPath), generated.source, { encoding: 'utf8' })
  process.exit(0)
}

const defaults = await localDefaults()
const groupId = process.env.CHRONOLOG_GROUP_ID ?? defaults.groupId
if (!groupId) throw new Error('Set CHRONOLOG_GROUP_ID or start chronologd with the default data directory')
const client = new ChronologClient({
  groupId,
  transport: new HttpRpcTransport({
    baseUrl: process.env.CHRONOLOG_URL ?? 'http://127.0.0.1:8787',
    ...(process.env.CHRONOLOG_TOKEN === undefined ? {} : { token: process.env.CHRONOLOG_TOKEN }),
  }),
})

try {
  switch (command) {
    case 'status':
      output(await client.getStatus())
      break
    case 'query': {
      const source = requiredArg(args.shift(), 'query QUERY_IR_OR_@FILE')
      const parameterNames = args[0] === undefined ? [] : stringArray(JSON.parse(args[0]))
      const inputParameters = args[1] === undefined ? [] : JSON.parse(args[1]) as JsonLogicalValue[]
      const parameters = logicalValues(inputParameters)
      const binding = await queryBinding({ ir: source, parameterNames, parameters: inputParameters })
      const result = await client.query(binding, parameters)
      output({ revision: result.revision, rows: result.result, resultDigest: result.canonical.resultDigest })
      break
    }
    case 'local-sql': {
      const sql = requiredArg(args.shift(), 'local-sql SQL')
      const result = await client.queryLocalSql(sql)
      output({ revision: result.revision, result: result.result, consensusSafe: false })
      break
    }
    case 'transact': {
      const source = requiredArg(args.shift(), 'transact SPEC_JSON_OR_@FILE')
      const spec = JSON.parse(await inlineOrFile(source)) as TransactionSpec
      if (!Array.isArray(spec.mutations) || spec.mutations.length === 0) throw new Error('Transaction spec requires mutations')
      const assertions = await Promise.all((spec.assertions ?? []).map(assertionBinding))
      const observations = await Promise.all((spec.observations ?? []).map(async (item) => ({
        item,
        binding: await queryBinding(item),
        parameters: logicalValues(item.parameters ?? []),
      })))
      const mutations = await Promise.all(spec.mutations.map(mutationBinding))
      const handle = await client.transaction(async (draft) => {
        for (const assertion of assertions) {
          draft.assert(assertion.binding, assertion.parameters, labelOptions(assertion.item.label))
        }
        for (const observation of observations) {
          const observed = await draft.observe(
            observation.binding,
            observation.parameters,
            labelOptions(observation.item.label),
          )
          if (observation.item.expect !== false) draft.expect(observed, labelOptions(observation.item.label))
        }
        for (const mutation of mutations) draft.mutate(mutation)
      }, spec.idempotencyKey === undefined ? {} : { idempotencyKey: spec.idempotencyKey })
      if (spec.wait === true) {
        const outcome = await waitForOutcome(handle.transactionId)
        output({ publication: handle.publication, outcome })
      } else output(handle.publication)
      break
    }
    case 'outcome':
      output(await client.getTransactionOutcome(requiredArg(args.shift(), 'outcome TRANSACTION_ID')))
      break
    case 'evidence':
      output(await client.getSettlementEvidence(requiredArg(args.shift(), 'evidence TRANSACTION_ID')))
      break
    case 'watermark':
      output(await client.validatorWatermark())
      break
    case 'replication':
      output(await client.getReplicationStatus())
      break
    default:
      process.stderr.write(`Unknown command: ${command}\n`)
      usage(1)
  }
} finally {
  await client.close()
}

async function queryBinding(spec: QuerySpec) {
  const canonicalBytes = await loadCanonicalBytes(spec.ir)
  const query = decodeQuery(canonicalBytes)
  const parameters = logicalValues(spec.parameters ?? [])
  const names = spec.parameterNames ?? []
  if (names.length !== parameters.length) throw new Error('parameterNames and parameters must have equal length')
  return defineQuery({
    canonicalBytes,
    resultMode: query.resultMode.kind,
    parameterNames: names,
    encodeParameters: (input: readonly LogicalValue[]) => encodeLogicalValues(input),
    decodeResult: (result: DecodedCanonicalResult) => result.rows,
  })
}

async function assertionBinding(item: QuerySpec) {
  const canonicalBytes = await loadCanonicalBytes(item.ir)
  const query = decodeQuery(canonicalBytes)
  if (query.resultMode.kind !== 'scalar') throw new Error('Assertion query must use scalar result mode')
  const parameters = logicalValues(item.parameters ?? [])
  const names = item.parameterNames ?? []
  if (names.length !== parameters.length) throw new Error('parameterNames and parameters must have equal length')
  return {
    item,
    parameters,
    binding: defineQuery({
      canonicalBytes,
      resultMode: 'scalar',
      parameterNames: names,
      encodeParameters: (input: readonly LogicalValue[]) => encodeLogicalValues(input),
      decodeResult: (result: DecodedCanonicalResult) => {
        const value = result.rows[0]?.[0]
        if (typeof value !== 'boolean') throw new Error('Assertion query must return one boolean value')
        return value
      },
    }),
  }
}

async function mutationBinding(spec: MutationSpec) {
  const canonicalBytes = await loadCanonicalBytes(spec.ir)
  const mutation = decodeMutation(canonicalBytes)
  const actualKind = mutation.kind === 'stateful_call' ? 'registered_call' : mutation.kind
  if (actualKind !== spec.kind) throw new Error(`Mutation kind is ${actualKind}, not ${spec.kind}`)
  return defineMutation(spec.kind, canonicalBytes, spec.label)
}

async function waitForOutcome(transactionId: string) {
  const deadline = Date.now() + 30_000
  while (true) {
    const outcome = await client.getTransactionOutcome(transactionId)
    if (outcome.outcome.type !== 'pending') return outcome
    if (Date.now() >= deadline) return outcome
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
  }
}

function logicalValues(input: unknown): readonly LogicalValue[] {
  if (!Array.isArray(input)) throw new Error('Logical parameters must be a JSON array')
  return input.map(logicalValue)
}

function logicalValue(value: JsonLogicalValue): LogicalValue {
  if (value === null) return values.null()
  if (typeof value === 'boolean') return values.boolean(value)
  if (typeof value === 'string') return values.text(value)
  if ('$int64' in value) return values.int64(BigInt(value.$int64))
  if ('$decimal' in value) return values.decimal(BigInt(value.$decimal.coefficient), value.$decimal.scale)
  if ('$blob' in value) return values.blob(Uint8Array.from(Buffer.from(value.$blob, 'base64')))
  if ('$uuid' in value) return values.uuid(fromBase64Url(value.$uuid))
  if ('$timestampMs' in value) return values.timestampMs(BigInt(value.$timestampMs))
  if ('$durationMs' in value) return values.durationMs(BigInt(value.$durationMs))
  if ('$json' in value) return values.json(jsonValue(value.$json))
  if ('$vector' in value) return values.vector(
    value.$vector.element,
    value.$vector.dimensions,
    Uint8Array.from(Buffer.from(value.$vector.base64, 'base64')),
  )
  throw new Error('Unsupported logical parameter')
}

function jsonValue(value: unknown): Parameters<typeof values.json>[0] {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error('JSON numbers must use {$int64:string} or {$decimal:{coefficient,scale}}')
    return BigInt(value)
  }
  if (Array.isArray(value)) return value.map(jsonValue)
  if (typeof value === 'object') {
    const entries = new Map<string, Parameters<typeof values.json>[0]>()
    for (const [key, item] of Object.entries(value)) entries.set(key, jsonValue(item))
    return entries
  }
  throw new Error('Unsupported canonical JSON value')
}

async function loadCanonicalBytes(source: string): Promise<Uint8Array> {
  return source.startsWith('@')
    ? Uint8Array.from(await readFile(resolve(source.slice(1))))
    : fromBase64Url(source)
}

function stringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error('Parameter names must be a JSON string array')
  }
  return value as readonly string[]
}

function labelOptions(label: string | undefined): { readonly applicationLabel?: string } {
  return label === undefined ? {} : { applicationLabel: label }
}

async function inlineOrFile(value: string): Promise<string> {
  return value.startsWith('@') ? readFile(resolve(value.slice(1)), 'utf8') : value
}

async function localDefaults(): Promise<{ readonly groupId?: string }> {
  try {
    const path = join(resolve(process.env.CHRONOLOG_DATA_DIR ?? '.chronolog'), 'config.json')
    const config = JSON.parse(await readFile(path, 'utf8')) as { readonly groupId?: string }
    return config.groupId === undefined
      ? {}
      : { groupId: Buffer.from(config.groupId, 'base64').toString('base64url') }
  } catch {
    return {}
  }
}

function requiredArg(value: string | undefined, expected: string): string {
  if (value === undefined) throw new Error(`Usage: chronolog ${expected}`)
  return value
}

function output(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === 'bigint') return { $integer: item.toString(10) }
    if (item instanceof Uint8Array) return { $blob: Buffer.from(item).toString('base64') }
    return item
  }, 2)}\n`)
}

function usage(exitCode: number): never {
  process.stderr.write(`Usage:
  chronolog status
  chronolog schema-generate @SCHEMA_CBOR OUTPUT_TS --execution-manifest @EXECUTION_CBOR
  chronolog schema-generate @SCHEMA_CBOR OUTPUT_TS --execution-digest BASE64URL
  chronolog query QUERY_IR_OR_@FILE [PARAMETER_NAMES_JSON] [LOGICAL_PARAMETERS_JSON]
  chronolog local-sql SQL
  chronolog transact SPEC_JSON_OR_@FILE
  chronolog outcome TRANSACTION_ID
  chronolog evidence TRANSACTION_ID
  chronolog watermark
  chronolog replication

Consensus commands accept canonical typed IR only. Raw SQL is available solely
through local-sql and is marked non-consensus-safe. Transaction specs contain
assertions and/or expected observations plus canonical mutations.
`)
  process.exit(exitCode)
}
