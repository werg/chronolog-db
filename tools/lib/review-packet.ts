import { execFileSync } from 'node:child_process'
import { copyFile, mkdir, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import { COMMIT_PATTERN, fileSha256, git, isMissing, isRecord, SHA256_PATTERN, sha256Hex } from './common.js'
import {
  evaluateGate,
  GATE_ITEMS,
  type DrillRoster,
  type GateReport,
} from './drill-evidence.js'

export const PACKET_FORMAT = 'chronolog-review-packet-v1'
export const THREAT_REVIEW_PATH = 'docs/security-threat-review.md'

/** Findings that are tracked in the threat review but are not release-blocking by their own text. */
const NON_BLOCKING_FINDINGS: Readonly<Record<string, string>> = {
  'SEC-007': 'Experimental workerd/CAS contract, not an active deployment target (docs/security-threat-review.md).',
}

export interface PacketInputs {
  readonly repo: string
  readonly output: string
  readonly sbom: string
  readonly provenance: string
  readonly conformance: string
  readonly fuzz: string
  readonly sanitizer: string
  readonly sanitizerMeta: string
  /** Additional named evidence (soak, characterization, production conformance, ...). */
  readonly attachments?: readonly { readonly name: string; readonly path: string }[]
  /** Drill evidence directory and the externally supplied roster used to evaluate it. */
  readonly evidence?: { readonly directory: string; readonly roster: DrillRoster; readonly rosterSha256: string }
  readonly includeSource?: boolean
  readonly now?: Date
}

export interface PacketFile {
  readonly path: string
  readonly role: string
  readonly sha256: string
  readonly bytes: number
}

export interface PacketFinding {
  readonly id: string
  readonly text: string
  readonly textSha256: string
  readonly releaseBlocking: boolean
  readonly gateKinds: readonly string[]
  /** `satisfied` only when every mapped drill has valid evidence; non-blocking findings stay `tracked`. */
  readonly status: 'unresolved' | 'evidence-present' | 'tracked-non-blocking'
  readonly note?: string
}

export interface PacketManifest {
  readonly format: typeof PACKET_FORMAT
  readonly commit: string
  readonly tree: string
  readonly pnpmLockSha256: string
  readonly createdAt: string
  readonly generator: { readonly node: string; readonly platform: string }
  readonly files: readonly PacketFile[]
  readonly omitted: readonly string[]
  readonly findings: readonly PacketFinding[]
  readonly unresolvedFindings: readonly string[]
  readonly gate: GateReport
  readonly notes: readonly string[]
}

export class PacketError extends Error {
  constructor(readonly code: string, message?: string) {
    super(message === undefined ? code : `${code}: ${message}`)
  }
}

// ------------------------------------------------------------ git state

/** Refuses any modified, staged, deleted, or untracked (non-ignored) path. */
export function assertCleanTree(repo: string): void {
  const status = git(repo, ['status', '--porcelain=v1', '--untracked-files=all', '--no-renames'])
  if (status.trim().length > 0) {
    const lines = status.trim().split('\n')
    throw new PacketError('REVIEW_PACKET_DIRTY_TREE', `${lines.length} path(s) differ from HEAD, first: ${lines[0]}`)
  }
}

function assertOutputIgnoredOrOutside(repo: string, output: string): void {
  const root = resolve(git(repo, ['rev-parse', '--show-toplevel']).trim())
  const inside = relative(root, output)
  if (inside.startsWith('..') || isAbsolute(inside)) return
  try {
    git(repo, ['check-ignore', '-q', '--', inside])
  } catch {
    throw new PacketError('REVIEW_PACKET_OUTPUT_TRACKED', 'output inside the repository must be a git-ignored path')
  }
}

// ----------------------------------------------------- input validators

async function readJsonFile(path: string, code: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown
  } catch (error) {
    throw new PacketError(code, error instanceof Error ? error.message : 'unreadable')
  }
}

export function validateSbom(value: unknown, commit: string, lockSha256: string): void {
  if (!isRecord(value) || value.bomFormat !== 'CycloneDX') throw new PacketError('REVIEW_PACKET_SBOM_INVALID')
  const metadata = isRecord(value.metadata) ? value.metadata : {}
  const component = isRecord(metadata.component) ? metadata.component : {}
  if (component.version !== commit) throw new PacketError('REVIEW_PACKET_SBOM_COMMIT_MISMATCH')
  const properties = Array.isArray(metadata.properties) ? metadata.properties as unknown[] : []
  const lock = properties.find((entry) => isRecord(entry) && entry.name === 'chronolog:pnpm-lock-sha256')
  if (!isRecord(lock) || lock.value !== lockSha256) throw new PacketError('REVIEW_PACKET_SBOM_LOCK_MISMATCH')
  if (!Array.isArray(value.components) || value.components.length === 0) throw new PacketError('REVIEW_PACKET_SBOM_EMPTY')
}

export function validateProvenance(source: string, commit: string): void {
  const lines = source.split('\n').filter((line) => line.trim().length > 0)
  if (lines.length === 0) throw new PacketError('REVIEW_PACKET_PROVENANCE_INVALID')
  for (const line of lines) {
    let statement: unknown
    try { statement = JSON.parse(line) } catch { throw new PacketError('REVIEW_PACKET_PROVENANCE_INVALID') }
    if (!isRecord(statement) || statement._type !== 'https://in-toto.io/Statement/v1') {
      throw new PacketError('REVIEW_PACKET_PROVENANCE_INVALID')
    }
    const predicate = isRecord(statement.predicate) ? statement.predicate : {}
    const definition = isRecord(predicate.buildDefinition) ? predicate.buildDefinition : {}
    const parameters = isRecord(definition.externalParameters) ? definition.externalParameters : {}
    if (parameters.sourceCommit !== commit) throw new PacketError('REVIEW_PACKET_PROVENANCE_COMMIT_MISMATCH')
    if (!Array.isArray(statement.subject) || statement.subject.length === 0) {
      throw new PacketError('REVIEW_PACKET_PROVENANCE_NO_SUBJECTS')
    }
  }
}

export function validateConformance(value: unknown, commit: string, name: string): void {
  if (!isRecord(value) || value.format !== 'chronolog-conformance-report-v1') {
    throw new PacketError('REVIEW_PACKET_CONFORMANCE_INVALID', name)
  }
  const deterministic = isRecord(value.deterministic) ? value.deterministic : {}
  const groups = Array.isArray(deterministic.testGroups) ? deterministic.testGroups as unknown[] : []
  if (groups.length === 0 || !groups.every((group) => isRecord(group) && group.passed === true)) {
    throw new PacketError('REVIEW_PACKET_CONFORMANCE_FAILED', name)
  }
  const operational = isRecord(value.operational) ? value.operational : {}
  if (operational.sourceCommit !== commit) throw new PacketError('REVIEW_PACKET_CONFORMANCE_COMMIT_MISMATCH', name)
}

/** Validates a Vitest JSON report and, optionally, that named test files were part of the run. */
export function validateTestReport(
  value: unknown,
  requiredFiles: readonly string[],
  commitTimeMs: number,
  name: string,
): void {
  if (!isRecord(value) || value.success !== true || value.numFailedTests !== 0 ||
    typeof value.numTotalTests !== 'number' || value.numTotalTests <= 0 ||
    !Array.isArray(value.testResults)) {
    throw new PacketError('REVIEW_PACKET_TEST_REPORT_FAILED', name)
  }
  const results = value.testResults as unknown[]
  const files = new Map<string, string>()
  for (const result of results) {
    if (isRecord(result) && typeof result.name === 'string') files.set(result.name, String(result.status))
  }
  for (const required of requiredFiles) {
    const match = [...files.entries()].find(([file]) => file.endsWith(`/${required}`))
    if (match === undefined || match[1] !== 'passed') throw new PacketError('REVIEW_PACKET_TEST_REPORT_INCOMPLETE', `${name}: ${required}`)
  }
  if (typeof value.startTime !== 'number' || value.startTime < commitTimeMs) {
    throw new PacketError('REVIEW_PACKET_TEST_REPORT_STALE', name)
  }
}

export const FUZZ_TEST_FILES = ['cbor.fuzz.test.ts', 'sql.fuzz.test.ts', 'sql-compiler.fuzz.test.ts'] as const
export const SANITIZER_TEST_FILES = [
  'sql-materializer.integration.test.ts',
  'sql-security.test.ts',
  'materializer-publication-crash.integration.test.ts',
] as const

export function validateSanitizerMeta(value: unknown, commit: string): void {
  if (!isRecord(value) || value.format !== 'chronolog-sanitizer-run-v1') throw new PacketError('REVIEW_PACKET_SANITIZER_META_INVALID')
  if (value.commit !== commit) throw new PacketError('REVIEW_PACKET_SANITIZER_META_COMMIT_MISMATCH')
  const flags = `${String(value.cflags)} ${String(value.cxxflags)} ${String(value.ldflags)}`
  if (!flags.includes('-fsanitize=address,undefined')) throw new PacketError('REVIEW_PACKET_SANITIZER_NOT_INSTRUMENTED')
}

// ------------------------------------------------------------- findings

export interface ParsedFinding { readonly id: string; readonly text: string }

/** Extracts every `SEC-nnn` bullet from the "Findings and disposition" section. */
export function parseFindings(markdown: string): readonly ParsedFinding[] {
  const start = markdown.indexOf('## Findings and disposition')
  if (start < 0) throw new PacketError('REVIEW_PACKET_FINDINGS_MISSING')
  const rest = markdown.slice(start + 1)
  const end = rest.indexOf('\n## ')
  const section = end < 0 ? rest : rest.slice(0, end)
  const findings: ParsedFinding[] = []
  let current: { id: string; lines: string[] } | null = null
  for (const line of section.split('\n')) {
    const heading = /^- `(SEC-\d{3})` — (.*)$/.exec(line)
    if (heading !== null) {
      if (current !== null) findings.push({ id: current.id, text: current.lines.join(' ').trim() })
      current = { id: heading[1] ?? '', lines: [heading[2] ?? ''] }
    } else if (current !== null && /^\s+\S/.test(line)) {
      current.lines.push(line.trim())
    } else if (current !== null && line.trim().length === 0) {
      findings.push({ id: current.id, text: current.lines.join(' ').trim() })
      current = null
    }
  }
  if (current !== null) findings.push({ id: current.id, text: current.lines.join(' ').trim() })
  if (findings.length === 0 || new Set(findings.map((finding) => finding.id)).size !== findings.length) {
    throw new PacketError('REVIEW_PACKET_FINDINGS_INVALID')
  }
  return findings
}

export function classifyFindings(parsed: readonly ParsedFinding[], gate: GateReport): readonly PacketFinding[] {
  return parsed.map((finding): PacketFinding => {
    const items = GATE_ITEMS.filter((item) => item.findings.includes(finding.id))
    const textSha256 = sha256Hex(finding.text)
    const nonBlocking = NON_BLOCKING_FINDINGS[finding.id]
    if (items.length === 0) {
      return nonBlocking !== undefined
        ? { ...finding, textSha256, releaseBlocking: false, gateKinds: [], status: 'tracked-non-blocking', note: nonBlocking }
        : { ...finding, textSha256, releaseBlocking: true, gateKinds: [], status: 'unresolved', note: 'No drill kind maps to this finding; it must be resolved or explicitly accepted by a human.' }
    }
    const satisfied = items.every((item) => gate.items.find((entry) => entry.kind === item.kind)?.status === 'satisfied')
    return {
      ...finding, textSha256, releaseBlocking: true,
      gateKinds: items.map((item) => item.kind),
      status: satisfied ? 'evidence-present' : 'unresolved',
    }
  })
}

// ---------------------------------------------------------------- build

async function addFile(
  files: PacketFile[],
  output: string,
  source: string,
  path: string,
  role: string,
): Promise<void> {
  const target = join(output, ...path.split('/'))
  await mkdir(dirname(target), { recursive: true })
  await copyFile(source, target)
  files.push({ path, role, sha256: await fileSha256(target), bytes: (await stat(target)).size })
}

async function walkFiles(directory: string, prefix = ''): Promise<string[]> {
  const found: string[] = []
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) found.push(...await walkFiles(path, `${prefix}${entry.name}/`))
    else if (entry.isFile()) found.push(`${prefix}${entry.name}`)
    else throw new PacketError('REVIEW_PACKET_EVIDENCE_NOT_REGULAR', `${prefix}${entry.name}`)
  }
  return found
}

export async function buildReviewPacket(inputs: PacketInputs): Promise<PacketManifest> {
  const repo = resolve(inputs.repo)
  const output = resolve(inputs.output)
  assertCleanTree(repo)
  assertOutputIgnoredOrOutside(repo, output)
  try {
    if ((await readdir(output)).length > 0) throw new PacketError('REVIEW_PACKET_OUTPUT_NOT_EMPTY', output)
  } catch (error) {
    if (!isMissing(error)) throw error
  }

  const commit = git(repo, ['rev-parse', 'HEAD']).trim()
  const tree = git(repo, ['rev-parse', 'HEAD^{tree}']).trim()
  if (!COMMIT_PATTERN.test(commit)) throw new PacketError('REVIEW_PACKET_COMMIT_INVALID')
  const commitTimeMs = Number(git(repo, ['show', '-s', '--format=%ct', 'HEAD']).trim()) * 1000
  const lockSha256 = sha256Hex(git(repo, ['show', 'HEAD:pnpm-lock.yaml']))

  // Validate every input before writing anything.
  validateSbom(await readJsonFile(inputs.sbom, 'REVIEW_PACKET_SBOM_UNREADABLE'), commit, lockSha256)
  validateProvenance(await readFile(inputs.provenance, 'utf8'), commit)
  validateConformance(await readJsonFile(inputs.conformance, 'REVIEW_PACKET_CONFORMANCE_UNREADABLE'), commit, 'conformance')
  validateTestReport(await readJsonFile(inputs.fuzz, 'REVIEW_PACKET_FUZZ_UNREADABLE'), FUZZ_TEST_FILES, commitTimeMs, 'fuzz')
  validateTestReport(await readJsonFile(inputs.sanitizer, 'REVIEW_PACKET_SANITIZER_UNREADABLE'), SANITIZER_TEST_FILES, commitTimeMs, 'sanitizer')
  validateSanitizerMeta(await readJsonFile(inputs.sanitizerMeta, 'REVIEW_PACKET_SANITIZER_META_UNREADABLE'), commit)
  const attachments = inputs.attachments ?? []
  for (const attachment of attachments) {
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(attachment.name)) throw new PacketError('REVIEW_PACKET_ATTACHMENT_NAME_INVALID', attachment.name)
    await stat(attachment.path)
  }

  const threatReviewPath = join(repo, THREAT_REVIEW_PATH)
  const parsedFindings = parseFindings(await readFile(threatReviewPath, 'utf8'))

  const evidenceFiles = inputs.evidence === undefined ? [] : await walkFiles(resolve(inputs.evidence.directory))
  const gate = await evaluateGate({
    commit,
    roster: inputs.evidence?.roster ?? { format: 'chronolog-drill-roster-v1', entries: [] },
    rosterSha256: inputs.evidence?.rosterSha256 ?? sha256Hex(''),
    evidenceDirectory: inputs.evidence === undefined ? null : resolve(inputs.evidence.directory),
    ...(inputs.now === undefined ? {} : { now: inputs.now }),
  })
  const findings = classifyFindings(parsedFindings, gate)

  await mkdir(output, { recursive: true })
  const files: PacketFile[] = []
  const omitted: string[] = []
  await addFile(files, output, inputs.sbom, 'evidence/sbom.cdx.json', 'sbom')
  await addFile(files, output, inputs.provenance, 'evidence/provenance.intoto.jsonl', 'provenance')
  await addFile(files, output, inputs.conformance, 'evidence/conformance-report.json', 'conformance-report')
  await addFile(files, output, inputs.fuzz, 'evidence/fuzz-results.json', 'fuzz-results')
  await addFile(files, output, inputs.sanitizer, 'evidence/sanitizer-results.json', 'sanitizer-results')
  await addFile(files, output, inputs.sanitizerMeta, 'evidence/sanitizer-run.json', 'sanitizer-run')
  await addFile(files, output, threatReviewPath, 'docs/security-threat-review.md', 'threat-review')
  for (const attachment of attachments) {
    await addFile(files, output, attachment.path, `attachments/${attachment.name}${extension(attachment.path)}`, `attachment:${attachment.name}`)
  }
  if (inputs.evidence !== undefined) {
    const evidenceRoot = resolve(inputs.evidence.directory)
    for (const path of evidenceFiles) await addFile(files, output, join(evidenceRoot, ...path.split('/')), `drills/${path}`, 'drill-evidence')
  }
  if (inputs.includeSource === false) {
    omitted.push('source archive (--no-source); reviewer must obtain the exact commit independently')
  } else {
    const archive = join(output, 'source', `chronolog-${commit.slice(0, 12)}.tar`)
    await mkdir(dirname(archive), { recursive: true })
    execFileSync('git', ['archive', '--format=tar', `--output=${archive}`, commit], { cwd: repo })
    files.push({ path: `source/${basename(archive)}`, role: 'source-archive', sha256: await fileSha256(archive), bytes: (await stat(archive)).size })
  }
  if (inputs.evidence === undefined) omitted.push('drill evidence (none supplied; every drill is reported missing)')

  files.sort((a, b) => a.path.localeCompare(b.path))
  const manifest: PacketManifest = {
    format: PACKET_FORMAT,
    commit,
    tree,
    pnpmLockSha256: lockSha256,
    createdAt: (inputs.now ?? new Date()).toISOString(),
    generator: { node: process.versions.node, platform: `${process.platform}-${process.arch}` },
    files,
    omitted,
    findings,
    unresolvedFindings: findings.filter((finding) => finding.status === 'unresolved').map((finding) => finding.id),
    gate,
    notes: [
      'Test reports are bound to the commit by timestamp and by the producing workflow, not by a signature; sanitizer instrumentation is attested by sanitizer-run.json from the same workflow.',
      'Drill records are evaluated against a roster supplied outside the repository; the roster digest is recorded in gate.rosterSha256.',
      'A packet establishes what was handed to the reviewer. It is not itself an assessment.',
    ],
  }
  await writeFile(join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  const sums = [...files.map((file) => ({ path: file.path, sha256: file.sha256 })), { path: 'manifest.json', sha256: await fileSha256(join(output, 'manifest.json')) }]
    .sort((a, b) => a.path.localeCompare(b.path))
  await writeFile(join(output, 'SHA256SUMS'), sums.map((entry) => `${entry.sha256}  ${entry.path}\n`).join(''), 'utf8')

  // The tree must still be exactly the committed release candidate.
  assertCleanTree(repo)
  if (git(repo, ['rev-parse', 'HEAD']).trim() !== commit) throw new PacketError('REVIEW_PACKET_HEAD_MOVED')
  return manifest
}

function extension(path: string): string {
  const name = basename(path)
  const index = name.lastIndexOf('.')
  return index <= 0 ? '' : name.slice(index)
}

// --------------------------------------------------------------- verify

export interface PacketVerification {
  readonly valid: boolean
  readonly commit: string | null
  readonly manifestSha256: string | null
  readonly errors: readonly string[]
}

/** Offline reviewer-side check: every file hash, no extras, commit bindings in all evidence. */
export async function verifyReviewPacket(directory: string): Promise<PacketVerification> {
  const root = resolve(directory)
  const errors: string[] = []
  let manifestSha256: string | null = null
  let commit: string | null = null
  try {
    const manifestPath = join(root, 'manifest.json')
    const manifestSource = await readFile(manifestPath, 'utf8')
    manifestSha256 = sha256Hex(manifestSource)
    const manifest = JSON.parse(manifestSource) as unknown
    if (!isRecord(manifest) || manifest.format !== PACKET_FORMAT || typeof manifest.commit !== 'string' ||
      !COMMIT_PATTERN.test(manifest.commit) || !Array.isArray(manifest.files) || typeof manifest.pnpmLockSha256 !== 'string') {
      return { valid: false, commit: null, manifestSha256, errors: ['MANIFEST_INVALID'] }
    }
    commit = manifest.commit
    const listed = new Map<string, PacketFile>()
    for (const entry of manifest.files as unknown[]) {
      if (!isRecord(entry) || typeof entry.path !== 'string' || typeof entry.sha256 !== 'string' ||
        !SHA256_PATTERN.test(entry.sha256) || typeof entry.role !== 'string' || typeof entry.bytes !== 'number' ||
        entry.path.startsWith('/') || entry.path.split('/').some((part) => part === '..' || part === '' || part === '.')) {
        errors.push('MANIFEST_ENTRY_INVALID')
        continue
      }
      if (listed.has(entry.path)) errors.push(`MANIFEST_DUPLICATE:${entry.path}`)
      listed.set(entry.path, { path: entry.path, role: entry.role, sha256: entry.sha256, bytes: entry.bytes })
    }
    const realRoot = await realpath(root)
    for (const file of listed.values()) {
      const path = join(root, ...file.path.split('/'))
      try {
        const real = await realpath(path)
        if (!real.startsWith(realRoot + sep)) { errors.push(`FILE_ESCAPES:${file.path}`); continue }
        if ((await stat(path)).size !== file.bytes) errors.push(`FILE_SIZE_MISMATCH:${file.path}`)
        if (await fileSha256(path) !== file.sha256) errors.push(`FILE_DIGEST_MISMATCH:${file.path}`)
      } catch {
        errors.push(`FILE_MISSING:${file.path}`)
      }
    }
    for (const path of await walkFiles(root)) {
      if (path !== 'manifest.json' && path !== 'SHA256SUMS' && !listed.has(path)) errors.push(`FILE_UNLISTED:${path}`)
    }
    // SHA256SUMS must agree with the manifest and cover the manifest itself.
    const expectedSums = new Map([...listed.values()].map((file) => [file.path, file.sha256]))
    expectedSums.set('manifest.json', manifestSha256)
    const sums = new Map<string, string>()
    for (const line of (await readFile(join(root, 'SHA256SUMS'), 'utf8')).split('\n').filter((entry) => entry.length > 0)) {
      const match = /^([0-9a-f]{64}) {2}(.+)$/.exec(line)
      if (match === null) { errors.push('SHA256SUMS_INVALID'); continue }
      sums.set(match[2] ?? '', match[1] ?? '')
    }
    for (const [path, digest] of expectedSums) if (sums.get(path) !== digest) errors.push(`SHA256SUMS_MISMATCH:${path}`)
    for (const path of sums.keys()) if (!expectedSums.has(path)) errors.push(`SHA256SUMS_EXTRA:${path}`)

    // Re-run the commit bindings against the files actually delivered.
    const sbom = join(root, 'evidence/sbom.cdx.json')
    const rebinding = async (name: string, check: () => Promise<void>): Promise<void> => {
      try { await check() } catch (error) { errors.push(error instanceof PacketError ? error.message : `BINDING_FAILED:${name}`) }
    }
    await rebinding('sbom', async () => validateSbom(JSON.parse(await readFile(sbom, 'utf8')), commit ?? '', manifest.pnpmLockSha256 as string))
    await rebinding('provenance', async () => validateProvenance(await readFile(join(root, 'evidence/provenance.intoto.jsonl'), 'utf8'), commit ?? ''))
    await rebinding('conformance', async () => validateConformance(JSON.parse(await readFile(join(root, 'evidence/conformance-report.json'), 'utf8')), commit ?? '', 'conformance'))
    await rebinding('sanitizer-run', async () => validateSanitizerMeta(JSON.parse(await readFile(join(root, 'evidence/sanitizer-run.json'), 'utf8')), commit ?? ''))
    await rebinding('fuzz', async () => validateTestReport(JSON.parse(await readFile(join(root, 'evidence/fuzz-results.json'), 'utf8')), FUZZ_TEST_FILES, 0, 'fuzz'))
    await rebinding('sanitizer', async () => validateTestReport(JSON.parse(await readFile(join(root, 'evidence/sanitizer-results.json'), 'utf8')), SANITIZER_TEST_FILES, 0, 'sanitizer'))

    const source = [...listed.values()].find((file) => file.role === 'source-archive')
    if (source !== undefined) {
      const head = Buffer.alloc(1024)
      const { open } = await import('node:fs/promises')
      const handle = await open(join(root, ...source.path.split('/')), 'r')
      try { await handle.read(head, 0, 1024, 0) } finally { await handle.close() }
      if (!head.toString('latin1').includes(`comment=${commit}`)) errors.push('SOURCE_ARCHIVE_COMMIT_MISMATCH')
    } else if (!Array.isArray(manifest.omitted) || !(manifest.omitted as unknown[]).some((entry) => typeof entry === 'string' && entry.startsWith('source archive'))) {
      errors.push('SOURCE_ARCHIVE_MISSING')
    }
    if (!Array.isArray(manifest.findings) || manifest.findings.length === 0) errors.push('FINDINGS_MISSING')
  } catch (error) {
    errors.push(`INTERNAL:${error instanceof Error ? error.message : 'unknown'}`)
  }
  return { valid: errors.length === 0, commit, manifestSha256, errors }
}
