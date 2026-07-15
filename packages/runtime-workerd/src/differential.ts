import {
  createFixtureObjectReader,
  decodeDifferentialFixture,
  decodeMaterializationInvocation,
  decodeMaterializationOutcome,
  encodeDifferentialObservation,
  resolveMaterializationInvocation,
  type DifferentialMaterializerBackend,
  type DifferentialMaterializationFixture,
  type DifferentialObservationProjector,
} from '@chronolog/materializer'

import { executeChronologMaterialization } from './coordinator.js'
import type {
  ChronologCompatibilityTuple,
  ChronologReducerCoordinatorClient,
} from './types.js'

export interface ChronologWorkerdDifferentialOptions {
  readonly compatibility: ChronologCompatibilityTuple
  readonly clientForFixture: (
    fixture: DifferentialMaterializationFixture,
  ) => ChronologReducerCoordinatorClient
  readonly project: DifferentialObservationProjector
}

/** Adapts the existing canonical differential fixture harness to workerd transport. */
export function createChronologWorkerdDifferentialBackend(
  name: string,
  options: ChronologWorkerdDifferentialOptions,
): DifferentialMaterializerBackend {
  return {
    name,
    async run(fixtureBytes): Promise<Uint8Array> {
      const fixture = decodeDifferentialFixture(fixtureBytes)
      const invocation = decodeMaterializationInvocation(fixture.invocation)
      const inputs = [
        ...(invocation.previous === null
          ? []
          : [{ name: 'previous' as const, ref: invocation.previous.database }]),
        { name: 'replayBase' as const, ref: invocation.replayBase.database },
      ]
      const response = await executeChronologMaterialization(options.clientForFixture(fixture), {
        invocation: fixture.invocation,
        inputs,
        compatibility: options.compatibility,
      })
      const outcome = decodeMaterializationOutcome(response.applicationResult)
      const resolved = await resolveMaterializationInvocation(
        fixture.invocation,
        createFixtureObjectReader(fixture),
      )
      return encodeDifferentialObservation(await options.project(outcome, resolved))
    },
  }
}
