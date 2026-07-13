import { decodeUtf8 } from '@chronolog/canonical'
import {
  decodeCanonicalQueryResult as decodeIrCanonicalQueryResult,
  encodeLogicalValues,
  type CanonicalJsonValue as IrCanonicalJsonValue,
  type LogicalValue,
  type VectorElementType,
} from '@chronolog/ir'
import type {
  CanonicalQueryResult,
  DisplayValue,
  LogicalResultColumn,
  ResultModeName,
} from '@chronolog/rpc'

export type Int64 = bigint & { readonly __chronologInt64: unique symbol }
export type TimestampMs = bigint & { readonly __chronologTimestampMs: unique symbol }
export type DurationMs = bigint & { readonly __chronologDurationMs: unique symbol }
export type Uuid = Uint8Array & { readonly __chronologUuid: unique symbol }

export interface DecimalValue {
  readonly coefficient: bigint
  readonly scale: number
  toString(): string
}

export interface CanonicalJsonValue {
  readonly canonicalJson: string
  decode(): unknown
}

export type DecodedLogicalValue =
  | null
  | boolean
  | bigint
  | DecimalValue
  | string
  | Uint8Array
  | CanonicalJsonValue
  | Int8Array
  | Int16Array
  | Int32Array
  | Float32Array
  | Float64Array

export interface DecodedCanonicalResult {
  readonly schema: readonly LogicalResultColumn[]
  readonly resultMode: ResultModeName
  readonly canonicalBytes: Uint8Array
  readonly resultDigest: string
  readonly rows: readonly (readonly DecodedLogicalValue[])[]
  readonly displayTruncated: boolean
}

export interface Query<
  Row,
  Mode extends ResultModeName = ResultModeName,
  Parameters = undefined,
> {
  readonly canonicalBytes: Uint8Array
  readonly resultMode: Mode
  readonly schemaDigest?: string
  readonly executionManifestDigest?: string
  readonly parameterNames: readonly string[]
  encodeParameters(parameters: Parameters): Uint8Array
  decodeResult(result: DecodedCanonicalResult): Row
}

export interface QueryBindingOptions<Row, Mode extends ResultModeName, Parameters> {
  readonly canonicalBytes: Uint8Array
  readonly resultMode: Mode
  readonly encodeParameters?: (parameters: Parameters) => Uint8Array
  readonly decodeResult: (result: DecodedCanonicalResult) => Row
  readonly schemaDigest?: string
  readonly executionManifestDigest?: string
  readonly parameterNames?: readonly string[]
}

/** Creates a generated-binding-compatible immutable query value. */
export function defineQuery<Row, Mode extends ResultModeName, Parameters = undefined>(
  options: QueryBindingOptions<Row, Mode, Parameters>,
): Query<Row, Mode, Parameters> {
  const canonicalBytes = Uint8Array.from(options.canonicalBytes)
  const parameterNames = [...(options.parameterNames ?? [])]
  const seen = new Set<string>()
  for (const name of parameterNames) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) throw new TypeError(`Invalid parameter name ${name}`)
    if (seen.has(name)) throw new TypeError(`Duplicate parameter name ${name}`)
    seen.add(name)
  }
  return Object.freeze({
    get canonicalBytes() { return Uint8Array.from(canonicalBytes) },
    resultMode: options.resultMode,
    ...(options.schemaDigest === undefined ? {} : { schemaDigest: options.schemaDigest }),
    ...(options.executionManifestDigest === undefined
      ? {}
      : { executionManifestDigest: options.executionManifestDigest }),
    parameterNames: Object.freeze(parameterNames),
    encodeParameters: (parameters: Parameters) => Uint8Array.from(
      options.encodeParameters?.(parameters) ?? encodeLogicalValues([]),
    ),
    decodeResult: options.decodeResult,
  })
}

export type MutationKind = 'insert' | 'update' | 'delete' | 'upsert' | 'merge' | 'registered_call'

export interface Mutation<Kind extends MutationKind = MutationKind> {
  readonly kind: Kind
  readonly canonicalBytes: Uint8Array
  readonly applicationLabel?: string
}

export function defineMutation<Kind extends MutationKind>(
  kind: Kind,
  canonicalBytes: Uint8Array,
  applicationLabel?: string,
): Mutation<Kind> {
  return Object.freeze({
    kind,
    get canonicalBytes() { return Uint8Array.from(canonicalBytes) },
    ...(applicationLabel === undefined ? {} : { applicationLabel }),
  })
}

export type ContextField =
  | 'group_id'
  | 'membership_revision'
  | 'validation_policy'
  | 'author_id'
  | 'author_timestamp_ms'
  | 'transaction_nonce'
  | 'candidate_digest'
  | 'transaction_id'
  | 'author_feed_sequence'

export interface ContextExpression<T> {
  readonly kind: 'context'
  readonly field: ContextField
  readonly __value?: T
}

export interface EntropyExpression {
  readonly kind: 'entropy'
  readonly label: string
  readonly index: number
  readonly length: number
}

export function contextExpression<T>(field: ContextField): ContextExpression<T> {
  return Object.freeze({ kind: 'context', field })
}

export function entropyExpression(label: string, index: number, length: number): EntropyExpression {
  if (!/^[\x21-\x7e]+$/u.test(label)) throw new TypeError('Entropy labels must be non-empty printable ASCII')
  if (!Number.isSafeInteger(index) || index < 0) throw new RangeError('Entropy index must be a non-negative safe integer')
  if (!Number.isSafeInteger(length) || length <= 0) throw new RangeError('Entropy length must be a positive safe integer')
  return Object.freeze({ kind: 'entropy', label, index, length })
}

export function decodeCanonicalResult(result: CanonicalQueryResult): DecodedCanonicalResult {
  const canonicalBytes = fromBase64Url(result.canonicalResult)
  const decoded = decodeIrCanonicalQueryResult(canonicalBytes)
  if (decoded.resultMode.kind !== result.resultMode) throw new TypeError('Canonical result mode does not match RPC metadata')
  if (decoded.columns.length !== result.schema.length || decoded.columns.some((column, index) => {
    const metadata = result.schema[index]
    return metadata === undefined || column.id !== metadata.id || column.name !== metadata.name
  })) throw new TypeError('Canonical result schema does not match RPC metadata')
  return Object.freeze({
    schema: result.schema.map((column) => Object.freeze({ ...column })),
    resultMode: result.resultMode,
    canonicalBytes,
    resultDigest: result.resultDigest,
    rows: decoded.rows.map((row) => Object.freeze(row.map(decodeLogicalValue))),
    displayTruncated: result.displayTruncated,
  })
}

export function decodeLogicalValue(value: LogicalValue): DecodedLogicalValue {
  switch (value.kind) {
    case 'null': return null
    case 'boolean': return value.value
    case 'int64': return value.value
    case 'decimal': return decimalFromParts(value.coefficient, value.scale)
    case 'text': return decodeUtf8(value.utf8)
    case 'blob': return Uint8Array.from(value.bytes)
    case 'uuid': return Uint8Array.from(value.bytes) as Uuid
    case 'timestamp_ms': return value.value as TimestampMs
    case 'duration_ms': return value.value as DurationMs
    case 'json': return jsonWrapper(value.value)
    case 'vector': return decodeVector(value.element, value.dimensions, value.bytes)
  }
}

export function decodeDisplayValue(value: DisplayValue): DecodedLogicalValue {
  switch (value.kind) {
    case 'null': return null
    case 'boolean': return value.value
    case 'int64': return BigInt(value.value)
    case 'decimal': return decimalFromParts(BigInt(value.coefficient), value.scale)
    case 'text': return value.value
    case 'blob': return fromBase64Url(value.value)
    case 'uuid': return fromBase64Url(value.value) as Uuid
    case 'timestamp_ms': return BigInt(value.value) as TimestampMs
    case 'duration_ms': return BigInt(value.value) as DurationMs
    case 'json': {
      const canonicalJson = value.canonicalJson
      return Object.freeze({ canonicalJson, decode: () => deepFreeze(JSON.parse(canonicalJson) as unknown) })
    }
    case 'vector': {
      const bytes = fromBase64Url(value.value)
      return decodeVector(value.element, value.dimensions, bytes)
    }
  }
}

export function formatUuid(value: Uuid): string {
  if (value.byteLength !== 16) throw new RangeError('UUID values must contain exactly 16 bytes')
  const hex = [...value].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export function formatTimestampMs(value: TimestampMs): string {
  const number = Number(value)
  if (!Number.isSafeInteger(number)) throw new RangeError('Timestamp is outside the JavaScript Date exact range')
  const date = new Date(number)
  if (Number.isNaN(date.getTime())) throw new RangeError('Timestamp is outside the JavaScript Date range')
  return date.toISOString()
}

export function toBase64Url(value: Uint8Array): string {
  let binary = ''
  for (const byte of value) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/gu, '')
}

export function fromBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/u.test(value)) throw new TypeError('Canonical bytes must use unpadded base64url')
  const padding = '='.repeat((4 - value.length % 4) % 4)
  const binary = atob(value.replace(/-/gu, '+').replace(/_/gu, '/') + padding)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

function decimalFromParts(coefficient: bigint, scale: number): DecimalValue {
  if (!Number.isSafeInteger(scale) || scale < 0) throw new TypeError('Invalid decimal scale')
  return Object.freeze({
    coefficient,
    scale,
    toString() {
      const negative = coefficient < 0n
      const digits = (negative ? -coefficient : coefficient).toString().padStart(scale + 1, '0')
      const rendered = scale === 0 ? digits : `${digits.slice(0, -scale)}.${digits.slice(-scale)}`
      return negative ? `-${rendered}` : rendered
    },
  })
}

function jsonWrapper(value: IrCanonicalJsonValue): CanonicalJsonValue {
  const canonicalJson = canonicalJsonText(value)
  return Object.freeze({ canonicalJson, decode: () => immutableCanonicalJson(value) })
}

function canonicalJsonText(value: IrCanonicalJsonValue): string {
  if (value === null) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'bigint') return value.toString(10)
  if (typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJsonText).join(',')}]`
  if (value instanceof Map) {
    return `{${[...value.entries()].map(([key, item]) => `${JSON.stringify(key)}:${canonicalJsonText(item)}`).join(',')}}`
  }
  const decimal = value as { readonly coefficient: bigint; readonly scale: number }
  return decimalFromParts(decimal.coefficient, decimal.scale).toString()
}

function immutableCanonicalJson(value: IrCanonicalJsonValue): unknown {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return Object.freeze(value.map(immutableCanonicalJson))
  if (value instanceof Map) {
    return Object.freeze(Object.fromEntries([...value].map(([key, item]) => [key, immutableCanonicalJson(item)])))
  }
  const decimal = value as { readonly coefficient: bigint; readonly scale: number }
  return decimalFromParts(decimal.coefficient, decimal.scale)
}

function decodeVector(
  element: VectorElementType,
  dimensions: number,
  bytes: Uint8Array,
): Int8Array | Uint8Array | Int16Array | Int32Array | Float32Array | Float64Array {
  const widths: Readonly<Record<VectorElementType, number>> = {
    i8: 1, u8: 1, i16: 2, i32: 4, f32: 4, f64: 8,
  }
  if (bytes.byteLength !== dimensions * widths[element]) throw new TypeError('Invalid vector byte length')
  if (element === 'u8') return Uint8Array.from(bytes)
  if (element === 'i8') return Int8Array.from(bytes, (value) => value > 0x7f ? value - 0x100 : value)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (element === 'i16') return Int16Array.from({ length: dimensions }, (_, index) => view.getInt16(index * 2, false))
  if (element === 'i32') return Int32Array.from({ length: dimensions }, (_, index) => view.getInt32(index * 4, false))
  if (element === 'f32') return Float32Array.from({ length: dimensions }, (_, index) => view.getFloat32(index * 4, false))
  return Float64Array.from({ length: dimensions }, (_, index) => view.getFloat64(index * 8, false))
}

function deepFreeze(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return value
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item)
  } else {
    for (const item of Object.values(value)) deepFreeze(item)
  }
  return Object.freeze(value)
}
