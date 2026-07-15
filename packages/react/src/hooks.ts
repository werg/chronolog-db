import { useCallback, useEffect, useState, useSyncExternalStore, type DependencyList } from 'react'
import {
  ChronologRpcError,
  ClientManifestMismatchError,
  type ChronologClient,
  type LocalSqlInput,
  type LiveQueryValue,
  type NodeStatus,
  type QueryOptions,
  type ReplicationStatus,
  type SettlementEvidence,
  type StreamResource,
  type StreamSnapshot,
  type TransactionDraft,
  type TransactionHandle,
  type TransactionOptions,
  type TransactionOutcome,
} from '@chronolog/client'

import { useChronologClient } from './context.js'

const idleSnapshot = { status: 'idle', reconnectAttempt: 0 } as const
const noSubscribe = (): (() => void) => () => undefined

export function useStreamResource<T>(resource: StreamResource<T>): StreamSnapshot<T> {
  return useSyncExternalStore(resource.subscribe, resource.getSnapshot, resource.getSnapshot)
}

function useOptionalResource<T>(resource: StreamResource<T> | undefined): StreamSnapshot<T> {
  return useSyncExternalStore(
    resource?.subscribe ?? noSubscribe,
    resource?.getSnapshot ?? (() => idleSnapshot),
    resource?.getSnapshot ?? (() => idleSnapshot),
  )
}

function useOwnedResource<T>(factory: () => StreamResource<T> | undefined, dependencies: DependencyList): StreamResource<T> | undefined {
  const [owned, setOwned] = useState<{
    readonly dependencies: readonly unknown[]
    readonly resource?: StreamResource<T>
  }>()
  const resource = owned !== undefined && sameDependencies(owned.dependencies, dependencies)
    ? owned.resource
    : undefined
  useEffect(() => {
    // Resource factories register with ChronologClient, so create them only in
    // the committed effect. React may discard render-time memo calculations in
    // Strict Mode, which would otherwise leave an unreachable tracked resource.
    const next = factory()
    setOwned({ dependencies: [...dependencies], ...(next === undefined ? {} : { resource: next }) })
    return () => next?.dispose()
    // The caller supplies the canonical semantic identity of the factory.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, dependencies)
  return resource
}

function sameDependencies(previous: readonly unknown[], current: DependencyList): boolean {
  return previous.length === current.length && previous.every((value, index) => Object.is(value, current[index]))
}

export type ChronologQueryState =
  | { readonly status: 'loading'; readonly previous?: LiveQueryValue }
  | { readonly status: 'value'; readonly value: LiveQueryValue }
  | { readonly status: 'reset'; readonly value: LiveQueryValue; readonly reason: string }
  | { readonly status: 'transport_error'; readonly error: unknown; readonly previous?: LiveQueryValue; readonly retrying: boolean }
  | { readonly status: 'query_error'; readonly error: unknown; readonly previous?: LiveQueryValue }
  | { readonly status: 'manifest_mismatch'; readonly error: ClientManifestMismatchError; readonly previous?: LiveQueryValue }
  | { readonly status: 'disabled' }

export interface UseChronologQueryOptions extends Omit<QueryOptions, 'atRevision' | 'signal'> {
  readonly client?: ChronologClient
  readonly enabled?: boolean
}

export function useChronologQuery(
  sql: string,
  parameters: readonly LocalSqlInput[] = [],
  options: UseChronologQueryOptions = {},
): ChronologQueryState {
  const client = useChronologClient(options.client)
  const identity = client.queryResourceKey(sql, parameters)
  const resource = useOwnedResource(
    () => options.enabled === false
      ? undefined
      : client.liveQuery(sql, parameters, {
          ...(options.maxRows === undefined ? {} : { maxRows: options.maxRows }),
        }),
    // Canonical query/parameter identity deliberately replaces JavaScript object identity.
    [client, identity, options.maxRows, options.enabled],
  )
  const snapshot = useOptionalResource(resource)
  if (options.enabled === false) return { status: 'disabled' }
  if (snapshot.status === 'ready' && snapshot.value !== undefined) {
    return snapshot.value.type === 'reset'
      ? { status: 'reset', value: snapshot.value, reason: snapshot.value.resetReason ?? 'subscription_rebuilt' }
      : { status: 'value', value: snapshot.value }
  }
  if (snapshot.status === 'error') {
    if (snapshot.error instanceof ClientManifestMismatchError) {
      return {
        status: 'manifest_mismatch',
        error: snapshot.error,
        ...(snapshot.value === undefined ? {} : { previous: snapshot.value }),
      }
    }
    if (isTransportError(snapshot.error)) {
      return {
        status: 'transport_error',
        error: snapshot.error,
        retrying: false,
        ...(snapshot.value === undefined ? {} : { previous: snapshot.value }),
      }
    }
    return {
      status: 'query_error',
      error: snapshot.error,
      ...(snapshot.value === undefined ? {} : { previous: snapshot.value }),
    }
  }
  if (snapshot.status === 'disconnected') {
    return {
      status: 'transport_error',
      error: snapshot.error ?? new ChronologRpcError('transport_unavailable', 'Query stream disconnected'),
      retrying: true,
      ...(snapshot.value === undefined ? {} : { previous: snapshot.value }),
    }
  }
  return { status: 'loading', ...(snapshot.value === undefined ? {} : { previous: snapshot.value }) }
}

export interface UseResourceOptions {
  readonly client?: ChronologClient
  readonly enabled?: boolean
}

export function useChronologTransactionOutcome(
  transactionId: string | undefined,
  options: UseResourceOptions = {},
): StreamSnapshot<TransactionOutcome> {
  const client = useChronologClient(options.client)
  const resource = useOwnedResource(
    () => transactionId === undefined || options.enabled === false
      ? undefined
      : client.transactionOutcome(transactionId),
    [client, transactionId, options.enabled],
  )
  return useOptionalResource(resource)
}

export function useChronologSettlement(
  transactionId: string | undefined,
  options: UseResourceOptions = {},
): StreamSnapshot<SettlementEvidence> {
  const client = useChronologClient(options.client)
  const resource = useOwnedResource(
    () => transactionId === undefined || options.enabled === false
      ? undefined
      : client.settlementEvidence(transactionId),
    [client, transactionId, options.enabled],
  )
  return useOptionalResource(resource)
}

export function useChronologReplication(options: UseResourceOptions = {}): StreamSnapshot<ReplicationStatus> {
  const client = useChronologClient(options.client)
  const resource = useOwnedResource(
    () => options.enabled === false ? undefined : client.replicationStatus(),
    [client, options.enabled],
  )
  return useOptionalResource(resource)
}

export function useChronologStatus(options: UseResourceOptions = {}): StreamSnapshot<NodeStatus> {
  const client = useChronologClient(options.client)
  const resource = useOwnedResource(
    () => options.enabled === false ? undefined : client.status(),
    [client, options.enabled],
  )
  return useOptionalResource(resource)
}

export type TransactionMutationState =
  | { readonly status: 'idle' }
  | { readonly status: 'publishing' }
  | { readonly status: 'published'; readonly handle: TransactionHandle }
  | { readonly status: 'error'; readonly error: unknown }

export interface TransactionMutation {
  readonly state: TransactionMutationState
  readonly run: (
    build: (draft: TransactionDraft) => void | Promise<void>,
    options?: TransactionOptions,
  ) => Promise<TransactionHandle>
  readonly reset: () => void
}

export function useChronologTransaction(clientOverride?: ChronologClient): TransactionMutation {
  const client = useChronologClient(clientOverride)
  const [state, setState] = useState<TransactionMutationState>({ status: 'idle' })
  const run = useCallback(async (
    build: (draft: TransactionDraft) => void | Promise<void>,
    options: TransactionOptions = {},
  ) => {
    setState({ status: 'publishing' })
    try {
      const handle = await client.transaction(build, options)
      setState({ status: 'published', handle })
      return handle
    } catch (error) {
      setState({ status: 'error', error })
      throw error
    }
  }, [client])
  const reset = useCallback(() => setState({ status: 'idle' }), [])
  return { state, run, reset }
}

function isTransportError(error: unknown): boolean {
  return error instanceof ChronologRpcError && (
    error.code === 'transport_unavailable' ||
    error.code === 'deadline_exceeded' ||
    error.code === 'cancelled'
  )
}
