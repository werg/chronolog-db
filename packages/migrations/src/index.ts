import { createHash } from 'node:crypto'

import type {
  ChronologClient,
  CompiledSqlStatement,
  LiveQueryValue,
  RevisionMetadata,
  SettlementEvidence,
  StreamResource,
  TransactionOutcome,
} from '@chronolog/client'

export const APPLICATION_MIGRATION_TABLE = 'application_migrations' as const

export interface MigrationDefinition {
  readonly component: string
  readonly id: string
  readonly version: number
  readonly checksum: string
  readonly statements: readonly CompiledSqlStatement[]
}

export interface MigrationInput extends Omit<MigrationDefinition, 'checksum'> {
  readonly checksum?: string
}

export interface MigrationHistoryEntry {
  readonly component: string
  readonly id: string
  readonly version: number
  readonly checksum: string
  readonly appliedAtMs: bigint
}

export type MigrationStatus =
  | { readonly state: 'pending'; readonly revision: RevisionMetadata; readonly historyTableExists: boolean; readonly history: readonly MigrationHistoryEntry[] }
  | { readonly state: 'applied'; readonly revision: RevisionMetadata; readonly entry: MigrationHistoryEntry; readonly history: readonly MigrationHistoryEntry[] }
  | { readonly state: 'conflicting_checksum'; readonly revision: RevisionMetadata; readonly expected: string; readonly actual: string; readonly entry: MigrationHistoryEntry }
  | { readonly state: 'version_gap'; readonly revision: RevisionMetadata; readonly expectedPreviousVersion: number; readonly actualVersion: number }

export type MigrationSettlement =
  | { readonly state: 'accepted'; readonly transactionId: string; readonly outcome: TransactionOutcome; readonly evidence: SettlementEvidence }
  | { readonly state: 'rejected'; readonly transactionId: string; readonly outcome: TransactionOutcome; readonly evidence?: SettlementEvidence }
  | { readonly state: 'watermark_excluded'; readonly transactionId: string; readonly outcome: TransactionOutcome; readonly evidence: SettlementEvidence }
  | { readonly state: 'timeout'; readonly transactionId: string; readonly outcome: TransactionOutcome }

export type MigrationApplyResult =
  | { readonly state: 'already_applied'; readonly status: Extract<MigrationStatus, { state: 'applied' }> }
  | { readonly state: 'conflicting_checksum'; readonly status: Extract<MigrationStatus, { state: 'conflicting_checksum' }> }
  | { readonly state: 'version_gap'; readonly status: Extract<MigrationStatus, { state: 'version_gap' }> }
  | MigrationSettlement

export interface CatalogColumn {
  readonly cid: number
  readonly name: string
  readonly declaredType: string
  readonly notNull: boolean
  readonly defaultSql: string | null
  readonly primaryKeyOrdinal: number
  readonly hidden: number
}

export interface CatalogObject {
  readonly type: string
  readonly name: string
  readonly tableName: string
  readonly sql: string | null
  readonly columns: readonly CatalogColumn[]
}

export interface CatalogSnapshot {
  readonly revision: RevisionMetadata
  readonly objects: readonly CatalogObject[]
  readonly digest: string
}

export interface CatalogDiff {
  readonly fromRevision: string
  readonly toRevision: string
  readonly added: readonly CatalogObject[]
  readonly removed: readonly CatalogObject[]
  readonly changed: readonly { readonly before: CatalogObject; readonly after: CatalogObject }[]
}

export function defineMigration(input: MigrationInput): MigrationDefinition {
  assertMigrationIdentity(input.component, input.id, input.version)
  if (input.statements.length === 0) throw new TypeError('MIGRATION_STATEMENTS_REQUIRED')
  const calculated = migrationChecksum(input)
  if (input.checksum !== undefined && input.checksum !== calculated) throw new TypeError('MIGRATION_CHECKSUM_INVALID')
  return Object.freeze({ ...input, checksum: calculated, statements: Object.freeze([...input.statements]) })
}

export function migrationChecksum(input: Pick<MigrationInput, 'component' | 'id' | 'version' | 'statements'>): string {
  assertMigrationIdentity(input.component, input.id, input.version)
  const payload = stableJson({
    component: input.component,
    id: input.id,
    version: input.version,
    statements: input.statements.map((statement) => ({
      sql: statement.sql,
      parameters: statement.parameters ?? [],
    })),
  })
  return createHash('sha256').update(`chronolog-application-migration-v1\n${payload}`, 'utf8').digest('hex')
}

export function schemaVersionAssumption(
  component: string,
  requirement: { readonly exact: number; readonly checksum?: string } | { readonly minimum: number },
): CompiledSqlStatement & { readonly applicationLabel: string } {
  if ('exact' in requirement) {
    const checksumClause = requirement.checksum === undefined ? '' : ' AND checksum = ?'
    return {
      sql: `SELECT EXISTS (SELECT 1 FROM ${APPLICATION_MIGRATION_TABLE} WHERE component = ? AND version = ?${checksumClause})`,
      parameters: requirement.checksum === undefined
        ? [component, BigInt(requirement.exact)]
        : [component, BigInt(requirement.exact), requirement.checksum],
      applicationLabel: `schema.${component}.exact.${requirement.exact}`,
    }
  }
  return {
    sql: `SELECT COUNT(*) >= ? FROM ${APPLICATION_MIGRATION_TABLE} WHERE component = ?`,
    parameters: [BigInt(requirement.minimum), component],
    applicationLabel: `schema.${component}.minimum.${requirement.minimum}`,
  }
}

export class MigrationManager {
  constructor(readonly client: ChronologClient) {}

  async status(migration: MigrationDefinition, options: { readonly atRevision?: string } = {}): Promise<MigrationStatus> {
    const catalog = await this.client.query(
      "SELECT EXISTS (SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?)",
      [APPLICATION_MIGRATION_TABLE],
      options,
    )
    const historyExists = catalog.result.rows[0]?.[0] === 1n
    if (!historyExists) {
      return migration.version === 1
        ? { state: 'pending', revision: catalog.revision, historyTableExists: false, history: [] }
        : { state: 'version_gap', revision: catalog.revision, expectedPreviousVersion: migration.version - 1, actualVersion: 0 }
    }
    const response = await this.client.query(
      `SELECT component, id, version, checksum, applied_at_ms FROM ${APPLICATION_MIGRATION_TABLE} WHERE component = ? ORDER BY version`,
      [migration.component],
      { ...options, atRevision: options.atRevision ?? catalog.revision.materializedRevision },
    )
    const history = response.result.rows.map(historyEntry)
    const existing = history.find((entry) => entry.version === migration.version || entry.id === migration.id)
    if (existing !== undefined) {
      return existing.version === migration.version && existing.id === migration.id && existing.checksum === migration.checksum
        ? { state: 'applied', revision: response.revision, entry: existing, history }
        : { state: 'conflicting_checksum', revision: response.revision, expected: migration.checksum, actual: existing.checksum, entry: existing }
    }
    const actualVersion = history.at(-1)?.version ?? 0
    if (actualVersion !== migration.version - 1) {
      return { state: 'version_gap', revision: response.revision, expectedPreviousVersion: migration.version - 1, actualVersion }
    }
    return { state: 'pending', revision: response.revision, historyTableExists: true, history }
  }

  async apply(migration: MigrationDefinition, options: {
    readonly timeoutMs?: number
    readonly requireWatermark?: boolean
    readonly signal?: AbortSignal
  } = {}): Promise<MigrationApplyResult> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const status = await this.status(migration)
      if (status.state === 'applied') return { state: 'already_applied', status }
      if (status.state === 'conflicting_checksum') return { state: 'conflicting_checksum', status }
      if (status.state === 'version_gap') return { state: 'version_gap', status }
      const historyAbsent = !status.historyTableExists
      const handle = await this.client.transaction(async (draft) => {
        if (historyAbsent) {
          draft.assert(
            "SELECT NOT EXISTS (SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?)",
            [APPLICATION_MIGRATION_TABLE],
            { applicationLabel: `migration.${migration.component}.${migration.version}.history_absent` },
          )
        } else {
          const previous = status.history.at(-1)
          draft.assert(
            `SELECT COUNT(*) = ? FROM ${APPLICATION_MIGRATION_TABLE} WHERE component = ?`,
            [BigInt(migration.version - 1), migration.component],
            { applicationLabel: `migration.${migration.component}.${migration.version}.predecessor` },
          )
          draft.assert(
            `SELECT NOT EXISTS (SELECT 1 FROM ${APPLICATION_MIGRATION_TABLE} WHERE component = ? AND (version = ? OR id = ?))`,
            [migration.component, BigInt(migration.version), migration.id],
            { applicationLabel: `migration.${migration.component}.${migration.version}.absent` },
          )
          if (previous !== undefined) {
            draft.assert(
              `SELECT EXISTS (SELECT 1 FROM ${APPLICATION_MIGRATION_TABLE} WHERE component = ? AND version = ? AND checksum = ?)`,
              [migration.component, BigInt(previous.version), previous.checksum],
              { applicationLabel: `migration.${migration.component}.${migration.version}.checksum` },
            )
          }
        }
        draft.exec({
          sql: `CREATE TABLE IF NOT EXISTS ${APPLICATION_MIGRATION_TABLE} (component TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL, checksum TEXT NOT NULL, applied_at_ms INTEGER NOT NULL, PRIMARY KEY (component, version), UNIQUE (component, id)) WITHOUT ROWID, STRICT`,
        })
        draft.exec(migration.statements)
        draft.exec(
          `INSERT INTO ${APPLICATION_MIGRATION_TABLE} (component, id, version, checksum, applied_at_ms) VALUES (?, ?, ?, ?, ?)`,
          [migration.component, migration.id, BigInt(migration.version), migration.checksum, draft.reservedAuthorTimestampMs],
        )
      }, options.signal === undefined ? {} : { signal: options.signal })
      try {
        const settlement = await this.wait(handle.transactionId, options)
        if (settlement.state !== 'rejected') return settlement
        const converged = await this.status(migration)
        if (converged.state === 'applied') return { state: 'already_applied', status: converged }
        if (converged.state === 'conflicting_checksum') return { state: 'conflicting_checksum', status: converged }
        if (attempt === 1) return settlement
      } finally {
        handle.dispose()
      }
    }
    throw new Error('MIGRATION_APPLY_RETRY_EXHAUSTED')
  }

  async wait(transactionId: string, options: {
    readonly timeoutMs?: number
    readonly requireWatermark?: boolean
    readonly signal?: AbortSignal
  } = {}): Promise<MigrationSettlement> {
    const deadline = Date.now() + (options.timeoutMs ?? 30_000)
    let outcome = await this.client.getTransactionOutcome(transactionId)
    while (Date.now() < deadline) {
      if (options.signal?.aborted === true) throw options.signal.reason
      outcome = await this.client.getTransactionOutcome(transactionId)
      if (outcome.outcome.type === 'rejected') {
        const evidence = await this.client.getSettlementEvidence(transactionId).catch(() => undefined)
        return { state: 'rejected', transactionId, outcome, ...(evidence === undefined ? {} : { evidence }) }
      }
      const evidence = await this.client.getSettlementEvidence(transactionId).catch(() => undefined)
      if (evidence?.confidence === 'policy_watermark_reached' && outcome.outcome.type !== 'accepted') {
        return { state: 'watermark_excluded', transactionId, outcome, evidence }
      }
      if (outcome.outcome.type === 'accepted' && evidence !== undefined &&
          (!options.requireWatermark || evidence.confidence === 'policy_watermark_reached')) {
        return { state: 'accepted', transactionId, outcome, evidence }
      }
      await abortableDelay(100, options.signal)
    }
    return { state: 'timeout', transactionId, outcome }
  }

  settlement(transactionId: string): StreamResource<SettlementEvidence> {
    return this.client.settlementEvidence(transactionId)
  }

  migrationChanges(): StreamResource<LiveQueryValue> {
    return this.client.liveQuery(
      `SELECT component, id, version, checksum, applied_at_ms FROM ${APPLICATION_MIGRATION_TABLE} ORDER BY component, version`,
    )
  }

  schemaChanges(): StreamResource<LiveQueryValue> {
    return this.client.liveQuery("SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE 'dolt_%' AND name NOT LIKE 'chronolog_%' ORDER BY type, name")
  }
}

export async function inspectCatalog(client: ChronologClient, atRevision?: string): Promise<CatalogSnapshot> {
  const response = await client.query(
    "SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE 'dolt_%' AND name NOT LIKE 'chronolog_%' ORDER BY type, name",
    [],
    atRevision === undefined ? {} : { atRevision },
  )
  const revision = atRevision ?? response.revision.materializedRevision
  const objects: CatalogObject[] = []
  for (const row of response.result.rows) {
    const type = stringValue(row[0])
    const name = stringValue(row[1])
    const tableName = stringValue(row[2])
    const sql = nullableString(row[3])
    let columns: readonly CatalogColumn[] = []
    if (type === 'table' || type === 'view') {
      const details = await client.query(
        'SELECT cid, name, type, "notnull", dflt_value, pk, hidden FROM pragma_table_xinfo(?) ORDER BY cid',
        [name],
        { atRevision: revision },
      )
      columns = details.result.rows.map(catalogColumn)
    }
    objects.push({ type, name, tableName, sql, columns })
  }
  return { revision: response.revision, objects, digest: catalogDigest(objects) }
}

export function diffCatalogs(before: CatalogSnapshot, after: CatalogSnapshot): CatalogDiff {
  const oldObjects = new Map(before.objects.map((object) => [`${object.type}\0${object.name}`, object]))
  const newObjects = new Map(after.objects.map((object) => [`${object.type}\0${object.name}`, object]))
  const added = [...newObjects].filter(([key]) => !oldObjects.has(key)).map(([, object]) => object)
  const removed = [...oldObjects].filter(([key]) => !newObjects.has(key)).map(([, object]) => object)
  const changed = [...newObjects].flatMap(([key, object]) => {
    const previous = oldObjects.get(key)
    return previous !== undefined && stableJson(previous) !== stableJson(object) ? [{ before: previous, after: object }] : []
  })
  return {
    fromRevision: before.revision.materializedRevision,
    toRevision: after.revision.materializedRevision,
    added,
    removed,
    changed,
  }
}

export function generateTypeScriptBindings(snapshot: CatalogSnapshot): string {
  const lines = [
    '// Generated advisory bindings. SQLite catalog + revision remain the source of truth.',
    `// Materialized revision: ${snapshot.revision.materializedRevision}`,
    `// Catalog digest: ${snapshot.digest}`,
    `export const catalogRevision = ${JSON.stringify(snapshot.revision.materializedRevision)} as const`,
    `export const catalogDigest = ${JSON.stringify(snapshot.digest)} as const`,
    '',
  ]
  for (const object of snapshot.objects.filter((item) => item.type === 'table')) {
    lines.push(`export interface ${typescriptName(object.name)}Row {`)
    for (const column of object.columns) {
      const optionalNull = column.notNull || column.primaryKeyOrdinal > 0 ? '' : ' | null'
      lines.push(`  readonly ${JSON.stringify(column.name)}: ${typescriptColumnType(column.declaredType)}${optionalNull}`)
    }
    lines.push('}', '')
  }
  return `${lines.join('\n')}\n`
}

function historyEntry(row: readonly unknown[]): MigrationHistoryEntry {
  return {
    component: stringValue(row[0]),
    id: stringValue(row[1]),
    version: integerNumber(row[2]),
    checksum: stringValue(row[3]),
    appliedAtMs: bigintValue(row[4]),
  }
}

function catalogColumn(row: readonly unknown[]): CatalogColumn {
  return {
    cid: integerNumber(row[0]),
    name: stringValue(row[1]),
    declaredType: stringValue(row[2]),
    notNull: bigintValue(row[3]) !== 0n,
    defaultSql: nullableString(row[4]),
    primaryKeyOrdinal: integerNumber(row[5]),
    hidden: integerNumber(row[6]),
  }
}

function catalogDigest(objects: readonly CatalogObject[]): string {
  return createHash('sha256').update(`chronolog-pinned-catalog-v1\n${stableJson(objects)}`, 'utf8').digest('hex')
}

function assertMigrationIdentity(component: string, id: string, version: number): void {
  if (!/^[a-z][a-z0-9_.-]{0,127}$/.test(component)) throw new TypeError('MIGRATION_COMPONENT_INVALID')
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(id)) throw new TypeError('MIGRATION_ID_INVALID')
  if (!Number.isSafeInteger(version) || version < 1) throw new TypeError('MIGRATION_VERSION_INVALID')
}

function stableJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'bigint') return JSON.stringify({ $int64: value.toString() })
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('MIGRATION_VALUE_NONFINITE')
    return JSON.stringify(value)
  }
  if (value instanceof Uint8Array) return JSON.stringify({ $blob: Buffer.from(value).toString('base64url') })
  if (value instanceof Date) return JSON.stringify({ $date: value.toISOString() })
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`
  }
  throw new TypeError('MIGRATION_VALUE_UNSUPPORTED')
}

function stringValue(value: unknown): string { if (typeof value !== 'string') throw new Error('CATALOG_STRING_INVALID'); return value }
function nullableString(value: unknown): string | null { if (value === null || typeof value === 'string') return value; throw new Error('CATALOG_STRING_INVALID') }
function bigintValue(value: unknown): bigint { if (typeof value !== 'bigint') throw new Error('CATALOG_INTEGER_INVALID'); return value }
function integerNumber(value: unknown): number {
  const number = Number(bigintValue(value))
  if (!Number.isSafeInteger(number)) throw new Error('CATALOG_INTEGER_INVALID')
  return number
}

function typescriptName(value: string): string {
  const name = value.split(/[^a-zA-Z0-9]+/u).filter(Boolean).map((part) => `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`).join('')
  return /^[A-Za-z_$]/u.test(name) ? name : `Table${name}`
}

function typescriptColumnType(type: string): string {
  const affinity = type.toUpperCase()
  if (affinity.includes('INT')) return 'bigint'
  if (affinity.includes('CHAR') || affinity.includes('CLOB') || affinity.includes('TEXT')) return 'string'
  if (affinity.includes('BLOB') || affinity === '') return 'Uint8Array'
  if (affinity.includes('REAL') || affinity.includes('FLOA') || affinity.includes('DOUB')) return 'number'
  return 'number | bigint | string | Uint8Array'
}

function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) return Promise.reject(signal.reason)
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(done, milliseconds)
    const abort = () => { clearTimeout(timeout); reject(signal?.reason) }
    function done(): void { signal?.removeEventListener('abort', abort); resolve() }
    signal?.addEventListener('abort', abort, { once: true })
  })
}
