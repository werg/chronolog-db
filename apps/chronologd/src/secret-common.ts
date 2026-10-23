import { spawn } from 'node:child_process'
import { timingSafeEqual } from 'node:crypto'

export interface DaemonSecretStore {
  get(reference: string): Promise<string>
  set(reference: string, value: string): Promise<void>
  delete(reference: string): Promise<void>
}

export class MemoryDaemonSecretStore implements DaemonSecretStore {
  readonly #values = new Map<string, string>()
  async get(reference: string): Promise<string> {
    const value = this.#values.get(validateReference(reference))
    if (value === undefined) throw new Error('DAEMON_SECRET_NOT_FOUND')
    return value
  }
  async set(reference: string, value: string): Promise<void> {
    this.#values.set(validateReference(reference), validateValue(value))
  }
  async delete(reference: string): Promise<void> {
    this.#values.delete(validateReference(reference))
  }
}

export interface SecretCommandRunner {
  (command: string, arguments_: readonly string[], standardInput?: string): Promise<string>
}

export interface CommandRunnerOptions {
  /** Kill the child and fail with `DAEMON_SECRET_COMMAND_TIMEOUT` after this long. Unbounded when omitted. */
  readonly timeoutMs?: number
  /** Exact child environment. The daemon's own environment is inherited when omitted. */
  readonly environment?: NodeJS.ProcessEnv
}

const MAX_COMMAND_OUTPUT_BYTES = 1024 * 1024
const MAX_STDERR_CHARACTERS = 512

/**
 * Spawn a platform tool without a shell. The optional standard input is the
 * only channel for secret values; callers must never place them in arguments.
 */
export function createCommandRunner(options: CommandRunnerOptions = {}): SecretCommandRunner {
  return (command, arguments_, standardInput) => new Promise<string>((resolve, reject) => {
    const child = spawn(command, [...arguments_], {
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(options.environment === undefined ? {} : { env: options.environment }),
    })
    const output: Buffer[] = []
    const errors: Buffer[] = []
    let bytes = 0
    let timedOut = false
    const timer = options.timeoutMs === undefined ? undefined : setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, options.timeoutMs)
    const collect = (target: Buffer[]) => (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > MAX_COMMAND_OUTPUT_BYTES) {
        child.kill('SIGKILL')
        return
      }
      target.push(chunk)
    }
    child.stdout.on('data', collect(output))
    child.stderr.on('data', collect(errors))
    // A tool that exits without reading its input must surface as its exit
    // status, not as an unhandled EPIPE on our side.
    child.stdin.on('error', () => undefined)
    child.once('error', (error) => {
      if (timer !== undefined) clearTimeout(timer)
      reject(error)
    })
    child.once('close', (code, signal) => {
      if (timer !== undefined) clearTimeout(timer)
      if (timedOut) return reject(new Error('DAEMON_SECRET_COMMAND_TIMEOUT'))
      if (bytes > MAX_COMMAND_OUTPUT_BYTES) return reject(new Error('DAEMON_SECRET_COMMAND_OUTPUT_LIMIT'))
      if (code !== 0) {
        return reject(new Error(`DAEMON_SECRET_COMMAND_FAILED:${code ?? signal ?? 'unknown'}:${Buffer.concat(errors).toString('utf8').trim().slice(0, MAX_STDERR_CHARACTERS)}`))
      }
      resolve(Buffer.concat(output).toString('utf8'))
    })
    child.stdin.end(standardInput)
  })
}

/** Exit status embedded in a runner failure, when the tool ran and failed. */
export function commandExitCode(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined
  return /^DAEMON_SECRET_COMMAND_FAILED:([^:]*):/u.exec(error.message)?.[1]
}

/**
 * Failure for an operation that handed a secret to a tool. Tool diagnostics
 * can echo their input, so only the operation and exit status are retained and
 * the original error is deliberately not attached as a cause.
 */
export function redactedCommandError(operation: string, error: unknown): Error {
  const code = commandExitCode(error)
  if (code !== undefined) return new Error(`DAEMON_SECRET_${operation.toUpperCase()}_FAILED:${code}`)
  if (error instanceof Error && error.message === 'DAEMON_SECRET_COMMAND_TIMEOUT') return error
  if (error instanceof Error && error.message === 'DAEMON_SECRET_COMMAND_OUTPUT_LIMIT') return error
  return new Error(`DAEMON_SECRET_${operation.toUpperCase()}_FAILED`)
}

const POSIX_ENVIRONMENT = ['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ'] as const
const WINDOWS_ENVIRONMENT = [
  'PATH', 'PATHEXT', 'SystemRoot', 'windir', 'SystemDrive', 'ComSpec', 'USERPROFILE', 'USERNAME',
  'USERDOMAIN', 'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)',
  'TEMP', 'TMP', 'HOMEDRIVE', 'HOMEPATH',
] as const

/**
 * Minimal child environment. The daemon's bearer tokens and other
 * `CHRONOLOG_*` settings are never inherited by key-provider tools; extra
 * names (for example a PKCS#11 module path) must be listed explicitly.
 */
export function scrubbedEnvironment(
  source: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  extraNames: readonly string[] = [],
): NodeJS.ProcessEnv {
  const allowed = new Set([...(platform === 'win32' ? WINDOWS_ENVIRONMENT : POSIX_ENVIRONMENT), ...extraNames]
    .map((name) => (platform === 'win32' ? name.toUpperCase() : name)))
  const result: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue
    if (allowed.has(platform === 'win32' ? name.toUpperCase() : name)) result[name] = value
  }
  return result
}

/**
 * Write-then-read-back guard for providers whose tool exit status is not
 * trusted to prove durability. Config migration rewrites JSON to references
 * immediately after `set`, so a silently dropped write would destroy the key.
 */
export class VerifiedSecretStore implements DaemonSecretStore {
  constructor(private readonly inner: DaemonSecretStore) {}

  get(reference: string): Promise<string> {
    return this.inner.get(reference)
  }

  async set(reference: string, value: string): Promise<void> {
    await this.inner.set(reference, value)
    let stored: string
    try {
      stored = await this.inner.get(reference)
    } catch {
      throw new Error('DAEMON_SECRET_WRITE_VERIFY_FAILED')
    }
    const expected = Buffer.from(value, 'utf8')
    const actual = Buffer.from(stored, 'utf8')
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      throw new Error('DAEMON_SECRET_WRITE_VERIFY_FAILED')
    }
  }

  async delete(reference: string): Promise<void> {
    await this.inner.delete(reference)
    let remains = false
    try {
      await this.inner.get(reference)
      remains = true
    } catch {
      // Absent or unreadable after a successful delete is treated as removed.
    }
    if (remains) throw new Error('DAEMON_SECRET_DELETE_VERIFY_FAILED')
  }
}

export function validateReference(reference: string): string {
  if (!/^[A-Za-z0-9._:/-]{1,256}$/u.test(reference)) throw new Error('DAEMON_SECRET_REFERENCE_INVALID')
  return reference
}

export function validateValue(value: string): string {
  if (value.length === 0 || value.length > 1024 * 1024 || value.includes('\0')) {
    throw new Error('DAEMON_SECRET_VALUE_INVALID')
  }
  return value
}

/** Namespace strings are embedded in tool arguments and scripts; keep them inert. */
export function validateService(service: string): string {
  if (!/^[A-Za-z0-9._:-]{1,128}$/u.test(service)) throw new Error('DAEMON_SECRET_SERVICE_INVALID')
  return service
}

export function stripTrailingNewline(value: string): string {
  return value.replace(/\r?\n$/u, '')
}
