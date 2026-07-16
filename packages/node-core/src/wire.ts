import {
  DOMAINS,
  assertCanonicalCbor,
  decodeEnvelope,
  encodeCanonicalCbor,
  encodeEnvelope,
  equalBytes,
  hashDomain,
  resolveEnvelopePayload,
  signDomain,
  verifyDomain,
  type CborValue,
  type Ed25519KeyPair,
  type EnvelopeMessageType,
  type ProtocolDomain,
} from '@chronolog/protocol'

import type { EnvelopeCipher, EnvelopeCipherResolver } from './types.js'
import { loadEnvelopePayload, storeEnvelopePayload, type EnvelopeBlobOptions, type ContentAddressedBlobStore } from './blobs.js'

export interface SignedWireMessage {
  readonly type: Extract<EnvelopeMessageType, 'candidate' | 'attestation' | 'heartbeat'>
  readonly payload: Uint8Array
  readonly signer: Uint8Array
  readonly signature: Uint8Array
}

const WIRE_TYPES = ['candidate', 'attestation', 'heartbeat'] as const

function domainFor(type: SignedWireMessage['type']): ProtocolDomain {
  if (type === 'candidate') return DOMAINS.transaction
  if (type === 'attestation') return DOMAINS.attestation
  return DOMAINS.heartbeat
}

export async function encodeSignedEnvelope(
  groupRoute: Uint8Array,
  type: SignedWireMessage['type'],
  payload: Uint8Array,
  signer: Ed25519KeyPair,
  cipher?: EnvelopeCipher | EnvelopeCipherResolver,
  blobs?: EnvelopeBlobOptions,
): Promise<Uint8Array> {
  const activeCipher = cipher === undefined ? undefined : isCipherResolver(cipher) ? cipher.current() : cipher
  const signature = await signDomain(domainFor(type), payload, signer.privateKey)
  const wire = encodeCanonicalCbor([
    1n,
    BigInt(WIRE_TYPES.indexOf(type)),
    payload,
    signer.publicKeyBytes,
    signature,
  ])
  const epochId = activeCipher?.epochId ?? null
  const envelopePayload = activeCipher === undefined
    ? wire
    : await activeCipher.seal(wire, envelopeAssociatedData(groupRoute, type, activeCipher.epochId))
  const payloadField = blobs !== undefined && envelopePayload.length > blobs.maxInlineBytes
    ? { type: 'manifest' as const, manifest: (await storeEnvelopePayload(envelopePayload, blobs)).manifest }
    : { type: 'inline' as const, bytes: envelopePayload }
  return encodeEnvelope({
    groupRoute,
    messageType: type,
    encryptionEpoch: epochId,
    payloadDigest: await hashDomain(DOMAINS.envelope, envelopePayload),
    payload: payloadField,
  })
}

export async function decodeSignedEnvelope(
  encoded: Uint8Array,
  expectedGroupRoute: Uint8Array,
  cipher?: EnvelopeCipher | EnvelopeCipherResolver,
  blobStore?: ContentAddressedBlobStore,
): Promise<SignedWireMessage> {
  const envelope = decodeEnvelope(encoded)
  if (!equalBytes(envelope.groupRoute, expectedGroupRoute)) throw wireError('WIRE_WRONG_GROUP')
  let payloadBytes: Uint8Array
  if (envelope.payload.type === 'inline') payloadBytes = await resolveEnvelopePayload(envelope)
  else {
    if (blobStore === undefined) throw wireError('WIRE_BLOB_STORE_REQUIRED')
    payloadBytes = await loadEnvelopePayload(envelope.payload.manifest, blobStore)
  }
  if (!equalBytes(await hashDomain(DOMAINS.envelope, payloadBytes), envelope.payloadDigest)) {
    throw wireError('WIRE_DIGEST_MISMATCH')
  }
  const activeCipher = envelope.encryptionEpoch === null || cipher === undefined
    ? undefined
    : isCipherResolver(cipher) ? cipher.resolve(envelope.encryptionEpoch) : cipher
  if ((envelope.encryptionEpoch === null) !== (cipher === undefined)) throw wireError('WIRE_ENCRYPTION_REQUIRED')
  if (envelope.encryptionEpoch !== null && (activeCipher === undefined || !equalBytes(envelope.encryptionEpoch, activeCipher.epochId))) {
    throw wireError('WIRE_ENCRYPTION_EPOCH_UNKNOWN')
  }
  const wireBytes = activeCipher === undefined
    ? payloadBytes
    : await activeCipher.open(
      payloadBytes,
      envelopeAssociatedData(expectedGroupRoute, envelope.messageType as SignedWireMessage['type'], envelope.encryptionEpoch!),
    )
  const value = assertCanonicalCbor(wireBytes)
  if (!Array.isArray(value) || value.length !== 5 || value[0] !== 1n) {
    throw wireError('WIRE_SCHEMA_INVALID')
  }
  const fields = value as readonly CborValue[]
  const typeIndex = fields[1]
  const payload = fields[2]
  const signer = fields[3]
  const signature = fields[4]
  if (
    typeof typeIndex !== 'bigint' ||
    typeIndex < 0n ||
    typeIndex >= BigInt(WIRE_TYPES.length) ||
    !(payload instanceof Uint8Array) ||
    !(signer instanceof Uint8Array) ||
    !(signature instanceof Uint8Array)
  ) throw wireError('WIRE_SCHEMA_INVALID')
  const type = WIRE_TYPES[Number(typeIndex)]
  if (type === undefined || type !== envelope.messageType) throw wireError('WIRE_TYPE_MISMATCH')
  if (!await verifyDomain(domainFor(type), payload, signature, signer)) {
    throw wireError('WIRE_SIGNATURE_INVALID')
  }
  return { type, payload, signer, signature }
}

function isCipherResolver(value: EnvelopeCipher | EnvelopeCipherResolver): value is EnvelopeCipherResolver {
  return 'current' in value && typeof value.current === 'function'
}

function envelopeAssociatedData(
  groupRoute: Uint8Array,
  type: SignedWireMessage['type'],
  epochId: Uint8Array,
): Uint8Array {
  return encodeCanonicalCbor([1n, groupRoute, BigInt(WIRE_TYPES.indexOf(type)), epochId])
}

function wireError(code: string): Error {
  const error = new Error(code)
  error.name = 'ChronologWireError'
  return error
}

/** Public for compatibility vectors and transport adapters. */
export function signedWireToCanonicalValue(message: SignedWireMessage): CborValue {
  return [
    1n,
    BigInt(WIRE_TYPES.indexOf(message.type)),
    message.payload,
    message.signer,
    message.signature,
  ]
}
