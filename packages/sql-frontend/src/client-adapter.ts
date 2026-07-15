import {
  defineMutation,
  defineQuery,
} from '@chronolog/client'
import type {
  DecodedCanonicalResult,
  Mutation as ClientMutation,
  MutationKind,
  Query as ClientQuery,
} from '@chronolog/client'
import { encodeMutation, encodeQuery } from '@chronolog/ir'
import type { Mutation, Query } from '@chronolog/ir'

export interface ClientQueryAdapterOptions<Row> {
  readonly decodeResult: (result: DecodedCanonicalResult) => Row
  readonly schemaDigest?: string
  readonly executionManifestDigest?: string
}

/** Wraps a lowered, already-bound query for `client.query()` or `draft.observe()`. */
export function defineLoweredQuery<Row>(
  query: Query,
  options: ClientQueryAdapterOptions<Row>,
): ClientQuery<Row> {
  return defineQuery({
    canonicalBytes: encodeQuery(query),
    resultMode: query.resultMode.kind,
    parameterNames: [],
    decodeResult: options.decodeResult,
    ...(options.schemaDigest === undefined ? {} : { schemaDigest: options.schemaDigest }),
    ...(options.executionManifestDigest === undefined
      ? {}
      : { executionManifestDigest: options.executionManifestDigest }),
  })
}

/** Wraps one lowered command for `draft.mutate()`; draft publication still requires a precondition. */
export function defineLoweredMutation(mutation: Mutation): ClientMutation {
  return defineMutation(clientMutationKind(mutation), encodeMutation(mutation), mutation.label)
}

function clientMutationKind(mutation: Mutation): MutationKind {
  return mutation.kind === 'stateful_call' ? 'registered_call' : mutation.kind
}
