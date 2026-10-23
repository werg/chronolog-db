import { isAbsolute } from 'node:path'

import {
  commandExitCode,
  createCommandRunner,
  redactedCommandError,
  scrubbedEnvironment,
  stripTrailingNewline,
  validateReference,
  validateValue,
  type DaemonSecretStore,
  type SecretCommandRunner,
} from './secret-common.js'

/**
 * Generic command-hook provider for hardware tokens (YubiKey/PKCS#11 wrappers,
 * HSM CLIs, enterprise vault agents).
 *
 * UNTESTED AGAINST REAL HARDWARE. The process protocol is exercised on Linux
 * with a real child process and a scripted fake helper; no token, PKCS#11
 * module or vendor tool has been run.
 *
 * The daemon runs `<command> <fixed args...> <op> <reference>`:
 *   get     print the secret on stdout; exit 0. Exit 3 or any failure = not found.
 *   set     read the secret from stdin (never argv); exit 0 only once durable.
 *   delete  remove the secret; exit 0, or 3 when it did not exist.
 * Only exit status 0 is success. The helper owns the actual custody (for
 * example a non-extractable token-resident wrapping key plus ciphertext file)
 * and must itself prompt for or obtain any PIN without placing it on argv.
 *
 * Hardening: the command must be an absolute path (no PATH lookup); no shell
 * is used; the child gets a scrubbed environment (no `CHRONOLOG_*` values,
 * including bearer tokens) plus only explicitly allow-listed variable names;
 * stderr from `set` is discarded because a helper may echo its input.
 * Residual exposure: the helper is fully trusted with every secret and every
 * reference; fixed arguments and allow-listed environment values are visible to
 * the same user and must not themselves be secrets.
 */
export const COMMAND_HOOK_NOT_FOUND = '3'

export class CommandHookSecretStore implements DaemonSecretStore {
  constructor(
    private readonly command: string,
    private readonly fixedArguments: readonly string[] = [],
    private readonly run: SecretCommandRunner = createCommandRunner({
      timeoutMs: 30_000,
      environment: scrubbedEnvironment(process.env, process.platform),
    }),
  ) {
    if (!isAbsolute(command) || command.includes('\0')) throw new Error('CHRONOLOG_SECRET_COMMAND_INVALID')
    if (fixedArguments.length > 32 || fixedArguments.some((argument) =>
      argument.length > 1024 || argument.includes('\0'))) {
      throw new Error('CHRONOLOG_SECRET_COMMAND_ARGS_INVALID')
    }
  }

  async get(reference: string): Promise<string> {
    try {
      const output = await this.run(this.command, [...this.fixedArguments, 'get', validateReference(reference)])
      return validateValue(stripTrailingNewline(output))
    } catch (error) {
      throw new Error('DAEMON_SECRET_NOT_FOUND', { cause: error })
    }
  }

  async set(reference: string, value: string): Promise<void> {
    try {
      await this.run(
        this.command,
        [...this.fixedArguments, 'set', validateReference(reference)],
        validateValue(value),
      )
    } catch (error) {
      throw redactedCommandError('set', error)
    }
  }

  async delete(reference: string): Promise<void> {
    try {
      await this.run(this.command, [...this.fixedArguments, 'delete', validateReference(reference)])
    } catch (error) {
      if (commandExitCode(error) === COMMAND_HOOK_NOT_FOUND) return
      throw redactedCommandError('delete', error)
    }
  }
}
