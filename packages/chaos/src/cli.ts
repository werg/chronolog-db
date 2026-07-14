#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import Docker from 'dockerode'

import { errorText, stringify } from './artifacts.js'
import { buildChaosImage } from './cluster.js'
import { defaultArtifactRoot, defaultChaosImage, runChaos } from './runner.js'
import { builtInScenarios, loadScenario } from './scenarios.js'
import { inspectRun } from './inspect.js'
import { readDockerPing, readDockerSystemInfo } from './docker-info.js'

const packageDirectory = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(packageDirectory, '../../..')
const [command = 'run', subject = command === 'run' ? 'smoke' : undefined, ...rest] = process.argv.slice(2)

try {
  if (command === 'list') {
    for (const scenario of Object.values(builtInScenarios)) {
      process.stdout.write(`${scenario.name.padEnd(10)} ${scenario.nodes} nodes, ${(scenario.durationMs / 1000).toFixed(0)}s — ${scenario.description}\n`)
    }
  } else if (command === 'doctor') {
    await doctor()
  } else if (command === 'image') {
    if (subject !== 'build') throw new Error('Usage: pnpm chaos image build [--image name]')
    const flags = parseFlags(rest)
    const image = flag(flags, 'image') ?? defaultChaosImage
    process.stdout.write(`Building ${image}...\n`)
    await buildChaosImage(repositoryRoot, image)
    process.stdout.write(`Built ${image}\n`)
  } else if (command === 'replay') {
    if (!subject) throw new Error('Usage: pnpm chaos replay <run-directory> [--no-build]')
    const runDirectory = resolve(subject)
    const stored = JSON.parse(await readFile(join(runDirectory, 'run.json'), 'utf8')) as { seed?: unknown }
    if (typeof stored.seed !== 'string') throw new Error('Replay run.json has no seed')
    await execute(join(runDirectory, 'scenario.json'), stored.seed, parseFlags(rest))
  } else if (command === 'inspect') {
    if (!subject) throw new Error('Usage: pnpm chaos inspect <run-directory>')
    if (rest.length > 0) throw new Error('inspect does not accept options')
    process.stdout.write(`${stringify(await inspectRun(subject), 2)}\n`)
  } else if (command === 'run') {
    if (!subject) throw new Error('Usage: pnpm chaos run <scenario-name-or-file> [options]')
    const flags = parseFlags(rest)
    const seed = flag(flags, 'seed') ?? `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`
    await execute(subject, seed, flags)
  } else if (command === 'help' || command === '--help' || command === '-h') {
    help()
  } else throw new Error(`Unknown chaos command: ${command}`)
} catch (error) {
  process.stderr.write(`chronolog chaos: ${errorText(error)}\n`)
  process.exitCode = 1
}

async function execute(scenarioName: string, seed: string, flags: ReadonlyMap<string, string | true>): Promise<void> {
  const scenario = await loadScenario(scenarioName)
  const image = flag(flags, 'image') ?? defaultChaosImage
  const artifactRoot = resolve(flag(flags, 'artifacts') ?? defaultArtifactRoot)
  const controller = new AbortController()
  const interrupt = () => controller.abort('SIGINT')
  process.once('SIGINT', interrupt)
  try {
    const result = await runChaos({
      scenario,
      seed,
      artifactRoot,
      repositoryRoot,
      image,
      buildImage: !flags.has('no-build'),
      signal: controller.signal,
      progress: (message) => process.stdout.write(`◆ ${message}\n`),
    })
    const mark = result.summary.passed ? '✓' : '✗'
    process.stdout.write(`${mark} ${scenario.name}: ${result.summary.operations.published}/${result.summary.operations.attempted} operations published\n`)
    process.stdout.write(`  Artifacts: ${result.artifacts}\n`)
    process.stdout.write(`  Replay: ${result.summary.replayCommand}\n`)
    if (!result.summary.passed) process.exitCode = 1
  } finally {
    process.removeListener('SIGINT', interrupt)
  }
}

async function doctor(): Promise<void> {
  const docker = new Docker()
  const [ping, version, info] = await Promise.all([readDockerPing(docker), docker.version(), readDockerSystemInfo(docker)])
  process.stdout.write(`Docker: ${ping} ${version.Version} (${version.Os}/${version.Arch})\n`)
  process.stdout.write(`Runtime: ${info.name}; ${info.cpus} CPUs; ${(info.memoryBytes / 1024 / 1024 / 1024).toFixed(1)} GiB RAM\n`)
  process.stdout.write(`Node: ${process.version}; platform ${process.platform}/${process.arch}\n`)
  process.stdout.write('Chaos dependencies and Docker API are reachable.\n')
}

function parseFlags(arguments_: readonly string[]): ReadonlyMap<string, string | true> {
  const flags = new Map<string, string | true>()
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]!
    if (!argument.startsWith('--')) throw new Error(`Unexpected argument: ${argument}`)
    const [rawName, inline] = argument.slice(2).split('=', 2)
    if (!rawName) throw new Error('Invalid empty flag')
    if (inline !== undefined) flags.set(rawName, inline)
    else if (rawName === 'no-build') flags.set(rawName, true)
    else {
      const value = arguments_[++index]
      if (value === undefined || value.startsWith('--')) throw new Error(`Flag --${rawName} requires a value`)
      flags.set(rawName, value)
    }
  }
  for (const name of flags.keys()) if (!['seed', 'image', 'artifacts', 'no-build'].includes(name)) throw new Error(`Unknown flag: --${name}`)
  return flags
}

function flag(flags: ReadonlyMap<string, string | true>, name: string): string | undefined {
  const value = flags.get(name)
  return typeof value === 'string' ? value : undefined
}

function help(): void {
  process.stdout.write(`Chronolog container chaos runner\n\n`)
  process.stdout.write(`  pnpm chaos list\n`)
  process.stdout.write(`  pnpm chaos doctor\n`)
  process.stdout.write(`  pnpm chaos image build [--image chronolog-chaos:dev]\n`)
  process.stdout.write(`  pnpm chaos run <smoke|crash|stress|scenario.json> [--seed value] [--no-build]\n`)
  process.stdout.write(`  pnpm chaos replay <artifact-directory> [--no-build]\n`)
  process.stdout.write(`  pnpm chaos inspect <artifact-directory>\n`)
}
