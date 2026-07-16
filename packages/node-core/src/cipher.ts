import { decryptEpochPayload, encryptEpochPayload } from '@chronolog/crypto'
import { assertCanonicalCbor, bytesToHex, encodeCanonicalCbor } from '@chronolog/protocol'

import type { EnvelopeCipher, EnvelopeCipherResolver } from './types.js'

/** Adapts a group epoch content key to authenticated transport envelopes. */
export function createEpochEnvelopeCipher(
  contentKey: Uint8Array,
  epoch: bigint,
): EnvelopeCipher {
  if (contentKey.length !== 32) throw new Error('EPOCH_CONTENT_KEY_INVALID')
  const key = contentKey.slice()
  const epochId = encodeCanonicalCbor(epoch)
  return {
    epochId,
    async seal(plaintext, associatedData) {
      const encrypted = await encryptEpochPayload(key, epoch, plaintext, associatedData)
      return encodeCanonicalCbor([1n, encrypted.epoch, encrypted.nonce, encrypted.ciphertext])
    },
    async open(ciphertext, associatedData) {
      const value = assertCanonicalCbor(ciphertext)
      if (
        !Array.isArray(value) || value.length !== 4 || value[0] !== 1n ||
        typeof value[1] !== 'bigint' || value[1] !== epoch ||
        !(value[2] instanceof Uint8Array) || !(value[3] instanceof Uint8Array)
      ) throw new Error('EPOCH_CIPHERTEXT_INVALID')
      return decryptEpochPayload(key, {
        epoch: value[1],
        nonce: value[2],
        ciphertext: value[3],
      }, associatedData)
    },
  }
}

/** Mutable operational key ring; only governance may advance its current key. */
export class EpochCipherRing implements EnvelopeCipherResolver {
  readonly #epochs = new Map<string, EnvelopeCipher>()
  #currentKey: string | undefined

  install(contentKey: Uint8Array, epoch: bigint, makeCurrent = false): EnvelopeCipher {
    const cipher = createEpochEnvelopeCipher(contentKey, epoch)
    const key = epochKey(cipher.epochId)
    const existing = this.#epochs.get(key)
    if (existing !== undefined) {
      if (makeCurrent) this.#currentKey = key
      return existing
    }
    this.#epochs.set(key, cipher)
    if (makeCurrent || this.#currentKey === undefined) this.#currentKey = key
    return cipher
  }

  current(): EnvelopeCipher {
    const cipher = this.#currentKey === undefined ? undefined : this.#epochs.get(this.#currentKey)
    if (cipher === undefined) throw new Error('EPOCH_CIPHER_CURRENT_UNAVAILABLE')
    return cipher
  }

  resolve(epochId: Uint8Array): EnvelopeCipher | undefined {
    return this.#epochs.get(epochKey(epochId))
  }

  remove(epoch: bigint): void {
    const key = epochKey(encodeCanonicalCbor(epoch))
    if (key === this.#currentKey) throw new Error('EPOCH_CIPHER_CURRENT_REMOVAL_PROHIBITED')
    this.#epochs.delete(key)
  }

  epochs(): readonly bigint[] {
    return [...this.#epochs.values()].map((cipher) => {
      const value = assertCanonicalCbor(cipher.epochId)
      if (typeof value !== 'bigint') throw new Error('EPOCH_CIPHER_ID_INVALID')
      return value
    }).sort((a, b) => a < b ? -1 : a > b ? 1 : 0)
  }
}

function epochKey(value: Uint8Array): string { return bytesToHex(value) }
