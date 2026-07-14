import {
  DEFAULT_DECODE_LIMITS,
  assertCanonicalCbor,
  canonicalInvariant,
  decodeUtf8,
  encodeCanonicalCbor,
  expectArray,
  expectBigint,
  expectBoolean,
  expectBytes,
  expectMap,
  expectString,
  hashDomain,
  integerMap,
  optional,
  required,
  utf8,
  type CborMapKey,
  type CborValue,
  type DecodeLimits,
} from '@chronolog/canonical'

import { IR_TAGS } from './tags.js'
import {
  assertValidExecutionManifest,
  assertValidSchemaManifest,
  assertValidTransactionProgram,
  validateCanonicalQueryResult,
  validateLogicalType,
  validateLogicalValue,
  validateQuery,
} from './validation.js'
import type {
  CanonicalJsonValue,
  CanonicalQueryResult,
  CollationId,
  ExecutionManifest,
  LogicalType,
  LogicalValue,
  Mutation,
  Precondition,
  Query,
  SchemaManifest,
  TransactionProgram,
  VectorElementType,
} from './types.js'

export const IR_DECODE_LIMITS: Readonly<DecodeLimits> = Object.freeze({
  ...DEFAULT_DECODE_LIMITS,
  maxBytes: 8 * 1024 * 1024,
  maxDepth: 96,
  maxArrayItems: 100_000,
  maxMapItems: 100_000,
  maxTextBytes: 2 * 1024 * 1024,
  maxBlobBytes: 8 * 1024 * 1024,
})

const KIND_TAG = new Map<string, number>([
  ['literal', IR_TAGS.exprLiteral], ['parameter', IR_TAGS.exprParameter], ['column', IR_TAGS.exprColumn],
  ['context', IR_TAGS.exprContext], ['old_new', IR_TAGS.exprOldNew], ['unary', IR_TAGS.exprUnary],
  ['binary', IR_TAGS.exprBinary], ['conditional', IR_TAGS.exprConditional], ['cast', IR_TAGS.exprCast],
  ['function', IR_TAGS.exprFunction], ['scalar_subquery', IR_TAGS.exprScalarSubquery], ['exists', IR_TAGS.exprExists],
  ['membership', IR_TAGS.exprMembership], ['entropy', IR_TAGS.exprEntropy],
  ['insert', IR_TAGS.mutationInsert], ['update', IR_TAGS.mutationUpdate], ['delete', IR_TAGS.mutationDelete],
  ['upsert', IR_TAGS.mutationUpsert], ['merge', IR_TAGS.mutationMerge], ['stateful_call', IR_TAGS.mutationStatefulCall],
  ['assert', IR_TAGS.preconditionAssert], ['expect', IR_TAGS.preconditionExpect],
  ['inline', IR_TAGS.expectedInline], ['digest', IR_TAGS.expectedDigest],
  ['scalar', IR_TAGS.resultScalar], ['ordered', IR_TAGS.resultOrdered], ['multiset', IR_TAGS.resultMultiset], ['set', IR_TAGS.resultSet],
  ['unconstrained', IR_TAGS.affectedUnconstrained], ['exactly', IR_TAGS.affectedExactly],
  ['at_least', IR_TAGS.affectedAtLeast], ['at_most', IR_TAGS.affectedAtMost], ['range', IR_TAGS.affectedRange],
  ['primary_key', IR_TAGS.constraintPrimaryKey], ['unique', IR_TAGS.constraintUnique],
  ['check', IR_TAGS.constraintCheck], ['foreign_key', IR_TAGS.constraintForeignKey],
  ['fts_index', IR_TAGS.schemaFtsIndex], ['vector_index', IR_TAGS.schemaVectorIndex], ['spatial_index', IR_TAGS.schemaSpatialIndex],
  ['system_relation', IR_TAGS.relationSystem],
])

const TAG_KIND = new Map<number, string>([...KIND_TAG].map(([kind, tag]) => [tag, kind]))
const NON_DISCRIMINATED_RECORD_TAGS = new Set<number>([
  IR_TAGS.cte, IR_TAGS.join, IR_TAGS.projection, IR_TAGS.orderTerm, IR_TAGS.window,
  IR_TAGS.compound, IR_TAGS.query, IR_TAGS.mergeClause, IR_TAGS.resultColumn,
  IR_TAGS.schemaManifest, IR_TAGS.schemaColumn, IR_TAGS.seedRow, IR_TAGS.executionManifest,
  IR_TAGS.registeredFunction, IR_TAGS.registeredCollation, IR_TAGS.registeredModule,
  IR_TAGS.valueType, IR_TAGS.conditionalBranch, IR_TAGS.page, IR_TAGS.assignment,
  IR_TAGS.canonicalQueryResult, IR_TAGS.executionFeatures, IR_TAGS.semanticResourceLimits,
])

/** Field positions are part of the signed wire format. Append only; never reorder. */
const TAG_FIELDS = new Map<number, readonly string[]>([
  [IR_TAGS.exprLiteral, ['id', 'value']],
  [IR_TAGS.exprParameter, ['id', 'name', 'valueType']],
  [IR_TAGS.exprColumn, ['id', 'relation', 'name']],
  [IR_TAGS.exprContext, ['id', 'field']],
  [IR_TAGS.exprOldNew, ['id', 'scope', 'column']],
  [IR_TAGS.exprUnary, ['id', 'operator', 'operand']],
  [IR_TAGS.exprBinary, ['id', 'operator', 'left', 'right']],
  [IR_TAGS.exprConditional, ['id', 'branches', 'otherwise']],
  [IR_TAGS.exprCast, ['id', 'value', 'target']],
  [IR_TAGS.exprFunction, ['id', 'functionId', 'args']],
  [IR_TAGS.exprJson, ['id', 'operation', 'args', 'path']],
  [IR_TAGS.exprScalarSubquery, ['id', 'query']],
  [IR_TAGS.exprExists, ['id', 'query', 'negated']],
  [IR_TAGS.exprMembership, ['id', 'value', 'values', 'query', 'negated']],
  [IR_TAGS.exprEntropy, ['id', 'label', 'index', 'length']],
  [IR_TAGS.valueType, ['logical', 'nullable']],
  [IR_TAGS.conditionalBranch, ['when', 'then']],
  [IR_TAGS.relationTable, ['id', 'name', 'alias']],
  [IR_TAGS.relationView, ['id', 'name', 'alias']],
  [IR_TAGS.relationSubquery, ['id', 'query', 'alias']],
  [IR_TAGS.relationCte, ['id', 'name', 'alias']],
  [IR_TAGS.relationTableFunction, ['id', 'functionId', 'args', 'alias']],
  [IR_TAGS.relationFts, ['id', 'indexId', 'query', 'alias']],
  [IR_TAGS.relationVector, ['id', 'indexId', 'vector', 'limit', 'alias']],
  [IR_TAGS.relationSpatial, ['id', 'indexId', 'predicate', 'alias']],
  [IR_TAGS.relationSystem, ['id', 'relation', 'alias']],
  [IR_TAGS.cte, ['id', 'name', 'query', 'materialized']],
  [IR_TAGS.join, ['id', 'kind', 'relation', 'on']],
  [IR_TAGS.projection, ['id', 'name', 'expression']],
  [IR_TAGS.orderTerm, ['id', 'expression', 'direction', 'nulls', 'canonicalRowTieBreaker']],
  [IR_TAGS.window, ['id', 'name', 'partitionBy', 'orderBy']],
  [IR_TAGS.compound, ['id', 'operator', 'query']],
  [IR_TAGS.page, ['limit', 'offset']],
  [IR_TAGS.query, ['id', 'ctes', 'from', 'joins', 'where', 'groupBy', 'having', 'projection', 'windows', 'compounds', 'orderBy', 'page', 'resultMode']],
  [IR_TAGS.mutationInsert, ['id', 'target', 'columns', 'rows', 'conflict', 'affectedRows', 'returning', 'label']],
  [IR_TAGS.mutationUpdate, ['id', 'target', 'assignments', 'where', 'affectedRows', 'returning', 'label']],
  [IR_TAGS.mutationDelete, ['id', 'target', 'where', 'affectedRows', 'returning', 'label']],
  [IR_TAGS.mutationUpsert, ['id', 'target', 'columns', 'row', 'constraint', 'updates', 'affectedRows', 'returning', 'label']],
  [IR_TAGS.mutationMerge, ['id', 'target', 'source', 'on', 'clauses', 'affectedRows', 'returning', 'label']],
  [IR_TAGS.mutationStatefulCall, ['id', 'moduleId', 'operationId', 'args', 'affectedRows', 'returning', 'label']],
  [IR_TAGS.mergeClause, ['id', 'when', 'predicate', 'action', 'assignments']],
  [IR_TAGS.affectedUnconstrained, []], [IR_TAGS.affectedExactly, ['count']],
  [IR_TAGS.affectedAtLeast, ['count']], [IR_TAGS.affectedAtMost, ['count']],
  [IR_TAGS.affectedRange, ['minimum', 'maximum']],
  [IR_TAGS.objectReferenceName, ['name']], [IR_TAGS.objectReferenceId, ['objectId']],
  [IR_TAGS.assignment, ['column', 'value']],
  [IR_TAGS.preconditionAssert, ['id', 'query', 'unknownIsFailure']],
  [IR_TAGS.preconditionExpect, ['id', 'query', 'expected']],
  [IR_TAGS.expectedInline, ['result']],
  [IR_TAGS.expectedDigest, ['digest', 'resultMode', 'columns']],
  [IR_TAGS.resultScalar, []], [IR_TAGS.resultOrdered, []], [IR_TAGS.resultMultiset, []], [IR_TAGS.resultSet, []],
  [IR_TAGS.resultColumn, ['id', 'name', 'valueType']],
  [IR_TAGS.canonicalQueryResult, ['resultMode', 'columns', 'rows']],
  [IR_TAGS.schemaManifest, ['version', 'name', 'objects', 'seedRows', 'functionIds', 'collationIds', 'moduleIds']],
  [IR_TAGS.schemaTable, ['id', 'name', 'declarationOrder', 'columns', 'constraints', 'withoutRowId']],
  [IR_TAGS.schemaIndex, ['id', 'name', 'declarationOrder', 'tableId', 'expressions', 'unique', 'where']],
  [IR_TAGS.schemaView, ['id', 'name', 'declarationOrder', 'query']],
  [IR_TAGS.schemaRule, ['id', 'name', 'declarationOrder', 'tableId', 'event', 'when', 'mutations', 'effectObjectIds']],
  [IR_TAGS.schemaFtsIndex, ['id', 'name', 'declarationOrder', 'tableId', 'columnIds', 'moduleId']],
  [IR_TAGS.schemaVectorIndex, ['id', 'name', 'declarationOrder', 'tableId', 'columnIds', 'moduleId']],
  [IR_TAGS.schemaSpatialIndex, ['id', 'name', 'declarationOrder', 'tableId', 'columnIds', 'moduleId']],
  [IR_TAGS.schemaColumn, ['id', 'name', 'declarationOrder', 'valueType', 'defaultValue', 'generated']],
  [IR_TAGS.constraintPrimaryKey, ['id', 'name', 'columnIds']],
  [IR_TAGS.constraintUnique, ['id', 'name', 'columnIds']],
  [IR_TAGS.constraintCheck, ['id', 'name', 'expression']],
  [IR_TAGS.constraintForeignKey, ['id', 'name', 'columnIds', 'targetTableId', 'targetColumnIds', 'onDelete', 'onUpdate']],
  [IR_TAGS.seedRow, ['tableId', 'values']],
  [IR_TAGS.executionManifest, ['version', 'profile', 'engine', 'engineDigest', 'functions', 'collations', 'modules', 'features', 'resources']],
  [IR_TAGS.registeredFunction, ['id', 'name', 'arguments', 'result', 'effect', 'implementationDigest']],
  [IR_TAGS.registeredCollation, ['id', 'name', 'implementationDigest']],
  [IR_TAGS.registeredModule, ['id', 'name', 'kind', 'implementationDigest', 'effectObjectIds']],
  [IR_TAGS.executionFeatures, ['decimal', 'json', 'vector', 'fts', 'spatial', 'wasm']],
  [IR_TAGS.semanticResourceLimits, ['maxProgramNodes', 'maxExpressionDepth', 'maxQueryRows', 'maxResultBytes', 'maxJsonDepth', 'maxVectorDimensions', 'maxRuleDepth', 'maxWasmFuel']],
])

const VECTOR_ELEMENTS: readonly VectorElementType[] = ['i8', 'u8', 'i16', 'i32', 'f32', 'f64']
const VALUE_TAGS = new Set<number>([
  IR_TAGS.valueNull, IR_TAGS.valueBoolean, IR_TAGS.valueInt64, IR_TAGS.valueDecimal, IR_TAGS.valueText,
  IR_TAGS.valueBlob, IR_TAGS.valueUuid, IR_TAGS.valueTimestampMs, IR_TAGS.valueDurationMs, IR_TAGS.valueJson, IR_TAGS.valueVector,
])
const TYPE_TAGS = new Set<number>([
  IR_TAGS.typeBoolean, IR_TAGS.typeInt64, IR_TAGS.typeDecimal, IR_TAGS.typeText, IR_TAGS.typeBlob,
  IR_TAGS.typeUuid, IR_TAGS.typeTimestampMs, IR_TAGS.typeDurationMs, IR_TAGS.typeJson, IR_TAGS.typeVector,
])

function uint(value: number, field: string): bigint {
  canonicalInvariant(Number.isSafeInteger(value) && value >= 0, 'SCHEMA_INVALID', `${field} must be an unsigned safe integer`)
  return BigInt(value)
}

function numberMarker(value: number): CborValue { return integerMap([[-1, uint(value, 'number')]]) }

function logicalValueToCbor(value: LogicalValue): CborValue {
  switch (value.kind) {
    case 'null': return [BigInt(IR_TAGS.valueNull)]
    case 'boolean': return [BigInt(IR_TAGS.valueBoolean), value.value]
    case 'int64': return [BigInt(IR_TAGS.valueInt64), value.value]
    case 'decimal': return [BigInt(IR_TAGS.valueDecimal), value.coefficient, uint(value.scale, 'decimal.scale')]
    case 'text': return [BigInt(IR_TAGS.valueText), decodeUtf8(value.utf8)]
    case 'blob': return [BigInt(IR_TAGS.valueBlob), value.bytes]
    case 'uuid': return [BigInt(IR_TAGS.valueUuid), value.bytes]
    case 'timestamp_ms': return [BigInt(IR_TAGS.valueTimestampMs), value.value]
    case 'duration_ms': return [BigInt(IR_TAGS.valueDurationMs), value.value]
    case 'json': return [BigInt(IR_TAGS.valueJson), jsonToCbor(value.value)]
    case 'vector': return [BigInt(IR_TAGS.valueVector), BigInt(VECTOR_ELEMENTS.indexOf(value.element)), uint(value.dimensions, 'vector.dimensions'), value.bytes]
  }
}

function logicalValueFromCbor(value: CborValue): LogicalValue {
  const items = expectArray(value, 'logical_value'), tag = Number(expectBigint(items[0] ?? null, 'logical_value.tag'))
  if (tag === IR_TAGS.valueNull && items.length === 1) return { kind: 'null' }
  if (tag === IR_TAGS.valueBoolean && items.length === 2) return { kind: 'boolean', value: expectBoolean(items[1] ?? null, 'boolean.value') }
  if (tag === IR_TAGS.valueInt64 && items.length === 2) return { kind: 'int64', value: expectBigint(items[1] ?? null, 'int64.value') }
  if (tag === IR_TAGS.valueDecimal && items.length === 3) return { kind: 'decimal', coefficient: expectBigint(items[1] ?? null, 'decimal.coefficient'), scale: Number(expectBigint(items[2] ?? null, 'decimal.scale')) }
  if (tag === IR_TAGS.valueText && items.length === 2) return { kind: 'text', utf8: utf8(expectString(items[1] ?? null, 'text.value')) }
  if (tag === IR_TAGS.valueBlob && items.length === 2) return { kind: 'blob', bytes: expectBytes(items[1] ?? null, 'blob.value') }
  if (tag === IR_TAGS.valueUuid && items.length === 2) return { kind: 'uuid', bytes: expectBytes(items[1] ?? null, 'uuid.value', 16) }
  if (tag === IR_TAGS.valueTimestampMs && items.length === 2) return { kind: 'timestamp_ms', value: expectBigint(items[1] ?? null, 'timestamp.value') }
  if (tag === IR_TAGS.valueDurationMs && items.length === 2) return { kind: 'duration_ms', value: expectBigint(items[1] ?? null, 'duration.value') }
  if (tag === IR_TAGS.valueJson && items.length === 2) return { kind: 'json', value: jsonFromCbor(items[1] ?? null) }
  if (tag === IR_TAGS.valueVector && items.length === 4) {
    const element = VECTOR_ELEMENTS[Number(expectBigint(items[1] ?? null, 'vector.element'))]
    canonicalInvariant(element !== undefined, 'SCHEMA_INVALID', 'Unknown vector element type')
    return { kind: 'vector', element, dimensions: Number(expectBigint(items[2] ?? null, 'vector.dimensions')), bytes: expectBytes(items[3] ?? null, 'vector.bytes') }
  }
  throw new Error(`IR_UNKNOWN_LOGICAL_VALUE_TAG:${tag}`)
}

function jsonToCbor(value: CanonicalJsonValue): CborValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'bigint' || typeof value === 'string') return value
  if (Array.isArray(value)) return (value as readonly CanonicalJsonValue[]).map(jsonToCbor)
  if (value instanceof Map) return new Map([...(value as ReadonlyMap<string, CanonicalJsonValue>)]
    .map(([key, item]) => [key, jsonToCbor(item)]))
  const decimal = value as { readonly kind: 'decimal'; readonly coefficient: bigint; readonly scale: number }
  return [BigInt(IR_TAGS.valueDecimal), decimal.coefficient, uint(decimal.scale, 'json.decimal.scale')]
}

function jsonFromCbor(value: CborValue): CanonicalJsonValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'bigint' || typeof value === 'string') return value
  if (value instanceof Uint8Array) throw new Error('IR_JSON_BLOB_FORBIDDEN')
  if (value instanceof Map) {
    const entries = value as ReadonlyMap<CborMapKey, CborValue>
    const result = new Map<string, CanonicalJsonValue>()
    for (const [key, item] of entries) { canonicalInvariant(typeof key === 'string', 'SCHEMA_INVALID', 'JSON object keys must be text'); result.set(key, jsonFromCbor(item)) }
    return result
  }
  if (Array.isArray(value)) {
    const items = value as readonly CborValue[]
    if (items.length === 3 && items[0] === BigInt(IR_TAGS.valueDecimal)) return { kind: 'decimal', coefficient: expectBigint(items[1] ?? null, 'json.decimal.coefficient'), scale: Number(expectBigint(items[2] ?? null, 'json.decimal.scale')) }
    return items.map(jsonFromCbor)
  }
  throw new Error('IR_INVALID_JSON')
}

function logicalTypeToCbor(type: LogicalType): CborValue {
  switch (type.kind) {
    case 'boolean': return [BigInt(IR_TAGS.typeBoolean)]
    case 'int64': return [BigInt(IR_TAGS.typeInt64)]
    case 'decimal': return [BigInt(IR_TAGS.typeDecimal), uint(type.precision, 'decimal.precision'), uint(type.scale, 'decimal.scale')]
    case 'text': return [BigInt(IR_TAGS.typeText), type.collation]
    case 'blob': return [BigInt(IR_TAGS.typeBlob), type.maxBytes === undefined ? null : uint(type.maxBytes, 'blob.maxBytes')]
    case 'uuid': return [BigInt(IR_TAGS.typeUuid)]
    case 'timestamp_ms': return [BigInt(IR_TAGS.typeTimestampMs)]
    case 'duration_ms': return [BigInt(IR_TAGS.typeDurationMs)]
    case 'json': return [BigInt(IR_TAGS.typeJson)]
    case 'vector': return [BigInt(IR_TAGS.typeVector), BigInt(VECTOR_ELEMENTS.indexOf(type.element)), uint(type.dimensions, 'vector.dimensions')]
  }
}

function logicalTypeFromCbor(value: CborValue): LogicalType {
  const items = expectArray(value, 'logical_type'), tag = Number(expectBigint(items[0] ?? null, 'logical_type.tag'))
  if (tag === IR_TAGS.typeBoolean && items.length === 1) return { kind: 'boolean' }
  if (tag === IR_TAGS.typeInt64 && items.length === 1) return { kind: 'int64' }
  if (tag === IR_TAGS.typeDecimal && items.length === 3) return { kind: 'decimal', precision: Number(expectBigint(items[1] ?? null, 'decimal.precision')), scale: Number(expectBigint(items[2] ?? null, 'decimal.scale')) }
  if (tag === IR_TAGS.typeText && items.length === 2) return { kind: 'text', collation: expectString(items[1] ?? null, 'text.collation') as CollationId }
  if (tag === IR_TAGS.typeBlob && items.length === 2) { const maximum = items[1]; return maximum === null ? { kind: 'blob' } : { kind: 'blob', maxBytes: Number(expectBigint(maximum ?? null, 'blob.maxBytes')) } }
  if (tag === IR_TAGS.typeUuid && items.length === 1) return { kind: 'uuid' }
  if (tag === IR_TAGS.typeTimestampMs && items.length === 1) return { kind: 'timestamp_ms' }
  if (tag === IR_TAGS.typeDurationMs && items.length === 1) return { kind: 'duration_ms' }
  if (tag === IR_TAGS.typeJson && items.length === 1) return { kind: 'json' }
  if (tag === IR_TAGS.typeVector && items.length === 3) { const element = VECTOR_ELEMENTS[Number(expectBigint(items[1] ?? null, 'vector.element'))]; canonicalInvariant(element !== undefined, 'SCHEMA_INVALID', 'Unknown vector element type'); return { kind: 'vector', element, dimensions: Number(expectBigint(items[2] ?? null, 'vector.dimensions')) } }
  throw new Error(`IR_UNKNOWN_LOGICAL_TYPE_TAG:${tag}`)
}

interface RecordTag { readonly tag: number; readonly consumesKind: boolean }

function recordTag(tag: number, consumesKind = false): RecordTag { return { tag, consumesKind } }

function tagFor(record: Record<string, unknown>): RecordTag | undefined {
  const kind = typeof record.kind === 'string' ? record.kind : undefined
  if ('ctes' in record && 'projection' in record && 'resultMode' in record) return recordTag(IR_TAGS.query)
  if ('logical' in record && 'nullable' in record) return recordTag(IR_TAGS.valueType)
  if ('when' in record && 'then' in record && Object.keys(record).length === 2) return recordTag(IR_TAGS.conditionalBranch)
  if ('materialized' in record && 'query' in record && 'name' in record) return recordTag(IR_TAGS.cte)
  if ((kind === 'inner' || kind === 'left' || kind === 'cross') && 'relation' in record) return recordTag(IR_TAGS.join)
  if ('direction' in record && 'nulls' in record && 'expression' in record) return recordTag(IR_TAGS.orderTerm)
  if ('partitionBy' in record && 'orderBy' in record && 'name' in record) return recordTag(IR_TAGS.window)
  if ('operator' in record && 'query' in record && kind === undefined) return recordTag(IR_TAGS.compound)
  if ('limit' in record && kind === undefined && !('id' in record)) return recordTag(IR_TAGS.page)
  if ('expression' in record && 'name' in record && 'id' in record && kind === undefined) return recordTag(IR_TAGS.projection)
  if ('when' in record && 'action' in record && 'assignments' in record) return recordTag(IR_TAGS.mergeClause)
  if ('column' in record && 'value' in record && kind === undefined && !('id' in record)) return recordTag(IR_TAGS.assignment)
  if (kind === 'name' && 'name' in record && !('id' in record)) return recordTag(IR_TAGS.objectReferenceName, true)
  if (kind === 'id' && 'objectId' in record && !('id' in record)) return recordTag(IR_TAGS.objectReferenceId, true)
  if (kind === undefined && 'valueType' in record && 'name' in record && 'id' in record) {
    return recordTag('declarationOrder' in record ? IR_TAGS.schemaColumn : IR_TAGS.resultColumn)
  }
  if ('tableId' in record && 'values' in record && Object.keys(record).length === 2) return recordTag(IR_TAGS.seedRow)
  if ('resultMode' in record && 'columns' in record && 'rows' in record) return recordTag(IR_TAGS.canonicalQueryResult)
  if ('version' in record && 'objects' in record && 'seedRows' in record) return recordTag(IR_TAGS.schemaManifest)
  if ('version' in record && 'engineDigest' in record && 'functions' in record) return recordTag(IR_TAGS.executionManifest)
  if ('decimal' in record && 'json' in record && 'wasm' in record) return recordTag(IR_TAGS.executionFeatures)
  if ('maxProgramNodes' in record && 'maxWasmFuel' in record) return recordTag(IR_TAGS.semanticResourceLimits)
  if ('arguments' in record && 'result' in record && 'effect' in record && 'implementationDigest' in record) return recordTag(IR_TAGS.registeredFunction)
  if ('effectObjectIds' in record && 'implementationDigest' in record && 'name' in record && 'id' in record) return recordTag(IR_TAGS.registeredModule)
  if ('implementationDigest' in record && 'name' in record && 'id' in record) return recordTag(IR_TAGS.registeredCollation)
  if (kind === 'json' && 'id' in record) return recordTag(IR_TAGS.exprJson, true)
  if (kind === 'table') return recordTag('columns' in record ? IR_TAGS.schemaTable : IR_TAGS.relationTable, true)
  if (kind === 'view') return recordTag('declarationOrder' in record ? IR_TAGS.schemaView : IR_TAGS.relationView, true)
  if (kind === 'index') return recordTag(IR_TAGS.schemaIndex, true)
  if (kind === 'rule') return recordTag(IR_TAGS.schemaRule, true)
  if (kind === 'subquery') return recordTag(IR_TAGS.relationSubquery, true)
  if (kind === 'cte') return recordTag(IR_TAGS.relationCte, true)
  if (kind === 'table_function') return recordTag(IR_TAGS.relationTableFunction, true)
  if (kind === 'fts') return recordTag(IR_TAGS.relationFts, true)
  if (kind === 'vector_search') return recordTag(IR_TAGS.relationVector, true)
  if (kind === 'spatial_search') return recordTag(IR_TAGS.relationSpatial, true)
  if (kind === 'system_relation') return recordTag(IR_TAGS.relationSystem, true)
  const tag = kind === undefined ? undefined : KIND_TAG.get(kind)
  return tag === undefined ? undefined : recordTag(tag, true)
}

function genericToCbor(value: unknown): CborValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'bigint' || typeof value === 'string' || value instanceof Uint8Array) return value
  if (typeof value === 'number') return numberMarker(value)
  if (Array.isArray(value)) return (value as readonly unknown[]).map(genericToCbor)
  if (value instanceof Map) return new Map([...(value as ReadonlyMap<unknown, unknown>)].map(([key, item]) => {
    const canonicalKey = typeof key === 'number'
      ? uint(key, 'map key')
      : key
    canonicalInvariant(
      typeof canonicalKey === 'string' || typeof canonicalKey === 'bigint' || canonicalKey instanceof Uint8Array,
      'SCHEMA_INVALID',
      'Unsupported IR map key',
    )
    return [canonicalKey, genericToCbor(item)]
  }))
  canonicalInvariant(typeof value === 'object' && value !== null, 'SCHEMA_INVALID', 'IR contains unsupported host value')
  const record = value as Record<string, unknown>
  if (isLogicalValueRecord(record)) return logicalValueToCbor(value as LogicalValue)
  if (typeof record.kind === 'string' && TYPE_TAGS.has(tagForTypeKind(record.kind)) && !('id' in record) && !('value' in record) && !('utf8' in record) && !('bytes' in record) && !('coefficient' in record)) return logicalTypeToCbor(value as LogicalType)
  const descriptor = tagFor(record)
  const fields = new Map<CborMapKey, CborValue>()
  const encodedKeys = Object.keys(record).filter((key) => key !== 'kind' || descriptor?.consumesKind !== true)
  if (descriptor !== undefined) {
    const knownFields = TAG_FIELDS.get(descriptor.tag)
    canonicalInvariant(knownFields !== undefined, 'SCHEMA_INVALID', `IR tag ${descriptor.tag} has no field registry`)
    for (const key of encodedKeys) canonicalInvariant(knownFields.includes(key), 'SCHEMA_INVALID', `IR tag ${descriptor.tag} contains unknown field ${key}`)
    for (let index = 0; index < knownFields.length; index += 1) {
      const item = record[knownFields[index]!]
      if (item !== undefined) fields.set(BigInt(index), genericToCbor(item))
    }
  } else {
    for (const key of encodedKeys.sort()) if (record[key] !== undefined) fields.set(key, genericToCbor(record[key]))
  }
  return descriptor === undefined ? fields : [BigInt(descriptor.tag), fields]
}

function isLogicalValueRecord(record: Record<string, unknown>): boolean {
  if ('id' in record || typeof record.kind !== 'string' || !VALUE_TAGS.has(tagForValueKind(record.kind))) return false
  switch (record.kind) {
    case 'null': return true
    case 'boolean': case 'int64': case 'timestamp_ms': case 'duration_ms': case 'json': return 'value' in record
    case 'decimal': return 'coefficient' in record
    case 'text': return 'utf8' in record
    case 'blob': case 'uuid': return 'bytes' in record
    case 'vector': return 'bytes' in record
    default: return false
  }
}

function tagForValueKind(kind: string): number { return ({ null: IR_TAGS.valueNull, boolean: IR_TAGS.valueBoolean, int64: IR_TAGS.valueInt64, decimal: IR_TAGS.valueDecimal, text: IR_TAGS.valueText, blob: IR_TAGS.valueBlob, uuid: IR_TAGS.valueUuid, timestamp_ms: IR_TAGS.valueTimestampMs, duration_ms: IR_TAGS.valueDurationMs, json: IR_TAGS.valueJson, vector: IR_TAGS.valueVector } as Record<string, number>)[kind] ?? -1 }
function tagForTypeKind(kind: string): number { return ({ boolean: IR_TAGS.typeBoolean, int64: IR_TAGS.typeInt64, decimal: IR_TAGS.typeDecimal, text: IR_TAGS.typeText, blob: IR_TAGS.typeBlob, uuid: IR_TAGS.typeUuid, timestamp_ms: IR_TAGS.typeTimestampMs, duration_ms: IR_TAGS.typeDurationMs, json: IR_TAGS.typeJson, vector: IR_TAGS.typeVector } as Record<string, number>)[kind] ?? -1 }

function genericFromCbor(value: CborValue): unknown {
  if (value === null || typeof value === 'boolean' || typeof value === 'bigint' || typeof value === 'string' || value instanceof Uint8Array) return value instanceof Uint8Array ? Uint8Array.from(value) : value
  if (value instanceof Map) {
    const entries = value as ReadonlyMap<CborMapKey, CborValue>
    if (entries.size === 1 && entries.has(-1n)) return Number(expectBigint(entries.get(-1n) ?? null, 'number'))
    const keys = [...entries.keys()]
    if (keys.every((key) => typeof key === 'string')) {
      const result: Record<string, unknown> = {}
      for (const [key, item] of entries) result[key as string] = genericFromCbor(item)
      return result
    }
    const map = new Map<CborMapKey, unknown>()
    for (const [key, item] of entries) map.set(key instanceof Uint8Array ? Uint8Array.from(key) : key, genericFromCbor(item))
    return map
  }
  if (Array.isArray(value)) {
    const items = value as readonly CborValue[]
    if (items.length === 0 || typeof items[0] !== 'bigint') return items.map(genericFromCbor)
    const tag = Number(items[0])
    if (VALUE_TAGS.has(tag)) return logicalValueFromCbor(items)
    if (TYPE_TAGS.has(tag)) return logicalTypeFromCbor(items)
    const kind = TAG_KIND.get(tag) ?? schemaOrRelationKind(tag)
    canonicalInvariant((kind !== undefined || NON_DISCRIMINATED_RECORD_TAGS.has(tag)) && items.length === 2, 'SCHEMA_INVALID', `Unknown or malformed IR tag ${tag}`)
    const encodedFields = expectMap(items[1] ?? null, `IR tag ${tag} fields`)
    const knownFields = TAG_FIELDS.get(tag)
    canonicalInvariant(knownFields !== undefined, 'SCHEMA_INVALID', `IR tag ${tag} has no field registry`)
    const fields: Record<string, unknown> = {}
    for (const [encodedKey, item] of encodedFields) {
      canonicalInvariant(typeof encodedKey === 'bigint' && encodedKey >= 0n && encodedKey < BigInt(knownFields.length), 'SCHEMA_INVALID', `IR tag ${tag} contains an unknown field`)
      fields[knownFields[Number(encodedKey)]!] = genericFromCbor(item)
    }
    return kind === undefined ? fields : { kind, ...fields }
  }
  throw new Error('IR_INVALID_CBOR_VALUE')
}

function schemaOrRelationKind(tag: number): string | undefined {
  return new Map<number, string>([
    [IR_TAGS.exprJson, 'json'],
    [IR_TAGS.relationTable, 'table'], [IR_TAGS.relationView, 'view'], [IR_TAGS.relationSubquery, 'subquery'], [IR_TAGS.relationCte, 'cte'],
    [IR_TAGS.relationTableFunction, 'table_function'], [IR_TAGS.relationFts, 'fts'], [IR_TAGS.relationVector, 'vector_search'], [IR_TAGS.relationSpatial, 'spatial_search'],
    [IR_TAGS.relationSystem, 'system_relation'],
    [IR_TAGS.schemaTable, 'table'], [IR_TAGS.schemaIndex, 'index'], [IR_TAGS.schemaView, 'view'], [IR_TAGS.schemaRule, 'rule'],
    [IR_TAGS.objectReferenceName, 'name'], [IR_TAGS.objectReferenceId, 'id'],
  ]).get(tag)
}

function encodeRoot(version: bigint, value: unknown): Uint8Array { return encodeCanonicalCbor(integerMap([[0, version], [1, genericToCbor(value)]])) }
function decodeRoot(bytes: Uint8Array, name: string, limits: DecodeLimits): unknown {
  const map = expectMap(assertCanonicalCbor(bytes, limits), name)
  canonicalInvariant(map.size === 2 && required(map, 0, `${name}.version`) === 1n, 'SCHEMA_INVALID', `${name} has unsupported version or fields`)
  return genericFromCbor(required(map, 1, `${name}.value`))
}

export function logicalValueToCanonicalCbor(value: LogicalValue): CborValue { return logicalValueToCbor(value) }
export function logicalValueFromCanonicalCbor(value: CborValue): LogicalValue { return freezePublic(checkedLogicalValue(logicalValueFromCbor(value))) }
export function logicalTypeToCanonicalCbor(value: LogicalType): CborValue { return logicalTypeToCbor(value) }
export function logicalTypeFromCanonicalCbor(value: CborValue): LogicalType { return freezePublic(checkedLogicalType(logicalTypeFromCbor(value))) }
export function irToCanonicalCbor(value: unknown): CborValue { return genericToCbor(value) }
export function irFromCanonicalCbor(value: CborValue): unknown { return genericFromCbor(value) }

export function encodeLogicalValue(value: LogicalValue): Uint8Array { return encodeCanonicalCbor(logicalValueToCbor(checkedLogicalValue(value))) }
export function decodeLogicalValue(bytes: Uint8Array, limits: DecodeLimits = IR_DECODE_LIMITS): LogicalValue { return freezePublic(checkedLogicalValue(logicalValueFromCbor(assertCanonicalCbor(bytes, limits)))) }
export function encodeLogicalValues(values: readonly LogicalValue[]): Uint8Array { return encodeCanonicalCbor(values.map((value) => logicalValueToCbor(checkedLogicalValue(value)))) }
export function decodeLogicalValues(bytes: Uint8Array, limits: DecodeLimits = IR_DECODE_LIMITS): readonly LogicalValue[] { return freezePublic(expectArray(assertCanonicalCbor(bytes, limits), 'logical_values').map((value) => checkedLogicalValue(logicalValueFromCbor(value)))) }

export function queryToCanonicalCbor(value: Query): CborValue { return genericToCbor(value) }
export function queryFromCanonicalCbor(value: CborValue): Query { return freezePublic(checkedQuery(genericFromCbor(value) as Query)) }
export function encodeQuery(value: Query): Uint8Array { return encodeRoot(1n, checkedQuery(value)) }
export function decodeQuery(bytes: Uint8Array, limits: DecodeLimits = IR_DECODE_LIMITS): Query { return freezePublic(checkedQuery(decodeRoot(bytes, 'query', limits) as Query)) }
export function encodeMutation(value: Mutation): Uint8Array { return encodeRoot(1n, value) }
export function decodeMutation(bytes: Uint8Array, limits: DecodeLimits = IR_DECODE_LIMITS): Mutation { return freezePublic(decodeRoot(bytes, 'mutation', limits) as Mutation) }
export function encodePrecondition(value: Precondition): Uint8Array { return encodeRoot(1n, value) }
export function decodePrecondition(bytes: Uint8Array, limits: DecodeLimits = IR_DECODE_LIMITS): Precondition { return freezePublic(decodeRoot(bytes, 'precondition', limits) as Precondition) }

export function transactionProgramToCanonicalCbor(value: TransactionProgram): CborValue {
  assertValidTransactionProgram(value)
  return integerMap([[0, 1n], [1, genericToCbor(value.preconditions)], [2, genericToCbor(value.mutations)], [3, value.metadata === undefined ? undefined : genericToCbor(value.metadata)]])
}
export function transactionProgramFromCanonicalCbor(value: CborValue): TransactionProgram {
  const map = expectMap(value, 'transaction_program')
  canonicalInvariant(map.size >= 3 && map.size <= 4 && required(map, 0, 'transaction_program.version') === 1n, 'SCHEMA_INVALID', 'Transaction program has unsupported version or fields')
  const metadata = optional(map, 3)
  let decodedMetadata: ReadonlyMap<string, Uint8Array> | undefined
  if (metadata !== undefined) {
    const entries = expectMap(metadata, 'transaction_program.metadata')
    const result = new Map<string, Uint8Array>()
    for (const [key, item] of entries) {
      canonicalInvariant(typeof key === 'string', 'SCHEMA_INVALID', 'Transaction metadata keys must be text')
      result.set(key, expectBytes(item, `transaction_program.metadata.${key}`))
    }
    decodedMetadata = result
  }
  return freezePublic(assertValidTransactionProgram({
    preconditions: genericFromCbor(required(map, 1, 'transaction_program.preconditions')) as readonly Precondition[],
    mutations: genericFromCbor(required(map, 2, 'transaction_program.mutations')) as readonly Mutation[],
    ...(decodedMetadata === undefined ? {} : { metadata: decodedMetadata }),
  }))
}
export function encodeTransactionProgram(value: TransactionProgram): Uint8Array { assertValidTransactionProgram(value); return encodeCanonicalCbor(transactionProgramToCanonicalCbor(value)) }
export function decodeTransactionProgram(bytes: Uint8Array, limits: DecodeLimits = IR_DECODE_LIMITS): TransactionProgram { return transactionProgramFromCanonicalCbor(assertCanonicalCbor(bytes, limits)) }

export function canonicalQueryResultToCbor(value: CanonicalQueryResult): CborValue { return genericToCbor(value) }
export function canonicalQueryResultFromCbor(value: CborValue): CanonicalQueryResult { return freezePublic(checkedQueryResult(genericFromCbor(value) as CanonicalQueryResult)) }
export function encodeCanonicalQueryResult(value: CanonicalQueryResult): Uint8Array { return encodeRoot(1n, checkedQueryResult(value)) }
export function decodeCanonicalQueryResult(bytes: Uint8Array, limits: DecodeLimits = IR_DECODE_LIMITS): CanonicalQueryResult { return freezePublic(checkedQueryResult(decodeRoot(bytes, 'query_result', limits) as CanonicalQueryResult)) }
export async function digestCanonicalQueryResult(value: CanonicalQueryResult): Promise<Uint8Array> { return hashDomain('queryResult', encodeCanonicalQueryResult(value)) }

function sortSchema(schema: SchemaManifest): SchemaManifest { return { ...schema, objects: [...schema.objects].sort((a, b) => a.id - b.id), seedRows: [...schema.seedRows].sort((a, b) => a.tableId - b.tableId), functionIds: [...schema.functionIds].sort((a, b) => a - b), collationIds: [...schema.collationIds].sort((a, b) => a - b), moduleIds: [...schema.moduleIds].sort((a, b) => a - b) } }
export function encodeSchemaManifest(value: SchemaManifest): Uint8Array { return encodeRoot(1n, sortSchema(assertValidSchemaManifest(value))) }
export function decodeSchemaManifest(bytes: Uint8Array, limits: DecodeLimits = IR_DECODE_LIMITS): SchemaManifest {
  const schema = decodeRoot(bytes, 'schema_manifest', limits) as SchemaManifest
  return freezePublic(assertValidSchemaManifest({
    ...schema,
    seedRows: schema.seedRows.map((row) => ({
      ...row,
      values: new Map([...row.values].map(([columnId, value]) => {
        canonicalInvariant(typeof columnId === 'bigint' && columnId <= BigInt(Number.MAX_SAFE_INTEGER), 'SCHEMA_INVALID', 'Seed row column ID is invalid')
        return [Number(columnId), value]
      })),
    })),
  }))
}
export async function digestSchemaManifest(value: SchemaManifest): Promise<Uint8Array> { return hashDomain('schema', encodeSchemaManifest(value)) }
export function encodeExecutionManifest(value: ExecutionManifest): Uint8Array { return encodeRoot(1n, assertValidExecutionManifest(value)) }
export function decodeExecutionManifest(bytes: Uint8Array, limits: DecodeLimits = IR_DECODE_LIMITS): ExecutionManifest { return freezePublic(assertValidExecutionManifest(decodeRoot(bytes, 'execution_manifest', limits) as ExecutionManifest)) }
export async function digestExecutionManifest(value: ExecutionManifest): Promise<Uint8Array> { return hashDomain('executionManifest', encodeExecutionManifest(value)) }
export async function digestExpectation(value: CanonicalQueryResult): Promise<Uint8Array> { return hashDomain('expectation', encodeCanonicalQueryResult(value)) }

function checkedLogicalValue(value: LogicalValue): LogicalValue {
  const diagnostics = validateLogicalValue(value)
  canonicalInvariant(diagnostics.length === 0, 'SCHEMA_INVALID', diagnostics[0]?.message ?? 'Invalid logical value')
  return value
}
function checkedLogicalType(value: LogicalType): LogicalType {
  const diagnostics = validateLogicalType(value)
  canonicalInvariant(diagnostics.length === 0, 'SCHEMA_INVALID', diagnostics[0]?.message ?? 'Invalid logical type')
  return value
}
function checkedQuery(value: Query): Query {
  const result = validateQuery(value, { allowParameters: true })
  canonicalInvariant(result.ok, 'SCHEMA_INVALID', result.diagnostics[0]?.message ?? 'Invalid query')
  return value
}
function checkedQueryResult(value: CanonicalQueryResult): CanonicalQueryResult {
  const result = validateCanonicalQueryResult(value)
  canonicalInvariant(result.ok, 'SCHEMA_INVALID', result.diagnostics[0]?.message ?? 'Invalid canonical query result')
  return value
}

function freezePublic<T>(value: T): T {
  if (Array.isArray(value)) { for (const item of value) freezePublic(item); return Object.freeze(value) as T }
  if (value instanceof Map) { for (const [key, item] of value) { if (key instanceof Uint8Array) freezePublic(key); freezePublic(item) }; return Object.freeze(value) as T }
  if (typeof value === 'object' && value !== null && !(value instanceof Uint8Array)) {
    for (const item of Object.values(value)) freezePublic(item)
    return Object.freeze(value)
  }
  return value
}
