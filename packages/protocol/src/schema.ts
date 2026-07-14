import type { CborMapKey, CborValue } from './cbor.js'
import { ProtocolError, protocolInvariant } from './errors.js'

export type IntegerMap = ReadonlyMap<CborMapKey, CborValue>

export function integerMap(entries: readonly (readonly [number, CborValue | undefined])[]): IntegerMap {
  const result = new Map<CborMapKey, CborValue>()
  for (const [key, value] of entries) {
    if (value !== undefined) result.set(BigInt(key), value)
  }
  return result
}

export function expectMap(value: CborValue, name: string): IntegerMap {
  protocolInvariant(value instanceof Map, 'SCHEMA_INVALID', `${name} must be a CBOR map`)
  return value
}

export function expectArray(value: CborValue, name: string): readonly CborValue[] {
  protocolInvariant(Array.isArray(value), 'SCHEMA_INVALID', `${name} must be a CBOR array`)
  return value as readonly CborValue[]
}

export function expectBytes(value: CborValue, name: string, length?: number): Uint8Array {
  protocolInvariant(value instanceof Uint8Array, 'SCHEMA_INVALID', `${name} must be bytes`)
  if (length !== undefined) {
    protocolInvariant(value.length === length, 'SCHEMA_INVALID', `${name} must contain ${length} bytes`)
  }
  return value
}

export function expectString(value: CborValue, name: string): string {
  protocolInvariant(typeof value === 'string', 'SCHEMA_INVALID', `${name} must be text`)
  return value
}

export function expectBigint(value: CborValue, name: string): bigint {
  protocolInvariant(typeof value === 'bigint', 'SCHEMA_INVALID', `${name} must be an integer`)
  return value
}

export function expectUint64(value: CborValue, name: string): bigint {
  const integer = expectBigint(value, name)
  protocolInvariant(integer >= 0n && integer <= (1n << 64n) - 1n, 'INTEGER_OUT_OF_RANGE', `${name} is outside uint64 range`)
  return integer
}

export function expectInt64(value: CborValue, name: string): bigint {
  const integer = expectBigint(value, name)
  protocolInvariant(integer >= -(1n << 63n) && integer <= (1n << 63n) - 1n, 'INTEGER_OUT_OF_RANGE', `${name} is outside int64 range`)
  return integer
}

export function required(map: IntegerMap, key: number, name: string): CborValue {
  const value = map.get(BigInt(key))
  if (value === undefined) throw new ProtocolError('SCHEMA_INVALID', `Missing required field ${name}`, { field: name })
  return value
}

export function optional(map: IntegerMap, key: number): CborValue | undefined {
  return map.get(BigInt(key))
}

export function assertKnownIntegerKeys(
  map: IntegerMap,
  knownKeys: readonly number[],
  name: string,
): void {
  const known = new Set(knownKeys.map(BigInt))
  for (const key of map.keys()) {
    protocolInvariant(typeof key === 'bigint', 'SCHEMA_INVALID', `${name} contains a non-integer field key`)
    protocolInvariant(known.has(key), 'SCHEMA_INVALID', `${name} contains unknown critical field ${String(key)}`)
  }
}

export function expectVersion(map: IntegerMap, expected: bigint, name: string): void {
  const version = expectUint64(required(map, 0, `${name}.version`), `${name}.version`)
  protocolInvariant(version === expected, 'UNSUPPORTED_VERSION', `Unsupported ${name} version`, { version: version.toString() })
}
