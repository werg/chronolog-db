import { decryptEpochPayload, encryptEpochPayload } from '@chronolog/crypto'
import { assertCanonicalCbor, encodeCanonicalCbor } from '@chronolog/protocol'

import type { EnvelopeCipher } from './types.js'

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
