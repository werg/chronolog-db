import {
  VerifiedSecretStore,
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
import { CommandHookSecretStore } from './secret-store-command.js'
import { MacOsKeychainStore } from './secret-store-macos.js'
import { WindowsDpapiStore } from './secret-store-windows.js'

export {
  MemoryDaemonSecretStore,
  VerifiedSecretStore,
  type DaemonSecretStore,
  type SecretCommandRunner,
} from './secret-common.js'
export { CommandHookSecretStore } from './secret-store-command.js'
export { MacOsKeychainStore } from './secret-store-macos.js'
export { WindowsDpapiStore } from './secret-store-windows.js'

/** Linux Secret Service adapter using libsecret's `secret-tool`. */
export class LinuxSecretServiceStore implements DaemonSecretStore {
  constructor(
    private readonly service = 'chronolog-db',
    private readonly run: SecretCommandRunner = createCommandRunner(),
  ) {
    if (service.length === 0) throw new Error('DAEMON_SECRET_SERVICE_INVALID')
  }

  async get(reference: string): Promise<string> {
    try {
      const output = await this.run('secret-tool', [
        'lookup', 'service', this.service, 'reference', validateReference(reference),
      ])
      return validateValue(stripTrailingNewline(output))
    } catch (error) {
      throw new Error('DAEMON_SECRET_NOT_FOUND', { cause: error })
    }
  }

  async set(reference: string, value: string): Promise<void> {
    try {
      await this.run('secret-tool', [
        'store', '--label', `Chronolog ${reference}`,
        'service', this.service,
        'reference', validateReference(reference),
      ], validateValue(value))
    } catch (error) {
      throw redactedCommandError('set', error)
    }
  }

  async delete(reference: string): Promise<void> {
    await this.run('secret-tool', [
      'clear', 'service', this.service, 'reference', validateReference(reference),
    ])
  }
}

/**
 * Select the daemon's private-material custody from `CHRONOLOG_SECRET_STORE`:
 *
 * - `file` (default): inline JSON, mode 0600, no external custody.
 * - `secret-service`: Linux libsecret through `secret-tool`.
 * - `macos-keychain`, `windows-dpapi`, `command`: opt-in providers that have
 *   NOT been run on a real macOS/Windows host or hardware token. They are
 *   always wrapped in a write read-back check.
 *
 * All providers are reference-only and fail closed: an unknown value, a
 * wrong-platform selection, or a missing or unreadable secret throws and
 * never falls back to inline storage.
 */
export function daemonSecretStoreFromEnvironment(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): DaemonSecretStore | undefined {
  const provider = environment.CHRONOLOG_SECRET_STORE ?? 'file'
  if (provider === 'file') return undefined
  const service = environment.CHRONOLOG_SECRET_SERVICE ?? 'chronolog-db'
  switch (provider) {
    case 'secret-service':
      if (platform !== 'linux') throw new Error('CHRONOLOG_SECRET_STORE_PLATFORM_UNSUPPORTED')
      return new LinuxSecretServiceStore(service)
    case 'macos-keychain':
      if (platform !== 'darwin') throw new Error('CHRONOLOG_SECRET_STORE_PLATFORM_UNSUPPORTED')
      return new VerifiedSecretStore(new MacOsKeychainStore(
        validateService(service),
        optional(environment.CHRONOLOG_SECRET_KEYCHAIN),
        providerRunner(environment, platform, []),
      ))
    case 'windows-dpapi':
      if (platform !== 'win32') throw new Error('CHRONOLOG_SECRET_STORE_PLATFORM_UNSUPPORTED')
      return new VerifiedSecretStore(new WindowsDpapiStore(
        validateService(service),
        optional(environment.CHRONOLOG_SECRET_DPAPI_DIR),
        providerRunner(environment, platform, []),
      ))
    case 'command': {
      const command = optional(environment.CHRONOLOG_SECRET_COMMAND)
      if (command === undefined) throw new Error('CHRONOLOG_SECRET_COMMAND_REQUIRED')
      return new VerifiedSecretStore(new CommandHookSecretStore(
        command,
        parseFixedArguments(environment.CHRONOLOG_SECRET_COMMAND_ARGS),
        providerRunner(environment, platform, parsePassthroughNames(environment.CHRONOLOG_SECRET_COMMAND_ENV)),
      ))
    }
    default:
      throw new Error('CHRONOLOG_SECRET_STORE_INVALID')
  }
}

function providerRunner(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  passthrough: readonly string[],
): SecretCommandRunner {
  return createCommandRunner({
    timeoutMs: parseTimeout(environment.CHRONOLOG_SECRET_COMMAND_TIMEOUT_MS),
    environment: scrubbedEnvironment(environment, platform, passthrough),
  })
}

function optional(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value
}

function parseTimeout(value: string | undefined): number {
  if (value === undefined || value === '') return 30_000
  if (!/^[0-9]{1,6}$/u.test(value)) throw new Error('CHRONOLOG_SECRET_COMMAND_TIMEOUT_MS_INVALID')
  const parsed = Number(value)
  if (parsed < 1_000 || parsed > 300_000) throw new Error('CHRONOLOG_SECRET_COMMAND_TIMEOUT_MS_INVALID')
  return parsed
}

function parseFixedArguments(value: string | undefined): readonly string[] {
  if (value === undefined || value === '') return []
  let parsed: unknown
  try { parsed = JSON.parse(value) } catch { throw new Error('CHRONOLOG_SECRET_COMMAND_ARGS_INVALID') }
  if (!Array.isArray(parsed) || parsed.some((entry: unknown) => typeof entry !== 'string')) {
    throw new Error('CHRONOLOG_SECRET_COMMAND_ARGS_INVALID')
  }
  return parsed as string[]
}

function parsePassthroughNames(value: string | undefined): readonly string[] {
  if (value === undefined || value === '') return []
  const names = value.split(',').map((name) => name.trim())
  for (const name of names) {
    // Never forward the daemon's own settings or bearer tokens to a helper.
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) || name.toUpperCase().startsWith('CHRONOLOG_')) {
      throw new Error('CHRONOLOG_SECRET_COMMAND_ENV_INVALID')
    }
  }
  return names
}
