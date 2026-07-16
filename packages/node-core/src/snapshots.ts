import {
  DOMAINS,
  equalBytes,
  signDomain,
  verifyDomain,
  type Ed25519KeyPair,
} from '@chronolog/protocol'
import {
  assertCanonicalCbor,
  DEFAULT_DECODE_LIMITS,
  encodeCanonicalCbor,
  expectArray,
  expectBytes,
  expectMap,
  required,
  type CborValue,
} from '@chronolog/canonical'

export interface SnapshotFeedHead {
  readonly feedId: string
  readonly sequence: bigint
  readonly recordId: string
}

export interface TrustedSnapshotManifest {
  readonly version: 1
  readonly groupId: Uint8Array
  readonly executionManifestDigest: Uint8Array
  readonly materializedRevision: bigint
  readonly orderLength: number
  readonly databaseContentHash: string
  readonly transactionLogDigest: Uint8Array
  readonly feedHeads: readonly SnapshotFeedHead[]
  readonly createdAtMs: bigint
}

export interface SignedSnapshotManifest {
  readonly manifest: TrustedSnapshotManifest
  readonly signer: Uint8Array
  readonly signature: Uint8Array
}

export async function signSnapshotManifest(
  manifest: TrustedSnapshotManifest,
  signer: Ed25519KeyPair,
): Promise<SignedSnapshotManifest> {
  const encoded = encodeSnapshotManifest(manifest)
  return {
    manifest: cloneManifest(manifest),
    signer: signer.publicKeyBytes.slice(),
    signature: await signDomain(DOMAINS.snapshotManifest, encoded, signer.privateKey),
  }
}

export async function assertSnapshotTrust(
  signed: SignedSnapshotManifest,
  expectations: {
    readonly groupId: Uint8Array
    readonly executionManifestDigest: Uint8Array
    readonly authorizedSigners: readonly Uint8Array[]
    readonly minimumRevision?: bigint
  },
): Promise<TrustedSnapshotManifest> {
  const canonical = decodeSignedSnapshotManifest(encodeSignedSnapshotManifest(signed))
  if (!expectations.authorizedSigners.some((signer) => equalBytes(signer, canonical.signer))) {
    throw new Error('SNAPSHOT_SIGNER_UNAUTHORIZED')
  }
  if (!await verifyDomain(
    DOMAINS.snapshotManifest,
    encodeSnapshotManifest(canonical.manifest),
    canonical.signature,
    canonical.signer,
  )) throw new Error('SNAPSHOT_SIGNATURE_INVALID')
  if (!equalBytes(canonical.manifest.groupId, expectations.groupId)) throw new Error('SNAPSHOT_GROUP_MISMATCH')
  if (!equalBytes(canonical.manifest.executionManifestDigest, expectations.executionManifestDigest)) {
    throw new Error('SNAPSHOT_EXECUTION_MANIFEST_MISMATCH')
  }
  if (canonical.manifest.materializedRevision < (expectations.minimumRevision ?? 0n)) {
    throw new Error('SNAPSHOT_REVISION_ROLLBACK')
  }
  return cloneManifest(canonical.manifest)
}

export function encodeSignedSnapshotManifest(value: SignedSnapshotManifest): Uint8Array {
  return encodeCanonicalCbor([1n, snapshotToCbor(value.manifest), value.signer, value.signature])
}

export function decodeSignedSnapshotManifest(bytes: Uint8Array): SignedSnapshotManifest {
  const value = expectArray(assertCanonicalCbor(bytes, DEFAULT_DECODE_LIMITS), 'signed_snapshot')
  if (value.length !== 4 || value[0] !== 1n) {
    throw new Error('SNAPSHOT_SIGNED_SCHEMA_INVALID')
  }
  return {
    manifest: snapshotFromCbor(value[1] ?? null),
    signer: expectBytes(value[2] ?? null, 'signed_snapshot.signer'),
    signature: expectBytes(value[3] ?? null, 'signed_snapshot.signature'),
  }
}

function encodeSnapshotManifest(value: TrustedSnapshotManifest): Uint8Array {
  return encodeCanonicalCbor(snapshotToCbor(value))
}

function snapshotToCbor(value: TrustedSnapshotManifest): CborValue {
  validateManifest(value)
  return new Map<bigint, CborValue>([
    [0n, 1n],
    [1n, value.groupId],
    [2n, value.executionManifestDigest],
    [3n, value.materializedRevision],
    [4n, BigInt(value.orderLength)],
    [5n, value.databaseContentHash],
    [6n, value.transactionLogDigest],
    [7n, canonicalFeedHeads(value.feedHeads).map((head) => [head.feedId, head.sequence, head.recordId])],
    [8n, value.createdAtMs],
  ])
}

function snapshotFromCbor(value: CborValue): TrustedSnapshotManifest {
  const map = expectMap(value, 'snapshot_manifest')
  if (map.size !== 9 || map.get(0n) !== 1n) {
    throw new Error('SNAPSHOT_MANIFEST_SCHEMA_INVALID')
  }
  const groupId = required(map, 1, 'snapshot_manifest.group_id')
  const executionManifestDigest = required(map, 2, 'snapshot_manifest.execution_manifest')
  const materializedRevision = required(map, 3, 'snapshot_manifest.revision')
  const orderLength = required(map, 4, 'snapshot_manifest.order_length')
  const databaseContentHash = required(map, 5, 'snapshot_manifest.database_hash')
  const transactionLogDigest = required(map, 6, 'snapshot_manifest.log_digest')
  const rawHeads = required(map, 7, 'snapshot_manifest.feed_heads')
  const createdAtMs = required(map, 8, 'snapshot_manifest.created_at')
  if (!(groupId instanceof Uint8Array) || !(executionManifestDigest instanceof Uint8Array) ||
      typeof materializedRevision !== 'bigint' || typeof orderLength !== 'bigint' ||
      typeof databaseContentHash !== 'string' || !(transactionLogDigest instanceof Uint8Array) ||
      !Array.isArray(rawHeads) || typeof createdAtMs !== 'bigint' ||
      orderLength < 0n || orderLength > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('SNAPSHOT_MANIFEST_SCHEMA_INVALID')
  }
  const feedHeads = rawHeads.map((raw) => {
    if (!Array.isArray(raw) || raw.length !== 3 || typeof raw[0] !== 'string' ||
        typeof raw[1] !== 'bigint' || typeof raw[2] !== 'string') {
      throw new Error('SNAPSHOT_MANIFEST_SCHEMA_INVALID')
    }
    return { feedId: raw[0], sequence: raw[1], recordId: raw[2] }
  })
  const result: TrustedSnapshotManifest = {
    version: 1,
    groupId,
    executionManifestDigest,
    materializedRevision,
    orderLength: Number(orderLength),
    databaseContentHash,
    transactionLogDigest,
    feedHeads,
    createdAtMs,
  }
  validateManifest(result)
  return result
}

function validateManifest(value: TrustedSnapshotManifest): void {
  if (value.version !== 1 || value.groupId.length !== 32 || value.executionManifestDigest.length !== 32 ||
      value.transactionLogDigest.length !== 32 || value.materializedRevision < 0n ||
      !Number.isSafeInteger(value.orderLength) || value.orderLength < 0 ||
      value.databaseContentHash.length === 0 || value.databaseContentHash.length > 256 ||
      value.createdAtMs < 0n) throw new Error('SNAPSHOT_MANIFEST_INVALID')
  const heads = canonicalFeedHeads(value.feedHeads)
  if (heads.some((head, index) => head.feedId !== value.feedHeads[index]?.feedId)) {
    throw new Error('SNAPSHOT_FEED_HEADS_NON_CANONICAL')
  }
  if (new Set(heads.map((head) => head.feedId)).size !== heads.length ||
      heads.some((head) => head.feedId.length === 0 || head.recordId.length === 0 || head.sequence < 1n)) {
    throw new Error('SNAPSHOT_FEED_HEAD_INVALID')
  }
}

function canonicalFeedHeads(heads: readonly SnapshotFeedHead[]): readonly SnapshotFeedHead[] {
  return [...heads].sort((left, right) => left.feedId.localeCompare(right.feedId))
}

function cloneManifest(value: TrustedSnapshotManifest): TrustedSnapshotManifest {
  return {
    ...value,
    groupId: value.groupId.slice(),
    executionManifestDigest: value.executionManifestDigest.slice(),
    transactionLogDigest: value.transactionLogDigest.slice(),
    feedHeads: value.feedHeads.map((head) => ({ ...head })),
  }
}
