import { createHash } from 'node:crypto'

import { DatabaseSync, chronologNativeManifest } from '@dolthub/doltlite'

import type {
  DatabaseLike,
  MaterializerBackendInfo,
  MaterializerOptions,
  NativeEngineManifest,
  SecurityConfiguration,
} from './types.js'
import { assertNativeSecurityConfiguration, configureSqliteLimits } from './sql-profile.js'

export interface OpenedDatabase {
  readonly database: DatabaseLike
  readonly backend: MaterializerBackendInfo
  readonly security: SecurityConfiguration
}

export interface NativeEngineInfo {
  readonly manifest: NativeEngineManifest
  readonly descriptor: string
  readonly digest: Uint8Array
}

/** Read the linked native build identity before a database is opened. */
export function readNativeEngineInfo(): NativeEngineInfo {
  const manifest = normalizeNativeManifest(chronologNativeManifest())
  return {
    manifest,
    descriptor: nativeEngineDescriptor(manifest),
    digest: digestNativeEngineManifest(manifest),
  }
}

export function openDatabase(options: MaterializerOptions): OpenedDatabase {
  const path = options.path
  if (path === undefined || path === ':memory:') {
    throw new Error('MATERIALIZER_PERSISTENT_PATH_REQUIRED')
  }
  const database = new DatabaseSync(path) as unknown as DatabaseLike
  try {
    assertNativeContract(database)
    const security = database.configureSecurity()
    assertNativeSecurityConfiguration(security)
    configureSqliteLimits(database)
    database.exec('PRAGMA foreign_keys = ON')
    database.exec('PRAGMA recursive_triggers = ON')
    database.exec('PRAGMA trusted_schema = OFF')
    const native = readNativeEngineInfo()
    return {
      database,
      backend: {
        engine: 'doltlite',
        version: database.doltVersion(),
        sqliteVersion: readSqliteVersion(database),
        vecVersion: readOptionalScalar(database, 'SELECT vec_version() AS version'),
        nativeManifest: native.manifest,
        engineDigest: native.digest,
        securityConfigured: true,
      },
      security,
    }
  } catch (error) {
    database.close()
    throw error
  }
}

/**
 * SHA-256 over a versioned, recursively key-sorted JSON descriptor. Object
 * keys are sorted by Unicode code point, arrays retain order, and JSON is
 * emitted without whitespace.
 */
export function digestNativeEngineManifest(manifest: NativeEngineManifest): Uint8Array {
  const descriptor = `chronolog-engine-manifest-v1\n${stableJson(manifest)}`
  return Uint8Array.from(createHash('sha256').update(descriptor, 'utf8').digest())
}

export function nativeEngineDescriptor(manifest: NativeEngineManifest): string {
  return `chronolog-engine-manifest-v1\n${stableJson(manifest)}`
}

function readOptionalScalar(database: DatabaseLike, sql: string): string | null {
  try {
    const row = database.prepare(sql).get()
    if (row === undefined || Array.isArray(row) || typeof row.version !== 'string') return null
    return row.version
  } catch {
    return null
  }
}

function readSqliteVersion(database: DatabaseLike): string {
  const row = database.prepare('SELECT sqlite_version() AS version').get()
  if (row === undefined || Array.isArray(row) || typeof row.version !== 'string') {
    throw new Error('MATERIALIZER_SQLITE_VERSION_UNAVAILABLE')
  }
  return row.version
}

function assertNativeContract(database: DatabaseLike): void {
  const required = [
    'setAuthorizer',
    'setProgressHandler',
    'setLimit',
    'interrupt',
    'configureSecurity',
    'doltCommit',
    'doltBranch',
    'doltCheckout',
    'doltResetHard',
    'doltForceBranch',
    'doltDeleteBranch',
    'doltHashOf',
    'doltVersion',
    'doltBranches',
    'doltActiveBranch',
  ] as const
  for (const method of required) {
    if (typeof database[method] !== 'function') {
      throw new Error(`MATERIALIZER_NATIVE_API_MISSING:${method}`)
    }
  }
}

function normalizeNativeManifest(value: unknown): NativeEngineManifest {
  if (typeof value !== 'object' || value === null) throw new Error('MATERIALIZER_NATIVE_MANIFEST_INVALID')
  const manifest = value as Record<string, unknown>
  for (const key of [
    'doltliteVersion', 'doltliteSourceSha256', 'sqliteVecVersion',
    'sqliteVecSourceSha256', 'chronologPatchProfile',
  ]) {
    if (typeof manifest[key] !== 'string' || manifest[key] === '') {
      throw new Error('MATERIALIZER_NATIVE_MANIFEST_INVALID')
    }
  }
  for (const key of ['fts5', 'json1', 'rtree', 'dynamicExtensions']) {
    if (typeof manifest[key] !== 'boolean') throw new Error('MATERIALIZER_NATIVE_MANIFEST_INVALID')
  }
  return structuredClone(value) as NativeEngineManifest
}

function stableJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`
  }
  throw new Error('MATERIALIZER_NATIVE_MANIFEST_INVALID')
}
