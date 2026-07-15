import type {
  ExecutionManifest,
  RegisteredCollation,
  RegisteredFunction,
  SchemaColumn,
  SchemaConstraint,
  SchemaIndex,
  SchemaManifest,
  SchemaObject,
  SchemaTable,
  SchemaView,
} from '@chronolog/ir'
import {
  isReservedSchemaObjectName,
  isValidSqlIdentifier,
  sqliteIdentifierKey,
} from '@chronolog/ir'

import { CompilerError } from './types.js'

export class Catalog {
  readonly schema: SchemaManifest
  readonly manifest: ExecutionManifest
  readonly #objectsById = new Map<number, SchemaObject>()
  readonly #objectsByName = new Map<string, SchemaObject>()
  readonly #columnsByTable = new Map<number, ReadonlyMap<string, SchemaColumn>>()
  readonly #transactionLogTable: SchemaTable

  private constructor(schema: SchemaManifest, manifest: ExecutionManifest) {
    this.schema = schema
    this.manifest = manifest
    this.#transactionLogTable = transactionLogTable()
    this.#columnsByTable.set(
      this.#transactionLogTable.id,
      new Map(this.#transactionLogTable.columns.map((column) => [sqliteIdentifierKey(column.name), column])),
    )
  }

  systemRelation(relation: 'transaction_log'): SchemaTable {
    if (relation !== 'transaction_log') throw new CompilerError('IR_SYSTEM_RELATION_UNSUPPORTED')
    return this.#transactionLogTable
  }

  static fromManifest(schema: SchemaManifest, manifest: ExecutionManifest): Catalog {
    const catalog = new Catalog(schema, manifest)
    catalog.#construct()
    return catalog
  }

  object(reference: { readonly kind: 'name'; readonly name: string } | { readonly kind: 'id'; readonly objectId: number }): SchemaObject {
    const object = reference.kind === 'name'
      ? this.#objectsByName.get(sqliteIdentifierKey(reference.name))
      : this.#objectsById.get(reference.objectId)
    if (object === undefined) throw new CompilerError('IR_UNKNOWN_SCHEMA_OBJECT')
    return object
  }

  table(reference: { readonly kind: 'name'; readonly name: string } | { readonly kind: 'id'; readonly objectId: number }): SchemaTable {
    const object = this.object(reference)
    if (object.kind !== 'table') throw new CompilerError('IR_TARGET_NOT_TABLE', object.id)
    return object
  }

  tableByName(name: string): SchemaTable {
    return this.table({ kind: 'name', name })
  }

  tableById(id: number): SchemaTable {
    return this.table({ kind: 'id', objectId: id })
  }

  viewByName(name: string): SchemaView {
    const object = this.object({ kind: 'name', name })
    if (object.kind !== 'view') throw new CompilerError('IR_TARGET_NOT_VIEW', object.id)
    return object
  }

  column(table: SchemaTable, name: string): SchemaColumn {
    const column = this.#columnsByTable.get(table.id)?.get(sqliteIdentifierKey(name))
    if (column === undefined) throw new CompilerError('IR_UNKNOWN_COLUMN', table.id)
    return column
  }

  columnById(table: SchemaTable, id: number): SchemaColumn {
    const column = table.columns.find((candidate) => candidate.id === id)
    if (column === undefined) throw new CompilerError('IR_UNKNOWN_COLUMN', table.id)
    return column
  }

  primaryKey(table: SchemaTable): Extract<SchemaConstraint, { kind: 'primary_key' }> {
    const keys = table.constraints.filter(
      (constraint): constraint is Extract<SchemaConstraint, { kind: 'primary_key' }> => constraint.kind === 'primary_key',
    )
    if (keys.length !== 1) throw new CompilerError('SCHEMA_PRIMARY_KEY_REQUIRED', table.id, 'schema')
    return keys[0]!
  }

  namedUnique(table: SchemaTable, name: string): Extract<SchemaConstraint, { kind: 'primary_key' | 'unique' }> {
    const key = sqliteIdentifierKey(name)
    const constraints = table.constraints.filter(
      (candidate): candidate is Extract<SchemaConstraint, { kind: 'primary_key' | 'unique' }> =>
        (candidate.kind === 'primary_key' || candidate.kind === 'unique') && sqliteIdentifierKey(candidate.name) === key,
    )
    if (constraints.length === 0) throw new CompilerError('IR_UNKNOWN_UNIQUE_CONSTRAINT', table.id, 'constraint')
    if (constraints.length > 1) throw new CompilerError('IR_AMBIGUOUS_UNIQUE_CONSTRAINT', table.id, 'constraint')
    return constraints[0]!
  }

  uniqueConstraintById(
    table: SchemaTable,
    id: number,
  ): Extract<SchemaConstraint, { kind: 'primary_key' | 'unique' }> {
    const constraint = table.constraints.find((candidate) => candidate.id === id)
    if (constraint?.kind !== 'primary_key' && constraint?.kind !== 'unique') {
      throw new CompilerError('IR_UNKNOWN_UNIQUE_CONSTRAINT', id, 'constraint')
    }
    return constraint
  }

  uniqueIndexById(table: SchemaTable, id: number): SchemaIndex {
    const index = this.#objectsById.get(id)
    if (index?.kind !== 'index' || !index.unique || index.tableId !== table.id) {
      throw new CompilerError('IR_UNKNOWN_UNIQUE_INDEX', id, 'constraint')
    }
    return index
  }

  functionById(id: number): RegisteredFunction {
    if (!this.schema.functionIds.includes(id)) throw new CompilerError('IR_FUNCTION_NOT_ENABLED', id)
    const fn = this.manifest.functions.find((candidate) => candidate.id === id)
    if (fn === undefined) throw new CompilerError('IR_FUNCTION_UNREGISTERED', id)
    return fn
  }

  collationById(id: number): RegisteredCollation {
    if (!this.schema.collationIds.includes(id)) throw new CompilerError('IR_COLLATION_NOT_ENABLED', id)
    const collation = this.manifest.collations.find((candidate) => candidate.id === id)
    if (collation === undefined) throw new CompilerError('IR_COLLATION_UNREGISTERED', id)
    return collation
  }

  #construct(): void {
    if (this.schema.version !== 1 || this.manifest.version !== 1) throw new CompilerError('MANIFEST_VERSION_UNSUPPORTED')
    assertIdentifier(this.schema.name, null)
    for (const object of [...this.schema.objects].sort((left, right) => left.id - right.id)) {
      assertId(object.id, 'SCHEMA_OBJECT_ID_INVALID')
      assertSchemaObjectIdentifier(object.name, object.id)
      const objectNameKey = sqliteIdentifierKey(object.name)
      if (this.#objectsById.has(object.id) || this.#objectsByName.has(objectNameKey)) {
        throw new CompilerError('SCHEMA_DUPLICATE_OBJECT', object.id, 'schema')
      }
      this.#objectsById.set(object.id, object)
      this.#objectsByName.set(objectNameKey, object)
      if (object.kind === 'table') this.#registerTable(object)
    }
    for (const object of this.#objectsById.values()) {
      if (object.kind !== 'table') continue
      this.primaryKey(object)
      for (const constraint of object.constraints) this.#validateConstraint(object, constraint)
    }
  }

  #registerTable(table: SchemaTable): void {
    const byName = new Map<string, SchemaColumn>()
    const ids = new Set<number>()
    for (const column of table.columns) {
      assertId(column.id, 'SCHEMA_COLUMN_ID_INVALID')
      assertIdentifier(column.name, column.id)
      const columnNameKey = sqliteIdentifierKey(column.name)
      if (ids.has(column.id) || byName.has(columnNameKey)) {
        throw new CompilerError('SCHEMA_DUPLICATE_COLUMN', column.id, 'schema')
      }
      ids.add(column.id)
      byName.set(columnNameKey, column)
      if (column.generated !== undefined) {
        throw new CompilerError('SCHEMA_GENERATED_COLUMN_UNSUPPORTED', column.id, 'schema')
      }
      if (column.valueType.logical.kind === 'text' &&
          column.valueType.logical.collation.startsWith('registered:')) {
        const id = Number(column.valueType.logical.collation.slice('registered:'.length))
        if (!Number.isSafeInteger(id)) throw new CompilerError('SCHEMA_COLLATION_INVALID', column.id, 'schema')
        this.collationById(id)
      }
    }
    this.#columnsByTable.set(table.id, byName)
  }

  #validateConstraint(table: SchemaTable, constraint: SchemaConstraint): void {
    assertId(constraint.id, 'SCHEMA_CONSTRAINT_ID_INVALID')
    assertIdentifier(constraint.name, constraint.id)
    if (constraint.kind === 'check') return
    for (const columnId of constraint.columnIds) this.columnById(table, columnId)
    if (constraint.kind === 'foreign_key') {
      const target = this.tableById(constraint.targetTableId)
      if (constraint.targetColumnIds.length !== constraint.columnIds.length) {
        throw new CompilerError('SCHEMA_FOREIGN_KEY_ARITY', constraint.id, 'constraint')
      }
      for (const columnId of constraint.targetColumnIds) this.columnById(target, columnId)
    }
  }
}

function transactionLogTable(): SchemaTable {
  const text = { logical: { kind: 'text' as const, collation: 'binary' as const }, nullable: false }
  const blob = { logical: { kind: 'blob' as const }, nullable: false }
  const int64 = { logical: { kind: 'int64' as const }, nullable: false }
  const nullableText = { ...text, nullable: true }
  const nullableInt = { ...int64, nullable: true }
  const nullableBlob = { ...blob, nullable: true }
  const columns: SchemaColumn[] = [
    { id: -101, name: 'tx_id', declarationOrder: 0, valueType: blob },
    { id: -102, name: 'order_index', declarationOrder: 1, valueType: int64 },
    { id: -103, name: 'author_id', declarationOrder: 2, valueType: blob },
    { id: -104, name: 'author_timestamp_ms', declarationOrder: 3, valueType: text },
    { id: -105, name: 'author_feed_sequence', declarationOrder: 4, valueType: text },
    { id: -106, name: 'candidate_digest', declarationOrder: 5, valueType: blob },
    { id: -107, name: 'canonical_candidate', declarationOrder: 6, valueType: blob },
    { id: -108, name: 'outcome', declarationOrder: 7, valueType: text },
    { id: -109, name: 'rejection_code', declarationOrder: 8, valueType: nullableText },
    { id: -110, name: 'failing_precondition_id', declarationOrder: 9, valueType: nullableInt },
    { id: -111, name: 'failing_command_id', declarationOrder: 10, valueType: nullableInt },
    { id: -112, name: 'failing_rule_id', declarationOrder: 11, valueType: nullableInt },
    { id: -113, name: 'failing_constraint_id', declarationOrder: 12, valueType: nullableInt },
    { id: -114, name: 'result_digest', declarationOrder: 13, valueType: nullableBlob },
  ]
  return {
    kind: 'table',
    id: -100,
    name: 'chronolog_transactions',
    declarationOrder: -1,
    columns,
    constraints: [{ kind: 'primary_key', id: -115, name: 'chronolog_transactions_pk', columnIds: [-101] }],
    withoutRowId: false,
  }
}

export function assertIdentifier(name: string, id: number | null): void {
  if (!isValidSqlIdentifier(name)) {
    throw new CompilerError('SCHEMA_IDENTIFIER_INVALID', id, 'schema')
  }
}

function assertSchemaObjectIdentifier(name: string, id: number | null): void {
  assertIdentifier(name, id)
  if (isReservedSchemaObjectName(name)) throw new CompilerError('SCHEMA_IDENTIFIER_RESERVED', id, 'schema')
}

function assertId(id: number, code: string): void {
  if (!Number.isSafeInteger(id) || id < 0) throw new CompilerError(code, null, 'schema')
}
