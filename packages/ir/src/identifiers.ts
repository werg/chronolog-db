import { utf8 } from '@chronolog/canonical'

const RESERVED_EXACT_SCHEMA_OBJECTS = new Set([
  'dbstat',
  'sqlite_dbpage',
  'bytecode',
  'tables_used',
])

/**
 * Returns the lookup key SQLite uses for identifiers: ASCII letters are
 * case-insensitive, while every non-ASCII code point remains distinct.
 *
 * Do not use JavaScript's locale-sensitive or Unicode-wide case conversion
 * here. SQLite's identifier comparison deliberately folds ASCII only.
 */
export function sqliteIdentifierKey(value: string): string {
  return Array.from(value, (character) => {
    const codePoint = character.codePointAt(0)!
    return codePoint >= 0x41 && codePoint <= 0x5a
      ? String.fromCodePoint(codePoint + 0x20)
      : character
  }).join('')
}

export function sqliteIdentifierEquals(left: string, right: string): boolean {
  return sqliteIdentifierKey(left) === sqliteIdentifierKey(right)
}

/** Quoted SQLite identifiers may contain any nonempty, well-formed Unicode text except NUL. */
export function isValidSqlIdentifier(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) return false
  try {
    utf8(value)
    return true
  } catch {
    return false
  }
}

/** Namespaces owned by SQLite, Dolt, or Chronolog rather than application schema objects. */
export function isReservedSchemaObjectName(value: unknown): boolean {
  if (typeof value !== 'string') return false
  const key = sqliteIdentifierKey(value)
  return key.startsWith('chronolog_') ||
    key.startsWith('sqlite_') ||
    key.startsWith('dolt_') ||
    key.startsWith('doltlite_') ||
    key.startsWith('pragma_') ||
    RESERVED_EXACT_SCHEMA_OBJECTS.has(key)
}
