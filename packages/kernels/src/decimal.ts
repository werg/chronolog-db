import { compareBigInt } from './int64.js'
import { KernelError, kernelAssert } from './errors.js'

export interface Decimal {
  readonly coefficient: bigint
  readonly scale: number
}

export type RoundingMode = 'exact' | 'toward-zero' | 'floor' | 'ceiling' | 'half-up' | 'half-down' | 'half-even'

const POW10: bigint[] = [1n]

function pow10(n: number): bigint {
  kernelAssert(Number.isSafeInteger(n) && n >= 0 && n <= 10_000, 'SEMANTIC_RESOURCE_LIMIT', 'decimal scale out of range')
  for (let i = POW10.length; i <= n; i += 1) POW10.push(POW10[i - 1]! * 10n)
  return POW10[n]!
}

export function decimal(coefficient: bigint, scale: number): Decimal {
  kernelAssert(Number.isSafeInteger(scale) && scale >= 0, 'INVALID_ARGUMENT_ENCODING', 'invalid decimal scale')
  return Object.freeze({ coefficient, scale })
}

export function parseDecimal(text: string, declaredScale?: number): Decimal {
  const match = /^(-?)(0|[1-9][0-9]*)(?:\.([0-9]+))?$/.exec(text)
  kernelAssert(match, 'INVALID_ARGUMENT_ENCODING', 'invalid canonical decimal')
  kernelAssert(text !== '-0', 'INVALID_ARGUMENT_ENCODING', 'negative zero is not canonical')
  const fraction = match[3] ?? ''
  const scale = declaredScale ?? fraction.length
  kernelAssert(scale >= fraction.length, 'DECIMAL_RESCALE_REQUIRED', 'decimal exceeds declared scale')
  const sign = match[1] === '-' ? -1n : 1n
  const coefficient = sign * BigInt(`${match[2]}${fraction}${'0'.repeat(scale - fraction.length)}`)
  return decimal(coefficient, scale)
}

export function formatDecimal(value: Decimal, preserveScale = true): string {
  const negative = value.coefficient < 0n
  const digits = (negative ? -value.coefficient : value.coefficient).toString().padStart(value.scale + 1, '0')
  let result = value.scale === 0
    ? digits
    : `${digits.slice(0, -value.scale)}.${digits.slice(-value.scale)}`
  if (!preserveScale && result.includes('.')) {
    result = result.replace(/0+$/, '').replace(/\.$/, '')
  }
  return negative && value.coefficient !== 0n ? `-${result}` : result
}

function common(a: Decimal, b: Decimal): readonly [bigint, bigint, number] {
  const scale = Math.max(a.scale, b.scale)
  return [a.coefficient * pow10(scale - a.scale), b.coefficient * pow10(scale - b.scale), scale]
}

export function compareDecimal(a: Decimal, b: Decimal): -1 | 0 | 1 {
  const [ac, bc] = common(a, b)
  return compareBigInt(ac, bc)
}

export function decimalAdd(a: Decimal, b: Decimal): Decimal {
  const [ac, bc, scale] = common(a, b)
  return decimal(ac + bc, scale)
}

export function decimalSub(a: Decimal, b: Decimal): Decimal {
  const [ac, bc, scale] = common(a, b)
  return decimal(ac - bc, scale)
}

export function decimalMul(a: Decimal, b: Decimal): Decimal {
  return decimal(a.coefficient * b.coefficient, a.scale + b.scale)
}

function roundedQuotient(numerator: bigint, denominator: bigint, mode: RoundingMode): bigint {
  kernelAssert(denominator !== 0n, 'DIVISION_BY_ZERO', 'decimal division by zero')
  const q = numerator / denominator
  const r = numerator % denominator
  if (r === 0n) return q
  if (mode === 'exact') throw new KernelError('DECIMAL_RESCALE_REQUIRED', 'decimal operation requires rounding')
  const sameSign = (numerator < 0n) === (denominator < 0n)
  const away = sameSign ? 1n : -1n
  if (mode === 'toward-zero') return q
  if (mode === 'floor') return sameSign ? q : q - 1n
  if (mode === 'ceiling') return sameSign ? q + 1n : q
  const twiceRemainder = (r < 0n ? -r : r) * 2n
  const absDenominator = denominator < 0n ? -denominator : denominator
  if (twiceRemainder < absDenominator) return q
  if (twiceRemainder > absDenominator) return q + away
  if (mode === 'half-up') return q + away
  if (mode === 'half-down') return q
  return q % 2n === 0n ? q : q + away
}

export function decimalRescale(value: Decimal, scale: number, mode: RoundingMode): Decimal {
  kernelAssert(Number.isSafeInteger(scale) && scale >= 0, 'INVALID_ARGUMENT_ENCODING', 'invalid decimal scale')
  if (scale >= value.scale) return decimal(value.coefficient * pow10(scale - value.scale), scale)
  return decimal(roundedQuotient(value.coefficient, pow10(value.scale - scale), mode), scale)
}

export function decimalDiv(a: Decimal, b: Decimal, resultScale: number, mode: RoundingMode): Decimal {
  kernelAssert(b.coefficient !== 0n, 'DIVISION_BY_ZERO', 'decimal division by zero')
  const exponent = resultScale + b.scale - a.scale
  const numerator = exponent >= 0 ? a.coefficient * pow10(exponent) : a.coefficient
  const denominator = exponent >= 0 ? b.coefficient : b.coefficient * pow10(-exponent)
  return decimal(roundedQuotient(numerator, denominator, mode), resultScale)
}

export function decimalRem(a: Decimal, b: Decimal): Decimal {
  const [ac, bc, scale] = common(a, b)
  kernelAssert(bc !== 0n, 'DIVISION_BY_ZERO', 'decimal remainder by zero')
  return decimal(ac % bc, scale)
}

export function decimalSum(values: readonly Decimal[]): Decimal {
  if (values.length === 0) return decimal(0n, 0)
  return values.slice(1).reduce(decimalAdd, values[0]!)
}

export function assertDecimalPrecision(value: Decimal, precision: number): Decimal {
  kernelAssert(Number.isSafeInteger(precision) && precision > 0, 'INVALID_ARGUMENT_ENCODING', 'invalid decimal precision')
  const digits = (value.coefficient < 0n ? -value.coefficient : value.coefficient).toString().length
  kernelAssert(digits <= precision, 'NUMERIC_OVERFLOW', 'decimal precision overflow')
  return value
}
