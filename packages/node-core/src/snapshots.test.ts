import { generateEd25519KeyPair } from '@chronolog/protocol'
import { describe, expect, it } from 'vitest'

import {
  assertSnapshotTrust,
  decodeSignedSnapshotManifest,
  encodeSignedSnapshotManifest,
  signSnapshotManifest,
  type TrustedSnapshotManifest,
} from './snapshots.js'

describe('trusted snapshot manifests', () => {
  it('binds database, log, feed heads, group, manifest, and revision to an authorized signer', async () => {
    const signer = await generateEd25519KeyPair()
    const manifest = fixture()
    const signed = await signSnapshotManifest(manifest, signer)
    expect(decodeSignedSnapshotManifest(encodeSignedSnapshotManifest(signed))).toEqual(signed)
    await expect(assertSnapshotTrust(signed, {
      groupId: manifest.groupId,
      executionManifestDigest: manifest.executionManifestDigest,
      authorizedSigners: [signer.publicKeyBytes],
      minimumRevision: 6n,
    })).resolves.toEqual(manifest)
  })

  it('rejects rollback, substitution, and unauthorized signing', async () => {
    const signer = await generateEd25519KeyPair()
    const other = await generateEd25519KeyPair()
    const manifest = fixture()
    const signed = await signSnapshotManifest(manifest, signer)
    await expect(assertSnapshotTrust(signed, {
      groupId: manifest.groupId,
      executionManifestDigest: manifest.executionManifestDigest,
      authorizedSigners: [other.publicKeyBytes],
    })).rejects.toThrow('SNAPSHOT_SIGNER_UNAUTHORIZED')
    await expect(assertSnapshotTrust(signed, {
      groupId: manifest.groupId,
      executionManifestDigest: manifest.executionManifestDigest,
      authorizedSigners: [signer.publicKeyBytes],
      minimumRevision: 8n,
    })).rejects.toThrow('SNAPSHOT_REVISION_ROLLBACK')
  })
})

function fixture(): TrustedSnapshotManifest {
  return {
    version: 1,
    groupId: bytes(32, 1),
    executionManifestDigest: bytes(32, 2),
    materializedRevision: 7n,
    orderLength: 11,
    databaseContentHash: 'dolt-content-hash',
    transactionLogDigest: bytes(32, 3),
    feedHeads: [
      { feedId: '@a.ed25519', sequence: 2n, recordId: '%two.sha256' },
      { feedId: '@b.ed25519', sequence: 1n, recordId: '%one.sha256' },
    ],
    createdAtMs: 100n,
  }
}

function bytes(length: number, seed: number): Uint8Array {
  return Uint8Array.from({ length }, (_value, index) => (seed + index) & 0xff)
}
