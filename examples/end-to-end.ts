import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ChronologClient, defineQuery } from '@chronolog/client'
import { createCoreExecutionManifest } from '@chronolog/compiler-sqlite'
import {
  IrBuilder,
  SchemaBuilder,
  encodeQuery,
  logicalTypes,
  values,
  type Mutation,
  type Query,
  type TransactionProgram,
} from '@chronolog/ir'
import { DeterministicMaterializer, readNativeEngineInfo } from '@chronolog/materializer-doltlite'
import { ChronologNode, type MembershipResolver } from '@chronolog/node-core'
import { equalBytes, generateEd25519KeyPair } from '@chronolog/protocol'
import { InProcessRpcTransport, NodeRpcService } from '@chronolog/rpc'
import { MemoryTransportNetwork } from '@chronolog/transport-ssb'

const directory = await mkdtemp(join(tmpdir(), 'chronolog-example-'))
const identity = await generateEd25519KeyPair()
const capability = Uint8Array.of(7)
const groupId = bytes32(1)
const membershipRevision = bytes32(2)
const validationPolicy = bytes32(3)

const schema = accountsSchema()
const native = readNativeEngineInfo()
const executionManifest = createCoreExecutionManifest({
  profile: 'chronolog-core-portable',
  engine: native.descriptor,
  engineDigest: native.digest,
})
const materializer = await DeterministicMaterializer.open({
  path: join(directory, 'application.db'),
  schemaManifest: schema,
  executionManifest,
  checkpointEvery: 1,
})
const membership: MembershipResolver = {
  canWrite: ({ writerId }) => equalBytes(writerId, identity.publicKeyBytes),
  canValidate: ({ validatorId, validatorCapability }) =>
    equalBytes(validatorId, identity.publicKeyBytes) && equalBytes(validatorCapability, capability),
  threshold: () => 1,
}
const network = new MemoryTransportNetwork()
const node = new ChronologNode({
  groupId,
  membershipRevision,
  validationPolicy,
  identity,
  transport: network.createNode('example'),
  materializer,
  membership,
  validator: { capabilityId: capability, cutoffLagMs: Number.MAX_SAFE_INTEGER },
})

try {
  await node.start()
  const balance = balanceQuery()
  const balanceBinding = defineQuery({
    canonicalBytes: encodeQuery(balance),
    resultMode: 'scalar',
    decodeResult: (result) => {
      const value = result.rows[0]?.[0]
      if (typeof value !== 'bigint') throw new Error('balance was not an int64')
      return value
    },
  })
  const client = new ChronologClient({
    groupId: Buffer.from(groupId).toString('base64url'),
    transport: new InProcessRpcTransport(new NodeRpcService({ node })),
    bindings: {
      schemaDigest: Buffer.from(materializer.schemaDigest).toString('base64url'),
      executionManifestDigest: Buffer.from(materializer.executionManifestDigest).toString('base64url'),
    },
  })

  try {
    // This transaction is initially accepted because the seeded balance is 100.
    const later = await node.publish({
      authorTimestampMs: 20n,
      program: programExpectingBalance(100n, updateBalance(90n)),
    })
    await eventually(() => node.outcome(later.txId)?.outcome === 'accepted')
    console.log('initial balance', (await client.query(balanceBinding)).result)

    // A late-arriving predecessor sorts before it. The materializer restores its
    // Dolt checkpoint, applies this transaction, and then deterministically
    // rejects the later transaction whose mandatory precondition moved.
    const predecessor = await node.publish({
      authorTimestampMs: 10n,
      program: programExpectingBalance(100n, updateBalance(5n)),
    })
    await eventually(() => node.outcome(predecessor.txId)?.outcome === 'accepted')
    await eventually(() => node.outcome(later.txId)?.outcome === 'rejected_precondition')

    console.log('replayed balance', (await client.query(balanceBinding)).result)
    console.log('later outcome', node.outcome(later.txId))
    console.log('checkpoints', materializer.checkpoints())
  } finally {
    await client.close()
  }
} finally {
  await node.close()
  await rm(directory, { recursive: true, force: true })
}

function accountsSchema() {
  const builder = new SchemaBuilder()
  const id = builder.column('id', builder.type(logicalTypes.int64()))
  const balance = builder.column('balance', builder.type(logicalTypes.int64()))
  const table = builder.table('accounts', [id, balance], [builder.primaryKey('accounts_pk', [id])])
  return builder.schema('accounts', [table], [
    builder.seed(table, new Map([[id, values.int64(1n)], [balance, values.int64(100n)]])),
  ])
}

function balanceQuery(): Query {
  const builder = new IrBuilder()
  return builder.query(
    [builder.projection('balance', builder.column('balance', 'a'))],
    {
      from: { kind: 'table', id: builder.id(), name: 'accounts', alias: 'a' },
      where: builder.binary('eq', builder.column('id', 'a'), builder.literal(values.int64(1n))),
      resultMode: { kind: 'scalar' },
    },
  )
}

function programExpectingBalance(expected: bigint, mutation: Mutation): TransactionProgram {
  const builder = new IrBuilder(1_000)
  const predicate = builder.query(
    [builder.projection('ok', builder.binary(
      'eq',
      builder.column('balance', 'a'),
      builder.literal(values.int64(expected)),
    ))],
    {
      from: { kind: 'table', id: builder.id(), name: 'accounts', alias: 'a' },
      where: builder.binary('eq', builder.column('id', 'a'), builder.literal(values.int64(1n))),
      resultMode: { kind: 'scalar' },
    },
  )
  return builder.program([builder.assertion(predicate)], [mutation])
}

function updateBalance(next: bigint): Mutation {
  const builder = new IrBuilder(2_000 + Number(next))
  return {
    kind: 'update',
    id: builder.id(),
    target: { kind: 'name', name: 'accounts' },
    assignments: [{ column: 'balance', value: builder.literal(values.int64(next)) }],
    where: builder.binary('eq', builder.column('id'), builder.literal(values.int64(1n))),
    affectedRows: { kind: 'exactly', count: 1n },
  }
}

async function eventually(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5_000
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error('condition did not become true')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}


function bytes32(seed: number): Uint8Array {
  return Uint8Array.from({ length: 32 }, (_value, index) => (seed + index) & 0xff)
}
