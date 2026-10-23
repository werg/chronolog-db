import {
  commandExitCode,
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
 * macOS Keychain adapter using `/usr/bin/security`.
 *
 * UNTESTED ON A REAL macOS HOST. It is exercised only against a fake command
 * runner on Linux and by an opt-in, non-blocking CI job on `macos-latest`.
 *
 * `security add-generic-password` accepts a password only as `-w <value>` on
 * argv (visible in `ps` to the same user) or through an interactive tty
 * prompt. To keep secrets off the process table this adapter instead runs
 * `security -i` and sends the `add-generic-password` command, including the
 * value, over stdin. Values are hex encoded first so the command line the tool
 * parses contains only inert characters; this also keeps the stored bytes
 * printable so `find-generic-password -w` returns them verbatim.
 *
 * Unverified assumptions (confirm on a real host before relying on them):
 * `security -i` line-length limits (hence the conservative value cap), whether
 * its exit status reflects a failed command (hence the mandatory read-back in
 * `VerifiedSecretStore`), and that no tool diagnostic echoes the command.
 *
 * Residual exposure: reference names, the service name and an optional
 * keychain path appear in argv; any process of the same macOS user that can
 * run `security` against an unlocked keychain can read the item (the CLI does
 * not provide per-application ACL isolation); a locked keychain makes
 * `security` fail or prompt, which the timeout converts into a closed failure.
 */
export const MACOS_SECURITY_PATH = '/usr/bin/security'
/** Conservative: the interactive-mode line limit is undocumented. */
export const MACOS_MAX_VALUE_BYTES = 1536
const KEYCHAIN_ITEM_NOT_FOUND = '44'

export class MacOsKeychainStore implements DaemonSecretStore {
  constructor(
    private readonly service = 'chronolog-db',
    private readonly keychain?: string,
    private readonly run: SecretCommandRunner = createCommandRunner({
      timeoutMs: 30_000,
      environment: scrubbedEnvironment(process.env, 'darwin'),
    }),
    private readonly securityPath = MACOS_SECURITY_PATH,
  ) {
    validateService(service)
    if (keychain !== undefined) quoteInteractive(keychain, 'DAEMON_SECRET_KEYCHAIN_INVALID')
  }

  async get(reference: string): Promise<string> {
    try {
      const output = await this.run(this.securityPath, [
        'find-generic-password', '-a', validateReference(reference), '-s', this.service, '-w',
        ...(this.keychain === undefined ? [] : [this.keychain]),
      ])
      return decodeHex(stripTrailingNewline(output))
    } catch (error) {
      throw new Error('DAEMON_SECRET_NOT_FOUND', { cause: error })
    }
  }

  async set(reference: string, value: string): Promise<void> {
    validateReference(reference)
    validateValue(value)
    if (Buffer.byteLength(value, 'utf8') > MACOS_MAX_VALUE_BYTES) throw new Error('DAEMON_SECRET_VALUE_INVALID')
    const command = [
      'add-generic-password', '-U',
      '-a', reference,
      '-s', this.service,
      '-w', Buffer.from(value, 'utf8').toString('hex'),
      ...(this.keychain === undefined ? [] : [quoteInteractive(this.keychain, 'DAEMON_SECRET_KEYCHAIN_INVALID')]),
    ].join(' ')
    try {
      await this.run(this.securityPath, ['-i'], `${command}\n`)
    } catch (error) {
      throw redactedCommandError('set', error)
    }
  }

  async delete(reference: string): Promise<void> {
    try {
      await this.run(this.securityPath, [
        'delete-generic-password', '-a', validateReference(reference), '-s', this.service,
        ...(this.keychain === undefined ? [] : [this.keychain]),
      ])
    } catch (error) {
      if (commandExitCode(error) === KEYCHAIN_ITEM_NOT_FOUND) return
      throw redactedCommandError('delete', error)
    }
  }
}

function decodeHex(encoded: string): string {
  if (encoded.length === 0 || encoded.length % 2 !== 0 || !/^[0-9a-f]+$/u.test(encoded)) {
    throw new Error('DAEMON_SECRET_VALUE_INVALID')
  }
  return validateValue(Buffer.from(encoded, 'hex').toString('utf8'))
}

/** Double-quote a path for the `security -i` parser, refusing anything it could reinterpret. */
function quoteInteractive(value: string, code: string): string {
  // eslint-disable-next-line no-control-regex
  if (value.length === 0 || value.length > 1024 || /["\\\u0000-\u001f\u007f]/u.test(value)) throw new Error(code)
  return `"${value}"`
}
