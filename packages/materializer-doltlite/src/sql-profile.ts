import {
  DETERMINISTIC_READ_ONLY_PRAGMAS,
  DETERMINISTIC_SQLITE_COMPILER_FUNCTIONS,
} from '@chronolog/compiler-sqlite'
import { isReservedSchemaObjectName } from '@chronolog/ir'
import { utf8 } from '@chronolog/protocol'

import type {
  DatabaseLike,
  NativeSecurityConfiguration,
  SqlRuntimeLimits,
  StatementLike,
} from './types.js'

const SQLITE_OK = 0
const SQLITE_DENY = 1
const SQLITE_AUTH = 23
const SQLITE_INTERRUPT = 9

const OPERATIONAL_SQLITE_CODES: ReadonlySet<number> = new Set([
  2, // SQLITE_INTERNAL
  3, // SQLITE_PERM
  4, // SQLITE_ABORT
  5, // SQLITE_BUSY
  6, // SQLITE_LOCKED
  7, // SQLITE_NOMEM
  8, // SQLITE_READONLY
  9, // SQLITE_INTERRUPT (deterministic budget interrupts are wrapped earlier)
  10, // SQLITE_IOERR
  11, // SQLITE_CORRUPT
  12, // SQLITE_NOTFOUND
  13, // SQLITE_FULL
  14, // SQLITE_CANTOPEN
  15, // SQLITE_PROTOCOL
  17, // SQLITE_SCHEMA after automatic reprepare failed
  21, // SQLITE_MISUSE
  24, // SQLITE_FORMAT
  26, // SQLITE_NOTADB
])

const ACTION = {
  CREATE_INDEX: 1,
  CREATE_TABLE: 2,
  CREATE_TEMP_INDEX: 3,
  CREATE_TEMP_TABLE: 4,
  CREATE_TEMP_TRIGGER: 5,
  CREATE_TEMP_VIEW: 6,
  CREATE_TRIGGER: 7,
  CREATE_VIEW: 8,
  DELETE: 9,
  DROP_INDEX: 10,
  DROP_TABLE: 11,
  DROP_TEMP_INDEX: 12,
  DROP_TEMP_TABLE: 13,
  DROP_TEMP_TRIGGER: 14,
  DROP_TEMP_VIEW: 15,
  DROP_TRIGGER: 16,
  DROP_VIEW: 17,
  INSERT: 18,
  PRAGMA: 19,
  READ: 20,
  SELECT: 21,
  TRANSACTION: 22,
  UPDATE: 23,
  ATTACH: 24,
  DETACH: 25,
  ALTER_TABLE: 26,
  REINDEX: 27,
  ANALYZE: 28,
  CREATE_VTABLE: 29,
  DROP_VTABLE: 30,
  FUNCTION: 31,
  SAVEPOINT: 32,
  RECURSIVE: 33,
} as const

export const SQLITE_LIMIT_CATEGORY = {
  LENGTH: 0,
  SQL_LENGTH: 1,
  COLUMN: 2,
  EXPR_DEPTH: 3,
  COMPOUND_SELECT: 4,
  VDBE_OP: 5,
  FUNCTION_ARG: 6,
  ATTACHED: 7,
  LIKE_PATTERN_LENGTH: 8,
  VARIABLE_NUMBER: 9,
  TRIGGER_DEPTH: 10,
  WORKER_THREADS: 11,
} as const

export const DEFAULT_SQL_RUNTIME_LIMITS: Readonly<SqlRuntimeLimits> = {
  maxSqlBytes: 1_000_000,
  maxVmSteps: 1_000_000,
  progressGranularity: 1_000,
  maxResultRows: 10_000,
  maxResultBytes: 16 * 1024 * 1024,
}

/**
 * Every permitted consensus function is deterministic from its SQL arguments
 * under the pinned SQLite build. Unknown functions fail closed. Time, random,
 * connection state, extension, filesystem and all Dolt functions are absent.
 * Local read SQL deliberately uses the separate denylist below.
 */
export const ALLOWED_DETERMINISTIC_FUNCTIONS: ReadonlySet<string> = new Set([
  ...DETERMINISTIC_SQLITE_COMPILER_FUNCTIONS,
  // These functions are deterministic when the compiler has rejected every
  // ambient time and timezone modifier.
  'date', 'time', 'datetime', 'julianday', 'strftime', 'unixepoch', 'timediff',
])

/**
 * Local SQL is not replayed or signed, so ambient presentation functions such
 * as datetime('now'), random(), JSON1, math and window functions are safe. It
 * still runs on an immutable reader and must not cross an external-effect or
 * Dolt-control boundary. Unknown statically linked read functions are allowed;
 * dynamic extension loading is also disabled at the native connection level.
 */
export const FORBIDDEN_LOCAL_READ_FUNCTIONS: ReadonlySet<string> = new Set([
  'active_branch',
  'load_extension',
])

export type SqlAuthorizationMode =
  | 'internal_bootstrap'
  | 'consensus_precondition'
  | 'consensus_body'
  | 'local_read'

export class SqlProfileError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'SqlProfileError'
  }
}

export function normalizeSqlRuntimeLimits(input: Partial<SqlRuntimeLimits> = {}): SqlRuntimeLimits {
  const limits = { ...DEFAULT_SQL_RUNTIME_LIMITS, ...input }
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new SqlProfileError(`SQL_INVALID_LIMIT_${name.toUpperCase()}`)
    }
  }
  if (limits.progressGranularity > limits.maxVmSteps) {
    throw new SqlProfileError('SQL_INVALID_LIMIT_PROGRESS_GRANULARITY')
  }
  return limits
}

/** Apply and verify connection-local sqlite3_limit values. */
export function configureSqliteLimits(
  database: DatabaseLike,
  input: Partial<SqlRuntimeLimits> = {},
): ReadonlyMap<number, number> {
  const limits = normalizeSqlRuntimeLimits(input)
  const requested = new Map<number, number>([
    [SQLITE_LIMIT_CATEGORY.LENGTH, limits.maxResultBytes],
    [SQLITE_LIMIT_CATEGORY.SQL_LENGTH, limits.maxSqlBytes],
    [SQLITE_LIMIT_CATEGORY.COLUMN, 256],
    [SQLITE_LIMIT_CATEGORY.EXPR_DEPTH, 100],
    [SQLITE_LIMIT_CATEGORY.COMPOUND_SELECT, 32],
    [SQLITE_LIMIT_CATEGORY.VDBE_OP, limits.maxVmSteps],
    [SQLITE_LIMIT_CATEGORY.FUNCTION_ARG, 64],
    [SQLITE_LIMIT_CATEGORY.ATTACHED, 0],
    [SQLITE_LIMIT_CATEGORY.LIKE_PATTERN_LENGTH, 10_000],
    [SQLITE_LIMIT_CATEGORY.VARIABLE_NUMBER, 1_000],
    [SQLITE_LIMIT_CATEGORY.TRIGGER_DEPTH, 16],
    [SQLITE_LIMIT_CATEGORY.WORKER_THREADS, 0],
  ])
  const applied = new Map<number, number>()
  for (const [category, requestedValue] of requested) {
    database.setLimit(category, requestedValue)
    const actual = database.setLimit(category, -1)
    if (actual !== requestedValue) throw new SqlProfileError('SQL_NATIVE_LIMIT_MISMATCH')
    applied.set(category, actual)
  }
  return applied
}

/** Fail startup if the native connection did not apply every security bit. */
export function assertNativeSecurityConfiguration(config: NativeSecurityConfiguration): void {
  if (
    !config.defensive ||
    !config.trustedSchema ||
    !config.loadExtension ||
    !config.dqsDml ||
    !config.dqsDdl ||
    !config.qpsg ||
    !config.ftsTokenizer ||
    !config.writableSchema ||
    !config.extendedResultCodes ||
    !config.attachCreate ||
    !config.attachWrite ||
    !config.reverseScanOrder ||
    !config.fpDigits
  ) {
    throw new SqlProfileError('SQL_NATIVE_SECURITY_CONFIGURATION_FAILED')
  }
}

export function prepareProfiledStatement(
  database: DatabaseLike,
  sql: string,
  mode: SqlAuthorizationMode,
  inputLimits: Partial<SqlRuntimeLimits> = {},
): StatementLike {
  const limits = normalizeSqlRuntimeLimits(inputLimits)
  validateSqlSource(sql, limits)
  return withProfileControls(database, mode, limits, () => {
    let statement: StatementLike
    try {
      statement = database.prepare(sql)
    } catch (error) {
      if (isSqlAuthorizationError(error)) throw new SqlProfileError('SQL_PROFILE_VIOLATION')
      if (isOperationalSqliteError(error)) throw error
      throw new SqlProfileError('SQL_PREPARE_FAILED')
    }
    validateSingleStatement(sql, statement)
    return statement
  })
}

/**
 * Keep authorizer and budget installed through prepare and step. This matters
 * because sqlite3_step() may reprepare after a schema change.
 */
export function withProfiledStatement<T>(
  database: DatabaseLike,
  sql: string,
  mode: SqlAuthorizationMode,
  operation: (statement: StatementLike) => T,
  inputLimits: Partial<SqlRuntimeLimits> = {},
): T {
  const limits = normalizeSqlRuntimeLimits(inputLimits)
  validateSqlSource(sql, limits)
  return withProfileControls(database, mode, limits, () => {
    let statement: StatementLike
    try {
      statement = database.prepare(sql)
    } catch (error) {
      if (isSqlAuthorizationError(error)) throw new SqlProfileError('SQL_PROFILE_VIOLATION')
      if (isOperationalSqliteError(error)) throw error
      throw new SqlProfileError('SQL_PREPARE_FAILED')
    }
    validateSingleStatement(sql, statement)
    return operation(statement)
  })
}

export function withAuthorizer<T>(
  database: DatabaseLike,
  mode: SqlAuthorizationMode,
  operation: () => T,
): T {
  database.setAuthorizer(createAuthorizer(mode))
  try {
    return operation()
  } catch (error) {
    if (isSqlAuthorizationError(error)) throw new SqlProfileError('SQL_PROFILE_VIOLATION')
    throw error
  } finally {
    database.setAuthorizer(null)
  }
}

export function withExecutionBudget<T>(
  database: DatabaseLike,
  operation: () => T,
  inputLimits: Partial<SqlRuntimeLimits> = {},
): T {
  const limits = normalizeSqlRuntimeLimits(inputLimits)
  let callbacks = 0
  const maximumCallbacks = Math.max(1, Math.ceil(limits.maxVmSteps / limits.progressGranularity))
  let budgetExceeded = false
  database.setProgressHandler(limits.progressGranularity, () => {
    callbacks += 1
    budgetExceeded = callbacks >= maximumCallbacks
    return budgetExceeded
  })
  try {
    return operation()
  } catch (error) {
    if (budgetExceeded && sqlitePrimaryCode(error) === SQLITE_INTERRUPT) {
      throw new SqlProfileError('SQL_STEP_LIMIT')
    }
    throw error
  } finally {
    database.setProgressHandler(0, null)
  }
}

function withProfileControls<T>(
  database: DatabaseLike,
  mode: SqlAuthorizationMode,
  limits: SqlRuntimeLimits,
  operation: () => T,
): T {
  database.setAuthorizer(createAuthorizer(mode))
  try {
    return withExecutionBudget(database, operation, limits)
  } catch (error) {
    if (isSqlAuthorizationError(error)) throw new SqlProfileError('SQL_PROFILE_VIOLATION')
    throw error
  } finally {
    database.setAuthorizer(null)
  }
}

function createAuthorizer(mode: SqlAuthorizationMode) {
  let schemaOperation = false
  let schemaIndexOperation = false
  return (
    action: number,
    arg1: string | null,
    arg2: string | null,
    databaseName: string | null,
    triggerOrView: string | null,
  ): number => {
    const objectName = asciiLower(arg1)
    const secondaryName = asciiLower(arg2)
    const database = asciiLower(databaseName)
    const source = asciiLower(triggerOrView)

    if (source !== '' && isReservedSchemaObjectName(source) && !isAllowedPragmaTable(source)) return SQLITE_DENY
    if (action === ACTION.SELECT) return SQLITE_OK
    if (action === ACTION.FUNCTION) {
      const functionName = secondaryName || objectName
      if (mode === 'local_read') {
        return isForbiddenLocalReadFunction(functionName) ? SQLITE_DENY : SQLITE_OK
      }
      if (functionName.startsWith('pragma_') &&
          DETERMINISTIC_READ_ONLY_PRAGMAS.has(functionName.slice('pragma_'.length))) return SQLITE_OK
      if (schemaOperation && (
        functionName === 'printf' || functionName === 'substr' || functionName === 'length' ||
        functionName.startsWith('sqlite_rename_')
      )) {
        return SQLITE_OK
      }
      return ALLOWED_DETERMINISTIC_FUNCTIONS.has(functionName) ? SQLITE_OK : SQLITE_DENY
    }
    if (action === ACTION.PRAGMA) {
      if (schemaOperation && objectName === 'quick_check') return SQLITE_OK
      return (mode === 'local_read' || mode === 'consensus_precondition' || mode === 'consensus_body') &&
        DETERMINISTIC_READ_ONLY_PRAGMAS.has(objectName)
        ? SQLITE_OK
        : SQLITE_DENY
    }
    if (action === ACTION.READ) {
      // SQLite may omit the database name for follow-on READ callbacks emitted
      // by a prepared statement. A non-empty name must still be the application
      // database; object-name restrictions below remain in force either way.
      if (schemaOperation && database === 'temp' && objectName === 'sqlite_temp_master') return SQLITE_OK
      if (database !== '' && database !== 'main') return SQLITE_DENY
      if (mode === 'internal_bootstrap') return database === '' || database === 'main' ? SQLITE_OK : SQLITE_DENY
      if (schemaOperation && objectName === 'pragma_quick_check') return SQLITE_OK
      if ((mode === 'local_read' || mode === 'consensus_precondition') && objectName === 'chronolog_transactions') return SQLITE_OK
      if ((mode === 'local_read' || mode === 'consensus_precondition' || mode === 'consensus_body') && isAllowedPragmaTable(objectName)) return SQLITE_OK
      if (
        (mode === 'local_read' || mode === 'consensus_precondition' || mode === 'consensus_body') &&
        (objectName === 'sqlite_master' || objectName === 'sqlite_schema')
      ) return SQLITE_OK
      if ((objectName === 'sqlite_master' || objectName === 'sqlite_schema') && isAllowedPragmaTable(source)) return SQLITE_OK
      // SQLite implements ordinary main-schema DDL by consulting and updating
      // its own catalog. Consensus body statements may observe that catalog
      // only as part of the authorized schema operation; Chronolog tables stay
      // protected by the separate reserved-name checks.
      return isReservedSchemaObjectName(objectName) ? SQLITE_DENY : SQLITE_OK
    }
    if ((mode === 'consensus_body' || mode === 'internal_bootstrap') && (
      action === ACTION.INSERT || action === ACTION.UPDATE || action === ACTION.DELETE
    )) {
      if (schemaOperation && action === ACTION.UPDATE && database === 'temp' && objectName === 'sqlite_temp_master') {
        return SQLITE_OK
      }
      if (database !== 'main') return SQLITE_DENY
      if (mode !== 'internal_bootstrap' && isReservedSchemaObjectName(objectName) && objectName !== 'sqlite_master' && objectName !== 'sqlite_schema') return SQLITE_DENY
      return SQLITE_OK
    }
    if ((mode === 'internal_bootstrap' || mode === 'consensus_body') && (
      action === ACTION.CREATE_TABLE || action === ACTION.CREATE_INDEX ||
      action === ACTION.CREATE_VIEW || action === ACTION.CREATE_TRIGGER ||
      action === ACTION.DROP_TABLE || action === ACTION.DROP_INDEX ||
      action === ACTION.DROP_VIEW || action === ACTION.DROP_TRIGGER
    )) {
      const allowed = database === 'main' && (mode === 'internal_bootstrap' || !isReservedSchemaObjectName(objectName))
      if (allowed) {
        schemaOperation = true
        if (action === ACTION.CREATE_INDEX) schemaIndexOperation = true
      }
      return allowed ? SQLITE_OK : SQLITE_DENY
    }
    // SQLITE_ALTER_TABLE reports the database and table through arg1/arg2
    // rather than through the usual object/database positions.
    if ((mode === 'internal_bootstrap' || mode === 'consensus_body') && action === ACTION.ALTER_TABLE) {
      const allowed = objectName === 'main' && (mode === 'internal_bootstrap' || !isReservedSchemaObjectName(secondaryName))
      if (allowed) schemaOperation = true
      return allowed ? SQLITE_OK : SQLITE_DENY
    }
    // SQLite emits SQLITE_REINDEX while preparing CREATE INDEX. A standalone
    // REINDEX reaches this callback without the preceding CREATE_INDEX action
    // and remains denied (the compiler also gates it).
    if (
      (mode === 'internal_bootstrap' || mode === 'consensus_body') &&
      action === ACTION.REINDEX && schemaIndexOperation
    ) return database === 'main' && !isReservedSchemaObjectName(objectName) ? SQLITE_OK : SQLITE_DENY
    // A recursive CTE is a deterministic query construct and remains bounded
    // by the same VM-step and result limits as every other statement. Schema
    // validation, rather than this coarse callback, excludes triggers from the
    // consensus language.
    if (action === ACTION.RECURSIVE && mode !== 'internal_bootstrap') return SQLITE_OK
    // All DDL, transactions, pragmas, attachment, virtual tables, maintenance
    // commands and unknown future action codes fail closed.
    return SQLITE_DENY
  }
}

function isAllowedPragmaTable(value: string): boolean {
  return value.startsWith('pragma_') &&
    DETERMINISTIC_READ_ONLY_PRAGMAS.has(value.slice('pragma_'.length))
}

function isForbiddenLocalReadFunction(value: string): boolean {
  return FORBIDDEN_LOCAL_READ_FUNCTIONS.has(value) ||
    value.startsWith('dolt_') ||
    value.startsWith('doltlite_')
}

function asciiLower(value: string | null): string {
  if (value === null) return ''
  let result = ''
  for (const character of value) {
    const code = character.charCodeAt(0)
    result += code >= 65 && code <= 90 ? String.fromCharCode(code + 32) : character
  }
  return result
}

function validateSqlSource(sql: string, limits: SqlRuntimeLimits): void {
  if (sql.includes('\0')) throw new SqlProfileError('SQL_INVALID_SOURCE')
  let bytes: Uint8Array
  try {
    bytes = utf8(sql)
  } catch {
    throw new SqlProfileError('SQL_INVALID_SOURCE')
  }
  if (bytes.length > limits.maxSqlBytes) throw new SqlProfileError('SQL_STATEMENT_TOO_LARGE')
}

function validateSingleStatement(sql: string, statement: StatementLike): void {
  if (!Number.isSafeInteger(statement.tailOffset) || statement.tailOffset < 0) {
    throw new SqlProfileError('SQL_STATEMENT_TAIL_UNAVAILABLE')
  }
  if (utf8(statement.sourceSQL).length !== statement.tailOffset) {
    throw new SqlProfileError('SQL_STATEMENT_TAIL_INVALID')
  }
  const tail = sql.slice(statement.sourceSQL.length)
  if (!isTriviaOnly(tail)) throw new SqlProfileError('SQL_MULTIPLE_STATEMENTS')
}

function isTriviaOnly(text: string): boolean {
  let index = 0
  while (index < text.length) {
    const character = text[index]!
    if (/\s/u.test(character) || character === ';') {
      index += 1
      continue
    }
    if (character === '-' && text[index + 1] === '-') {
      index += 2
      while (index < text.length && text[index] !== '\n' && text[index] !== '\r') index += 1
      continue
    }
    if (character === '/' && text[index + 1] === '*') {
      const end = text.indexOf('*/', index + 2)
      if (end < 0) return false
      index = end + 2
      continue
    }
    return false
  }
  return true
}

function isSqlAuthorizationError(error: unknown): boolean {
  const primary = sqlitePrimaryCode(error)
  if (primary === SQLITE_AUTH) return true
  return typeof error === 'object' && error !== null &&
    'message' in error && typeof (error as { message?: unknown }).message === 'string' &&
    /authoriz|not authorized/u.test((error as { message: string }).message)
}

export function sqlitePrimaryCode(error: unknown): number | null {
  if (typeof error !== 'object' || error === null) return null
  for (const property of ['sqliteCode', 'errcode', 'sqliteExtendedCode'] as const) {
    const value = (error as Record<string, unknown>)[property]
    if (typeof value === 'number' && Number.isInteger(value)) return value & 0xff
  }
  return null
}

/** True when the failure is local/environmental and must abort replay. */
export function isOperationalSqliteError(error: unknown): boolean {
  const primary = sqlitePrimaryCode(error)
  return primary !== null && OPERATIONAL_SQLITE_CODES.has(primary)
}
