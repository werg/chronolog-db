import { ProtocolError, concatBytes, protocolInvariant, utf8 } from '@chronolog/protocol'

export const HPKE_SUITE = 'DHKEM(X25519,HKDF-SHA256)/HKDF-SHA256/AES-256-GCM' as const

const KEM_ID = Uint8Array.of(0x00, 0x20)
const KDF_ID = Uint8Array.of(0x00, 0x01)
const AEAD_ID = Uint8Array.of(0x00, 0x02)
const KEM_SUITE_ID = concatBytes(utf8('KEM'), KEM_ID)
const HPKE_SUITE_ID = concatBytes(utf8('HPKE'), KEM_ID, KDF_ID, AEAD_ID)
const HPKE_VERSION = utf8('HPKE-v1')
const HASH_SIZE = 32

const X25519: AlgorithmIdentifier = { name: 'X25519' }

function source(value: Uint8Array): ArrayBuffer {
  return value.slice().buffer
}

function i2osp(value: number, length: number): Uint8Array {
  protocolInvariant(Number.isSafeInteger(value) && value >= 0 && value < 2 ** (8 * length), 'INTEGER_OUT_OF_RANGE', 'Integer does not fit HPKE field')
  const result = new Uint8Array(length)
  let remainder = value
  for (let index = length - 1; index >= 0; index -= 1) {
    result[index] = remainder & 0xff
    remainder = Math.floor(remainder / 256)
  }
  return result
}

async function hmac(keyBytes: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const key = await globalThis.crypto.subtle.importKey(
    'raw', source(keyBytes), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  )
  return new Uint8Array(await globalThis.crypto.subtle.sign('HMAC', key, source(data)))
}

async function hkdfExtract(salt: Uint8Array, ikm: Uint8Array): Promise<Uint8Array> {
  return hmac(salt.length === 0 ? new Uint8Array(HASH_SIZE) : salt, ikm)
}

async function hkdfExpand(prk: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  protocolInvariant(length <= 255 * HASH_SIZE, 'INTEGER_OUT_OF_RANGE', 'HKDF output is too long')
  let previous: Uint8Array = new Uint8Array()
  const blocks: Uint8Array[] = []
  for (let counter = 1; blocks.reduce((sum, block) => sum + block.length, 0) < length; counter += 1) {
    previous = await hmac(prk, concatBytes(previous, info, Uint8Array.of(counter)))
    blocks.push(previous)
  }
  return concatBytes(...blocks).slice(0, length)
}

async function labeledExtract(
  suiteId: Uint8Array,
  salt: Uint8Array,
  label: string,
  ikm: Uint8Array,
): Promise<Uint8Array> {
  return hkdfExtract(salt, concatBytes(HPKE_VERSION, suiteId, utf8(label), ikm))
}

async function labeledExpand(
  suiteId: Uint8Array,
  prk: Uint8Array,
  label: string,
  info: Uint8Array,
  length: number,
): Promise<Uint8Array> {
  return hkdfExpand(prk, concatBytes(i2osp(length, 2), HPKE_VERSION, suiteId, utf8(label), info), length)
}

export interface X25519KeyPair {
  readonly publicKey: CryptoKey
  readonly privateKey: CryptoKey
  readonly publicKeyBytes: Uint8Array
}

export interface HpkeCiphertext {
  readonly encapsulatedKey: Uint8Array
  readonly ciphertext: Uint8Array
}

export async function generateX25519KeyPair(extractable = true): Promise<X25519KeyPair> {
  const pair = await globalThis.crypto.subtle.generateKey(X25519, extractable, ['deriveBits']) as CryptoKeyPair
  return {
    publicKey: pair.publicKey,
    privateKey: pair.privateKey,
    publicKeyBytes: new Uint8Array(await globalThis.crypto.subtle.exportKey('raw', pair.publicKey)),
  }
}

export async function importX25519PublicKey(raw: Uint8Array): Promise<CryptoKey> {
  protocolInvariant(raw.length === 32, 'INVALID_KEY', 'X25519 public key must contain 32 bytes')
  try {
    return await globalThis.crypto.subtle.importKey('raw', source(raw), X25519, true, [])
  } catch {
    throw new ProtocolError('INVALID_KEY', 'Unable to import X25519 public key')
  }
}

export async function importX25519PrivateKey(pkcs8: Uint8Array, extractable = true): Promise<CryptoKey> {
  try {
    return await globalThis.crypto.subtle.importKey('pkcs8', source(pkcs8), X25519, extractable, ['deriveBits'])
  } catch {
    throw new ProtocolError('INVALID_KEY', 'Unable to import X25519 private key')
  }
}

export async function exportX25519PrivateKey(privateKey: CryptoKey): Promise<Uint8Array> {
  try {
    return new Uint8Array(await globalThis.crypto.subtle.exportKey('pkcs8', privateKey))
  } catch {
    throw new ProtocolError('INVALID_KEY', 'X25519 private key is not extractable')
  }
}

async function dh(privateKey: CryptoKey, publicKey: CryptoKey): Promise<Uint8Array> {
  try {
    const bits = await globalThis.crypto.subtle.deriveBits({ name: 'X25519', public: publicKey }, privateKey, 256)
    const result = new Uint8Array(bits)
    protocolInvariant(result.some((byte) => byte !== 0), 'INVALID_KEY', 'X25519 produced the prohibited all-zero shared secret')
    return result
  } catch (error) {
    if (error instanceof ProtocolError) throw error
    throw new ProtocolError('INVALID_KEY', 'X25519 key agreement failed')
  }
}

async function extractAndExpand(dhValue: Uint8Array, kemContext: Uint8Array): Promise<Uint8Array> {
  const eaePrk = await labeledExtract(KEM_SUITE_ID, new Uint8Array(), 'eae_prk', dhValue)
  return labeledExpand(KEM_SUITE_ID, eaePrk, 'shared_secret', kemContext, HASH_SIZE)
}

async function keySchedule(sharedSecret: Uint8Array, info: Uint8Array): Promise<{ key: Uint8Array; nonce: Uint8Array }> {
  const pskIdHash = await labeledExtract(HPKE_SUITE_ID, new Uint8Array(), 'psk_id_hash', new Uint8Array())
  const infoHash = await labeledExtract(HPKE_SUITE_ID, new Uint8Array(), 'info_hash', info)
  const keyScheduleContext = concatBytes(Uint8Array.of(0), pskIdHash, infoHash)
  const secret = await labeledExtract(HPKE_SUITE_ID, sharedSecret, 'secret', new Uint8Array())
  return {
    key: await labeledExpand(HPKE_SUITE_ID, secret, 'key', keyScheduleContext, 32),
    nonce: await labeledExpand(HPKE_SUITE_ID, secret, 'base_nonce', keyScheduleContext, 12),
  }
}

async function aesGcmSeal(keyBytes: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array, aad: Uint8Array): Promise<Uint8Array> {
  const key = await globalThis.crypto.subtle.importKey('raw', source(keyBytes), 'AES-GCM', false, ['encrypt'])
  return new Uint8Array(await globalThis.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: source(nonce), additionalData: source(aad), tagLength: 128 }, key, source(plaintext),
  ))
}

async function aesGcmOpen(keyBytes: Uint8Array, nonce: Uint8Array, ciphertext: Uint8Array, aad: Uint8Array): Promise<Uint8Array> {
  try {
    const key = await globalThis.crypto.subtle.importKey('raw', source(keyBytes), 'AES-GCM', false, ['decrypt'])
    return new Uint8Array(await globalThis.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: source(nonce), additionalData: source(aad), tagLength: 128 }, key, source(ciphertext),
    ))
  } catch {
    throw new ProtocolError('INVALID_SIGNATURE', 'HPKE ciphertext authentication failed')
  }
}

export async function hpkeSealBase(
  recipientPublicKeyBytes: Uint8Array,
  plaintext: Uint8Array,
  info: Uint8Array,
  aad: Uint8Array,
): Promise<HpkeCiphertext> {
  const recipientPublicKey = await importX25519PublicKey(recipientPublicKeyBytes)
  const ephemeral = await generateX25519KeyPair(false)
  const sharedSecret = await extractAndExpand(
    await dh(ephemeral.privateKey, recipientPublicKey),
    concatBytes(ephemeral.publicKeyBytes, recipientPublicKeyBytes),
  )
  const context = await keySchedule(sharedSecret, info)
  return {
    encapsulatedKey: ephemeral.publicKeyBytes,
    ciphertext: await aesGcmSeal(context.key, context.nonce, plaintext, aad),
  }
}

export async function hpkeOpenBase(
  recipientPrivateKey: CryptoKey,
  recipientPublicKeyBytes: Uint8Array,
  encapsulatedKey: Uint8Array,
  ciphertext: Uint8Array,
  info: Uint8Array,
  aad: Uint8Array,
): Promise<Uint8Array> {
  protocolInvariant(recipientPublicKeyBytes.length === 32 && encapsulatedKey.length === 32, 'INVALID_KEY', 'HPKE X25519 keys must contain 32 bytes')
  const ephemeralPublicKey = await importX25519PublicKey(encapsulatedKey)
  const sharedSecret = await extractAndExpand(
    await dh(recipientPrivateKey, ephemeralPublicKey),
    concatBytes(encapsulatedKey, recipientPublicKeyBytes),
  )
  const context = await keySchedule(sharedSecret, info)
  return aesGcmOpen(context.key, context.nonce, ciphertext, aad)
}
