import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { createCoreExecutionManifest } from '@chronolog/compiler-sqlite'
import { ControlStore, JsonFileControlStorePersistence } from '@chronolog/control-store'
import { decodeSchemaManifest, encodeSchemaManifest, SchemaBuilder, type SchemaManifest } from '@chronolog/ir'
import { DeterministicMaterializer, readNativeEngineInfo } from '@chronolog/materializer-doltlite'
import { ChronologNode, createEpochEnvelopeCipher, type MembershipResolver } from '@chronolog/node-core'
import { equalBytes } from '@chronolog/protocol'
import { HttpRpcServer, NodeRpcService } from '@chronolog/rpc'
import { SsbDb2Transport, type SsbPeer } from '@chronolog/transport-ssb'

import { fromBase64, loadOrCreateConfig } from './config.js'
import { loadStaticMembership } from './static-membership.js'

const dataDirectory = resolve(process.env.CHRONOLOG_DATA_DIR ?? '.chronolog')
const { config, identity } = await loadOrCreateConfig(dataDirectory)
const groupId = fromBase64(config.groupId)
const membershipRevision = fromBase64(config.membershipRevision)
const validationPolicy = fromBase64(config.validationPolicy)
const validatorCapability = fromBase64(config.validatorCapability)

// Standalone bootstrap profile: a root-controlled single participant. Replace
// this resolver with reduceCapabilityLog(...) or an external membership source
// when adding participants; node-core never assumes a fixed validator list.
const standaloneMembership: MembershipResolver = {
  canWrite: (context) =>
    equalBytes(context.membershipRevision, membershipRevision) &&
    equalBytes(context.writerId, identity.publicKeyBytes),
  canValidate: (context) =>
    equalBytes(context.membershipRevision, membershipRevision) &&
    equalBytes(context.validatorId, identity.publicKeyBytes) &&
    equalBytes(context.validatorCapability, validatorCapability),
  threshold: () => 1,
  watermarkPolicy: () => ({
    kind: 'threshold',
    policyId: Buffer.from(validationPolicy).toString('base64url'),
    validatorIds: [identity.publicKeyBytes],
    threshold: 1,
  }),
}
const membership = process.env.CHRONOLOG_STATIC_MEMBERSHIP_FILE === undefined
  ? standaloneMembership
  : await loadStaticMembership(resolve(process.env.CHRONOLOG_STATIC_MEMBERSHIP_FILE), {
      groupId,
      membershipRevision,
      validationPolicy,
    })

const configuredPeers = process.env.CHRONOLOG_SSB_PEERS === undefined
  ? []
  : JSON.parse(process.env.CHRONOLOG_SSB_PEERS) as SsbPeer[]
const staleReconnectMs = process.env.CHRONOLOG_SSB_STALE_RECONNECT_MS === undefined
  ? undefined
  : Number(process.env.CHRONOLOG_SSB_STALE_RECONNECT_MS)
const schemaManifest = await loadSchemaManifest(dataDirectory)
const nativeEngine = readNativeEngineInfo()
const executionManifest = createCoreExecutionManifest({
  profile: 'chronolog-core-portable',
  engineDigest: nativeEngine.digest,
})
const transport = await SsbDb2Transport.open({
  path: join(dataDirectory, 'ssb'),
  network: {
    listen: {
      host: process.env.CHRONOLOG_SSB_HOST ?? '127.0.0.1',
      port: Number(process.env.CHRONOLOG_SSB_PORT ?? 0),
      scope: process.env.CHRONOLOG_SSB_SCOPE === 'public' ? 'public' : process.env.CHRONOLOG_SSB_SCOPE === 'local' ? 'local' : 'device',
    },
    peers: configuredPeers,
    ...(staleReconnectMs === undefined ? {} : { reconnect: { staleAfterMs: staleReconnectMs } }),
  },
})
const materializer = await DeterministicMaterializer.open({
  path: join(dataDirectory, 'application.db'),
  checkpointEvery: Number(process.env.CHRONOLOG_CHECKPOINT_EVERY ?? 100),
  schemaManifest,
  executionManifest,
})
const node = new ChronologNode({
  groupId,
  groupRoute: fromBase64(config.groupRoute),
  membershipRevision,
  validationPolicy,
  identity,
  transport,
  materializer,
  controlStore: new ControlStore(new JsonFileControlStorePersistence(join(dataDirectory, 'control.json'))),
  membership,
  validator: {
    capabilityId: validatorCapability,
    cutoffLagMs: Number(process.env.CHRONOLOG_CUTOFF_LAG_MS ?? 60_000),
    maxFutureSkewMs: Number(process.env.CHRONOLOG_MAX_FUTURE_SKEW_MS ?? 30_000),
    heartbeatIntervalMs: Number(process.env.CHRONOLOG_HEARTBEAT_INTERVAL_MS ?? 30_000),
  },
  envelopeCipher: createEpochEnvelopeCipher(fromBase64(config.epochContentKey), BigInt(config.epoch)),
})
await node.start()

const server = new HttpRpcServer({
  service: new NodeRpcService({ node }),
  host: process.env.CHRONOLOG_HOST ?? '127.0.0.1',
  port: Number(process.env.CHRONOLOG_PORT ?? 8787),
  ...(process.env.CHRONOLOG_TOKEN === undefined ? {} : { token: process.env.CHRONOLOG_TOKEN }),
})
const address = await server.listen()
process.stdout.write(`${JSON.stringify({
  event: 'chronologd.ready',
  url: address.url,
  groupId: Buffer.from(groupId).toString('base64url'),
  nodeId: Buffer.from(identity.publicKeyBytes).toString('base64url'),
  ssbId: transport.identity,
  ssbAddress: transport.address(process.env.CHRONOLOG_SSB_SCOPE === 'public' ? 'public' : process.env.CHRONOLOG_SSB_SCOPE === 'local' ? 'local' : 'device'),
  materializer: materializer.backend,
  schemaDigest: Buffer.from(materializer.schemaDigest).toString('base64url'),
  executionManifestDigest: Buffer.from(materializer.executionManifestDigest).toString('base64url'),
})}\n`)

let stopping = false
async function stop(signal: string): Promise<void> {
  if (stopping) return
  stopping = true
  process.stdout.write(`${JSON.stringify({ event: 'chronologd.stopping', signal })}\n`)
  await server.close()
  await node.close()
}

function terminate(signal: string): void {
  void stop(signal).then(
    () => process.exit(0),
    (error: unknown) => {
      process.stderr.write(`${JSON.stringify({
        event: 'chronologd.stop_failed',
        signal,
        error: error instanceof Error ? error.stack ?? error.message : String(error),
      })}\n`)
      process.exit(1)
    },
  )
}

process.once('SIGINT', () => terminate('SIGINT'))
process.once('SIGTERM', () => terminate('SIGTERM'))

async function loadSchemaManifest(directory: string): Promise<SchemaManifest> {
  const configured = process.env.CHRONOLOG_SCHEMA_FILE
  const path = resolve(configured ?? join(directory, 'schema.cbor'))
  try {
    return decodeSchemaManifest(new Uint8Array(await readFile(path)))
  } catch (error) {
    if (configured !== undefined || !isMissing(error)) throw error
    const schema = new SchemaBuilder().schema('application_default', [])
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await writeFile(path, encodeSchemaManifest(schema), { flag: 'wx', mode: 0o600 })
    return schema
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}
