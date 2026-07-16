import {
  exactDatabaseRefToCbor,
  sameBytes,
  type ExactDatabaseRef,
} from '@chronolog/materializer'
import { encodeCanonicalCbor } from '@chronolog/canonical'

import type {
  ChronologWorkerdPublicationIntent,
  ChronologWorkerdPublicationResult,
} from './host-client.js'

export interface ChronologCasRefState {
  readonly generation: bigint | null
  readonly current: ExactDatabaseRef | null
}

export interface ChronologCasPublicationBackend {
  /** Verifies that every object reachable by the selected immutable output is durable. */
  verifyExactOutput(request: ChronologWorkerdPublicationIntent): Promise<void>
  readRef(refName: string): Promise<ChronologCasRefState>
  compareAndSwapRef(request: {
    readonly refName: string
    readonly expectedGeneration: bigint | null
    readonly expectedCurrent: ExactDatabaseRef | null
    readonly selected: ExactDatabaseRef
    readonly executionKey: Uint8Array
  }): Promise<{ readonly applied: boolean; readonly state: ChronologCasRefState }>
}

/**
 * Crash-safe immutable-output publication. Reachability is verified before a
 * mutable ref can move, and an ambiguous CAS is reconciled by exact ref read.
 */
export async function publishChronologCasIntent(
  backend: ChronologCasPublicationBackend,
  request: ChronologWorkerdPublicationIntent,
): Promise<ChronologWorkerdPublicationResult> {
  await backend.verifyExactOutput(request)
  const before = await backend.readRef(request.refName)
  const selected = request.selectedOutput.ref
  if (sameDatabase(before.current, selected)) return publicationResult('already_current', before)
  if (!sameDatabase(before.current, request.expectedCurrent)) return publicationResult('conflict', before)

  try {
    const exchanged = await backend.compareAndSwapRef({
      refName: request.refName,
      expectedGeneration: before.generation,
      expectedCurrent: request.expectedCurrent,
      selected,
      executionKey: request.executionKey,
    })
    if (exchanged.applied) {
      if (!sameDatabase(exchanged.state.current, selected)) {
        throw new Error('CHRONOLOG_CAS_APPLIED_REF_MISMATCH')
      }
      return publicationResult('published', exchanged.state)
    }
    return publicationResult(
      sameDatabase(exchanged.state.current, selected) ? 'already_current' : 'conflict',
      exchanged.state,
    )
  } catch (error) {
    const reconciled = await backend.readRef(request.refName)
    if (sameDatabase(reconciled.current, selected)) {
      return publicationResult('already_current', reconciled)
    }
    if (sameDatabase(reconciled.current, request.expectedCurrent)) throw error
    return publicationResult('conflict', reconciled)
  }
}

function publicationResult(
  status: ChronologWorkerdPublicationResult['status'],
  state: ChronologCasRefState,
): ChronologWorkerdPublicationResult {
  return {
    status,
    generation: state.generation,
    current: state.current === null ? null : cloneDatabase(state.current),
  }
}

function sameDatabase(left: ExactDatabaseRef | null, right: ExactDatabaseRef | null): boolean {
  if (left === null || right === null) return left === right
  return sameBytes(
    encodeCanonicalCbor(exactDatabaseRefToCbor(left)),
    encodeCanonicalCbor(exactDatabaseRefToCbor(right)),
  )
}

function cloneDatabase(value: ExactDatabaseRef): ExactDatabaseRef {
  return structuredClone(value)
}
