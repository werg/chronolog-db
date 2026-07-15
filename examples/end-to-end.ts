import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ChronologClient } from '@chronolog/client'
import { createCoreExecutionManifest } from '@chronolog/compiler-sqlite'
import {
  DeterministicMaterializer,
  createDoltLiteMaterializationRuntime,
  readNativeEngineInfo,
} from '@chronolog/materializer-doltlite'
import { ChronologNode, type MembershipResolver } from '@chronolog/node-core'
import { equalBytes, generateEd25519KeyPair, type SqlTransactionProgram } from '@chronolog/protocol'
import { InProcessRpcTransport, NodeRpcService } from '@chronolog/rpc'
import { MemoryTransportNetwork } from '@chronolog/transport-ssb'

const directory = await mkdtemp(join(tmpdir(), 'chronolog-example-'))
const identity = await generateEd25519KeyPair()
const capability = Uint8Array.of(7)
const groupId = bytes32(1)
const membershipRevision = bytes32(2)
const validationPolicy = bytes32(3)
const native = readNativeEngineInfo()
const executionManifest = createCoreExecutionManifest({
  profile: 'chronolog-core-portable',
  engine: native.descriptor,
  engineDigest: native.digest,
})
const materializer = await DeterministicMaterializer.open({
  path: join(directory, 'application.db'),
  executionManifest,
  checkpointEvery: 1,
})
const membership: MembershipResolver = {
  canWrite: ({ writerId }) => equalBytes(writerId, identity.publicKeyBytes),
  canValidate: ({ validatorId, validatorCapability }) =>
    equalBytes(validatorId, identity.publicKeyBytes) && equalBytes(validatorCapability, capability),
  threshold: () => 1,
}
const node = new ChronologNode({
  groupId,
  membershipRevision,
  validationPolicy,
  identity,
  transport: new MemoryTransportNetwork().createNode('example'),
  materialization: createDoltLiteMaterializationRuntime(materializer),
  membership,
  validator: { capabilityId: capability, cutoffLagMs: Number.MAX_SAFE_INTEGER },
})

try {
  await node.start()
  const client = new ChronologClient({
    groupId: Buffer.from(groupId).toString('base64url'),
    transport: new InProcessRpcTransport(new NodeRpcService({ node })),
    bindings: { executionManifestDigest: Buffer.from(materializer.executionManifestDigest).toString('base64url') },
  })
  try {
    const bootstrap = await node.publish({ authorTimestampMs: 1n, program: bootstrapProgram() })
    await eventually(() => node.outcome(bootstrap.txId) !== null)
    if (node.outcome(bootstrap.txId)?.outcome !== 'accepted') {
      throw new Error(`bootstrap rejected: ${node.outcome(bootstrap.txId)?.rejectionCode}`)
    }

    const later = await node.publish({ authorTimestampMs: 20n, program: updateProgram(100n, 90n) })
    await eventually(() => node.outcome(later.txId)?.outcome === 'accepted')
    console.log('initial balance', (await client.query('SELECT balance FROM accounts WHERE id = ?', [1n])).result.rows)

    const predecessor = await node.publish({ authorTimestampMs: 10n, program: updateProgram(100n, 5n) })
    await eventually(() => node.outcome(predecessor.txId)?.outcome === 'accepted')
    await eventually(() => node.outcome(later.txId)?.outcome === 'rejected_precondition')

    console.log('replayed balance', (await client.query('SELECT balance FROM accounts WHERE id = ?', [1n])).result.rows)
    console.log('later outcome', node.outcome(later.txId))
    console.log('checkpoints', materializer.checkpoints())
  } finally {
    await client.close()
  }
} finally {
  await node.close()
  await rm(directory, { recursive: true, force: true })
}

function bootstrapProgram(): SqlTransactionProgram {
  return {
    version: 1,
    preconditions: [{
      id: 1,
      query: { sql: 'SELECT 1', bindings: [] },
      resultMode: 'scalar',
      expectation: { kind: 'assert_true' },
    }],
    body: [
      { sql: 'CREATE TABLE accounts (id INTEGER PRIMARY KEY, balance INTEGER NOT NULL) STRICT', bindings: [] },
      { sql: 'INSERT INTO accounts (id, balance) VALUES (?, ?)', bindings: [indexed(1, 1n), indexed(2, 100n)] },
    ],
  }
}

function updateProgram(expected: bigint, next: bigint): SqlTransactionProgram {
  return {
    version: 1,
    preconditions: [{
      id: 1,
      query: {
        sql: 'SELECT balance = ? FROM accounts WHERE id = ?',
        bindings: [indexed(1, expected), indexed(2, 1n)],
      },
      resultMode: 'scalar',
      expectation: { kind: 'assert_true' },
    }],
    body: [{
      sql: 'UPDATE accounts SET balance = ? WHERE id = ?',
      bindings: [indexed(1, next), indexed(2, 1n)],
    }],
  }
}

function indexed(index: number, value: bigint) {
  return { parameter: { kind: 'index' as const, index }, value: { kind: 'int64' as const, value } }
}

async function eventually(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5_000
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error('condition did not become true')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
function bytes32(seed: number): Uint8Array { return Uint8Array.from({ length: 32 }, (_value, index) => (seed + index) & 0xff) }
