import { mkdir, open, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import {
  createPayloadManifest,
  equalBytes,
  payloadChunkDigest,
  verifyPayloadManifest,
  type PayloadManifest,
} from '@chronolog/protocol'

export interface ContentAddressedBlobStore {
  put(digest: Uint8Array, bytes: Uint8Array): Promise<void>
  get(digest: Uint8Array): Promise<Uint8Array | null>
}

export interface EnvelopeBlobOptions {
  readonly store: ContentAddressedBlobStore
  readonly maxInlineBytes: number
  readonly chunkBytes: number
}

export class MemoryBlobStore implements ContentAddressedBlobStore {
  readonly #values = new Map<string, Uint8Array>()
  async put(digest: Uint8Array, bytes: Uint8Array): Promise<void> {
    await verifyChunk(digest, bytes)
    this.#values.set(hex(digest), bytes.slice())
  }
  async get(digest: Uint8Array): Promise<Uint8Array | null> {
    const value = this.#values.get(hex(digest))
    return value?.slice() ?? null
  }
}

export class FileBlobStore implements ContentAddressedBlobStore {
  constructor(private readonly root: string) {}
  async put(digest: Uint8Array, bytes: Uint8Array): Promise<void> {
    await verifyChunk(digest, bytes)
    const path = this.#path(digest)
    try {
      const existing = await readFile(path)
      await verifyChunk(digest, existing)
      return
    } catch (error) {
      if (!isMissing(error)) throw error
    }
    await mkdir(dirname(path), { recursive: true })
    const temporary = `${path}.${process.pid}.tmp`
    await writeFile(temporary, bytes, { mode: 0o600 })
    const handle = await open(temporary, 'r')
    try { await handle.sync() } finally { await handle.close() }
    await rename(temporary, path)
  }
  async get(digest: Uint8Array): Promise<Uint8Array | null> {
    try {
      const value = Uint8Array.from(await readFile(this.#path(digest)))
      await verifyChunk(digest, value)
      return value
    } catch (error) {
      if (isMissing(error)) return null
      throw error
    }
  }
  #path(digest: Uint8Array): string {
    if (digest.length !== 32) throw new Error('BLOB_DIGEST_INVALID')
    const identity = hex(digest)
    return join(this.root, identity.slice(0, 2), identity.slice(2))
  }
}

export async function storeEnvelopePayload(
  bytes: Uint8Array,
  options: EnvelopeBlobOptions,
): Promise<{ readonly manifest: PayloadManifest; readonly chunks: number }> {
  validateOptions(options)
  if (bytes.length <= options.maxInlineBytes) throw new Error('BLOB_PAYLOAD_INLINE_ELIGIBLE')
  const chunks: Uint8Array[] = []
  for (let offset = 0; offset < bytes.length; offset += options.chunkBytes) {
    chunks.push(bytes.slice(offset, Math.min(bytes.length, offset + options.chunkBytes)))
  }
  const manifest = await createPayloadManifest(chunks)
  await Promise.all(chunks.map((chunk, index) => options.store.put(manifest.chunks[index]!.digest, chunk)))
  return { manifest, chunks: chunks.length }
}

export async function loadEnvelopePayload(
  manifest: PayloadManifest,
  store: ContentAddressedBlobStore,
  maximumBytes = 16 * 1024 * 1024,
): Promise<Uint8Array> {
  if (manifest.totalSize > BigInt(maximumBytes)) throw new Error('BLOB_PAYLOAD_LIMIT')
  const chunks: Uint8Array[] = []
  for (const chunk of manifest.chunks) {
    const value = await store.get(chunk.digest)
    if (value === null) throw new Error(`BLOB_CHUNK_MISSING:${hex(chunk.digest)}`)
    chunks.push(value)
  }
  return verifyPayloadManifest(manifest, chunks)
}

function validateOptions(options: EnvelopeBlobOptions): void {
  if (!Number.isSafeInteger(options.maxInlineBytes) || options.maxInlineBytes < 0 ||
      !Number.isSafeInteger(options.chunkBytes) || options.chunkBytes < 1 ||
      options.chunkBytes > 4 * 1024 * 1024) throw new Error('BLOB_OPTIONS_INVALID')
}

async function verifyChunk(digest: Uint8Array, bytes: Uint8Array): Promise<void> {
  if (digest.length !== 32 || !equalBytes(await payloadChunkDigest(bytes), digest)) {
    throw new Error('BLOB_CHUNK_DIGEST_MISMATCH')
  }
}

function hex(value: Uint8Array): string { return Buffer.from(value).toString('hex') }
function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
}
