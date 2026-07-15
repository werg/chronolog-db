import { join, resolve } from 'node:path'

import { createCoreExecutionManifest } from '@chronolog/compiler-sqlite'
import { ControlStore, JsonFileControlStorePersistence } from '@chronolog/control-store'
import {
  DeterministicMaterializer,
  createDoltLiteMaterializationRuntime,
  readNativeEngineInfo,
} from '@chronolog/materializer-doltlite'
import { ChronologNode, createEpochEnvelopeCipher, type MembershipResolver } from '@chronolog/node-core'
import { equalBytes } from '@chronolog/protocol'
import { HttpRpcServer, NodeRpcService } from '@chronolog/rpc'
import { SsbDb2Transport, type SsbPeer } from '@chronolog/transport-ssb'

import { fromBase64, loadOrCreateConfig, parseDaemonRuntimeConfig } from './config.js'
import { loadStaticMembership } from './static-membership.js'

const dataDirectory = resolve(process.env.CHRONOLOG_DATA_DIR ?? '.chronolog')
const runtime = parseDaemonRuntimeConfig(process.env)
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

const configuredPeers: readonly SsbPeer[] = runtime.peers
const nativeEngine = readNativeEngineInfo()
const executionManifest = createCoreExecutionManifest({
  profile: 'chronolog-core-portable',
  engineDigest: nativeEngine.digest,
})
const { transport, materializer, node, server, address } = await startRuntime()
process.stdout.write(`${JSON.stringify({
  event: 'chronologd.ready',
  url: address.url,
  groupId: Buffer.from(groupId).toString('base64url'),
  nodeId: Buffer.from(identity.publicKeyBytes).toString('base64url'),
  ssbId: transport.identity,
  ssbAddress: transport.address(runtime.ssbScope),
  materializer: materializer.backend,
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

async function startRuntime() {
  const transport = await SsbDb2Transport.open({
    path: join(dataDirectory, 'ssb'),
    network: {
      listen: {
        host: runtime.ssbHost,
        port: runtime.ssbPort,
        scope: runtime.ssbScope,
      },
      peers: configuredPeers,
      ...(runtime.staleReconnectMs === undefined ? {} : { reconnect: { staleAfterMs: runtime.staleReconnectMs } }),
    },
  })
  let materializer: DeterministicMaterializer | undefined
  let node: ChronologNode | undefined
  let server: HttpRpcServer | undefined
  try {
    materializer = await DeterministicMaterializer.open({
      path: join(dataDirectory, 'application.db'),
      checkpointEvery: runtime.checkpointEvery,
      executionManifest,
    })
    node = new ChronologNode({
      groupId,
      groupRoute: fromBase64(config.groupRoute),
      membershipRevision,
      validationPolicy,
      identity,
      transport,
      materialization: createDoltLiteMaterializationRuntime(materializer),
      controlStore: new ControlStore(new JsonFileControlStorePersistence(join(dataDirectory, 'control.json'))),
      membership,
      validator: {
        capabilityId: validatorCapability,
        cutoffLagMs: runtime.cutoffLagMs,
        maxFutureSkewMs: runtime.maxFutureSkewMs,
        heartbeatIntervalMs: runtime.heartbeatIntervalMs,
      },
      envelopeCipher: createEpochEnvelopeCipher(fromBase64(config.epochContentKey), BigInt(config.epoch)),
    })
    await node.start()
    server = new HttpRpcServer({
      service: new NodeRpcService({ node }),
      host: runtime.host,
      port: runtime.port,
      ...(runtime.token === undefined ? {} : { token: runtime.token }),
    })
    const address = await server.listen()
    return { transport, materializer, node, server, address }
  } catch (error) {
    await server?.close().catch(() => undefined)
    if (node !== undefined) {
      await node.close().catch(() => undefined)
    } else {
      materializer?.close()
      await transport.close().catch(() => undefined)
    }
    throw error
  }
}
