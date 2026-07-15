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
      ...options.resources,
    },
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
