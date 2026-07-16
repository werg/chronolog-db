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
  FeedForkRegistry,
  JsonFeedForkPersistence,
  createEpochEnvelopeCipher,
  FileBlobStore,
  HttpBlobStore,
  ReplicatedBlobStore,
  type MembershipResolver,
} from '@chronolog/node-core'
import { equalBytes } from '@chronolog/protocol'
import { HttpRpcServer, NodeRpcService } from '@chronolog/rpc'
import { SsbDb2Transport, type SsbPeer } from '@chronolog/transport-ssb'

import { fromBase64, loadOrCreateConfig, parseDaemonRuntimeConfig } from './config.js'
import { loadOrCreateGovernanceBootstrap } from './governance-config.js'
import { loadStaticMembership } from './static-membership.js'
import { discoverPublicSsbAddress, verifyPublicSsbReachability, type NatVerificationResult } from './nat-discovery.js'
import { daemonHealth, prometheusMetrics } from './observability.js'
import { daemonSecretStoreFromEnvironment } from './secret-store.js'
import { createGovernanceRpcAdmin } from './governance-admin.js'
import { acquireDataDirectoryLock } from './data-lock.js'

const dataDirectory = resolve(process.env.CHRONOLOG_DATA_DIR ?? '.chronolog')
const dataLock = await acquireDataDirectoryLock(dataDirectory, 'daemon')
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
const { transport, materializer, node, server, address, governance, nat } = await startRuntime()
process.stdout.write(`${JSON.stringify({
  event: 'chronologd.ready',
  url: address.url,
  healthUrl: `${address.url}/health`,
  metricsUrl: `${address.url}/metrics`,
  groupId: Buffer.from(groupId).toString('base64url'),
  nodeId: Buffer.from(identity.publicKeyBytes).toString('base64url'),
  ssbId: transport.identity,
  ssbAddress: transport.address(runtime.ssbScope),
  publicSsbAddress: nat.address,
  publicSsbAddressSource: nat.source,
  natDiscoveryError: nat.error ?? null,
  publicSsbReachability: nat.reachability.status,
  publicSsbReachabilityError: nat.reachability.error ?? null,
  materializer: materializer.backend,
  executionManifestDigest: Buffer.from(materializer.executionManifestDigest).toString('base64url'),
  membershipRevision: Buffer.from(node.membershipRevision).toString('base64url'),
  governanceRevision: governance?.snapshot.revision.toString() ?? null,
  encryptionEpoch: governance?.currentEpoch?.toString() ?? config.epoch,
  blobMode: runtime.blobMaxInlineBytes === undefined ? 'inline' : 'manifest-v1',
  blobPeers: runtime.blobPeers.length,
})}\n`)

let stopping = false
async function stop(signal: string): Promise<void> {
  if (stopping) return
  stopping = true
  process.stdout.write(`${JSON.stringify({ event: 'chronologd.stopping', signal })}\n`)
  await server.close()
  await governance?.close()
  await node.close()
  await dataLock.release()
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
  let reachability: NatVerificationResult = { status: 'not-configured', address: null }
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
    const localBlobStore = runtime.blobMaxInlineBytes === undefined
      ? undefined
      : new FileBlobStore(join(dataDirectory, 'blobs'))
    const blobStore = localBlobStore === undefined
      ? undefined
      : new ReplicatedBlobStore(localBlobStore, runtime.blobPeers.map((peer) => new HttpBlobStore({
        baseUrl: peer.url,
        ...(peer.token === undefined ? {} : { token: peer.token }),
        maximumChunkBytes: runtime.blobChunkBytes!,
      })))
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
      feedForkRegistry: new FeedForkRegistry(
        new JsonFeedForkPersistence(join(dataDirectory, 'feed-continuity.json')),
      ),
      ...(blobStore === undefined ? {} : {
        blobPayloads: {
          store: blobStore,
          maxInlineBytes: runtime.blobMaxInlineBytes!,
          chunkBytes: runtime.blobChunkBytes!,
        },
      }),
    })
    await node.start()
    server = new HttpRpcServer({
      service: new NodeRpcService({
        node,
        ...(governance === undefined ? {} : {
          governanceAdmin: createGovernanceRpcAdmin({ governance, rootPrivateKey: identity.privateKey }),
        }),
      }),
      host: runtime.host,
      port: runtime.port,
      ...(runtime.token === undefined ? {} : { token: runtime.token }),
      health: async () => daemonHealth(await node!.status(), stopping, traversalError(runtime.ssbScope, reachability)),
      metrics: async () => prometheusMetrics(await node!.status(), traversalError(runtime.ssbScope, reachability)),
      ...(localBlobStore === undefined ? {} : { blob: (digest: Uint8Array) => localBlobStore.get(digest) }),
    })
    const address = await server.listen()
    const nat = await discoverPublicSsbAddress({
      timeoutMs: runtime.natDiscoveryTimeoutMs,
      ...(runtime.publicSsbAddress === undefined ? {} : { explicitAddress: runtime.publicSsbAddress }),
      ...(runtime.natDiscoveryUrl === undefined ? {} : { discoveryUrl: runtime.natDiscoveryUrl }),
    })
    reachability = await verifyPublicSsbReachability({
      address: nat.address,
      timeoutMs: runtime.natDiscoveryTimeoutMs,
      ...(runtime.natVerificationUrl === undefined ? {} : { verificationUrl: runtime.natVerificationUrl }),
    })
    return { transport, materializer, node, server, address, governance, nat: { ...nat, reachability } }
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

function traversalError(scope: 'device' | 'local' | 'public', result: NatVerificationResult): string | undefined {
  if (scope !== 'public') return undefined
  if (result.status === 'verified') return undefined
  return result.error ?? 'PUBLIC_SSB_REACHABILITY_NOT_VERIFIED'
}
