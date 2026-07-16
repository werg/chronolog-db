import { join, resolve } from 'node:path'

import { createCoreExecutionManifest } from '@chronolog/compiler-sqlite'
import { isCapabilityActive } from '@chronolog/capabilities'
import { ControlStore, JsonFileControlStorePersistence } from '@chronolog/control-store'
import {
  DeterministicMaterializer,
  createDoltLiteMaterializationRuntime,
  readNativeEngineInfo,
} from '@chronolog/materializer-doltlite'
import {
  CapabilityMembershipResolver,
  ChronologNode,
  GovernanceControlPlane,
  createEpochEnvelopeCipher,
  type MembershipResolver,
} from '@chronolog/node-core'
import { equalBytes } from '@chronolog/protocol'
import { HttpRpcServer, NodeRpcService } from '@chronolog/rpc'
import { SsbDb2Transport, type SsbPeer } from '@chronolog/transport-ssb'

import { fromBase64, loadOrCreateConfig, parseDaemonRuntimeConfig } from './config.js'
import { loadOrCreateGovernanceBootstrap } from './governance-config.js'
import { loadStaticMembership } from './static-membership.js'
import { daemonSecretStoreFromEnvironment } from './secret-store.js'

const dataDirectory = resolve(process.env.CHRONOLOG_DATA_DIR ?? '.chronolog')
const runtime = parseDaemonRuntimeConfig(process.env)
const secretStore = daemonSecretStoreFromEnvironment(process.env)
const { config, identity } = await loadOrCreateConfig(dataDirectory, secretStore)
const groupId = fromBase64(config.groupId)
const configuredMembershipRevision = fromBase64(config.membershipRevision)
const configuredValidationPolicy = fromBase64(config.validationPolicy)
const configuredValidatorCapability = fromBase64(config.validatorCapability)

const configuredPeers: readonly SsbPeer[] = runtime.peers
const nativeEngine = readNativeEngineInfo()
const executionManifest = createCoreExecutionManifest({
  profile: 'chronolog-core-portable',
  engineDigest: nativeEngine.digest,
})
const { transport, materializer, node, server, address, governance } = await startRuntime()
process.stdout.write(`${JSON.stringify({
  event: 'chronologd.ready',
  url: address.url,
  groupId: Buffer.from(groupId).toString('base64url'),
  nodeId: Buffer.from(identity.publicKeyBytes).toString('base64url'),
  ssbId: transport.identity,
  ssbAddress: transport.address(runtime.ssbScope),
  materializer: materializer.backend,
  executionManifestDigest: Buffer.from(materializer.executionManifestDigest).toString('base64url'),
  membershipRevision: Buffer.from(node.membershipRevision).toString('base64url'),
  governanceRevision: governance?.snapshot.revision.toString() ?? null,
  encryptionEpoch: governance?.currentEpoch?.toString() ?? config.epoch,
})}\n`)

let stopping = false
async function stop(signal: string): Promise<void> {
  if (stopping) return
  stopping = true
  process.stdout.write(`${JSON.stringify({ event: 'chronologd.stopping', signal })}\n`)
  await server.close()
  await governance?.close()
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
  let governance: GovernanceControlPlane | undefined
  try {
    materializer = await DeterministicMaterializer.open({
      path: join(dataDirectory, 'application.db'),
      checkpointEvery: runtime.checkpointEvery,
      executionManifest,
    })
    const controlStore = new ControlStore(new JsonFileControlStorePersistence(join(dataDirectory, 'control.json')))
    let membership: MembershipResolver
    let membershipRevision = configuredMembershipRevision
    let validationPolicy = configuredValidationPolicy
    let validatorCapability = configuredValidatorCapability
    let envelopeCipher = createEpochEnvelopeCipher(fromBase64(config.epochContentKey), BigInt(config.epoch))
    let membershipState: (() => {
      readonly membershipRevision: Uint8Array
      readonly validationPolicy: Uint8Array
      readonly validatorCapability?: Uint8Array
    }) | undefined
    if (process.env.CHRONOLOG_STATIC_MEMBERSHIP_FILE !== undefined) {
      membership = await loadStaticMembership(resolve(process.env.CHRONOLOG_STATIC_MEMBERSHIP_FILE), {
        groupId,
        membershipRevision,
        validationPolicy,
      })
    } else {
      const bootstrap = await loadOrCreateGovernanceBootstrap({
        dataDirectory,
        groupId,
        schemaId: materializer.executionManifestDigest,
        identity,
        transportAuthor: transport.identity,
        ...(secretStore === undefined ? {} : { secretStore }),
      })
      governance = await GovernanceControlPlane.create({
        genesis: bootstrap.genesis,
        groupRoute: fromBase64(config.groupRoute),
        transport,
        identity,
        recipient: { id: bootstrap.recipientId, privateKey: bootstrap.recipientPrivateKey },
        onHistoryReopened: (event) => controlStore.recordHistoryReopening({
          id: event.id,
          floorMs: 0n,
          membershipRevision: event.membershipRevision,
          reason: event.reason,
        }),
      })
      await governance.start()
      if (governance.currentEpoch === null) {
        await governance.rotateEpoch(identity.privateKey, fromBase64(config.epochContentKey))
      }
      membership = new CapabilityMembershipResolver({
        snapshotForRevision: (digest) => governance!.snapshotForRevision(digest),
      })
      validationPolicy = bootstrap.validationPolicyId
      const state = () => {
        const snapshot = governance!.snapshot
        const activeValidator = [...snapshot.capabilities.values()].find((capability) =>
          capability.grant.role === 'validator' &&
          equalBytes(capability.grant.signingPublicKey, identity.publicKeyBytes) &&
          isCapabilityActive(capability, snapshot.revision))
        return {
          membershipRevision: snapshot.revisionDigest,
          validationPolicy,
          ...(activeValidator === undefined ? {} : { validatorCapability: activeValidator.id }),
        }
      }
      const initial = state()
      membershipRevision = initial.membershipRevision
      validatorCapability = initial.validatorCapability ?? configuredValidatorCapability
      membershipState = state
      envelopeCipher = governance.cipherRing.current()
    }
    node = new ChronologNode({
      groupId,
      groupRoute: fromBase64(config.groupRoute),
      membershipRevision,
      validationPolicy,
      identity,
      transport,
      materialization: createDoltLiteMaterializationRuntime(materializer),
      controlStore,
      membership,
      ...(membershipState === undefined ? {} : { membershipState }),
      validator: {
        capabilityId: validatorCapability,
        cutoffLagMs: runtime.cutoffLagMs,
        maxFutureSkewMs: runtime.maxFutureSkewMs,
        heartbeatIntervalMs: runtime.heartbeatIntervalMs,
      },
      envelopeCipher: governance?.cipherRing ?? envelopeCipher,
    })
    await node.start()
    server = new HttpRpcServer({
      service: new NodeRpcService({ node }),
      host: runtime.host,
      port: runtime.port,
      ...(runtime.token === undefined ? {} : { token: runtime.token }),
    })
    const address = await server.listen()
    return { transport, materializer, node, server, address, governance }
  } catch (error) {
    await server?.close().catch(() => undefined)
    await governance?.close().catch(() => undefined)
    if (node !== undefined) {
      await node.close().catch(() => undefined)
    } else {
      materializer?.close()
      await transport.close().catch(() => undefined)
    }
    throw error
  }
}
