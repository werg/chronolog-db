import { CanonicalError, compareBytes, utf8 } from '@chronolog/canonical'

import type { CanonicalJsonValue } from './types.js'

/** Serialize the portable JSON tree without passing numbers through IEEE-754. */
export function canonicalJsonToText(value: CanonicalJsonValue): string {
  if (value === null) return 'null'
  if (value === true) return 'true'
  if (value === false) return 'false'
  if (typeof value === 'bigint') return value.toString(10)
  if (typeof value === 'string') return quote(value)
  if (Array.isArray(value)) return `[${(value as readonly CanonicalJsonValue[]).map(canonicalJsonToText).join(',')}]`
  if (value instanceof Map) {
    const entries = [...(value as ReadonlyMap<string, CanonicalJsonValue>)]
      .map(([key, item]) => ({ key, item, bytes: utf8(key) }))
      .sort((left, right) => compareBytes(left.bytes, right.bytes))
    return `{${entries.map(({ key, item }) => `${quote(key)}:${canonicalJsonToText(item)}`).join(',')}}`
  }
  const decimal = value as { readonly kind: 'decimal'; readonly coefficient: bigint; readonly scale: number }
  return decimalText(decimal.coefficient, decimal.scale)
}

/** Parse JSON into exact bigint/decimal nodes, rejecting duplicate keys and invalid Unicode. */
export function canonicalJsonFromText(text: string): CanonicalJsonValue {
  // Validate the host string before indexing UTF-16 so lone surrogates never enter the tree.
  utf8(text)
  const parser = new JsonParser(text)
  const value = parser.value()
  parser.whitespace()
  if (!parser.done) throw new CanonicalError('SCHEMA_INVALID', `Trailing JSON text at offset ${parser.offset}`)
  return value
}

function decimalText(coefficient: bigint, scale: number): string {
  if (!Number.isSafeInteger(scale) || scale < 0) throw new CanonicalError('SCHEMA_INVALID', 'JSON decimal scale is invalid')
  const negative = coefficient < 0n
  const digits = (negative ? -coefficient : coefficient).toString(10).padStart(scale + 1, '0')
  if (scale === 0) return `${negative ? '-' : ''}${digits}`
  const split = digits.length - scale
  return `${negative ? '-' : ''}${digits.slice(0, split)}.${digits.slice(split)}`
}

function quote(value: string): string {
  utf8(value)
  let output = '"'
  for (const character of value) {
    const code = character.codePointAt(0)!
    if (character === '"') output += '\\"'
    else if (character === '\\') output += '\\\\'
    else if (character === '\b') output += '\\b'
    else if (character === '\f') output += '\\f'
    else if (character === '\n') output += '\\n'
    else if (character === '\r') output += '\\r'
    else if (character === '\t') output += '\\t'
    else if (code < 0x20) output += `\\u${code.toString(16).padStart(4, '0')}`
    else output += character
  }
  return `${output}"`
}

class JsonParser {
  public offset = 0
  public constructor(private readonly source: string) {}
  public get done(): boolean { return this.offset === this.source.length }

  public whitespace(): void {
    while (this.offset < this.source.length && /[\x20\t\r\n]/u.test(this.source[this.offset]!)) this.offset += 1
  }

  public value(): CanonicalJsonValue {
    this.whitespace()
    const character = this.source[this.offset]
    if (character === '"') return this.string()
    if (character === '[') return this.array()
    if (character === '{') return this.object()
    if (character === '-' || (character !== undefined && character >= '0' && character <= '9')) return this.number()
    if (this.takeKeyword('true')) return true
    if (this.takeKeyword('false')) return false
    if (this.takeKeyword('null')) return null
    throw new CanonicalError('SCHEMA_INVALID', `Invalid JSON value at offset ${this.offset}`)
  }

  private takeKeyword(keyword: string): boolean {
    if (!this.source.startsWith(keyword, this.offset)) return false
    this.offset += keyword.length
    return true
  }

  private string(): string {
    this.expect('"')
    let output = ''
    while (!this.done) {
      const character = this.source[this.offset++]!
      if (character === '"') { utf8(output); return output }
      if (character.charCodeAt(0) < 0x20) throw new CanonicalError('SCHEMA_INVALID', `Unescaped JSON control character at offset ${this.offset - 1}`)
      if (character !== '\\') { output += character; continue }
      const escape = this.source[this.offset++]
      const simple: Readonly<Record<string, string>> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' }
      if (escape !== undefined && simple[escape] !== undefined) { output += simple[escape]; continue }
      if (escape !== 'u') throw new CanonicalError('SCHEMA_INVALID', `Invalid JSON escape at offset ${this.offset - 1}`)
      const first = this.hexCodeUnit()
      if (first >= 0xd800 && first <= 0xdbff) {
        if (this.source.slice(this.offset, this.offset + 2) !== '\\u') throw new CanonicalError('INVALID_UTF8', 'JSON high surrogate is not paired')
        this.offset += 2
        const second = this.hexCodeUnit()
        if (second < 0xdc00 || second > 0xdfff) throw new CanonicalError('INVALID_UTF8', 'JSON high surrogate is not paired')
        output += String.fromCodePoint(0x10000 + ((first - 0xd800) << 10) + second - 0xdc00)
      } else if (first >= 0xdc00 && first <= 0xdfff) {
        throw new CanonicalError('INVALID_UTF8', 'JSON low surrogate has no high surrogate')
      } else output += String.fromCharCode(first)
    }
    throw new CanonicalError('SCHEMA_INVALID', 'Unterminated JSON string')
  }

  private hexCodeUnit(): number {
    const digits = this.source.slice(this.offset, this.offset + 4)
    if (!/^[0-9a-fA-F]{4}$/u.test(digits)) throw new CanonicalError('SCHEMA_INVALID', `Invalid JSON Unicode escape at offset ${this.offset}`)
    this.offset += 4
    return Number.parseInt(digits, 16)
  }

  private array(): readonly CanonicalJsonValue[] {
    this.expect('['); this.whitespace()
    const result: CanonicalJsonValue[] = []
    if (this.source[this.offset] === ']') { this.offset += 1; return result }
    for (;;) {
      result.push(this.value()); this.whitespace()
      if (this.source[this.offset] === ']') { this.offset += 1; return result }
      this.expect(',')
    }
  }

  private object(): ReadonlyMap<string, CanonicalJsonValue> {
    this.expect('{'); this.whitespace()
    const result = new Map<string, CanonicalJsonValue>()
    if (this.source[this.offset] === '}') { this.offset += 1; return result }
    for (;;) {
      this.whitespace()
      if (this.source[this.offset] !== '"') throw new CanonicalError('SCHEMA_INVALID', `JSON object key must be a string at offset ${this.offset}`)
      const key = this.string()
      if (result.has(key)) throw new CanonicalError('SCHEMA_INVALID', `Duplicate JSON object key ${key}`)
      this.whitespace(); this.expect(':'); result.set(key, this.value()); this.whitespace()
      if (this.source[this.offset] === '}') { this.offset += 1; return result }
      this.expect(',')
    }
  }

  private number(): CanonicalJsonValue {
    const start = this.offset
    if (this.source[this.offset] === '-') this.offset += 1
    const integerStart = this.offset
    if (this.source[this.offset] === '0') this.offset += 1
    else {
      if (!this.isDigit(this.source[this.offset]) || this.source[this.offset] === '0') throw new CanonicalError('SCHEMA_INVALID', `Invalid JSON number at offset ${start}`)
      while (this.isDigit(this.source[this.offset])) this.offset += 1
    }
    if (this.offset === integerStart || (this.source[integerStart] === '0' && this.isDigit(this.source[integerStart + 1]))) throw new CanonicalError('SCHEMA_INVALID', `Invalid JSON integer at offset ${start}`)
    let fractionDigits = 0
    if (this.source[this.offset] === '.') {
      this.offset += 1; const fractionStart = this.offset
      while (this.isDigit(this.source[this.offset])) this.offset += 1
      fractionDigits = this.offset - fractionStart
      if (fractionDigits === 0) throw new CanonicalError('SCHEMA_INVALID', `Invalid JSON fraction at offset ${start}`)
    }
    let exponent = 0
    if (this.source[this.offset] === 'e' || this.source[this.offset] === 'E') {
      this.offset += 1; let sign = 1
      if (this.source[this.offset] === '+' || this.source[this.offset] === '-') { if (this.source[this.offset] === '-') sign = -1; this.offset += 1 }
      const exponentStart = this.offset
      while (this.isDigit(this.source[this.offset])) this.offset += 1
      if (this.offset === exponentStart) throw new CanonicalError('SCHEMA_INVALID', `Invalid JSON exponent at offset ${start}`)
      const magnitude = Number(this.source.slice(exponentStart, this.offset))
      if (!Number.isSafeInteger(magnitude) || magnitude > 1_000_000) throw new CanonicalError('SCHEMA_INVALID', 'JSON exponent is outside the portable bound')
      exponent = sign * magnitude
    }
    const token = this.source.slice(start, this.offset)
    const negative = token.startsWith('-')
    const mantissa = token.replace(/^[+-]/u, '').split(/[eE]/u)[0]!
    let coefficient = BigInt(mantissa.replace('.', '')) * (negative ? -1n : 1n)
    let scale = fractionDigits - exponent
    if (scale < 0) { coefficient *= 10n ** BigInt(-scale); scale = 0 }
    while (scale > 0 && coefficient % 10n === 0n) { coefficient /= 10n; scale -= 1 }
    if (scale === 0) return coefficient
    if (scale > 38) throw new CanonicalError('SCHEMA_INVALID', 'JSON decimal scale exceeds the portable bound')
    return { kind: 'decimal', coefficient, scale }
  }

  private isDigit(character: string | undefined): boolean { return character !== undefined && character >= '0' && character <= '9' }
  private expect(character: string): void {
    if (this.source[this.offset] !== character) throw new CanonicalError('SCHEMA_INVALID', `Expected ${character} at offset ${this.offset}`)
    this.offset += 1
  }
}
