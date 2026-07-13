import { mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

import { AsyncQueue } from './async-queue.js'
import { type ChronologTransport, type PublishOptions, type TransportRecord, type TransportStatus } from './types.js'

const require = createRequire(import.meta.url)

function requireSsbDb2(): unknown {
  // atomic-file-rw@0.3 selects its browser backend whenever a global
  // localStorage exists. Node 25 added one, even for ordinary server processes.
  // Mask it only while the CommonJS dependency graph initializes.
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  try {
    if (descriptor?.configurable) Reflect.deleteProperty(globalThis, 'localStorage')
    return require('ssb-db2') as unknown
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor)
  }
}

interface SsbKvt {
  readonly key: string
  readonly value: {
    readonly author: string
    readonly sequence: number
    readonly previous: string | null
    readonly timestamp?: number
    readonly content: unknown
  }
  readonly timestamp?: number
}

interface SsbDb {
  create(options: { content: unknown }, callback: (error: Error | null, kvt?: SsbKvt) => void): void
  get(id: string, callback: (error: Error | null, value?: SsbKvt['value']) => void): void
  query(...operators: unknown[]): void
  onMsgAdded(callback: (event: { kvt: SsbKvt }) => void): (() => void) | void
  onDrain?(indexName: string, callback: () => void): void
}

interface Sbot {
  readonly id: string
  readonly db: SsbDb
  readonly ebt?: {
    request(feedId: string, replicating: boolean): void
    peerStatus?(feedId: string): unknown
    clock?(callback: (error: Error | null, clock?: Readonly<Record<string, number>>) => void): void
  }
  connect?(address: string, callback: (error: Error | null, rpc?: SsbRpc) => void): void
  getAddress?(scope?: string): string
  on?(event: string, callback: (...arguments_: unknown[]) => void): void
  close(callback: (error?: Error) => void): void
}

interface SsbRpc {
  readonly id?: string
  on?(event: string, callback: () => void): void
}

export interface SsbPeer {
  readonly address: string
  readonly feedId: string
}

export interface SsbDb2TransportOptions {
  readonly path: string
  readonly secretPath?: string
  readonly keys?: unknown
  readonly config?: Readonly<Record<string, unknown>>
  readonly network?: {
    readonly listen?: {
      readonly host?: string
      readonly port: number
      readonly scope?: 'device' | 'local' | 'public'
    }
    readonly peers?: readonly SsbPeer[]
  }
}

function decodeContent(content: unknown): Uint8Array | undefined {
  if (!content || typeof content !== 'object') return undefined
  const value = content as Record<string, unknown>
  if (value.type !== 'chronolog-envelope/v1' || typeof value.payload !== 'string') return undefined
  return Uint8Array.from(Buffer.from(value.payload, 'base64'))
}

function normalize(kvt: SsbKvt): TransportRecord | undefined {
  const payload = decodeContent(kvt.value.content)
  if (!payload) return undefined
  return {
    id: kvt.key,
    author: kvt.value.author,
    sequence: BigInt(kvt.value.sequence),
    ...(kvt.value.previous === null ? {} : { previous: kvt.value.previous }),
    receivedAtMs: kvt.timestamp ?? kvt.value.timestamp ?? Date.now(),
    payload,
  }
}

export class SsbDb2Transport implements ChronologTransport {
  readonly #sbot: Sbot
  readonly #queueSubscribers = new Set<AsyncQueue<TransportRecord>>()
  readonly #peers = new Set<string>()
  readonly #unsubscribe?: () => void
  #closed = false

  private constructor(sbot: Sbot) {
    this.#sbot = sbot
    const unsubscribe = sbot.db.onMsgAdded((event) => {
      const record = normalize(event.kvt)
      if (!record) return
      for (const subscriber of this.#queueSubscribers) subscriber.push(record)
    })
    if (typeof unsubscribe === 'function') this.#unsubscribe = unsubscribe
    sbot.on?.('rpc:connect', (...arguments_: unknown[]) => {
      const rpc = arguments_[0] as SsbRpc | undefined
      if (rpc?.id === undefined) return
      this.#peers.add(rpc.id)
      rpc.on?.('closed', () => this.#peers.delete(rpc.id!))
    })
  }

  static async open(options: SsbDb2TransportOptions): Promise<SsbDb2Transport> {
    await mkdir(options.path, { recursive: true })
    const SecretStack = require('secret-stack') as (options: unknown) => {
      use(plugin: unknown): unknown
    }
    const caps = require('ssb-caps') as unknown
    const db2 = requireSsbDb2()
    const db2EbtCompat = require('ssb-db2/compat/ebt') as unknown
    const ebt = require('ssb-ebt') as unknown
    const ssbKeys = require('ssb-keys') as {
      loadOrCreateSync(path: string): unknown
    }
    const secretPath = options.secretPath ?? join(dirname(options.path), 'secret')
    const keys = options.keys ?? ssbKeys.loadOrCreateSync(secretPath)
    interface StackBuilder {
      use(plugin: unknown): StackBuilder
      call(context: null, config: unknown): Sbot
    }
    const stack = SecretStack({ caps }) as StackBuilder
    const networkConfig = options.network === undefined ? {} : {
      connections: {
        incoming: options.network.listen === undefined ? {} : {
          net: [{
            host: options.network.listen.host ?? '127.0.0.1',
            port: options.network.listen.port,
            scope: options.network.listen.scope ?? 'device',
            transform: 'shs',
          }],
        },
        outgoing: { net: [{ transform: 'shs' }] },
      },
    }
    const sbot = stack.use(db2).use(db2EbtCompat).use(ebt).call(null, {
      path: options.path,
      keys,
      ...networkConfig,
      ...options.config,
    })
    await waitForIndex(sbot.db, 'base')
    await waitForIndex(sbot.db, 'ebt')
    await waitForEbt(sbot)
    // EBT only serves a local feed when it is part of the requested set. A
    // social-graph scheduler normally does this; Chronolog has no such ambient
    // graph, so it explicitly enables its own feed and only configured peers.
    sbot.ebt?.request(sbot.id, true)
    const transport = new SsbDb2Transport(sbot)
    for (const peer of options.network?.peers ?? []) await transport.connect(peer)
    return transport
  }

  get identity(): string {
    return this.#sbot.id
  }

  address(scope: 'device' | 'local' | 'public' = 'device'): string | undefined {
    try { return this.#sbot.getAddress?.(scope) } catch { return undefined }
  }

  requestFeed(feedId: string): void {
    if (!this.#sbot.ebt) throw new Error('SSB_EBT_UNAVAILABLE')
    this.#sbot.ebt.request(feedId, true)
  }

  feedReplicationStatus(feedId: string): unknown {
    return this.#sbot.ebt?.peerStatus?.(feedId)
  }

  async connect(peer: SsbPeer): Promise<void> {
    if (!this.#sbot.connect) throw new Error('SSB_NETWORK_UNAVAILABLE')
    this.requestFeed(peer.feedId)
    await new Promise<void>((resolve, reject) => {
      this.#sbot.connect!(peer.address, (error, rpc) => {
        if (error) reject(error)
        else {
          this.#peers.add(rpc?.id ?? peer.feedId)
          resolve()
        }
      })
    })
  }

  publish(payload: Uint8Array, _options: PublishOptions = {}): Promise<TransportRecord> {
    if (this.#closed) return Promise.reject(new Error('transport is closed'))
    return new Promise((resolve, reject) => {
      this.#sbot.db.create(
        {
          content: {
            type: 'chronolog-envelope/v1',
            payload: Buffer.from(payload).toString('base64'),
          },
        },
        (error, kvt) => {
          if (error) reject(error)
          else if (!kvt) reject(new Error('SSB-DB2 returned no persisted message'))
          else {
            const record = normalize(kvt)
            if (!record) reject(new Error('SSB-DB2 returned an invalid Chronolog message'))
            else resolve(record)
          }
        },
      )
    })
  }

  get(id: string): Promise<TransportRecord | undefined> {
    return new Promise((resolve, reject) => {
      this.#sbot.db.get(id, (error, value) => {
        if (error) {
          if (/not.?found/i.test(error.message)) resolve(undefined)
          else reject(error)
          return
        }
        if (!value) {
          resolve(undefined)
          return
        }
        resolve(normalize({ key: id, value }))
      })
    })
  }

  async history(): Promise<readonly TransportRecord[]> {
    const operators = require('ssb-db2/operators') as {
      where(operator: unknown): unknown
      type(value: string): unknown
      toCallback(callback: (error: Error | null, values?: SsbKvt[]) => void): unknown
    }
    return new Promise((resolve, reject) => {
      this.#sbot.db.query(
        operators.where(operators.type('chronolog-envelope/v1')),
        operators.toCallback((error, values) => {
          if (error) reject(error)
          else resolve((values ?? []).map(normalize).filter((value): value is TransportRecord => value !== undefined))
        }),
      )
    })
  }

  subscribe(signal?: AbortSignal): AsyncIterable<TransportRecord> {
    const queue = new AsyncQueue<TransportRecord>()
    this.#queueSubscribers.add(queue)
    void this.history().then(
      (records) => {
        for (const record of records) queue.push(record)
      },
      (error: unknown) => queue.fail(error),
    )
    const abort = () => {
      this.#queueSubscribers.delete(queue)
      queue.close()
    }
    if (signal?.aborted) abort()
    else signal?.addEventListener('abort', abort, { once: true })
    return queue
  }

  async status(): Promise<TransportStatus> {
    const history = await this.history()
    return {
      identity: this.identity,
      records: history.length,
      closed: this.#closed,
      peers: [...this.#peers].sort(),
    }
  }

  close(): Promise<void> {
    if (this.#closed) return Promise.resolve()
    this.#closed = true
    this.#unsubscribe?.()
    for (const subscriber of this.#queueSubscribers) subscriber.close()
    this.#queueSubscribers.clear()
    return new Promise((resolve, reject) => {
      this.#sbot.close((error) => error ? reject(error) : resolve())
    })
  }
}

function waitForIndex(database: SsbDb, indexName: string): Promise<void> {
  if (database.onDrain === undefined) return Promise.resolve()
  return new Promise((resolve) => database.onDrain!(indexName, resolve))
}

function waitForEbt(sbot: Sbot): Promise<void> {
  if (sbot.ebt?.clock === undefined) return Promise.resolve()
  return new Promise((resolve, reject) => {
    sbot.ebt!.clock!((error) => error ? reject(error) : resolve())
  })
}
