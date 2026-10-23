import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { afterEach, describe, expect, it } from 'vitest'

import { sha256Hex } from './common.js'
import {
  DRILL_KINDS,
  DRILL_RECORD_FORMAT,
  DRILL_ROSTER_FORMAT,
  DRILL_SPECS,
  evaluateGate,
  generateDrillKey,
  parseDrillKey,
  parseDrillRecord,
  recordDigest,
  renderGate,
  signDrillRecord,
  verifyDrillRecord,
  type DrillBody,
  type DrillKeyFile,
  type DrillKind,
  type DrillRecord,
  type DrillRoster,
  type RosterEntry,
} from './drill-evidence.js'

const COMMIT = 'a'.repeat(40)
const OTHER_COMMIT = 'b'.repeat(40)
const NOW = new Date('2026-06-01T00:00:00.000Z')
const run = promisify(execFile)
const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'chronolog-drill-'))
  directories.push(directory)
  return directory
}

interface Fixture {
  readonly record: DrillRecord
  readonly body: DrillBody
  readonly keys: readonly { readonly role: string; readonly key: DrillKeyFile }[]
  readonly roster: DrillRoster
  readonly directory: string
}

/** Builds a fully valid, fully signed record for any kind straight from its spec. */
async function fixture(kind: DrillKind, options: { readonly sign?: boolean; readonly commit?: string } = {}): Promise<Fixture> {
  const spec = DRILL_SPECS[kind]
  const directory = await temporaryDirectory()
  const keys: { role: string; key: DrillKeyFile }[] = []
  const entries: RosterEntry[] = []
  for (const [role, roleSpec] of Object.entries(spec.roles)) {
    for (let index = 0; index < roleSpec.min; index += 1) {
      const key = await generateDrillKey()
      keys.push({ role, key })
      entries.push({ fingerprint: key.fingerprint, roles: [role], independenceGroup: `${role}-${String(index)}` })
    }
  }
  const artifacts = []
  for (const name of spec.artifacts) {
    const content = `artifact ${name} for ${kind}\n`
    await writeFile(join(directory, `${name}.txt`), content)
    artifacts.push({ name, path: `${name}.txt`, sha256: sha256Hex(content), bytes: Buffer.byteLength(content) })
  }
  const details: Record<string, string> = {}
  for (const detail of spec.details) {
    details[detail] = detail === 'previousCommit' ? OTHER_COMMIT
      : artifacts.find((artifact) => artifact.name === 'review-packet-manifest')?.sha256 ?? ''
  }
  const body: DrillBody = {
    format: DRILL_RECORD_FORMAT,
    kind,
    commit: options.commit ?? COMMIT,
    startedAt: '2026-05-01T10:00:00Z',
    completedAt: '2026-05-01T11:00:00Z',
    environment: Object.fromEntries(spec.environment.map((name) => [name, 'test'])),
    details,
    participants: keys.map(({ role, key }) => ({
      role, publicKey: key.publicKey, fingerprint: key.fingerprint,
    })),
    checks: spec.checks.map((id) => ({ id, passed: true })),
    artifacts,
  }
  let record: DrillRecord = { ...body, signatures: [] }
  if (options.sign !== false) {
    for (const { key } of keys) record = await signDrillRecord(record, key)
  }
  return { record, body, keys, roster: { format: DRILL_ROSTER_FORMAT, entries }, directory }
}

function verify(input: Fixture, record: unknown = input.record, roster: DrillRoster = input.roster) {
  return verifyDrillRecord(record, {
    roster, artifactsRoot: input.directory, expectedCommit: COMMIT, now: NOW,
  })
}

describe('drill evidence verification', () => {
  it('accepts a fully signed record for every drill kind', async () => {
    for (const kind of DRILL_KINDS) {
      const input = await fixture(kind)
      const result = await verify(input)
      expect(result.errors, kind).toEqual([])
      expect(result.valid).toBe(true)
      expect(result.recordDigest).toBe(recordDigest(input.record))
    }
  })

  it('survives a JSON round trip unchanged', async () => {
    const input = await fixture('alert')
    const reparsed = parseDrillRecord(JSON.parse(JSON.stringify(input.record)))
    expect(reparsed.errors).toEqual([])
    expect((await verify(input, reparsed.value)).valid).toBe(true)
  })

  it('rejects a record modified after signing', async () => {
    const input = await fixture('alert')
    const tampered = { ...input.record, completedAt: '2026-05-01T12:00:00Z' }
    const result = await verify(input, tampered)
    expect(result.valid).toBe(false)
    for (const { key } of input.keys) expect(result.errors).toContain(`SIGNATURE_INVALID:${key.fingerprint}`)

    const flipped = { ...input.record, checks: input.record.checks.map((check) => ({ ...check, note: 'edited' })) }
    expect((await verify(input, flipped)).valid).toBe(false)
  })

  it('rejects a signature that was swapped between participants', async () => {
    const input = await fixture('alert')
    const [first, second] = input.record.signatures
    const swapped = {
      ...input.record,
      signatures: [
        { fingerprint: first!.fingerprint, signature: second!.signature },
        { fingerprint: second!.fingerprint, signature: first!.signature },
      ],
    }
    const result = await verify(input, swapped)
    expect(result.valid).toBe(false)
    expect(result.errors.filter((error) => error.startsWith('SIGNATURE_INVALID'))).toHaveLength(2)
  })

  it('requires a signature from every participant', async () => {
    const input = await fixture('alert')
    const partial = { ...input.record, signatures: input.record.signatures.slice(0, 1) }
    const result = await verify(input, partial)
    expect(result.valid).toBe(false)
    expect(result.errors).toEqual([`SIGNATURE_MISSING:${input.record.signatures[1]!.fingerprint}`])
    expect((await verify(input, { ...input.record, signatures: [] })).valid).toBe(false)
  })

  it('rejects signatures from keys that are not participants, and duplicates', async () => {
    const input = await fixture('alert')
    const outsider = await generateDrillKey()
    await expect(signDrillRecord(input.record, outsider)).rejects.toThrow('DRILL_SIGNER_NOT_PARTICIPANT')
    await expect(signDrillRecord(input.record, input.keys[0]!.key)).rejects.toThrow('DRILL_ALREADY_SIGNED')

    const outsiderRecord = await signDrillRecord(
      { ...input.record, participants: [...input.record.participants, { role: 'responder', publicKey: outsider.publicKey, fingerprint: outsider.fingerprint }] },
      outsider,
    )
    const forged = {
      ...input.record,
      signatures: [...input.record.signatures, outsiderRecord.signatures.at(-1)!],
    }
    expect((await verify(input, forged)).errors).toContain(`SIGNATURE_UNKNOWN_SIGNER:${outsider.fingerprint}`)

    const duplicated = { ...input.record, signatures: [...input.record.signatures, input.record.signatures[0]!] }
    expect((await verify(input, duplicated)).errors)
      .toContain(`SIGNATURE_DUPLICATE:${input.record.signatures[0]!.fingerprint}`)
  })

  it('rejects a participant whose roster entry does not grant the claimed role', async () => {
    const input = await fixture('alert')
    const responder = input.keys.find(({ role }) => role === 'responder')!.key
    const roster: DrillRoster = {
      ...input.roster,
      entries: input.roster.entries.map((entry) =>
        entry.fingerprint === responder.fingerprint ? { ...entry, roles: ['operator'] } : entry),
    }
    const result = await verify(input, input.record, roster)
    expect(result.valid).toBe(false)
    expect(result.errors).toContain(`ROSTER_ROLE_NOT_GRANTED:${responder.fingerprint}:responder`)
  })

  it('rejects a participant missing from the roster, an undeclared role, and a short role quota', async () => {
    const input = await fixture('alert')
    const responder = input.keys.find(({ role }) => role === 'responder')!.key
    const roster: DrillRoster = {
      ...input.roster,
      entries: input.roster.entries.filter((entry) => entry.fingerprint !== responder.fingerprint),
    }
    expect((await verify(input, input.record, roster)).errors)
      .toContain(`ROSTER_UNKNOWN_PARTICIPANT:${responder.fingerprint}`)

    const missingRole = await fixture('alert', { sign: false })
    const withoutResponder = {
      ...missingRole.record,
      participants: missingRole.record.participants.filter((participant) => participant.role !== 'responder'),
    }
    expect((await verify(missingRole, withoutResponder)).errors).toContain('ROLE_COUNT:responder:0<1')

    const wrongRole = { ...missingRole.record, participants: missingRole.record.participants.map((participant) => ({ ...participant, role: 'bystander' })) }
    expect((await verify(missingRole, wrongRole)).errors).toContain(`ROLE_UNEXPECTED:bystander`)
  })

  it('enforces independence groups between roles and among custodians', async () => {
    const snapshot = await fixture('snapshot-repair')
    const sameGroup: DrillRoster = {
      ...snapshot.roster,
      entries: snapshot.roster.entries.map((entry) => ({ ...entry, independenceGroup: 'one-team' })),
    }
    expect((await verify(snapshot, snapshot.record, sameGroup)).errors).toContain('INDEPENDENCE_VIOLATED:reviewer:operator')

    const ungrouped: DrillRoster = {
      ...snapshot.roster,
      entries: snapshot.roster.entries.map(({ independenceGroup: _group, ...entry }) => entry),
    }
    expect((await verify(snapshot, snapshot.record, ungrouped)).errors).toContain('INDEPENDENCE_GROUP_MISSING:reviewer')

    const custodians = await fixture('custodian-handoff')
    const shared: DrillRoster = {
      ...custodians.roster,
      entries: custodians.roster.entries.map((entry) => entry.roles.includes('custodian')
        ? { ...entry, independenceGroup: 'same-person' } : entry),
    }
    expect((await verify(custodians, custodians.record, shared)).errors).toContain('INDEPENDENCE_GROUP_SHARED:custodian')
  })

  it('rejects a record bound to a different commit', async () => {
    const input = await fixture('alert', { commit: OTHER_COMMIT })
    const result = await verify(input)
    expect(result.valid).toBe(false)
    expect(result.errors).toEqual([`COMMIT_MISMATCH:${OTHER_COMMIT}!=${COMMIT}`])
    expect(await verifyDrillRecord(input.record, {
      roster: input.roster, artifactsRoot: input.directory, now: NOW,
    })).toMatchObject({ valid: true })
  })

  it('rejects artifacts whose content, size, location or type changed', async () => {
    const input = await fixture('alert')
    await writeFile(join(input.directory, 'alert-rules.txt'), 'artifact ALERT-RULES for alert\n' /* same length, different bytes */)
    expect((await verify(input)).errors).toContain('ARTIFACT_DIGEST_MISMATCH:alert-rules')

    await writeFile(join(input.directory, 'delivery-receipt.txt'), 'longer than before, different size entirely\n')
    expect((await verify(input)).errors).toContain('ARTIFACT_SIZE_MISMATCH:delivery-receipt')

    await rm(join(input.directory, 'metrics-baseline.txt'))
    expect((await verify(input)).errors).toContain('ARTIFACT_MISSING_FILE:metrics-baseline')

    const outside = await temporaryDirectory()
    await writeFile(join(outside, 'secret.txt'), 'x')
    await rm(join(input.directory, 'alert-rules.txt'))
    await symlink(join(outside, 'secret.txt'), join(input.directory, 'alert-rules.txt'))
    expect((await verify(input)).errors).toContain('ARTIFACT_NOT_REGULAR_FILE:alert-rules')
  })

  it('rejects unsafe artifact paths at parse time and requires every named artifact', async () => {
    const input = await fixture('alert')
    for (const path of ['../escape.txt', '/etc/passwd', 'a\\b', 'a//b', './x']) {
      const record = { ...input.record, artifacts: input.record.artifacts.map((artifact, index) => index === 0 ? { ...artifact, path } : artifact) }
      const result = await verify(input, record)
      expect(result.valid, path).toBe(false)
      expect(result.errors.some((error) => error.startsWith('ARTIFACT_PATH_UNSAFE')), path).toBe(true)
    }
    const fewer = { ...input.record, artifacts: input.record.artifacts.slice(1) }
    expect((await verify(input, fewer)).errors).toContain(`ARTIFACT_MISSING:${input.record.artifacts[0]!.name}`)
  })

  it('rejects failed, missing and duplicated checks', async () => {
    const input = await fixture('alert')
    const failed = { ...input.record, checks: input.record.checks.map((check, index) => index === 0 ? { ...check, passed: false } : check) }
    expect((await verify(input, failed)).errors).toContain(`CHECK_FAILED:${input.record.checks[0]!.id}`)
    const fewer = { ...input.record, checks: input.record.checks.slice(1) }
    expect((await verify(input, fewer)).errors).toContain(`CHECK_MISSING:${input.record.checks[0]!.id}`)
    const duplicated = { ...input.record, checks: [...input.record.checks, input.record.checks[0]!] }
    expect((await verify(input, duplicated)).errors).toContain(`CHECK_DUPLICATE:${input.record.checks[0]!.id}`)
  })

  it('rejects impossible timestamps and malformed records without throwing', async () => {
    const input = await fixture('alert')
    const reversed = { ...input.record, startedAt: input.record.completedAt, completedAt: input.record.startedAt }
    expect((await verify(input, reversed)).errors).toContain('TIMESTAMP_ORDER_INVALID')
    const future = await verifyDrillRecord(input.record, {
      roster: input.roster, artifactsRoot: input.directory, now: new Date('2026-04-01T00:00:00Z'),
    })
    expect(future.errors).toContain('TIMESTAMP_IN_FUTURE')

    for (const garbage of [null, 'text', [], {}, { ...input.record, extra: 1 }, { ...input.record, kind: 'nope' }]) {
      expect((await verify(input, garbage)).valid).toBe(false)
    }
  })

  it('applies the kind-specific cross-checks', async () => {
    const upgrade = await fixture('upgrade')
    const same = { ...upgrade.record, details: { previousCommit: COMMIT } }
    expect((await verify(upgrade, same)).errors).toContain('UPGRADE_NOT_CROSS_VERSION')
    const review = await fixture('external-review')
    const wrongDigest = { ...review.record, details: { packetManifestSha256: 'c'.repeat(64) } }
    expect((await verify(review, wrongDigest)).errors).toContain('REVIEW_PACKET_DIGEST_MISMATCH')
  })

  it('rejects keys whose fingerprint does not match', () => {
    expect(() => parseDrillKey({ format: 'chronolog-drill-key-v1', publicKey: 'AA', fingerprint: 'x', pkcs8: 'y' })).toThrow('DRILL_KEY_INVALID')
    expect(() => parseDrillKey(null)).toThrow('DRILL_KEY_INVALID')
  })
})

describe('drill evidence gate', () => {
  async function evidenceTree(): Promise<{ root: string; roster: DrillRoster; entries: RosterEntry[] }> {
    return { root: await temporaryDirectory(), roster: { format: DRILL_ROSTER_FORMAT, entries: [] }, entries: [] }
  }

  async function install(root: string, kind: DrillKind, entries: RosterEntry[], options: { commit?: string } = {}): Promise<Fixture> {
    const input = await fixture(kind, options)
    const target = join(root, kind)
    await mkdir(target, { recursive: true })
    for (const artifact of input.record.artifacts) {
      await writeFile(join(target, artifact.path), await readFile(join(input.directory, artifact.path)))
    }
    await writeFile(join(target, `${kind}.drill.json`), JSON.stringify(input.record))
    entries.push(...input.roster.entries)
    return input
  }

  const gate = (root: string | null, entries: readonly RosterEntry[]) => evaluateGate({
    commit: COMMIT, roster: { format: DRILL_ROSTER_FORMAT, entries }, rosterSha256: 'd'.repeat(64),
    evidenceDirectory: root, now: NOW,
  })

  it('reports every drill MISSING when there is no evidence', async () => {
    const report = await gate(null, [])
    expect(report.satisfied).toBe(false)
    expect(report.items).toHaveLength(DRILL_KINDS.length)
    expect(report.items.every((item) => item.status === 'missing')).toBe(true)
    expect(renderGate(report)).toContain('Gate NOT satisfied')

    const { root } = await evidenceTree()
    expect((await gate(root, [])).satisfied).toBe(false)
  })

  it('marks only the drills with valid evidence as satisfied', async () => {
    const { root, entries } = await evidenceTree()
    await install(root, 'alert', entries)
    const report = await gate(root, entries)
    expect(report.satisfied).toBe(false)
    expect(report.items.find((item) => item.kind === 'alert')?.status).toBe('satisfied')
    expect(report.items.filter((item) => item.status === 'missing')).toHaveLength(DRILL_KINDS.length - 1)
    expect(renderGate(report)).toContain('SATISFIED')
  })

  it('is satisfied only when every drill kind has valid evidence', async () => {
    const { root, entries } = await evidenceTree()
    for (const kind of DRILL_KINDS) await install(root, kind, entries)
    const report = await gate(root, entries)
    expect(report.items.map((item) => item.status)).toEqual(DRILL_KINDS.map(() => 'satisfied'))
    expect(report.satisfied).toBe(true)
  })

  it('does not accept evidence for another commit, with a changed artifact, or an unreadable file', async () => {
    const { root, entries } = await evidenceTree()
    await install(root, 'alert', entries, { commit: OTHER_COMMIT })
    const input = await install(root, 'traversal', entries)
    await writeFile(join(root, 'traversal', input.record.artifacts[0]!.path), 'tampered')
    await writeFile(join(root, 'broken.drill.json'), '{ not json')
    const report = await gate(root, entries)
    expect(report.satisfied).toBe(false)
    expect(report.items.find((item) => item.kind === 'alert')?.status).toBe('invalid')
    expect(report.items.find((item) => item.kind === 'traversal')?.status).toBe('invalid')
    expect(report.unreadable).toEqual([{ file: 'broken.drill.json', errors: ['RECORD_UNREADABLE'] }])
  })

  it('does not let a valid record satisfy the gate under a different roster', async () => {
    const { root, entries } = await evidenceTree()
    await install(root, 'alert', entries)
    const report = await gate(root, [])
    expect(report.items.find((item) => item.kind === 'alert')?.status).toBe('invalid')
  })
})

describe('drill CLI', () => {
  it('runs keygen, record, sign, verify and gate end to end', async () => {
    const directory = await temporaryDirectory()
    const bundle = join(directory, 'bundle')
    await mkdir(bundle)
    await writeFile(join(bundle, 'alert-rules.txt'), 'rules')
    await writeFile(join(bundle, 'delivery-receipt.txt'), 'receipt')
    await writeFile(join(bundle, 'metrics-baseline.txt'), 'metrics')
    const drill = async (...args: string[]) => run(process.execPath, ['--import', 'tsx', 'tools/drill.ts', ...args], { cwd: process.cwd() })

    const keys: { fingerprint: string; publicKey: string }[] = []
    for (const name of ['operator', 'responder']) {
      const { stdout } = await drill('keygen', '--out', join(directory, `${name}.key.json`))
      keys.push(JSON.parse(stdout) as { fingerprint: string; publicKey: string })
    }
    const roster = {
      format: DRILL_ROSTER_FORMAT,
      entries: [
        { fingerprint: keys[0]!.fingerprint, roles: ['operator'] },
        { fingerprint: keys[1]!.fingerprint, roles: ['responder'] },
      ],
    }
    await writeFile(join(directory, 'roster.json'), JSON.stringify(roster))
    const spec = DRILL_SPECS.alert
    await drill(
      'record', '--kind', 'alert', '--dir', bundle, '--commit', COMMIT,
      '--started', '2026-05-01T10:00:00Z', '--completed', '2026-05-01T11:00:00Z',
      '--participant', `operator=${keys[0]!.publicKey}`, '--participant', `responder=${keys[1]!.publicKey}`,
      '--env', 'os=linux', '--env', 'node=22',
      ...spec.checks.flatMap((id) => ['--check', id]),
      ...spec.artifacts.flatMap((name) => ['--artifact', `${name}=${name}.txt`]),
    )
    const recordPath = join(bundle, 'alert.drill.json')
    const verifyArgs = ['verify', '--record', recordPath, '--roster', join(directory, 'roster.json'), '--commit', COMMIT]

    await expect(drill(...verifyArgs)).rejects.toMatchObject({ code: 1 })
    await drill('sign', '--record', recordPath, '--key', join(directory, 'operator.key.json'))
    await expect(drill(...verifyArgs)).rejects.toMatchObject({ code: 1 })
    await drill('sign', '--record', recordPath, '--key', join(directory, 'responder.key.json'))
    const verified = JSON.parse((await drill(...verifyArgs)).stdout) as { event: string; errors: string[] }
    expect(verified).toMatchObject({ event: 'chronolog.drill_record_valid', errors: [] })

    await expect(drill('verify', '--record', recordPath, '--roster', join(directory, 'roster.json'), '--commit', OTHER_COMMIT))
      .rejects.toMatchObject({ code: 1 })
    const gateRun = drill('gate', '--roster', join(directory, 'roster.json'), '--evidence', directory, '--commit', COMMIT, '--json')
    await expect(gateRun).rejects.toMatchObject({ code: 1 })
  }, 120_000)
})
