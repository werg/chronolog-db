import type { CborMapKey, CborValue } from './cbor.js'
import { CanonicalError, canonicalInvariant } from './errors.js'

export type IntegerMap = ReadonlyMap<CborMapKey, CborValue>
export function integerMap(entries: readonly (readonly [number, CborValue | undefined])[]): IntegerMap { const map = new Map<CborMapKey, CborValue>(); for (const [key, value] of entries) if (value !== undefined) map.set(BigInt(key), value); return map }
export function expectMap(value: CborValue, name: string): IntegerMap { canonicalInvariant(value instanceof Map, 'SCHEMA_INVALID', `${name} must be a map`); return value }
export function expectArray(value: CborValue, name: string): readonly CborValue[] { canonicalInvariant(Array.isArray(value), 'SCHEMA_INVALID', `${name} must be an array`); return value }
export function expectBytes(value: CborValue, name: string, length?: number): Uint8Array { canonicalInvariant(value instanceof Uint8Array, 'SCHEMA_INVALID', `${name} must be bytes`); if (length !== undefined) canonicalInvariant(value.length === length, 'SCHEMA_INVALID', `${name} must contain ${length} bytes`); return Uint8Array.from(value) }
export function expectString(value: CborValue, name: string): string { canonicalInvariant(typeof value === 'string', 'SCHEMA_INVALID', `${name} must be text`); return value }
export function expectBoolean(value: CborValue, name: string): boolean { canonicalInvariant(typeof value === 'boolean', 'SCHEMA_INVALID', `${name} must be boolean`); return value }
export function expectBigint(value: CborValue, name: string): bigint { canonicalInvariant(typeof value === 'bigint', 'SCHEMA_INVALID', `${name} must be integer`); return value }
export function expectUint(value: CborValue, name: string, maximum = BigInt(Number.MAX_SAFE_INTEGER)): number { const n = expectBigint(value, name); canonicalInvariant(n >= 0n && n <= maximum && n <= BigInt(Number.MAX_SAFE_INTEGER), 'INTEGER_OUT_OF_RANGE', `${name} is outside range`); return Number(n) }
export function expectUint64(value: CborValue, name: string): bigint { const n = expectBigint(value, name); canonicalInvariant(n >= 0n && n <= (1n << 64n) - 1n, 'INTEGER_OUT_OF_RANGE', `${name} is outside uint64`); return n }
export function expectInt64(value: CborValue, name: string): bigint { const n = expectBigint(value, name); canonicalInvariant(n >= -(1n << 63n) && n <= (1n << 63n) - 1n, 'INTEGER_OUT_OF_RANGE', `${name} is outside int64`); return n }
export function required(map: IntegerMap, key: number, name: string): CborValue { const value = map.get(BigInt(key)); if (value === undefined) throw new CanonicalError('SCHEMA_INVALID', `Missing required field ${name}`); return value }
export function optional(map: IntegerMap, key: number): CborValue | undefined { return map.get(BigInt(key)) }
export function assertKnownIntegerKeys(map: IntegerMap, keys: readonly number[], name: string): void { const known = new Set(keys.map(BigInt)); for (const key of map.keys()) canonicalInvariant(typeof key === 'bigint' && known.has(key), 'SCHEMA_INVALID', `${name} contains an unknown field`) }
