import { kernelAssert } from './errors.js'

export function validateBitVector(bytes: Uint8Array, dimensions: number): Uint8Array {
  kernelAssert(Number.isSafeInteger(dimensions) && dimensions > 0, 'VECTOR_VALUE_INVALID', 'invalid bit-vector dimensions')
  kernelAssert(bytes.length === Math.ceil(dimensions / 8), 'VECTOR_DIMENSION_MISMATCH', 'bit-vector byte length mismatch')
  const unused = bytes.length * 8 - dimensions
  if (unused > 0) {
    const usedMask = 0xff << unused & 0xff
    kernelAssert((bytes[bytes.length - 1]! & ~usedMask) === 0, 'VECTOR_VALUE_INVALID', 'non-zero bit-vector padding')
  }
  return bytes.slice()
}

const POPCOUNT = Uint8Array.from({ length: 256 }, (_, value) => {
  let x = value
  let count = 0
  while (x !== 0) { count += x & 1; x >>>= 1 }
  return count
})

export function hammingDistance(a: Uint8Array, b: Uint8Array, dimensions: number): bigint {
  validateBitVector(a, dimensions)
  validateBitVector(b, dimensions)
  let distance = 0n
  for (let i = 0; i < a.length; i += 1) distance += BigInt(POPCOUNT[a[i]! ^ b[i]!]!)
  return distance
}

function equalInt8Dimensions(a: Int8Array, b: Int8Array): void {
  kernelAssert(a.length === b.length, 'VECTOR_DIMENSION_MISMATCH', 'int8 vector dimensions differ')
}

export function int8Manhattan(a: Int8Array, b: Int8Array): bigint {
  equalInt8Dimensions(a, b)
  let result = 0n
  for (let i = 0; i < a.length; i += 1) result += BigInt(Math.abs(a[i]! - b[i]!))
  return result
}

export function int8SquaredL2(a: Int8Array, b: Int8Array): bigint {
  equalInt8Dimensions(a, b)
  let result = 0n
  for (let i = 0; i < a.length; i += 1) {
    const delta = BigInt(a[i]! - b[i]!)
    result += delta * delta
  }
  return result
}

export function int8Dot(a: Int8Array, b: Int8Array): bigint {
  equalInt8Dimensions(a, b)
  let result = 0n
  for (let i = 0; i < a.length; i += 1) result += BigInt(a[i]!) * BigInt(b[i]!)
  return result
}

export function compareBytes(a: Uint8Array, b: Uint8Array): -1 | 0 | 1 {
  const length = Math.min(a.length, b.length)
  for (let i = 0; i < length; i += 1) {
    if (a[i]! < b[i]!) return -1
    if (a[i]! > b[i]!) return 1
  }
  return a.length < b.length ? -1 : a.length > b.length ? 1 : 0
}

export interface VectorCandidate<T> {
  readonly key: Uint8Array
  readonly value: T
}

export interface VectorNeighbor<T> extends VectorCandidate<T> {
  readonly distance: bigint
}

export function exactKnn<T>(
  candidates: readonly VectorCandidate<T>[],
  query: T,
  k: number,
  distance: (a: T, b: T) => bigint,
): readonly VectorNeighbor<T>[] {
  kernelAssert(Number.isSafeInteger(k) && k >= 0, 'INVALID_ARGUMENT_ENCODING', 'invalid KNN limit')
  return candidates
    .map((candidate) => ({ ...candidate, distance: distance(candidate.value, query) }))
    .sort((a, b) => {
      if (a.distance < b.distance) return -1
      if (a.distance > b.distance) return 1
      return compareBytes(a.key, b.key)
    })
    .slice(0, k)
}
