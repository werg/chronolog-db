import { encodeCanonicalCbor, integerMap } from '@chronolog/canonical'
import { type TransactionProgram } from '@chronolog/ir'
import { describe, expect, it } from 'vitest'

import {
  ProtocolError, compareTransactionOrder, createPayloadManifest, decodeEnvelope,
  decodeTransactionCore, decodeValidatorAttestation, encodeEnvelope, encodeTransactionCore,
  encodeValidatorAttestation, payloadDigest, resolveEnvelopePayload, transactionDigest,
  transactionOrderKey, type ChronologEnvelope, type TransactionCore, type ValidatorAttestation,
} from './index.js'

const bytes = (value: number, length = 32) => new Uint8Array(length).fill(value)

function program(): TransactionProgram {
  return {
    preconditions: [{
      kind: 'assert', id: 4, unknownIsFailure: true,
      query: {
        id: 1, ctes: [], joins: [], groupBy: [], windows: [], compounds: [], orderBy: [],
        projection: [{ id: 2, name: 'allowed', expression: { kind: 'literal', id: 3, value: { kind: 'boolean', value: true } } }],
        resultMode: { kind: 'scalar' },
      },
    }],
    mutations: [{
      kind: 'insert', id: 5, target: { kind: 'name', name: 'effects' }, columns: ['id'],
      rows: [[{ kind: 'literal', id: 6, value: { kind: 'int64', value: 1n } }]],
      conflict: 'error', affectedRows: { kind: 'exactly', count: 1n },
    }],
    metadata: new Map([['intent', bytes(9, 4)]]),
  }
}

function transaction(): TransactionCore {
  return {
    groupId: bytes(1), membershipRevision: bytes(2), validationPolicy: bytes(3), authorId: bytes(4),
    authorTimestampMs: 1_720_000_000_123n, nonce: bytes(5, 24), executionManifestDigest: bytes(6),
    schemaDigest: bytes(7), program: program(), metadata: new Map([['client', bytes(8, 4)]]),
  }
}

describe('IR transaction schema', () => {
  it('round trips direct nested IR and yields a stable digest', async () => {
    const input = transaction(), encoded = encodeTransactionCore(input), decoded = decodeTransactionCore(encoded)
    expect(encodeTransactionCore(decoded)).toEqual(encoded)
    expect(await transactionDigest(decoded)).toEqual(await transactionDigest(encoded))
    expect(decoded.program.mutations[0]?.kind).toBe('insert')
    expect(Buffer.from(encoded).includes(Buffer.from('SELECT'))).toBe(false)
  })

  it('rejects old raw-SQL transaction bytes rather than negotiating a legacy shape', () => {
    const old = encodeCanonicalCbor(integerMap([
      [0, 1n], [1, bytes(1)], [2, bytes(2)], [3, bytes(3)], [4, bytes(4)], [5, 1n],
      [6, bytes(5, 16)], [7, 'chronolog-sql-v1'], [8, 0n], [9, []], [10, []],
    ]))
    expect(() => decodeTransactionCore(old)).toThrowError(expect.objectContaining<Partial<ProtocolError>>({ code: 'SCHEMA_INVALID' }))
  })

  it('commits every manifest, schema, program, and context field to candidate identity', async () => {
    const base = transaction(), digest = await transactionDigest(base)
    const variants: TransactionCore[] = [
      { ...base, authorTimestampMs: base.authorTimestampMs + 1n },
      { ...base, nonce: bytes(99, 24) },
      { ...base, executionManifestDigest: bytes(99) },
      { ...base, schemaDigest: bytes(98) },
      { ...base, program: { ...base.program, metadata: new Map([['changed', bytes(1)]]) } },
    ]
    for (const variant of variants) expect(await transactionDigest(variant)).not.toEqual(digest)
  })

  it('enforces timestamp, digest, nonce, precondition, and mutation boundaries', () => {
    const input = transaction()
    for (const invalid of [
      { ...input, authorTimestampMs: 1n << 63n },
      { ...input, nonce: bytes(1, 15) },
      { ...input, schemaDigest: bytes(1, 31) },
      { ...input, executionManifestDigest: bytes(1, 31) },
      { ...input, groupId: bytes(1, 31) },
      { ...input, membershipRevision: bytes(1, 31) },
      { ...input, validationPolicy: bytes(1, 31) },
      { ...input, authorId: bytes(1, 31) },
      { ...input, program: { ...input.program, preconditions: [] } },
      { ...input, program: { ...input.program, mutations: [] } },
    ]) expect(() => encodeTransactionCore(invalid)).toThrow()
  })
})

describe('protocol messages and immutable ordering', () => {
  it('round trips inline and chunked envelopes', () => {
    const inline: ChronologEnvelope = { groupRoute: bytes(1, 16), messageType: 'candidate', encryptionEpoch: bytes(2, 8), payloadDigest: bytes(3), payload: { type: 'inline', bytes: bytes(4, 20) } }
    expect(encodeEnvelope(decodeEnvelope(encodeEnvelope(inline)))).toEqual(encodeEnvelope(inline))
    const chunked: ChronologEnvelope = { ...inline, payload: { type: 'manifest', manifest: { totalDigest: bytes(5), totalSize: 5n, chunks: [{ digest: bytes(6), size: 2n }, { digest: bytes(7), size: 3n }] } } }
    expect(decodeEnvelope(encodeEnvelope(chunked))).toMatchObject({ messageType: 'candidate', payload: { type: 'manifest' } })
  })

  it('verifies complete inline and chunked payload commitments', async () => {
    const chunks = [bytes(1, 3), bytes(2, 4)], manifest = await createPayloadManifest(chunks)
    const fullPayload = new Uint8Array([...chunks[0]!, ...chunks[1]!])
    const envelope: ChronologEnvelope = { groupRoute: bytes(1, 16), messageType: 'candidate', encryptionEpoch: null, payloadDigest: await payloadDigest(fullPayload), payload: { type: 'manifest', manifest } }
    expect(await resolveEnvelopePayload(envelope, chunks)).toEqual(fullPayload)
    await expect(resolveEnvelopePayload(envelope, [chunks[0]!, bytes(9, 4)])).rejects.toMatchObject({ code: 'DIGEST_MISMATCH' })
  })

  it('requires the author timestamp to exceed the validator cutoff', () => {
    const value: ValidatorAttestation = { groupId: bytes(1), membershipRevision: bytes(2), validatorCapability: bytes(3), txId: bytes(4), validatorId: bytes(5), authorTimestampMs: 1001n, acceptedAboveMs: 1000n, candidateDigest: bytes(6), decision: 'admit', policyVersion: 1n }
    expect(decodeValidatorAttestation(encodeValidatorAttestation(value))).toEqual(value)
    expect(() => encodeValidatorAttestation({ ...value, authorTimestampMs: 1000n })).toThrowError(expect.objectContaining<Partial<ProtocolError>>({ code: 'SCHEMA_INVALID' }))
  })

  it('orders only by timestamp and immutable SSB tie breakers', () => {
    const core = transaction(), first = transactionOrderKey(core, { authorFeedSequence: 9n, txId: bytes(9) })
    const earlierClock = { ...first, authorTimestampMs: first.authorTimestampMs - 1n, txId: bytes(255) }, otherAuthor = { ...first, authorId: bytes(5), authorFeedSequence: 0n }
    expect(compareTransactionOrder(earlierClock, first)).toBeLessThan(0)
    expect(compareTransactionOrder(first, otherAuthor)).toBeLessThan(0)
    expect(compareTransactionOrder(first, { ...first, txId: bytes(10) })).toBeLessThan(0)
  })
})
