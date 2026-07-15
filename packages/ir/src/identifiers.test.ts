import { describe, expect, it } from 'vitest'

import {
  isReservedSchemaObjectName,
  isValidSqlIdentifier,
  sqliteIdentifierEquals,
  sqliteIdentifierKey,
} from './index.js'

describe('SQL identifiers', () => {
  it('accepts ordinary quoted SQL names without a style or length policy', () => {
    for (const name of [
      'select',
      'Order Details',
      'display"name',
      '_leading',
      '$ amount / unit',
      '日本語の名前',
      'x'.repeat(256),
    ]) expect(isValidSqlIdentifier(name), name).toBe(true)

    expect(isValidSqlIdentifier('')).toBe(false)
    expect(isValidSqlIdentifier('nul\0name')).toBe(false)
    expect(isValidSqlIdentifier('\ud800')).toBe(false)
  })

  it('matches SQLite ASCII case folding without folding Unicode', () => {
    expect(sqliteIdentifierKey('MiXeD É')).toBe('mixed É')
    expect(sqliteIdentifierEquals('Order DETAILS', 'order details')).toBe(true)
    expect(sqliteIdentifierEquals('é', 'É')).toBe(false)
  })

  it('reserves internal schema-object namespaces only', () => {
    for (const name of [
      'Chronolog_state', 'SQLITE_sequence', 'DOLT_docs', 'DoltLite_docs',
      'Pragma_table_info', 'dbstat', 'sqlite_dbpage', 'bytecode', 'tables_used',
    ]) expect(isReservedSchemaObjectName(name)).toBe(true)

    for (const name of ['Application Data', 'account_value', 'order_items']) {
      expect(isReservedSchemaObjectName(name)).toBe(false)
    }
  })
})
