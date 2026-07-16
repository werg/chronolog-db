import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'

interface ReadyEvent {
  readonly event: 'chronologd.ready'
  readonly url: string
  readonly groupId: string
  readonly nodeId: string
  readonly ssbId: string
  readonly executionManifestDigest: string
  readonly governanceRevision: string | null
  readonly encryptionEpoch: string
}

const directory = resolve(argument('--directory', 'artifacts/distribution'))
const detected = (await readdir(directory, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory() && entry.name.startsWith('chronolog-'))
  .map((entry) => join(directory, entry.name))
  .sort()
const from = resolve(optional('--from') ?? detected.at(-1) ?? missing('No distribution directory found'))
const to = resolve(optional('--to') ?? from)
const dataDirectory = await mkdtemp(join(tmpdir(), 'chronolog-packaged-upgrade-'))

try {
  execFileSync(join(from, 'bin', 'chronolog-verify'), { stdio: 'inherit' })
  const before = await runOnce(from, dataDirectory)
  execFileSync(join(to, 'bin', 'chronolog-verify'), { stdio: 'inherit' })
  const after = await runOnce(to, dataDirectory)
  for (const field of ['groupId', 'nodeId', 'ssbId', 'executionManifestDigest', 'governanceRevision', 'encryptionEpoch'] as const) {
    if (before[field] !== after[field]) throw new Error(`DISTRIBUTION_UPGRADE_IDENTITY_CHANGED:${field}`)
  }
  process.stdout.write(`${JSON.stringify({
    event: 'chronolog.distribution_upgrade_passed', from, to,
    groupId: after.groupId, nodeId: after.nodeId,
    executionManifestDigest: after.executionManifestDigest,
  })}\n`)
} finally {
  await rm(dataDirectory, { recursive: true, force: true })
}

async function runOnce(distribution: string, data: string): Promise<ReadyEvent> {
  const environment = { ...process.env, CHRONOLOG_DATA_DIR: data, CHRONOLOG_PORT: '0', CHRONOLOG_SSB_PORT: '0' }
  const child = spawn(join(distribution, 'bin', 'chronologd'), [], {
    env: environment, stdio: ['ignore', 'pipe', 'pipe'], shell: false,
  })
  const errors: Buffer[] = []
  child.stderr?.on('data', (chunk: Buffer) => errors.push(chunk))
  try {
    const ready = await readyEvent(child, 20_000)
    const health = await fetch(`${ready.url}/health`)
    if (!health.ok || (await health.json() as { readonly ok?: unknown }).ok !== true) throw new Error('DISTRIBUTION_HEALTH_FAILED')
    const status = JSON.parse(execFileSync(join(distribution, 'bin', 'chronolog'), ['status'], {
      env: { ...environment, CHRONOLOG_URL: ready.url, CHRONOLOG_GROUP_ID: ready.groupId }, encoding: 'utf8',
    })) as { readonly state?: unknown; readonly nodeId?: unknown }
    if (status.state !== 'ready' || status.nodeId !== ready.nodeId) throw new Error('DISTRIBUTION_CLI_STATUS_FAILED')
    return ready
  } finally {
    await stop(child, errors)
  }
}

function readyEvent(child: ChildProcess, timeoutMs: number): Promise<ReadyEvent> {
  return new Promise((resolveReady, reject) => {
    const timeout = setTimeout(() => reject(new Error('DISTRIBUTION_READY_TIMEOUT')), timeoutMs)
    const lines = createInterface({ input: child.stdout! })
    lines.on('line', (line) => {
      try {
        const value = JSON.parse(line) as Partial<ReadyEvent>
        if (value.event === 'chronologd.ready') {
          clearTimeout(timeout)
          lines.close()
          resolveReady(value as ReadyEvent)
        }
      } catch { /* Ignore non-JSON dependency diagnostics. */ }
    })
    child.once('exit', (code, signal) => {
      clearTimeout(timeout)
      reject(new Error(`DISTRIBUTION_DAEMON_EXITED:${code ?? signal ?? 'unknown'}`))
    })
    child.once('error', reject)
  })
}

async function stop(child: ChildProcess, errors: readonly Buffer[]): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGINT')
  const exited = new Promise<void>((resolveExit) => child.once('exit', () => resolveExit()))
  const timeout = new Promise<void>((_resolve, reject) => setTimeout(() => reject(new Error('DISTRIBUTION_STOP_TIMEOUT')), 10_000))
  try { await Promise.race([exited, timeout]) }
  catch (error) {
    child.kill('SIGKILL')
    throw new Error(`${error instanceof Error ? error.message : String(error)}:${Buffer.concat(errors).toString('utf8')}`, { cause: error })
  }
  if (child.exitCode !== 0) throw new Error(`DISTRIBUTION_STOP_FAILED:${child.exitCode}:${Buffer.concat(errors).toString('utf8')}`)
}

function optional(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}
function argument(name: string, fallback: string): string { return optional(name) ?? fallback }
function missing(message: string): never { throw new Error(message) }
