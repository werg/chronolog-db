import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { chmod, lstat, mkdir, readFile, readdir, readlink, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'

interface Subject { readonly path: string; readonly sha256: string; readonly bytes: number }

const root = resolve('.')
const outputDirectory = resolve(argument('--output', 'artifacts/distribution'))
const dirty = exec('git', ['status', '--porcelain=v1', '--untracked-files=all']).trim()
if (dirty.length > 0 && !process.argv.includes('--allow-dirty')) {
  throw new Error('DISTRIBUTION_REQUIRES_CLEAN_WORKTREE (use --allow-dirty only for local package debugging)')
}
const commit = exec('git', ['rev-parse', 'HEAD']).trim()
const version = tagVersion() ?? `0.0.0-${commit.slice(0, 12)}`
const distributionName = `chronolog-${version}-${process.platform}-${process.arch}`
const destination = join(outputDirectory, distributionName)
const staging = join(outputDirectory, `.staging-${process.pid}`)

await mkdir(outputDirectory, { recursive: true })
await rm(staging, { recursive: true, force: true })
await rm(destination, { recursive: true, force: true })
await mkdir(staging, { recursive: true })
try {
  exec('pnpm', ['--filter', 'chronolog-distribution', 'deploy', '--prod', '--legacy', join(staging, 'runtime')], {
    HUSKY: '0',
  })
  // Legacy deploy leaves a convenience link back to the workspace package
  // being deployed. It is not a runtime dependency and would make the archive
  // non-relocatable, so remove that single known self-link before auditing.
  await rm(join(staging, 'runtime', 'node_modules', '.pnpm', 'node_modules', 'chronolog-distribution'), { force: true })
  await mkdir(join(staging, 'bin'), { recursive: true })
  await Promise.all([
    launcher('chronologd', 'chronologd/src/main.ts'),
    launcher('chronolog', 'chronolog-cli/src/main.ts'),
    launcher('chronolog-custody', 'chronologd/src/custody.ts'),
    launcher('chronolog-recovery', 'chronolog-recovery-cli/src/main.ts'),
    launcher('chronolog-snapshot', 'chronologd/src/snapshot.ts'),
  ])
  await writeFile(join(staging, 'verify-distribution.mjs'), await readFile(join(root, 'tools', 'verify-distribution.mjs')), { mode: 0o755 })
  await writeFile(join(staging, 'bin', 'chronolog-verify'), '#!/bin/sh\nset -eu\nROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)\nexec node "$ROOT/verify-distribution.mjs"\n', { mode: 0o755 })
  await chmod(join(staging, 'bin', 'chronolog-verify'), 0o755)
  await writeFile(join(staging, 'INSTALL.md'), installGuide(), 'utf8')
  const subjects = await collectFiles(staging)
  const manifest = {
    format: 'chronolog-native-distribution-v1',
    version,
    sourceCommit: commit,
    platform: process.platform,
    architecture: process.arch,
    node: process.versions.node,
    packageManager: packageManager(),
    files: subjects,
  }
  await writeFile(join(staging, 'release-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  await rename(staging, destination)
  const archive = `${destination}.tar.gz`
  await rm(archive, { force: true })
  exec('tar', ['-czf', archive, '-C', outputDirectory, basename(destination)])
  process.stdout.write(`${JSON.stringify({
    event: 'chronolog.distribution_built',
    directory: destination,
    archive,
    archiveSha256: digest(await readFile(archive)),
    files: subjects.length,
    version,
  })}\n`)
} catch (error) {
  await rm(staging, { recursive: true, force: true })
  throw error
}

async function launcher(name: string, entry: string): Promise<void> {
  const path = join(staging, 'bin', name)
  const contents = `#!/bin/sh\nset -eu\nROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)\nexec "$ROOT/runtime/node_modules/.bin/tsx" "$ROOT/runtime/node_modules/${entry}" "$@"\n`
  await writeFile(path, contents, { encoding: 'utf8', mode: 0o755 })
  await chmod(path, 0o755)
}

async function collectFiles(directory: string): Promise<readonly Subject[]> {
  const result: Subject[] = []
  await walk(directory, result)
  return result.sort((left, right) => left.path.localeCompare(right.path))
}

async function walk(path: string, result: Subject[]): Promise<void> {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name)
    if (entry.isDirectory()) await walk(child, result)
    else if (entry.isFile()) {
      const value = await readFile(child)
      result.push({ path: relative(staging, child).split('\\').join('/'), sha256: digest(value), bytes: value.byteLength })
    } else if (entry.isSymbolicLink()) {
      const target = await readlink(child)
      const resolved = resolve(dirname(child), target)
      if (!resolved.startsWith(`${staging}/`)) throw new Error(`DISTRIBUTION_SYMLINK_ESCAPE:${relative(staging, child)}`)
      const stat = await lstat(resolved)
      if (!stat.isDirectory() && !stat.isFile() && !stat.isSymbolicLink()) throw new Error('DISTRIBUTION_SYMLINK_INVALID')
    }
  }
}

function installGuide(): string {
  return `# Chronolog native distribution\n\n` +
    `Platform: ${process.platform}-${process.arch}  \nSource: ${commit}\n\n` +
    `This directory is relocatable on the same OS/architecture with Node.js >=22. ` +
    `Add its \`bin\` directory to PATH. Set \`CHRONOLOG_DATA_DIR\` to a persistent directory, ` +
    `then run \`chronologd\`. Remote binds require \`CHRONOLOG_TOKEN\`.\n\n` +
    `Before upgrading, stop the daemon cleanly and back up the data directory and OS secret collection. ` +
    `Unpack the new distribution beside the old one, verify its attestation and run \`chronolog-verify\`, ` +
    `start the new \`chronologd\` against the unchanged data directory, and require ready health plus ` +
    `governance/replication inspection before removing the old package. Never downgrade a data directory ` +
    `after a release declares an irreversible storage migration.\n`
}

function exec(command: string, arguments_: readonly string[], environment: Readonly<Record<string, string>> = {}): string {
  return execFileSync(command, [...arguments_], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, ...environment },
  })
}
function tagVersion(): string | undefined {
  try {
    const tag = execFileSync('git', ['describe', '--tags', '--exact-match', '--match', 'v*'], {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    return /^v[0-9][0-9A-Za-z.-]*$/u.test(tag) ? tag.slice(1) : undefined
  } catch { return undefined }
}
function packageManager(): string {
  const value = JSON.parse(exec('git', ['show', 'HEAD:package.json'])) as { readonly packageManager?: unknown }
  if (typeof value.packageManager !== 'string') throw new Error('DISTRIBUTION_PACKAGE_MANAGER_MISSING')
  return value.packageManager
}
function argument(name: string, fallback: string): string {
  const index = process.argv.indexOf(name)
  if (index < 0) return fallback
  const value = process.argv[index + 1]
  if (value === undefined || value.startsWith('-')) throw new Error(`DISTRIBUTION_ARGUMENT_MISSING:${name}`)
  return value
}
function digest(value: Uint8Array): string { return createHash('sha256').update(value).digest('hex') }
