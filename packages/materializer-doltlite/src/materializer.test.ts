import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createCoreExecutionManifest } from '@chronolog/compiler-sqlite'
import { deriveEntropy } from '@chronolog/kernels'
import {
  digestExecutionManifest,
  digestSchemaManifest,
  type CanonicalJsonValue,
  type Expr,
  type Mutation,
  type Precondition,
  type Query,
  type SchemaManifest,
} from '@chronolog/ir'
import { encodeTransactionCore, transactionDigest, type TransactionCore } from '@chronolog/protocol'
import { afterEach, describe, expect, it } from 'vitest'

import { DeterministicMaterializer } from './materializer.js'
import { readNativeEngineInfo } from './driver.js'
import type { AdmittedTransaction, LocalSqlValue } from './types.js'

const bytes = (...values: number[]) => Uint8Array.from(values)
const digestBytes = (seed: number) => Uint8Array.from({ length: 32 }, (_, index) => (seed + index) & 0xff)
const text = (value: string) => ({ kind: 'text' as const, utf8: new TextEncoder().encode(value) })

const executionManifest = createCoreExecutionManifest({
  profile: 'chronolog-core-tests-v1',
  engineDigest: readNativeEngineInfo().digest,
})

const schema: SchemaManifest = {
  version: 1,
  name: 'ledger_test',
  objects: [
    {
      kind: 'table', id: 1, name: 'accounts', declarationOrder: 0, withoutRowId: true,
      columns: [
        { id: 2, name: 'id', declarationOrder: 0, valueType: { logical: { kind: 'int64' }, nullable: false } },
        { id: 3, name: 'balance', declarationOrder: 1, valueType: { logical: { kind: 'int64' }, nullable: false } },
      ],
      constraints: [{ kind: 'primary_key', id: 4, name: 'accounts_pk', columnIds: [2] }],
    },
    {
      kind: 'table', id: 10, name: 'effects', declarationOrder: 1, withoutRowId: true,
      columns: [
        { id: 11, name: 'id', declarationOrder: 0, valueType: { logical: { kind: 'int64' }, nullable: false } },
        { id: 12, name: 'value', declarationOrder: 1, valueType: { logical: { kind: 'text', collation: 'binary' }, nullable: false } },
      ],
      constraints: [{ kind: 'primary_key', id: 13, name: 'effects_pk', columnIds: [11] }],
    },
    {
      kind: 'table', id: 20, name: 'typed_values', declarationOrder: 2, withoutRowId: true,
      columns: [
        { id: 21, name: 'id', declarationOrder: 0, valueType: { logical: { kind: 'int64' }, nullable: false } },
        { id: 22, name: 'amount', declarationOrder: 1, valueType: { logical: { kind: 'decimal', precision: 10, scale: 2 }, nullable: false } },
        { id: 23, name: 'payload', declarationOrder: 2, valueType: { logical: { kind: 'json' }, nullable: false } },
        { id: 24, name: 'embedding', declarationOrder: 3, valueType: { logical: { kind: 'vector', element: 'i8', dimensions: 3 }, nullable: false } },
      ],
      constraints: [{ kind: 'primary_key', id: 25, name: 'typed_values_pk', columnIds: [21] }],
    },
    {
      kind: 'table', id: 30, name: 'entropy_values', declarationOrder: 3, withoutRowId: true,
      columns: [
        { id: 31, name: 'id', declarationOrder: 0, valueType: { logical: { kind: 'int64' }, nullable: false } },
        { id: 32, name: 'entropy_bytes', declarationOrder: 1, valueType: { logical: { kind: 'blob', maxBytes: 32 }, nullable: false } },
        { id: 33, name: 'uuid_value', declarationOrder: 2, valueType: { logical: { kind: 'uuid' }, nullable: false } },
      ],
      constraints: [{ kind: 'primary_key', id: 34, name: 'entropy_values_pk', columnIds: [31] }],
    },
  ],
  seedRows: [{ tableId: 1, values: new Map([
    [2, { kind: 'int64', value: 1n }],
    [3, { kind: 'int64', value: 100n }],
  ]) }],
  functionIds: [], collationIds: [], moduleIds: [],
}

const temporaryDirectories: string[] = []
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function temporaryPath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'chronolog-materializer-'))
  temporaryDirectories.push(directory)
  return join(directory, 'state.db')
}

async function open(path = temporaryPath(), checkpointEvery = 1): Promise<DeterministicMaterializer> {
  return DeterministicMaterializer.open({ path, schemaManifest: schema, executionManifest, checkpointEvery })
}

function literal(id: number, value: Extract<Expr, { kind: 'literal' }>['value']): Expr {
  return { kind: 'literal', id, value }
}

function truePrecondition(base: number): Precondition {
  return {
    kind: 'assert', id: base,
    query: {
      id: base + 1, ctes: [], joins: [], groupBy: [], windows: [], compounds: [], orderBy: [],
      projection: [{ id: base + 2, name: 'ok', expression: literal(base + 3, { kind: 'boolean', value: true }) }],
      resultMode: { kind: 'scalar' },
    },
    unknownIsFailure: true,
  }
}

function balanceQuery(base: number): Query {
  return {
    id: base, ctes: [], joins: [], groupBy: [], windows: [], compounds: [], orderBy: [],
    from: { kind: 'table', id: base + 1, name: 'accounts', alias: 'account' },
    where: { kind: 'binary', id: base + 2, operator: 'eq', left: { kind: 'column', id: base + 3, relation: 'account', name: 'id' }, right: literal(base + 4, { kind: 'int64', value: 1n }) },
    projection: [{ id: base + 5, name: 'balance', expression: { kind: 'column', id: base + 6, relation: 'account', name: 'balance' } }],
    resultMode: { kind: 'scalar' },
  }
}

function expectBalance(base: number, expected: bigint): Precondition {
  const query = balanceQuery(base + 1)
  return {
    kind: 'expect', id: base, query,
    expected: {
      kind: 'inline',
      result: {
        resultMode: { kind: 'scalar' },
        columns: [{ id: base + 6, name: 'balance', valueType: { logical: { kind: 'int64' }, nullable: false } }],
        rows: [[{ kind: 'int64', value: expected }]],
      },
    },
  }
}

function setBalance(base: number, value: bigint): Mutation {
  return {
    kind: 'update', id: base, target: { kind: 'name', name: 'accounts' },
    affectedRows: { kind: 'exactly', count: 1n },
    assignments: [{ column: 'balance', value: literal(base + 1, { kind: 'int64', value }) }],
    where: { kind: 'binary', id: base + 2, operator: 'eq', left: { kind: 'column', id: base + 3, name: 'id' }, right: literal(base + 4, { kind: 'int64', value: 1n }) },
  }
}

function insertEffect(base: number, id: bigint, value: string): Mutation {
  return {
    kind: 'insert', id: base, target: { kind: 'name', name: 'effects' },
    affectedRows: { kind: 'exactly', count: 1n }, columns: ['id', 'value'], conflict: 'error',
    rows: [[literal(base + 1, { kind: 'int64', value: id }), literal(base + 2, text(value))]],
  }
}

async function transaction(
  id: number,
  timestamp: bigint,
  mutations: readonly Mutation[],
  preconditions: readonly Precondition[] = [truePrecondition(id * 1_000 + 1)],
  digests: { schema?: Uint8Array; manifest?: Uint8Array } = {},
): Promise<AdmittedTransaction> {
  const core: TransactionCore = {
    groupId: digestBytes(1), membershipRevision: digestBytes(2), validationPolicy: digestBytes(3), authorId: digestBytes(7),
    authorTimestampMs: timestamp,
    nonce: Uint8Array.from({ length: 16 }, (_value, index) => (id + index) & 0xff),
    executionManifestDigest: digests.manifest ?? await digestExecutionManifest(executionManifest),
    schemaDigest: digests.schema ?? await digestSchemaManifest(schema),
    program: { preconditions, mutations },
  }
  const canonicalCandidate = encodeTransactionCore(core)
  return {
    txId: bytes(id), authorFeedSequence: BigInt(id), candidateDigest: await transactionDigest(canonicalCandidate),
    canonicalCandidate, core,
  }
}

function integerResult(materializer: DeterministicMaterializer, sql: string): bigint {
  const value = materializer.localSql(sql).rows[0]?.[0]
  if (value?.kind !== 'integer') throw new Error('expected integer')
  return BigInt(value.value)
}

describe('DeterministicMaterializer IR reducer', () => {
  it('initializes from canonical manifests, persists them, and reopens exactly', async () => {
    const path = temporaryPath()
    const first = await open(path)
    expect(integerResult(first, 'SELECT balance FROM accounts WHERE id = 1')).toBe(100n)
    expect(first.schemaDigest).toEqual(await digestSchemaManifest(schema))
    expect(first.executionManifestDigest).toEqual(await digestExecutionManifest(executionManifest))
    expect(first.backend.nativeManifest.dynamicExtensions).toBe(false)
    first.close()

    const reopened = await open(path)
    expect(reopened.revision).toBe(0n)
    expect(integerResult(reopened, 'SELECT count(*) FROM typed_values')).toBe(0n)
    reopened.close()
  })

  it('atomically accepts an IR transaction and records its exact protected log identity', async () => {
    const materializer = await open()
    const spend = await transaction(1, 10n, [setBalance(100, 90n)], [expectBalance(200, 100n)])
    const event = await materializer.materialize([spend])
    expect(event).toMatchObject({ revision: 1n, earliestChangedOrderIndex: 0, replayedTransactions: 1 })
    expect(integerResult(materializer, 'SELECT balance FROM accounts')).toBe(90n)
    expect(materializer.outcome(spend.txId)).toMatchObject({ outcome: 'accepted', resultDigest: expect.any(Uint8Array) })
    expect(materializer.transactionLog()[0]?.canonicalCandidate).toEqual(spend.canonicalCandidate)
    materializer.close()
  })

  it('rolls back every mutation when a later command rejects', async () => {
    const materializer = await open()
    const candidate = await transaction(1, 10n, [
      insertEffect(100, 1n, 'first'),
      insertEffect(200, 1n, 'duplicate'),
    ])
    await materializer.materialize([candidate])
    expect(materializer.outcome(candidate.txId)).toMatchObject({
      outcome: 'rejected_execution', rejectionCode: 'CONSTRAINT_VIOLATION', failingCommandId: 200,
    })
    expect(integerResult(materializer, 'SELECT count(*) FROM effects')).toBe(0n)
    materializer.close()
  })

  it('executes insert, named upsert, and delete in signed command order', async () => {
    const materializer = await open()
    const upsert: Mutation = {
      kind: 'upsert', id: 200, target: { kind: 'name', name: 'effects' },
      affectedRows: { kind: 'exactly', count: 1n }, columns: ['id', 'value'],
      row: [literal(201, { kind: 'int64', value: 1n }), literal(202, text('second'))],
      constraint: 'effects_pk',
      updates: [{ column: 'value', value: { kind: 'old_new', id: 203, scope: 'new', column: 'value' } }],
    }
    const remove: Mutation = {
      kind: 'delete', id: 300, target: { kind: 'name', name: 'effects' },
      affectedRows: { kind: 'exactly', count: 1n },
      where: { kind: 'binary', id: 301, operator: 'eq', left: { kind: 'column', id: 302, name: 'id' }, right: literal(303, { kind: 'int64', value: 1n }) },
    }
    const candidate = await transaction(1, 10n, [insertEffect(100, 1n, 'first'), upsert, remove])
    await materializer.materialize([candidate])
    expect(materializer.outcome(candidate.txId)?.outcome).toBe('accepted')
    expect(integerResult(materializer, 'SELECT count(*) FROM effects')).toBe(0n)
    materializer.close()
  })

  it('replays a late predecessor and changes a formerly accepted outcome', async () => {
    const materializer = await open()
    const later = await transaction(2, 20n, [setBalance(100, 90n)], [expectBalance(200, 100n)])
    const earlier = await transaction(1, 10n, [setBalance(300, 5n)])
    await materializer.materialize([later])
    const event = await materializer.materialize([earlier, later])
    expect(integerResult(materializer, 'SELECT balance FROM accounts')).toBe(5n)
    expect(materializer.outcome(later.txId)).toMatchObject({
      outcome: 'rejected_precondition', rejectionCode: 'EXPECTATION_MISMATCH', failingPreconditionId: 200,
    })
    expect(event?.outcomeChanges).toContainEqual(expect.objectContaining({
      txId: later.txId, previous: 'accepted', current: 'rejected_precondition',
    }))
    materializer.close()
  })

  it('records a replay rejection without restoring stale later log rows', async () => {
    const materializer = await open(temporaryPath(), 5)
    const first = await transaction(1, 10n, [setBalance(100, 90n)], [expectBalance(200, 100n)])
    const displaced = await transaction(3, 30n, [setBalance(300, 80n)], [expectBalance(400, 90n)])
    const trailing = await transaction(4, 40n, [setBalance(500, 70n)])
    await materializer.materialize([first, displaced, trailing])

    const predecessor = await transaction(2, 20n, [setBalance(600, 5n)])
    await materializer.materialize([first, predecessor, displaced, trailing])

    expect(materializer.transactionLog().map((row) => row.orderIndex)).toEqual([0, 1, 2, 3])
    expect(materializer.outcome(displaced.txId)).toMatchObject({
      outcome: 'rejected_precondition',
      rejectionCode: 'EXPECTATION_MISMATCH',
    })
    materializer.close()
  })

  it('repeatedly replays checkpointed history as late predecessors arrive', async () => {
    const materializer = await open(temporaryPath(), 5)
    const arrivalTimestamps = [
      20, 35, 10, 40, 30, 5, 25, 15, 38, 2,
      33, 8, 28, 18, 37, 1, 22, 12, 32, 7,
    ]
    const admitted: AdmittedTransaction[] = []
    for (let index = 0; index < arrivalTimestamps.length; index += 1) {
      const timestamp = arrivalTimestamps[index]!
      admitted.push(await transaction(index + 1, BigInt(timestamp), [setBalance(10_000 + index * 10, BigInt(timestamp))]))
      admitted.sort((left, right) => Number(left.core.authorTimestampMs - right.core.authorTimestampMs))
      await materializer.materialize(admitted)
      expect(materializer.orderLength).toBe(admitted.length)
    }
    expect(materializer.transactionLog().map((row) => Number(row.authorTimestampMs))).toEqual(
      [...arrivalTimestamps].sort((left, right) => left - right),
    )
    materializer.close()
  })

  it('queries the prior protected log only through explicit system_relation IR', async () => {
    const materializer = await open()
    const prerequisite = await transaction(1, 10n, [insertEffect(100, 1n, 'prerequisite')])
    const nested: Query = {
      id: 501, ctes: [], joins: [], groupBy: [], windows: [], compounds: [], orderBy: [],
      from: { kind: 'system_relation', id: 502, relation: 'transaction_log', alias: 'log' },
      where: {
        kind: 'binary', id: 503, operator: 'and',
        left: { kind: 'binary', id: 504, operator: 'eq', left: { kind: 'column', id: 505, relation: 'log', name: 'tx_id' }, right: literal(506, { kind: 'blob', bytes: prerequisite.txId }) },
        right: { kind: 'binary', id: 507, operator: 'eq', left: { kind: 'column', id: 508, relation: 'log', name: 'outcome' }, right: literal(509, text('accepted')) },
      },
      projection: [{ id: 510, name: 'one', expression: literal(511, { kind: 'int64', value: 1n }) }],
      resultMode: { kind: 'multiset' },
    }
    const precondition: Precondition = {
      kind: 'assert', id: 500,
      query: {
        id: 512, ctes: [], joins: [], groupBy: [], windows: [], compounds: [], orderBy: [],
        projection: [{ id: 513, name: 'found', expression: { kind: 'exists', id: 514, query: nested, negated: false } }],
        resultMode: { kind: 'scalar' },
      },
      unknownIsFailure: true,
    }
    const dependent = await transaction(2, 20n, [insertEffect(600, 2n, 'dependent')], [precondition])

    await materializer.materialize([dependent])
    expect(materializer.outcome(dependent.txId)?.outcome).toBe('rejected_precondition')
    await materializer.materialize([prerequisite, dependent])
    expect(materializer.outcome(dependent.txId)?.outcome).toBe('accepted')
    expect(integerResult(materializer, 'SELECT count(*) FROM effects')).toBe(2n)
    expect(materializer.validateQuery({ ...nested, from: { kind: 'table', id: 502, name: 'chronolog_transactions', alias: 'log' } })).not.toHaveLength(0)
    materializer.close()
  })

  it('round-trips exact decimal, canonical JSON and ordinary vector BLOB values', async () => {
    const materializer = await open()
    const jsonValue = new Map<string, CanonicalJsonValue>([['large', 9_007_199_254_740_993n], ['ok', true]])
    const insert: Mutation = {
      kind: 'insert', id: 100, target: { kind: 'name', name: 'typed_values' },
      affectedRows: { kind: 'exactly', count: 2n }, conflict: 'error',
      columns: ['id', 'amount', 'payload', 'embedding'],
      rows: [[
        literal(101, { kind: 'int64', value: 1n }),
        literal(102, { kind: 'decimal', coefficient: 1231n, scale: 2 }),
        literal(103, { kind: 'json', value: jsonValue }),
        literal(104, { kind: 'vector', element: 'i8', dimensions: 3, bytes: bytes(0xff, 0, 1) }),
      ], [
        literal(105, { kind: 'int64', value: 2n }),
        literal(106, { kind: 'decimal', coefficient: 12n, scale: 0 }),
        literal(107, { kind: 'json', value: null }),
        literal(108, { kind: 'vector', element: 'i8', dimensions: 3, bytes: bytes(1, 2, 3) }),
      ]],
    }
    const candidate = await transaction(1, 10n, [insert])
    await materializer.materialize([candidate])
    const query: Query = {
      id: 200, ctes: [], joins: [], groupBy: [], windows: [], compounds: [],
      from: { kind: 'table', id: 201, name: 'typed_values', alias: 'v' },
      projection: [
        { id: 202, name: 'amount', expression: { kind: 'column', id: 203, relation: 'v', name: 'amount' } },
        { id: 204, name: 'payload', expression: { kind: 'column', id: 205, relation: 'v', name: 'payload' } },
        { id: 206, name: 'embedding', expression: { kind: 'column', id: 207, relation: 'v', name: 'embedding' } },
      ],
      orderBy: [{ id: 208, expression: { kind: 'column', id: 209, relation: 'v', name: 'id' }, direction: 'asc', nulls: 'first', canonicalRowTieBreaker: true }],
      resultMode: { kind: 'ordered' },
    }
    const row = (await materializer.queryIr(query)).result.rows[0]
    expect(row?.[0]).toEqual({ kind: 'decimal', coefficient: 1231n, scale: 2 })
    expect(row?.[1]).toEqual({ kind: 'json', value: jsonValue })
    expect(row?.[2]).toEqual({ kind: 'vector', element: 'i8', dimensions: 3, bytes: bytes(0xff, 0, 1) })
    expect((await materializer.queryIr(query)).result.rows[1]?.[0]).toEqual({ kind: 'decimal', coefficient: 12n, scale: 0 })
    materializer.close()
  })

  it('derives entropy only from signed group/nonce context and preserves it across replay', async () => {
    const materializer = await open()
    expect(materializer.validateMutation({
      kind: 'insert', id: 50, target: { kind: 'name', name: 'entropy_values' },
      affectedRows: { kind: 'exactly', count: 1n }, conflict: 'error', columns: ['uuid_value'],
      rows: [[{ kind: 'entropy', id: 51, label: 'row/uuid', index: 0, length: 15 }]],
    })).toContainEqual(expect.objectContaining({ code: 'IR_ENTROPY_UUID_LENGTH', nodeId: 51 }))
    const entropyInsert = (base: number, rowId: bigint): Mutation => ({
      kind: 'insert', id: base, target: { kind: 'name', name: 'entropy_values' },
      affectedRows: { kind: 'exactly', count: 1n }, conflict: 'error',
      columns: ['id', 'entropy_bytes', 'uuid_value'],
      rows: [[
        literal(base + 1, { kind: 'int64', value: rowId }),
        { kind: 'entropy', id: base + 2, label: 'row/token', index: 4, length: 32 },
        { kind: 'entropy', id: base + 3, label: 'row/uuid', index: 4, length: 16 },
      ]],
    })
    const original = await transaction(1, 20n, [entropyInsert(100, 1n)])
    await materializer.materialize([original])
    const first = materializer.localSql('SELECT entropy_bytes, uuid_value FROM entropy_values WHERE id = 1').rows[0]
    expect(first?.[0]).toEqual({
      kind: 'blob',
      value: deriveEntropy(original.core.groupId, original.core.nonce, 'row/token', 4n, 32),
    })
    expect(first?.[1]).toEqual({
      kind: 'blob',
      value: deriveEntropy(original.core.groupId, original.core.nonce, 'row/uuid', 4n, 16),
    })

    const predecessor = await transaction(9, 10n, [insertEffect(900, 9n, 'late predecessor')])
    await materializer.materialize([predecessor, original])
    const replayed = materializer.localSql('SELECT entropy_bytes, uuid_value FROM entropy_values WHERE id = 1').rows[0]
    expect(replayed).toEqual(first)

    const changedNonce = await transaction(2, 30n, [entropyInsert(200, 2n)])
    await materializer.materialize([predecessor, original, changedNonce])
    const second = materializer.localSql('SELECT entropy_bytes FROM entropy_values WHERE id = 2').rows[0]?.[0]
    expect(second).toEqual({
      kind: 'blob',
      value: deriveEntropy(changedNonce.core.groupId, changedNonce.core.nonce, 'row/token', 4n, 32),
    })
    expect(second).not.toEqual(first?.[0])

    const query: Query = {
      id: 500, ctes: [], joins: [], groupBy: [], windows: [], compounds: [], orderBy: [],
      projection: [{ id: 501, name: 'entropy', expression: { kind: 'entropy', id: 502, label: 'draft/value', index: 0, length: 16 } }],
      resultMode: { kind: 'scalar' },
    }
    const context = { groupId: original.core.groupId, transactionNonce: original.core.nonce }
    const observedA = await materializer.queryIr(query, { context })
    const observedB = await materializer.queryIr(query, { context })
    expect(observedB.result).toEqual(observedA.result)
    const observedChanged = await materializer.queryIr(query, {
      context: { groupId: original.core.groupId, transactionNonce: changedNonce.core.nonce },
    })
    expect(observedChanged.result).not.toEqual(observedA.result)
    await expect(materializer.queryIr(query, { context: { transactionNonce: original.core.nonce } }))
      .rejects.toThrow('TRANSACTION_CONTEXT_UNAVAILABLE')
    materializer.close()
  })

  it('rejects schema/manifest mismatches and unavailable reader revisions', async () => {
    const path = temporaryPath()
    const first = await open(path)
    expect(() => first.localSql('SELECT 1', [], { atRevision: 1n })).toThrow('MATERIALIZER_REVISION_UNAVAILABLE')
    first.close()
    const changed: SchemaManifest = { ...schema, name: 'changed_schema' }
    await expect(DeterministicMaterializer.open({ path, schemaManifest: changed, executionManifest }))
      .rejects.toThrow('DATABASE_MANIFEST_MISMATCH')
    const changedExecution = createCoreExecutionManifest({
      profile: 'changed-profile',
      engineDigest: readNativeEngineInfo().digest,
    })
    await expect(DeterministicMaterializer.open({ path, schemaManifest: schema, executionManifest: changedExecution }))
      .rejects.toThrow('DATABASE_MANIFEST_MISMATCH')
    const wrongEngine = createCoreExecutionManifest({ profile: 'wrong-engine', engineDigest: digestBytes(77) })
    await expect(DeterministicMaterializer.open({
      path: temporaryPath(), schemaManifest: schema, executionManifest: wrongEngine,
    })).rejects.toThrow('MATERIALIZER_ENGINE_DIGEST_MISMATCH')
  })

  it('rejects manifest-digest candidates without changing application state', async () => {
    const materializer = await open()
    const candidate = await transaction(1, 10n, [setBalance(100, 0n)], undefined, { manifest: digestBytes(9) })
    await materializer.materialize([candidate])
    expect(materializer.outcome(candidate.txId)).toMatchObject({
      outcome: 'rejected_execution', rejectionCode: 'EXECUTION_MANIFEST_DIGEST_MISMATCH',
    })
    expect(integerResult(materializer, 'SELECT balance FROM accounts')).toBe(100n)
    materializer.close()
  })

  it('records schema-aware compiler rejection instead of aborting replay', async () => {
    const materializer = await open()
    const unknown: Mutation = {
      kind: 'insert', id: 100, target: { kind: 'name', name: 'missing_table' },
      affectedRows: { kind: 'exactly', count: 1n }, columns: ['id'], conflict: 'error',
      rows: [[literal(101, { kind: 'int64', value: 1n })]],
    }
    const candidate = await transaction(1, 10n, [unknown])
    await materializer.materialize([candidate])
    expect(materializer.outcome(candidate.txId)).toMatchObject({
      outcome: 'rejected_execution', rejectionCode: 'OBJECT_NOT_FOUND',
    })
    expect(materializer.revision).toBe(1n)
    materializer.close()
  })

  it('keeps local SQL read-only and separate from consensus IR', async () => {
    const materializer = await open()
    const parameter: LocalSqlValue = { kind: 'integer', value: '1' }
    expect(materializer.localSql('SELECT balance FROM accounts WHERE id = ?', [parameter]).rows[0]?.[0])
      .toEqual({ kind: 'integer', value: '100' })
    expect(() => materializer.localSql('UPDATE accounts SET balance = 0')).toThrow('SQL_PROFILE_VIOLATION')
    materializer.close()
  })
})
