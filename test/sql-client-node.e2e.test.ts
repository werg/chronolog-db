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
import { ChronologNode, type MembershipResolver } from '@chronolog/node-core'
import { equalBytes, generateEd25519KeyPair } from '@chronolog/protocol'
import { InProcessRpcTransport, NodeRpcService } from '@chronolog/rpc'
import { MemoryTransportNetwork } from '@chronolog/transport-ssb'
import { afterEach, describe, expect, it } from 'vitest'

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

async function runtime() {
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
