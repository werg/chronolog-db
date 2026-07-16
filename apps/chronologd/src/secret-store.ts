import { spawn } from 'node:child_process'

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

/** Linux Secret Service adapter using libsecret's `secret-tool`. */
export class LinuxSecretServiceStore implements DaemonSecretStore {
  constructor(
    private readonly service = 'chronolog-db',
    private readonly run: SecretCommandRunner = runCommand,
  ) {
    if (service.length === 0) throw new Error('DAEMON_SECRET_SERVICE_INVALID')
  }

  async get(reference: string): Promise<string> {
    try {
      const output = await this.run('secret-tool', [
        'lookup', 'service', this.service, 'reference', validateReference(reference),
      ])
      return validateValue(output.replace(/\r?\n$/u, ''))
    } catch (error) {
      throw new Error('DAEMON_SECRET_NOT_FOUND', { cause: error })
    }
  }

  async set(reference: string, value: string): Promise<void> {
    await this.run('secret-tool', [
      'store', '--label', `Chronolog ${reference}`,
      'service', this.service,
      'reference', validateReference(reference),
    ], validateValue(value))
  }

  async delete(reference: string): Promise<void> {
    await this.run('secret-tool', [
      'clear', 'service', this.service, 'reference', validateReference(reference),
    ])
  }
}

export function daemonSecretStoreFromEnvironment(
  environment: NodeJS.ProcessEnv,
  platform = process.platform,
): DaemonSecretStore | undefined {
  const provider = environment.CHRONOLOG_SECRET_STORE ?? 'file'
  if (provider === 'file') return undefined
  if (provider !== 'secret-service') throw new Error('CHRONOLOG_SECRET_STORE_INVALID')
  if (platform !== 'linux') throw new Error('CHRONOLOG_SECRET_STORE_PLATFORM_UNSUPPORTED')
  return new LinuxSecretServiceStore(environment.CHRONOLOG_SECRET_SERVICE ?? 'chronolog-db')
}

function runCommand(
  command: string,
  arguments_: readonly string[],
  standardInput?: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...arguments_], { shell: false, stdio: ['pipe', 'pipe', 'pipe'] })
    const output: Buffer[] = []
    const errors: Buffer[] = []
    let bytes = 0
    const collect = (target: Buffer[]) => (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > 1024 * 1024) {
        child.kill('SIGKILL')
        return
      }
      target.push(chunk)
    }
    child.stdout.on('data', collect(output))
    child.stderr.on('data', collect(errors))
    child.once('error', reject)
    child.once('close', (code, signal) => {
      if (bytes > 1024 * 1024) return reject(new Error('DAEMON_SECRET_COMMAND_OUTPUT_LIMIT'))
      if (code !== 0) {
        return reject(new Error(`DAEMON_SECRET_COMMAND_FAILED:${code ?? signal ?? 'unknown'}:${Buffer.concat(errors).toString('utf8').trim()}`))
      }
      resolve(Buffer.concat(output).toString('utf8'))
    })
    child.stdin.end(standardInput)
  })
}

function validateReference(reference: string): string {
  if (!/^[A-Za-z0-9._:/-]{1,256}$/u.test(reference)) throw new Error('DAEMON_SECRET_REFERENCE_INVALID')
  return reference
}

function validateValue(value: string): string {
  if (value.length === 0 || value.length > 1024 * 1024 || value.includes('\0')) {
    throw new Error('DAEMON_SECRET_VALUE_INVALID')
  }
  return value
}
