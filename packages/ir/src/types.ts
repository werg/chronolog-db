export type CollationId = 'binary' | 'nocase' | 'rtrim' | 'unicode_codepoint' | `registered:${number}`
export type VectorElementType = 'i8' | 'u8' | 'i16' | 'i32' | 'f32' | 'f64'

export type CanonicalJsonValue =
  | null
  | boolean
  | bigint
  | { readonly kind: 'decimal'; readonly coefficient: bigint; readonly scale: number }
  | string
  | readonly CanonicalJsonValue[]
  | ReadonlyMap<string, CanonicalJsonValue>

export type LogicalValue =
  | { readonly kind: 'null' }
  | { readonly kind: 'boolean'; readonly value: boolean }
  | { readonly kind: 'int64'; readonly value: bigint }
  | { readonly kind: 'decimal'; readonly coefficient: bigint; readonly scale: number }
  | { readonly kind: 'text'; readonly utf8: Uint8Array }
  | { readonly kind: 'blob'; readonly bytes: Uint8Array }
  | { readonly kind: 'uuid'; readonly bytes: Uint8Array }
  | { readonly kind: 'timestamp_ms'; readonly value: bigint }
  | { readonly kind: 'duration_ms'; readonly value: bigint }
  | { readonly kind: 'json'; readonly value: CanonicalJsonValue }
  | { readonly kind: 'vector'; readonly element: VectorElementType; readonly dimensions: number; readonly bytes: Uint8Array }

export type LogicalType =
  | { readonly kind: 'boolean' }
  | { readonly kind: 'int64' }
  | { readonly kind: 'decimal'; readonly precision: number; readonly scale: number }
  | { readonly kind: 'text'; readonly collation: CollationId }
  | { readonly kind: 'blob'; readonly maxBytes?: number }
  | { readonly kind: 'uuid' }
  | { readonly kind: 'timestamp_ms' }
  | { readonly kind: 'duration_ms' }
  | { readonly kind: 'json' }
  | { readonly kind: 'vector'; readonly element: VectorElementType; readonly dimensions: number }

export interface ValueType {
  readonly logical: LogicalType
  readonly nullable: boolean
}

export const BUILTIN_FUNCTION_NAMES = [
  'char', 'concat', 'concat_ws',
  'length', 'octet_length',
  'lower', 'upper', 'trim', 'ltrim', 'rtrim', 'replace',
  'instr', 'substr', 'substring', 'hex',
  'coalesce', 'ifnull', 'nullif',
  'if', 'iif', 'likelihood', 'likely', 'unlikely',
  'glob', 'like', 'min', 'max',
  'quote', 'typeof', 'unhex', 'unicode', 'unistr', 'unistr_quote', 'zeroblob',
  'abs', 'sign',
] as const

export type FunctionEffect = 'pure' | 'stable_context' | 'stateful'
export interface RegisteredFunction {
  readonly id: number
  readonly name: string
  readonly arguments: readonly ValueType[]
  readonly result: ValueType
  readonly effect: FunctionEffect
  readonly implementationDigest: Uint8Array
}
export interface RegisteredCollation {
  readonly id: number
  readonly name: string
  readonly implementationDigest: Uint8Array
}
export interface RegisteredModule {
  readonly id: number
  readonly name: string
  readonly kind: 'native' | 'wasm' | 'builtin'
  readonly implementationDigest: Uint8Array
  readonly effectObjectIds: readonly number[]
}
export interface SemanticResourceLimits {
  readonly maxProgramNodes: number
  readonly maxExpressionDepth: number
  readonly maxQueryRows: number
  readonly maxResultBytes: number
  readonly maxJsonDepth: number
  readonly maxVectorDimensions: number
  readonly maxRuleDepth: number
  readonly maxWasmFuel: bigint
  readonly maxResultColumnsPerStatement: number
  readonly maxResultRowsPerStatement: number
  readonly maxResultBytesPerStatement: number
  readonly maxTransactionResultRows: number
  readonly maxTransactionResultBytes: number
  readonly maxResultValueBytes: number
  readonly maxResultSortWork: number
  readonly maxOrderedMutationTargets: number
  readonly maxOrderedMutationIdentityBytes: number
  readonly maxOrderedMutationBindings: number
}
export interface ExecutionFeatures {
  readonly decimal: boolean
  readonly json: boolean
  readonly vector: boolean
  readonly fts: boolean
  readonly spatial: boolean
  readonly wasm: boolean
}
export interface ExecutionManifest {
  readonly version: 1
  readonly profile: string
  readonly engine: string
  readonly engineDigest: Uint8Array
  readonly functions: readonly RegisteredFunction[]
  readonly collations: readonly RegisteredCollation[]
  readonly modules: readonly RegisteredModule[]
  readonly features: ExecutionFeatures
  readonly resources: SemanticResourceLimits
  readonly transactionResults: {
    readonly envelopeVersion: 1
    readonly valueProfile: 'sqlite-finite-binary64-v1'
    readonly canonicalizationProfile: 'sqlite-result-modes-v1'
    readonly sqlResultDigestDomain: 'chronolog-canonical-sql-result-v1\0'
    readonly envelopeDigestDomain: 'chronolog-transaction-result-envelope-v1\0'
  }
  readonly errorCodes: readonly string[]
}
