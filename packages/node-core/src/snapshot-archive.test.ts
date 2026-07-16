import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { generateEd25519KeyPair } from '@chronolog/protocol'
import { afterEach, describe, expect, it } from 'vitest'

import { commitStagedSnapshot, exportSnapshotArchive, stageSnapshotArchive } from './snapshot-archive.js'
import { signSnapshotManifest, type TrustedSnapshotManifest } from './snapshots.js'

const directories: string[] = []
afterEach(async () => Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))))

describe('trusted snapshot archive', () => {
  it('verifies, stages, validates, backs up, and atomically replaces a database', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'chronolog-snapshot-archive-'))
    directories.push(directory)
    const source = join(directory, 'source.db')
    const target = join(directory, 'target.db')
    const backup = join(directory, 'target.pre-snapshot.db')
    const archive = join(directory, 'archive')
    await writeFile(source, 'trusted database')
    await writeFile(target, 'old database')
    const signer = await generateEd25519KeyPair()
    const manifest = fixture()
    await exportSnapshotArchive({ archiveDirectory: archive, databasePath: source, signedManifest: await signSnapshotManifest(manifest, signer) })
    const staged = await stageSnapshotArchive({
      archiveDirectory: archive,
      targetDatabasePath: target,
      expectations: {
        groupId: manifest.groupId,
        executionManifestDigest: manifest.executionManifestDigest,
        authorizedSigners: [signer.publicKeyBytes],
        minimumRevision: 6n,
      },
      validateDatabase: async (path, trusted) => {
        expect(await readFile(path, 'utf8')).toBe('trusted database')
        expect(trusted).toEqual(manifest)
      },
    })
    expect(await readFile(target, 'utf8')).toBe('old database')
    await commitStagedSnapshot({ staged, targetDatabasePath: target, backupPath: backup })
    expect(await readFile(target, 'utf8')).toBe('trusted database')
    expect(await readFile(backup, 'utf8')).toBe('old database')
  })

  it('rejects archive corruption before opening staged bytes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'chronolog-snapshot-corrupt-'))
    directories.push(directory)
    const source = join(directory, 'source.db')
    const target = join(directory, 'target.db')
    const archive = join(directory, 'archive')
    await writeFile(source, 'trusted database')
    await writeFile(target, 'old database')
    const signer = await generateEd25519KeyPair()
    const manifest = fixture()
    await exportSnapshotArchive({ archiveDirectory: archive, databasePath: source, signedManifest: await signSnapshotManifest(manifest, signer) })
    await writeFile(join(archive, 'application.db'), 'substituted')
    await expect(stageSnapshotArchive({
      archiveDirectory: archive,
      targetDatabasePath: target,
      expectations: { groupId: manifest.groupId, executionManifestDigest: manifest.executionManifestDigest, authorizedSigners: [signer.publicKeyBytes] },
      validateDatabase: async () => undefined,
    })).rejects.toThrow('SNAPSHOT_ARCHIVE_SIZE_MISMATCH')
  })
})

function fixture(): TrustedSnapshotManifest {
  return {
    version: 1,
    groupId: bytes(1),
    executionManifestDigest: bytes(2),
    materializedRevision: 7n,
    orderLength: 11,
    databaseContentHash: 'dolt-content-hash',
    transactionLogDigest: bytes(3),
    feedHeads: [],
    createdAtMs: 100n,
  }
}
function bytes(seed: number): Uint8Array {
  return Uint8Array.from({ length: 32 }, (_value, index) => (seed + index) & 0xff)
}
