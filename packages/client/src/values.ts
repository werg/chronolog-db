import { utf8 } from '@chronolog/canonical'
import { encodeLogicalValues, type CanonicalJsonValue, type LogicalValue } from '@chronolog/ir'

const MIN_INT64 = -(2n ** 63n)
const MAX_INT64 = 2n ** 63n - 1n

export type LogicalInput = LogicalValue

export function int64(value: bigint | number): LogicalValue {
  const exact = typeof value === 'number' ? safeInteger(value, 'Int64') : value
  assertInt64(exact, 'Int64')
  return Object.freeze({ kind: 'int64', value: exact })
}

export function boolean(value: boolean): LogicalValue {
  return Object.freeze({ kind: 'boolean', value })
}

export function decimal(
  value: string,
  options: { readonly precision: number; readonly scale: number },
): LogicalValue {
  if (!Number.isSafeInteger(options.precision) || options.precision < 1) throw new RangeError('Decimal precision must be positive')
  if (!Number.isSafeInteger(options.scale) || options.scale < 0 || options.scale > options.precision) throw new RangeError('Decimal scale is invalid')
  const match = /^(-?)(0|[1-9][0-9]*)(?:\.([0-9]+))?$/u.exec(value)
  if (!match) throw new TypeError('Decimal text must be canonical base-10 notation without an exponent')
  const fraction = match[3] ?? ''
  if (fraction.length !== options.scale) throw new RangeError('Decimal text does not match the declared scale')
  const integral = match[2]!
  const digits = `${integral}${fraction}`
  if (digits.length > options.precision) throw new RangeError('Decimal exceeds declared precision')
  const coefficient = BigInt(`${match[1] ?? ''}${digits}`)
  return Object.freeze({ kind: 'decimal', coefficient, scale: options.scale })
}

export function timestampMs(value: bigint | number): LogicalValue {
  const exact = typeof value === 'number' ? safeInteger(value, 'Timestamp') : value
  assertInt64(exact, 'Timestamp')
  return Object.freeze({ kind: 'timestamp_ms', value: exact })
}

export function timestampMsFromDate(value: Date): LogicalValue {
  const milliseconds = value.getTime()
  if (!Number.isSafeInteger(milliseconds)) throw new RangeError('Date cannot be represented as an exact UTC millisecond timestamp')
  return timestampMs(BigInt(milliseconds))
}

export function durationMs(value: bigint | number): LogicalValue {
  const exact = typeof value === 'number' ? safeInteger(value, 'Duration') : value
  assertInt64(exact, 'Duration')
  return Object.freeze({ kind: 'duration_ms', value: exact })
}

export function text(value: string): LogicalValue {
  return Object.freeze({ kind: 'text', utf8: utf8(value) })
}

export function blob(value: Uint8Array): LogicalValue {
  return Object.freeze({ kind: 'blob', bytes: Uint8Array.from(value) })
}

export function uuid(value: Uint8Array): LogicalValue {
  if (value.byteLength !== 16) throw new RangeError('UUID values must contain exactly 16 bytes')
  return Object.freeze({ kind: 'uuid', bytes: Uint8Array.from(value) })
}

export function jsonValue(value: unknown): LogicalValue {
  return Object.freeze({ kind: 'json', value: canonicalJson(value, new Set()) })
}

export function vectorInt8(value: Int8Array): LogicalValue {
  const bytes = new Uint8Array(value.byteLength)
  bytes.set(new Uint8Array(value.buffer, value.byteOffset, value.byteLength))
  return Object.freeze({ kind: 'vector', element: 'i8', dimensions: value.length, bytes })
}

export function vectorFloat32(value: Float32Array | readonly number[]): LogicalValue {
  const values = value instanceof Float32Array ? value : Float32Array.from(value)
  const bytes = new Uint8Array(values.length * 4)
  const view = new DataView(bytes.buffer)
  for (let index = 0; index < values.length; index += 1) {
    const item = values[index]!
    if (!Number.isFinite(item)) throw new TypeError('Float32 vectors require finite elements')
    view.setFloat32(index * 4, item, false)
  }
  return Object.freeze({ kind: 'vector', element: 'f32', dimensions: values.length, bytes })
}

export function encodeLogicalParameters(values: readonly LogicalInput[] = []): Uint8Array {
  return encodeLogicalValues(values.map(copyLogicalValue))
}

function copyLogicalValue(value: LogicalValue): LogicalValue {
  switch (value.kind) {
    case 'text': return { ...value, utf8: Uint8Array.from(value.utf8) }
    case 'blob': return { ...value, bytes: Uint8Array.from(value.bytes) }
    case 'uuid': return { ...value, bytes: Uint8Array.from(value.bytes) }
    case 'vector': return { ...value, bytes: Uint8Array.from(value.bytes) }
    default: return value
  }
}

function canonicalJson(value: unknown, ancestors: Set<object>): CanonicalJsonValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string' || typeof value === 'bigint') return value
  if (typeof value === 'number') return safeInteger(value, 'JSON number')
  if (typeof value !== 'object') throw new TypeError('JSON values cannot contain undefined, functions, or symbols')
  if (ancestors.has(value)) throw new TypeError('JSON values cannot contain cycles')
  ancestors.add(value)
  try {
    if (Array.isArray(value)) return Object.freeze(value.map((item) => canonicalJson(item, ancestors)))
    if (value instanceof Map) {
      const entries = [...value.entries()]
      if (!entries.every((entry): entry is [string, unknown] => typeof entry[0] === 'string')) throw new TypeError('JSON map keys must be strings')
      entries.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      return new Map(entries.map(([key, item]) => [key, canonicalJson(item, ancestors)]))
    }
    const record = value as Record<string, unknown>
    const entries = Object.keys(record).sort().map((key) => [key, canonicalJson(record[key], ancestors)] as const)
    return new Map(entries)
  } finally {
    ancestors.delete(value)
  }
}

function safeInteger(value: number, label: string): bigint {
  if (!Number.isSafeInteger(value)) throw new RangeError(`${label} number must be a safe integer`)
  return BigInt(value)
}

function assertInt64(value: bigint, label: string): void {
  if (value < MIN_INT64 || value > MAX_INT64) throw new RangeError(`${label} is outside the signed 64-bit range`)
}
