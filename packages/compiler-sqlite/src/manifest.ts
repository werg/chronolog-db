import {
  digestExecutionManifest,
  encodeExecutionManifest,
  type ExecutionManifest,
} from '@chronolog/ir'

import { SqlCompilerError } from './sql-compiler.js'

export interface ManifestArtifacts {
  readonly executionManifestDigest: Uint8Array
  readonly canonicalExecutionManifest: Uint8Array
}

export interface CoreExecutionManifestOptions {
  readonly profile: string
  readonly engineDigest: Uint8Array
  readonly engine?: string
  readonly resources?: Partial<ExecutionManifest['resources']>
  readonly features?: Partial<ExecutionManifest['features']>
}

export const CORE_SQL_ERROR_CODES = [
  'EXECUTION_MANIFEST_DIGEST_MISMATCH',
  'SQL_ASSERTION_FALSE',
  'SQL_CONSTRAINT_VIOLATION',
  'SQL_EVALUATION_ERROR',
  'SQL_EXPECTATION_MISMATCH',
  'SQL_INVALID_INTEGER_PARAMETER',
  'SQL_INVALID_LIMIT_PROGRESS_GRANULARITY',
  'SQL_INVALID_REAL_PARAMETER',
  'SQL_INVALID_SOURCE',
  'SQL_MULTIPLE_STATEMENTS',
  'SQL_NATIVE_LIMIT_MISMATCH',
  'SQL_NATIVE_SECURITY_CONFIGURATION_FAILED',
  'SQL_NONFINITE_REAL_RESULT',
  'SQL_ORDERED_MUTATION_BINDING_LIMIT',
  'SQL_ORDERED_MUTATION_FOREIGN_KEY_GATED',
  'SQL_ORDERED_MUTATION_GENERATED_COLUMN_GATED',
  'SQL_ORDERED_MUTATION_IDENTITY_BYTE_LIMIT',
  'SQL_ORDERED_MUTATION_IDENTITY_DUPLICATE',
  'SQL_ORDERED_MUTATION_IDENTITY_INVALID',
  'SQL_ORDERED_MUTATION_IDENTITY_UPDATE_GATED',
  'SQL_ORDERED_MUTATION_PRIMARY_KEY_COLLATION_GATED',
  'SQL_ORDERED_MUTATION_PRIMARY_KEY_GATED',
  'SQL_ORDERED_MUTATION_REAL_TABLE_REQUIRED',
  'SQL_ORDERED_MUTATION_TARGET_LIMIT',
  'SQL_ORDERED_MUTATION_TRIGGER_GATED',
  'SQL_ORDERED_MUTATION_UNIQUE_KEY_GATED',
  'SQL_ORDERED_RESULT_REQUIRES_ORDER_BY',
  'SQL_PREPARE_FAILED',
  'SQL_PROFILE_VIOLATION',
  'SQL_RESULT_BYTE_LIMIT',
  'SQL_RESULT_COLUMN_LIMIT',
  'SQL_RESULT_LIMIT',
  'SQL_RESULT_ROW_LIMIT',
  'SQL_RESULT_SORT_WORK_LIMIT',
  'SQL_RESULT_VALUE_BYTE_LIMIT',
  'SQL_STATEMENT_TAIL_INVALID',
  'SQL_STATEMENT_TAIL_UNAVAILABLE',
  'SQL_STATEMENT_TOO_LARGE',
  'SQL_STEP_LIMIT',
  'SQL_TRANSACTION_RESULT_BYTE_LIMIT',
  'SQL_TRANSACTION_RESULT_ROW_LIMIT',
  'SQL_TYPE_MISMATCH',
  'SQL_VALUE_TOO_LARGE',
] as const

/**
 * Construct the only execution profile implemented by the practical SQLite
 * compiler today. Exact decimal/JSON/vector value storage is enabled; derived
 * search indexes, FTS, spatial behavior, WASM and registries remain disabled.
 * Callers must explicitly commit the measured engine digest.
 */
export function createCoreExecutionManifest(
  options: CoreExecutionManifestOptions,
): ExecutionManifest {
  assertDigest(options.engineDigest, 'EXECUTION_ENGINE_DIGEST_INVALID')
  return {
    version: 1,
    profile: options.profile,
    engine: options.engine ?? 'doltlite-core-v1',
    engineDigest: Uint8Array.from(options.engineDigest),
    functions: [],
    collations: [],
    modules: [],
    features: {
      decimal: true,
      json: true,
      vector: true,
      fts: false,
      spatial: false,
      wasm: false,
      ...options.features,
    },
    resources: {
      maxProgramNodes: 10_000,
      maxExpressionDepth: 64,
      maxQueryRows: 10_000,
      maxResultBytes: 16 * 1024 * 1024,
      maxJsonDepth: 64,
      maxVectorDimensions: 4_096,
      maxRuleDepth: 0,
      maxWasmFuel: 0n,
      maxResultColumnsPerStatement: 1_024,
      maxResultRowsPerStatement: 10_000,
      maxResultBytesPerStatement: 16 * 1024 * 1024,
      maxTransactionResultRows: 50_000,
      maxTransactionResultBytes: 32 * 1024 * 1024,
      maxResultValueBytes: 4 * 1024 * 1024,
      maxResultSortWork: 64 * 1024 * 1024,
      maxOrderedMutationTargets: 10_000,
      maxOrderedMutationIdentityBytes: 4 * 1024 * 1024,
      maxOrderedMutationBindings: 1_000,
      ...options.resources,
    },
    transactionResults: {
      envelopeVersion: 1,
      valueProfile: 'sqlite-finite-binary64-v1',
      canonicalizationProfile: 'sqlite-result-modes-v1',
      sqlResultDigestDomain: 'chronolog-canonical-sql-result-v1\0',
      envelopeDigestDomain: 'chronolog-transaction-result-envelope-v1\0',
    },
    errorCodes: CORE_SQL_ERROR_CODES,
  }
}

export async function compileManifestArtifacts(
  executionManifest: ExecutionManifest,
): Promise<ManifestArtifacts> {
  assertDigest(executionManifest.engineDigest, 'EXECUTION_ENGINE_DIGEST_INVALID')
  const canonicalExecutionManifest = encodeExecutionManifest(executionManifest)
  const executionManifestDigest = await digestExecutionManifest(executionManifest)
  assertDigest(executionManifestDigest, 'EXECUTION_MANIFEST_DIGEST_INVALID')
  return { executionManifestDigest, canonicalExecutionManifest }
}

function assertDigest(value: Uint8Array, code: string): void {
  if (value.length !== 32) throw new SqlCompilerError(code)
}
