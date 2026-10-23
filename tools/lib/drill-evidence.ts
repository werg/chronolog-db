import { lstat, readdir, readFile, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'

import {
  DOMAINS,
  encodeCanonicalCbor,
  generateEd25519KeyPair,
  importEd25519PrivateKey,
  exportEd25519PrivateKey,
  signDomain,
  verifyDomain,
  type CborValue,
} from '@chronolog/protocol'

import { COMMIT_PATTERN, fileSha256, isRecord, SHA256_PATTERN, sha256Hex, stableJson } from './common.js'

export const DRILL_RECORD_FORMAT = 'chronolog-drill-record-v1'
export const DRILL_ROSTER_FORMAT = 'chronolog-drill-roster-v1'
export const DRILL_KEY_FORMAT = 'chronolog-drill-key-v1'
export const DRILL_RECORD_SUFFIX = '.drill.json'

export const DRILL_KINDS = [
  'custodian-handoff',
  'snapshot-repair',
  'multi-host-blob',
  'traversal',
  'alert',
  'upgrade',
  'external-review',
] as const
export type DrillKind = (typeof DRILL_KINDS)[number]

export interface RoleSpec {
  /** Minimum number of distinct participants holding the role. */
  readonly min: number
  /** Roster independence groups must all differ within this role. */
  readonly distinctGroups?: boolean
  /** Groups of this role must differ from the groups of every listed role. */
  readonly independentOf?: readonly string[]
}

export interface DrillSpec {
  readonly kind: DrillKind
  readonly title: string
  readonly findings: readonly string[]
  /** Where the requirement is stated, for the gate report. */
  readonly references: readonly string[]
  readonly roles: Readonly<Record<string, RoleSpec>>
  readonly environment: readonly string[]
  readonly details: readonly string[]
  readonly checks: readonly string[]
  readonly artifacts: readonly string[]
}

const BASE_ENVIRONMENT = ['os', 'node'] as const

export const DRILL_SPECS: Readonly<Record<DrillKind, DrillSpec>> = {
  'custodian-handoff': {
    kind: 'custodian-handoff',
    title: 'Independent-custodian recovery handoff and two-person drill',
    findings: ['SEC-001'],
    references: ['docs/security-threat-review.md SEC-001', 'docs/governance.md', 'docs/pilot-runbook.md (custody drill)'],
    roles: { operator: { min: 1 }, custodian: { min: 3, distinctGroups: true } },
    environment: BASE_ENVIRONMENT,
    details: [],
    checks: [
      'shares_exported_and_verified',
      'shares_purged_from_daemon_store',
      'payload_inspected_by_all_custodians',
      'two_custodian_offline_signing',
      'combine_and_verify_on_public_host',
      'no_private_share_in_evidence',
    ],
    artifacts: ['recovery-payload', 'combined-recovery-verification'],
  },
  'snapshot-repair': {
    kind: 'snapshot-repair',
    title: 'Packaged snapshot restore and synthetic fork repair drill',
    findings: ['SEC-003', 'SEC-004'],
    references: ['docs/security-threat-review.md SEC-003, SEC-004', 'docs/snapshot-recovery.md', 'docs/pilot-runbook.md (backup, restore, fork)'],
    roles: { operator: { min: 1 }, reviewer: { min: 1, independentOf: ['operator'] } },
    environment: [...BASE_ENVIRONMENT, 'filesystem', 'storageClass'],
    details: [],
    checks: [
      'snapshot_exported_signed',
      'restore_on_disposable_host',
      'signer_confirmed_independently',
      'doctor_healthy_after_restore',
      'catalog_and_queries_compared',
      'fork_repair_executed',
      'losing_branch_discarded',
      'quarantine_cleared_after_repair',
      'rebuild_diagnostics_retained',
    ],
    artifacts: ['snapshot-manifest', 'repair-plan', 'doctor-output', 'quarantine-evidence'],
  },
  'multi-host-blob': {
    kind: 'multi-host-blob',
    title: 'Cache-miss multi-host blob fetch and retention drill',
    findings: ['SEC-002'],
    references: ['docs/security-threat-review.md SEC-002', 'docs/blob-replication.md', 'docs/pilot-runbook.md (blob loss)'],
    roles: { operator: { min: 1 }, host: { min: 2 } },
    environment: BASE_ENVIRONMENT,
    details: [],
    checks: [
      'cache_miss_remote_fetch',
      'digest_verified_before_retention',
      'chunks_retained_locally',
      'tampered_peer_response_rejected',
      'unauthenticated_fetch_rejected',
      'no_automatic_gc_observed',
    ],
    artifacts: ['blob-manifest', 'fetch-log', 'metrics-baseline'],
  },
  traversal: {
    kind: 'traversal',
    title: 'Externally verified public-address traversal drill',
    findings: ['SEC-005'],
    references: ['docs/security-threat-review.md SEC-005', 'docs/pilot-runbook.md (public SSB)'],
    roles: { operator: { min: 1 }, vantage: { min: 1, independentOf: ['operator'] } },
    environment: BASE_ENVIRONMENT,
    details: [],
    checks: [
      'external_handshake_succeeded',
      'observed_server_key_matches',
      'health_degraded_without_proof',
      'health_ok_with_proof',
      'mapping_and_verifier_monitored',
    ],
    artifacts: ['verifier-response', 'health-before', 'health-after'],
  },
  alert: {
    kind: 'alert',
    title: 'Alert delivery drill',
    findings: [],
    references: ['docs/pilot-runbook.md (capacity and alerting)', 'upcoming.md Project 10 (alert drill)'],
    roles: { operator: { min: 1 }, responder: { min: 1 } },
    environment: BASE_ENVIRONMENT,
    details: [],
    checks: [
      'alert_rules_deployed',
      'synthetic_fault_fired',
      'alert_delivered_to_responder',
      'alert_acknowledged',
      'alert_cleared_after_recovery',
    ],
    artifacts: ['alert-rules', 'delivery-receipt', 'metrics-baseline'],
  },
  upgrade: {
    kind: 'upgrade',
    title: 'Previous-release-to-candidate upgrade drill',
    findings: ['SEC-006'],
    references: ['docs/security-threat-review.md SEC-006', 'docs/release-hardening.md', 'docs/pilot-runbook.md (upgrade)'],
    roles: { operator: { min: 1 } },
    environment: BASE_ENVIRONMENT,
    details: ['previousCommit'],
    checks: [
      'previous_release_verified',
      'candidate_verified',
      'identities_stable',
      'replication_converged',
      'migration_status_ok',
      'canary_accepted',
    ],
    artifacts: ['previous-archive', 'candidate-archive', 'upgrade-drill-output', 'doctor-output'],
  },
  'external-review': {
    kind: 'external-review',
    title: 'Independent external security review of the release candidate',
    findings: ['SEC-008'],
    references: ['docs/security-threat-review.md SEC-008 and Review gate', 'upcoming.md Project 10'],
    roles: { operator: { min: 1 }, 'external-reviewer': { min: 1, distinctGroups: true, independentOf: ['operator'] } },
    environment: BASE_ENVIRONMENT,
    details: ['packetManifestSha256'],
    checks: [
      'packet_verified_by_reviewer',
      'report_delivered',
      'no_unresolved_release_blocking_findings',
    ],
    artifacts: ['review-packet-manifest', 'review-report'],
  },
}

export interface GateItem {
  readonly kind: DrillKind
  readonly title: string
  readonly findings: readonly string[]
  readonly references: readonly string[]
}

export const GATE_ITEMS: readonly GateItem[] = DRILL_KINDS.map((kind) => ({
  kind,
  title: DRILL_SPECS[kind].title,
  findings: DRILL_SPECS[kind].findings,
  references: DRILL_SPECS[kind].references,
}))

export interface DrillParticipant {
  readonly role: string
  readonly publicKey: string
  readonly fingerprint: string
}

export interface DrillCheck {
  readonly id: string
  readonly passed: boolean
  readonly note?: string
}

export interface DrillArtifact {
  readonly name: string
  readonly path: string
  readonly sha256: string
  readonly bytes: number
}

export interface DrillBody {
  readonly format: typeof DRILL_RECORD_FORMAT
  readonly kind: DrillKind
  readonly commit: string
  readonly startedAt: string
  readonly completedAt: string
  readonly environment: Readonly<Record<string, string>>
  readonly details: Readonly<Record<string, string>>
  readonly participants: readonly DrillParticipant[]
  readonly checks: readonly DrillCheck[]
  readonly artifacts: readonly DrillArtifact[]
}

export interface DrillSignature {
  readonly fingerprint: string
  readonly signature: string
}

export interface DrillRecord extends DrillBody {
  readonly signatures: readonly DrillSignature[]
}

export interface RosterEntry {
  readonly fingerprint: string
  readonly roles: readonly string[]
  readonly independenceGroup?: string
}

export interface DrillRoster {
  readonly format: typeof DRILL_ROSTER_FORMAT
  readonly entries: readonly RosterEntry[]
}

export interface DrillKeyFile {
  readonly format: typeof DRILL_KEY_FORMAT
  readonly publicKey: string
  readonly fingerprint: string
  readonly pkcs8: string
}

const LIMITS = {
  text: 512,
  entries: 64,
  participants: 32,
  environment: 16,
  artifactBytes: 64 * 1024 ** 3,
} as const
const IDENTIFIER = /^[a-z][a-z0-9_-]{0,63}$/
const DETAIL_KEY = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/
const CLOCK_SKEW_MS = 5 * 60_000

export function fingerprintOf(publicKey: Uint8Array): string {
  return sha256Hex(publicKey)
}

export function encodeBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url')
}

export function decodeBase64Url(value: string, length: number): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null
  const bytes = new Uint8Array(Buffer.from(value, 'base64url'))
  if (bytes.length !== length || encodeBase64Url(bytes) !== value) return null
  return bytes
}

function normalizeTimestamp(value: string): number | null {
  if (!TIMESTAMP.test(value)) return null
  const time = Date.parse(value)
  return Number.isNaN(time) ? null : time
}

// ---------------------------------------------------------------- parsing

export interface ParseResult<T> {
  readonly value: T | null
  readonly errors: readonly string[]
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], context: string, errors: string[]): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) errors.push(`UNKNOWN_FIELD:${context}.${key}`)
  }
}

function text(value: unknown, context: string, errors: string[], pattern?: RegExp): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > LIMITS.text) {
    errors.push(`FIELD_INVALID:${context}`)
    return null
  }
  if (pattern !== undefined && !pattern.test(value)) {
    errors.push(`FIELD_INVALID:${context}`)
    return null
  }
  return value
}

function stringMap(value: unknown, context: string, errors: string[], maxEntries: number): Record<string, string> | null {
  if (!isRecord(value) || Object.keys(value).length > maxEntries) {
    errors.push(`FIELD_INVALID:${context}`)
    return null
  }
  const result: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (!DETAIL_KEY.test(key)) errors.push(`FIELD_INVALID:${context}.${key}`)
    const parsed = text(entry, `${context}.${key}`, errors)
    if (parsed !== null) result[key] = parsed
  }
  return result
}

export function parseDrillBody(input: unknown, extraKeys: readonly string[] = []): ParseResult<DrillBody> {
  const errors: string[] = []
  if (!isRecord(input)) return { value: null, errors: ['RECORD_NOT_OBJECT'] }
  exactKeys(input, [
    'format', 'kind', 'commit', 'startedAt', 'completedAt', 'environment', 'details',
    'participants', 'checks', 'artifacts', ...extraKeys,
  ], 'record', errors)
  if (input.format !== DRILL_RECORD_FORMAT) errors.push('FORMAT_UNSUPPORTED')
  const kind = DRILL_KINDS.find((candidate) => candidate === input.kind)
  if (kind === undefined) errors.push('KIND_UNKNOWN')
  const commit = text(input.commit, 'commit', errors, COMMIT_PATTERN)
  const startedAt = text(input.startedAt, 'startedAt', errors, TIMESTAMP)
  const completedAt = text(input.completedAt, 'completedAt', errors, TIMESTAMP)
  const environment = stringMap(input.environment, 'environment', errors, LIMITS.environment)
  const details = stringMap(input.details, 'details', errors, LIMITS.environment)

  const participants: DrillParticipant[] = []
  if (!Array.isArray(input.participants) || input.participants.length > LIMITS.participants) {
    errors.push('FIELD_INVALID:participants')
  } else {
    input.participants.forEach((entry: unknown, index) => {
      const context = `participants[${index}]`
      if (!isRecord(entry)) { errors.push(`FIELD_INVALID:${context}`); return }
      exactKeys(entry, ['role', 'publicKey', 'fingerprint'], context, errors)
      const role = text(entry.role, `${context}.role`, errors, IDENTIFIER)
      const publicKey = text(entry.publicKey, `${context}.publicKey`, errors)
      const fingerprint = text(entry.fingerprint, `${context}.fingerprint`, errors, SHA256_PATTERN)
      if (role !== null && publicKey !== null && fingerprint !== null) participants.push({ role, publicKey, fingerprint })
    })
  }

  const checks: DrillCheck[] = []
  if (!Array.isArray(input.checks) || input.checks.length > LIMITS.entries) {
    errors.push('FIELD_INVALID:checks')
  } else {
    input.checks.forEach((entry: unknown, index) => {
      const context = `checks[${index}]`
      if (!isRecord(entry)) { errors.push(`FIELD_INVALID:${context}`); return }
      exactKeys(entry, ['id', 'passed', 'note'], context, errors)
      const id = text(entry.id, `${context}.id`, errors, IDENTIFIER)
      if (typeof entry.passed !== 'boolean') errors.push(`FIELD_INVALID:${context}.passed`)
      const note = entry.note === undefined ? undefined : text(entry.note, `${context}.note`, errors)
      if (id !== null && typeof entry.passed === 'boolean') {
        checks.push({ id, passed: entry.passed, ...(note === undefined || note === null ? {} : { note }) })
      }
    })
  }

  const artifacts: DrillArtifact[] = []
  if (!Array.isArray(input.artifacts) || input.artifacts.length > LIMITS.entries) {
    errors.push('FIELD_INVALID:artifacts')
  } else {
    input.artifacts.forEach((entry: unknown, index) => {
      const context = `artifacts[${index}]`
      if (!isRecord(entry)) { errors.push(`FIELD_INVALID:${context}`); return }
      exactKeys(entry, ['name', 'path', 'sha256', 'bytes'], context, errors)
      const name = text(entry.name, `${context}.name`, errors, IDENTIFIER)
      const path = text(entry.path, `${context}.path`, errors)
      const sha256 = text(entry.sha256, `${context}.sha256`, errors, SHA256_PATTERN)
      const bytes = entry.bytes
      if (typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes < 0 || bytes > LIMITS.artifactBytes) {
        errors.push(`FIELD_INVALID:${context}.bytes`)
      }
      if (path !== null && !isSafeRelativePath(path)) errors.push(`ARTIFACT_PATH_UNSAFE:${context}`)
      if (name !== null && path !== null && sha256 !== null && typeof bytes === 'number') {
        artifacts.push({ name, path, sha256, bytes })
      }
    })
  }

  if (errors.length > 0 || kind === undefined || commit === null || startedAt === null || completedAt === null ||
    environment === null || details === null) {
    return { value: null, errors }
  }
  return {
    value: {
      format: DRILL_RECORD_FORMAT, kind, commit, startedAt, completedAt,
      environment, details, participants, checks, artifacts,
    },
    errors,
  }
}

export function isSafeRelativePath(path: string): boolean {
  if (path.length === 0 || isAbsolute(path) || path.includes('\\') || path.includes('\0')) return false
  return path.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..')
}

export function parseDrillRecord(input: unknown): ParseResult<DrillRecord> {
  const parsed = parseDrillBody(input, ['signatures'])
  const errors = [...parsed.errors]
  const signatures: DrillSignature[] = []
  const raw = isRecord(input) ? input.signatures : undefined
  if (!Array.isArray(raw) || raw.length > LIMITS.participants) {
    errors.push('FIELD_INVALID:signatures')
  } else {
    raw.forEach((entry: unknown, index) => {
      const context = `signatures[${index}]`
      if (!isRecord(entry)) { errors.push(`FIELD_INVALID:${context}`); return }
      exactKeys(entry, ['fingerprint', 'signature'], context, errors)
      const fingerprint = text(entry.fingerprint, `${context}.fingerprint`, errors, SHA256_PATTERN)
      const signature = text(entry.signature, `${context}.signature`, errors)
      if (fingerprint !== null && signature !== null) signatures.push({ fingerprint, signature })
    })
  }
  if (parsed.value === null || errors.length > 0) return { value: null, errors }
  return { value: { ...parsed.value, signatures }, errors }
}

export function parseRoster(input: unknown): ParseResult<DrillRoster> {
  const errors: string[] = []
  if (!isRecord(input)) return { value: null, errors: ['ROSTER_NOT_OBJECT'] }
  exactKeys(input, ['format', 'entries'], 'roster', errors)
  if (input.format !== DRILL_ROSTER_FORMAT) errors.push('ROSTER_FORMAT_UNSUPPORTED')
  const entries: RosterEntry[] = []
  const seen = new Set<string>()
  if (!Array.isArray(input.entries) || input.entries.length === 0 || input.entries.length > 256) {
    errors.push('FIELD_INVALID:roster.entries')
  } else {
    input.entries.forEach((entry: unknown, index) => {
      const context = `roster.entries[${index}]`
      if (!isRecord(entry)) { errors.push(`FIELD_INVALID:${context}`); return }
      exactKeys(entry, ['fingerprint', 'roles', 'independenceGroup'], context, errors)
      const fingerprint = text(entry.fingerprint, `${context}.fingerprint`, errors, SHA256_PATTERN)
      const group = entry.independenceGroup === undefined
        ? undefined : text(entry.independenceGroup, `${context}.independenceGroup`, errors, IDENTIFIER)
      const roles: string[] = []
      if (!Array.isArray(entry.roles) || entry.roles.length === 0 || entry.roles.length > 16) {
        errors.push(`FIELD_INVALID:${context}.roles`)
      } else {
        for (const role of entry.roles as unknown[]) {
          const parsed = text(role, `${context}.roles`, errors, IDENTIFIER)
          if (parsed !== null) roles.push(parsed)
        }
      }
      if (fingerprint !== null) {
        if (seen.has(fingerprint)) errors.push(`ROSTER_DUPLICATE:${fingerprint}`)
        seen.add(fingerprint)
        entries.push({ fingerprint, roles, ...(group === undefined || group === null ? {} : { independenceGroup: group }) })
      }
    })
  }
  if (errors.length > 0) return { value: null, errors }
  return { value: { format: DRILL_ROSTER_FORMAT, entries }, errors }
}

// ---------------------------------------------------------------- signing

export function bodyOf(record: DrillBody): DrillBody {
  return {
    format: record.format, kind: record.kind, commit: record.commit,
    startedAt: record.startedAt, completedAt: record.completedAt,
    environment: record.environment, details: record.details,
    participants: record.participants, checks: record.checks, artifacts: record.artifacts,
  }
}

function toCbor(value: unknown): CborValue {
  if (typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value)
  if (Array.isArray(value)) return value.map(toCbor)
  if (isRecord(value)) {
    return new Map(Object.entries(value).filter(([, entry]) => entry !== undefined).map(([key, entry]) => [key, toCbor(entry)]))
  }
  throw new Error('DRILL_ENCODING_INVALID')
}

/** Canonical bytes covered by every participant signature (domain separation is applied by signDomain). */
export function signedBytes(body: DrillBody): Uint8Array {
  return encodeCanonicalCbor(toCbor(bodyOf(body)))
}

export function recordDigest(record: DrillRecord): string {
  const signatures = [...record.signatures].sort((a, b) => a.fingerprint.localeCompare(b.fingerprint))
  return sha256Hex(stableJson({ ...bodyOf(record), signatures }))
}

export async function generateDrillKey(): Promise<DrillKeyFile> {
  const pair = await generateEd25519KeyPair(true)
  return {
    format: DRILL_KEY_FORMAT,
    publicKey: encodeBase64Url(pair.publicKeyBytes),
    fingerprint: fingerprintOf(pair.publicKeyBytes),
    pkcs8: encodeBase64Url(await exportEd25519PrivateKey(pair.privateKey)),
  }
}

export function parseDrillKey(input: unknown): DrillKeyFile {
  if (!isRecord(input) || input.format !== DRILL_KEY_FORMAT || typeof input.publicKey !== 'string' ||
    typeof input.fingerprint !== 'string' || typeof input.pkcs8 !== 'string') {
    throw new Error('DRILL_KEY_INVALID')
  }
  const publicKey = decodeBase64Url(input.publicKey, 32)
  if (publicKey === null || fingerprintOf(publicKey) !== input.fingerprint) throw new Error('DRILL_KEY_INVALID')
  return { format: DRILL_KEY_FORMAT, publicKey: input.publicKey, fingerprint: input.fingerprint, pkcs8: input.pkcs8 }
}

/** Adds the key holder's signature; the key must belong to a declared participant. */
export async function signDrillRecord(record: DrillRecord, key: DrillKeyFile): Promise<DrillRecord> {
  if (!record.participants.some((participant) => participant.fingerprint === key.fingerprint)) {
    throw new Error('DRILL_SIGNER_NOT_PARTICIPANT')
  }
  if (record.signatures.some((signature) => signature.fingerprint === key.fingerprint)) {
    throw new Error('DRILL_ALREADY_SIGNED')
  }
  const pkcs8 = Buffer.from(key.pkcs8, 'base64url')
  const privateKey = await importEd25519PrivateKey(new Uint8Array(pkcs8), false)
  const signature = await signDomain(DOMAINS.drillEvidence, signedBytes(record), privateKey)
  return { ...record, signatures: [...record.signatures, { fingerprint: key.fingerprint, signature: encodeBase64Url(signature) }] }
}

// -------------------------------------------------------------- verifying

export interface VerifyOptions {
  readonly roster: DrillRoster
  /** Directory against which artifact paths resolve; artifacts are always re-hashed. */
  readonly artifactsRoot: string
  /** When set, the record must bind exactly this commit. */
  readonly expectedCommit?: string
  readonly now?: Date
}

export interface VerifyResult {
  readonly valid: boolean
  readonly kind: DrillKind | null
  readonly commit: string | null
  readonly recordDigest: string | null
  readonly errors: readonly string[]
}

/** Offline, fail-closed verification. Any unexpected exception makes the record invalid. */
export async function verifyDrillRecord(input: unknown, options: VerifyOptions): Promise<VerifyResult> {
  try {
    return await verifyUnchecked(input, options)
  } catch (error) {
    return {
      valid: false, kind: null, commit: null, recordDigest: null,
      errors: [`INTERNAL:${error instanceof Error ? error.message : 'unknown'}`],
    }
  }
}

async function verifyUnchecked(input: unknown, options: VerifyOptions): Promise<VerifyResult> {
  const parsed = parseDrillRecord(input)
  if (parsed.value === null) {
    return { valid: false, kind: null, commit: null, recordDigest: null, errors: parsed.errors }
  }
  const record = parsed.value
  const spec = DRILL_SPECS[record.kind]
  const errors: string[] = []
  const now = (options.now ?? new Date()).getTime()

  if (options.expectedCommit !== undefined && record.commit !== options.expectedCommit) {
    errors.push(`COMMIT_MISMATCH:${record.commit}!=${options.expectedCommit}`)
  }
  const started = normalizeTimestamp(record.startedAt)
  const completed = normalizeTimestamp(record.completedAt)
  if (started === null || completed === null) errors.push('TIMESTAMP_INVALID')
  else {
    if (completed <= started) errors.push('TIMESTAMP_ORDER_INVALID')
    if (completed > now + CLOCK_SKEW_MS) errors.push('TIMESTAMP_IN_FUTURE')
  }

  for (const key of spec.environment) if (!(key in record.environment)) errors.push(`ENVIRONMENT_MISSING:${key}`)
  for (const key of spec.details) if (!(key in record.details)) errors.push(`DETAIL_MISSING:${key}`)
  for (const key of Object.keys(record.details)) if (!spec.details.includes(key)) errors.push(`DETAIL_UNEXPECTED:${key}`)

  // Participants: key binding, uniqueness, roster membership, role quotas.
  const keys = new Map<string, Uint8Array>()
  const rosterByFingerprint = new Map(options.roster.entries.map((entry) => [entry.fingerprint, entry]))
  const roleMembers = new Map<string, DrillParticipant[]>()
  for (const participant of record.participants) {
    const publicKey = decodeBase64Url(participant.publicKey, 32)
    if (publicKey === null) { errors.push(`PUBLIC_KEY_INVALID:${participant.fingerprint}`); continue }
    if (fingerprintOf(publicKey) !== participant.fingerprint) errors.push(`FINGERPRINT_MISMATCH:${participant.fingerprint}`)
    if (keys.has(participant.fingerprint)) errors.push(`PARTICIPANT_DUPLICATE:${participant.fingerprint}`)
    keys.set(participant.fingerprint, publicKey)
    if (!(participant.role in spec.roles)) errors.push(`ROLE_UNEXPECTED:${participant.role}`)
    const entry = rosterByFingerprint.get(participant.fingerprint)
    if (entry === undefined) errors.push(`ROSTER_UNKNOWN_PARTICIPANT:${participant.fingerprint}`)
    else if (!entry.roles.includes(participant.role)) errors.push(`ROSTER_ROLE_NOT_GRANTED:${participant.fingerprint}:${participant.role}`)
    roleMembers.set(participant.role, [...(roleMembers.get(participant.role) ?? []), participant])
  }
  const groupsOf = (role: string): readonly string[] => (roleMembers.get(role) ?? []).flatMap((participant) => {
    const group = rosterByFingerprint.get(participant.fingerprint)?.independenceGroup
    return group === undefined ? [] : [group]
  })
  for (const [role, roleSpec] of Object.entries(spec.roles)) {
    const members = roleMembers.get(role) ?? []
    if (members.length < roleSpec.min) errors.push(`ROLE_COUNT:${role}:${members.length}<${roleSpec.min}`)
    const needsGroups = roleSpec.distinctGroups === true || (roleSpec.independentOf?.length ?? 0) > 0
    if (needsGroups && members.length > 0) {
      const groups = groupsOf(role)
      if (groups.length !== members.length) errors.push(`INDEPENDENCE_GROUP_MISSING:${role}`)
      if (roleSpec.distinctGroups === true && new Set(groups).size !== groups.length) {
        errors.push(`INDEPENDENCE_GROUP_SHARED:${role}`)
      }
      for (const other of roleSpec.independentOf ?? []) {
        const otherGroups = new Set(groupsOf(other))
        if (otherGroups.size !== (roleMembers.get(other) ?? []).length) errors.push(`INDEPENDENCE_GROUP_MISSING:${other}`)
        if (groups.some((group) => otherGroups.has(group))) errors.push(`INDEPENDENCE_VIOLATED:${role}:${other}`)
      }
    }
  }

  // Signatures: exactly one valid signature from each participant, nothing else.
  const signed = new Set<string>()
  const payload = signedBytes(record)
  for (const signature of record.signatures) {
    const publicKey = keys.get(signature.fingerprint)
    if (publicKey === undefined) { errors.push(`SIGNATURE_UNKNOWN_SIGNER:${signature.fingerprint}`); continue }
    if (signed.has(signature.fingerprint)) { errors.push(`SIGNATURE_DUPLICATE:${signature.fingerprint}`); continue }
    const bytes = decodeBase64Url(signature.signature, 64)
    if (bytes === null || !(await verifyDomain(DOMAINS.drillEvidence, payload, bytes, publicKey))) {
      errors.push(`SIGNATURE_INVALID:${signature.fingerprint}`)
      continue
    }
    signed.add(signature.fingerprint)
  }
  for (const fingerprint of keys.keys()) if (!signed.has(fingerprint)) errors.push(`SIGNATURE_MISSING:${fingerprint}`)

  // Checks: every required check present exactly once and passed; no failed check anywhere.
  const checkIds = new Set<string>()
  for (const check of record.checks) {
    if (checkIds.has(check.id)) errors.push(`CHECK_DUPLICATE:${check.id}`)
    checkIds.add(check.id)
    if (!check.passed) errors.push(`CHECK_FAILED:${check.id}`)
  }
  for (const id of spec.checks) if (!checkIds.has(id)) errors.push(`CHECK_MISSING:${id}`)

  // Artifacts: required names present, digests recomputed from the bundle.
  const artifactNames = new Set<string>()
  for (const artifact of record.artifacts) {
    if (artifactNames.has(artifact.name)) errors.push(`ARTIFACT_DUPLICATE:${artifact.name}`)
    artifactNames.add(artifact.name)
    errors.push(...await verifyArtifact(artifact, options.artifactsRoot))
  }
  for (const name of spec.artifacts) if (!artifactNames.has(name)) errors.push(`ARTIFACT_MISSING:${name}`)

  errors.push(...kindSpecificErrors(record))

  return {
    valid: errors.length === 0,
    kind: record.kind,
    commit: record.commit,
    recordDigest: recordDigest(record),
    errors,
  }
}

function kindSpecificErrors(record: DrillRecord): string[] {
  const errors: string[] = []
  const artifact = (name: string): DrillArtifact | undefined => record.artifacts.find((entry) => entry.name === name)
  if (record.kind === 'upgrade') {
    const previous = record.details.previousCommit
    if (previous === undefined || !COMMIT_PATTERN.test(previous)) errors.push('UPGRADE_PREVIOUS_COMMIT_INVALID')
    else if (previous === record.commit) errors.push('UPGRADE_NOT_CROSS_VERSION')
    const previousArchive = artifact('previous-archive')
    const candidateArchive = artifact('candidate-archive')
    if (previousArchive !== undefined && candidateArchive !== undefined && previousArchive.sha256 === candidateArchive.sha256) {
      errors.push('UPGRADE_NOT_CROSS_VERSION')
    }
  }
  if (record.kind === 'external-review') {
    const manifest = artifact('review-packet-manifest')
    const claimed = record.details.packetManifestSha256
    if (claimed === undefined || !SHA256_PATTERN.test(claimed)) errors.push('REVIEW_PACKET_DIGEST_INVALID')
    else if (manifest !== undefined && manifest.sha256 !== claimed) errors.push('REVIEW_PACKET_DIGEST_MISMATCH')
  }
  return errors
}

async function verifyArtifact(artifact: DrillArtifact, root: string): Promise<string[]> {
  if (!isSafeRelativePath(artifact.path)) return [`ARTIFACT_PATH_UNSAFE:${artifact.name}`]
  const base = resolve(root)
  const path = resolve(base, ...artifact.path.split('/'))
  try {
    const stat = await lstat(path)
    if (stat.isSymbolicLink() || !stat.isFile()) return [`ARTIFACT_NOT_REGULAR_FILE:${artifact.name}`]
    const [realBase, realPath] = await Promise.all([realpath(base), realpath(path)])
    if (!realPath.startsWith(realBase + sep)) return [`ARTIFACT_PATH_ESCAPES:${artifact.name}`]
    if (stat.size !== artifact.bytes) return [`ARTIFACT_SIZE_MISMATCH:${artifact.name}`]
    if (await fileSha256(path) !== artifact.sha256) return [`ARTIFACT_DIGEST_MISMATCH:${artifact.name}`]
    return []
  } catch {
    return [`ARTIFACT_MISSING_FILE:${artifact.name}`]
  }
}

// ------------------------------------------------------------------ gate

export type GateStatus = 'satisfied' | 'missing' | 'invalid'

export interface GateItemReport {
  readonly kind: DrillKind
  readonly title: string
  readonly findings: readonly string[]
  readonly references: readonly string[]
  readonly status: GateStatus
  readonly satisfiedBy: readonly { readonly file: string; readonly recordDigest: string }[]
  readonly rejected: readonly { readonly file: string; readonly errors: readonly string[] }[]
}

export interface GateReport {
  readonly format: 'chronolog-drill-gate-v1'
  readonly commit: string
  readonly rosterSha256: string
  readonly satisfied: boolean
  readonly items: readonly GateItemReport[]
  readonly unreadable: readonly { readonly file: string; readonly errors: readonly string[] }[]
}

export interface GateOptions {
  readonly commit: string
  readonly roster: DrillRoster
  readonly rosterSha256: string
  /** Directory scanned (recursively) for `*.drill.json`; null means no evidence exists. */
  readonly evidenceDirectory: string | null
  readonly now?: Date
}

async function findRecords(directory: string): Promise<string[]> {
  const found: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) found.push(...await findRecords(path))
    else if (entry.isFile() && entry.name.endsWith(DRILL_RECORD_SUFFIX)) found.push(path)
  }
  return found.sort()
}

/** Reports, per required drill, whether a fully valid record for the exact commit exists. */
export async function evaluateGate(options: GateOptions): Promise<GateReport> {
  const files = options.evidenceDirectory === null ? [] : await findRecords(options.evidenceDirectory)
  const root = options.evidenceDirectory
  const byKind = new Map<DrillKind, { satisfiedBy: { file: string; recordDigest: string }[]; rejected: { file: string; errors: readonly string[] }[] }>()
  for (const kind of DRILL_KINDS) byKind.set(kind, { satisfiedBy: [], rejected: [] })
  const unreadable: { file: string; errors: readonly string[] }[] = []

  for (const path of files) {
    const file = root === null ? path : path.slice(resolve(root).length + 1).split(sep).join('/')
    let raw: unknown
    try { raw = JSON.parse(await readFile(path, 'utf8')) } catch {
      unreadable.push({ file, errors: ['RECORD_UNREADABLE'] })
      continue
    }
    const result = await verifyDrillRecord(raw, {
      roster: options.roster,
      artifactsRoot: dirname(path),
      expectedCommit: options.commit,
      ...(options.now === undefined ? {} : { now: options.now }),
    })
    if (result.kind === null) { unreadable.push({ file, errors: result.errors }); continue }
    const bucket = byKind.get(result.kind)
    if (bucket === undefined) continue
    if (result.valid && result.recordDigest !== null) bucket.satisfiedBy.push({ file, recordDigest: result.recordDigest })
    else bucket.rejected.push({ file, errors: result.errors })
  }

  const items = GATE_ITEMS.map((item): GateItemReport => {
    const bucket = byKind.get(item.kind) ?? { satisfiedBy: [], rejected: [] }
    const status: GateStatus = bucket.satisfiedBy.length > 0 ? 'satisfied'
      : bucket.rejected.length > 0 ? 'invalid' : 'missing'
    return { ...item, status, satisfiedBy: bucket.satisfiedBy, rejected: bucket.rejected }
  })
  return {
    format: 'chronolog-drill-gate-v1',
    commit: options.commit,
    rosterSha256: options.rosterSha256,
    satisfied: items.every((item) => item.status === 'satisfied'),
    items,
    unreadable,
  }
}

export function renderGate(report: GateReport): string {
  const lines = [`Release drill gate for ${report.commit} (roster sha256 ${report.rosterSha256})`]
  for (const item of report.items) {
    const findings = item.findings.length === 0 ? '' : ` [${item.findings.join(', ')}]`
    lines.push(`  ${item.status.toUpperCase().padEnd(9)} ${item.kind}${findings} - ${item.title}`)
    for (const entry of item.satisfiedBy) lines.push(`      evidence ${entry.file} ${entry.recordDigest}`)
    for (const entry of item.rejected) lines.push(`      rejected ${entry.file}: ${entry.errors.join(', ')}`)
  }
  for (const entry of report.unreadable) lines.push(`  UNREADABLE ${entry.file}: ${entry.errors.join(', ')}`)
  lines.push(report.satisfied
    ? 'All drill evidence is present and valid. This does not replace human review of the evidence.'
    : 'Gate NOT satisfied: missing or invalid evidence remains.')
  return lines.join('\n')
}

// ---------------------------------------------------------------- schema

/** JSON Schema describing the structural contract; verification code remains authoritative. */
export function drillRecordJsonSchema(): Record<string, unknown> {
  const stringMapSchema = { type: 'object', maxProperties: LIMITS.environment, additionalProperties: { type: 'string', minLength: 1, maxLength: LIMITS.text } }
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://chronolog.dev/schemas/drill-record-v1.json',
    title: DRILL_RECORD_FORMAT,
    type: 'object',
    additionalProperties: false,
    required: ['format', 'kind', 'commit', 'startedAt', 'completedAt', 'environment', 'details', 'participants', 'checks', 'artifacts', 'signatures'],
    properties: {
      format: { const: DRILL_RECORD_FORMAT },
      kind: { enum: [...DRILL_KINDS] },
      commit: { type: 'string', pattern: COMMIT_PATTERN.source },
      startedAt: { type: 'string', pattern: TIMESTAMP.source },
      completedAt: { type: 'string', pattern: TIMESTAMP.source },
      environment: stringMapSchema,
      details: stringMapSchema,
      participants: {
        type: 'array', maxItems: LIMITS.participants,
        items: {
          type: 'object', additionalProperties: false, required: ['role', 'publicKey', 'fingerprint'],
          properties: {
            role: { type: 'string', pattern: IDENTIFIER.source },
            publicKey: { type: 'string', description: 'Ed25519 raw public key, base64url' },
            fingerprint: { type: 'string', pattern: SHA256_PATTERN.source, description: 'hex SHA-256 of the raw public key' },
          },
        },
      },
      checks: {
        type: 'array', maxItems: LIMITS.entries,
        items: {
          type: 'object', additionalProperties: false, required: ['id', 'passed'],
          properties: {
            id: { type: 'string', pattern: IDENTIFIER.source },
            passed: { type: 'boolean' },
            note: { type: 'string', maxLength: LIMITS.text },
          },
        },
      },
      artifacts: {
        type: 'array', maxItems: LIMITS.entries,
        items: {
          type: 'object', additionalProperties: false, required: ['name', 'path', 'sha256', 'bytes'],
          properties: {
            name: { type: 'string', pattern: IDENTIFIER.source },
            path: { type: 'string', description: 'relative POSIX path inside the evidence bundle' },
            sha256: { type: 'string', pattern: SHA256_PATTERN.source },
            bytes: { type: 'integer', minimum: 0 },
          },
        },
      },
      signatures: {
        type: 'array', maxItems: LIMITS.participants,
        items: {
          type: 'object', additionalProperties: false, required: ['fingerprint', 'signature'],
          properties: {
            fingerprint: { type: 'string', pattern: SHA256_PATTERN.source },
            signature: { type: 'string', description: 'Ed25519 signature (base64url) over domain chronolog/drill-evidence/v1 and the canonical CBOR of the record without signatures' },
          },
        },
      },
    },
    'x-chronolog-kinds': Object.fromEntries(DRILL_KINDS.map((kind) => {
      const spec = DRILL_SPECS[kind]
      return [kind, {
        title: spec.title,
        findings: spec.findings,
        roles: spec.roles,
        environment: spec.environment,
        details: spec.details,
        checks: spec.checks,
        artifacts: spec.artifacts,
      }]
    })),
  }
}
