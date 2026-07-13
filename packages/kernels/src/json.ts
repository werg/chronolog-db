import { compareBytes } from './vector.js'
import { KernelError, kernelAssert } from './errors.js'

export type CanonicalJsonValue =
  | { readonly kind: 'null' }
  | { readonly kind: 'boolean'; readonly value: boolean }
  | { readonly kind: 'number'; readonly coefficient: bigint; readonly scale: number }
  | { readonly kind: 'string'; readonly utf8: Uint8Array }
  | { readonly kind: 'array'; readonly values: readonly CanonicalJsonValue[] }
  | { readonly kind: 'object'; readonly entries: readonly CanonicalJsonEntry[] }

export interface CanonicalJsonEntry {
  readonly key: Uint8Array
  readonly value: CanonicalJsonValue
}

export interface JsonLimits {
  readonly maxBytes: number
  readonly maxDepth: number
  readonly maxNodes: number
  readonly maxStringBytes: number
  readonly maxNumberDigits: number
}

export const DEFAULT_JSON_LIMITS: JsonLimits = Object.freeze({
  maxBytes: 1_048_576,
  maxDepth: 128,
  maxNodes: 100_000,
  maxStringBytes: 1_048_576,
  maxNumberDigits: 10_000,
})

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

function frozenBytes(value: string): Uint8Array {
  return encoder.encode(value)
}

class Parser {
  readonly source: string
  readonly limits: JsonLimits
  index = 0
  nodes = 0

  constructor(source: string, limits: JsonLimits) {
    this.source = source
    this.limits = limits
  }

  fail(message: string): never {
    throw new KernelError('INVALID_JSON', message, this.index)
  }

  bumpNode(depth: number): void {
    this.nodes += 1
    kernelAssert(this.nodes <= this.limits.maxNodes, 'SEMANTIC_RESOURCE_LIMIT', 'JSON node limit exceeded', this.index)
    kernelAssert(depth <= this.limits.maxDepth, 'JSON_DEPTH_LIMIT', 'JSON depth limit exceeded', this.index)
  }

  whitespace(): void {
    while (this.source[this.index] === ' ' || this.source[this.index] === '\n' || this.source[this.index] === '\r' || this.source[this.index] === '\t') this.index += 1
  }

  value(depth: number): CanonicalJsonValue {
    this.bumpNode(depth)
    this.whitespace()
    const char = this.source[this.index]
    if (char === 'n' && this.source.slice(this.index, this.index + 4) === 'null') { this.index += 4; return Object.freeze({ kind: 'null' }) }
    if (char === 't' && this.source.slice(this.index, this.index + 4) === 'true') { this.index += 4; return Object.freeze({ kind: 'boolean', value: true }) }
    if (char === 'f' && this.source.slice(this.index, this.index + 5) === 'false') { this.index += 5; return Object.freeze({ kind: 'boolean', value: false }) }
    if (char === '"') return Object.freeze({ kind: 'string', utf8: frozenBytes(this.string()) })
    if (char === '[') return this.array(depth)
    if (char === '{') return this.object(depth)
    if (char === '-' || (char !== undefined && char >= '0' && char <= '9')) return this.number()
    return this.fail('expected JSON value')
  }

  string(): string {
    if (this.source[this.index] !== '"') this.fail('expected JSON string')
    this.index += 1
    let result = ''
    while (this.index < this.source.length) {
      const char = this.source[this.index]!
      this.index += 1
      if (char === '"') {
        kernelAssert(encoder.encode(result).length <= this.limits.maxStringBytes, 'SEMANTIC_RESOURCE_LIMIT', 'JSON string limit exceeded', this.index)
        return result
      }
      if (char === '\\') {
        const escaped = this.source[this.index]
        this.index += 1
        if (escaped === '"' || escaped === '\\' || escaped === '/') result += escaped
        else if (escaped === 'b') result += '\b'
        else if (escaped === 'f') result += '\f'
        else if (escaped === 'n') result += '\n'
        else if (escaped === 'r') result += '\r'
        else if (escaped === 't') result += '\t'
        else if (escaped === 'u') result += this.unicodeEscape()
        else this.fail('invalid JSON escape')
        continue
      }
      const code = char.charCodeAt(0)
      if (code < 0x20) this.fail('unescaped JSON control character')
      if (code >= 0xd800 && code <= 0xdbff) {
        const low = this.source.charCodeAt(this.index)
        if (!(low >= 0xdc00 && low <= 0xdfff)) this.fail('unpaired high surrogate')
        result += char + this.source[this.index]!
        this.index += 1
      } else {
        if (code >= 0xdc00 && code <= 0xdfff) this.fail('unpaired low surrogate')
        result += char
      }
    }
    return this.fail('unterminated JSON string')
  }

  unicodeEscape(): string {
    const firstText = this.source.slice(this.index, this.index + 4)
    if (!/^[0-9a-fA-F]{4}$/.test(firstText)) this.fail('invalid Unicode escape')
    this.index += 4
    const first = Number.parseInt(firstText, 16)
    if (first >= 0xd800 && first <= 0xdbff) {
      if (this.source.slice(this.index, this.index + 2) !== '\\u') this.fail('unpaired Unicode high surrogate')
      this.index += 2
      const lowText = this.source.slice(this.index, this.index + 4)
      if (!/^[dD][c-fC-F][0-9a-fA-F]{2}$/.test(lowText)) this.fail('invalid Unicode low surrogate')
      this.index += 4
      const low = Number.parseInt(lowText, 16)
      return String.fromCodePoint(0x10000 + ((first - 0xd800) << 10) + low - 0xdc00)
    }
    if (first >= 0xdc00 && first <= 0xdfff) this.fail('unpaired Unicode low surrogate')
    return String.fromCodePoint(first)
  }

  number(): CanonicalJsonValue {
    const rest = this.source.slice(this.index)
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?/.exec(rest)
    if (!match) return this.fail('invalid JSON number')
    const token = match[0]
    const next = rest[token.length]
    if (next !== undefined && !/[\s,\]}]/.test(next)) this.fail('invalid JSON number suffix')
    const digitCount = (token.match(/[0-9]/g) ?? []).length
    kernelAssert(digitCount <= this.limits.maxNumberDigits, 'SEMANTIC_RESOURCE_LIMIT', 'JSON number digit limit exceeded', this.index)
    this.index += token.length
    const exponent = Number.parseInt(match[2] ?? '0', 10)
    kernelAssert(Number.isSafeInteger(exponent) && Math.abs(exponent) <= this.limits.maxNumberDigits, 'SEMANTIC_RESOURCE_LIMIT', 'JSON exponent out of range', this.index)
    const negative = token.startsWith('-')
    const mantissa = token.replace(/^-/, '').replace(/[eE].*$/, '')
    const digits = mantissa.replace('.', '')
    let coefficient = BigInt(digits) * (negative ? -1n : 1n)
    let scale = (match[1]?.length ?? 0) - exponent
    if (scale < 0) { coefficient *= 10n ** BigInt(-scale); scale = 0 }
    while (scale > 0 && coefficient % 10n === 0n) { coefficient /= 10n; scale -= 1 }
    if (coefficient === 0n) scale = 0
    return Object.freeze({ kind: 'number', coefficient, scale })
  }

  array(depth: number): CanonicalJsonValue {
    this.index += 1
    const values: CanonicalJsonValue[] = []
    this.whitespace()
    if (this.source[this.index] === ']') { this.index += 1; return Object.freeze({ kind: 'array', values: Object.freeze(values) }) }
    for (;;) {
      values.push(this.value(depth + 1))
      this.whitespace()
      const char = this.source[this.index]
      this.index += 1
      if (char === ']') break
      if (char !== ',') this.fail('expected comma or array end')
      this.whitespace()
      if (this.source[this.index] === ']') this.fail('trailing array comma')
    }
    return Object.freeze({ kind: 'array', values: Object.freeze(values) })
  }

  object(depth: number): CanonicalJsonValue {
    this.index += 1
    const entries: CanonicalJsonEntry[] = []
    const seen = new Set<string>()
    this.whitespace()
    if (this.source[this.index] === '}') { this.index += 1; return Object.freeze({ kind: 'object', entries: Object.freeze(entries) }) }
    for (;;) {
      if (this.source[this.index] !== '"') this.fail('expected object key')
      const keyText = this.string()
      if (seen.has(keyText)) throw new KernelError('JSON_DUPLICATE_KEY', `duplicate JSON key ${escapeJsonString(keyText)}`, this.index)
      seen.add(keyText)
      this.whitespace()
      if (this.source[this.index] !== ':') this.fail('expected object colon')
      this.index += 1
      entries.push(Object.freeze({ key: frozenBytes(keyText), value: this.value(depth + 1) }))
      this.whitespace()
      const char = this.source[this.index]
      this.index += 1
      if (char === '}') break
      if (char !== ',') this.fail('expected comma or object end')
      this.whitespace()
      if (this.source[this.index] === '}') this.fail('trailing object comma')
    }
    entries.sort((a, b) => compareBytes(a.key, b.key))
    return Object.freeze({ kind: 'object', entries: Object.freeze(entries) })
  }
}

export function parseCanonicalJson(input: string | Uint8Array, limits: JsonLimits = DEFAULT_JSON_LIMITS): CanonicalJsonValue {
  let source: string
  try { source = typeof input === 'string' ? input : decoder.decode(input) }
  catch { throw new KernelError('INVALID_UTF8', 'JSON input is not valid UTF-8') }
  kernelAssert(encoder.encode(source).length <= limits.maxBytes, 'SEMANTIC_RESOURCE_LIMIT', 'JSON byte limit exceeded')
  const parser = new Parser(source, limits)
  const value = parser.value(0)
  parser.whitespace()
  if (parser.index !== source.length) throw new KernelError('INVALID_JSON', 'trailing JSON content', parser.index)
  return value
}

function escapeJsonString(value: string): string {
  let result = '"'
  for (const scalar of value) {
    const code = scalar.codePointAt(0)!
    if (scalar === '"') result += '\\"'
    else if (scalar === '\\') result += '\\\\'
    else if (code === 0x08) result += '\\b'
    else if (code === 0x0c) result += '\\f'
    else if (code === 0x0a) result += '\\n'
    else if (code === 0x0d) result += '\\r'
    else if (code === 0x09) result += '\\t'
    else if (code < 0x20) result += `\\u${code.toString(16).padStart(4, '0')}`
    else result += scalar
  }
  return `${result}"`
}

function formatJsonNumber(coefficient: bigint, scale: number): string {
  if (coefficient === 0n) return '0'
  const negative = coefficient < 0n
  const digits = (negative ? -coefficient : coefficient).toString().padStart(scale + 1, '0')
  const body = scale === 0 ? digits : `${digits.slice(0, -scale)}.${digits.slice(-scale)}`
  return negative ? `-${body}` : body
}

export function serializeCanonicalJson(value: CanonicalJsonValue): string {
  switch (value.kind) {
    case 'null': return 'null'
    case 'boolean': return value.value ? 'true' : 'false'
    case 'number': return formatJsonNumber(value.coefficient, value.scale)
    case 'string': return escapeJsonString(decoder.decode(value.utf8))
    case 'array': return `[${value.values.map(serializeCanonicalJson).join(',')}]`
    case 'object': return `{${value.entries.map((entry) => `${escapeJsonString(decoder.decode(entry.key))}:${serializeCanonicalJson(entry.value)}`).join(',')}}`
  }
}

function decodePointer(pointer: string): readonly string[] {
  if (pointer === '') return []
  kernelAssert(pointer.startsWith('/'), 'JSON_PATH_ERROR', 'JSON Pointer must be empty or start with /')
  return pointer.slice(1).split('/').map((token) => {
    kernelAssert(!/~(?:[^01]|$)/.test(token), 'JSON_PATH_ERROR', 'invalid JSON Pointer escape')
    return token.replace(/~1/g, '/').replace(/~0/g, '~')
  })
}

function entryIndex(entries: readonly CanonicalJsonEntry[], token: string): number {
  const key = encoder.encode(token)
  return entries.findIndex((entry) => compareBytes(entry.key, key) === 0)
}

export function jsonPointer(value: CanonicalJsonValue, pointer: string): CanonicalJsonValue {
  let current = value
  for (const token of decodePointer(pointer)) {
    if (current.kind === 'object') {
      const index = entryIndex(current.entries, token)
      kernelAssert(index >= 0, 'JSON_PATH_ERROR', `object key not found: ${token}`)
      current = current.entries[index]!.value
    } else if (current.kind === 'array') {
      kernelAssert(/^(?:0|[1-9][0-9]*)$/.test(token), 'JSON_PATH_ERROR', 'invalid array index')
      const index = Number(token)
      kernelAssert(Number.isSafeInteger(index) && index < current.values.length, 'JSON_PATH_ERROR', 'array index out of range')
      current = current.values[index]!
    } else throw new KernelError('JSON_PATH_ERROR', 'cannot traverse a JSON scalar')
  }
  return current
}

export function canonicalJsonEqual(a: CanonicalJsonValue, b: CanonicalJsonValue): boolean {
  return serializeCanonicalJson(a) === serializeCanonicalJson(b)
}

export function jsonMergePatch(target: CanonicalJsonValue, patch: CanonicalJsonValue): CanonicalJsonValue {
  if (patch.kind !== 'object') return patch
  const values = new Map<string, CanonicalJsonValue>()
  if (target.kind === 'object') for (const entry of target.entries) values.set(decoder.decode(entry.key), entry.value)
  for (const entry of patch.entries) {
    const key = decoder.decode(entry.key)
    if (entry.value.kind === 'null') values.delete(key)
    else values.set(key, jsonMergePatch(values.get(key) ?? Object.freeze({ kind: 'object', entries: Object.freeze([]) }), entry.value))
  }
  const entries = Array.from(values, ([key, value]) => Object.freeze({ key: encoder.encode(key), value }))
  entries.sort((a, b) => compareBytes(a.key, b.key))
  return Object.freeze({ kind: 'object', entries: Object.freeze(entries) })
}

export type JsonPatchOperation =
  | { readonly op: 'add' | 'replace' | 'test'; readonly path: string; readonly value: CanonicalJsonValue }
  | { readonly op: 'remove'; readonly path: string }
  | { readonly op: 'copy' | 'move'; readonly from: string; readonly path: string }

function objectValue(entries: readonly CanonicalJsonEntry[], token: string): CanonicalJsonValue | undefined {
  const index = entryIndex(entries, token)
  return index < 0 ? undefined : entries[index]!.value
}

function changedAt(
  current: CanonicalJsonValue,
  tokens: readonly string[],
  action: 'add' | 'replace' | 'remove',
  replacement?: CanonicalJsonValue,
): CanonicalJsonValue {
  if (tokens.length === 0) {
    kernelAssert(action !== 'remove' && replacement !== undefined, 'JSON_PATH_ERROR', 'cannot remove the JSON document root')
    return replacement
  }
  const [token, ...rest] = tokens
  if (current.kind === 'object') {
    const existing = objectValue(current.entries, token!)
    if (rest.length > 0) {
      kernelAssert(existing !== undefined, 'JSON_PATH_ERROR', `object key not found: ${token}`)
      return changedAt(current, [token!], 'replace', changedAt(existing, rest, action, replacement))
    }
    kernelAssert(action === 'add' || existing !== undefined, 'JSON_PATH_ERROR', `object key not found: ${token}`)
    const values = new Map(current.entries.map((entry) => [decoder.decode(entry.key), entry.value]))
    if (action === 'remove') values.delete(token!)
    else values.set(token!, replacement!)
    const entries = Array.from(values, ([key, value]) => Object.freeze({ key: encoder.encode(key), value }))
    entries.sort((a, b) => compareBytes(a.key, b.key))
    return Object.freeze({ kind: 'object', entries: Object.freeze(entries) })
  }
  if (current.kind === 'array') {
    const append = token === '-'
    kernelAssert(append ? action === 'add' && rest.length === 0 : /^(?:0|[1-9][0-9]*)$/.test(token!), 'JSON_PATH_ERROR', 'invalid array index')
    const index = append ? current.values.length : Number(token)
    const maximum = action === 'add' && rest.length === 0 ? current.values.length : current.values.length - 1
    kernelAssert(Number.isSafeInteger(index) && index >= 0 && index <= maximum, 'JSON_PATH_ERROR', 'array index out of range')
    const values = [...current.values]
    if (rest.length > 0) values[index] = changedAt(values[index]!, rest, action, replacement)
    else if (action === 'add') values.splice(index, 0, replacement!)
    else if (action === 'replace') values[index] = replacement!
    else values.splice(index, 1)
    return Object.freeze({ kind: 'array', values: Object.freeze(values) })
  }
  throw new KernelError('JSON_PATH_ERROR', 'cannot mutate through a JSON scalar')
}

export function applyJsonPatch(
  value: CanonicalJsonValue,
  operations: readonly JsonPatchOperation[],
): CanonicalJsonValue {
  let current = value
  operations.forEach((operation, index) => {
    try {
      if (operation.op === 'test') {
        kernelAssert(canonicalJsonEqual(jsonPointer(current, operation.path), operation.value), 'JSON_PATH_ERROR', 'JSON Patch test failed')
      } else if (operation.op === 'add' || operation.op === 'replace') {
        current = changedAt(current, decodePointer(operation.path), operation.op, operation.value)
      } else if (operation.op === 'remove') {
        current = changedAt(current, decodePointer(operation.path), 'remove')
      } else if (operation.op === 'copy' || operation.op === 'move') {
        const copied = jsonPointer(current, operation.from)
        if (operation.op === 'move') {
          kernelAssert(!(operation.path + '/').startsWith(operation.from + '/'), 'JSON_PATH_ERROR', 'cannot move a value into its descendant')
          current = changedAt(current, decodePointer(operation.from), 'remove')
        }
        current = changedAt(current, decodePointer(operation.path), 'add', copied)
      }
    } catch (error) {
      if (error instanceof KernelError) throw new KernelError(error.code, `JSON Patch operation ${index}: ${error.message}`, error.position)
      throw error
    }
  })
  return current
}
