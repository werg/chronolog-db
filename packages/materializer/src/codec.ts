import {
  DEFAULT_DECODE_LIMITS,
  assertCanonicalCbor,
  assertKnownIntegerKeys,
  canonicalInvariant,
  concatBytes,
  encodeCanonicalCbor,
  expectArray,
  expectBigint,
  expectBytes,
  expectMap,
  expectString,
  expectUint,
  integerMap,
  required,
  sha256,
  utf8,
  type CborValue,
  type DecodeLimits,
} from '@chronolog/canonical'
import {
  decodeExecutionManifest,
  decodeSchemaManifest,
  encodeExecutionManifest,
  encodeSchemaManifest,
  type ExecutionManifest,
  type SchemaManifest,
} from '@chronolog/ir'
import {
  decodeTransactionCore,
  encodeTransactionCore,
} from '@chronolog/protocol'

import type {
  ChronologAdmittedSuffix,
  ChronologArtifactKind,
  ChronologMaterializationContinuation,
  ChronologMaterializationInvocation,
  ChronologMaterializationOutcome,
  CodecId,
  ContentHashAlgorithm,
  ContentId,
  DatabaseStateDigest,
  DifferentialMaterializationFixture,
  DifferentialObservation,
  DoltChunkId,
  ExactArtifactRef,
  ExactDatabaseRef,
  ExactObjectRef,
  MaterializationInput,
} from './types.js'

export const MATERIALIZER_DECODE_LIMITS: Readonly<DecodeLimits> = Object.freeze({
  ...DEFAULT_DECODE_LIMITS,
  maxBytes: 32 * 1024 * 1024,
  maxArrayItems: 250_000,
  maxMapItems: 250_000,
  maxBlobBytes: 24 * 1024 * 1024,
})

const HASH_ALGORITHMS: readonly ContentHashAlgorithm[] = [
  'sha2-256',
  'blake3-256',
  'dolt-blake3-160',
]
const ARTIFACT_KINDS: readonly ChronologArtifactKind[] = [
  'admitted-suffix',
  'schema-manifest',
  'execution-manifest',
  'continuation',
  'materialization-manifest',
  'outcome-changes',
]

function root(bytes: Uint8Array, name: string, limits: DecodeLimits): ReturnType<typeof expectMap> {
  return expectMap(assertCanonicalCbor(bytes, limits), name)
}

function digestLength(algorithm: ContentHashAlgorithm): number {
  return algorithm === 'dolt-blake3-160' ? 20 : 32
}

function contentIdToCbor(value: ContentId): CborValue {
  const index = HASH_ALGORITHMS.indexOf(value.algorithm)
  canonicalInvariant(index >= 0, 'SCHEMA_INVALID', 'Unknown content hash algorithm')
  canonicalInvariant(
    value.digest.length === digestLength(value.algorithm),
    'SCHEMA_INVALID',
    'Content digest has the wrong length for its algorithm',
  )
  return integerMap([[0, BigInt(index + 1)], [1, value.digest]])
}

function contentIdFromCbor(value: CborValue, name: string): ContentId {
  const map = expectMap(value, name)
  assertKnownIntegerKeys(map, [0, 1], name)
  const index = expectUint(required(map, 0, `${name}.algorithm`), `${name}.algorithm`) - 1
  const algorithm = HASH_ALGORITHMS[index]
  canonicalInvariant(algorithm !== undefined, 'SCHEMA_INVALID', `${name} uses an unknown hash algorithm`)
  return {
    algorithm,
    digest: expectBytes(required(map, 1, `${name}.digest`), `${name}.digest`, digestLength(algorithm)),
  }
}

function codecIdToCbor(value: CodecId): CborValue {
  canonicalInvariant(
    Number.isSafeInteger(value.number) && value.number > 0 && value.number <= 0xffff_ffff,
    'INTEGER_OUT_OF_RANGE',
    'Codec number must be a nonzero uint32',
  )
  canonicalInvariant(
    Number.isSafeInteger(value.version) && value.version >= 0 && value.version <= 0xffff,
    'INTEGER_OUT_OF_RANGE',
    'Codec version must be a uint16',
  )
  return integerMap([[0, BigInt(value.number)], [1, BigInt(value.version)]])
}

function codecIdFromCbor(value: CborValue, name: string): CodecId {
  const map = expectMap(value, name)
  assertKnownIntegerKeys(map, [0, 1], name)
  const number = expectUint(required(map, 0, `${name}.number`), `${name}.number`, 0xffff_ffffn)
  canonicalInvariant(number > 0, 'SCHEMA_INVALID', `${name}.number cannot be zero`)
  return {
    number,
    version: expectUint(required(map, 1, `${name}.version`), `${name}.version`, 0xffffn),
  }
}

export function exactObjectRefToCbor(value: ExactObjectRef): CborValue {
  canonicalInvariant(value.storeId.length > 0 && value.storeId.length <= 1_024, 'SCHEMA_INVALID', 'Store ID has invalid length')
  return integerMap([
    [0, value.storeId],
    [1, codecIdToCbor(value.codec)],
    [2, contentIdToCbor(value.contentId)],
  ])
}

export function exactObjectRefFromCbor(value: CborValue, name: string): ExactObjectRef {
  const map = expectMap(value, name)
  assertKnownIntegerKeys(map, [0, 1, 2], name)
  const storeId = expectBytes(required(map, 0, `${name}.store_id`), `${name}.store_id`)
  canonicalInvariant(storeId.length > 0 && storeId.length <= 1_024, 'SCHEMA_INVALID', `${name}.store_id has invalid length`)
  return {
    storeId,
    codec: codecIdFromCbor(required(map, 1, `${name}.codec`), `${name}.codec`),
    contentId: contentIdFromCbor(required(map, 2, `${name}.content_id`), `${name}.content_id`),
  }
}

function doltChunkToCbor(value: DoltChunkId): CborValue {
  canonicalInvariant(Number.isSafeInteger(value.doltFormatVersion) && value.doltFormatVersion > 0, 'INTEGER_OUT_OF_RANGE', 'Dolt format version must be positive')
  canonicalInvariant(value.contentId.algorithm === 'dolt-blake3-160', 'SCHEMA_INVALID', 'Dolt chunks require dolt-blake3-160')
  return integerMap([[0, BigInt(value.doltFormatVersion)], [1, contentIdToCbor(value.contentId)]])
}

function doltChunkFromCbor(value: CborValue, name: string): DoltChunkId {
  const map = expectMap(value, name)
  assertKnownIntegerKeys(map, [0, 1], name)
  const doltFormatVersion = expectUint(required(map, 0, `${name}.dolt_format_version`), `${name}.dolt_format_version`, 0xffff_ffffn)
  canonicalInvariant(doltFormatVersion > 0, 'SCHEMA_INVALID', `${name}.dolt_format_version cannot be zero`)
  const contentId = contentIdFromCbor(required(map, 1, `${name}.content_id`), `${name}.content_id`)
  canonicalInvariant(contentId.algorithm === 'dolt-blake3-160', 'SCHEMA_INVALID', `${name} requires dolt-blake3-160`)
  return { doltFormatVersion, contentId }
}

function stateDigestToCbor(value: DatabaseStateDigest): CborValue {
  canonicalInvariant(Number.isSafeInteger(value.stateFormatVersion) && value.stateFormatVersion > 0, 'INTEGER_OUT_OF_RANGE', 'State format version must be positive')
  return integerMap([[0, BigInt(value.stateFormatVersion)], [1, contentIdToCbor(value.contentId)]])
}

function stateDigestFromCbor(value: CborValue, name: string): DatabaseStateDigest {
  const map = expectMap(value, name)
  assertKnownIntegerKeys(map, [0, 1], name)
  const stateFormatVersion = expectUint(required(map, 0, `${name}.state_format_version`), `${name}.state_format_version`, 0xffff_ffffn)
  canonicalInvariant(stateFormatVersion > 0, 'SCHEMA_INVALID', `${name}.state_format_version cannot be zero`)
  return {
    stateFormatVersion,
    contentId: contentIdFromCbor(required(map, 1, `${name}.content_id`), `${name}.content_id`),
  }
}

export function exactDatabaseRefToCbor(value: ExactDatabaseRef): CborValue {
  canonicalInvariant(value.storeId.length > 0 && value.storeId.length <= 1_024, 'SCHEMA_INVALID', 'Database store ID has invalid length')
  canonicalInvariant(value.doltFormatVersion === value.canonicalGenesisCommit.doltFormatVersion, 'SCHEMA_INVALID', 'Genesis format differs from database format')
  canonicalInvariant(value.doltFormatVersion === value.commitHash.doltFormatVersion, 'SCHEMA_INVALID', 'Commit format differs from database format')
  return integerMap([
    [0, value.storeId],
    [1, BigInt(value.doltFormatVersion)],
    [2, doltChunkToCbor(value.canonicalGenesisCommit)],
    [3, doltChunkToCbor(value.commitHash)],
    [4, stateDigestToCbor(value.stateDigest)],
  ])
}

export function exactDatabaseRefFromCbor(value: CborValue, name: string): ExactDatabaseRef {
  const map = expectMap(value, name)
  assertKnownIntegerKeys(map, [0, 1, 2, 3, 4], name)
  const storeId = expectBytes(required(map, 0, `${name}.store_id`), `${name}.store_id`)
  canonicalInvariant(storeId.length > 0 && storeId.length <= 1_024, 'SCHEMA_INVALID', `${name}.store_id has invalid length`)
  const doltFormatVersion = expectUint(required(map, 1, `${name}.dolt_format_version`), `${name}.dolt_format_version`, 0xffff_ffffn)
  canonicalInvariant(doltFormatVersion > 0, 'SCHEMA_INVALID', `${name}.dolt_format_version cannot be zero`)
  const canonicalGenesisCommit = doltChunkFromCbor(required(map, 2, `${name}.canonical_genesis`), `${name}.canonical_genesis`)
  const commitHash = doltChunkFromCbor(required(map, 3, `${name}.commit_hash`), `${name}.commit_hash`)
  canonicalInvariant(canonicalGenesisCommit.doltFormatVersion === doltFormatVersion, 'SCHEMA_INVALID', `${name}.canonical_genesis has a different format`)
  canonicalInvariant(commitHash.doltFormatVersion === doltFormatVersion, 'SCHEMA_INVALID', `${name}.commit_hash has a different format`)
  return {
    storeId,
    doltFormatVersion,
    canonicalGenesisCommit,
    commitHash,
    stateDigest: stateDigestFromCbor(required(map, 4, `${name}.state_digest`), `${name}.state_digest`),
  }
}

export function exactArtifactRefToCbor(value: ExactArtifactRef): CborValue {
  const kind = ARTIFACT_KINDS.indexOf(value.kind)
  canonicalInvariant(kind >= 0, 'SCHEMA_INVALID', 'Unknown Chronolog artifact kind')
  canonicalInvariant(Number.isSafeInteger(value.formatVersion) && value.formatVersion > 0, 'INTEGER_OUT_OF_RANGE', 'Artifact format version must be positive')
  return integerMap([
    [0, BigInt(kind + 1)],
    [1, BigInt(value.formatVersion)],
    [2, exactObjectRefToCbor(value.object)],
  ])
}

export function exactArtifactRefFromCbor(value: CborValue, name: string): ExactArtifactRef {
  const map = expectMap(value, name)
  assertKnownIntegerKeys(map, [0, 1, 2], name)
  const kind = ARTIFACT_KINDS[expectUint(required(map, 0, `${name}.kind`), `${name}.kind`) - 1]
  canonicalInvariant(kind !== undefined, 'SCHEMA_INVALID', `${name} uses an unknown artifact kind`)
  const formatVersion = expectUint(required(map, 1, `${name}.format_version`), `${name}.format_version`, 0xffff_ffffn)
  canonicalInvariant(formatVersion > 0, 'SCHEMA_INVALID', `${name}.format_version cannot be zero`)
  return {
    kind,
    formatVersion,
    object: exactObjectRefFromCbor(required(map, 2, `${name}.object`), `${name}.object`),
  }
}

function inputToCbor(value: MaterializationInput): CborValue {
  return integerMap([[0, exactArtifactRefToCbor(value.manifest)], [1, exactDatabaseRefToCbor(value.database)]])
}

function inputFromCbor(value: CborValue, name: string): MaterializationInput {
  const map = expectMap(value, name)
  assertKnownIntegerKeys(map, [0, 1], name)
  const manifest = exactArtifactRefFromCbor(required(map, 0, `${name}.manifest`), `${name}.manifest`)
  canonicalInvariant(manifest.kind === 'materialization-manifest', 'SCHEMA_INVALID', `${name}.manifest has the wrong kind`)
  return {
    manifest,
    database: exactDatabaseRefFromCbor(required(map, 1, `${name}.database`), `${name}.database`),
  }
}

function requireDigest(value: Uint8Array, name: string): Uint8Array {
  canonicalInvariant(value.length === 32, 'SCHEMA_INVALID', `${name} must contain 32 bytes`)
  return value
}

function requireIndex(value: number, name: string): number {
  canonicalInvariant(Number.isSafeInteger(value) && value >= 0, 'INTEGER_OUT_OF_RANGE', `${name} must be a nonnegative safe integer`)
  return value
}

export function encodeMaterializationInvocation(value: ChronologMaterializationInvocation): Uint8Array {
  canonicalInvariant(value.version === 1 && value.profile === 'pure', 'SCHEMA_INVALID', 'Unsupported materialization invocation version or profile')
  canonicalInvariant(value.context.groupId.length === 32, 'SCHEMA_INVALID', 'Invocation group ID must contain 32 bytes')
  canonicalInvariant(value.context.logicalTimeMs === null, 'SCHEMA_INVALID', 'Pure materialization v1 forbids logical time')
  canonicalInvariant(value.context.entropySeed === null, 'SCHEMA_INVALID', 'Pure materialization v1 forbids caller entropy')
  canonicalInvariant(value.admittedSuffix.kind === 'admitted-suffix', 'SCHEMA_INVALID', 'Invocation admitted suffix has the wrong kind')
  canonicalInvariant(value.schemaManifest.kind === 'schema-manifest', 'SCHEMA_INVALID', 'Invocation schema manifest has the wrong kind')
  canonicalInvariant(value.executionManifest.kind === 'execution-manifest', 'SCHEMA_INVALID', 'Invocation execution manifest has the wrong kind')
  canonicalInvariant(value.continuation === null || value.continuation.kind === 'continuation', 'SCHEMA_INVALID', 'Invocation continuation has the wrong kind')
  requireIndex(value.replayFromIndex, 'replayFromIndex')
  requireIndex(value.targetOrderLength, 'targetOrderLength')
  canonicalInvariant(value.replayFromIndex <= value.targetOrderLength, 'SCHEMA_INVALID', 'Replay index exceeds target order length')
  return encodeCanonicalCbor(integerMap([
    [0, 1n],
    [1, 1n],
    [2, integerMap([[0, value.context.groupId], [1, value.context.logicalTimeMs], [2, value.context.entropySeed]])],
    [3, value.previous === null ? null : inputToCbor(value.previous)],
    [4, inputToCbor(value.replayBase)],
    [5, exactArtifactRefToCbor(value.admittedSuffix)],
    [6, exactArtifactRefToCbor(value.schemaManifest)],
    [7, exactArtifactRefToCbor(value.executionManifest)],
    [8, value.continuation === null ? null : exactArtifactRefToCbor(value.continuation)],
    [9, requireDigest(value.expectedEngineDigest, 'expectedEngineDigest')],
    [10, requireDigest(value.expectedSchemaDigest, 'expectedSchemaDigest')],
    [11, requireDigest(value.expectedExecutionManifestDigest, 'expectedExecutionManifestDigest')],
    [12, requireDigest(value.expectedPreviousOrderDigest, 'expectedPreviousOrderDigest')],
    [13, BigInt(value.replayFromIndex)],
    [14, BigInt(value.targetOrderLength)],
    [15, requireDigest(value.targetOrderDigest, 'targetOrderDigest')],
  ]))
}

export function decodeMaterializationInvocation(
  bytes: Uint8Array,
  limits: DecodeLimits = MATERIALIZER_DECODE_LIMITS,
): ChronologMaterializationInvocation {
  const map = root(bytes, 'materialization_invocation', limits)
  assertKnownIntegerKeys(map, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], 'materialization_invocation')
  canonicalInvariant(expectBigint(required(map, 0, 'materialization_invocation.version'), 'materialization_invocation.version') === 1n, 'SCHEMA_INVALID', 'Unsupported materialization invocation version')
  canonicalInvariant(expectBigint(required(map, 1, 'materialization_invocation.profile'), 'materialization_invocation.profile') === 1n, 'SCHEMA_INVALID', 'Materialization invocation must use pure profile')
  const context = expectMap(required(map, 2, 'materialization_invocation.context'), 'materialization_invocation.context')
  assertKnownIntegerKeys(context, [0, 1, 2], 'materialization_invocation.context')
  const logicalTimeMs = required(context, 1, 'materialization_invocation.context.logical_time_ms')
  const entropySeed = required(context, 2, 'materialization_invocation.context.entropy_seed')
  canonicalInvariant(logicalTimeMs === null, 'SCHEMA_INVALID', 'Pure materialization v1 forbids logical time')
  canonicalInvariant(entropySeed === null, 'SCHEMA_INVALID', 'Pure materialization v1 forbids caller entropy')
  const previousValue = required(map, 3, 'materialization_invocation.previous')
  const continuationValue = required(map, 8, 'materialization_invocation.continuation')
  const admittedSuffix = exactArtifactRefFromCbor(required(map, 5, 'materialization_invocation.admitted_suffix'), 'materialization_invocation.admitted_suffix')
  const schemaManifest = exactArtifactRefFromCbor(required(map, 6, 'materialization_invocation.schema_manifest'), 'materialization_invocation.schema_manifest')
  const executionManifest = exactArtifactRefFromCbor(required(map, 7, 'materialization_invocation.execution_manifest'), 'materialization_invocation.execution_manifest')
  const continuation = continuationValue === null ? null : exactArtifactRefFromCbor(continuationValue, 'materialization_invocation.continuation')
  canonicalInvariant(admittedSuffix.kind === 'admitted-suffix', 'SCHEMA_INVALID', 'Invocation admitted suffix has the wrong kind')
  canonicalInvariant(schemaManifest.kind === 'schema-manifest', 'SCHEMA_INVALID', 'Invocation schema manifest has the wrong kind')
  canonicalInvariant(executionManifest.kind === 'execution-manifest', 'SCHEMA_INVALID', 'Invocation execution manifest has the wrong kind')
  canonicalInvariant(continuation === null || continuation.kind === 'continuation', 'SCHEMA_INVALID', 'Invocation continuation has the wrong kind')
  const replayFromIndex = expectUint(required(map, 13, 'materialization_invocation.replay_from_index'), 'materialization_invocation.replay_from_index')
  const targetOrderLength = expectUint(required(map, 14, 'materialization_invocation.target_order_length'), 'materialization_invocation.target_order_length')
  canonicalInvariant(replayFromIndex <= targetOrderLength, 'SCHEMA_INVALID', 'Replay index exceeds target order length')
  return {
    version: 1,
    profile: 'pure',
    context: {
      groupId: expectBytes(required(context, 0, 'materialization_invocation.context.group_id'), 'materialization_invocation.context.group_id', 32),
      logicalTimeMs: null,
      entropySeed: null,
    },
    previous: previousValue === null ? null : inputFromCbor(previousValue, 'materialization_invocation.previous'),
    replayBase: inputFromCbor(required(map, 4, 'materialization_invocation.replay_base'), 'materialization_invocation.replay_base'),
    admittedSuffix,
    schemaManifest,
    executionManifest,
    continuation,
    expectedEngineDigest: expectBytes(required(map, 9, 'materialization_invocation.expected_engine_digest'), 'materialization_invocation.expected_engine_digest', 32),
    expectedSchemaDigest: expectBytes(required(map, 10, 'materialization_invocation.expected_schema_digest'), 'materialization_invocation.expected_schema_digest', 32),
    expectedExecutionManifestDigest: expectBytes(required(map, 11, 'materialization_invocation.expected_execution_manifest_digest'), 'materialization_invocation.expected_execution_manifest_digest', 32),
    expectedPreviousOrderDigest: expectBytes(required(map, 12, 'materialization_invocation.expected_previous_order_digest'), 'materialization_invocation.expected_previous_order_digest', 32),
    replayFromIndex,
    targetOrderLength,
    targetOrderDigest: expectBytes(required(map, 15, 'materialization_invocation.target_order_digest'), 'materialization_invocation.target_order_digest', 32),
  }
}

function admittedTransactionToCbor(value: ChronologAdmittedSuffix['transactions'][number]): CborValue {
  canonicalInvariant(value.txId.length > 0, 'SCHEMA_INVALID', 'Transaction ID cannot be empty')
  canonicalInvariant(value.authorFeedSequence >= 0n, 'INTEGER_OUT_OF_RANGE', 'Author feed sequence cannot be negative')
  canonicalInvariant(value.candidateDigest.length === 32, 'SCHEMA_INVALID', 'Candidate digest must contain 32 bytes')
  canonicalInvariant(value.canonicalCandidate.length > 0, 'SCHEMA_INVALID', 'Canonical candidate cannot be empty')
  canonicalInvariant(
    encodeCanonicalCbor(assertCanonicalCbor(value.canonicalCandidate, MATERIALIZER_DECODE_LIMITS)).every(
      (byte, index) => byte === value.canonicalCandidate[index],
    ),
    'SCHEMA_INVALID',
    'Candidate bytes are not canonical',
  )
  return [value.txId, value.authorFeedSequence, value.candidateDigest, value.canonicalCandidate]
}

export function encodeAdmittedSuffix(value: ChronologAdmittedSuffix): Uint8Array {
  canonicalInvariant(value.version === 1, 'SCHEMA_INVALID', 'Unsupported admitted suffix version')
  canonicalInvariant(value.groupId.length === 32, 'SCHEMA_INVALID', 'Admitted suffix group ID must contain 32 bytes')
  requireIndex(value.replayFromIndex, 'replayFromIndex')
  requireIndex(value.targetOrderLength, 'targetOrderLength')
  canonicalInvariant(value.replayFromIndex + value.transactions.length === value.targetOrderLength, 'SCHEMA_INVALID', 'Admitted suffix length does not reach target order length')
  return encodeCanonicalCbor(integerMap([
    [0, 1n],
    [1, value.groupId],
    [2, BigInt(value.replayFromIndex)],
    [3, BigInt(value.targetOrderLength)],
    [4, requireDigest(value.targetOrderDigest, 'targetOrderDigest')],
    [5, value.transactions.map(admittedTransactionToCbor)],
  ]))
}

export function decodeAdmittedSuffix(
  bytes: Uint8Array,
  limits: DecodeLimits = MATERIALIZER_DECODE_LIMITS,
): ChronologAdmittedSuffix {
  const map = root(bytes, 'admitted_suffix', limits)
  assertKnownIntegerKeys(map, [0, 1, 2, 3, 4, 5], 'admitted_suffix')
  canonicalInvariant(expectBigint(required(map, 0, 'admitted_suffix.version'), 'admitted_suffix.version') === 1n, 'SCHEMA_INVALID', 'Unsupported admitted suffix version')
  const transactions = expectArray(required(map, 5, 'admitted_suffix.transactions'), 'admitted_suffix.transactions').map((value, index) => {
    const tuple = expectArray(value, `admitted_suffix.transactions[${index}]`)
    canonicalInvariant(tuple.length === 4, 'SCHEMA_INVALID', `admitted_suffix.transactions[${index}] has invalid arity`)
    const canonicalCandidate = expectBytes(tuple[3] ?? null, `admitted_suffix.transactions[${index}].canonical_candidate`)
    const core = decodeTransactionCore(canonicalCandidate)
    canonicalInvariant(
      encodeTransactionCore(core).every((byte, offset) => byte === canonicalCandidate[offset]),
      'SCHEMA_INVALID',
      `admitted_suffix.transactions[${index}] is not canonical`,
    )
    return {
      txId: expectBytes(tuple[0] ?? null, `admitted_suffix.transactions[${index}].tx_id`),
      authorFeedSequence: expectBigint(tuple[1] ?? null, `admitted_suffix.transactions[${index}].author_feed_sequence`),
      candidateDigest: expectBytes(tuple[2] ?? null, `admitted_suffix.transactions[${index}].candidate_digest`, 32),
      canonicalCandidate,
      core,
    }
  })
  for (const [index, transaction] of transactions.entries()) {
    canonicalInvariant(transaction.txId.length > 0, 'SCHEMA_INVALID', `admitted_suffix.transactions[${index}].tx_id cannot be empty`)
    canonicalInvariant(transaction.authorFeedSequence >= 0n, 'INTEGER_OUT_OF_RANGE', `admitted_suffix.transactions[${index}].author_feed_sequence cannot be negative`)
  }
  const replayFromIndex = expectUint(required(map, 2, 'admitted_suffix.replay_from_index'), 'admitted_suffix.replay_from_index')
  const targetOrderLength = expectUint(required(map, 3, 'admitted_suffix.target_order_length'), 'admitted_suffix.target_order_length')
  canonicalInvariant(replayFromIndex + transactions.length === targetOrderLength, 'SCHEMA_INVALID', 'Admitted suffix length does not reach target order length')
  return {
    version: 1,
    groupId: expectBytes(required(map, 1, 'admitted_suffix.group_id'), 'admitted_suffix.group_id', 32),
    replayFromIndex,
    targetOrderLength,
    targetOrderDigest: expectBytes(required(map, 4, 'admitted_suffix.target_order_digest'), 'admitted_suffix.target_order_digest', 32),
    transactions,
  }
}

export function encodeMaterializationContinuation(value: ChronologMaterializationContinuation): Uint8Array {
  canonicalInvariant(value.version === 1, 'SCHEMA_INVALID', 'Unsupported continuation version')
  requireIndex(value.nextOrderIndex, 'nextOrderIndex')
  return encodeCanonicalCbor(integerMap([
    [0, 1n],
    [1, requireDigest(value.invocationDigest, 'invocationDigest')],
    [2, exactDatabaseRefToCbor(value.partialDatabase)],
    [3, BigInt(value.nextOrderIndex)],
    [4, requireDigest(value.prefixOrderDigest, 'prefixOrderDigest')],
  ]))
}

export function decodeMaterializationContinuation(
  bytes: Uint8Array,
  limits: DecodeLimits = MATERIALIZER_DECODE_LIMITS,
): ChronologMaterializationContinuation {
  const map = root(bytes, 'materialization_continuation', limits)
  assertKnownIntegerKeys(map, [0, 1, 2, 3, 4], 'materialization_continuation')
  canonicalInvariant(expectBigint(required(map, 0, 'materialization_continuation.version'), 'materialization_continuation.version') === 1n, 'SCHEMA_INVALID', 'Unsupported continuation version')
  return {
    version: 1,
    invocationDigest: expectBytes(required(map, 1, 'materialization_continuation.invocation_digest'), 'materialization_continuation.invocation_digest', 32),
    partialDatabase: exactDatabaseRefFromCbor(required(map, 2, 'materialization_continuation.partial_database'), 'materialization_continuation.partial_database'),
    nextOrderIndex: expectUint(required(map, 3, 'materialization_continuation.next_order_index'), 'materialization_continuation.next_order_index'),
    prefixOrderDigest: expectBytes(required(map, 4, 'materialization_continuation.prefix_order_digest'), 'materialization_continuation.prefix_order_digest', 32),
  }
}

export function encodeMaterializationOutcome(value: ChronologMaterializationOutcome): Uint8Array {
  if (value.kind === 'completed') {
    return encodeCanonicalCbor(integerMap([
      [0, 1n], [1, 1n], [2, exactDatabaseRefToCbor(value.outputDatabase)],
      [3, exactArtifactRefToCbor(value.materializationManifest)],
      [4, exactArtifactRefToCbor(value.outcomeChanges)], [5, BigInt(requireIndex(value.orderLength, 'orderLength'))],
      [6, requireDigest(value.orderDigest, 'orderDigest')], [7, BigInt(requireIndex(value.replayFromIndex, 'replayFromIndex'))],
      [8, contentIdToCbor(value.stateDigest)],
    ]))
  }
  if (value.kind === 'unchanged') {
    return encodeCanonicalCbor(integerMap([
      [0, 1n], [1, 2n], [2, exactDatabaseRefToCbor(value.outputDatabase)],
      [3, exactArtifactRefToCbor(value.materializationManifest)], [5, BigInt(requireIndex(value.orderLength, 'orderLength'))],
      [6, requireDigest(value.orderDigest, 'orderDigest')], [8, contentIdToCbor(value.stateDigest)],
    ]))
  }
  return encodeCanonicalCbor(integerMap([
    [0, 1n], [1, 3n], [2, exactDatabaseRefToCbor(value.partialDatabase)],
    [3, exactArtifactRefToCbor(value.continuation)], [5, BigInt(requireIndex(value.nextOrderIndex, 'nextOrderIndex'))],
    [6, requireDigest(value.prefixOrderDigest, 'prefixOrderDigest')],
  ]))
}

export function decodeMaterializationOutcome(
  bytes: Uint8Array,
  limits: DecodeLimits = MATERIALIZER_DECODE_LIMITS,
): ChronologMaterializationOutcome {
  const map = root(bytes, 'materialization_outcome', limits)
  assertKnownIntegerKeys(map, [0, 1, 2, 3, 4, 5, 6, 7, 8], 'materialization_outcome')
  canonicalInvariant(expectBigint(required(map, 0, 'materialization_outcome.version'), 'materialization_outcome.version') === 1n, 'SCHEMA_INVALID', 'Unsupported materialization outcome version')
  const kind = expectBigint(required(map, 1, 'materialization_outcome.kind'), 'materialization_outcome.kind')
  if (kind === 1n) {
    const materializationManifest = exactArtifactRefFromCbor(required(map, 3, 'materialization_outcome.materialization_manifest'), 'materialization_outcome.materialization_manifest')
    const outcomeChanges = exactArtifactRefFromCbor(required(map, 4, 'materialization_outcome.outcome_changes'), 'materialization_outcome.outcome_changes')
    canonicalInvariant(materializationManifest.kind === 'materialization-manifest', 'SCHEMA_INVALID', 'Outcome manifest has the wrong kind')
    canonicalInvariant(outcomeChanges.kind === 'outcome-changes', 'SCHEMA_INVALID', 'Outcome changes have the wrong kind')
    return {
      kind: 'completed',
      outputDatabase: exactDatabaseRefFromCbor(required(map, 2, 'materialization_outcome.output_database'), 'materialization_outcome.output_database'),
      materializationManifest,
      outcomeChanges,
      orderLength: expectUint(required(map, 5, 'materialization_outcome.order_length'), 'materialization_outcome.order_length'),
      orderDigest: expectBytes(required(map, 6, 'materialization_outcome.order_digest'), 'materialization_outcome.order_digest', 32),
      replayFromIndex: expectUint(required(map, 7, 'materialization_outcome.replay_from_index'), 'materialization_outcome.replay_from_index'),
      stateDigest: contentIdFromCbor(required(map, 8, 'materialization_outcome.state_digest'), 'materialization_outcome.state_digest'),
    }
  }
  if (kind === 2n) {
    const materializationManifest = exactArtifactRefFromCbor(required(map, 3, 'materialization_outcome.materialization_manifest'), 'materialization_outcome.materialization_manifest')
    canonicalInvariant(materializationManifest.kind === 'materialization-manifest', 'SCHEMA_INVALID', 'Outcome manifest has the wrong kind')
    return {
      kind: 'unchanged',
      outputDatabase: exactDatabaseRefFromCbor(required(map, 2, 'materialization_outcome.output_database'), 'materialization_outcome.output_database'),
      materializationManifest,
      orderLength: expectUint(required(map, 5, 'materialization_outcome.order_length'), 'materialization_outcome.order_length'),
      orderDigest: expectBytes(required(map, 6, 'materialization_outcome.order_digest'), 'materialization_outcome.order_digest', 32),
      stateDigest: contentIdFromCbor(required(map, 8, 'materialization_outcome.state_digest'), 'materialization_outcome.state_digest'),
    }
  }
  canonicalInvariant(kind === 3n, 'SCHEMA_INVALID', 'Unknown materialization outcome kind')
  const continuation = exactArtifactRefFromCbor(required(map, 3, 'materialization_outcome.continuation'), 'materialization_outcome.continuation')
  canonicalInvariant(continuation.kind === 'continuation', 'SCHEMA_INVALID', 'Checkpoint outcome continuation has the wrong kind')
  return {
    kind: 'checkpointed',
    partialDatabase: exactDatabaseRefFromCbor(required(map, 2, 'materialization_outcome.partial_database'), 'materialization_outcome.partial_database'),
    continuation,
    nextOrderIndex: expectUint(required(map, 5, 'materialization_outcome.next_order_index'), 'materialization_outcome.next_order_index'),
    prefixOrderDigest: expectBytes(required(map, 6, 'materialization_outcome.prefix_order_digest'), 'materialization_outcome.prefix_order_digest', 32),
  }
}

export function encodeDifferentialObservation(value: DifferentialObservation): Uint8Array {
  canonicalInvariant(value.version === 1, 'SCHEMA_INVALID', 'Unsupported differential observation version')
  return encodeCanonicalCbor(integerMap([
    [0, 1n], [1, BigInt(requireIndex(value.orderLength, 'orderLength'))],
    [2, requireDigest(value.orderDigest, 'orderDigest')], [3, contentIdToCbor(value.stateDigest)],
    [4, requireDigest(value.protectedLogDigest, 'protectedLogDigest')],
    [5, requireDigest(value.outcomeSetDigest, 'outcomeSetDigest')],
    [6, requireDigest(value.queryResultDigest, 'queryResultDigest')],
    [7, requireDigest(value.rejectionAttributionDigest, 'rejectionAttributionDigest')],
  ]))
}

export function decodeDifferentialObservation(
  bytes: Uint8Array,
  limits: DecodeLimits = MATERIALIZER_DECODE_LIMITS,
): DifferentialObservation {
  const map = root(bytes, 'differential_observation', limits)
  assertKnownIntegerKeys(map, [0, 1, 2, 3, 4, 5, 6, 7], 'differential_observation')
  canonicalInvariant(expectBigint(required(map, 0, 'differential_observation.version'), 'differential_observation.version') === 1n, 'SCHEMA_INVALID', 'Unsupported differential observation version')
  return {
    version: 1,
    orderLength: expectUint(required(map, 1, 'differential_observation.order_length'), 'differential_observation.order_length'),
    orderDigest: expectBytes(required(map, 2, 'differential_observation.order_digest'), 'differential_observation.order_digest', 32),
    stateDigest: contentIdFromCbor(required(map, 3, 'differential_observation.state_digest'), 'differential_observation.state_digest'),
    protectedLogDigest: expectBytes(required(map, 4, 'differential_observation.protected_log_digest'), 'differential_observation.protected_log_digest', 32),
    outcomeSetDigest: expectBytes(required(map, 5, 'differential_observation.outcome_set_digest'), 'differential_observation.outcome_set_digest', 32),
    queryResultDigest: expectBytes(required(map, 6, 'differential_observation.query_result_digest'), 'differential_observation.query_result_digest', 32),
    rejectionAttributionDigest: expectBytes(required(map, 7, 'differential_observation.rejection_attribution_digest'), 'differential_observation.rejection_attribution_digest', 32),
  }
}

export function encodeDifferentialFixture(value: DifferentialMaterializationFixture): Uint8Array {
  canonicalInvariant(value.version === 1, 'SCHEMA_INVALID', 'Unsupported differential fixture version')
  canonicalInvariant(value.name.length > 0 && value.name.length <= 256, 'SCHEMA_INVALID', 'Differential fixture name has invalid length')
  decodeMaterializationInvocation(value.invocation)
  const objects = [...value.objects].sort((left, right) => compareObjectRefs(left.ref, right.ref))
  for (let index = 1; index < objects.length; index += 1) {
    canonicalInvariant(compareObjectRefs(objects[index - 1]!.ref, objects[index]!.ref) !== 0, 'SCHEMA_INVALID', 'Differential fixture contains a duplicate object ref')
  }
  return encodeCanonicalCbor(integerMap([
    [0, 1n], [1, value.name], [2, value.invocation],
    [3, objects.map((object) => [exactObjectRefToCbor(object.ref), object.bytes])],
  ]))
}

export function decodeDifferentialFixture(
  bytes: Uint8Array,
  limits: DecodeLimits = MATERIALIZER_DECODE_LIMITS,
): DifferentialMaterializationFixture {
  const map = root(bytes, 'differential_fixture', limits)
  assertKnownIntegerKeys(map, [0, 1, 2, 3], 'differential_fixture')
  canonicalInvariant(expectBigint(required(map, 0, 'differential_fixture.version'), 'differential_fixture.version') === 1n, 'SCHEMA_INVALID', 'Unsupported differential fixture version')
  const name = expectString(required(map, 1, 'differential_fixture.name'), 'differential_fixture.name')
  canonicalInvariant(name.length > 0 && name.length <= 256, 'SCHEMA_INVALID', 'Differential fixture name has invalid length')
  const invocation = expectBytes(required(map, 2, 'differential_fixture.invocation'), 'differential_fixture.invocation')
  decodeMaterializationInvocation(invocation, limits)
  const objects = expectArray(required(map, 3, 'differential_fixture.objects'), 'differential_fixture.objects').map((value, index) => {
    const tuple = expectArray(value, `differential_fixture.objects[${index}]`)
    canonicalInvariant(tuple.length === 2, 'SCHEMA_INVALID', `differential_fixture.objects[${index}] has invalid arity`)
    return {
      ref: exactObjectRefFromCbor(tuple[0] ?? null, `differential_fixture.objects[${index}].ref`),
      bytes: expectBytes(tuple[1] ?? null, `differential_fixture.objects[${index}].bytes`),
    }
  })
  for (let index = 1; index < objects.length; index += 1) {
    canonicalInvariant(compareObjectRefs(objects[index - 1]!.ref, objects[index]!.ref) < 0, 'SCHEMA_INVALID', 'Differential fixture object refs are not strictly sorted')
  }
  return { version: 1, name, invocation, objects }
}

export function encodeSchemaManifestArtifact(value: SchemaManifest): Uint8Array {
  return encodeSchemaManifest(value)
}

export function decodeSchemaManifestArtifact(bytes: Uint8Array): SchemaManifest {
  return decodeSchemaManifest(bytes)
}

export function encodeExecutionManifestArtifact(value: ExecutionManifest): Uint8Array {
  return encodeExecutionManifest(value)
}

export function decodeExecutionManifestArtifact(bytes: Uint8Array): ExecutionManifest {
  return decodeExecutionManifest(bytes)
}

export async function digestMaterializationInvocation(value: ChronologMaterializationInvocation): Promise<Uint8Array> {
  return digestFramed('chronolog/materialization-invocation/v1', encodeMaterializationInvocation(value))
}

export async function digestAdmittedOrder(transactionIds: readonly Uint8Array[]): Promise<Uint8Array> {
  const framed = transactionIds.map((transactionId) => {
    canonicalInvariant(transactionId.length > 0, 'SCHEMA_INVALID', 'Transaction ID cannot be empty')
    const length = new Uint8Array(4)
    new DataView(length.buffer).setUint32(0, transactionId.length, false)
    return concatBytes(length, transactionId)
  })
  return digestFramed('chronolog/admitted-order/v1', concatBytes(...framed))
}

export async function digestFramed(domain: string, payload: Uint8Array): Promise<Uint8Array> {
  const domainBytes = utf8(domain)
  const length = new Uint8Array(4)
  new DataView(length.buffer).setUint32(0, domainBytes.length, false)
  return sha256(concatBytes(length, domainBytes, Uint8Array.of(0), payload))
}

export function compareObjectRefs(left: ExactObjectRef, right: ExactObjectRef): number {
  const leftBytes = encodeCanonicalCbor(exactObjectRefToCbor(left))
  const rightBytes = encodeCanonicalCbor(exactObjectRefToCbor(right))
  const length = Math.min(leftBytes.length, rightBytes.length)
  for (let index = 0; index < length; index += 1) {
    if (leftBytes[index] !== rightBytes[index]) return leftBytes[index]! < rightBytes[index]! ? -1 : 1
  }
  return leftBytes.length - rightBytes.length
}

export function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false
  let difference = 0
  for (let index = 0; index < left.length; index += 1) difference |= left[index]! ^ right[index]!
  return difference === 0
}
