import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createCoreExecutionManifest } from '@chronolog/compiler-sqlite'
import { IrBuilder, SchemaBuilder, logicalTypes, values } from '@chronolog/ir'
import {
  DeterministicMaterializer,
  createDoltLiteLegacyMaterializationRuntime,
  readNativeEngineInfo,
} from '@chronolog/materializer-doltlite'
import { equalBytes, generateEd25519KeyPair } from '@chronolog/protocol'
import { MemoryTransportNetwork } from '@chronolog/transport-ssb'
import { afterEach, describe, expect, it } from 'vitest'

import { createEpochEnvelopeCipher } from './cipher.js'
import { ChronologNode } from './node.js'
import type { MembershipResolver } from './types.js'

describe('ChronologNode end-to-end', () => {
  const nodes: ChronologNode[] = []
  const directories: string[] = []

  afterEach(async () => {
    await Promise.all(nodes.splice(0).map(async (node) => node.close()))
    await Promise.all(directories.splice(0).map(
      async (directory) => rm(directory, { recursive: true, force: true }),
    ))
  })

  it('replicates canonical IR, obtains validator inclusion, and materializes identical state', async () => {
    const writer = await generateEd25519KeyPair()
    const validator = await generateEd25519KeyPair()
    const groupId = bytes32(1)
    const revision = bytes32(2)
    const policy = bytes32(3)
    const capability = Uint8Array.of(7)
    const membership: MembershipResolver = {
      canWrite: ({ writerId }) => equalBytes(writerId, writer.publicKeyBytes),
      canValidate: ({ validatorId, validatorCapability }) =>
        equalBytes(validatorId, validator.publicKeyBytes) &&
        equalBytes(validatorCapability, capability),
      threshold: () => 1,
      policyVersion: () => 1n,
      canUseTransportAuthor: ({ role, signingId, transportAuthor }) =>
        role === 'writer'
          ? equalBytes(signingId, writer.publicKeyBytes) && transportAuthor === 'writer'
          : equalBytes(signingId, validator.publicKeyBytes) && transportAuthor === 'validator',
      canHeartbeat: ({ validatorId, validatorCapability }) =>
        equalBytes(validatorId, validator.publicKeyBytes) &&
        equalBytes(validatorCapability, capability),
    }
    const network = new MemoryTransportNetwork()
    const directory = await mkdtemp(join(tmpdir(), 'chronolog-node-integration-'))
    directories.push(directory)
    const epochKey = Uint8Array.from({ length: 32 }, (_value, index) => index + 1)
    const writerTransport = network.createNode('writer')
    const validatorTransport = network.createNode('validator')
    network.connectAll()
    const schema = notesSchema()
    const native = readNativeEngineInfo()
    const executionManifest = createCoreExecutionManifest({
      profile: 'chronolog-core-portable',
      engine: native.descriptor,
      engineDigest: native.digest,
    })
    const writerMaterializer = await DeterministicMaterializer.open({
      path: join(directory, 'writer.db'), schemaManifest: schema, executionManifest,
    })
    const validatorMaterializer = await DeterministicMaterializer.open({
      path: join(directory, 'validator.db'), schemaManifest: schema, executionManifest,
    })
    expect(writerMaterializer.backend).toMatchObject({ engine: 'doltlite', securityConfigured: true })
    expect(validatorMaterializer.backend).toMatchObject({ engine: 'doltlite', securityConfigured: true })
    const writerNode = new ChronologNode({
      groupId,
      membershipRevision: revision,
      validationPolicy: policy,
      identity: writer,
      transport: writerTransport,
      materialization: createDoltLiteLegacyMaterializationRuntime(writerMaterializer),
      membership,
      envelopeCipher: createEpochEnvelopeCipher(epochKey, 1n),
    })
    const validatorNode = new ChronologNode({
      groupId,
      membershipRevision: revision,
      validationPolicy: policy,
      identity: validator,
      transport: validatorTransport,
      materialization: createDoltLiteLegacyMaterializationRuntime(validatorMaterializer),
      membership,
      validator: { capabilityId: capability, cutoffLagMs: 120_000 },
      envelopeCipher: createEpochEnvelopeCipher(epochKey, 1n),
    })
    nodes.push(writerNode, validatorNode)
    await Promise.all([writerNode.start(), validatorNode.start()])

    const ir = new IrBuilder()
    const assertion = ir.query(
      [ir.projection('ok', ir.literal(values.boolean(true)))],
      { resultMode: { kind: 'scalar' } },
    )
    const published = await writerNode.publish({
      program: ir.program(
        [ir.assertion(assertion)],
        [ir.insert('notes', ['id', 'body'], [[
          ir.literal(values.int64(1n)),
          ir.literal(values.text('hello decentralized world')),
        ]], { kind: 'exactly', count: 1n })],
      ),
    })

    await eventually(async () =>
      writerNode.outcome(published.txId)?.outcome === 'accepted' &&
      validatorNode.outcome(published.txId)?.outcome === 'accepted')
    const query = noteQuery()
    expect((await writerNode.queryIr(query)).result).toEqual((await validatorNode.queryIr(query)).result)
    expect(writerNode.controlStore.attestationsFor(published.txId)).toHaveLength(1)
    expect((await writerNode.status()).admitted).toBe(1)
  })
})

function notesSchema() {
  const builder = new SchemaBuilder()
  const id = builder.column('id', builder.type(logicalTypes.int64()))
  const body = builder.column('body', builder.type(logicalTypes.text()))
  const table = builder.table('notes', [id, body], [builder.primaryKey('notes_pk', [id])])
  return builder.schema('notes', [table])
}

function noteQuery() {
  const builder = new IrBuilder()
  return builder.query(
    [
      builder.projection('id', builder.column('id', 'n')),
      builder.projection('body', builder.column('body', 'n')),
    ],
    {
      from: { kind: 'table', id: builder.id(), name: 'notes', alias: 'n' },
      where: builder.binary('eq', builder.column('id', 'n'), builder.literal(values.int64(1n))),
      resultMode: { kind: 'multiset' },
    },
  )
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
