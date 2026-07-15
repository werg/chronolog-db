import {
  publicationRequestForRevision,
  type AdmittedTransaction,
  type ChronologMaterializationRuntime,
  type MaterializationPublicationRequest,
  type MaterializationPublicationResult,
  type MaterializedRevisionSnapshot,
} from '@chronolog/materializer'

import type {
  LocalSqlOptions,
  LocalSqlQueryResult,
  LocalSqlValue,
  MaterializedSqlQueryResult,
  MaterializedRevision,
  ObserveSqlOptions,
  SqlDiagnostic,
  TransactionOutcome,
} from './types.js'
import type { SqlStatement, TransactionResultEnvelopeV1 } from '@chronolog/protocol'

export interface DoltLiteMaterializerRuntimeBackend {
  readonly revision: bigint
  readonly orderLength: number
  readonly executionManifestDigest: Uint8Array
  materialize(orderedTransactions: readonly AdmittedTransaction[]): Promise<MaterializedRevision | null>
  observe(statement: SqlStatement, options: ObserveSqlOptions): Promise<MaterializedSqlQueryResult>
  localSql(
    sql: string,
    parameters?: readonly LocalSqlValue[],
    options?: LocalSqlOptions,
  ): LocalSqlQueryResult
  validateStatement(statement: SqlStatement, mode: 'precondition' | 'body'): readonly SqlDiagnostic[]
  outcome(txId: Uint8Array): TransactionOutcome | null
  transactionResult(txId: Uint8Array): TransactionResultEnvelopeV1 | null
  subscribe(subscriber: (revision: MaterializedRevision) => void): () => void
  close(): void
}

/**
 * Adapts the branch-backed DoltLite materializer to the portable runtime seams.
 * DoltLite has already moved its local head when materialize() returns, so
 * publish() validates and memoizes that exact movement as already-current.
 */
export function createDoltLiteMaterializationRuntime(
  materializer: DoltLiteMaterializerRuntimeBackend,
): ChronologMaterializationRuntime {
  const prepared = new Map<string, MaterializationPublicationRequest>()
  const publications = new Map<string, {
    readonly request: MaterializationPublicationRequest
    readonly result: MaterializationPublicationResult
  }>()
  const snapshot = (): MaterializedRevisionSnapshot => ({
    revision: materializer.revision,
    orderLength: materializer.orderLength,
    executionManifestDigest: materializer.executionManifestDigest.slice(),
  })
  const result = (
    status: MaterializationPublicationResult['status'],
    publicationKey: string | null,
  ): MaterializationPublicationResult => ({ status, publicationKey, ...snapshot() })

  return {
    coordinator: {
      async materialize(orderedTransactions) {
        const revision = await materializer.materialize(orderedTransactions)
        if (revision === null) return null
        const publication = publicationRequestForRevision(revision)
        prepared.set(publication.publicationKey, publication)
        return { revision, publication }
      },
    },
    queries: {
      get revision() { return materializer.revision },
      get orderLength() { return materializer.orderLength },
      get executionManifestDigest() { return materializer.executionManifestDigest },
      observe(statement, options) { return materializer.observe(statement, options) },
      localSql(sql, parameters, options) { return materializer.localSql(sql, parameters, options) },
      validateStatement(statement, mode) { return materializer.validateStatement(statement, mode) },
      outcome(txId) { return materializer.outcome(txId) },
      transactionResult(txId) { return materializer.transactionResult(txId) },
      subscribe(subscriber) {
        return materializer.subscribe((revision) => subscriber({
          revision: revision.revision,
          orderLength: revision.orderLength,
          executionManifestDigest: revision.manifestDigest.slice(),
        }))
      },
    },
    publications: {
      async publish(request): Promise<MaterializationPublicationResult> {
        const previous = publications.get(request.publicationKey)
        if (previous !== undefined) {
          if (!sameRequest(previous.request, request)) {
            throw new Error('MATERIALIZATION_PUBLICATION_KEY_REUSED')
          }
          return copyResult(previous.result)
        }
        const candidate = prepared.get(request.publicationKey)
        if (candidate === undefined || !sameRequest(candidate, request)) {
          throw new Error('MATERIALIZATION_PUBLICATION_NOT_PREPARED')
        }
        if (
          materializer.revision !== request.targetRevision ||
          materializer.orderLength !== request.targetOrderLength
        ) {
          throw new Error('MATERIALIZATION_PUBLICATION_NOT_CURRENT')
        }
        const completed = result('already_current', request.publicationKey)
        publications.set(request.publicationKey, { request: { ...request }, result: completed })
        prepared.delete(request.publicationKey)
        return copyResult(completed)
      },
      async reconcile(expectation): Promise<MaterializationPublicationResult> {
        if (
          materializer.orderLength !== expectation.targetOrderLength ||
          (expectation.targetRevision !== undefined &&
            materializer.revision !== expectation.targetRevision)
        ) {
          throw new Error('MATERIALIZATION_RECONCILIATION_MISMATCH')
        }
        return result('reconciled', null)
      },
    },
    close() { materializer.close() },
  }
}

function copyResult(value: MaterializationPublicationResult): MaterializationPublicationResult {
  return {
    status: value.status,
    publicationKey: value.publicationKey,
    revision: value.revision,
    orderLength: value.orderLength,
    executionManifestDigest: value.executionManifestDigest.slice(),
  }
}

function sameRequest(
  left: MaterializationPublicationRequest,
  right: MaterializationPublicationRequest,
): boolean {
  return left.publicationKey === right.publicationKey &&
    left.expectedRevision === right.expectedRevision &&
    left.targetRevision === right.targetRevision &&
    left.targetOrderLength === right.targetOrderLength &&
    left.candidateIdentity === right.candidateIdentity
}
