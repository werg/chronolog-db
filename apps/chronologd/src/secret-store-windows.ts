import { createHash } from 'node:crypto'

import {
  createCommandRunner,
  redactedCommandError,
  scrubbedEnvironment,
  stripTrailingNewline,
  validateReference,
  validateService,
  validateValue,
  type DaemonSecretStore,
  type SecretCommandRunner,
} from './secret-common.js'

/**
 * Windows DPAPI adapter (current-user scope) driven through Windows
 * PowerShell 5.1.
 *
 * UNTESTED ON A REAL WINDOWS HOST. It is exercised only against a fake command
 * runner on Linux (which checks the generated script and the stdin protocol)
 * and by an opt-in, non-blocking CI job on `windows-latest`.
 *
 * This is a DPAPI-protected file store, not Windows Credential Manager:
 * `cmdkey` can only receive a password as an argv element (visible to other
 * processes) and has no read verb, and reading Credential Manager from a
 * script needs hand-written P/Invoke. Each secret is encrypted with
 * `ProtectedData.Protect(..., CurrentUser)` using entropy bound to the service
 * and reference, and the opaque blob is written to
 * `<directory>\<sha256(service|reference)>.dpapi`.
 *
 * The secret travels as base64 on the child's stdin; the PowerShell source is
 * constant apart from validated, non-secret names and is passed with
 * `-EncodedCommand`. Residual exposure: any process running as the same
 * Windows user (or able to impersonate it) can decrypt the blobs; DPAPI has no
 * "locked" state, so custody fails closed only when the profile or key
 * material is unavailable (for example a service account without a loaded
 * profile); the directory path and file digests are visible; file writes are
 * temp-file plus move without an explicit flush, which is why the write is
 * read back by `VerifiedSecretStore`.
 */
export const WINDOWS_DPAPI_NOT_FOUND = '2'

export class WindowsDpapiStore implements DaemonSecretStore {
  constructor(
    private readonly service = 'chronolog-db',
    private readonly directory?: string,
    private readonly run: SecretCommandRunner = createCommandRunner({
      timeoutMs: 30_000,
      environment: scrubbedEnvironment(process.env, 'win32'),
    }),
    private readonly powershellPath = defaultPowerShellPath(process.env),
  ) {
    validateService(service)
    if (directory !== undefined) powershellLiteral(directory, 'DAEMON_SECRET_DPAPI_DIRECTORY_INVALID')
  }

  async get(reference: string): Promise<string> {
    try {
      const output = await this.run(this.powershellPath, this.invocation('get', reference))
      const decoded = Buffer.from(stripTrailingNewline(output), 'base64').toString('utf8')
      return validateValue(decoded)
    } catch (error) {
      throw new Error('DAEMON_SECRET_NOT_FOUND', { cause: error })
    }
  }

  async set(reference: string, value: string): Promise<void> {
    validateValue(value)
    try {
      await this.run(
        this.powershellPath,
        this.invocation('set', reference),
        Buffer.from(value, 'utf8').toString('base64'),
      )
    } catch (error) {
      throw redactedCommandError('set', error)
    }
  }

  async delete(reference: string): Promise<void> {
    try {
      await this.run(this.powershellPath, this.invocation('delete', reference))
    } catch (error) {
      throw redactedCommandError('delete', error)
    }
  }

  private invocation(operation: 'get' | 'set' | 'delete', reference: string): readonly string[] {
    validateReference(reference)
    const script = dpapiScript(operation, this.service, reference, this.directory)
    return [
      '-NoProfile', '-NonInteractive',
      '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64'),
    ]
  }
}

export function dpapiFileName(service: string, reference: string): string {
  return `${createHash('sha256').update(`${service}|${reference}`, 'utf8').digest('hex')}.dpapi`
}

/** Exposed for tests: the PowerShell source for one operation. */
export function dpapiScript(
  operation: 'get' | 'set' | 'delete',
  service: string,
  reference: string,
  directory?: string,
): string {
  const directoryExpression = directory === undefined
    ? `(Join-Path $env:LOCALAPPDATA 'chronolog-db\\secrets')`
    : powershellLiteral(directory, 'DAEMON_SECRET_DPAPI_DIRECTORY_INVALID')
  const entropy = powershellLiteral(`chronolog-db/dpapi/v1|${service}|${reference}`, 'DAEMON_SECRET_REFERENCE_INVALID')
  const file = powershellLiteral(dpapiFileName(service, reference), 'DAEMON_SECRET_REFERENCE_INVALID')
  const scope = '[Security.Cryptography.DataProtectionScope]::CurrentUser'
  const body = {
    get: [
      'if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { [Console]::Error.WriteLine("NOT_FOUND"); exit 2 }',
      '$blob = [IO.File]::ReadAllBytes($path)',
      `$plain = [Security.Cryptography.ProtectedData]::Unprotect($blob, $entropy, ${scope})`,
      '[Console]::Out.Write([Convert]::ToBase64String($plain))',
    ],
    set: [
      '$plain = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())',
      'if ($plain.Length -eq 0) { throw "empty" }',
      `$blob = [Security.Cryptography.ProtectedData]::Protect($plain, $entropy, ${scope})`,
      'New-Item -ItemType Directory -Force -Path $directory | Out-Null',
      '$temporary = $path + "." + [Guid]::NewGuid().ToString("N") + ".tmp"',
      '[IO.File]::WriteAllBytes($temporary, $blob)',
      'Move-Item -LiteralPath $temporary -Destination $path -Force',
    ],
    delete: [
      'Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue',
      'if (Test-Path -LiteralPath $path) { throw "still present" }',
    ],
  }[operation]
  return [
    "$ErrorActionPreference = 'Stop'",
    'try {',
    'Add-Type -AssemblyName System.Security',
    `$directory = ${directoryExpression}`,
    `$path = Join-Path $directory ${file}`,
    `$entropy = [Text.Encoding]::UTF8.GetBytes(${entropy})`,
    ...body,
    '} catch { [Console]::Error.WriteLine("DPAPI_FAILED"); exit 3 }',
  ].join('\n')
}

/** Single-quoted PowerShell literal; PowerShell also treats Unicode single quotes as quotes. */
function powershellLiteral(value: string, code: string): string {
  // eslint-disable-next-line no-control-regex
  if (value.length === 0 || value.length > 1024 || /['\u2018\u2019\u201a\u201b\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(code)
  }
  return `'${value}'`
}

function defaultPowerShellPath(environment: NodeJS.ProcessEnv): string {
  const root = environment.SystemRoot ?? environment.windir ?? 'C:\\Windows'
  return `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
}
