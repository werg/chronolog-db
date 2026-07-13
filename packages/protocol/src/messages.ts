import {
  assertValidTransactionProgram,
  transactionProgramFromCanonicalCbor,
  transactionProgramToCanonicalCbor,
  type TransactionProgram,
} from '@chronolog/ir'
import { hashDomain as hashCanonicalDomain } from '@chronolog/canonical'

import { compareBytes, concatBytes, equalBytes } from './bytes.js'
import { assertCanonicalCbor, type CborValue, encodeCanonicalCbor } from './cbor.js'
import { ProtocolError, protocolInvariant } from './errors.js'
import { DOMAINS, hashDomain } from './primitives.js'
import {
  assertKnownIntegerKeys, expectArray, expectBytes, expectMap, expectUint64,
  expectVersion, integerMap, optional, required,
} from './schema.js'

export interface TransactionCore {
  readonly groupId: Uint8Array
  readonly membershipRevision: Uint8Array
  readonly validationPolicy: Uint8Array
  readonly authorId: Uint8Array
  readonly authorTimestampMs: bigint
  readonly nonce: Uint8Array
  readonly executionManifestDigest: Uint8Array
  readonly schemaDigest: Uint8Array
  readonly program: TransactionProgram
  readonly metadata?: ReadonlyMap<string, Uint8Array>
}

export interface PayloadChunk { readonly digest: Uint8Array; readonly size: bigint }
export interface PayloadManifest { readonly totalDigest: Uint8Array; readonly totalSize: bigint; readonly chunks: readonly PayloadChunk[] }
export type EnvelopeMessageType = 'candidate' | 'attestation' | 'heartbeat' | 'capability' | 'recovery' | 'epoch-manifest' | 'proof-bundle' | 'snapshot'
export interface ChronologEnvelope {
  readonly groupRoute: Uint8Array
  readonly messageType: EnvelopeMessageType
  readonly encryptionEpoch: Uint8Array | null
  readonly payloadDigest: Uint8Array
  readonly payload: { readonly type: 'inline'; readonly bytes: Uint8Array } | { readonly type: 'manifest'; readonly manifest: PayloadManifest }
}
export interface ValidatorAttestation {
  readonly groupId: Uint8Array; readonly membershipRevision: Uint8Array; readonly validatorCapability: Uint8Array
  readonly txId: Uint8Array; readonly validatorId: Uint8Array; readonly authorTimestampMs: bigint
  readonly acceptedAboveMs: bigint; readonly candidateDigest: Uint8Array; readonly decision: 'admit'; readonly policyVersion: bigint
}
export interface ValidatorHeartbeat { readonly groupId: Uint8Array; readonly membershipRevision: Uint8Array; readonly validatorCapability: Uint8Array; readonly validatorId: Uint8Array; readonly acceptanceCutoffMs: bigint }
export interface TransactionOrderKey { readonly authorTimestampMs: bigint; readonly authorId: Uint8Array; readonly authorFeedSequence: bigint; readonly txId: Uint8Array }
export interface CandidateTransportIdentity { readonly authorFeedSequence: bigint; readonly txId: Uint8Array }

function metadataToCbor(metadata: ReadonlyMap<string, Uint8Array> | undefined): CborValue | undefined {
  if (metadata === undefined) return undefined
  return new Map([...metadata.entries()].map(([key, value]) => [key, value] as const))
}

function metadataFromCbor(value: CborValue): ReadonlyMap<string, Uint8Array> {
  const map = expectMap(value, 'transaction.metadata'), result = new Map<string, Uint8Array>()
  for (const [key, item] of map) { protocolInvariant(typeof key === 'string', 'SCHEMA_INVALID', 'Transaction metadata keys must be text'); result.set(key, expectBytes(item, `transaction.metadata.${String(key)}`)) }
  return result
}

function transactionToCbor(value: TransactionCore): CborValue {
  for (const [field, bytes] of [
    ['groupId', value.groupId], ['membershipRevision', value.membershipRevision],
    ['validationPolicy', value.validationPolicy], ['authorId', value.authorId],
  ] as const) protocolInvariant(bytes.length === 32, 'SCHEMA_INVALID', `${field} must contain 32 bytes`)
  protocolInvariant(value.authorTimestampMs >= 0n && value.authorTimestampMs <= (1n << 63n) - 1n, 'INTEGER_OUT_OF_RANGE', 'Author timestamp must be a nonnegative int64')
  protocolInvariant(value.nonce.length >= 16, 'SCHEMA_INVALID', 'Transaction nonce must contain at least 16 bytes')
  protocolInvariant(value.executionManifestDigest.length === 32, 'SCHEMA_INVALID', 'Execution-manifest digest must contain 32 bytes')
  protocolInvariant(value.schemaDigest.length === 32, 'SCHEMA_INVALID', 'Schema digest must contain 32 bytes')
  assertValidTransactionProgram(value.program)
  return integerMap([
    [0, 1n], [1, value.groupId], [2, value.membershipRevision], [3, value.validationPolicy],
    [4, value.authorId], [5, value.authorTimestampMs], [6, value.nonce], [7, value.executionManifestDigest],
    [8, value.schemaDigest], [9, transactionProgramToCanonicalCbor(value.program)], [10, metadataToCbor(value.metadata)],
  ])
}

export function encodeTransactionCore(value: TransactionCore): Uint8Array { return encodeCanonicalCbor(transactionToCbor(value)) }

export function decodeTransactionCore(bytes: Uint8Array): TransactionCore {
  const map = expectMap(assertCanonicalCbor(bytes), 'transaction')
  assertKnownIntegerKeys(map, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 'transaction')
  expectVersion(map, 1n, 'transaction')
  const authorTimestampMs = expectUint64(required(map, 5, 'transaction.author_timestamp_ms'), 'transaction.author_timestamp_ms')
  protocolInvariant(authorTimestampMs <= (1n << 63n) - 1n, 'INTEGER_OUT_OF_RANGE', 'Author timestamp is outside nonnegative int64')
  const nonce = expectBytes(required(map, 6, 'transaction.nonce'), 'transaction.nonce')
  protocolInvariant(nonce.length >= 16, 'SCHEMA_INVALID', 'Transaction nonce must contain at least 16 bytes')
  const program = transactionProgramFromCanonicalCbor(required(map, 9, 'transaction.program'))
  assertValidTransactionProgram(program)
  const metadata = optional(map, 10)
  return {
    groupId: expectBytes(required(map, 1, 'transaction.group_id'), 'transaction.group_id', 32),
    membershipRevision: expectBytes(required(map, 2, 'transaction.membership_revision'), 'transaction.membership_revision', 32),
    validationPolicy: expectBytes(required(map, 3, 'transaction.validation_policy'), 'transaction.validation_policy', 32),
    authorId: expectBytes(required(map, 4, 'transaction.author_id'), 'transaction.author_id', 32),
    authorTimestampMs, nonce,
    executionManifestDigest: expectBytes(required(map, 7, 'transaction.execution_manifest_digest'), 'transaction.execution_manifest_digest', 32),
    schemaDigest: expectBytes(required(map, 8, 'transaction.schema_digest'), 'transaction.schema_digest', 32),
    program,
    ...(metadata === undefined ? {} : { metadata: metadataFromCbor(metadata) }),
  }
}

export async function transactionDigest(value: TransactionCore | Uint8Array): Promise<Uint8Array> { return hashCanonicalDomain('transaction', value instanceof Uint8Array ? value : encodeTransactionCore(value)) }
export async function payloadDigest(bytes: Uint8Array): Promise<Uint8Array> { return hashDomain(DOMAINS.envelope, bytes) }
export async function payloadChunkDigest(bytes: Uint8Array): Promise<Uint8Array> { return hashDomain(DOMAINS.payloadChunk, bytes) }

export async function createPayloadManifest(chunks: readonly Uint8Array[]): Promise<PayloadManifest> {
  protocolInvariant(chunks.length > 0, 'SCHEMA_INVALID', 'Payload manifest requires at least one chunk')
  const total = concatBytes(...chunks)
  return { totalDigest: await payloadDigest(total), totalSize: BigInt(total.length), chunks: await Promise.all(chunks.map(async (chunk) => ({ digest: await payloadChunkDigest(chunk), size: BigInt(chunk.length) }))) }
}

export async function verifyPayloadManifest(manifest: PayloadManifest, chunks: readonly Uint8Array[]): Promise<Uint8Array> {
  protocolInvariant(chunks.length === manifest.chunks.length, 'DIGEST_MISMATCH', 'Payload chunk count differs from manifest')
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index]!, expected = manifest.chunks[index]!
    protocolInvariant(BigInt(chunk.length) === expected.size, 'DIGEST_MISMATCH', 'Payload chunk size differs from manifest', { index })
    protocolInvariant(equalBytes(await payloadChunkDigest(chunk), expected.digest), 'DIGEST_MISMATCH', 'Payload chunk digest differs from manifest', { index })
  }
  const payload = concatBytes(...chunks)
  protocolInvariant(BigInt(payload.length) === manifest.totalSize, 'DIGEST_MISMATCH', 'Payload total size differs from manifest')
  protocolInvariant(equalBytes(await payloadDigest(payload), manifest.totalDigest), 'DIGEST_MISMATCH', 'Payload total digest differs from manifest')
  return payload
}

export async function resolveEnvelopePayload(envelope: ChronologEnvelope, chunks: readonly Uint8Array[] = []): Promise<Uint8Array> {
  const payload = envelope.payload.type === 'inline' ? envelope.payload.bytes : await verifyPayloadManifest(envelope.payload.manifest, chunks)
  protocolInvariant(equalBytes(await payloadDigest(payload), envelope.payloadDigest), 'DIGEST_MISMATCH', 'Envelope payload digest does not match resolved bytes')
  return payload
}

function chunkToCbor(chunk: PayloadChunk): CborValue { return integerMap([[0, chunk.digest], [1, chunk.size]]) }
function manifestToCbor(manifest: PayloadManifest): CborValue { protocolInvariant(manifest.chunks.length > 0, 'SCHEMA_INVALID', 'Payload manifest must contain at least one chunk'); return integerMap([[0, manifest.totalDigest], [1, manifest.totalSize], [2, manifest.chunks.map(chunkToCbor)]]) }
function manifestFromCbor(value: CborValue): PayloadManifest {
  const map = expectMap(value, 'payload_manifest'); assertKnownIntegerKeys(map, [0, 1, 2], 'payload_manifest')
  const chunks = expectArray(required(map, 2, 'payload_manifest.chunks'), 'payload_manifest.chunks').map((item, index) => { const chunk = expectMap(item, `payload_manifest.chunks[${index}]`); assertKnownIntegerKeys(chunk, [0, 1], `payload_manifest.chunks[${index}]`); return { digest: expectBytes(required(chunk, 0, 'chunk.digest'), 'chunk.digest', 32), size: expectUint64(required(chunk, 1, 'chunk.size'), 'chunk.size') } })
  protocolInvariant(chunks.length > 0, 'SCHEMA_INVALID', 'Payload manifest must contain at least one chunk')
  const totalSize = expectUint64(required(map, 1, 'payload_manifest.total_size'), 'payload_manifest.total_size')
  protocolInvariant(chunks.reduce((sum, chunk) => sum + chunk.size, 0n) === totalSize, 'SCHEMA_INVALID', 'Payload chunk sizes do not equal total size')
  return { totalDigest: expectBytes(required(map, 0, 'payload_manifest.total_digest'), 'payload_manifest.total_digest', 32), totalSize, chunks }
}

const MESSAGE_TYPES: readonly EnvelopeMessageType[] = ['candidate', 'attestation', 'heartbeat', 'capability', 'recovery', 'epoch-manifest', 'proof-bundle', 'snapshot']
export function encodeEnvelope(value: ChronologEnvelope): Uint8Array {
  const messageIndex = MESSAGE_TYPES.indexOf(value.messageType); protocolInvariant(messageIndex >= 0, 'SCHEMA_INVALID', 'Unknown envelope message type')
  const payload = value.payload.type === 'inline' ? [0n, value.payload.bytes] as const : [1n, manifestToCbor(value.payload.manifest)] as const
  return encodeCanonicalCbor(integerMap([[0, 1n], [1, value.groupRoute], [2, BigInt(messageIndex)], [3, value.encryptionEpoch], [4, value.payloadDigest], [5, payload]]))
}
export function decodeEnvelope(bytes: Uint8Array): ChronologEnvelope {
  const map = expectMap(assertCanonicalCbor(bytes), 'envelope'); assertKnownIntegerKeys(map, [0, 1, 2, 3, 4, 5], 'envelope'); expectVersion(map, 1n, 'envelope')
  const typeIndex = expectUint64(required(map, 2, 'envelope.message_type'), 'envelope.message_type'); protocolInvariant(typeIndex < BigInt(MESSAGE_TYPES.length), 'SCHEMA_INVALID', 'Unknown envelope message type')
  const messageType = MESSAGE_TYPES[Number(typeIndex)]; protocolInvariant(messageType !== undefined, 'SCHEMA_INVALID', 'Unknown envelope message type')
  const epoch = required(map, 3, 'envelope.encryption_epoch'); protocolInvariant(epoch === null || epoch instanceof Uint8Array, 'SCHEMA_INVALID', 'Envelope encryption epoch must be null or bytes')
  const encodedPayload = expectArray(required(map, 5, 'envelope.payload'), 'envelope.payload'); protocolInvariant(encodedPayload.length === 2, 'SCHEMA_INVALID', 'Envelope payload has invalid arity')
  const payloadType = expectUint64(encodedPayload[0] ?? null, 'envelope.payload.type')
  const payload = payloadType === 0n ? { type: 'inline' as const, bytes: expectBytes(encodedPayload[1] ?? null, 'envelope.payload.bytes') } : payloadType === 1n ? { type: 'manifest' as const, manifest: manifestFromCbor(encodedPayload[1] ?? null) } : (() => { throw new ProtocolError('SCHEMA_INVALID', 'Unknown envelope payload type') })()
  return { groupRoute: expectBytes(required(map, 1, 'envelope.group_route'), 'envelope.group_route'), messageType, encryptionEpoch: epoch, payloadDigest: expectBytes(required(map, 4, 'envelope.payload_digest'), 'envelope.payload_digest', 32), payload }
}

function attestationToCbor(value: ValidatorAttestation): CborValue {
  protocolInvariant(value.decision === 'admit', 'SCHEMA_INVALID', 'Only positive validator attestations are protocol events')
  protocolInvariant(value.authorTimestampMs > value.acceptedAboveMs, 'SCHEMA_INVALID', 'Attestation timestamp must exceed validator cutoff')
  return integerMap([[0, 1n], [1, value.groupId], [2, value.membershipRevision], [3, value.validatorCapability], [4, value.txId], [5, value.validatorId], [6, value.authorTimestampMs], [7, value.acceptedAboveMs], [8, value.candidateDigest], [9, 1n], [10, value.policyVersion]])
}
export function encodeValidatorAttestation(value: ValidatorAttestation): Uint8Array { return encodeCanonicalCbor(attestationToCbor(value)) }
export function decodeValidatorAttestation(bytes: Uint8Array): ValidatorAttestation {
  const map = expectMap(assertCanonicalCbor(bytes), 'attestation'); assertKnownIntegerKeys(map, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 'attestation'); expectVersion(map, 1n, 'attestation')
  protocolInvariant(expectUint64(required(map, 9, 'attestation.decision'), 'attestation.decision') === 1n, 'SCHEMA_INVALID', 'Only admit attestations are supported')
  const authorTimestampMs = expectUint64(required(map, 6, 'attestation.author_timestamp_ms'), 'attestation.author_timestamp_ms'), acceptedAboveMs = expectUint64(required(map, 7, 'attestation.accepted_above_ms'), 'attestation.accepted_above_ms')
  protocolInvariant(authorTimestampMs > acceptedAboveMs, 'SCHEMA_INVALID', 'Attestation timestamp must exceed validator cutoff')
  return { groupId: expectBytes(required(map, 1, 'attestation.group_id'), 'attestation.group_id'), membershipRevision: expectBytes(required(map, 2, 'attestation.membership_revision'), 'attestation.membership_revision'), validatorCapability: expectBytes(required(map, 3, 'attestation.validator_capability'), 'attestation.validator_capability'), txId: expectBytes(required(map, 4, 'attestation.tx_id'), 'attestation.tx_id'), validatorId: expectBytes(required(map, 5, 'attestation.validator_id'), 'attestation.validator_id'), authorTimestampMs, acceptedAboveMs, candidateDigest: expectBytes(required(map, 8, 'attestation.candidate_digest'), 'attestation.candidate_digest', 32), decision: 'admit', policyVersion: expectUint64(required(map, 10, 'attestation.policy_version'), 'attestation.policy_version') }
}

function heartbeatToCbor(value: ValidatorHeartbeat): CborValue { return integerMap([[0, 1n], [1, value.groupId], [2, value.membershipRevision], [3, value.validatorCapability], [4, value.validatorId], [5, value.acceptanceCutoffMs]]) }
export function encodeValidatorHeartbeat(value: ValidatorHeartbeat): Uint8Array { return encodeCanonicalCbor(heartbeatToCbor(value)) }
export function decodeValidatorHeartbeat(bytes: Uint8Array): ValidatorHeartbeat {
  const map = expectMap(assertCanonicalCbor(bytes), 'heartbeat'); assertKnownIntegerKeys(map, [0, 1, 2, 3, 4, 5], 'heartbeat'); expectVersion(map, 1n, 'heartbeat')
  return { groupId: expectBytes(required(map, 1, 'heartbeat.group_id'), 'heartbeat.group_id'), membershipRevision: expectBytes(required(map, 2, 'heartbeat.membership_revision'), 'heartbeat.membership_revision'), validatorCapability: expectBytes(required(map, 3, 'heartbeat.validator_capability'), 'heartbeat.validator_capability'), validatorId: expectBytes(required(map, 4, 'heartbeat.validator_id'), 'heartbeat.validator_id'), acceptanceCutoffMs: expectUint64(required(map, 5, 'heartbeat.acceptance_cutoff_ms'), 'heartbeat.acceptance_cutoff_ms') }
}

export function transactionOrderKey(core: Pick<TransactionCore, 'authorTimestampMs' | 'authorId'>, transport: CandidateTransportIdentity): TransactionOrderKey { protocolInvariant(transport.authorFeedSequence >= 0n, 'INTEGER_OUT_OF_RANGE', 'Author feed sequence cannot be negative'); return { authorTimestampMs: core.authorTimestampMs, authorId: core.authorId, ...transport } }
export function compareTransactionOrder(left: TransactionOrderKey, right: TransactionOrderKey): number { if (left.authorTimestampMs !== right.authorTimestampMs) return left.authorTimestampMs < right.authorTimestampMs ? -1 : 1; const authorOrder = compareBytes(left.authorId, right.authorId); if (authorOrder !== 0) return authorOrder; if (left.authorFeedSequence !== right.authorFeedSequence) return left.authorFeedSequence < right.authorFeedSequence ? -1 : 1; return compareBytes(left.txId, right.txId) }
export function assertUniqueOrderKeys(keys: readonly TransactionOrderKey[]): void { const sorted = [...keys].sort(compareTransactionOrder); for (let index = 1; index < sorted.length; index += 1) if (compareTransactionOrder(sorted[index - 1]!, sorted[index]!) === 0) throw new ProtocolError('DUPLICATE_TRANSACTION', 'Duplicate transaction order key') }
