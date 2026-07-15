import { describe, expect, it } from 'vitest'

import {
  decodeMaterializationInvocation,
  encodeMaterializationInvocation,
  type ChronologArtifactKind,
  type ChronologMaterializationInvocation,
  type ExactArtifactRef,
  type ExactDatabaseRef,
} from './index.js'

const storeId = Uint8Array.of(1, 2, 3)
const digest32 = (seed: number) => Uint8Array.from({ length: 32 }, (_value, index) => (seed + index) & 0xff)
const digest20 = (seed: number) => Uint8Array.from({ length: 20 }, (_value, index) => (seed + index) & 0xff)

function artifact(kind: ChronologArtifactKind, seed: number): ExactArtifactRef {
  return {
    kind,
    formatVersion: 1,
    object: {
      storeId,
      codec: { number: seed + 1, version: 1 },
      contentId: { algorithm: 'sha2-256', digest: digest32(seed) },
    },
  }
}

const database: ExactDatabaseRef = {
  storeId,
  doltFormatVersion: 1,
  canonicalGenesisCommit: { doltFormatVersion: 1, contentId: { algorithm: 'dolt-blake3-160', digest: digest20(1) } },
  commitHash: { doltFormatVersion: 1, contentId: { algorithm: 'dolt-blake3-160', digest: digest20(2) } },
  stateDigest: { stateFormatVersion: 1, contentId: { algorithm: 'sha2-256', digest: digest32(3) } },
}

describe('portable SQL materialization invocation', () => {
  it('round-trips without an external schema artifact or digest', () => {
    const invocation: ChronologMaterializationInvocation = {
      version: 1,
      profile: 'pure',
      context: { groupId: digest32(4), logicalTimeMs: null, entropySeed: null },
      previous: null,
      replayBase: { manifest: artifact('materialization-manifest', 5), database },
      admittedSuffix: artifact('admitted-suffix', 6),
      executionManifest: artifact('execution-manifest', 7),
      continuation: null,
      expectedEngineDigest: digest32(8),
      expectedExecutionManifestDigest: digest32(9),
      expectedPreviousOrderDigest: digest32(10),
      replayFromIndex: 0,
      targetOrderLength: 2,
      targetOrderDigest: digest32(11),
    }
    const decoded = decodeMaterializationInvocation(encodeMaterializationInvocation(invocation))
    expect(decoded).toEqual(invocation)
    expect(decoded).not.toHaveProperty('schemaManifest')
    expect(decoded).not.toHaveProperty('expectedSchemaDigest')
  })
})
