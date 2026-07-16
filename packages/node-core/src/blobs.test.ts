import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { generateEd25519KeyPair, payloadChunkDigest } from '@chronolog/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { FileBlobStore, HttpBlobStore, MemoryBlobStore, ReplicatedBlobStore, loadEnvelopePayload, storeEnvelopePayload } from './blobs.js'
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

  it('authenticates, bounds, verifies, and retains remotely fetched chunks', async () => {
    const chunk = bytes(64, 9)
    const digest = await payloadChunkDigest(chunk)
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.headers).toEqual({ authorization: 'Bearer peer-secret' })
      return new Response(chunk.slice().buffer, { headers: { 'content-length': String(chunk.length) } })
    })
    const local = new MemoryBlobStore()
    const store = new ReplicatedBlobStore(local, [new HttpBlobStore({
      baseUrl: 'https://peer.example', token: 'peer-secret', fetch, maximumChunkBytes: 128,
    })])
    await expect(store.get(digest)).resolves.toEqual(chunk)
    await expect(store.get(digest)).resolves.toEqual(chunk)
    expect(fetch).toHaveBeenCalledTimes(1)

    const substituted = new HttpBlobStore({
      baseUrl: 'https://peer.example',
      fetch: async () => new Response(Uint8Array.of(1), { headers: { 'content-length': '1' } }),
    })
    await expect(substituted.get(digest)).rejects.toThrow('BLOB_CHUNK_DIGEST_MISMATCH')
    expect(() => new HttpBlobStore({ baseUrl: 'http://peer.example' })).toThrow('BLOB_REMOTE_HTTPS_REQUIRED')
  })
})

function bytes(length: number, seed: number): Uint8Array {
  return Uint8Array.from({ length }, (_value, index) => (seed + index) & 0xff)
}
