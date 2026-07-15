import { sha256 } from '@chronolog/canonical'

import {
  decodeDifferentialFixture,
  decodeDifferentialObservation,
  encodeDifferentialFixture,
  encodeDifferentialObservation,
  sameBytes,
} from './codec.js'
import { resolveMaterializationInvocation } from './runner.js'
import type {
  DifferentialMaterializationFixture,
  DifferentialMaterializerBackend,
  DifferentialObservation,
  DifferentialObservationProjector,
  ExactObjectReader,
  ExactObjectRef,
  ExactObjectVerifier,
  ChronologMaterializerKernel,
} from './types.js'

export class DifferentialMismatchError extends Error {
  constructor(
    readonly fixtureName: string,
    readonly baseline: string,
    readonly candidate: string,
  ) {
    super(`DIFFERENTIAL_MISMATCH:${fixtureName}:${baseline}:${candidate}`)
    this.name = 'DifferentialMismatchError'
  }
}

export async function runDifferentialFixture(
  fixture: DifferentialMaterializationFixture,
  backends: readonly DifferentialMaterializerBackend[],
): Promise<ReadonlyMap<string, DifferentialObservation>> {
  if (backends.length === 0) throw new Error('DIFFERENTIAL_BACKEND_REQUIRED')
  const fixtureBytes = encodeDifferentialFixture(fixture)
  const results = new Map<string, DifferentialObservation>()
  let baselineBytes: Uint8Array | null = null
  let baselineName = ''
  for (const backend of backends) {
    if (results.has(backend.name)) throw new Error(`DIFFERENTIAL_BACKEND_DUPLICATE:${backend.name}`)
    const resolved = await backend.run(fixtureBytes)
    const observation = decodeDifferentialObservation(resolved)
    const canonical = encodeDifferentialObservation(observation)
    if (!sameBytes(canonical, resolved)) throw new Error(`DIFFERENTIAL_BACKEND_NON_CANONICAL:${backend.name}`)
    if (baselineBytes === null) {
      baselineBytes = canonical
      baselineName = backend.name
    } else if (!sameBytes(baselineBytes, canonical)) {
      throw new DifferentialMismatchError(fixture.name, baselineName, backend.name)
    }
    results.set(backend.name, observation)
  }
  return results
}

export function createInProcessDifferentialBackend(
  name: string,
  kernel: ChronologMaterializerKernel,
  project: DifferentialObservationProjector,
  verifier?: ExactObjectVerifier,
): DifferentialMaterializerBackend {
  return {
    name,
    async run(fixtureBytes): Promise<Uint8Array> {
      const fixture = decodeDifferentialFixture(fixtureBytes)
      const reader = createFixtureObjectReader(fixture, verifier)
      const resolved = await resolveMaterializationInvocation(fixture.invocation, reader)
      return encodeDifferentialObservation(await project(await kernel.materialize(resolved), resolved))
    },
  }
}

export function createFixtureObjectReader(
  fixture: DifferentialMaterializationFixture,
  verifier?: ExactObjectVerifier,
): ExactObjectReader {
  const objects = new Map(fixture.objects.map((object) => [identity(object.ref), object] as const))
  return {
    async readExact(ref): Promise<Uint8Array> {
      const object = objects.get(identity(ref))
      if (object === undefined) throw new Error('DIFFERENTIAL_EXACT_OBJECT_MISSING')
      if (!sameRef(ref, object.ref)) throw new Error('DIFFERENTIAL_EXACT_OBJECT_REF_MISMATCH')
      const valid = verifier === undefined
        ? await verifyBuiltIn(ref, object.bytes)
        : await verifier(ref, object.bytes)
      if (!valid) throw new Error('DIFFERENTIAL_EXACT_OBJECT_DIGEST_MISMATCH')
      return object.bytes.slice()
    },
  }
}

async function verifyBuiltIn(ref: ExactObjectRef, bytes: Uint8Array): Promise<boolean> {
  if (ref.contentId.algorithm !== 'sha2-256') {
    throw new Error(`DIFFERENTIAL_OBJECT_VERIFIER_REQUIRED:${ref.contentId.algorithm}`)
  }
  return sameBytes(await sha256(bytes), ref.contentId.digest)
}

function sameRef(left: ExactObjectRef, right: ExactObjectRef): boolean {
  return sameBytes(left.storeId, right.storeId) &&
    left.codec.number === right.codec.number &&
    left.codec.version === right.codec.version &&
    left.contentId.algorithm === right.contentId.algorithm &&
    sameBytes(left.contentId.digest, right.contentId.digest)
}

function identity(ref: ExactObjectRef): string {
  return `${text(ref.storeId)}:${ref.codec.number}:${ref.codec.version}:${ref.contentId.algorithm}:${text(ref.contentId.digest)}`
}

function text(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}
