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
  expectString,
  hashDomain,
  utf8,
  type CborMapKey,
  type CborValue,
  type DecodeLimits,
} from '@chronolog/canonical'

import type {
  CanonicalJsonValue,
  CollationId,
  ExecutionFeatures,
  ExecutionManifest,
  FunctionEffect,
  LogicalType,
  LogicalValue,
  RegisteredCollation,
  RegisteredFunction,
  RegisteredModule,
  SemanticResourceLimits,
  ValueType,
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

const VALUE_TAG = {
  null: 0,
  boolean: 1,
  int64: 2,
  decimal: 3,
  text: 4,
  blob: 5,
  uuid: 6,
  timestamp_ms: 7,
  duration_ms: 8,
  json: 9,
  vector: 10,
} as const

const TYPE_TAG = {
  boolean: 16,
  int64: 17,
  decimal: 18,
  text: 19,
  blob: 20,
  uuid: 21,
  timestamp_ms: 22,
  duration_ms: 23,
  json: 24,
  vector: 25,
} as const

const VECTOR_ELEMENTS: readonly VectorElementType[] = ['i8', 'u8', 'i16', 'i32', 'f32', 'f64']
const VECTOR_WIDTH: Readonly<Record<VectorElementType, number>> = {
  i8: 1,
  u8: 1,
  i16: 2,
  i32: 4,
  f32: 4,
  f64: 8,
}
const MIN_INT64 = -(1n << 63n)
const MAX_INT64 = (1n << 63n) - 1n

export function logicalValueToCanonicalCbor(value: LogicalValue): CborValue {
  assertLogicalValue(value)
  switch (value.kind) {
    case 'null': return [BigInt(VALUE_TAG.null)]
    case 'boolean': return [BigInt(VALUE_TAG.boolean), value.value]
    case 'int64': return [BigInt(VALUE_TAG.int64), value.value]
    case 'decimal': return [BigInt(VALUE_TAG.decimal), value.coefficient, uint(value.scale, 'decimal.scale')]
    case 'text': return [BigInt(VALUE_TAG.text), decodeUtf8(value.utf8)]
    case 'blob': return [BigInt(VALUE_TAG.blob), value.bytes]
    case 'uuid': return [BigInt(VALUE_TAG.uuid), value.bytes]
    case 'timestamp_ms': return [BigInt(VALUE_TAG.timestamp_ms), value.value]
    case 'duration_ms': return [BigInt(VALUE_TAG.duration_ms), value.value]
    case 'json': return [BigInt(VALUE_TAG.json), jsonToCbor(value.value)]
    case 'vector': return [
      BigInt(VALUE_TAG.vector),
      BigInt(VECTOR_ELEMENTS.indexOf(value.element)),
      uint(value.dimensions, 'vector.dimensions'),
      value.bytes,
    ]
  }
}

export function logicalValueFromCanonicalCbor(value: CborValue): LogicalValue {
  const items = expectArray(value, 'logical_value')
  const tag = safeNumber(expectBigint(items[0] ?? null, 'logical_value.tag'), 'logical_value.tag')
  let decoded: LogicalValue
  if (tag === VALUE_TAG.null && items.length === 1) decoded = { kind: 'null' }
  else if (tag === VALUE_TAG.boolean && items.length === 2) {
    decoded = { kind: 'boolean', value: expectBoolean(items[1] ?? null, 'boolean.value') }
  } else if (tag === VALUE_TAG.int64 && items.length === 2) {
    decoded = { kind: 'int64', value: expectBigint(items[1] ?? null, 'int64.value') }
  } else if (tag === VALUE_TAG.decimal && items.length === 3) {
    decoded = {
      kind: 'decimal',
      coefficient: expectBigint(items[1] ?? null, 'decimal.coefficient'),
      scale: safeUint(items[2] ?? null, 'decimal.scale'),
    }
  } else if (tag === VALUE_TAG.text && items.length === 2) {
    decoded = { kind: 'text', utf8: utf8(expectString(items[1] ?? null, 'text.value')) }
  } else if (tag === VALUE_TAG.blob && items.length === 2) {
    decoded = { kind: 'blob', bytes: expectBytes(items[1] ?? null, 'blob.value') }
  } else if (tag === VALUE_TAG.uuid && items.length === 2) {
    decoded = { kind: 'uuid', bytes: expectBytes(items[1] ?? null, 'uuid.value', 16) }
  } else if (tag === VALUE_TAG.timestamp_ms && items.length === 2) {
    decoded = { kind: 'timestamp_ms', value: expectBigint(items[1] ?? null, 'timestamp.value') }
  } else if (tag === VALUE_TAG.duration_ms && items.length === 2) {
    decoded = { kind: 'duration_ms', value: expectBigint(items[1] ?? null, 'duration.value') }
  } else if (tag === VALUE_TAG.json && items.length === 2) {
    decoded = { kind: 'json', value: jsonFromCbor(items[1] ?? null) }
  } else if (tag === VALUE_TAG.vector && items.length === 4) {
    const element = VECTOR_ELEMENTS[safeUint(items[1] ?? null, 'vector.element')]
    canonicalInvariant(element !== undefined, 'SCHEMA_INVALID', 'Unknown vector element type')
    decoded = {
      kind: 'vector',
      element,
      dimensions: safeUint(items[2] ?? null, 'vector.dimensions'),
      bytes: expectBytes(items[3] ?? null, 'vector.bytes'),
    }
  } else {
    throw new Error(`IR_UNKNOWN_LOGICAL_VALUE_TAG:${tag}`)
  }
  assertLogicalValue(decoded)
  return decoded
}

export function logicalTypeToCanonicalCbor(value: LogicalType): CborValue {
  assertLogicalType(value)
  switch (value.kind) {
    case 'boolean': return [BigInt(TYPE_TAG.boolean)]
    case 'int64': return [BigInt(TYPE_TAG.int64)]
    case 'decimal': return [BigInt(TYPE_TAG.decimal), uint(value.precision, 'decimal.precision'), uint(value.scale, 'decimal.scale')]
    case 'text': return [BigInt(TYPE_TAG.text), value.collation]
    case 'blob': return [BigInt(TYPE_TAG.blob), value.maxBytes === undefined ? null : uint(value.maxBytes, 'blob.maxBytes')]
    case 'uuid': return [BigInt(TYPE_TAG.uuid)]
    case 'timestamp_ms': return [BigInt(TYPE_TAG.timestamp_ms)]
    case 'duration_ms': return [BigInt(TYPE_TAG.duration_ms)]
    case 'json': return [BigInt(TYPE_TAG.json)]
    case 'vector': return [
      BigInt(TYPE_TAG.vector),
      BigInt(VECTOR_ELEMENTS.indexOf(value.element)),
      uint(value.dimensions, 'vector.dimensions'),
    ]
  }
}

export function logicalTypeFromCanonicalCbor(value: CborValue): LogicalType {
  const items = expectArray(value, 'logical_type')
  const tag = safeNumber(expectBigint(items[0] ?? null, 'logical_type.tag'), 'logical_type.tag')
  let decoded: LogicalType
  if (tag === TYPE_TAG.boolean && items.length === 1) decoded = { kind: 'boolean' }
  else if (tag === TYPE_TAG.int64 && items.length === 1) decoded = { kind: 'int64' }
  else if (tag === TYPE_TAG.decimal && items.length === 3) {
    decoded = {
      kind: 'decimal',
      precision: safeUint(items[1] ?? null, 'decimal.precision'),
      scale: safeUint(items[2] ?? null, 'decimal.scale'),
    }
  } else if (tag === TYPE_TAG.text && items.length === 2) {
    decoded = { kind: 'text', collation: expectString(items[1] ?? null, 'text.collation') as CollationId }
  } else if (tag === TYPE_TAG.blob && items.length === 2) {
    decoded = items[1] === null
      ? { kind: 'blob' }
      : { kind: 'blob', maxBytes: safeUint(items[1] ?? null, 'blob.maxBytes') }
  } else if (tag === TYPE_TAG.uuid && items.length === 1) decoded = { kind: 'uuid' }
  else if (tag === TYPE_TAG.timestamp_ms && items.length === 1) decoded = { kind: 'timestamp_ms' }
  else if (tag === TYPE_TAG.duration_ms && items.length === 1) decoded = { kind: 'duration_ms' }
  else if (tag === TYPE_TAG.json && items.length === 1) decoded = { kind: 'json' }
  else if (tag === TYPE_TAG.vector && items.length === 3) {
    const element = VECTOR_ELEMENTS[safeUint(items[1] ?? null, 'vector.element')]
    canonicalInvariant(element !== undefined, 'SCHEMA_INVALID', 'Unknown vector element type')
    decoded = { kind: 'vector', element, dimensions: safeUint(items[2] ?? null, 'vector.dimensions') }
  } else {
    throw new Error(`IR_UNKNOWN_LOGICAL_TYPE_TAG:${tag}`)
  }
  assertLogicalType(decoded)
  return decoded
}

export function encodeLogicalValue(value: LogicalValue): Uint8Array {
  return encodeCanonicalCbor(logicalValueToCanonicalCbor(value))
}

export function decodeLogicalValue(
  bytes: Uint8Array,
  limits: DecodeLimits = IR_DECODE_LIMITS,
): LogicalValue {
  return logicalValueFromCanonicalCbor(assertCanonicalCbor(bytes, limits))
}

export function encodeLogicalValues(values: readonly LogicalValue[]): Uint8Array {
  return encodeCanonicalCbor(values.map(logicalValueToCanonicalCbor))
}

export function decodeLogicalValues(
  bytes: Uint8Array,
  limits: DecodeLimits = IR_DECODE_LIMITS,
): readonly LogicalValue[] {
  return expectArray(assertCanonicalCbor(bytes, limits), 'logical_values').map(logicalValueFromCanonicalCbor)
}

export function encodeExecutionManifest(value: ExecutionManifest): Uint8Array {
  assertExecutionManifest(value)
  return encodeCanonicalCbor(executionManifestToCbor(value))
}

export function decodeExecutionManifest(
  bytes: Uint8Array,
  limits: DecodeLimits = IR_DECODE_LIMITS,
): ExecutionManifest {
  const value = executionManifestFromCbor(assertCanonicalCbor(bytes, limits))
  assertExecutionManifest(value)
  return value
}

export async function digestExecutionManifest(value: ExecutionManifest): Promise<Uint8Array> {
  return hashDomain('executionManifest', encodeExecutionManifest(value))
}

function executionManifestToCbor(value: ExecutionManifest): CborValue {
  return [
    1n,
    value.profile,
    value.engine,
    value.engineDigest,
    value.functions.map(registeredFunctionToCbor),
    value.collations.map(registeredCollationToCbor),
    value.modules.map(registeredModuleToCbor),
    featuresToCbor(value.features),
    resourcesToCbor(value.resources),
    [
      1n,
      value.transactionResults.valueProfile,
      value.transactionResults.canonicalizationProfile,
      value.transactionResults.sqlResultDigestDomain,
      value.transactionResults.envelopeDigestDomain,
    ],
    value.errorCodes,
  ]
}

function executionManifestFromCbor(value: CborValue): ExecutionManifest {
  const items = expectArray(value, 'execution_manifest')
  canonicalInvariant(items.length === 11 && items[0] === 1n, 'SCHEMA_INVALID', 'Unsupported execution manifest')
  const transactionResults = exactArray(items[9] ?? null, 5, 'transaction_result_profile')
  canonicalInvariant(
    transactionResults[0] === 1n && transactionResults[1] === 'sqlite-finite-binary64-v1' &&
    transactionResults[2] === 'sqlite-result-modes-v1' &&
    transactionResults[3] === 'chronolog-canonical-sql-result-v1\0' &&
    transactionResults[4] === 'chronolog-transaction-result-envelope-v1\0',
    'SCHEMA_INVALID', 'Unsupported transaction result profile',
  )
  return {
    version: 1,
    profile: expectString(items[1] ?? null, 'execution_manifest.profile'),
    engine: expectString(items[2] ?? null, 'execution_manifest.engine'),
    engineDigest: expectBytes(items[3] ?? null, 'execution_manifest.engine_digest', 32),
    functions: expectArray(items[4] ?? null, 'execution_manifest.functions').map(registeredFunctionFromCbor),
    collations: expectArray(items[5] ?? null, 'execution_manifest.collations').map(registeredCollationFromCbor),
    modules: expectArray(items[6] ?? null, 'execution_manifest.modules').map(registeredModuleFromCbor),
    features: featuresFromCbor(items[7] ?? null),
    resources: resourcesFromCbor(items[8] ?? null),
    transactionResults: {
      envelopeVersion: 1,
      valueProfile: 'sqlite-finite-binary64-v1',
      canonicalizationProfile: 'sqlite-result-modes-v1',
      sqlResultDigestDomain: 'chronolog-canonical-sql-result-v1\0',
      envelopeDigestDomain: 'chronolog-transaction-result-envelope-v1\0',
    },
    errorCodes: expectArray(items[10] ?? null, 'execution_manifest.error_codes').map((item) => expectString(item, 'execution_manifest.error_code')),
  }
}

function registeredFunctionToCbor(value: RegisteredFunction): CborValue {
  return [
    uint(value.id, 'function.id'),
    value.name,
    value.arguments.map(valueTypeToCbor),
    valueTypeToCbor(value.result),
    BigInt(['pure', 'stable_context', 'stateful'].indexOf(value.effect)),
    value.implementationDigest,
  ]
}

function registeredFunctionFromCbor(value: CborValue): RegisteredFunction {
  const items = exactArray(value, 6, 'registered_function')
  const effect = (['pure', 'stable_context', 'stateful'] as const)[safeUint(items[4] ?? null, 'registered_function.effect')]
  canonicalInvariant(effect !== undefined, 'SCHEMA_INVALID', 'Unknown registered function effect')
  return {
    id: safeUint(items[0] ?? null, 'registered_function.id'),
    name: expectString(items[1] ?? null, 'registered_function.name'),
    arguments: expectArray(items[2] ?? null, 'registered_function.arguments').map(valueTypeFromCbor),
    result: valueTypeFromCbor(items[3] ?? null),
    effect,
    implementationDigest: expectBytes(items[5] ?? null, 'registered_function.implementation_digest', 32),
  }
}

function registeredCollationToCbor(value: RegisteredCollation): CborValue {
  return [uint(value.id, 'collation.id'), value.name, value.implementationDigest]
}

function registeredCollationFromCbor(value: CborValue): RegisteredCollation {
  const items = exactArray(value, 3, 'registered_collation')
  return {
    id: safeUint(items[0] ?? null, 'registered_collation.id'),
    name: expectString(items[1] ?? null, 'registered_collation.name'),
    implementationDigest: expectBytes(items[2] ?? null, 'registered_collation.implementation_digest', 32),
  }
}

function registeredModuleToCbor(value: RegisteredModule): CborValue {
  return [
    uint(value.id, 'module.id'),
    value.name,
    BigInt(['native', 'wasm', 'builtin'].indexOf(value.kind)),
    value.implementationDigest,
    value.effectObjectIds.map((id) => uint(id, 'module.effect_object_id')),
  ]
}

function registeredModuleFromCbor(value: CborValue): RegisteredModule {
  const items = exactArray(value, 5, 'registered_module')
  const kind = (['native', 'wasm', 'builtin'] as const)[safeUint(items[2] ?? null, 'registered_module.kind')]
  canonicalInvariant(kind !== undefined, 'SCHEMA_INVALID', 'Unknown registered module kind')
  return {
    id: safeUint(items[0] ?? null, 'registered_module.id'),
    name: expectString(items[1] ?? null, 'registered_module.name'),
    kind,
    implementationDigest: expectBytes(items[3] ?? null, 'registered_module.implementation_digest', 32),
    effectObjectIds: expectArray(items[4] ?? null, 'registered_module.effect_object_ids').map(
      (item) => safeUint(item, 'registered_module.effect_object_id'),
    ),
  }
}

function valueTypeToCbor(value: ValueType): CborValue {
  assertValueType(value)
  return [logicalTypeToCanonicalCbor(value.logical), value.nullable]
}

function valueTypeFromCbor(value: CborValue): ValueType {
  const items = exactArray(value, 2, 'value_type')
  const result = {
    logical: logicalTypeFromCanonicalCbor(items[0] ?? null),
    nullable: expectBoolean(items[1] ?? null, 'value_type.nullable'),
  }
  assertValueType(result)
  return result
}

function featuresToCbor(value: ExecutionFeatures): CborValue {
  return [value.decimal, value.json, value.vector, value.fts, value.spatial, value.wasm]
}

function featuresFromCbor(value: CborValue): ExecutionFeatures {
  const items = exactArray(value, 6, 'execution_features')
  return {
    decimal: expectBoolean(items[0] ?? null, 'execution_features.decimal'),
    json: expectBoolean(items[1] ?? null, 'execution_features.json'),
    vector: expectBoolean(items[2] ?? null, 'execution_features.vector'),
    fts: expectBoolean(items[3] ?? null, 'execution_features.fts'),
    spatial: expectBoolean(items[4] ?? null, 'execution_features.spatial'),
    wasm: expectBoolean(items[5] ?? null, 'execution_features.wasm'),
  }
}

function resourcesToCbor(value: SemanticResourceLimits): CborValue {
  return [
    uint(value.maxProgramNodes, 'resources.maxProgramNodes'),
    uint(value.maxExpressionDepth, 'resources.maxExpressionDepth'),
    uint(value.maxQueryRows, 'resources.maxQueryRows'),
    uint(value.maxResultBytes, 'resources.maxResultBytes'),
    uint(value.maxJsonDepth, 'resources.maxJsonDepth'),
    uint(value.maxVectorDimensions, 'resources.maxVectorDimensions'),
    uint(value.maxRuleDepth, 'resources.maxRuleDepth'),
    value.maxWasmFuel,
    uint(value.maxResultColumnsPerStatement, 'resources.maxResultColumnsPerStatement'),
    uint(value.maxResultRowsPerStatement, 'resources.maxResultRowsPerStatement'),
    uint(value.maxResultBytesPerStatement, 'resources.maxResultBytesPerStatement'),
    uint(value.maxTransactionResultRows, 'resources.maxTransactionResultRows'),
    uint(value.maxTransactionResultBytes, 'resources.maxTransactionResultBytes'),
    uint(value.maxResultValueBytes, 'resources.maxResultValueBytes'),
    uint(value.maxResultSortWork, 'resources.maxResultSortWork'),
    uint(value.maxOrderedMutationTargets, 'resources.maxOrderedMutationTargets'),
    uint(value.maxOrderedMutationIdentityBytes, 'resources.maxOrderedMutationIdentityBytes'),
    uint(value.maxOrderedMutationBindings, 'resources.maxOrderedMutationBindings'),
  ]
}

function resourcesFromCbor(value: CborValue): SemanticResourceLimits {
  const items = exactArray(value, 18, 'semantic_resource_limits')
  return {
    maxProgramNodes: safeUint(items[0] ?? null, 'resources.maxProgramNodes'),
    maxExpressionDepth: safeUint(items[1] ?? null, 'resources.maxExpressionDepth'),
    maxQueryRows: safeUint(items[2] ?? null, 'resources.maxQueryRows'),
    maxResultBytes: safeUint(items[3] ?? null, 'resources.maxResultBytes'),
    maxJsonDepth: safeUint(items[4] ?? null, 'resources.maxJsonDepth'),
    maxVectorDimensions: safeUint(items[5] ?? null, 'resources.maxVectorDimensions'),
    maxRuleDepth: safeUint(items[6] ?? null, 'resources.maxRuleDepth'),
    maxWasmFuel: expectBigint(items[7] ?? null, 'resources.maxWasmFuel'),
    maxResultColumnsPerStatement: safeUint(items[8] ?? null, 'resources.maxResultColumnsPerStatement'),
    maxResultRowsPerStatement: safeUint(items[9] ?? null, 'resources.maxResultRowsPerStatement'),
    maxResultBytesPerStatement: safeUint(items[10] ?? null, 'resources.maxResultBytesPerStatement'),
    maxTransactionResultRows: safeUint(items[11] ?? null, 'resources.maxTransactionResultRows'),
    maxTransactionResultBytes: safeUint(items[12] ?? null, 'resources.maxTransactionResultBytes'),
    maxResultValueBytes: safeUint(items[13] ?? null, 'resources.maxResultValueBytes'),
    maxResultSortWork: safeUint(items[14] ?? null, 'resources.maxResultSortWork'),
    maxOrderedMutationTargets: safeUint(items[15] ?? null, 'resources.maxOrderedMutationTargets'),
    maxOrderedMutationIdentityBytes: safeUint(items[16] ?? null, 'resources.maxOrderedMutationIdentityBytes'),
    maxOrderedMutationBindings: safeUint(items[17] ?? null, 'resources.maxOrderedMutationBindings'),
  }
}

function jsonToCbor(value: CanonicalJsonValue): CborValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'bigint' || typeof value === 'string') return value
  if (isJsonArray(value)) return value.map(jsonToCbor)
  if (isJsonMap(value)) {
    return new Map([...value].map(([key, item]) => [key, jsonToCbor(item)]))
  }
  canonicalInvariant(isJsonDecimal(value), 'SCHEMA_INVALID', 'Canonical JSON decimal is invalid')
  return [BigInt(VALUE_TAG.decimal), value.coefficient, uint(value.scale, 'json.decimal.scale')]
}

function jsonFromCbor(value: CborValue): CanonicalJsonValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'bigint' || typeof value === 'string') return value
  canonicalInvariant(!(value instanceof Uint8Array), 'SCHEMA_INVALID', 'JSON blobs are not permitted')
  if (value instanceof Map) {
    const result = new Map<string, CanonicalJsonValue>()
    for (const [key, item] of value as ReadonlyMap<CborMapKey, CborValue>) {
      canonicalInvariant(typeof key === 'string', 'SCHEMA_INVALID', 'JSON object keys must be text')
      result.set(key, jsonFromCbor(item))
    }
    return result
  }
  const items = expectArray(value, 'json')
  if (items.length === 3 && items[0] === BigInt(VALUE_TAG.decimal)) {
    return {
      kind: 'decimal',
      coefficient: expectBigint(items[1] ?? null, 'json.decimal.coefficient'),
      scale: safeUint(items[2] ?? null, 'json.decimal.scale'),
    }
  }
  return items.map(jsonFromCbor)
}

function assertLogicalValue(value: LogicalValue): void {
  canonicalInvariant(typeof value === 'object' && value !== null, 'SCHEMA_INVALID', 'Logical value must be an object')
  switch (value.kind) {
    case 'null': return
    case 'boolean':
      canonicalInvariant(typeof value.value === 'boolean', 'SCHEMA_INVALID', 'Boolean logical value is invalid')
      return
    case 'int64': case 'timestamp_ms': case 'duration_ms':
      canonicalInvariant(
        typeof value.value === 'bigint' && value.value >= MIN_INT64 && value.value <= MAX_INT64,
        'SCHEMA_INVALID',
        `${value.kind} is outside signed int64`,
      )
      return
    case 'decimal':
      canonicalInvariant(typeof value.coefficient === 'bigint', 'SCHEMA_INVALID', 'Decimal coefficient is invalid')
      assertUint(value.scale, 'decimal.scale')
      return
    case 'text':
      canonicalInvariant(value.utf8 instanceof Uint8Array, 'SCHEMA_INVALID', 'Text bytes are invalid')
      decodeUtf8(value.utf8)
      return
    case 'blob':
      canonicalInvariant(value.bytes instanceof Uint8Array, 'SCHEMA_INVALID', 'Blob bytes are invalid')
      return
    case 'uuid':
      canonicalInvariant(value.bytes instanceof Uint8Array && value.bytes.length === 16, 'SCHEMA_INVALID', 'UUID bytes are invalid')
      return
    case 'json':
      assertJson(value.value, new Set())
      return
    case 'vector':
      canonicalInvariant(VECTOR_ELEMENTS.includes(value.element), 'SCHEMA_INVALID', 'Vector element type is invalid')
      assertUint(value.dimensions, 'vector.dimensions')
      canonicalInvariant(value.dimensions > 0, 'SCHEMA_INVALID', 'Vector dimensions must be positive')
      canonicalInvariant(
        value.bytes instanceof Uint8Array && value.bytes.length === value.dimensions * VECTOR_WIDTH[value.element],
        'SCHEMA_INVALID',
        'Vector byte length does not match dimensions',
      )
  }
}

function assertLogicalType(value: LogicalType): void {
  canonicalInvariant(typeof value === 'object' && value !== null, 'SCHEMA_INVALID', 'Logical type must be an object')
  switch (value.kind) {
    case 'boolean': case 'int64': case 'uuid': case 'timestamp_ms': case 'duration_ms': case 'json': return
    case 'decimal':
      assertUint(value.precision, 'decimal.precision')
      assertUint(value.scale, 'decimal.scale')
      canonicalInvariant(value.precision > 0 && value.scale <= value.precision, 'SCHEMA_INVALID', 'Decimal type is invalid')
      return
    case 'text':
      canonicalInvariant(isCollationId(value.collation), 'SCHEMA_INVALID', 'Text collation is invalid')
      return
    case 'blob':
      if (value.maxBytes !== undefined) assertUint(value.maxBytes, 'blob.maxBytes')
      return
    case 'vector':
      canonicalInvariant(VECTOR_ELEMENTS.includes(value.element), 'SCHEMA_INVALID', 'Vector type is invalid')
      assertUint(value.dimensions, 'vector.dimensions')
      canonicalInvariant(value.dimensions > 0, 'SCHEMA_INVALID', 'Vector dimensions must be positive')
  }
}

function assertValueType(value: ValueType): void {
  assertLogicalType(value.logical)
  canonicalInvariant(typeof value.nullable === 'boolean', 'SCHEMA_INVALID', 'Value type nullable flag is invalid')
}

function assertExecutionManifest(value: ExecutionManifest): void {
  canonicalInvariant(value.version === 1, 'SCHEMA_INVALID', 'Unsupported execution manifest version')
  canonicalInvariant(value.profile.length > 0 && value.engine.length > 0, 'SCHEMA_INVALID', 'Execution profile identity is empty')
  canonicalInvariant(value.engineDigest instanceof Uint8Array && value.engineDigest.length === 32, 'SCHEMA_INVALID', 'Execution engine digest is invalid')
  assertUniqueRegistry(value.functions, 'function')
  assertUniqueRegistry(value.collations, 'collation')
  assertUniqueRegistry(value.modules, 'module')
  for (const item of value.functions) {
    for (const argument of item.arguments) assertValueType(argument)
    assertValueType(item.result)
    canonicalInvariant(
      (['pure', 'stable_context', 'stateful'] as readonly FunctionEffect[]).includes(item.effect),
      'SCHEMA_INVALID',
      'Registered function effect is invalid',
    )
    assertDigest(item.implementationDigest, 'Registered function implementation digest')
  }
  for (const item of value.collations) assertDigest(item.implementationDigest, 'Registered collation implementation digest')
  for (const item of value.modules) {
    canonicalInvariant(['native', 'wasm', 'builtin'].includes(item.kind), 'SCHEMA_INVALID', 'Registered module kind is invalid')
    assertDigest(item.implementationDigest, 'Registered module implementation digest')
    for (const id of item.effectObjectIds) assertUint(id, 'module.effectObjectId')
  }
  for (const feature of Object.values(value.features)) {
    canonicalInvariant(typeof feature === 'boolean', 'SCHEMA_INVALID', 'Execution feature flag is invalid')
  }
  const resources = value.resources
  for (const [name, amount] of Object.entries(resources)) {
    if (name === 'maxWasmFuel') {
      canonicalInvariant(typeof amount === 'bigint' && amount >= 0n, 'SCHEMA_INVALID', `${name} is invalid`)
    } else {
      assertUint(amount as number, `resources.${name}`)
    }
  }
  canonicalInvariant(
    resources.maxProgramNodes > 0 && resources.maxExpressionDepth > 0 && resources.maxQueryRows > 0 &&
    resources.maxResultBytes > 0 && resources.maxJsonDepth > 0 && resources.maxVectorDimensions > 0 &&
    resources.maxResultColumnsPerStatement > 0 && resources.maxResultRowsPerStatement > 0 &&
    resources.maxResultBytesPerStatement > 0 && resources.maxTransactionResultRows > 0 &&
    resources.maxTransactionResultBytes > 0 && resources.maxResultValueBytes > 0 &&
    resources.maxResultSortWork > 0 && resources.maxOrderedMutationTargets > 0 &&
    resources.maxOrderedMutationIdentityBytes > 0 && resources.maxOrderedMutationBindings > 0,
    'SCHEMA_INVALID',
    'Execution resource ceilings must be positive',
  )
  canonicalInvariant(
    value.transactionResults.envelopeVersion === 1 &&
    value.transactionResults.valueProfile === 'sqlite-finite-binary64-v1' &&
    value.transactionResults.canonicalizationProfile === 'sqlite-result-modes-v1' &&
    value.transactionResults.sqlResultDigestDomain === 'chronolog-canonical-sql-result-v1\0' &&
    value.transactionResults.envelopeDigestDomain === 'chronolog-transaction-result-envelope-v1\0',
    'SCHEMA_INVALID', 'Transaction result profile is invalid',
  )
  const sortedErrorCodes = [...value.errorCodes].sort()
  canonicalInvariant(
    value.errorCodes.length > 0 && value.errorCodes.every((code, index) =>
      /^[A-Z][A-Z0-9_]*$/u.test(code) && code === sortedErrorCodes[index] &&
      (index === 0 || code !== value.errorCodes[index - 1])),
    'SCHEMA_INVALID', 'Execution error-code registry must be sorted, unique canonical codes',
  )
}

function assertUniqueRegistry(
  values: readonly { readonly id: number; readonly name: string }[],
  kind: string,
): void {
  const ids = new Set<number>()
  const names = new Set<string>()
  for (const value of values) {
    assertUint(value.id, `${kind}.id`)
    canonicalInvariant(value.name.length > 0, 'SCHEMA_INVALID', `${kind} name is empty`)
    const name = value.name.toLowerCase()
    canonicalInvariant(!ids.has(value.id) && !names.has(name), 'SCHEMA_INVALID', `Duplicate ${kind} registry entry`)
    ids.add(value.id)
    names.add(name)
  }
}

function assertJson(value: CanonicalJsonValue, ancestors: Set<object>): void {
  if (value === null || typeof value === 'boolean' || typeof value === 'bigint' || typeof value === 'string') return
  canonicalInvariant(typeof value === 'object', 'SCHEMA_INVALID', 'Canonical JSON value is invalid')
  canonicalInvariant(!ancestors.has(value), 'SCHEMA_INVALID', 'Canonical JSON value is cyclic')
  ancestors.add(value)
  if (isJsonArray(value)) {
    for (const item of value) assertJson(item, ancestors)
  } else if (isJsonMap(value)) {
    for (const [key, item] of value) {
      canonicalInvariant(typeof key === 'string', 'SCHEMA_INVALID', 'Canonical JSON object key is invalid')
      assertJson(item, ancestors)
    }
  } else {
    canonicalInvariant(isJsonDecimal(value), 'SCHEMA_INVALID', 'Canonical JSON decimal is invalid')
    assertUint(value.scale, 'json.decimal.scale')
  }
  ancestors.delete(value)
}

function isJsonArray(value: CanonicalJsonValue): value is readonly CanonicalJsonValue[] {
  return Array.isArray(value)
}

function isJsonMap(value: CanonicalJsonValue): value is ReadonlyMap<string, CanonicalJsonValue> {
  return value instanceof Map
}

function isJsonDecimal(
  value: CanonicalJsonValue,
): value is { readonly kind: 'decimal'; readonly coefficient: bigint; readonly scale: number } {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Map) &&
    'kind' in value && value.kind === 'decimal' && 'coefficient' in value && typeof value.coefficient === 'bigint'
}

function isCollationId(value: string): value is CollationId {
  return value === 'binary' || value === 'nocase' || value === 'rtrim' || value === 'unicode_codepoint' ||
    /^registered:(?:0|[1-9][0-9]*)$/u.test(value)
}

function exactArray(value: CborValue, length: number, name: string): readonly CborValue[] {
  const items = expectArray(value, name)
  canonicalInvariant(items.length === length, 'SCHEMA_INVALID', `${name} has invalid arity`)
  return items
}

function assertDigest(value: Uint8Array, name: string): void {
  canonicalInvariant(value instanceof Uint8Array && value.length === 32, 'SCHEMA_INVALID', `${name} is invalid`)
}

function assertUint(value: number, name: string): void {
  canonicalInvariant(Number.isSafeInteger(value) && value >= 0, 'SCHEMA_INVALID', `${name} must be an unsigned safe integer`)
}

function uint(value: number, name: string): bigint {
  assertUint(value, name)
  return BigInt(value)
}

function safeUint(value: CborValue, name: string): number {
  const amount = expectBigint(value, name)
  canonicalInvariant(amount >= 0n && amount <= BigInt(Number.MAX_SAFE_INTEGER), 'SCHEMA_INVALID', `${name} is outside safe uint range`)
  return Number(amount)
}

function safeNumber(value: bigint, name: string): number {
  canonicalInvariant(value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER), 'SCHEMA_INVALID', `${name} is outside safe integer range`)
  return Number(value)
}
