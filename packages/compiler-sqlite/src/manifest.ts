import {
  digestExecutionManifest,
  digestSchemaManifest,
  encodeExecutionManifest,
  encodeSchemaManifest,
  type ExecutionManifest,
  type SchemaManifest,
} from '@chronolog/ir'

import { CompilerError } from './types.js'

export interface ManifestArtifacts {
  readonly schemaDigest: Uint8Array
  readonly canonicalSchema: Uint8Array
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
  schema: SchemaManifest,
  executionManifest: ExecutionManifest,
): Promise<ManifestArtifacts> {
  assertDigest(executionManifest.engineDigest, 'EXECUTION_ENGINE_DIGEST_INVALID')
  const canonicalSchema = encodeSchemaManifest(schema)
  const canonicalExecutionManifest = encodeExecutionManifest(executionManifest)
  const [schemaDigest, executionManifestDigest] = await Promise.all([
    digestSchemaManifest(schema),
    digestExecutionManifest(executionManifest),
  ])
  assertDigest(schemaDigest, 'SCHEMA_DIGEST_INVALID')
  assertDigest(executionManifestDigest, 'EXECUTION_MANIFEST_DIGEST_INVALID')
  return { schemaDigest, canonicalSchema, executionManifestDigest, canonicalExecutionManifest }
}

function assertDigest(value: Uint8Array, code: string): void {
  if (value.length !== 32) throw new CompilerError(code)
}
