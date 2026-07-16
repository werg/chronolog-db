import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

export interface DataDirectoryLock { readonly path: string; release(): Promise<void> }

export async function acquireDataDirectoryLock(dataDirectory: string, purpose: string): Promise<DataDirectoryLock> {
  await mkdir(dataDirectory, { recursive: true })
  const path = join(dataDirectory, 'chronolog.lock')
  const token = randomUUID()
  const document = `${JSON.stringify({ format: 'chronolog-data-lock-v1', pid: process.pid, purpose, token })}\n`
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await writeFile(path, document, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
      const handle = await open(path, 'r')
      try { await handle.sync() } finally { await handle.close() }
      let released = false
      return {
        path,
        async release() {
          if (released) return
          const current = JSON.parse(await readFile(path, 'utf8')) as { readonly token?: unknown }
          if (current.token !== token) throw new Error('DATA_DIRECTORY_LOCK_OWNERSHIP_LOST')
          await unlink(path)
          released = true
        },
      }
    } catch (error) {
      if (!isExists(error)) throw error
      const owner = await lockOwner(path)
      if (owner !== null && processAlive(owner.pid)) {
        throw new Error(`DATA_DIRECTORY_LOCKED:${owner.pid}:${owner.purpose}`, { cause: error })
      }
      try { await rename(path, `${path}.stale-${token}-${attempt}`) }
      catch (renameError) { if (!isMissing(renameError)) throw renameError }
    }
  }
  throw new Error('DATA_DIRECTORY_LOCK_BUSY')
}

async function lockOwner(path: string): Promise<{ readonly pid: number; readonly purpose: string } | null> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as { readonly format?: unknown; readonly pid?: unknown; readonly purpose?: unknown }
    return value.format === 'chronolog-data-lock-v1' && Number.isSafeInteger(value.pid) && (value.pid as number) > 0 && typeof value.purpose === 'string'
      ? { pid: value.pid as number, purpose: value.purpose }
      : null
  } catch { return null }
}
function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true }
  catch (error) { return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'EPERM' }
}
function isExists(error: unknown): boolean { return code(error) === 'EEXIST' }
function isMissing(error: unknown): boolean { return code(error) === 'ENOENT' }
function code(error: unknown): unknown { return typeof error === 'object' && error !== null && 'code' in error ? (error as { code?: unknown }).code : undefined }
