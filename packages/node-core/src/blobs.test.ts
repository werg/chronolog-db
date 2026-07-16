import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { generateEd25519KeyPair } from '@chronolog/protocol'
import { afterEach, describe, expect, it } from 'vitest'

import { FileBlobStore, MemoryBlobStore, loadEnvelopePayload, storeEnvelopePayload } from './blobs.js'
import { decodeSignedEnvelope, encodeSignedEnvelope } from './wire.js'

const directories: string[] = []
afterEach(async () => Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))))

describe('content-addressed envelope blobs', () => {
  it('stores, resolves, and verifies a chunk manifest through the wire codec', async () => {
    const store = new MemoryBlobStore()
    const signer = await generateEd25519KeyPair()
    const group = bytes(32, 1)
    const payload = bytes(200, 2)
    const encoded = await encodeSignedEnvelope(group, 'candidate', payload, signer, undefined, {
      store,
      maxInlineBytes: 32,
      chunkBytes: 48,
    })
    await expect(decodeSignedEnvelope(encoded, group, undefined, store)).resolves
      .toMatchObject({ type: 'candidate', payload })
    await expect(decodeSignedEnvelope(encoded, group)).rejects.toThrow('WIRE_BLOB_STORE_REQUIRED')
  })

  it('persists exact chunks and rejects missing or substituted content', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'chronolog-blobs-'))
    directories.push(directory)
    const store = new FileBlobStore(directory)
    const payload = bytes(150, 3)
    const { manifest } = await storeEnvelopePayload(payload, {
      store,
      maxInlineBytes: 16,
      chunkBytes: 64,
    })
    await expect(loadEnvelopePayload(manifest, store)).resolves.toEqual(payload)
    const missing = new MemoryBlobStore()
    await expect(loadEnvelopePayload(manifest, missing)).rejects.toThrow('BLOB_CHUNK_MISSING')
    await expect(missing.put(manifest.chunks[0]!.digest, Uint8Array.of(9)))
      .rejects.toThrow('BLOB_CHUNK_DIGEST_MISMATCH')
  })
})

function bytes(length: number, seed: number): Uint8Array {
  return Uint8Array.from({ length }, (_value, index) => (seed + index) & 0xff)
}
