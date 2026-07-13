import { canonicalInvariant } from './errors.js'

export function uint32Bytes(value: number): Uint8Array {
  canonicalInvariant(Number.isSafeInteger(value) && value >= 0 && value <= 0xffff_ffff, 'INTEGER_OUT_OF_RANGE', 'Value is outside uint32')
  const bytes = new Uint8Array(4); new DataView(bytes.buffer).setUint32(0, value, false); return bytes
}
export function uint64Bytes(value: bigint): Uint8Array {
  canonicalInvariant(value >= 0n && value <= (1n << 64n) - 1n, 'INTEGER_OUT_OF_RANGE', 'Value is outside uint64')
  const bytes = new Uint8Array(8); new DataView(bytes.buffer).setBigUint64(0, value, false); return bytes
}
export function int64Bytes(value: bigint): Uint8Array {
  canonicalInvariant(value >= -(1n << 63n) && value <= (1n << 63n) - 1n, 'INTEGER_OUT_OF_RANGE', 'Value is outside int64')
  const bytes = new Uint8Array(8); new DataView(bytes.buffer).setBigInt64(0, value, false); return bytes
}
export function bytesToUint32(bytes: Uint8Array): number { canonicalInvariant(bytes.length === 4, 'SCHEMA_INVALID', 'uint32 requires 4 bytes'); return new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, false) }
export function bytesToUint64(bytes: Uint8Array): bigint { canonicalInvariant(bytes.length === 8, 'SCHEMA_INVALID', 'uint64 requires 8 bytes'); return new DataView(bytes.buffer, bytes.byteOffset, 8).getBigUint64(0, false) }
export function bytesToInt64(bytes: Uint8Array): bigint { canonicalInvariant(bytes.length === 8, 'SCHEMA_INVALID', 'int64 requires 8 bytes'); return new DataView(bytes.buffer, bytes.byteOffset, 8).getBigInt64(0, false) }
