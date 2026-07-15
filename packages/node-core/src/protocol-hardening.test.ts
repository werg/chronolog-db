import { IrBuilder, values } from '@chronolog/ir'
import {
  createDoltLiteLegacyMaterializationRuntime,
  type DoltLiteLegacyMaterializer,
} from '@chronolog/materializer-doltlite'
import {
  encodeTransactionCore,
  encodeValidatorAttestation,
  generateEd25519KeyPair,
  transactionDigest,
  utf8,
  type TransactionCore,
  type ValidatorAttestation,
} from '@chronolog/protocol'
import { ControlStore, type ControlStorePersistence, type ControlStoreSnapshot } from '@chronolog/control-store'
import { MemoryTransportNetwork, type ChronologTransport, type TransportRecord } from '@chronolog/transport-ssb'
import { afterEach, describe, expect, it } from 'vitest'

import { ChronologNode } from './node.js'
import type { ChronologNodeOptions, MembershipResolver } from './types.js'
import { encodeSignedEnvelope } from './wire.js'

describe('ChronologNode protocol hardening', () => {
  const nodes: ChronologNode[] = []
  const transports: ChronologTransport[] = []

  afterEach(async () => {
    await Promise.all(nodes.splice(0).map(async (node) => node.close()))
    await Promise.all(transports.splice(0).map(async (transport) => transport.close()))
  })

  it('rejects a copied signed candidate published on a different outer feed', async () => {
    const writer = await generateEd25519KeyPair()
    const observer = await generateEd25519KeyPair()
    const network = new MemoryTransportNetwork()
    const writerTransport = network.createNode('writer-feed')
    const attackerTransport = network.createNode('attacker-feed')
    const observerTransport = network.createNode('observer-feed')
    transports.push(attackerTransport)
    network.connectAll()
    const pins = protocolPins()
    const membership = membershipFor(pins, {
      writers: [[writer.publicKeyBytes, 'writer-feed']],
    })
    const writerNode = makeNode(writer, writerTransport, membership, pins)
    const observerNode = makeNode(observer, observerTransport, membership, pins)
    nodes.push(writerNode, observerNode)
    await Promise.all([writerNode.start(), observerNode.start()])

    await writerNode.publish({ program: testProgram(), authorTimestampMs: 100n, nonce: bytes32(10) })
    const original = (await writerTransport.history()).find((record) => record.author === 'writer-feed')!
    await attackerTransport.publish(original.payload)

    await eventually(async () => (await observerNode.status()).processedTransportRecords >= 2)
    expect(observerNode.controlStore.listCandidates()).toHaveLength(1)
    // Invalid remote protocol input is terminal for that record, but does not
    // permanently degrade an otherwise healthy node.
    expect((await observerNode.status()).lastError).toBeUndefined()
  })

  it('validates every attestation field at admission regardless of delivery order', async () => {
    const writer = await generateEd25519KeyPair()
    const validator = await generateEd25519KeyPair()
    const observer = await generateEd25519KeyPair()
    const network = new MemoryTransportNetwork()
    const writerTransport = network.createNode('writer-feed')
    const validatorTransport = network.createNode('validator-feed')
    const observerTransport = network.createNode('observer-feed')
    transports.push(writerTransport, validatorTransport)
    const pins = protocolPins()
    const capability = bytes32(9)
    const membership = membershipFor(pins, {
      writers: [[writer.publicKeyBytes, 'writer-feed']],
      validators: [[validator.publicKeyBytes, capability, 'validator-feed']],
    })
    const node = makeNode(observer, observerTransport, membership, pins)
    nodes.push(node)
    await node.start()

    const core = transactionCore(writer.publicKeyBytes, pins, 1_000n)
    const canonical = encodeTransactionCore(core)
    const candidateRecord = await writerTransport.publish(
      await encodeSignedEnvelope(pins.groupId, 'candidate', canonical, writer),
    )
    const txId = utf8(candidateRecord.id)
    const digest = await transactionDigest(canonical)
    const base: ValidatorAttestation = {
      groupId: pins.groupId,
      membershipRevision: pins.membershipRevision,
      validatorCapability: capability,
      txId,
      validatorId: validator.publicKeyBytes,
      authorTimestampMs: core.authorTimestampMs,
      acceptedAboveMs: 100n,
      candidateDigest: digest,
      decision: 'admit',
      policyVersion: 1n,
    }
    const invalidProofs: readonly ValidatorAttestation[] = [
      { ...base, membershipRevision: bytes32(77) },
      { ...base, authorTimestampMs: 999n },
      { ...base, policyVersion: 2n },
      { ...base, candidateDigest: bytes32(78) },
    ]
    for (const proof of invalidProofs) {
      const record = await validatorTransport.publish(await encodeSignedEnvelope(
        pins.groupId,
        'attestation',
        encodeValidatorAttestation(proof),
        validator,
      ))
      await node.ingest(record)
    }

    await node.ingest(candidateRecord)
    expect(node.candidate(txId)?.state).toBe('pending_validation')
    expect(node.controlStore.attestationsFor(txId)).toHaveLength(invalidProofs.length)

    const validRecord = await validatorTransport.publish(await encodeSignedEnvelope(
      pins.groupId,
      'attestation',
      encodeValidatorAttestation(base),
      validator,
    ))
    await node.ingest(validRecord)
    expect(node.candidate(txId)?.state).toBe('admissible')
    expect(node.candidate(txId)?.proofAttestationIds).toEqual([utf8(validRecord.id)])
  })

  it('recovers its validator cutoff from its authenticated feed tail before validating', async () => {
    const writer = await generateEd25519KeyPair()
    const validator = await generateEd25519KeyPair()
    const network = new MemoryTransportNetwork()
    const writerTransport = network.createNode('writer-feed')
    const validatorTransport = network.createNode('validator-feed')
    const pins = protocolPins()
    const capability = bytes32(9)
    const core = transactionCore(writer.publicKeyBytes, pins, 400n)
    const canonical = encodeTransactionCore(core)
    const candidateRecord = await writerTransport.publish(
      await encodeSignedEnvelope(pins.groupId, 'candidate', canonical, writer),
    )
    const historicalProof: ValidatorAttestation = {
      groupId: pins.groupId,
      membershipRevision: pins.membershipRevision,
      validatorCapability: capability,
      txId: utf8('%older-candidate.sha256'),
      validatorId: validator.publicKeyBytes,
      authorTimestampMs: 600n,
      acceptedAboveMs: 500n,
      candidateDigest: bytes32(20),
      decision: 'admit',
      policyVersion: 1n,
    }
    await validatorTransport.publish(await encodeSignedEnvelope(
      pins.groupId,
      'attestation',
      encodeValidatorAttestation(historicalProof),
      validator,
    ))
    network.connect(writerTransport, validatorTransport)
    const membership = membershipFor(pins, {
      writers: [[writer.publicKeyBytes, 'writer-feed']],
      validators: [[validator.publicKeyBytes, capability, 'validator-feed']],
    })
    const node = makeNode(validator, validatorTransport, membership, pins, {
      validator: { capabilityId: capability, cutoffLagMs: 0 },
      clock: { now: () => 500 },
    })
    nodes.push(node)
    const before = (await validatorTransport.history()).length

    await node.start()

    expect(node.controlStore.validatorCutoff(validator.publicKeyBytes)).toBe(500n)
    expect(node.controlStore.attestationsFor(utf8(candidateRecord.id))).toHaveLength(0)
    expect(await validatorTransport.history()).toHaveLength(before)
  })

  it('persists a cutoff synchronously before publishing a heartbeat', async () => {
    const validator = await generateEd25519KeyPair()
    const pins = protocolPins()
    const capability = bytes32(9)
    const persistence = new InspectablePersistence()
    const controlStore = new ControlStore(persistence)
    const transport = new InspectingTransport('validator-feed', () => {
      expect(controlStore.validatorCutoff(validator.publicKeyBytes)).toBe(900n)
      expect(persistence.snapshot?.validatorCutoffs?.[0]?.acceptedAboveMs).toBe(900n)
    })
    const membership = membershipFor(pins, {
      validators: [[validator.publicKeyBytes, capability, 'validator-feed']],
    })
    const node = makeNode(validator, transport, membership, pins, {
      controlStore,
      validator: { capabilityId: capability, cutoffLagMs: 100 },
      clock: { now: () => 1_000 },
    })
    nodes.push(node)
    await node.start()

    await node.publishHeartbeat()

    expect(node.controlStore.validatorCutoff(validator.publicKeyBytes)).toBe(900n)
  })

  it('retries transient resolver failures instead of permanently marking the record seen', async () => {
    const writer = await generateEd25519KeyPair()
    const observer = await generateEd25519KeyPair()
    const network = new MemoryTransportNetwork()
    const writerTransport = network.createNode('writer-feed')
    const observerTransport = network.createNode('observer-feed')
    const pins = protocolPins()
    const core = transactionCore(writer.publicKeyBytes, pins, 100n)
    await writerTransport.publish(await encodeSignedEnvelope(
      pins.groupId,
      'candidate',
      encodeTransactionCore(core),
      writer,
    ))
    network.connect(writerTransport, observerTransport)
    let attempts = 0
    const membership = membershipFor(pins, { writers: [[writer.publicKeyBytes, 'writer-feed']] })
    const transientMembership: MembershipResolver = {
      ...membership,
      canWrite: (context) => {
        attempts += 1
        if (attempts === 1) throw new Error('MEMBERSHIP_TEMPORARILY_UNAVAILABLE')
        return membership.canWrite(context)
      },
    }
    const node = makeNode(observer, observerTransport, transientMembership, pins)
    nodes.push(node)

    await node.start()
    await eventually(() => node.controlStore.listCandidates().length === 1)

    expect(attempts).toBeGreaterThanOrEqual(2)
    expect(node.controlStore.listCandidates()).toHaveLength(1)
    expect((await node.status()).lastError).toBeUndefined()
  })

  it('bounds transient retry memory and recovers overflowed records from transport history', async () => {
    const writer = await generateEd25519KeyPair()
    const observer = await generateEd25519KeyPair()
    const network = new MemoryTransportNetwork()
    const writerTransport = network.createNode('writer-feed')
    const observerTransport = network.createNode('observer-feed')
    const pins = protocolPins()
    for (const timestamp of [100n, 101n]) {
      const core = transactionCore(writer.publicKeyBytes, pins, timestamp)
      await writerTransport.publish(await encodeSignedEnvelope(
        pins.groupId, 'candidate', encodeTransactionCore(core), writer,
      ))
    }
    network.connect(writerTransport, observerTransport)
    let available = false
    const membership = membershipFor(pins, { writers: [[writer.publicKeyBytes, 'writer-feed']] })
    const transientMembership: MembershipResolver = {
      ...membership,
      canWrite: (context) => {
        if (!available) throw new Error('MEMBERSHIP_TEMPORARILY_UNAVAILABLE')
        return membership.canWrite(context)
      },
    }
    const node = makeNode(observer, observerTransport, transientMembership, pins, { maximumRetryRecords: 1 })
    nodes.push(node)

    await node.start()
    available = true
    await eventually(() => node.controlStore.listCandidates().length === 2)

    expect(node.controlStore.listCandidates()).toHaveLength(2)
  })
})

interface Pins {
  readonly groupId: Uint8Array
  readonly membershipRevision: Uint8Array
  readonly validationPolicy: Uint8Array
  readonly schemaDigest: Uint8Array
  readonly executionManifestDigest: Uint8Array
}

function protocolPins(): Pins {
  return {
    groupId: bytes32(1),
    membershipRevision: bytes32(2),
    validationPolicy: bytes32(3),
    schemaDigest: bytes32(4),
    executionManifestDigest: bytes32(5),
  }
}

function membershipFor(
  pins: Pins,
  members: {
    readonly writers?: readonly (readonly [Uint8Array, string])[]
    readonly validators?: readonly (readonly [Uint8Array, Uint8Array, string])[]
  },
): MembershipResolver {
  const writers = members.writers ?? []
  const validators = members.validators ?? []
  return {
    canWrite: ({ writerId }) => writers.some(([key]) => equal(key, writerId)),
    canValidate: ({ validatorId, validatorCapability }) => validators.some(([key, capability]) =>
      equal(key, validatorId) && equal(capability, validatorCapability)),
    threshold: () => 1,
    policyVersion: () => 1n,
    canHeartbeat: ({ groupId, membershipRevision, validatorId, validatorCapability }) =>
      equal(groupId, pins.groupId) && equal(membershipRevision, pins.membershipRevision) &&
      validators.some(([key, capability]) => equal(key, validatorId) && equal(capability, validatorCapability)),
    canUseTransportAuthor: ({ role, signingId, transportAuthor, validatorCapability }) =>
      role === 'writer'
        ? writers.some(([key, feed]) => equal(key, signingId) && feed === transportAuthor)
        : validators.some(([key, capability, feed]) =>
            equal(key, signingId) && equal(capability, validatorCapability ?? new Uint8Array()) && feed === transportAuthor),
  }
}

function makeNode(
  identity: Awaited<ReturnType<typeof generateEd25519KeyPair>>,
  transport: ChronologTransport,
  membership: MembershipResolver,
  pins: Pins,
  overrides: Partial<Pick<ChronologNodeOptions, 'controlStore' | 'validator' | 'clock' | 'maximumRetryRecords'>> = {},
): ChronologNode {
  return new ChronologNode({
    ...pins,
    identity,
    transport,
    membership,
    materialization: createDoltLiteLegacyMaterializationRuntime(fakeMaterializer(pins)),
    ...overrides,
  })
}

function fakeMaterializer(pins: Pins): DoltLiteLegacyMaterializer {
  let revision = 0n
  let orderLength = 0
  return {
    get revision() { return revision },
    get orderLength() { return orderLength },
    schemaDigest: pins.schemaDigest,
    executionManifestDigest: pins.executionManifestDigest,
    materialize: async (transactions: readonly unknown[]) => {
      orderLength = transactions.length
      revision += 1n
      return null
    },
    close: () => {},
  } as unknown as DoltLiteLegacyMaterializer
}

function transactionCore(authorId: Uint8Array, pins: Pins, authorTimestampMs: bigint): TransactionCore {
  return {
    groupId: pins.groupId,
    membershipRevision: pins.membershipRevision,
    validationPolicy: pins.validationPolicy,
    authorId,
    authorTimestampMs,
    nonce: bytes32(6),
    schemaDigest: pins.schemaDigest,
    executionManifestDigest: pins.executionManifestDigest,
    program: testProgram(),
  }
}

function testProgram() {
  const ir = new IrBuilder()
  return ir.program([
    ir.assertion(ir.query([
      ir.projection('ok', ir.literal(values.boolean(true))),
    ], { resultMode: { kind: 'scalar' } })),
  ], [
    ir.insert('test_rows', ['id'], [[ir.literal(values.int64(1n))]], { kind: 'exactly', count: 1n }),
  ])
}

class InspectablePersistence implements ControlStorePersistence {
  snapshot: ControlStoreSnapshot | null = null
  load(): ControlStoreSnapshot | null { return this.snapshot === null ? null : structuredClone(this.snapshot) }
  save(snapshot: ControlStoreSnapshot): void { this.snapshot = structuredClone(snapshot) }
}

class InspectingTransport implements ChronologTransport {
  readonly #records: TransportRecord[] = []
  #sequence = 0n
  constructor(readonly identity: string, private readonly beforePublish: () => void) {}
  async publish(payload: Uint8Array): Promise<TransportRecord> {
    this.beforePublish()
    this.#sequence += 1n
    const record: TransportRecord = {
      id: `%inspect-${this.#sequence}.sha256`,
      author: this.identity,
      sequence: this.#sequence,
      receivedAtMs: 1_000,
      payload: payload.slice(),
    }
    this.#records.push(record)
    return structuredClone(record)
  }
  async get(id: string): Promise<TransportRecord | undefined> {
    return structuredClone(this.#records.find((record) => record.id === id))
  }
  async history(): Promise<readonly TransportRecord[]> { return structuredClone(this.#records) }
  subscribe(): AsyncIterable<TransportRecord> { return { async *[Symbol.asyncIterator]() {} } }
  async status() {
    return {
      identity: this.identity,
      records: this.#records.length,
      closed: false,
      peers: [],
      feedStates: [{
        feedId: this.identity,
        contiguousThrough: this.#sequence.toString(10),
        maximumSequence: this.#sequence.toString(10),
        hasGaps: false,
      }],
      feedsWithGaps: 0,
    }
  }
  async close(): Promise<void> {}
}

async function eventually(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 3_000
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error('condition did not become true')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

function bytes32(seed: number): Uint8Array {
  return Uint8Array.from({ length: 32 }, (_value, index) => (seed + index) & 0xff)
}

function equal(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}
