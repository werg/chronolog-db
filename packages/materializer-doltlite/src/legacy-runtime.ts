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
  MaterializedIrQueryResult,
  MaterializedRevision,
  QueryIrOptions,
  TransactionOutcome,
} from './types.js'
import type { IrDiagnostic, Mutation, Query } from '@chronolog/ir'

export interface DoltLiteLegacyMaterializer {
  readonly revision: bigint
  readonly orderLength: number
  readonly schemaDigest: Uint8Array
  readonly executionManifestDigest: Uint8Array
  materialize(orderedTransactions: readonly AdmittedTransaction[]): Promise<MaterializedRevision | null>
  queryIr(query: Query, options?: QueryIrOptions): Promise<MaterializedIrQueryResult>
  localSql(
    sql: string,
    parameters?: readonly LocalSqlValue[],
    options?: LocalSqlOptions,
  ): LocalSqlQueryResult
  validateQuery(query: Query): readonly IrDiagnostic[]
  validateMutation(mutation: Mutation): readonly IrDiagnostic[]
  outcome(txId: Uint8Array): TransactionOutcome | null
  subscribe(subscriber: (revision: MaterializedRevision) => void): () => void
  close(): void
}

/**
 * Preserves the current branch-backed behavior behind the portable seams.
 * DoltLite has already moved its local head when materialize() returns, so
 * publish() validates and memoizes that exact movement as already-current.
 */
export function createDoltLiteLegacyMaterializationRuntime(
  materializer: DoltLiteLegacyMaterializer,
): ChronologMaterializationRuntime {
  const prepared = new Map<string, MaterializationPublicationRequest>()
  const publications = new Map<string, {
    readonly request: MaterializationPublicationRequest
    readonly result: MaterializationPublicationResult
  }>()
  const snapshot = (): MaterializedRevisionSnapshot => ({
    revision: materializer.revision,
    orderLength: materializer.orderLength,
    schemaDigest: materializer.schemaDigest.slice(),
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
      get schemaDigest() { return materializer.schemaDigest },
      get executionManifestDigest() { return materializer.executionManifestDigest },
      queryIr(query, options) { return materializer.queryIr(query, options) },
      localSql(sql, parameters, options) { return materializer.localSql(sql, parameters, options) },
      validateQuery(query) { return materializer.validateQuery(query) },
      validateMutation(mutation) { return materializer.validateMutation(mutation) },
      outcome(txId) { return materializer.outcome(txId) },
      subscribe(subscriber) {
        return materializer.subscribe((revision) => subscriber({
          revision: revision.revision,
          orderLength: revision.orderLength,
          schemaDigest: revision.schemaDigest.slice(),
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
          throw new Error('MATERIALIZATION_LEGACY_PUBLICATION_NOT_CURRENT')
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
          throw new Error('MATERIALIZATION_LEGACY_RECONCILIATION_MISMATCH')
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
    schemaDigest: value.schemaDigest.slice(),
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
