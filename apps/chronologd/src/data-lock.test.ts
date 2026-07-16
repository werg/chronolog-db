import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { acquireDataDirectoryLock } from './data-lock.js'

const directories: string[] = []
afterEach(async () => Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))))

describe('data directory operation lock', () => {
  it('excludes a live daemon and permits a later offline operation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'chronolog-data-lock-'))
    directories.push(directory)
    const daemon = await acquireDataDirectoryLock(directory, 'daemon')
    await expect(acquireDataDirectoryLock(directory, 'snapshot-export')).rejects.toThrow(`DATA_DIRECTORY_LOCKED:${process.pid}:daemon`)
    await daemon.release()
    const snapshot = await acquireDataDirectoryLock(directory, 'snapshot-export')
    await snapshot.release()
  })

  it('quarantines an invalid stale lock instead of blocking recovery', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'chronolog-stale-lock-'))
    directories.push(directory)
    await writeFile(join(directory, 'chronolog.lock'), 'not json', 'utf8')
    const lock = await acquireDataDirectoryLock(directory, 'repair')
    await lock.release()
  })
})
