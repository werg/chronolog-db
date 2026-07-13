import {
  DOMAINS,
  ProtocolError,
  assertCanonicalCbor,
  assertKnownIntegerKeys,
  compareBytes,
  encodeCanonicalCbor,
  equalBytes,
  expectArray,
  expectBytes,
  expectMap,
  expectString,
  expectUint64,
  expectVersion,
  integerMap,
  protocolInvariant,
  required,
  signDomain,
  verifyDomain,
  type CborValue,
} from '@chronolog/protocol'
import { HPKE_SUITE, hpkeOpenBase, hpkeSealBase } from './hpke.js'

export interface EpochRecipient {
  readonly recipientId: Uint8Array
  readonly publicKey: Uint8Array
}

export interface EpochKeyWrap {
  readonly recipientId: Uint8Array
  readonly recipientPublicKey: Uint8Array
  readonly encapsulatedKey: Uint8Array
  readonly ciphertext: Uint8Array
}

export interface EpochManifest {
  readonly groupId: Uint8Array
  readonly epoch: bigint
  readonly previousEpochDigest: Uint8Array | null
  readonly suite: typeof HPKE_SUITE
  readonly createdAtMs: bigint
  readonly wraps: readonly EpochKeyWrap[]
}

export interface SignedEpochManifest {
  readonly manifest: EpochManifest
  readonly signerPublicKey: Uint8Array
  readonly signature: Uint8Array
}

export interface CreatedEpoch {
  readonly signedManifest: SignedEpochManifest
  readonly contentKey: Uint8Array
}

export interface EncryptedEpochPayload {
  readonly epoch: bigint
  readonly nonce: Uint8Array
  readonly ciphertext: Uint8Array
}

function source(value: Uint8Array): ArrayBuffer {
  return value.slice().buffer as ArrayBuffer
}

function wrapContext(groupId: Uint8Array, epoch: bigint, previous: Uint8Array | null, recipientId: Uint8Array): Uint8Array {
  return encodeCanonicalCbor(integerMap([[0, groupId], [1, epoch], [2, previous], [3, recipientId], [4, HPKE_SUITE]]))
}

function wrapToCbor(value: EpochKeyWrap): CborValue {
  return integerMap([[0, value.recipientId], [1, value.recipientPublicKey], [2, value.encapsulatedKey], [3, value.ciphertext]])
}

function manifestToCbor(value: EpochManifest): CborValue {
  protocolInvariant(value.epoch >= 0n, 'INTEGER_OUT_OF_RANGE', 'Encryption epoch cannot be negative')
  protocolInvariant(value.suite === HPKE_SUITE, 'SCHEMA_INVALID', 'Unsupported HPKE suite')
  protocolInvariant(value.wraps.length > 0, 'SCHEMA_INVALID', 'Epoch manifest requires at least one recipient')
  const sorted = [...value.wraps].sort((a, b) => compareBytes(a.recipientId, b.recipientId))
  for (let index = 1; index < sorted.length; index += 1) {
    protocolInvariant(compareBytes(sorted[index - 1]?.recipientId ?? new Uint8Array(), sorted[index]?.recipientId ?? new Uint8Array()) !== 0, 'SCHEMA_INVALID', 'Epoch manifest contains duplicate recipient')
  }
  return integerMap([
    [0, 1n], [1, value.groupId], [2, value.epoch], [3, value.previousEpochDigest],
    [4, value.suite], [5, value.createdAtMs], [6, sorted.map(wrapToCbor)],
  ])
}

export function encodeEpochManifest(value: EpochManifest): Uint8Array {
  return encodeCanonicalCbor(manifestToCbor(value))
}

export function decodeEpochManifest(bytes: Uint8Array): EpochManifest {
  const map = expectMap(assertCanonicalCbor(bytes), 'epoch_manifest')
  assertKnownIntegerKeys(map, [0, 1, 2, 3, 4, 5, 6], 'epoch_manifest')
  expectVersion(map, 1n, 'epoch_manifest')
  const previous = required(map, 3, 'epoch_manifest.previous')
  protocolInvariant(previous === null || previous instanceof Uint8Array, 'SCHEMA_INVALID', 'Previous epoch digest must be null or bytes')
  const suite = expectString(required(map, 4, 'epoch_manifest.suite'), 'epoch_manifest.suite')
  protocolInvariant(suite === HPKE_SUITE, 'SCHEMA_INVALID', 'Unsupported HPKE suite')
  const manifest: EpochManifest = {
    groupId: expectBytes(required(map, 1, 'epoch_manifest.group_id'), 'epoch_manifest.group_id'),
    epoch: expectUint64(required(map, 2, 'epoch_manifest.epoch'), 'epoch_manifest.epoch'),
    previousEpochDigest: previous,
    suite,
    createdAtMs: expectUint64(required(map, 5, 'epoch_manifest.created_at'), 'epoch_manifest.created_at'),
    wraps: expectArray(required(map, 6, 'epoch_manifest.wraps'), 'epoch_manifest.wraps').map((item, index) => {
      const wrap = expectMap(item, `epoch_manifest.wraps[${index}]`)
      assertKnownIntegerKeys(wrap, [0, 1, 2, 3], `epoch_manifest.wraps[${index}]`)
      return {
        recipientId: expectBytes(required(wrap, 0, 'wrap.recipient_id'), 'wrap.recipient_id'),
        recipientPublicKey: expectBytes(required(wrap, 1, 'wrap.recipient_key'), 'wrap.recipient_key', 32),
        encapsulatedKey: expectBytes(required(wrap, 2, 'wrap.encapsulated_key'), 'wrap.encapsulated_key', 32),
        ciphertext: expectBytes(required(wrap, 3, 'wrap.ciphertext'), 'wrap.ciphertext'),
      }
    }),
  }
  manifestToCbor(manifest)
  return manifest
}

export function encodeSignedEpochManifest(value: SignedEpochManifest): Uint8Array {
  return encodeCanonicalCbor(integerMap([
    [0, 1n],
    [1, encodeEpochManifest(value.manifest)],
    [2, value.signerPublicKey],
    [3, value.signature],
  ]))
}

export function decodeSignedEpochManifest(bytes: Uint8Array): SignedEpochManifest {
  const map = expectMap(assertCanonicalCbor(bytes), 'signed_epoch_manifest')
  assertKnownIntegerKeys(map, [0, 1, 2, 3], 'signed_epoch_manifest')
  expectVersion(map, 1n, 'signed_epoch_manifest')
  return {
    manifest: decodeEpochManifest(expectBytes(required(map, 1, 'signed_epoch_manifest.payload'), 'signed_epoch_manifest.payload')),
    signerPublicKey: expectBytes(required(map, 2, 'signed_epoch_manifest.signer'), 'signed_epoch_manifest.signer', 32),
    signature: expectBytes(required(map, 3, 'signed_epoch_manifest.signature'), 'signed_epoch_manifest.signature', 64),
  }
}

export async function createEpochManifest(input: {
  readonly groupId: Uint8Array
  readonly epoch: bigint
  readonly previousEpochDigest: Uint8Array | null
  readonly createdAtMs: bigint
  readonly recipients: readonly EpochRecipient[]
  readonly signerPublicKey: Uint8Array
  readonly signerPrivateKey: CryptoKey
  readonly contentKey?: Uint8Array
}): Promise<CreatedEpoch> {
  const contentKey = input.contentKey?.slice() ?? globalThis.crypto.getRandomValues(new Uint8Array(32))
  protocolInvariant(contentKey.length === 32, 'SCHEMA_INVALID', 'Epoch content key must contain 32 bytes')
  const recipients = [...input.recipients].sort((a, b) => compareBytes(a.recipientId, b.recipientId))
  protocolInvariant(recipients.length > 0, 'SCHEMA_INVALID', 'Epoch requires at least one reader recipient')
  const wraps: EpochKeyWrap[] = []
  for (let index = 0; index < recipients.length; index += 1) {
    const recipient = recipients[index] as EpochRecipient
    if (index > 0) protocolInvariant(compareBytes(recipients[index - 1]?.recipientId ?? new Uint8Array(), recipient.recipientId) !== 0, 'SCHEMA_INVALID', 'Epoch recipients must be unique')
    const context = wrapContext(input.groupId, input.epoch, input.previousEpochDigest, recipient.recipientId)
    const sealed = await hpkeSealBase(recipient.publicKey, contentKey, context, context)
    wraps.push({
      recipientId: recipient.recipientId,
      recipientPublicKey: recipient.publicKey,
      encapsulatedKey: sealed.encapsulatedKey,
      ciphertext: sealed.ciphertext,
    })
  }
  const manifest: EpochManifest = {
    groupId: input.groupId,
    epoch: input.epoch,
    previousEpochDigest: input.previousEpochDigest,
    suite: HPKE_SUITE,
    createdAtMs: input.createdAtMs,
    wraps,
  }
  const signature = await signDomain(DOMAINS.epochManifest, encodeEpochManifest(manifest), input.signerPrivateKey)
  return { signedManifest: { manifest, signerPublicKey: input.signerPublicKey, signature }, contentKey }
}

export async function verifyEpochManifest(value: SignedEpochManifest, trustedSigner: Uint8Array): Promise<boolean> {
  return equalBytes(value.signerPublicKey, trustedSigner)
    && verifyDomain(DOMAINS.epochManifest, encodeEpochManifest(value.manifest), value.signature, trustedSigner)
}

export async function unwrapEpochKey(input: {
  readonly signedManifest: SignedEpochManifest
  readonly trustedSigner: Uint8Array
  readonly recipientId: Uint8Array
  readonly recipientPrivateKey: CryptoKey
}): Promise<Uint8Array> {
  protocolInvariant(await verifyEpochManifest(input.signedManifest, input.trustedSigner), 'INVALID_SIGNATURE', 'Epoch manifest signature is invalid')
  const { manifest } = input.signedManifest
  const wrap = manifest.wraps.find((candidate) => equalBytes(candidate.recipientId, input.recipientId))
  protocolInvariant(wrap !== undefined, 'INVALID_KEY', 'Epoch manifest has no wrap for recipient')
  const context = wrapContext(manifest.groupId, manifest.epoch, manifest.previousEpochDigest, input.recipientId)
  const key = await hpkeOpenBase(
    input.recipientPrivateKey,
    wrap.recipientPublicKey,
    wrap.encapsulatedKey,
    wrap.ciphertext,
    context,
    context,
  )
  protocolInvariant(key.length === 32, 'INVALID_KEY', 'Unwrapped epoch key has invalid length')
  return key
}

function payloadAad(epoch: bigint, associatedData: Uint8Array): Uint8Array {
  return encodeCanonicalCbor(integerMap([[0, 1n], [1, epoch], [2, associatedData]]))
}

export async function encryptEpochPayload(
  contentKey: Uint8Array,
  epoch: bigint,
  plaintext: Uint8Array,
  associatedData: Uint8Array,
): Promise<EncryptedEpochPayload> {
  protocolInvariant(contentKey.length === 32, 'INVALID_KEY', 'Epoch content key must contain 32 bytes')
  const key = await globalThis.crypto.subtle.importKey('raw', source(contentKey), 'AES-GCM', false, ['encrypt'])
  const nonce = globalThis.crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = new Uint8Array(await globalThis.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: source(nonce), additionalData: source(payloadAad(epoch, associatedData)), tagLength: 128 },
    key,
    source(plaintext),
  ))
  return { epoch, nonce, ciphertext }
}

export async function decryptEpochPayload(
  contentKey: Uint8Array,
  payload: EncryptedEpochPayload,
  associatedData: Uint8Array,
): Promise<Uint8Array> {
  protocolInvariant(contentKey.length === 32, 'INVALID_KEY', 'Epoch content key must contain 32 bytes')
  protocolInvariant(payload.nonce.length === 12, 'SCHEMA_INVALID', 'Epoch payload nonce must contain 12 bytes')
  try {
    const key = await globalThis.crypto.subtle.importKey('raw', source(contentKey), 'AES-GCM', false, ['decrypt'])
    return new Uint8Array(await globalThis.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: source(payload.nonce), additionalData: source(payloadAad(payload.epoch, associatedData)), tagLength: 128 },
      key,
      source(payload.ciphertext),
    ))
  } catch {
    throw new ProtocolError('INVALID_SIGNATURE', 'Epoch payload authentication failed')
  }
}
