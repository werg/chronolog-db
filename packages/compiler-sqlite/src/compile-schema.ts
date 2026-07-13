import type {
  Expr,
  LogicalValue,
  SchemaColumn,
  SchemaConstraint,
  SchemaIndex,
  SchemaManifest,
  SchemaTable,
} from '@chronolog/ir'

import { Catalog } from './catalog.js'
import { quoteIdentifier, storageType, valueTypeOf } from './render.js'
import { CompilerError, type CompiledSchema, type SchemaStatement } from './types.js'
import type { ExecutionManifest } from '@chronolog/ir'
import { assertValidExecutionManifest, assertValidSchemaManifest } from '@chronolog/ir'
import { canonicalJsonToText } from '@chronolog/ir'
import { assertDecimalPrecision, decimalRescale, formatDecimal } from '@chronolog/kernels'

export function compileSchema(schema: SchemaManifest, executionManifest: ExecutionManifest): CompiledSchema {
  assertValidSchemaManifest(schema)
  assertValidExecutionManifest(executionManifest)
  const catalog = Catalog.fromManifest(schema, executionManifest)
  assertCoreManifest(executionManifest)
  assertSchemaFeatures(schema, executionManifest)
  const statements: SchemaStatement[] = []
  for (const object of [...schema.objects].sort(compareDeclaration)) {
    if (object.kind === 'table') statements.push({ objectId: object.id, sql: renderTable(object, catalog), parameters: [] })
    else if (object.kind === 'index') statements.push({ objectId: object.id, sql: renderIndex(object, catalog), parameters: [] })
    else throw new CompilerError('SCHEMA_OBJECT_UNSUPPORTED', object.id, 'schema')
  }
  const seeds = [...schema.seedRows].sort((left, right) => left.tableId - right.tableId || compareSeed(left.values, right.values))
  let seedId = Number.MAX_SAFE_INTEGER - seeds.length
  for (const seed of seeds) {
    const table = catalog.tableById(seed.tableId)
    const primary = catalog.primaryKey(table)
    for (const id of primary.columnIds) {
      if (!seed.values.has(id)) throw new CompilerError('SCHEMA_SEED_PRIMARY_KEY_REQUIRED', table.id, 'schema')
    }
    const columns = [...seed.values.keys()].map((id) => catalog.columnById(table, id)).sort((left, right) => left.id - right.id)
    const parameters = columns.map((column, index) => {
      const value = seed.values.get(column.id)
      if (value === undefined) throw new CompilerError('SCHEMA_SEED_VALUE_MISSING', column.id, 'schema')
      assertAssignable(column, value)
      return { ordinal: index + 1, valueType: column.valueType, source: { kind: 'literal' as const, value } }
    })
    statements.push({
      objectId: seedId,
      sql: `INSERT INTO ${quoteIdentifier(table.name)} (${columns.map((column) => quoteIdentifier(column.name)).join(', ')}) VALUES (${parameters.map((parameter) => `?${parameter.ordinal}`).join(', ')})`,
      parameters,
    })
    seedId += 1
  }
  return { schema, executionManifest, catalog, statements }
}

function renderTable(table: SchemaTable, catalog: Catalog): string {
  const columns = [...table.columns].sort((left, right) => left.declarationOrder - right.declarationOrder || left.id - right.id)
  const definitions = columns.map((column) => renderColumn(column))
  for (const constraint of [...table.constraints].sort((left, right) => left.id - right.id)) {
    definitions.push(renderConstraint(table, constraint, catalog))
  }
  const options = table.withoutRowId ? ' STRICT, WITHOUT ROWID' : ' STRICT'
  return `CREATE TABLE ${quoteIdentifier(table.name)} (${definitions.join(', ')})${options}`
}

function renderColumn(column: SchemaColumn): string {
  const type = storageType(column.valueType.logical)
  const parts = [quoteIdentifier(column.name), type]
  if (!column.valueType.nullable) parts.push('NOT NULL')
  if (column.defaultValue !== undefined) {
    assertAssignable(column, column.defaultValue)
    parts.push(`DEFAULT ${renderSchemaLiteral(column.defaultValue)}`)
  }
  switch (column.valueType.logical.kind) {
    case 'boolean': parts.push(`CHECK (${quoteIdentifier(column.name)} IN (0, 1))`); break
    case 'uuid': parts.push(`CHECK (length(${quoteIdentifier(column.name)}) = 16)`); break
    case 'blob': {
      const maximum = column.valueType.logical.maxBytes
      if (maximum !== undefined) parts.push(`CHECK (length(${quoteIdentifier(column.name)}) <= ${maximum})`)
      break
    }
    case 'decimal': parts.push(`CHECK (typeof(${quoteIdentifier(column.name)}) = 'text')`); break
    case 'json': parts.push(`CHECK (typeof(${quoteIdentifier(column.name)}) = 'text')`); break
    case 'vector': parts.push(`CHECK (length(${quoteIdentifier(column.name)}) = ${
      vectorElementWidth(column.valueType.logical.element) * column.valueType.logical.dimensions
    })`); break
  }
  return parts.join(' ')
}

function renderConstraint(table: SchemaTable, constraint: SchemaConstraint, catalog: Catalog): string {
  const prefix = `CONSTRAINT ${quoteIdentifier(constraint.name)} `
  if (constraint.kind === 'check') return `${prefix}CHECK (${renderSchemaExpression(constraint.expression, table, catalog)})`
  const columns = constraint.columnIds.map((id) => quoteIdentifier(catalog.columnById(table, id).name)).join(', ')
  if (constraint.kind === 'primary_key') return `${prefix}PRIMARY KEY (${columns})`
  if (constraint.kind === 'unique') return `${prefix}UNIQUE (${columns})`
  const target = catalog.tableById(constraint.targetTableId)
  const targetColumns = constraint.targetColumnIds.map((id) => quoteIdentifier(catalog.columnById(target, id).name)).join(', ')
  const onDelete = constraint.onDelete === 'set_null' ? 'SET NULL' : constraint.onDelete.toUpperCase()
  return `${prefix}FOREIGN KEY (${columns}) REFERENCES ${quoteIdentifier(target.name)} (${targetColumns}) ON DELETE ${onDelete} ON UPDATE ${constraint.onUpdate.toUpperCase()}`
}

function renderIndex(index: SchemaIndex, catalog: Catalog): string {
  const table = catalog.tableById(index.tableId)
  if (index.expressions.length === 0) throw new CompilerError('SCHEMA_INDEX_EXPRESSION_REQUIRED', index.id, 'schema')
  const expressions = index.expressions.map((expression) => renderSchemaExpression(expression, table, catalog)).join(', ')
  const where = index.where === undefined ? '' : ` WHERE ${renderSchemaExpression(index.where, table, catalog)}`
  return `CREATE ${index.unique ? 'UNIQUE ' : ''}INDEX ${quoteIdentifier(index.name)} ON ${quoteIdentifier(table.name)} (${expressions})${where}`
}

function renderSchemaExpression(expression: Expr, table: SchemaTable, catalog: Catalog): string {
  switch (expression.kind) {
    case 'literal': return renderSchemaLiteral(expression.value)
    case 'column': {
      if (expression.relation !== undefined && expression.relation !== table.name) throw new CompilerError('SCHEMA_EXPRESSION_RELATION_INVALID', expression.id, 'schema')
      return quoteIdentifier(catalog.column(table, expression.name).name)
    }
    case 'unary': {
      const operand = renderSchemaExpression(expression.operand, table, catalog)
      if (expression.operator === 'not') return `(NOT ${operand})`
      if (expression.operator === 'is_null') return `(${operand} IS NULL)`
      if (expression.operator === 'is_not_null') return `(${operand} IS NOT NULL)`
      throw new CompilerError('SCHEMA_EXPRESSION_UNSUPPORTED', expression.id, 'schema')
    }
    case 'binary': {
      const operators: Record<string, string | undefined> = {
        and: 'AND', or: 'OR', eq: '=', ne: '<>', lt: '<', lte: '<=', gt: '>', gte: '>=',
        concat: '||', is: 'IS', is_not: 'IS NOT',
      }
      const operator = operators[expression.operator]
      if (operator === undefined) throw new CompilerError('SCHEMA_EXPRESSION_UNSUPPORTED', expression.id, 'schema')
      return `(${renderSchemaExpression(expression.left, table, catalog)} ${operator} ${renderSchemaExpression(expression.right, table, catalog)})`
    }
    case 'conditional': return `(CASE ${expression.branches.map((branch) =>
      `WHEN ${renderSchemaExpression(branch.when, table, catalog)} THEN ${renderSchemaExpression(branch.then, table, catalog)}`,
    ).join(' ')} ELSE ${renderSchemaExpression(expression.otherwise, table, catalog)} END)`
    default: throw new CompilerError('SCHEMA_EXPRESSION_UNSUPPORTED', expression.id, 'schema')
  }
}

function renderSchemaLiteral(value: LogicalValue): string {
  switch (value.kind) {
    case 'null': return 'NULL'
    case 'boolean': return value.value ? '1' : '0'
    case 'int64':
    case 'timestamp_ms':
    case 'duration_ms': return value.value.toString(10)
    case 'text': {
      const decoded = new TextDecoder('utf-8', { fatal: true }).decode(value.utf8)
      return decoded.includes('\0')
        ? `(CAST(X'${hex(value.utf8)}' AS TEXT))`
        : `'${decoded.replaceAll("'", "''")}'`
    }
    case 'blob': return `X'${hex(value.bytes)}'`
    case 'uuid':
      if (value.bytes.length !== 16) throw new CompilerError('IR_UUID_LENGTH')
      return `X'${hex(value.bytes)}'`
    case 'decimal': return `'${formatDecimal(assertDecimalPrecision(value, decimalPrecision(value.coefficient)))}'`
    case 'json': return `'${canonicalJsonToText(value.value).replaceAll("'", "''")}'`
    case 'vector': return `X'${hex(value.bytes)}'`
    default: throw new CompilerError('SCHEMA_LITERAL_UNSUPPORTED')
  }
}

function assertAssignable(column: SchemaColumn, value: LogicalValue): void {
  if (value.kind === 'null') {
    if (!column.valueType.nullable) throw new CompilerError('SCHEMA_NULL_NOT_ALLOWED', column.id, 'schema')
    return
  }
  const actual = valueTypeOf(value).logical.kind
  if (actual !== column.valueType.logical.kind) throw new CompilerError('SCHEMA_SEED_TYPE_MISMATCH', column.id, 'schema')
  if (value.kind === 'decimal' && column.valueType.logical.kind === 'decimal') {
    if (value.scale > column.valueType.logical.scale) throw new CompilerError('SCHEMA_DECIMAL_SCALE_MISMATCH', column.id, 'schema')
    try {
      assertDecimalPrecision(decimalRescale(value, column.valueType.logical.scale, 'exact'), column.valueType.logical.precision)
    } catch { throw new CompilerError('SCHEMA_DECIMAL_PRECISION_OVERFLOW', column.id, 'schema') }
  }
  if (value.kind === 'vector' && column.valueType.logical.kind === 'vector') {
    const expected = vectorElementWidth(column.valueType.logical.element) * column.valueType.logical.dimensions
    if (value.element !== column.valueType.logical.element || value.dimensions !== column.valueType.logical.dimensions || value.bytes.length !== expected) {
      throw new CompilerError('SCHEMA_VECTOR_SHAPE_MISMATCH', column.id, 'schema')
    }
  }
}

function assertCoreManifest(manifest: ExecutionManifest): void {
  if (manifest.features.fts || manifest.features.spatial || manifest.features.wasm) {
    throw new CompilerError('EXECUTION_FEATURE_UNSUPPORTED')
  }
  if (manifest.functions.length > 0 || manifest.collations.length > 0 || manifest.modules.length > 0) {
    throw new CompilerError('EXECUTION_REGISTRY_UNSUPPORTED')
  }
  if (manifest.resources.maxQueryRows > 10_000 ||
      manifest.resources.maxResultBytes > 16 * 1024 * 1024 ||
      manifest.resources.maxExpressionDepth > 100 ||
      manifest.resources.maxVectorDimensions > 4_096) {
    throw new CompilerError('EXECUTION_RESOURCE_LIMIT_UNSUPPORTED')
  }
}

function assertSchemaFeatures(schema: SchemaManifest, manifest: ExecutionManifest): void {
  for (const object of schema.objects) {
    if (object.kind !== 'table') continue
    for (const column of object.columns) {
      const kind = column.valueType.logical.kind
      if (kind === 'decimal' && !manifest.features.decimal) throw new CompilerError('DECIMAL_FEATURE_DISABLED', column.id, 'schema')
      if (kind === 'json' && !manifest.features.json) throw new CompilerError('JSON_FEATURE_DISABLED', column.id, 'schema')
      if (kind === 'vector' && !manifest.features.vector) throw new CompilerError('VECTOR_FEATURE_DISABLED', column.id, 'schema')
      if (kind === 'vector' && column.valueType.logical.dimensions > manifest.resources.maxVectorDimensions) {
        throw new CompilerError('VECTOR_RESOURCE_EXCEEDED', column.id, 'schema')
      }
    }
  }
}

function decimalPrecision(coefficient: bigint): number {
  return (coefficient < 0n ? -coefficient : coefficient).toString(10).length
}

function vectorElementWidth(element: Extract<LogicalValue, { kind: 'vector' }>['element']): number {
  return element === 'i8' || element === 'u8' ? 1 : element === 'i16' ? 2 : 4 + (element === 'f64' ? 4 : 0)
}

function compareDeclaration(left: { declarationOrder: number; id: number }, right: { declarationOrder: number; id: number }): number {
  return left.declarationOrder - right.declarationOrder || left.id - right.id
}

function compareSeed(left: ReadonlyMap<number, LogicalValue>, right: ReadonlyMap<number, LogicalValue>): number {
  const leftText = [...left.entries()].sort(([a], [b]) => a - b).map(([id, value]) => `${id}:${stableValue(value)}`).join('|')
  const rightText = [...right.entries()].sort(([a], [b]) => a - b).map(([id, value]) => `${id}:${stableValue(value)}`).join('|')
  return leftText < rightText ? -1 : leftText > rightText ? 1 : 0
}

function stableValue(value: LogicalValue): string {
  if (value.kind === 'null') return '0'
  if ('value' in value && typeof value.value !== 'object') return `${value.kind}:${String(value.value)}`
  if (value.kind === 'text') return `text:${hex(value.utf8)}`
  if (value.kind === 'blob' || value.kind === 'uuid') return `${value.kind}:${hex(value.bytes)}`
  return value.kind
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}
