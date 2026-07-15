import { describe, expect, it } from 'vitest'

import {
  isReservedSchemaObjectName,
  isValidSqlIdentifier,
  sqliteIdentifierEquals,
  sqliteIdentifierKey,
  decodeSchemaManifest,
  encodeSchemaManifest,
  validateSchemaManifest,
  type SchemaManifest,
} from './index.js'

function schemaWithNames(tableName: string, columnNames: readonly string[]): SchemaManifest {
  const columns = columnNames.map((name, index) => ({
    id: index + 2,
    name,
    declarationOrder: index,
    valueType: { logical: { kind: 'int64' as const }, nullable: false },
  }))
  return {
    version: 1,
    name: 'Application schema',
    objects: [{
      kind: 'table',
      id: 1,
      name: tableName,
      declarationOrder: 0,
      columns,
      constraints: [{ kind: 'primary_key', id: 100, name: 'Primary Key', columnIds: [2] }],
      withoutRowId: true,
    }],
    seedRows: [],
    functionIds: [],
    collationIds: [],
    moduleIds: [],
  }
}

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

    const schema = schemaWithNames('Order "Details"', ['Primary ID', '日本語の名前'])
    expect(decodeSchemaManifest(encodeSchemaManifest(schema))).toEqual(schema)
  })

  it('matches SQLite ASCII case folding without folding Unicode', () => {
    expect(sqliteIdentifierKey('MiXeD É')).toBe('mixed É')
    expect(sqliteIdentifierEquals('Order DETAILS', 'order details')).toBe(true)
    expect(sqliteIdentifierEquals('é', 'É')).toBe(false)
  })

  it('rejects object and column collisions exactly where SQLite would', () => {
    const objectCollision = schemaWithNames('Accounts', ['id'])
    const second = { ...objectCollision.objects[0]!, id: 200, name: 'accounts' }
    expect(validateSchemaManifest({ ...objectCollision, objects: [...objectCollision.objects, second] })
      .diagnostics.map((item) => item.code)).toContain('DUPLICATE_SCHEMA_NAME')

    expect(validateSchemaManifest(schemaWithNames('Accounts', ['ID', 'id']))
      .diagnostics.map((item) => item.code)).toContain('DUPLICATE_COLUMN_NAME')
    expect(validateSchemaManifest(schemaWithNames('Accounts', ['é', 'É'])).ok).toBe(true)
  })

  it('reserves only internal schema-object namespaces', () => {
    for (const name of [
      'Chronolog_state', 'SQLITE_sequence', 'DOLT_docs', 'DoltLite_docs',
      'Pragma_table_info', 'dbstat', 'sqlite_dbpage', 'bytecode', 'tables_used',
    ]) {
      expect(isReservedSchemaObjectName(name)).toBe(true)
      expect(validateSchemaManifest(schemaWithNames(name, ['id'])).diagnostics.map((item) => item.code))
        .toContain('RESERVED_IDENTIFIER')
    }

    const ordinaryNames = schemaWithNames('Application Data', ['chronolog_value', 'sqlite_value', 'dolt_value'])
    expect(validateSchemaManifest({
      ...ordinaryNames,
      name: 'chronolog_manifest',
      objects: ordinaryNames.objects.map((object) => object.kind === 'table'
        ? { ...object, constraints: [{ ...object.constraints[0]!, name: 'sqlite_constraint' }] }
        : object),
    }).ok).toBe(true)
  })
})
