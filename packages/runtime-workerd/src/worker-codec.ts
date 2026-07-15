import {
  DEFAULT_DECODE_LIMITS,
  assertCanonicalCbor,
  assertKnownIntegerKeys,
  canonicalInvariant,
  encodeCanonicalCbor,
  expectArray,
  expectBigint,
  expectBytes,
  expectMap,
  integerMap,
  required,
  sha256,
} from '@chronolog/canonical'
import {
  compareObjectRefs,
  decodeMaterializationInvocation,
  exactObjectRefFromCbor,
  exactObjectRefToCbor,
  sameBytes,
  type ExactObjectReader,
  type ExactObjectRef,
} from '@chronolog/materializer'

export type ChronologReducerDatabaseSelector = 'materialized' | 'checkpoint'
export type ChronologReducerSelectedSource = 'materialized' | 'previous' | 'replayBase'

export interface ChronologReducerBundledObject {
  readonly ref: ExactObjectRef
  readonly bytes: Uint8Array
}

/** Self-contained exact-object input supplied as one reducer byte string. */
export interface ChronologReducerInvocationBundle {
  readonly version: 1
  readonly invocation: Uint8Array
  readonly objects: readonly ChronologReducerBundledObject[]
}

/**
 * Canonical application output produced while database handles are still
 * invocation-local. Final immutable database refs are supplied by workerd's
 * selected-database result, so they are deliberately not duplicated here.
 */
export interface ChronologReducerApplicationResult {
  readonly version: 1
  readonly databaseSelector: ChronologReducerDatabaseSelector
  readonly selectedSource: ChronologReducerSelectedSource
  readonly payload: Uint8Array
  readonly exactReadSet: readonly ExactObjectRef[]
}

const SELECTORS: readonly ChronologReducerDatabaseSelector[] = ['materialized', 'checkpoint']
const SOURCES: readonly ChronologReducerSelectedSource[] = ['materialized', 'previous', 'replayBase']

export function encodeChronologReducerInvocationBundle(
  value: ChronologReducerInvocationBundle,
): Uint8Array {
  canonicalInvariant(value.version === 1, 'SCHEMA_INVALID', 'Unsupported reducer bundle version')
  decodeMaterializationInvocation(value.invocation)
  const objects = [...value.objects].sort((left, right) => compareObjectRefs(left.ref, right.ref))
  for (let index = 1; index < objects.length; index += 1) {
    canonicalInvariant(
      compareObjectRefs(objects[index - 1]!.ref, objects[index]!.ref) < 0,
      'SCHEMA_INVALID',
      'Reducer invocation bundle contains a duplicate object ref',
    )
  }
  return encodeCanonicalCbor(integerMap([
    [0, 1n],
    [1, value.invocation],
    [2, objects.map((object) => [exactObjectRefToCbor(object.ref), object.bytes])],
  ]))
}

export function decodeChronologReducerInvocationBundle(
  bytes: Uint8Array,
): ChronologReducerInvocationBundle {
  const map = expectMap(
    assertCanonicalCbor(bytes, DEFAULT_DECODE_LIMITS),
    'chronolog_reducer_bundle',
  )
  assertKnownIntegerKeys(map, [0, 1, 2], 'chronolog_reducer_bundle')
  canonicalInvariant(
    expectBigint(required(map, 0, 'chronolog_reducer_bundle.version'),
      'chronolog_reducer_bundle.version') === 1n,
    'SCHEMA_INVALID',
    'Unsupported reducer bundle version',
  )
  const invocation = expectBytes(
    required(map, 1, 'chronolog_reducer_bundle.invocation'),
    'chronolog_reducer_bundle.invocation',
  )
  decodeMaterializationInvocation(invocation)
  const objects = expectArray(
    required(map, 2, 'chronolog_reducer_bundle.objects'),
    'chronolog_reducer_bundle.objects',
  ).map((value, index) => {
    const tuple = expectArray(value, `chronolog_reducer_bundle.objects[${index}]`)
    canonicalInvariant(
      tuple.length === 2,
      'SCHEMA_INVALID',
      `chronolog_reducer_bundle.objects[${index}] has invalid arity`,
    )
    return {
      ref: exactObjectRefFromCbor(tuple[0] ?? null,
        `chronolog_reducer_bundle.objects[${index}].ref`),
      bytes: expectBytes(tuple[1] ?? null, `chronolog_reducer_bundle.objects[${index}].bytes`),
    }
  })
  for (let index = 1; index < objects.length; index += 1) {
    canonicalInvariant(
      compareObjectRefs(objects[index - 1]!.ref, objects[index]!.ref) < 0,
      'SCHEMA_INVALID',
      'Reducer invocation bundle object refs are not strictly sorted',
    )
  }
  return { version: 1, invocation, objects }
}

export function createChronologBundledObjectReader(
  bundle: ChronologReducerInvocationBundle,
): ExactObjectReader {
  const objects = new Map(bundle.objects.map((object) => [objectIdentity(object.ref), object] as const))
  return {
    async readExact(ref): Promise<Uint8Array> {
      const object = objects.get(objectIdentity(ref))
      if (object === undefined || compareObjectRefs(ref, object.ref) !== 0) {
        throw new Error('CHRONOLOG_BUNDLED_EXACT_OBJECT_MISSING')
      }
      if (ref.contentId.algorithm !== 'sha2-256') {
        throw new Error(`CHRONOLOG_BUNDLED_OBJECT_VERIFIER_REQUIRED:${ref.contentId.algorithm}`)
      }
      if (!sameBytes(await sha256(object.bytes), ref.contentId.digest)) {
        throw new Error('CHRONOLOG_BUNDLED_EXACT_OBJECT_DIGEST_MISMATCH')
      }
      return object.bytes.slice()
    },
  }
}

export function encodeChronologReducerApplicationResult(
  value: ChronologReducerApplicationResult,
): Uint8Array {
  canonicalInvariant(value.version === 1, 'SCHEMA_INVALID', 'Unsupported reducer result version')
  const selector = SELECTORS.indexOf(value.databaseSelector)
  const source = SOURCES.indexOf(value.selectedSource)
  canonicalInvariant(selector >= 0, 'SCHEMA_INVALID', 'Unknown reducer database selector')
  canonicalInvariant(source >= 0, 'SCHEMA_INVALID', 'Unknown reducer selected source')
  const exactReadSet = canonicalReadSet(value.exactReadSet)
  return encodeCanonicalCbor(integerMap([
    [0, 1n],
    [1, BigInt(selector + 1)],
    [2, BigInt(source + 1)],
    [3, value.payload],
    [4, exactReadSet.map(exactObjectRefToCbor)],
  ]))
}

export function decodeChronologReducerApplicationResult(
  bytes: Uint8Array,
): ChronologReducerApplicationResult {
  const map = expectMap(
    assertCanonicalCbor(bytes, DEFAULT_DECODE_LIMITS),
    'chronolog_reducer_result',
  )
  assertKnownIntegerKeys(map, [0, 1, 2, 3, 4], 'chronolog_reducer_result')
  canonicalInvariant(
    expectBigint(required(map, 0, 'chronolog_reducer_result.version'),
      'chronolog_reducer_result.version') === 1n,
    'SCHEMA_INVALID',
    'Unsupported reducer result version',
  )
  const selectorValue = expectBigint(
    required(map, 1, 'chronolog_reducer_result.database_selector'),
    'chronolog_reducer_result.database_selector',
  )
  const sourceValue = expectBigint(
    required(map, 2, 'chronolog_reducer_result.selected_source'),
    'chronolog_reducer_result.selected_source',
  )
  const selector = selectorValue >= 1n && selectorValue <= BigInt(SELECTORS.length)
    ? SELECTORS[Number(selectorValue - 1n)]
    : undefined
  const selectedSource = sourceValue >= 1n && sourceValue <= BigInt(SOURCES.length)
    ? SOURCES[Number(sourceValue - 1n)]
    : undefined
  canonicalInvariant(selector !== undefined, 'SCHEMA_INVALID', 'Unknown reducer database selector')
  canonicalInvariant(selectedSource !== undefined, 'SCHEMA_INVALID', 'Unknown reducer selected source')
  const exactReadSet = expectArray(
    required(map, 4, 'chronolog_reducer_result.exact_read_set'),
    'chronolog_reducer_result.exact_read_set',
  ).map((value, index) => exactObjectRefFromCbor(
    value,
    `chronolog_reducer_result.exact_read_set[${index}]`,
  ))
  for (let index = 1; index < exactReadSet.length; index += 1) {
    canonicalInvariant(
      compareObjectRefs(exactReadSet[index - 1]!, exactReadSet[index]!) < 0,
      'SCHEMA_INVALID',
      'Reducer exact read set is not strictly sorted',
    )
  }
  return {
    version: 1,
    databaseSelector: selector,
    selectedSource,
    payload: expectBytes(required(map, 3, 'chronolog_reducer_result.payload'),
      'chronolog_reducer_result.payload'),
    exactReadSet,
  }
}

/** The workerd canonical-value encoding of one Uint8Array is canonical CBOR. */
export function encodeDatabaseReducerByteString(value: Uint8Array): Uint8Array {
  return encodeCanonicalCbor(value)
}

export function decodeDatabaseReducerByteString(value: Uint8Array): Uint8Array {
  return expectBytes(
    assertCanonicalCbor(value, DEFAULT_DECODE_LIMITS),
    'database_reducer_byte_string',
  )
}

function canonicalReadSet(value: readonly ExactObjectRef[]): readonly ExactObjectRef[] {
  const result = [...value].sort(compareObjectRefs)
  for (let index = 1; index < result.length; index += 1) {
    canonicalInvariant(
      compareObjectRefs(result[index - 1]!, result[index]!) < 0,
      'SCHEMA_INVALID',
      'Reducer exact read set contains a duplicate',
    )
  }
  return result
}

function objectIdentity(ref: ExactObjectRef): string {
  return [
    bytesIdentity(ref.storeId),
    ref.codec.number.toString(10),
    ref.codec.version.toString(10),
    ref.contentId.algorithm,
    bytesIdentity(ref.contentId.digest),
  ].join(':')
}

function bytesIdentity(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join('')
}
