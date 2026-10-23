import { describe, expect, it, vi } from 'vitest'

import {
  VerifiedSecretStore,
  createCommandRunner,
  redactedCommandError,
  scrubbedEnvironment,
  type SecretCommandRunner,
} from './secret-common.js'
import {
  CommandHookSecretStore,
  LinuxSecretServiceStore,
  MacOsKeychainStore,
  MemoryDaemonSecretStore,
  WindowsDpapiStore,
  daemonSecretStoreFromEnvironment,
} from './secret-store.js'
import { MACOS_MAX_VALUE_BYTES } from './secret-store-macos.js'

const SECRET = 'S3cret-private-key-material/+=value'
const REFERENCE = 'groups/example/signing'

interface Call {
  readonly command: string
  readonly arguments_: readonly string[]
  readonly standardInput: string | undefined
}

async function thrown(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise
  } catch (error) {
    return error as Error
  }
  throw new Error('expected rejection')
}

function failure(code: string, stderr: string): Error {
  return new Error(`DAEMON_SECRET_COMMAND_FAILED:${code}:${stderr}`)
}

/** Every call a fake runner saw, so tests can assert that no secret reached argv. */
function recording(inner: SecretCommandRunner): { readonly run: SecretCommandRunner; readonly calls: Call[] } {
  const calls: Call[] = []
  const run: SecretCommandRunner = async (command, arguments_, standardInput) => {
    calls.push({ command, arguments_: [...arguments_], standardInput })
    return inner(command, arguments_, standardInput)
  }
  return { run, calls }
}

function expectNoSecretInArgv(calls: readonly Call[], ...forms: readonly string[]): void {
  for (const call of calls) {
    for (const form of forms) {
      expect(call.arguments_.some((argument) => argument.includes(form))).toBe(false)
    }
  }
}

/** Minimal emulation of `security -i add-generic-password` / `find` / `delete`. */
function fakeSecurity(options: { readonly stderrEchoesInput?: boolean } = {}): SecretCommandRunner {
  const items = new Map<string, string>()
  return async (_command, arguments_, standardInput) => {
    if (arguments_[0] === '-i') {
      const words = (standardInput ?? '').trim().split(' ')
      if (options.stderrEchoesInput === true) throw failure('1', `bad command: ${standardInput ?? ''}`)
      expect(words[0]).toBe('add-generic-password')
      const account = words[words.indexOf('-a') + 1]!
      const service = words[words.indexOf('-s') + 1]!
      items.set(`${service}|${account}`, words[words.indexOf('-w') + 1]!)
      return ''
    }
    const account = arguments_[arguments_.indexOf('-a') + 1]!
    const service = arguments_[arguments_.indexOf('-s') + 1]!
    const key = `${service}|${account}`
    const stored = items.get(key)
    if (arguments_[0] === 'find-generic-password') {
      if (stored === undefined) throw failure('44', 'The specified item could not be found in the keychain.')
      return `${stored}\n`
    }
    if (stored === undefined) throw failure('44', 'not found')
    items.delete(key)
    return ''
  }
}

function decodeScript(arguments_: readonly string[]): string {
  expect(arguments_.slice(0, 2)).toEqual(['-NoProfile', '-NonInteractive'])
  expect(arguments_[2]).toBe('-EncodedCommand')
  return Buffer.from(arguments_[3]!, 'base64').toString('utf16le')
}

/** Emulates the generated PowerShell by keying on the script's target file name. */
function fakeDpapi(options: { readonly failSet?: boolean } = {}): SecretCommandRunner {
  const files = new Map<string, string>()
  return async (_command, arguments_, standardInput) => {
    const script = decodeScript(arguments_)
    const file = /Join-Path \$directory '([0-9a-f]{64}\.dpapi)'/u.exec(script)?.[1]
    if (file === undefined) throw new Error('fake: no file in script')
    if (script.includes('ProtectedData]::Protect')) {
      if (options.failSet === true) throw failure('3', `DPAPI_FAILED ${standardInput ?? ''}`)
      files.set(file, standardInput ?? '')
      return ''
    }
    if (script.includes('ProtectedData]::Unprotect')) {
      const stored = files.get(file)
      if (stored === undefined) throw failure('2', 'NOT_FOUND')
      return stored
    }
    files.delete(file)
    return ''
  }
}

function fakeHook(): SecretCommandRunner {
  const items = new Map<string, string>()
  return async (_command, arguments_, standardInput) => {
    const [operation, reference] = arguments_.slice(-2) as [string, string]
    if (operation === 'set') {
      items.set(reference, standardInput ?? '')
      return ''
    }
    if (operation === 'get') {
      const value = items.get(reference)
      if (value === undefined) throw failure('3', 'no such key')
      return `${value}\n`
    }
    if (!items.delete(reference)) throw failure('3', 'no such key')
    return ''
  }
}

describe('macOS Keychain provider (fake runner)', () => {
  it('round trips a value without placing it, or its encoding, in argv', async () => {
    const { run, calls } = recording(fakeSecurity())
    const store = new MacOsKeychainStore('chronolog-test', undefined, run, '/usr/bin/security')
    await store.set(REFERENCE, SECRET)
    expect(await store.get(REFERENCE)).toBe(SECRET)
    const hex = Buffer.from(SECRET, 'utf8').toString('hex')
    expectNoSecretInArgv(calls, SECRET, hex)
    expect(calls[0]?.arguments_).toEqual(['-i'])
    expect(calls[0]?.standardInput).toContain(hex)
    expect(calls[0]?.standardInput?.endsWith('\n')).toBe(true)
    await store.delete(REFERENCE)
    await expect(store.get(REFERENCE)).rejects.toThrow('DAEMON_SECRET_NOT_FOUND')
  })

  it('treats a missing item as not found and tolerates deleting one', async () => {
    const store = new MacOsKeychainStore('chronolog-test', undefined, fakeSecurity())
    await expect(store.get('missing')).rejects.toThrow('DAEMON_SECRET_NOT_FOUND')
    await expect(store.delete('missing')).resolves.toBeUndefined()
  })

  it('does not leak tool diagnostics or the value through secret-bearing errors', async () => {
    const store = new MacOsKeychainStore('chronolog-test', undefined, fakeSecurity({ stderrEchoesInput: true }))
    const error = await thrown(store.set(REFERENCE, SECRET))
    expect(error.message).toBe('DAEMON_SECRET_SET_FAILED:1')
    expect(error.message).not.toContain('bad command')
    expect(error.message).not.toContain(Buffer.from(SECRET).toString('hex'))
    expect(error.cause).toBeUndefined()
  })

  it('redacts failures other than item-not-found on delete', async () => {
    const run = vi.fn<SecretCommandRunner>().mockRejectedValue(failure('1', 'keychain locked'))
    const error = await thrown(new MacOsKeychainStore('chronolog-test', undefined, run).delete('x'))
    expect(error.message).toBe('DAEMON_SECRET_DELETE_FAILED:1')
  })

  it('rejects hostile references, services, keychain paths and oversized values before running anything', async () => {
    const run = vi.fn<SecretCommandRunner>().mockResolvedValue('')
    const store = new MacOsKeychainStore('chronolog-test', undefined, run)
    await expect(store.set('bad ref; -w x', SECRET)).rejects.toThrow('DAEMON_SECRET_REFERENCE_INVALID')
    await expect(store.set(REFERENCE, '')).rejects.toThrow('DAEMON_SECRET_VALUE_INVALID')
    await expect(store.set(REFERENCE, 'x'.repeat(MACOS_MAX_VALUE_BYTES + 1))).rejects.toThrow('DAEMON_SECRET_VALUE_INVALID')
    expect(() => new MacOsKeychainStore('bad service', undefined, run)).toThrow('DAEMON_SECRET_SERVICE_INVALID')
    expect(() => new MacOsKeychainStore('svc', 'a"b', run)).toThrow('DAEMON_SECRET_KEYCHAIN_INVALID')
    expect(() => new MacOsKeychainStore('svc', 'a\nb', run)).toThrow('DAEMON_SECRET_KEYCHAIN_INVALID')
    expect(run).not.toHaveBeenCalled()
  })

  it('rejects stored data that is not hex', async () => {
    const run = vi.fn<SecretCommandRunner>().mockResolvedValue('not hex\n')
    await expect(new MacOsKeychainStore('svc', undefined, run).get('x')).rejects.toThrow('DAEMON_SECRET_NOT_FOUND')
  })
})

describe('Windows DPAPI provider (fake runner)', () => {
  it('round trips a value with the secret only on stdin and out of the script', async () => {
    const { run, calls } = recording(fakeDpapi())
    const store = new WindowsDpapiStore('chronolog-test', 'C:\\secrets', run, 'powershell.exe')
    await store.set(REFERENCE, SECRET)
    expect(await store.get(REFERENCE)).toBe(SECRET)
    const base64 = Buffer.from(SECRET, 'utf8').toString('base64')
    expectNoSecretInArgv(calls, SECRET, base64)
    for (const call of calls) {
      const script = decodeScript(call.arguments_)
      expect(script).not.toContain(SECRET)
      expect(script).not.toContain(base64)
      expect(script).toContain("'C:\\secrets'")
    }
    expect(calls[0]?.standardInput).toBe(base64)
    await store.delete(REFERENCE)
    await expect(store.get(REFERENCE)).rejects.toThrow('DAEMON_SECRET_NOT_FOUND')
  })

  it('reports a missing blob as not found', async () => {
    const store = new WindowsDpapiStore('chronolog-test', undefined, fakeDpapi())
    await expect(store.get('missing')).rejects.toThrow('DAEMON_SECRET_NOT_FOUND')
  })

  it('does not leak the tool diagnostics from a failed set', async () => {
    const store = new WindowsDpapiStore('chronolog-test', undefined, fakeDpapi({ failSet: true }))
    const error = await thrown(store.set(REFERENCE, SECRET))
    expect(error.message).toBe('DAEMON_SECRET_SET_FAILED:3')
    expect(error.cause).toBeUndefined()
  })

  it('fails delete closed instead of treating errors as success', async () => {
    const run = vi.fn<SecretCommandRunner>().mockRejectedValue(failure('3', 'DPAPI_FAILED'))
    await expect(new WindowsDpapiStore('svc', undefined, run).delete('x')).rejects.toThrow('DAEMON_SECRET_DELETE_FAILED:3')
  })

  it('rejects directories that could break out of the PowerShell literal', () => {
    const run = vi.fn<SecretCommandRunner>()
    for (const directory of ["C:\\a'; calc; '", 'C:\\a\u2019b', 'C:\\a\nb', '']) {
      expect(() => new WindowsDpapiStore('svc', directory, run)).toThrow('DAEMON_SECRET_DPAPI_DIRECTORY_INVALID')
    }
    expect(() => new WindowsDpapiStore('bad service', undefined, run)).toThrow('DAEMON_SECRET_SERVICE_INVALID')
  })

  it('binds the blob file and entropy to both service and reference', async () => {
    const { run, calls } = recording(fakeDpapi())
    await new WindowsDpapiStore('svc-a', undefined, run).set('ref', SECRET)
    await new WindowsDpapiStore('svc-b', undefined, run).set('ref', SECRET)
    const [a, b] = calls.map((call) => decodeScript(call.arguments_))
    expect(a).not.toEqual(b)
  })
})

describe('command-hook provider (fake runner)', () => {
  it('round trips through the helper protocol with the value on stdin only', async () => {
    const { run, calls } = recording(fakeHook())
    const store = new CommandHookSecretStore('/opt/helper', ['--token', 'slot1'], run)
    await store.set(REFERENCE, SECRET)
    expect(await store.get(REFERENCE)).toBe(SECRET)
    expectNoSecretInArgv(calls, SECRET)
    expect(calls[0]).toEqual({
      command: '/opt/helper',
      arguments_: ['--token', 'slot1', 'set', REFERENCE],
      standardInput: SECRET,
    })
    await store.delete(REFERENCE)
    await expect(store.get(REFERENCE)).rejects.toThrow('DAEMON_SECRET_NOT_FOUND')
  })

  it('treats exit 3 on delete as already absent but other failures as errors', async () => {
    await expect(new CommandHookSecretStore('/opt/helper', [], fakeHook()).delete('missing')).resolves.toBeUndefined()
    const run = vi.fn<SecretCommandRunner>().mockRejectedValue(failure('9', 'boom'))
    await expect(new CommandHookSecretStore('/opt/helper', [], run).delete('x'))
      .rejects.toThrow('DAEMON_SECRET_DELETE_FAILED:9')
  })

  it('does not leak helper stderr from set', async () => {
    const run = vi.fn<SecretCommandRunner>().mockRejectedValue(failure('1', `echo ${SECRET}`))
    const error = await thrown(new CommandHookSecretStore('/opt/helper', [], run).set('x', SECRET))
    expect(error.message).toBe('DAEMON_SECRET_SET_FAILED:1')
    expect(error.message).not.toContain(SECRET)
    expect(error.cause).toBeUndefined()
  })

  it('requires an absolute command and bounded inert fixed arguments', () => {
    const run = vi.fn<SecretCommandRunner>()
    expect(() => new CommandHookSecretStore('helper', [], run)).toThrow('CHRONOLOG_SECRET_COMMAND_INVALID')
    expect(() => new CommandHookSecretStore('/opt/h\0', [], run)).toThrow('CHRONOLOG_SECRET_COMMAND_INVALID')
    expect(() => new CommandHookSecretStore('/opt/h', ['a\0b'], run)).toThrow('CHRONOLOG_SECRET_COMMAND_ARGS_INVALID')
    expect(() => new CommandHookSecretStore('/opt/h', Array.from({ length: 33 }, () => 'a'), run))
      .toThrow('CHRONOLOG_SECRET_COMMAND_ARGS_INVALID')
  })
})

describe('Linux Secret Service provider', () => {
  it('does not leak tool diagnostics from a failed set', async () => {
    const run = vi.fn<SecretCommandRunner>().mockRejectedValue(failure('1', `echo ${SECRET}`))
    const error = await thrown(new LinuxSecretServiceStore('svc', run).set('x', SECRET))
    expect(error.message).toBe('DAEMON_SECRET_SET_FAILED:1')
    expect(error.cause).toBeUndefined()
  })
})

describe('VerifiedSecretStore', () => {
  class DroppingStore extends MemoryDaemonSecretStore {
    override async set(): Promise<void> { /* exit 0 but nothing durable */ }
  }
  class CorruptingStore extends MemoryDaemonSecretStore {
    override async set(reference: string, value: string): Promise<void> {
      await super.set(reference, `${value}x`)
    }
  }
  class UndeletableStore extends MemoryDaemonSecretStore {
    override async delete(): Promise<void> { /* exit 0 but still present */ }
  }

  it('passes through a healthy store', async () => {
    const store = new VerifiedSecretStore(new MemoryDaemonSecretStore())
    await store.set('a', 'value')
    expect(await store.get('a')).toBe('value')
    await store.delete('a')
    await expect(store.get('a')).rejects.toThrow('DAEMON_SECRET_NOT_FOUND')
  })

  it('detects a silently dropped write', async () => {
    await expect(new VerifiedSecretStore(new DroppingStore()).set('a', 'value'))
      .rejects.toThrow('DAEMON_SECRET_WRITE_VERIFY_FAILED')
  })

  it('detects a corrupted write, including a same-prefix value', async () => {
    await expect(new VerifiedSecretStore(new CorruptingStore()).set('a', 'value'))
      .rejects.toThrow('DAEMON_SECRET_WRITE_VERIFY_FAILED')
  })

  it('detects a delete that left the secret in place', async () => {
    const inner = new UndeletableStore()
    await inner.set('a', 'value')
    await expect(new VerifiedSecretStore(inner).delete('a')).rejects.toThrow('DAEMON_SECRET_DELETE_VERIFY_FAILED')
  })

  it('does not echo the value when verification fails', async () => {
    const error = await thrown(new VerifiedSecretStore(new CorruptingStore()).set('a', SECRET))
    expect(error.message).not.toContain(SECRET)
  })
})

describe('provider selection fails closed', () => {
  it('rejects an unknown provider instead of falling back to inline storage', () => {
    expect(() => daemonSecretStoreFromEnvironment({ CHRONOLOG_SECRET_STORE: 'keychain' }, 'darwin'))
      .toThrow('CHRONOLOG_SECRET_STORE_INVALID')
    expect(() => daemonSecretStoreFromEnvironment({ CHRONOLOG_SECRET_STORE: '' }, 'linux'))
      .toThrow('CHRONOLOG_SECRET_STORE_INVALID')
  })

  it('rejects providers selected on the wrong platform', () => {
    expect(() => daemonSecretStoreFromEnvironment({ CHRONOLOG_SECRET_STORE: 'macos-keychain' }, 'linux'))
      .toThrow('CHRONOLOG_SECRET_STORE_PLATFORM_UNSUPPORTED')
    expect(() => daemonSecretStoreFromEnvironment({ CHRONOLOG_SECRET_STORE: 'windows-dpapi' }, 'darwin'))
      .toThrow('CHRONOLOG_SECRET_STORE_PLATFORM_UNSUPPORTED')
    expect(() => daemonSecretStoreFromEnvironment({ CHRONOLOG_SECRET_STORE: 'secret-service' }, 'win32'))
      .toThrow('CHRONOLOG_SECRET_STORE_PLATFORM_UNSUPPORTED')
  })

  it('wraps opt-in providers in the read-back guard', () => {
    expect(daemonSecretStoreFromEnvironment({ CHRONOLOG_SECRET_STORE: 'macos-keychain' }, 'darwin'))
      .toBeInstanceOf(VerifiedSecretStore)
    expect(daemonSecretStoreFromEnvironment({ CHRONOLOG_SECRET_STORE: 'windows-dpapi' }, 'win32'))
      .toBeInstanceOf(VerifiedSecretStore)
    expect(daemonSecretStoreFromEnvironment({
      CHRONOLOG_SECRET_STORE: 'command',
      CHRONOLOG_SECRET_COMMAND: '/opt/helper',
    }, 'linux')).toBeInstanceOf(VerifiedSecretStore)
  })

  it('validates the command provider settings', () => {
    const base = { CHRONOLOG_SECRET_STORE: 'command', CHRONOLOG_SECRET_COMMAND: '/opt/helper' }
    expect(() => daemonSecretStoreFromEnvironment({ CHRONOLOG_SECRET_STORE: 'command' }, 'linux'))
      .toThrow('CHRONOLOG_SECRET_COMMAND_REQUIRED')
    expect(() => daemonSecretStoreFromEnvironment({ ...base, CHRONOLOG_SECRET_COMMAND: 'relative' }, 'linux'))
      .toThrow('CHRONOLOG_SECRET_COMMAND_INVALID')
    expect(() => daemonSecretStoreFromEnvironment({ ...base, CHRONOLOG_SECRET_COMMAND_ARGS: '{"a":1}' }, 'linux'))
      .toThrow('CHRONOLOG_SECRET_COMMAND_ARGS_INVALID')
    expect(() => daemonSecretStoreFromEnvironment({ ...base, CHRONOLOG_SECRET_COMMAND_ARGS: '[1]' }, 'linux'))
      .toThrow('CHRONOLOG_SECRET_COMMAND_ARGS_INVALID')
    expect(() => daemonSecretStoreFromEnvironment({ ...base, CHRONOLOG_SECRET_COMMAND_ENV: 'CHRONOLOG_TOKEN' }, 'linux'))
      .toThrow('CHRONOLOG_SECRET_COMMAND_ENV_INVALID')
    expect(() => daemonSecretStoreFromEnvironment({ ...base, CHRONOLOG_SECRET_COMMAND_ENV: 'chronolog_token' }, 'linux'))
      .toThrow('CHRONOLOG_SECRET_COMMAND_ENV_INVALID')
    expect(() => daemonSecretStoreFromEnvironment({ ...base, CHRONOLOG_SECRET_COMMAND_ENV: 'A B' }, 'linux'))
      .toThrow('CHRONOLOG_SECRET_COMMAND_ENV_INVALID')
    expect(() => daemonSecretStoreFromEnvironment({ ...base, CHRONOLOG_SECRET_COMMAND_TIMEOUT_MS: '5' }, 'linux'))
      .toThrow('CHRONOLOG_SECRET_COMMAND_TIMEOUT_MS_INVALID')
    expect(() => daemonSecretStoreFromEnvironment({ ...base, CHRONOLOG_SECRET_COMMAND_TIMEOUT_MS: '1e3' }, 'linux'))
      .toThrow('CHRONOLOG_SECRET_COMMAND_TIMEOUT_MS_INVALID')
    expect(daemonSecretStoreFromEnvironment({ ...base, CHRONOLOG_SECRET_COMMAND_ENV: 'PKCS11_MODULE' }, 'linux'))
      .toBeDefined()
  })
})

describe('scrubbedEnvironment and redaction helpers', () => {
  it('drops daemon settings and bearer tokens but keeps allow-listed names', () => {
    const source = {
      PATH: '/bin', HOME: '/home/u', CHRONOLOG_TOKEN: 'bearer', CHRONOLOG_SECRET_COMMAND: '/x', PKCS11_MODULE: '/m',
    }
    expect(scrubbedEnvironment(source, 'linux')).toEqual({ PATH: '/bin', HOME: '/home/u' })
    expect(scrubbedEnvironment(source, 'linux', ['PKCS11_MODULE'])).toEqual({
      PATH: '/bin', HOME: '/home/u', PKCS11_MODULE: '/m',
    })
  })

  it('matches Windows variable names case-insensitively', () => {
    expect(scrubbedEnvironment({ Path: 'C:\\x', SystemRoot: 'C:\\Windows', CHRONOLOG_TOKEN: 't' }, 'win32'))
      .toEqual({ Path: 'C:\\x', SystemRoot: 'C:\\Windows' })
  })

  it('keeps only operation and exit status in redacted errors', () => {
    expect(redactedCommandError('set', failure('7', 'secret')).message).toBe('DAEMON_SECRET_SET_FAILED:7')
    expect(redactedCommandError('set', new Error('DAEMON_SECRET_COMMAND_TIMEOUT')).message)
      .toBe('DAEMON_SECRET_COMMAND_TIMEOUT')
    expect(redactedCommandError('set', new Error(`spawn ENOENT ${SECRET}`)).message).toBe('DAEMON_SECRET_SET_FAILED')
    expect(redactedCommandError('delete', 'weird').message).toBe('DAEMON_SECRET_DELETE_FAILED')
  })
})

describe('createCommandRunner (real child process)', () => {
  const node = process.execPath

  it('delivers stdin to the child and returns stdout without a shell', async () => {
    const run = createCommandRunner({ timeoutMs: 20_000 })
    const output = await run(node, ['-e', 'process.stdin.pipe(process.stdout)'], 'from-stdin; $(echo injected)')
    expect(output).toBe('from-stdin; $(echo injected)')
  })

  it('reports exit status and truncated stderr for failures', async () => {
    const run = createCommandRunner({ timeoutMs: 20_000 })
    const error = await thrown(run(node, ['-e', 'console.error("x".repeat(2000)); process.exit(5)']))
    expect(error.message.startsWith('DAEMON_SECRET_COMMAND_FAILED:5:')).toBe(true)
    expect(error.message.length).toBeLessThan(600)
  })

  it('applies the exact scrubbed environment', async () => {
    const run = createCommandRunner({ timeoutMs: 20_000, environment: { PATH: process.env.PATH, ONLY: 'yes' } })
    const output = await run(node, ['-e', 'process.stdout.write(JSON.stringify([process.env.ONLY, process.env.HOME ?? null]))'])
    expect(JSON.parse(output)).toEqual(['yes', null])
  })

  it('kills a child that exceeds the timeout', async () => {
    const run = createCommandRunner({ timeoutMs: 300 })
    await expect(run(node, ['-e', 'setInterval(() => undefined, 1000)'])).rejects.toThrow('DAEMON_SECRET_COMMAND_TIMEOUT')
  })

  it('does not hang or crash when the child ignores its stdin', async () => {
    const run = createCommandRunner({ timeoutMs: 20_000 })
    await expect(run(node, ['-e', 'process.exit(0)'], 'x'.repeat(1_000_000))).resolves.toBe('')
  })
})
