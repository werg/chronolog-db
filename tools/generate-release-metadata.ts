import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'

interface LicensePackage {
  readonly name: string
  readonly versions: readonly string[]
  readonly license: string
}

interface Component {
  readonly type: 'application' | 'library'
  readonly name: string
  readonly version: string
  readonly 'bom-ref': string
  readonly purl?: string
  readonly licenses?: readonly { readonly license: { readonly name: string } }[]
}

const root = resolve('.')
const outputDirectory = resolve(argument('--output', 'artifacts/release'))
const components = await collectComponents()
const componentDigest = digest(stableJson(components))
const sbom = {
  bomFormat: 'CycloneDX',
  specVersion: '1.6',
  serialNumber: uuidUrn(componentDigest),
  version: 1,
  metadata: {
    component: {
      type: 'application',
      name: 'chronolog-db',
      version: sourceCommit(),
      'bom-ref': 'pkg:generic/chronolog-db',
    },
    properties: [
      { name: 'chronolog:pnpm-lock-sha256', value: await fileDigest('pnpm-lock.yaml') },
      { name: 'chronolog:component-set-sha256', value: componentDigest },
    ],
  },
  components,
}

const subjects = await collectSubjects(['dist', 'patches'])
const provenance = {
  _type: 'https://in-toto.io/Statement/v1',
  subject: subjects.map((subject) => ({
    name: subject.path,
    digest: { sha256: subject.sha256 },
  })),
  predicateType: 'https://slsa.dev/provenance/v1',
  predicate: {
    buildDefinition: {
      buildType: 'https://chronolog.dev/builds/native-typescript/v1',
      externalParameters: {
        sourceCommit: sourceCommit(),
        node: process.versions.node,
        platform: `${process.platform}-${process.arch}`,
      },
      internalParameters: {
        packageManager: packageManager(),
      },
      resolvedDependencies: [{
        uri: 'file:pnpm-lock.yaml',
        digest: { sha256: await fileDigest('pnpm-lock.yaml') },
      }],
    },
    runDetails: {
      builder: { id: 'https://chronolog.dev/builders/local-release-metadata/v1' },
      metadata: { invocationId: `${sourceCommit()}:${componentDigest}` },
    },
  },
}

await mkdir(outputDirectory, { recursive: true })
await Promise.all([
  writeFile(join(outputDirectory, 'sbom.cdx.json'), `${JSON.stringify(sbom, null, 2)}\n`, 'utf8'),
  writeFile(join(outputDirectory, 'provenance.intoto.jsonl'), `${stableJson(provenance)}\n`, 'utf8'),
])
process.stdout.write(`${JSON.stringify({
  event: 'chronolog.release_metadata',
  outputDirectory,
  components: components.length,
  subjects: subjects.length,
  componentDigest,
})}\n`)

async function collectComponents(): Promise<readonly Component[]> {
  const byRef = new Map<string, Component>()
  for (const directory of ['apps', 'packages']) {
    for (const entry of await readdir(resolve(root, directory), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      let source: string
      try {
        source = await readFile(resolve(root, directory, entry.name, 'package.json'), 'utf8')
      } catch (error) {
        if (isMissing(error)) continue
        throw error
      }
      const manifest = JSON.parse(source) as {
        name?: unknown
        version?: unknown
      }
      if (typeof manifest.name !== 'string' || typeof manifest.version !== 'string') continue
      const reference = npmPurl(manifest.name, manifest.version)
      byRef.set(reference, {
        type: 'library',
        name: manifest.name,
        version: manifest.version,
        'bom-ref': reference,
        purl: reference,
      })
    }
  }
  const licenses = JSON.parse(execFileSync(
    'pnpm', ['licenses', 'list', '--json', '--prod'], { cwd: root, encoding: 'utf8' },
  )) as Record<string, readonly LicensePackage[]>
  for (const packages of Object.values(licenses)) {
    for (const package_ of packages) {
      for (const version of package_.versions) {
        const reference = npmPurl(package_.name, version)
        byRef.set(reference, {
          type: 'library',
          name: package_.name,
          version,
          'bom-ref': reference,
          purl: reference,
          ...(package_.license.length === 0 ? {} : {
            licenses: [{ license: { name: package_.license } }],
          }),
        })
      }
    }
  }
  return [...byRef.values()].sort((left, right) => left['bom-ref'].localeCompare(right['bom-ref']))
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
}

async function collectSubjects(directories: readonly string[]): Promise<readonly { path: string; sha256: string }[]> {
  const result: { path: string; sha256: string }[] = []
  for (const directory of directories) await walk(resolve(root, directory), result)
  return result.sort((left, right) => left.path.localeCompare(right.path))
}

async function walk(path: string, result: { path: string; sha256: string }[]): Promise<void> {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name)
    if (entry.isDirectory()) await walk(child, result)
    else if (entry.isFile()) result.push({
      path: relative(root, child).split('\\').join('/'),
      sha256: await fileDigest(child),
    })
  }
}

async function fileDigest(path: string): Promise<string> {
  return digest(await readFile(resolve(root, path)))
}

function sourceCommit(): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
}

function packageManager(): string {
  const manifest = JSON.parse(execFileSync('git', ['show', 'HEAD:package.json'], {
    cwd: root,
    encoding: 'utf8',
  })) as { packageManager?: unknown }
  if (typeof manifest.packageManager !== 'string') throw new Error('RELEASE_PACKAGE_MANAGER_MISSING')
  return manifest.packageManager
}

function argument(name: string, fallback: string): string {
  const index = process.argv.indexOf(name)
  if (index < 0) return fallback
  const value = process.argv[index + 1]
  if (value === undefined || value.startsWith('-')) throw new Error(`RELEASE_ARGUMENT_MISSING:${name}`)
  return value
}

function digest(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

function uuidUrn(hex: string): string {
  return `urn:uuid:${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

function npmPurl(name: string, version: string): string {
  const encoded = name.startsWith('@')
    ? `%40${name.slice(1).split('/').map(encodeURIComponent).join('/')}`
    : encodeURIComponent(name)
  return `pkg:npm/${encoded}@${encodeURIComponent(version)}`
}

function stableJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string' || typeof value === 'number') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`
  }
  throw new Error('RELEASE_JSON_INVALID')
}
