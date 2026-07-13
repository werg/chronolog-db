export * from './decimal.js'
export * from './entropy.js'
export * from './errors.js'
export * from './int64.js'
export * from './json.js'
export * from './text.js'
export * from './vector.js'

export const KERNEL_SEMANTIC_MANIFEST = Object.freeze({
  name: 'chronolog-typescript-reference-kernels',
  integer: 'int64-checked-v1',
  decimal: 'coefficient-scale-explicit-rounding-v1',
  text: 'utf8-binary-ascii-v1',
  json: 'rfc8259-exact-number-sorted-utf8-v1',
  entropy: 'hkdf-sha256-labeled-v1',
  vector: 'bit-int8-exact-v1',
})
