import { KernelError, kernelAssert } from './errors.js'

export const INT64_MIN = -(1n << 63n)
export const INT64_MAX = (1n << 63n) - 1n

export function int64(value: bigint | string): bigint {
  let parsed: bigint
  try {
    if (typeof value === 'string') {
      kernelAssert(/^-?(?:0|[1-9][0-9]*)$/.test(value), 'INVALID_ARGUMENT_ENCODING', 'invalid canonical Int64')
      kernelAssert(value !== '-0', 'INVALID_ARGUMENT_ENCODING', 'negative zero is not canonical')
    }
    parsed = BigInt(value)
  } catch (error) {
    if (error instanceof KernelError) throw error
    throw new KernelError('INVALID_ARGUMENT_ENCODING', 'invalid Int64')
  }
  kernelAssert(parsed >= INT64_MIN && parsed <= INT64_MAX, 'NUMERIC_OVERFLOW', 'Int64 out of range')
  return parsed
}

function checked(value: bigint): bigint {
  kernelAssert(value >= INT64_MIN && value <= INT64_MAX, 'NUMERIC_OVERFLOW', 'Int64 overflow')
  return value
}

export const int64Add = (a: bigint, b: bigint): bigint => checked(a + b)
export const int64Sub = (a: bigint, b: bigint): bigint => checked(a - b)
export const int64Mul = (a: bigint, b: bigint): bigint => checked(a * b)

export function int64Div(a: bigint, b: bigint): bigint {
  kernelAssert(b !== 0n, 'DIVISION_BY_ZERO', 'Int64 division by zero')
  kernelAssert(!(a === INT64_MIN && b === -1n), 'NUMERIC_OVERFLOW', 'Int64 division overflow')
  return a / b
}

export function int64Rem(a: bigint, b: bigint): bigint {
  kernelAssert(b !== 0n, 'DIVISION_BY_ZERO', 'Int64 remainder by zero')
  return a % b
}

export function int64Neg(a: bigint): bigint {
  kernelAssert(a !== INT64_MIN, 'NUMERIC_OVERFLOW', 'Int64 negation overflow')
  return -a
}

export function int64Abs(a: bigint): bigint {
  return a < 0n ? int64Neg(a) : a
}

export function int64ShiftLeft(a: bigint, bits: number): bigint {
  kernelAssert(Number.isInteger(bits) && bits >= 0 && bits < 64, 'INVALID_ARGUMENT_ENCODING', 'shift must be in [0, 63]')
  return checked(a << BigInt(bits))
}

export function int64ShiftRight(a: bigint, bits: number): bigint {
  kernelAssert(Number.isInteger(bits) && bits >= 0 && bits < 64, 'INVALID_ARGUMENT_ENCODING', 'shift must be in [0, 63]')
  return a >> BigInt(bits)
}

export function compareBigInt(a: bigint, b: bigint): -1 | 0 | 1 {
  return a < b ? -1 : a > b ? 1 : 0
}
