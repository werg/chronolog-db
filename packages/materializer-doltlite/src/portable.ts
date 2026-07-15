import {
  MaterializerContractError,
  digestAdmittedOrder,
  sameBytes,
  type AdmittedTransaction as PortableAdmittedTransaction,
  type ChronologMaterializationInvocation,
  type ChronologMaterializationOutcome,
  type ChronologMaterializerKernel,
  type ExactObjectRef,
  type ResolvedMaterializationInvocation,
} from '@chronolog/materializer'
import { decodeTransactionCore } from '@chronolog/protocol'

import type {
  AdmittedTransaction,
  MaterializedRevision,
  MaterializerBackendInfo,
  TransactionLogRow,
} from './types.js'

export interface DoltLitePortableMaterializerLike {
  readonly revision: bigint
  readonly orderLength: number
  readonly schemaDigest: Uint8Array
  readonly executionManifestDigest: Uint8Array
  readonly backend: MaterializerBackendInfo
  transactionLog(): readonly TransactionLogRow[]
  materialize(orderedTransactions: readonly AdmittedTransaction[]): Promise<MaterializedRevision | null>
}

export interface DoltLitePortableProjectionContext {
  readonly invocation: ChronologMaterializationInvocation
  readonly revision: MaterializedRevision | null
  readonly transactionLog: readonly TransactionLogRow[]
  readonly exactReadSet: readonly ExactObjectRef[]
}

/**
 * Maps the local oracle's revision to generic immutable refs. Production Node
 * code will provide this through its CAS/export adapter; tests can provide a
 * deterministic in-memory projection. The DoltLite package never fabricates a
 * workerd StoreId or mutates a metadata ref.
 */
export type DoltLitePortableOutcomeProjector = (
  context: DoltLitePortableProjectionContext,
) => ChronologMaterializationOutcome | Promise<ChronologMaterializationOutcome>

/**
 * Adapts the current branch-backed Node materializer to the portable pure
 * kernel contract. This remains a differential oracle: workerd publication is
 * deliberately outside this adapter.
 */
export function createDoltLitePortableKernel(
  materializer: DoltLitePortableMaterializerLike,
  project: DoltLitePortableOutcomeProjector,
): ChronologMaterializerKernel {
  return {
    async materialize(input): Promise<ChronologMaterializationOutcome> {
      verifyEngineAndManifests(materializer, input)
      if (input.continuation !== null) {
        throw new MaterializerContractError('MATERIALIZER_ORACLE_CONTINUATION_UNSUPPORTED')
      }

      const priorLog = materializer.transactionLog()
      if (priorLog.length !== materializer.orderLength) {
        throw new MaterializerContractError('MATERIALIZER_ORACLE_LOG_LENGTH_MISMATCH')
      }
      if (!sameBytes(
        await digestAdmittedOrder(priorLog.map((row) => row.txId)),
        input.invocation.expectedPreviousOrderDigest,
      )) {
        throw new MaterializerContractError('MATERIALIZER_PREVIOUS_ORDER_DIGEST_MISMATCH')
      }
      if (input.invocation.replayFromIndex > priorLog.length) {
        throw new MaterializerContractError('MATERIALIZER_REPLAY_PREFIX_UNAVAILABLE')
      }

      const prefix = priorLog
        .slice(0, input.invocation.replayFromIndex)
        .map(transactionFromLogRow)
      const ordered = [...prefix, ...input.admittedSuffix.transactions.map(clonePortableTransaction)]
      if (ordered.length !== input.invocation.targetOrderLength) {
        throw new MaterializerContractError('MATERIALIZER_TARGET_ORDER_LENGTH_MISMATCH')
      }
      if (!sameBytes(
        await digestAdmittedOrder(ordered.map((transaction) => transaction.txId)),
        input.invocation.targetOrderDigest,
      )) {
        throw new MaterializerContractError('MATERIALIZER_TARGET_ORDER_DIGEST_MISMATCH')
      }

      const revision = await materializer.materialize(ordered)
      const transactionLog = materializer.transactionLog()
      if (transactionLog.length !== input.invocation.targetOrderLength) {
        throw new MaterializerContractError('MATERIALIZER_ORACLE_FINAL_LOG_LENGTH_MISMATCH')
      }
      if (!sameBytes(
        await digestAdmittedOrder(transactionLog.map((row) => row.txId)),
        input.invocation.targetOrderDigest,
      )) {
        throw new MaterializerContractError('MATERIALIZER_ORACLE_FINAL_ORDER_MISMATCH')
      }
      return project({
        invocation: structuredClone(input.invocation),
        revision: revision === null ? null : structuredClone(revision),
        transactionLog: transactionLog.map((row) => structuredClone(row)),
        exactReadSet: input.exactReadSet.map((ref) => structuredClone(ref)),
      })
    },
  }
}

function verifyEngineAndManifests(
  materializer: DoltLitePortableMaterializerLike,
  input: ResolvedMaterializationInvocation,
): void {
  if (!sameBytes(materializer.backend.engineDigest, input.invocation.expectedEngineDigest)) {
    throw new MaterializerContractError('MATERIALIZER_ORACLE_ENGINE_DIGEST_MISMATCH')
  }
  if (!sameBytes(materializer.schemaDigest, input.invocation.expectedSchemaDigest)) {
    throw new MaterializerContractError('MATERIALIZER_ORACLE_SCHEMA_DIGEST_MISMATCH')
  }
  if (!sameBytes(
    materializer.executionManifestDigest,
    input.invocation.expectedExecutionManifestDigest,
  )) {
    throw new MaterializerContractError('MATERIALIZER_ORACLE_EXECUTION_MANIFEST_DIGEST_MISMATCH')
  }
}

function transactionFromLogRow(row: TransactionLogRow): AdmittedTransaction {
  return {
    txId: row.txId.slice(),
    authorFeedSequence: row.authorFeedSequence,
    candidateDigest: row.candidateDigest.slice(),
    canonicalCandidate: row.canonicalCandidate.slice(),
    core: decodeTransactionCore(row.canonicalCandidate),
  }
}

function clonePortableTransaction(transaction: PortableAdmittedTransaction): AdmittedTransaction {
  return {
    txId: transaction.txId.slice(),
    authorFeedSequence: transaction.authorFeedSequence,
    candidateDigest: transaction.candidateDigest.slice(),
    canonicalCandidate: transaction.canonicalCandidate.slice(),
    core: structuredClone(transaction.core),
  }
}
