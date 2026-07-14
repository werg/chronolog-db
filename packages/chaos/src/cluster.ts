import { resolve } from 'node:path'

import { ChronologClient } from '@chronolog/client'
import { type CreatedProxy, type StartedToxiProxyContainer, ToxiProxyContainer } from '@testcontainers/toxiproxy'
import Docker from 'dockerode'
import { GenericContainer, Network, type StartedNetwork, type StartedTestContainer, Wait } from 'testcontainers'

import type { PreparedCluster } from './bootstrap.js'
import type { RunArtifacts } from './artifacts.js'
import type { ChaosScenario, FaultSpec, LinkName, NodeName, NodeResourceSample } from './types.js'
import { HttpRpcTransport } from '@chronolog/rpc'
import { readDockerSystemInfo } from './docker-info.js'

const RPC_PORT = 8787
const SSB_PORT = 8008
const TOXIPROXY_IMAGE = 'ghcr.io/shopify/toxiproxy:2.12.0'
const GRACEFUL_RESTART_TIMEOUT_MS = 15_000

export async function describeChaosEnvironment(image: string): Promise<Readonly<Record<string, unknown>>> {
  const docker = new Docker()
  const [version, info, imageInfo] = await Promise.all([
    docker.version(),
    readDockerSystemInfo(docker),
    docker.getImage(image).inspect(),
  ])
  return {
    capturedAt: new Date().toISOString(),
    host: { platform: process.platform, arch: process.arch, node: process.version, cpus: info.cpus, memoryBytes: info.memoryBytes },
    docker: { version: version.Version, apiVersion: version.ApiVersion, os: version.Os, arch: version.Arch, name: info.name },
    images: {
      chronolog: { reference: image, id: imageInfo.Id, repoDigests: imageInfo.RepoDigests ?? [] },
      toxiproxy: TOXIPROXY_IMAGE,
    },
    harness: { testcontainers: '12.0.4', toxiproxyModule: '12.0.4', dockerode: '5.0.1' },
  }
}

interface RunningNode {
  readonly name: NodeName
  readonly container: StartedTestContainer
  client: ChronologClient
  url: string
}

export interface FaultHandle {
  heal(): Promise<void>
}

export class ChaosCluster {
  readonly #network: StartedNetwork
  readonly #toxiproxy: StartedToxiProxyContainer
  readonly #docker = new Docker()
  readonly #links: ReadonlyMap<LinkName, CreatedProxy>
  readonly #nodes: ReadonlyMap<NodeName, RunningNode>
  readonly #disabledLinks = new Map<LinkName, number>()
  readonly #activeToxics = new Set<{ remove(): Promise<void> }>()
  readonly #pausedNodes = new Set<NodeName>()
  readonly #downNodes = new Set<NodeName>()
  #closed = false

  private constructor(
    readonly prepared: PreparedCluster,
    readonly scenario: ChaosScenario,
    readonly artifacts: RunArtifacts,
    network: StartedNetwork,
    toxiproxy: StartedToxiProxyContainer,
    links: ReadonlyMap<LinkName, CreatedProxy>,
    nodes: ReadonlyMap<NodeName, RunningNode>,
  ) {
    this.#network = network
    this.#toxiproxy = toxiproxy
    this.#links = links
    this.#nodes = nodes
  }

  static async start(options: {
    readonly prepared: PreparedCluster
    readonly scenario: ChaosScenario
    readonly artifacts: RunArtifacts
    readonly image: string
  }): Promise<ChaosCluster> {
    const network = await new Network().start()
    let toxiproxy: StartedToxiProxyContainer | undefined
    const startedNodes: StartedTestContainer[] = []
    try {
      const toxiproxyContainer = new ToxiProxyContainer(TOXIPROXY_IMAGE)
      toxiproxyContainer.withNetwork(network).withNetworkAliases('toxiproxy')
      toxiproxy = await toxiproxyContainer.start()
      const links = new Map<LinkName, CreatedProxy>()
      for (const source of options.prepared.nodes) {
        for (const target of options.prepared.nodes) {
          if (source.name === target.name) continue
          const name: LinkName = `${source.name}->${target.name}`
          links.set(name, await toxiproxy.createProxy({ name, upstream: `${target.name}:${SSB_PORT}` }))
        }
      }

      const nodes = new Map<NodeName, RunningNode>()
      await Promise.all(options.prepared.nodes.map(async (node) => {
        const peers = options.prepared.nodes
          .filter((peer) => peer.name !== node.name)
          .map((peer) => {
            const link = links.get(`${node.name}->${peer.name}`)
            if (!link) throw new Error('CHAOS_LINK_MISSING')
            const internalPort = Number(link.instance.listen.slice(link.instance.listen.lastIndexOf(':') + 1))
            const shs = peer.ssb.public.replace(/\.ed25519$/u, '')
            return { feedId: peer.ssb.id, address: `net:toxiproxy:${internalPort}~shs:${shs}` }
          })
        const container = new GenericContainer(options.image)
          .withNetwork(network)
          .withNetworkAliases(node.name)
          .withExposedPorts(RPC_PORT)
          .withBindMounts([{ source: resolve(node.directory), target: '/data', mode: 'rw' }])
          .withEnvironment({
            CHRONOLOG_DATA_DIR: '/data',
            CHRONOLOG_HOST: '0.0.0.0',
            CHRONOLOG_PORT: String(RPC_PORT),
            CHRONOLOG_SSB_HOST: '0.0.0.0',
            CHRONOLOG_SSB_PORT: String(SSB_PORT),
            CHRONOLOG_SSB_SCOPE: 'device',
            CHRONOLOG_SSB_PEERS: JSON.stringify(peers),
            CHRONOLOG_SSB_STALE_RECONNECT_MS: '8000',
            CHRONOLOG_STATIC_MEMBERSHIP_FILE: '/data/membership.json',
            CHRONOLOG_CHECKPOINT_EVERY: String(options.scenario.checkpointEvery),
            CHRONOLOG_CUTOFF_LAG_MS: String(options.scenario.cutoffLagMs),
            CHRONOLOG_MAX_FUTURE_SKEW_MS: '30000',
            CHRONOLOG_HEARTBEAT_INTERVAL_MS: '1000',
          })
          .withWaitStrategy(Wait.forHttp('/health', RPC_PORT))
          .withStartupTimeout(180_000)
          .withLogConsumer((stream) => stream.on('data', (chunk: Buffer) => options.artifacts.appendNodeLog(node.name, chunk)))
        if (process.getuid !== undefined && process.getgid !== undefined) container.withUser(`${process.getuid()}:${process.getgid()}`)
        const started = await container.start()
        startedNodes.push(started)
        const url = `http://${started.getHost()}:${started.getMappedPort(RPC_PORT)}`
        const client = new ChronologClient({
          groupId: options.prepared.groupIdUrl,
          transport: new HttpRpcTransport({ baseUrl: url }),
          unaryRetryAttempts: 1,
        })
        nodes.set(node.name, { name: node.name, container: started, client, url })
      }))
      return new ChaosCluster(options.prepared, options.scenario, options.artifacts, network, toxiproxy, links, nodes)
    } catch (error) {
      await Promise.allSettled(startedNodes.map((container) => container.stop({ timeout: GRACEFUL_RESTART_TIMEOUT_MS })))
      await toxiproxy?.stop().catch(() => undefined)
      await network.stop().catch(() => undefined)
      throw error
    }
  }

  nodeNames(): readonly NodeName[] { return [...this.#nodes.keys()].sort() }

  client(name: NodeName): ChronologClient {
    const node = this.#nodes.get(name)
    if (!node) throw new Error(`CHAOS_NODE_UNKNOWN:${name}`)
    return node.client
  }

  clients(): readonly { readonly name: NodeName; readonly client: ChronologClient }[] {
    return this.nodeNames().map((name) => ({ name, client: this.client(name) }))
  }

  linkNames(): readonly LinkName[] { return [...this.#links.keys()].sort() }

  async sampleResources(): Promise<readonly NodeResourceSample[]> {
    return Promise.all(this.nodeNames().map(async (name) => {
      const node = this.#node(name)
      const containerId = node.container.getId()
      try {
        const container = this.#docker.getContainer(containerId)
        const [inspect, stats] = await withDeadline(
          Promise.all([container.inspect(), container.stats({ stream: false })]),
          3_000,
          'CHAOS_RESOURCE_SAMPLE_TIMEOUT',
        )
        const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage
        const systemDelta = (stats.cpu_stats.system_cpu_usage ?? 0) - (stats.precpu_stats.system_cpu_usage ?? 0)
        const cpuCount = stats.cpu_stats.online_cpus ?? stats.cpu_stats.cpu_usage.percpu_usage?.length ?? 1
        const memoryCache = stats.memory_stats.stats?.cache ?? 0
        const networks = Object.values(stats.networks ?? {})
        const block = stats.blkio_stats?.io_service_bytes_recursive ?? []
        return {
          node: name,
          containerId,
          state: inspect.State.Status,
          restartCount: inspect.RestartCount,
          cpuPercent: systemDelta > 0 && cpuDelta >= 0 ? cpuDelta / systemDelta * cpuCount * 100 : 0,
          memoryBytes: Math.max(0, (stats.memory_stats.usage ?? 0) - memoryCache),
          memoryLimitBytes: stats.memory_stats.limit ?? 0,
          networkRxBytes: networks.reduce((sum, network) => sum + network.rx_bytes, 0),
          networkTxBytes: networks.reduce((sum, network) => sum + network.tx_bytes, 0),
          blockReadBytes: block.filter((entry) => entry.op.toLowerCase() === 'read').reduce((sum, entry) => sum + entry.value, 0),
          blockWriteBytes: block.filter((entry) => entry.op.toLowerCase() === 'write').reduce((sum, entry) => sum + entry.value, 0),
        }
      } catch (error) {
        return {
          node: name,
          containerId,
          state: 'unavailable',
          restartCount: 0,
          error: error instanceof Error ? error.message : String(error),
        }
      }
    }))
  }

  async waitForHealthy(name: NodeName, timeoutMs = 30_000): Promise<void> {
    const node = this.#node(name)
    const deadline = Date.now() + timeoutMs
    let lastError: unknown
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`${node.url}/health`, { signal: AbortSignal.timeout(2_000) })
        if (response.ok) return
      } catch (error) { lastError = error }
      await delay(200)
    }
    throw new Error(`CHAOS_NODE_HEALTH_TIMEOUT:${name}:${lastError instanceof Error ? lastError.message : String(lastError)}`)
  }

  async applyFault(fault: FaultSpec, token: string): Promise<FaultHandle> {
    switch (fault.kind) {
      case 'partition': {
        const groupByNode = new Map(fault.groups.flatMap((group, index) => group.map((node) => [node, index] as const)))
        const links = this.linkNames().filter((link) => {
          const [source, target] = splitLink(link)
          return groupByNode.get(source) !== groupByNode.get(target)
        })
        await this.#disable(links)
        return { heal: () => this.#enable(links) }
      }
      case 'latency': return this.#toxic(fault.links, token, 'latency', { latency: fault.latencyMs, jitter: fault.jitterMs })
      case 'bandwidth': return this.#toxic(fault.links, token, 'bandwidth', { rate: fault.rateKbps })
      case 'timeout': return this.#toxic(fault.links, token, 'timeout', { timeout: fault.timeoutMs })
      case 'reset': return this.#toxic(fault.links, token, 'reset_peer', { timeout: fault.resetAfterMs })
      case 'pause': {
        const container = this.#docker.getContainer(this.#node(fault.node).container.getId())
        await container.pause()
        this.#pausedNodes.add(fault.node)
        return { heal: async () => { if (this.#pausedNodes.delete(fault.node)) await container.unpause() } }
      }
      case 'crash': {
        const node = this.#node(fault.node)
        await this.#docker.getContainer(node.container.getId()).kill({ signal: 'SIGKILL' })
        this.#downNodes.add(fault.node)
        return { heal: async () => {
          if (!this.#downNodes.delete(fault.node)) return
          await this.#startCrashedNode(node)
          await this.#refreshClient(node)
          await this.waitForHealthy(fault.node)
        } }
      }
      case 'restart': {
        const node = this.#node(fault.node)
        await this.#restartNode(node)
        await this.#refreshClient(node)
        await this.waitForHealthy(fault.node)
        return { heal: async () => undefined }
      }
      case 'cpu': {
        const container = this.#docker.getContainer(this.#node(fault.node).container.getId())
        await container.update({ CpuPeriod: 100_000, CpuQuota: Math.max(1_000, Math.round(fault.cores * 100_000)) })
        return { heal: async () => { await container.update({ CpuPeriod: 0, CpuQuota: 0 }) } }
      }
    }
  }

  async healAll(waitForHealth = true): Promise<void> {
    await Promise.allSettled([...this.#pausedNodes].map(async (name) => {
      await this.#docker.getContainer(this.#node(name).container.getId()).unpause()
      this.#pausedNodes.delete(name)
    }))
    await Promise.allSettled([...this.#downNodes].map(async (name) => {
      const node = this.#node(name)
      await this.#startCrashedNode(node)
      await this.#refreshClient(node)
      this.#downNodes.delete(name)
    }))
    await Promise.all(this.linkNames().map(async (name) => {
      this.#disabledLinks.delete(name)
      await this.#links.get(name)!.setEnabled(true)
    }))
    await Promise.all([...this.#activeToxics].map((toxic) => toxic.remove().catch(() => undefined)))
    this.#activeToxics.clear()
    if (waitForHealth) await Promise.all(this.nodeNames().map((name) => this.waitForHealthy(name)))
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    await withDeadline(this.healAll(false), 10_000, 'CHAOS_CLEANUP_HEAL_TIMEOUT').catch(() => undefined)
    await Promise.allSettled([...this.#nodes.values()].map((node) => node.client.close()))
    await Promise.allSettled([...this.#nodes.values()].reverse().map((node) => node.container.stop({ timeout: GRACEFUL_RESTART_TIMEOUT_MS })))
    await this.#toxiproxy.stop().catch(() => undefined)
    await this.#network.stop().catch(() => undefined)
  }

  #node(name: NodeName): RunningNode {
    const node = this.#nodes.get(name)
    if (!node) throw new Error(`CHAOS_NODE_UNKNOWN:${name}`)
    return node
  }

  async #refreshClient(node: RunningNode): Promise<void> {
    const previous = node.client
    const inspect = await this.#docker.getContainer(node.container.getId()).inspect()
    const binding = inspect.NetworkSettings.Ports[`${RPC_PORT}/tcp`]?.[0]
    if (!binding) throw new Error(`CHAOS_NODE_RPC_PORT_UNBOUND:${node.name}`)
    node.url = `http://${node.container.getHost()}:${binding.HostPort}`
    node.client = new ChronologClient({
      groupId: this.prepared.groupIdUrl,
      transport: new HttpRpcTransport({ baseUrl: node.url }),
      unaryRetryAttempts: 1,
    })
    await previous.close()
  }

  async #restartNode(node: RunningNode): Promise<void> {
    await this.#docker.getContainer(node.container.getId()).restart({ t: GRACEFUL_RESTART_TIMEOUT_MS / 1_000 })
  }

  async #startCrashedNode(node: RunningNode): Promise<void> {
    await this.#docker.getContainer(node.container.getId()).start()
  }

  #selectedLinks(selection: readonly LinkName[] | 'all'): readonly LinkName[] {
    if (selection === 'all') return this.linkNames()
    for (const link of selection) if (!this.#links.has(link)) throw new Error(`CHAOS_LINK_UNKNOWN:${link}`)
    return selection
  }

  async #disable(links: readonly LinkName[]): Promise<void> {
    await Promise.all(links.map(async (link) => {
      const count = this.#disabledLinks.get(link) ?? 0
      this.#disabledLinks.set(link, count + 1)
      if (count === 0) await this.#links.get(link)!.setEnabled(false)
    }))
  }

  async #enable(links: readonly LinkName[]): Promise<void> {
    await Promise.all(links.map(async (link) => {
      const count = this.#disabledLinks.get(link) ?? 0
      if (count <= 1) {
        this.#disabledLinks.delete(link)
        await this.#links.get(link)!.setEnabled(true)
      } else this.#disabledLinks.set(link, count - 1)
    }))
  }

  async #toxic(
    selection: readonly LinkName[] | 'all',
    token: string,
    type: 'latency' | 'bandwidth' | 'timeout' | 'reset_peer',
    attributes: Record<string, number>,
  ): Promise<FaultHandle> {
    const toxics = await Promise.all(this.#selectedLinks(selection).map((link, index) =>
      this.#links.get(link)!.instance.addToxic({
        name: `${token}-${index}`,
        stream: 'downstream',
        toxicity: 1,
        type,
        attributes,
      })))
    for (const toxic of toxics) this.#activeToxics.add(toxic)
    return { heal: async () => {
      await Promise.all(toxics.map((toxic) => toxic.remove().catch(() => undefined)))
      for (const toxic of toxics) this.#activeToxics.delete(toxic)
    } }
  }
}

export async function buildChaosImage(rootDirectory: string, image: string): Promise<void> {
  await GenericContainer.fromDockerfile(resolve(rootDirectory), 'chaos/Dockerfile')
    .withBuildkit()
    .build(image, { deleteOnExit: false })
}

function splitLink(link: LinkName): readonly [NodeName, NodeName] {
  const [source, target] = link.split('->')
  return [source as NodeName, target as NodeName]
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))
}

function withDeadline<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolveDeadline, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs)
    timer.unref?.()
    promise.then(
      (value) => { clearTimeout(timer); resolveDeadline(value) },
      (error: unknown) => { clearTimeout(timer); reject(error) },
    )
  })
}
