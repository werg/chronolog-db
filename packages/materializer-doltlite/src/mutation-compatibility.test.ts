import { DatabaseSync } from '@dolthub/doltlite'
import {
  compileMutation,
  compileSchema,
  createCoreExecutionManifest,
  type TransactionContextValues,
} from '@chronolog/compiler-sqlite'
import type { Expr, Query, SchemaManifest } from '@chronolog/ir'
import { describe, expect, it } from 'vitest'

import { executeCompiledMutation } from './ir-executor.js'
import { assertNativeSecurityConfiguration, configureSqliteLimits } from './sql-profile.js'
import { executeLocalSql } from './sql-values.js'
import type { DatabaseLike } from './types.js'

const encoder = new TextEncoder()
const textType = { logical: { kind: 'text' as const, collation: 'binary' as const }, nullable: false }
const intType = { logical: { kind: 'int64' as const }, nullable: false }

const schema: SchemaManifest = {
  version: 1,
  name: 'mutation_compatibility',
  objects: [table(1, 'source_rows'), table(10, 'target_rows'), defaultTable()],
  seedRows: [], functionIds: [], collationIds: [], moduleIds: [],
}

function defaultTable(): Extract<SchemaManifest['objects'][number], { kind: 'table' }> {
  return {
    kind: 'table', id: 20, name: 'default_rows', declarationOrder: 20, withoutRowId: true,
    columns: [
      { id: 21, name: 'id', declarationOrder: 0, valueType: intType, defaultValue: { kind: 'int64', value: 100n } },
      { id: 22, name: 'value', declarationOrder: 1, valueType: textType, defaultValue: { kind: 'text', utf8: encoder.encode('default') } },
      { id: 23, name: 'score', declarationOrder: 2, valueType: intType, defaultValue: { kind: 'int64', value: 7n } },
    ],
    constraints: [{ kind: 'primary_key', id: 24, name: 'default_rows_pk', columnIds: [21] }],
  }
}

const manifest = createCoreExecutionManifest({
  profile: 'mutation-compatibility',
  engineDigest: new Uint8Array(32),
})

const context: TransactionContextValues = {
  group_id: new Uint8Array(32),
  membership_revision: new Uint8Array(32),
  validation_policy: new Uint8Array(32),
  author_id: new Uint8Array(32),
  author_timestamp_ms: 0n,
  transaction_nonce: new Uint8Array(16),
  candidate_digest: new Uint8Array(32),
  transaction_id: new Uint8Array(32),
  author_feed_sequence: 0n,
}

function table(id: number, name: string): Extract<SchemaManifest['objects'][number], { kind: 'table' }> {
  return {
    kind: 'table', id, name, declarationOrder: id, withoutRowId: true,
    columns: [
      { id: id + 1, name: 'id', declarationOrder: 0, valueType: intType },
      { id: id + 2, name: 'value', declarationOrder: 1, valueType: textType },
      { id: id + 3, name: 'score', declarationOrder: 2, valueType: intType },
    ],
    constraints: [
      { kind: 'primary_key', id: id + 4, name: `${name}_pk`, columnIds: [id + 1] },
      { kind: 'unique', id: id + 5, name: `${name}_value_uq`, columnIds: [id + 2] },
    ],
  }
}

function integer(id: number, value: bigint): Expr {
  return { kind: 'literal', id, value: { kind: 'int64', value } }
}

function text(id: number, value: string): Expr {
  return { kind: 'literal', id, value: { kind: 'text', utf8: encoder.encode(value) } }
}

describe('deterministic SQLite mutation compatibility', () => {
  it('executes conflict policies, INSERT SELECT, aliases, and named UPSERT actions', () => {
    const compiledSchema = compileSchema(schema, manifest)
    const database = new DatabaseSync(':memory:') as unknown as DatabaseLike
    try {
      assertNativeSecurityConfiguration(database.configureSecurity())
      database.exec('PRAGMA foreign_keys = ON')
      database.exec('PRAGMA trusted_schema = OFF')
      configureSqliteLimits(database)
      for (const statement of compiledSchema.statements) database.exec(statement.sql)
      database.exec(`
        INSERT INTO source_rows VALUES (10, 'ten', 10), (11, 'eleven', 11);
        INSERT INTO target_rows VALUES (1, 'one', 1);
      `)

      const defaultValues = compileMutation({
        kind: 'insert', id: 80, target: { kind: 'name', name: 'default_rows' }, alias: 'defaults',
        columns: [], rows: [[]], conflict: 'error', affectedRows: { kind: 'exactly', count: 1n },
      }, compiledSchema.catalog)
      expect(executeCompiledMutation(database, defaultValues, context)).toBe(1n)

      const ignore = compileMutation({
        kind: 'insert', id: 100, target: { kind: 'name', name: 'target_rows' }, alias: 'destination',
        columns: ['id', 'value', 'score'], rows: [[integer(101, 1n), text(102, 'ignored'), integer(103, 2n)]],
        conflict: 'ignore', affectedRows: { kind: 'exactly', count: 0n },
      }, compiledSchema.catalog)
      expect(executeCompiledMutation(database, ignore, context)).toBe(0n)

      const replace = compileMutation({
        kind: 'insert', id: 110, target: { kind: 'name', name: 'target_rows' },
        columns: ['id', 'value', 'score'], rows: [[integer(111, 1n), text(112, 'replaced'), integer(113, 3n)]],
        conflict: 'replace', affectedRows: { kind: 'exactly', count: 1n },
      }, compiledSchema.catalog)
      expect(executeCompiledMutation(database, replace, context)).toBe(1n)

      const source: Query = {
        id: 120, ctes: [], joins: [], groupBy: [], windows: [], compounds: [],
        from: { kind: 'table', id: 121, name: 'source_rows', alias: 'source' },
        projection: [
          { id: 122, name: 'id', expression: { kind: 'column', id: 123, relation: 'source', name: 'id' } },
          { id: 124, name: 'value', expression: { kind: 'column', id: 125, relation: 'source', name: 'value' } },
          { id: 126, name: 'score', expression: { kind: 'column', id: 127, relation: 'source', name: 'score' } },
        ],
        orderBy: [{
          id: 128, expression: { kind: 'column', id: 129, relation: 'source', name: 'id' },
          direction: 'asc', nulls: 'first', canonicalRowTieBreaker: true,
        }],
        resultMode: { kind: 'ordered' },
      }
      const insertSelect = compileMutation({
        kind: 'insert', id: 130, target: { kind: 'name', name: 'target_rows' },
        columns: ['id', 'value', 'score'], rows: [], source, conflict: 'error',
        affectedRows: { kind: 'exactly', count: 2n },
      }, compiledSchema.catalog)
      expect(executeCompiledMutation(database, insertSelect, context)).toBe(2n)

      const doNothing = compileMutation({
        kind: 'upsert', id: 140, target: { kind: 'name', name: 'target_rows' }, alias: 'target',
        columns: ['id', 'value', 'score'], row: [integer(141, 2n), text(142, 'replaced'), integer(143, 20n)],
        constraint: 'target_rows_value_uq', updates: [], affectedRows: { kind: 'exactly', count: 0n },
      }, compiledSchema.catalog)
      expect(executeCompiledMutation(database, doNothing, context)).toBe(0n)

      const update = compileMutation({
        kind: 'upsert', id: 150, target: { kind: 'name', name: 'target_rows' }, alias: 'target',
        columns: ['id', 'value', 'score'], row: [integer(151, 2n), text(152, 'replaced'), integer(153, 20n)],
        constraint: 'target_rows_value_uq',
        updates: [{ column: 'score', value: { kind: 'old_new', id: 154, scope: 'new', column: 'score' } }],
        where: {
          kind: 'binary', id: 155, operator: 'gt',
          left: { kind: 'old_new', id: 156, scope: 'new', column: 'score' },
          right: { kind: 'old_new', id: 157, scope: 'old', column: 'score' },
        },
        affectedRows: { kind: 'exactly', count: 1n },
      }, compiledSchema.catalog)
      expect(executeCompiledMutation(database, update, context)).toBe(1n)

      const singletonIgnore = compileMutation({
        kind: 'update', id: 160, target: { kind: 'name', name: 'target_rows' }, alias: 'target',
        conflict: 'ignore', assignments: [{ column: 'value', value: text(161, 'replaced') }],
        where: {
          kind: 'binary', id: 162, operator: 'eq',
          left: { kind: 'column', id: 163, relation: 'target', name: 'id' },
          right: integer(164, 10n),
        },
        affectedRows: { kind: 'exactly', count: 0n },
      }, compiledSchema.catalog)
      expect(executeCompiledMutation(database, singletonIgnore, context)).toBe(0n)

      const singletonReplace = compileMutation({
        kind: 'update', id: 165, target: { kind: 'name', name: 'target_rows' }, alias: 'target',
        conflict: 'replace', assignments: [{ column: 'value', value: text(166, 'replaced') }],
        where: {
          kind: 'binary', id: 167, operator: 'eq',
          left: { kind: 'column', id: 168, relation: 'target', name: 'id' },
          right: integer(169, 10n),
        },
        affectedRows: { kind: 'exactly', count: 1n },
      }, compiledSchema.catalog)
      expect(executeCompiledMutation(database, singletonReplace, context)).toBe(1n)

      const scalarSource: Query = {
        id: 170, ctes: [], joins: [], groupBy: [], windows: [], compounds: [], orderBy: [],
        from: { kind: 'table', id: 171, name: 'source_rows', alias: 'source' },
        where: {
          kind: 'binary', id: 172, operator: 'eq',
          left: { kind: 'column', id: 173, relation: 'source', name: 'id' },
          right: integer(174, 10n),
        },
        projection: [{
          id: 175, name: 'score',
          expression: { kind: 'column', id: 176, relation: 'source', name: 'score' },
        }],
        resultMode: { kind: 'multiset' },
      }
      const updateFrom = compileMutation({
        kind: 'update', id: 180, target: { kind: 'name', name: 'target_rows' }, alias: 'target',
        from: scalarSource, fromAlias: 'snapshot',
        assignments: [{ column: 'score', value: { kind: 'column', id: 181, relation: 'snapshot', name: 'score' } }],
        where: {
          kind: 'binary', id: 182, operator: 'eq',
          left: { kind: 'column', id: 183, relation: 'target', name: 'id' },
          right: integer(184, 11n),
        },
        affectedRows: { kind: 'exactly', count: 1n },
      }, compiledSchema.catalog)
      expect(executeCompiledMutation(database, updateFrom, context)).toBe(1n)
      expect(executeLocalSql(database, 'SELECT score FROM target_rows WHERE id = 11').rows).toEqual([
        [{ kind: 'integer', value: '10' }],
      ])

      const keyPreservingUpdateFrom = compileMutation({
        kind: 'update', id: 185, target: { kind: 'name', name: 'target_rows' }, alias: 'target',
        from: source, fromAlias: 'snapshot',
        assignments: [{ column: 'score', value: { kind: 'column', id: 186, relation: 'snapshot', name: 'score' } }],
        where: {
          kind: 'binary', id: 187, operator: 'eq',
          left: { kind: 'column', id: 188, relation: 'target', name: 'id' },
          right: { kind: 'column', id: 189, relation: 'snapshot', name: 'id' },
        },
        affectedRows: { kind: 'exactly', count: 2n },
      }, compiledSchema.catalog)
      expect(executeCompiledMutation(database, keyPreservingUpdateFrom, context)).toBe(2n)
      expect(executeLocalSql(database, 'SELECT score FROM target_rows WHERE id = 11').rows).toEqual([
        [{ kind: 'integer', value: '11' }],
      ])

      const upsertSelect = compileMutation({
        kind: 'upsert', id: 190, target: { kind: 'name', name: 'target_rows' }, alias: 'target',
        columns: ['id', 'value', 'score'], row: [], source,
        constraint: 'target_rows_pk',
        updates: [{ column: 'score', value: { kind: 'old_new', id: 191, scope: 'new', column: 'score' } }],
        affectedRows: { kind: 'exactly', count: 2n },
      }, compiledSchema.catalog)
      expect(executeCompiledMutation(database, upsertSelect, context)).toBe(2n)

      expect(executeLocalSql(database, 'SELECT id, value, score FROM target_rows ORDER BY id').rows).toEqual([
        [{ kind: 'integer', value: '10' }, { kind: 'text', value: 'replaced' }, { kind: 'integer', value: '10' }],
        [{ kind: 'integer', value: '11' }, { kind: 'text', value: 'eleven' }, { kind: 'integer', value: '11' }],
      ])
      expect(executeLocalSql(database, 'SELECT id, value, score FROM default_rows').rows).toEqual([
        [{ kind: 'integer', value: '100' }, { kind: 'text', value: 'default' }, { kind: 'integer', value: '7' }],
      ])
    } finally {
      database.close()
    }
  })

  it('normalizes step-time SQLite evaluation errors with command attribution', () => {
    const compiledSchema = compileSchema(schema, manifest)
    const database = new DatabaseSync(':memory:') as unknown as DatabaseLike
    try {
      assertNativeSecurityConfiguration(database.configureSecurity())
      database.exec('PRAGMA foreign_keys = ON')
      database.exec('PRAGMA trusted_schema = OFF')
      configureSqliteLimits(database)
      for (const statement of compiledSchema.statements) database.exec(statement.sql)
      database.exec("INSERT INTO target_rows VALUES (1, 'minimum', -9223372036854775808)")

      const update = compileMutation({
        kind: 'update', id: 300, target: { kind: 'name', name: 'target_rows' }, alias: 'target',
        assignments: [{
          column: 'score',
          value: {
            kind: 'builtin', id: 301, name: 'abs',
            args: [{ kind: 'column', id: 302, relation: 'target', name: 'score' }],
          },
        }],
        where: {
          kind: 'binary', id: 303, operator: 'eq',
          left: { kind: 'column', id: 304, relation: 'target', name: 'id' },
          right: integer(305, 1n),
        },
        affectedRows: { kind: 'exactly', count: 1n },
      }, compiledSchema.catalog)

      expect(() => executeCompiledMutation(database, update, context)).toThrowError(
        expect.objectContaining({ code: 'SQL_EVALUATION_ERROR', failingCommandId: 300 }),
      )
    } finally {
      database.close()
    }
  })
})
