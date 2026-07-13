import { describe, expect, it } from 'vitest'
import { DOMAINS, generateEd25519KeyPair, utf8, verifyDomain } from '@chronolog/protocol'
import {
  MemoryKeyStore,
  createEpochManifest,
  decodeSignedEpochManifest,
  decryptEpochPayload,
  encryptEpochPayload,
  encodeSignedEpochManifest,
  generateX25519KeyPair,
  hpkeOpenBase,
  hpkeSealBase,
  unwrapEpochKey,
  verifyEpochManifest,
} from './index.js'

const bytes = (value: number, length = 32) => new Uint8Array(length).fill(value)

describe('RFC 9180 base-mode adapter', () => {
  it('seals to an X25519 recipient and authenticates info and AAD', async () => {
    const recipient = await generateX25519KeyPair()
    const info = utf8('chronolog epoch context')
    const aad = utf8('group/epoch/recipient')
    const plaintext = bytes(7)
    const sealed = await hpkeSealBase(recipient.publicKeyBytes, plaintext, info, aad)
    expect(sealed.encapsulatedKey).toHaveLength(32)
    expect(await hpkeOpenBase(recipient.privateKey, recipient.publicKeyBytes, sealed.encapsulatedKey, sealed.ciphertext, info, aad)).toEqual(plaintext)
    await expect(hpkeOpenBase(recipient.privateKey, recipient.publicKeyBytes, sealed.encapsulatedKey, sealed.ciphertext, info, utf8('wrong'))).rejects.toMatchObject({ code: 'INVALID_SIGNATURE' })
  })

  it('does not open to another recipient', async () => {
    const recipient = await generateX25519KeyPair()
    const other = await generateX25519KeyPair()
    const sealed = await hpkeSealBase(recipient.publicKeyBytes, bytes(1), new Uint8Array(), new Uint8Array())
    await expect(hpkeOpenBase(other.privateKey, other.publicKeyBytes, sealed.encapsulatedKey, sealed.ciphertext, new Uint8Array(), new Uint8Array())).rejects.toBeDefined()
  })
})

describe('signed encryption epochs', () => {
  it('wraps one content key independently to every active reader', async () => {
    const signer = await generateEd25519KeyPair()
    const first = await generateX25519KeyPair()
    const second = await generateX25519KeyPair()
    const created = await createEpochManifest({
      groupId: bytes(1), epoch: 4n, previousEpochDigest: bytes(2), createdAtMs: 100n,
      recipients: [
        { recipientId: bytes(20), publicKey: first.publicKeyBytes },
        { recipientId: bytes(21), publicKey: second.publicKeyBytes },
      ],
      signerPublicKey: signer.publicKeyBytes, signerPrivateKey: signer.privateKey,
    })
    const signedManifest = decodeSignedEpochManifest(encodeSignedEpochManifest(created.signedManifest))
    expect(await verifyEpochManifest(signedManifest, signer.publicKeyBytes)).toBe(true)
    expect(await unwrapEpochKey({ signedManifest, trustedSigner: signer.publicKeyBytes, recipientId: bytes(20), recipientPrivateKey: first.privateKey })).toEqual(created.contentKey)
    expect(await unwrapEpochKey({ signedManifest: created.signedManifest, trustedSigner: signer.publicKeyBytes, recipientId: bytes(21), recipientPrivateKey: second.privateKey })).toEqual(created.contentKey)
    await expect(unwrapEpochKey({ signedManifest: created.signedManifest, trustedSigner: bytes(99), recipientId: bytes(20), recipientPrivateKey: first.privateKey })).rejects.toMatchObject({ code: 'INVALID_SIGNATURE' })
  })

  it('encrypts payloads with the epoch and caller routing header bound as AAD', async () => {
    const key = bytes(9)
    const encrypted = await encryptEpochPayload(key, 12n, utf8('private transaction'), utf8('visible header'))
    expect(await decryptEpochPayload(key, encrypted, utf8('visible header'))).toEqual(utf8('private transaction'))
    await expect(decryptEpochPayload(key, encrypted, utf8('different header'))).rejects.toMatchObject({ code: 'INVALID_SIGNATURE' })
    await expect(decryptEpochPayload(key, { ...encrypted, epoch: 13n }, utf8('visible header'))).rejects.toMatchObject({ code: 'INVALID_SIGNATURE' })
  })
})

describe('key-store abstraction', () => {
  it('purpose-separates signing and recipient keys without exporting secrets', async () => {
    const store = new MemoryKeyStore()
    const signer = await store.create('device-signing', 'signing')
    await store.create('device-hpke', 'hpke-recipient')
    const signature = await store.sign('device-signing', DOMAINS.transaction, utf8('payload'))
    expect(await verifyDomain(DOMAINS.transaction, utf8('payload'), signature, signer.publicKey)).toBe(true)
    await expect(store.sign('device-hpke', DOMAINS.transaction, utf8('payload'))).rejects.toMatchObject({ code: 'INVALID_KEY' })
    expect(await store.list()).toHaveLength(2)
    await store.delete('device-signing')
    await expect(store.exportPublic('device-signing')).rejects.toMatchObject({ code: 'INVALID_KEY' })
  })
})
