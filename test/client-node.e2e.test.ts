import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ChronologClient, defineMutation, defineQuery } from '@chronolog/client'
import { createCoreExecutionManifest } from '@chronolog/compiler-sqlite'
import {
  IrBuilder,
  SchemaBuilder,
  encodeMutation,
  encodeQuery,
  logicalTypes,
  values,
  type Mutation,
  type Query,
  type SchemaManifest,
  type TransactionProgram,
} from '@chronolog/ir'
import {
  DeterministicMaterializer,
  createDoltLiteLegacyMaterializationRuntime,
  readNativeEngineInfo,
} from '@chronolog/materializer-doltlite'
import { ChronologNode, type MembershipResolver } from '@chronolog/node-core'
import { equalBytes, generateEd25519KeyPair } from '@chronolog/protocol'
import { HttpRpcServer, HttpRpcTransport, InProcessRpcTransport, NodeRpcService } from '@chronolog/rpc'
import { MemoryTransportNetwork, SsbDb2Transport } from '@chronolog/transport-ssb'
import { afterEach, describe, expect, it } from 'vitest'

describe('public client to replicated database', () => {
  const cleanup: Array<() => Promise<void>> = []

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((close) => close()))
  })

  it('publishes a mandatory-precondition typed transaction through HTTP RPC', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'chronolog-client-e2e-'))
    const identity = await generateEd25519KeyPair()
    const capability = Uint8Array.of(8)
    const membership = selfMembership(identity.publicKeyBytes, capability)
    const network = new MemoryTransportNetwork()
    const schema = todosSchema()
    const materializer = await openMaterializer(join(directory, 'application.db'), schema)
    const node = new ChronologNode({
      groupId: bytes32(1),
      membershipRevision: bytes32(2),
      validationPolicy: bytes32(3),
      identity,
      transport: network.createNode('local'),
      materialization: createDoltLiteLegacyMaterializationRuntime(materializer),
      membership,
      validator: { capabilityId: capability },
    })
    await node.start()
    const groupId = Buffer.from(node.groupId).toString('base64url')
    const server = new HttpRpcServer({ service: new NodeRpcService({ node }), port: 0, token: 'test-token' })
    const address = await server.listen()
    const client = new ChronologClient({
      groupId,
      transport: new HttpRpcTransport({ baseUrl: address.url, token: 'test-token' }),
    })
    cleanup.push(async () => {
      await client.close()
      await server.close()
      await node.close()
      await rm(directory, { recursive: true, force: true })
    })

    const absent = todoAbsentQuery(100)
    const absentBinding = defineQuery({
      canonicalBytes: encodeQuery(absent),
      resultMode: 'scalar',
      decodeResult: (result) => {
        const value = result.rows[0]?.[0]
        if (typeof value !== 'boolean') throw new Error('precondition did not return boolean')
        return value
      },
    })
    const insert = insertTodo(200, 1n, 'ship it')
    const transaction = await client.transaction((draft) => {
      draft.assert(absentBinding).insert(defineMutation('insert', encodeMutation(insert), 'create-todo'))
    })

    await eventually(async () =>
      (await client.getTransactionOutcome(transaction.transactionId)).outcome.type === 'accepted')
    const titleBinding = defineQuery({
      canonicalBytes: encodeQuery(todoTitleQuery()),
      resultMode: 'scalar',
      decodeResult: (result) => result.rows[0]?.[0],
    })
    expect((await client.query(titleBinding)).result).toBe('ship it')
    expect((await client.getSettlementEvidence(transaction.transactionId)).confidence).toBe('insufficient')
  })

  it('refuses to publish a draft without an application precondition', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'chronolog-client-e2e-'))
    const identity = await generateEd25519KeyPair()
    const capability = Uint8Array.of(1)
    const network = new MemoryTransportNetwork()
    const materializer = await openMaterializer(join(directory, 'application.db'), todosSchema())
    const node = new ChronologNode({
      groupId: bytes32(4),
      membershipRevision: bytes32(5),
      validationPolicy: bytes32(6),
      identity,
      transport: network.createNode('mandatory'),
      materialization: createDoltLiteLegacyMaterializationRuntime(materializer),
      membership: selfMembership(identity.publicKeyBytes, capability),
      validator: { capabilityId: capability },
    })
    await node.start()
    const client = new ChronologClient({
      groupId: Buffer.from(node.groupId).toString('base64url'),
      transport: new InProcessRpcTransport(new NodeRpcService({ node })),
    })
    cleanup.push(async () => {
      await client.close()
      await node.close()
      await rm(directory, { recursive: true, force: true })
    })

    await expect(client.transaction((draft) => {
      draft.insert(defineMutation('insert', encodeMutation(insertTodo(300, 1n, 'forbidden'))))
    })).rejects.toThrow('Every transaction requires a precondition')
  })

  it('keeps native Dolt checkpoints across restart and replays a late predecessor', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'chronolog-native-e2e-'))
    const identity = await generateEd25519KeyPair()
    const capability = Uint8Array.of(23)
    const groupId = bytes32(7)
    const membershipRevision = bytes32(8)
    const validationPolicy = bytes32(9)
    const membership = selfMembership(identity.publicKeyBytes, capability)
    const schema = accountsSchema()
    let active: { readonly node: ChronologNode; readonly materializer: DeterministicMaterializer } | undefined

    const openPersistentNode = async () => {
      const materializer = await openMaterializer(join(directory, 'application.db'), schema, 1)
      const transport = await SsbDb2Transport.open({
        path: join(directory, 'ssb'),
        secretPath: join(directory, 'ssb-secret'),
      })
      const node = new ChronologNode({
        groupId,
        membershipRevision,
        validationPolicy,
        identity,
        transport,
        materialization: createDoltLiteLegacyMaterializationRuntime(materializer),
        membership,
        validator: { capabilityId: capability, cutoffLagMs: Number.MAX_SAFE_INTEGER },
      })
      await node.start()
      return { node, materializer }
    }

    try {
      active = await openPersistentNode()
      const later = await active.node.publish({
        authorTimestampMs: 20n,
        program: accountProgram(1_000, 100n, 90n),
      })
      await eventually(() => active?.node.outcome(later.txId)?.outcome === 'accepted')
      const checkpoint = active.materializer.checkpoints().find((item) => item.prefixLength === 1)
      expect(checkpoint).toMatchObject({ prefixLength: 1, doltCommitHash: expect.any(String) })

      await active.node.close()
      active = await openPersistentNode()
      expect(active.materializer.checkpoints()).toContainEqual(checkpoint)
      expect(await balance(active.node)).toBe(90n)

      const earlier = await active.node.publish({
        authorTimestampMs: 10n,
        program: accountProgram(2_000, 100n, 5n),
      })
      await eventually(() => active?.node.outcome(earlier.txId)?.outcome === 'accepted')
      await eventually(() => active?.node.outcome(later.txId)?.outcome === 'rejected_precondition')
      expect(await balance(active.node)).toBe(5n)
      expect(active.node.outcomeChangedByReplay(later.txId)).toBe(true)
    } finally {
      await active?.node.close()
      await rm(directory, { recursive: true, force: true })
    }
  })
})

function selfMembership(publicKey: Uint8Array, capability: Uint8Array): MembershipResolver {
  return {
    canWrite: ({ writerId }) => equalBytes(writerId, publicKey),
    canValidate: ({ validatorId, validatorCapability }) =>
      equalBytes(validatorId, publicKey) && equalBytes(validatorCapability, capability),
    threshold: () => 1,
  }
}

async function openMaterializer(path: string, schemaManifest: SchemaManifest, checkpointEvery?: number) {
  const native = readNativeEngineInfo()
  return DeterministicMaterializer.open({
    path,
    schemaManifest,
    executionManifest: createCoreExecutionManifest({
      profile: 'chronolog-core-portable', engine: native.descriptor, engineDigest: native.digest,
    }),
    ...(checkpointEvery === undefined ? {} : { checkpointEvery }),
  })
}

function todosSchema(): SchemaManifest {
  const builder = new SchemaBuilder()
  const id = builder.column('id', builder.type(logicalTypes.int64()))
  const title = builder.column('title', builder.type(logicalTypes.text()))
  const table = builder.table('todos', [id, title], [builder.primaryKey('todos_pk', [id])])
  return builder.schema('todos', [table])
}

function accountsSchema(): SchemaManifest {
  const builder = new SchemaBuilder()
  const id = builder.column('id', builder.type(logicalTypes.int64()))
  const balanceColumn = builder.column('balance', builder.type(logicalTypes.int64()))
  const table = builder.table('accounts', [id, balanceColumn], [builder.primaryKey('accounts_pk', [id])])
  return builder.schema('accounts', [table], [
    builder.seed(table, new Map([[id, values.int64(1n)], [balanceColumn, values.int64(100n)]])),
  ])
}

function todoAbsentQuery(startId: number): Query {
  const builder = new IrBuilder(startId)
  const subquery = builder.query(
    [builder.projection('one', builder.literal(values.int64(1n)))],
    {
      from: { kind: 'table', id: builder.id(), name: 'todos', alias: 't' },
      where: builder.binary('eq', builder.column('id', 't'), builder.literal(values.int64(1n))),
      resultMode: { kind: 'multiset' },
    },
  )
  return builder.query(
    [builder.projection('absent', { kind: 'exists', id: builder.id(), query: subquery, negated: true })],
    { resultMode: { kind: 'scalar' } },
  )
}

function todoTitleQuery(): Query {
  const builder = new IrBuilder(400)
  return builder.query(
    [builder.projection('title', builder.column('title', 't'))],
    {
      from: { kind: 'table', id: builder.id(), name: 'todos', alias: 't' },
      where: builder.binary('eq', builder.column('id', 't'), builder.literal(values.int64(1n))),
      resultMode: { kind: 'scalar' },
    },
  )
}

function insertTodo(startId: number, id: bigint, title: string): Mutation {
  const builder = new IrBuilder(startId)
  return builder.insert('todos', ['id', 'title'], [[
    builder.literal(values.int64(id)), builder.literal(values.text(title)),
  ]], { kind: 'exactly', count: 1n })
}

function accountProgram(startId: number, expected: bigint, next: bigint): TransactionProgram {
  const builder = new IrBuilder(startId)
  const assertion = builder.query(
    [builder.projection('ok', builder.binary(
      'eq', builder.column('balance', 'a'), builder.literal(values.int64(expected)),
    ))],
    {
      from: { kind: 'table', id: builder.id(), name: 'accounts', alias: 'a' },
      where: builder.binary('eq', builder.column('id', 'a'), builder.literal(values.int64(1n))),
      resultMode: { kind: 'scalar' },
    },
  )
  const mutation: Mutation = {
    kind: 'update', id: builder.id(), target: { kind: 'name', name: 'accounts' },
    assignments: [{ column: 'balance', value: builder.literal(values.int64(next)) }],
    where: builder.binary('eq', builder.column('id'), builder.literal(values.int64(1n))),
    affectedRows: { kind: 'exactly', count: 1n },
  }
  return builder.program([builder.assertion(assertion)], [mutation])
}

async function balance(node: ChronologNode): Promise<bigint> {
  const builder = new IrBuilder(8_000)
  const query = builder.query(
    [builder.projection('balance', builder.column('balance', 'a'))],
    {
      from: { kind: 'table', id: builder.id(), name: 'accounts', alias: 'a' },
      where: builder.binary('eq', builder.column('id', 'a'), builder.literal(values.int64(1n))),
      resultMode: { kind: 'scalar' },
    },
  )
  const value = (await node.queryIr(query)).result.rows[0]?.[0]
  if (value?.kind !== 'int64') throw new Error('balance is not an int64')
  return value.value
}

async function eventually(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 10_000
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error('condition did not become true')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

function bytes32(seed: number): Uint8Array {
  return Uint8Array.from({ length: 32 }, (_value, index) => (seed + index) & 0xff)
}
