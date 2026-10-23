import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { parseArgs } from 'node:util'

import { COMMIT_PATTERN, fileSha256, git, sha256Hex } from './lib/common.js'
import {
  DRILL_KINDS,
  DRILL_RECORD_FORMAT,
  DRILL_RECORD_SUFFIX,
  decodeBase64Url,
  drillRecordJsonSchema,
  evaluateGate,
  fingerprintOf,
  generateDrillKey,
  parseDrillKey,
  parseDrillRecord,
  parseRoster,
  renderGate,
  signDrillRecord,
  verifyDrillRecord,
  type DrillBody,
  type DrillRoster,
} from './lib/drill-evidence.js'

const USAGE = `Usage: pnpm drill <command> [options]

  keygen  --out KEY.json                      create a participant signing key (mode 0600)
  record  --kind KIND --dir DIR [--out FILE]  write an UNSIGNED record binding commit, participants,
          --participant ROLE=PUBLIC_KEY ...   checks and artifact digests (artifacts live under DIR)
          --check ID[=NOTE] ... --artifact NAME=RELATIVE_PATH ...
          --env KEY=VALUE ... --detail KEY=VALUE ... [--commit SHA] --started T --completed T
  sign    --record FILE --key KEY.json        add the key holder's signature (one per participant)
  verify  --record FILE --roster ROSTER.json (--commit SHA | --any-commit)
  gate    --roster ROSTER.json [--evidence DIR] [--commit SHA] [--json]
  schema  [--check FILE]                      print the JSON Schema (or verify a checked-in copy)

Kinds: ${DRILL_KINDS.join(', ')}
Exit status is non-zero whenever verification or the gate fails.`

class UsageError extends Error {}

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2)
  switch (command) {
    case 'keygen': return keygen(rest)
    case 'record': return record(rest)
    case 'sign': return sign(rest)
    case 'verify': return verify(rest)
    case 'gate': return gate(rest)
    case 'schema': return schema(rest)
    default:
      process.stderr.write(`${USAGE}\n`)
      return command === undefined || command === '--help' ? 0 : 2
  }
}

function options<T extends Record<string, { type: 'string' | 'boolean'; multiple?: boolean }>>(args: string[], spec: T) {
  try {
    return parseArgs({ args, options: spec, allowPositionals: false, strict: true }).values
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : 'invalid arguments')
  }
}

function required(value: string | undefined, name: string): string {
  if (value === undefined) throw new UsageError(`missing --${name}`)
  return value
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown
}

async function writeAtomic(path: string, content: string, mode = 0o644): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, content, { mode, flag: 'wx' })
  await rename(temporary, path)
}

function headCommit(): string {
  return git(resolve('.'), ['rev-parse', 'HEAD']).trim()
}

function pairs(values: string[] | undefined, name: string): [string, string][] {
  return (values ?? []).map((entry) => {
    const index = entry.indexOf('=')
    if (index <= 0) throw new UsageError(`--${name} expects KEY=VALUE`)
    return [entry.slice(0, index), entry.slice(index + 1)]
  })
}

async function keygen(args: string[]): Promise<number> {
  const values = options(args, { out: { type: 'string' } })
  const out = resolve(required(values.out, 'out'))
  const key = await generateDrillKey()
  await writeFile(out, `${JSON.stringify(key, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
  process.stdout.write(`${JSON.stringify({ event: 'chronolog.drill_key_created', fingerprint: key.fingerprint, publicKey: key.publicKey, keyFile: out })}\n`)
  return 0
}

async function record(args: string[]): Promise<number> {
  const values = options(args, {
    kind: { type: 'string' }, dir: { type: 'string' }, out: { type: 'string' }, commit: { type: 'string' },
    started: { type: 'string' }, completed: { type: 'string' },
    participant: { type: 'string', multiple: true }, check: { type: 'string', multiple: true },
    artifact: { type: 'string', multiple: true }, env: { type: 'string', multiple: true },
    detail: { type: 'string', multiple: true },
  })
  const kind = DRILL_KINDS.find((candidate) => candidate === values.kind)
  if (kind === undefined) throw new UsageError(`--kind must be one of ${DRILL_KINDS.join(', ')}`)
  const directory = resolve(required(values.dir, 'dir'))
  const commit = values.commit ?? headCommit()
  if (!COMMIT_PATTERN.test(commit)) throw new UsageError('--commit must be a 40-character lowercase hex commit')

  const participants = pairs(values.participant, 'participant').map(([role, publicKey]) => {
    const bytes = decodeBase64Url(publicKey, 32)
    if (bytes === null) throw new UsageError(`participant ${role}: public key must be 32 bytes of base64url`)
    return { role, publicKey, fingerprint: fingerprintOf(bytes) }
  })
  const checks = (values.check ?? []).map((entry) => {
    const index = entry.indexOf('=')
    return index < 0 ? { id: entry, passed: true } : { id: entry.slice(0, index), passed: true, note: entry.slice(index + 1) }
  })
  const artifacts = await Promise.all(pairs(values.artifact, 'artifact').map(async ([name, path]) => {
    const absolute = resolve(directory, path)
    const inside = relative(directory, absolute)
    if (inside.startsWith('..') || isAbsolute(inside) || inside.length === 0) {
      throw new UsageError(`artifact ${name} must live inside --dir`)
    }
    return {
      name, path: inside.split(sep).join('/'),
      sha256: await fileSha256(absolute), bytes: (await stat(absolute)).size,
    }
  }))
  const body: DrillBody = {
    format: DRILL_RECORD_FORMAT, kind, commit,
    startedAt: required(values.started, 'started'),
    completedAt: required(values.completed, 'completed'),
    environment: Object.fromEntries(pairs(values.env, 'env')),
    details: Object.fromEntries(pairs(values.detail, 'detail')),
    participants, checks, artifacts,
  }
  const output = resolve(directory, values.out ?? `${kind}${DRILL_RECORD_SUFFIX}`)
  if (!basename(output).endsWith(DRILL_RECORD_SUFFIX)) throw new UsageError(`--out must end with ${DRILL_RECORD_SUFFIX}`)
  if (dirname(output) !== directory) throw new UsageError('--out must be directly inside --dir')
  await mkdir(directory, { recursive: true })
  await writeAtomic(output, `${JSON.stringify({ ...body, signatures: [] }, null, 2)}\n`)
  process.stdout.write(`${JSON.stringify({ event: 'chronolog.drill_record_drafted', file: output, kind, commit, requiredSignatures: participants.length })}\n`)
  return 0
}

async function sign(args: string[]): Promise<number> {
  const values = options(args, { record: { type: 'string' }, key: { type: 'string' } })
  const path = resolve(required(values.record, 'record'))
  const parsed = parseDrillRecord(await readJson(path))
  if (parsed.value === null) throw new Error(`DRILL_RECORD_INVALID:${parsed.errors.join(',')}`)
  const key = parseDrillKey(await readJson(resolve(required(values.key, 'key'))))
  const signed = await signDrillRecord(parsed.value, key)
  await writeFile(path, `${JSON.stringify(signed, null, 2)}\n`, 'utf8')
  process.stdout.write(`${JSON.stringify({
    event: 'chronolog.drill_record_signed', file: path, signer: key.fingerprint,
    signatures: signed.signatures.length, participants: signed.participants.length,
  })}\n`)
  return 0
}

async function loadRoster(path: string): Promise<{ roster: DrillRoster; sha256: string }> {
  const source = await readFile(resolve(path), 'utf8')
  const parsed = parseRoster(JSON.parse(source))
  if (parsed.value === null) throw new Error(`DRILL_ROSTER_INVALID:${parsed.errors.join(',')}`)
  return { roster: parsed.value, sha256: sha256Hex(source) }
}

async function verify(args: string[]): Promise<number> {
  const values = options(args, {
    record: { type: 'string' }, roster: { type: 'string' }, commit: { type: 'string' }, 'any-commit': { type: 'boolean' },
  })
  if (values.commit === undefined && values['any-commit'] !== true) throw new UsageError('pass --commit SHA or --any-commit')
  const path = resolve(required(values.record, 'record'))
  const { roster } = await loadRoster(required(values.roster, 'roster'))
  const result = await verifyDrillRecord(await readJson(path), {
    roster,
    artifactsRoot: dirname(path),
    ...(values.commit === undefined ? {} : { expectedCommit: values.commit }),
  })
  process.stdout.write(`${JSON.stringify({
    event: result.valid ? 'chronolog.drill_record_valid' : 'chronolog.drill_record_invalid',
    file: path, kind: result.kind, commit: result.commit, recordDigest: result.recordDigest, errors: result.errors,
  })}\n`)
  return result.valid ? 0 : 1
}

async function gate(args: string[]): Promise<number> {
  const values = options(args, {
    roster: { type: 'string' }, evidence: { type: 'string' }, commit: { type: 'string' }, json: { type: 'boolean' },
  })
  const { roster, sha256 } = await loadRoster(required(values.roster, 'roster'))
  const commit = values.commit ?? headCommit()
  if (!COMMIT_PATTERN.test(commit)) throw new UsageError('--commit must be a 40-character lowercase hex commit')
  const report = await evaluateGate({
    commit, roster, rosterSha256: sha256,
    evidenceDirectory: values.evidence === undefined ? null : resolve(values.evidence),
  })
  process.stdout.write(values.json === true ? `${JSON.stringify(report, null, 2)}\n` : `${renderGate(report)}\n`)
  return report.satisfied ? 0 : 1
}

async function schema(args: string[]): Promise<number> {
  const values = options(args, { check: { type: 'string' } })
  const expected = `${JSON.stringify(drillRecordJsonSchema(), null, 2)}\n`
  if (values.check === undefined) {
    process.stdout.write(expected)
    return 0
  }
  const actual = await readFile(resolve(values.check), 'utf8')
  if (actual !== expected) {
    process.stderr.write(`${values.check} is out of date; regenerate with: pnpm drill schema > ${values.check}\n`)
    return 1
  }
  return 0
}

main().then((code) => { process.exitCode = code }, (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`${message}\n`)
  if (error instanceof UsageError) process.stderr.write(`${USAGE}\n`)
  process.exitCode = error instanceof UsageError ? 2 : 1
})
