import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

export interface DataDirectoryLock { readonly path: string; release(): Promise<void> }

export async function acquireDataDirectoryLock(dataDirectory: string, purpose: string): Promise<DataDirectoryLock> {
  await mkdir(dataDirectory, { recursive: true })
  const path = join(dataDirectory, 'chronolog.lock')
  const token = randomUUID()
  const startTime = await processStartTime(process.pid)
  const document = `${JSON.stringify({ format: 'chronolog-data-lock-v1', pid: process.pid, purpose, token, ...(startTime === null ? {} : { startTime }) })}\n`
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
      if (owner !== null && await ownerAlive(owner)) {
        throw new Error(`DATA_DIRECTORY_LOCKED:${owner.pid}:${owner.purpose}`, { cause: error })
      }
      try { await rename(path, `${path}.stale-${token}-${attempt}`) }
      catch (renameError) { if (!isMissing(renameError)) throw renameError }
    }
  }
  throw new Error('DATA_DIRECTORY_LOCK_BUSY')
}

interface LockOwner { readonly pid: number; readonly purpose: string; readonly startTime?: string }

async function lockOwner(path: string): Promise<LockOwner | null> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as { readonly format?: unknown; readonly pid?: unknown; readonly purpose?: unknown; readonly startTime?: unknown }
    return value.format === 'chronolog-data-lock-v1' && Number.isSafeInteger(value.pid) && (value.pid as number) > 0 && typeof value.purpose === 'string'
      ? { pid: value.pid as number, purpose: value.purpose, ...(typeof value.startTime === 'string' ? { startTime: value.startTime } : {}) }
      : null
  } catch { return null }
}

/**
 * A live PID alone does not prove ownership: a restarted container starts a
 * fresh PID namespace, so the replacement daemon routinely receives the PID
 * of the process that was killed while holding the lock. When the lock
 * recorded a start time, a live process with a different one is a reuse.
 */
async function ownerAlive(owner: LockOwner): Promise<boolean> {
  if (!processAlive(owner.pid)) return false
  if (owner.startTime === undefined) return true
  const current = await processStartTime(owner.pid)
  return current === null || current === owner.startTime
}

/** Linux process start time in clock ticks since boot, or null where unavailable. */
async function processStartTime(pid: number): Promise<string | null> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8')
    // The command name may contain spaces or parentheses; fields resume after the last ')'.
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    const startTime = fields[19]
    return startTime !== undefined && /^\d+$/.test(startTime) ? startTime : null
  } catch { return null }
}
function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true }
  catch (error) { return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'EPERM' }
}
function isExists(error: unknown): boolean { return code(error) === 'EEXIST' }
function isMissing(error: unknown): boolean { return code(error) === 'ENOENT' }
function code(error: unknown): unknown { return typeof error === 'object' && error !== null && 'code' in error ? (error as { code?: unknown }).code : undefined }
