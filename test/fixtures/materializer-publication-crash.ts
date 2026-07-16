import { createCoreExecutionManifest } from '@chronolog/compiler-sqlite'
import {
  DeterministicMaterializer,
  readNativeEngineInfo,
  type AdmittedTransaction,
  type MaterializerPublicationFaultPoint,
} from '@chronolog/materializer-doltlite'
import {
  encodeTransactionCore,
  transactionDigest,
  utf8,
  type TransactionCore,
} from '@chronolog/protocol'

const [path, requestedPoint] = process.argv.slice(2)
if (path === undefined || requestedPoint === undefined) throw new Error('CRASH_FIXTURE_ARGUMENTS_REQUIRED')
const point = requestedPoint as MaterializerPublicationFaultPoint
const native = readNativeEngineInfo()
const manifest = createCoreExecutionManifest({
  profile: 'chronolog-native-production-v1',
  engine: native.descriptor,
  engineDigest: native.digest,
})
const materializer = await DeterministicMaterializer.open({
  path,
  executionManifest: manifest,
  checkpointEvery: 1,
  publicationFaultInjector(candidate) {
    if (candidate === point) process.kill(process.pid, 'SIGKILL')
  },
})
const core: TransactionCore = {
  groupId: bytes32(1),
  membershipRevision: bytes32(2),
  validationPolicy: bytes32(3),
  authorId: bytes32(4),
  authorTimestampMs: 1n,
  nonce: bytes32(5),
  executionManifestDigest: materializer.executionManifestDigest,
  program: {
    version: 1,
    preconditions: [{
      id: 1,
      query: { sql: 'SELECT 1', bindings: [] },
      resultMode: 'scalar',
      expectation: { kind: 'assert_true' },
    }],
    body: [{ sql: 'CREATE TABLE crash_probe (id INTEGER PRIMARY KEY) STRICT', bindings: [] }],
  },
}
const canonicalCandidate = encodeTransactionCore(core)
const transaction: AdmittedTransaction = {
  txId: utf8('crash-probe'),
  authorFeedSequence: 1n,
  candidateDigest: await transactionDigest(canonicalCandidate),
  canonicalCandidate,
  core,
}
await materializer.materialize([transaction])
throw new Error(`CRASH_FIXTURE_POINT_NOT_REACHED:${point}`)

function bytes32(seed: number): Uint8Array {
  return Uint8Array.from({ length: 32 }, (_value, index) => (seed + index) & 0xff)
}
