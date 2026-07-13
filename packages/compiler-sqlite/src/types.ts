import type {
  ContextField,
  ExpectedResult,
  ExecutionManifest,
  LogicalValue,
  Mutation,
  Precondition,
  Query,
  ResultColumn,
  ResultMode,
  SchemaManifest,
  ValueType,
} from '@chronolog/ir'

import type { Catalog } from './catalog.js'

export class CompilerError extends Error {
  constructor(
    readonly code: string,
    readonly nodeId: number | null = null,
    readonly attribution: 'schema' | 'precondition' | 'command' | 'constraint' | null = null,
  ) {
    super(code)
    this.name = 'CompilerError'
  }
}

export type BindingSource =
  | { readonly kind: 'literal'; readonly value: LogicalValue }
  | { readonly kind: 'context'; readonly field: ContextField }
  | {
      readonly kind: 'entropy'
      readonly label: string
      readonly index: number
      readonly length: number
    }

export interface BackendParameter {
  readonly ordinal: number
  readonly valueType: ValueType
  readonly source: BindingSource
}

export interface CompiledQuery {
  readonly source: Query
  readonly sql: string
  readonly parameters: readonly BackendParameter[]
  readonly columns: readonly ResultColumn[]
  readonly resultMode: ResultMode
}

export interface CompiledPrecondition {
  readonly id: number
  readonly kind: Precondition['kind']
  readonly query: CompiledQuery
  readonly expected?: ExpectedResult
}

export interface CompiledMutation {
  readonly id: number
  readonly source: Mutation
  readonly sql: string
  readonly parameters: readonly BackendParameter[]
}

export interface CompiledProgram {
  readonly preconditions: readonly CompiledPrecondition[]
  readonly mutations: readonly CompiledMutation[]
}

export interface SchemaStatement {
  readonly objectId: number
  readonly sql: string
  readonly parameters: readonly BackendParameter[]
}

export interface CompiledSchema {
  readonly schema: SchemaManifest
  readonly executionManifest: ExecutionManifest
  readonly catalog: Catalog
  readonly statements: readonly SchemaStatement[]
}

export interface TransactionContextValues {
  readonly group_id: Uint8Array
  readonly membership_revision: Uint8Array
  readonly validation_policy: Uint8Array
  readonly author_id: Uint8Array
  readonly author_timestamp_ms: bigint
  readonly transaction_nonce: Uint8Array
  readonly candidate_digest: Uint8Array
  readonly transaction_id: Uint8Array
  readonly author_feed_sequence: bigint
}

export interface CompilerContext {
  readonly catalog: Catalog
  readonly manifest: ExecutionManifest
}
