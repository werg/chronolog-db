import { describe, expect, it } from 'vitest'

import {
  decodeExecutionManifest,
  decodeLogicalValues,
  digestExecutionManifest,
  encodeExecutionManifest,
  encodeLogicalValues,
  type ExecutionManifest,
  type LogicalValue,
} from './index.js'

const values: readonly LogicalValue[] = [
  { kind: 'null' },
  { kind: 'boolean', value: true },
  { kind: 'int64', value: -5n },
  { kind: 'decimal', coefficient: 1234n, scale: 2 },
  { kind: 'text', utf8: new TextEncoder().encode('Grüße') },
  { kind: 'blob', bytes: Uint8Array.of(0, 255) },
  { kind: 'uuid', bytes: Uint8Array.from({ length: 16 }, (_value, index) => index) },
  { kind: 'timestamp_ms', value: 1_700_000_000_000n },
  { kind: 'duration_ms', value: 250n },
  { kind: 'json', value: new Map([['answer', 42n]]) },
  { kind: 'vector', element: 'f32', dimensions: 2, bytes: new Uint8Array(8) },
]

const manifest: ExecutionManifest = {
  version: 1,
  profile: 'sqlite-test-v1',
  engine: 'sqlite',
  engineDigest: new Uint8Array(32),
  functions: [],
  collations: [],
  modules: [],
  features: { decimal: true, json: true, vector: true, fts: false, spatial: false, wasm: false },
  resources: {
    maxProgramNodes: 100,
    maxExpressionDepth: 32,
    maxQueryRows: 1_000,
    maxResultBytes: 1_000_000,
    maxJsonDepth: 32,
    maxVectorDimensions: 1_024,
    maxRuleDepth: 0,
    maxWasmFuel: 0n,
  },
}

describe('logical values and execution profile codecs', () => {
  it('round-trips canonical logical values', () => {
    expect(decodeLogicalValues(encodeLogicalValues(values))).toEqual(values)
  })

  it('round-trips and domain-hashes the execution profile', async () => {
    expect(decodeExecutionManifest(encodeExecutionManifest(manifest))).toEqual(manifest)
    expect(await digestExecutionManifest(manifest)).toHaveLength(32)
  })

  it('rejects malformed logical values', () => {
    expect(() => encodeLogicalValues([{ kind: 'uuid', bytes: new Uint8Array(15) }])).toThrow()
    expect(() => encodeLogicalValues([{ kind: 'int64', value: 1n << 63n }])).toThrow()
  })
})
