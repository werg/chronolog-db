import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { hostname } from 'node:os'
import { dirname, join } from 'node:path'

import { lock as lockFile } from 'proper-lockfile'

import { AsyncQueue } from './async-queue.js'
import type { ChronologTransport, PublishOptions, TransportRecord, TransportStatus } from './types.js'

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
  add(message: SsbKvt['value'], callback: (error: Error | null, kvt?: SsbKvt) => void): void
  get(id: string, callback: (error: Error | null, value?: SsbKvt['value']) => void): void
  query(...operators: unknown[]): unknown
  onMsgAdded(callback: (event: { kvt: SsbKvt }) => void): (() => void) | void
  onDrain?(indexName: string, callback: (error?: unknown) => void): void
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
  close?(error?: Error): void
}

export interface SsbPeer {
  readonly address: string
  readonly feedId: string
}

export interface SsbDb2TransportOptions {
  readonly path: string
  readonly secretPath?: string
  readonly keys?: unknown
  /** Extra SecretStack settings; first-class path, keys, and network options take precedence. */
  readonly config?: Readonly<Record<string, unknown>>
  /** @deprecated Retained for configuration compatibility; no polling is performed. */
  readonly catchUpIntervalMs?: number
  /** Rebuild disposable db2 indexes when the previous owner did not close cleanly. */
  readonly recoverIndexesOnUncleanClose?: boolean
  readonly network?: {
    readonly listen?: {
      readonly host?: string
      readonly port: number
      readonly scope?: 'device' | 'local' | 'public'
    }
    readonly peers?: readonly SsbPeer[]
    readonly reconnect?: false | {
      readonly initialDelayMs?: number
      readonly maximumDelayMs?: number
      readonly connectTimeoutMs?: number
      /** Recycle a nominally connected Chronolog feed that stops advancing. */
      readonly staleAfterMs?: number
    }
  }
}

interface ConfiguredPeerState {
  address: string
  feedId: string
  attempts: number
  nextAttemptAt: number
  lastError?: string
}

interface ReconnectOptions {
  readonly initialDelayMs: number
  readonly maximumDelayMs: number
  readonly connectTimeoutMs: number
  readonly staleAfterMs?: number
}

interface FeedProgress {
  sequence: bigint
  advancedAt: number
}

interface AuthorRecoveryFile {
  readonly format: 'chronolog-ssb-author-recovery'
  readonly records: readonly SsbKvt[]
}

interface TransportSubscriber {
  readonly queue: AsyncQueue<TransportRecord>
  readonly history: PullStreamIterable<SsbKvt, TransportRecord>
  readonly close: () => Promise<void>
}

interface StorageOwnership {
  readonly marker: string
  readonly token: string
  readonly recovered: boolean
  readonly releaseLease: () => Promise<void>
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
  readonly #queueSubscribers = new Set<TransportSubscriber>()
  readonly #peers = new Set<string>()
  readonly #configuredPeers = new Map<string, ConfiguredPeerState>()
  readonly #peerRpcs = new Map<string, Set<SsbRpc>>()
  readonly #feedProgress = new Map<string, FeedProgress>()
  readonly #connecting = new Set<string>()
  readonly #unsubscribe?: () => void
  #reconnectOptions?: ReconnectOptions
  #reconnectTimer?: ReturnType<typeof setInterval>
  readonly #ownership: StorageOwnership
  readonly #recoveredAfterUncleanClose: boolean
  readonly #authorRecovery: AuthorRecoveryStore
  readonly #pendingAdded: TransportRecord[] = []
  #progressDrainRunning = false
  #lastCatchUpError: string | undefined
  #closed = false

  private constructor(
    sbot: Sbot,
    ownership: StorageOwnership,
    authorRecovery: AuthorRecoveryStore,
  ) {
    this.#sbot = sbot
    this.#ownership = ownership
    this.#recoveredAfterUncleanClose = ownership.recovered
    this.#authorRecovery = authorRecovery
    const unsubscribe = sbot.db.onMsgAdded((event) => {
      const record = normalize(event.kvt)
      if (!record) return
      if (this.#pendingAdded.length >= MAXIMUM_PENDING_DURABILITY_EVENTS) {
        const error = new Error('SSB_DURABILITY_EVENT_OVERFLOW')
        this.#lastCatchUpError = error.message
        for (const subscriber of this.#queueSubscribers) {
          subscriber.queue.fail(error)
          void subscriber.close()
        }
        return
      }
      this.#pendingAdded.push(record)
      void this.#flushProgressAfterDrain()
    })
    if (typeof unsubscribe === 'function') this.#unsubscribe = unsubscribe
    sbot.on?.('rpc:connect', (...arguments_: unknown[]) => {
      const rpc = arguments_[0] as SsbRpc | undefined
      if (rpc?.id === undefined) return
      this.#registerRpc(rpc.id, rpc)
    })
  }

  static async open(options: SsbDb2TransportOptions): Promise<SsbDb2Transport> {
    // Retained as a validated compatibility option. Subscriptions now use a
    // backpressured snapshot plus db2's durable append hook and never poll.
    if (options.catchUpIntervalMs !== undefined) positiveInteger(options.catchUpIntervalMs, 'catchUpIntervalMs')
    const reconnectOptions = parseReconnectOptions(options.network?.reconnect)
    await mkdir(options.path, { recursive: true })
    const ownership = await claimStorage(options.path, options.recoverIndexesOnUncleanClose ?? true)
    let sbot: Sbot | undefined
    let transport: SsbDb2Transport | undefined
    try {
      const authorRecovery = new AuthorRecoveryStore(join(options.path, 'author-recovery.json'))
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
      sbot = stack.use(db2).use(db2EbtCompat).use(ebt).call(null, {
        ...options.config,
        path: options.path,
        keys,
        ...networkConfig,
      })
      await waitForIndex(sbot.db, 'base')
      await waitForIndex(sbot.db, 'ebt')
      await recoverAuthorTail(sbot.db, authorRecovery)
      await waitForEbt(sbot)
      // EBT only serves a local feed when it is part of the requested set. A
      // social-graph scheduler normally does this; Chronolog has no such ambient
      // graph, so it explicitly enables its own feed and only configured peers.
      sbot.ebt?.request(sbot.id, true)
      const created = new SsbDb2Transport(sbot, ownership, authorRecovery)
      transport = created
      if (reconnectOptions !== undefined) {
        created.#reconnectOptions = reconnectOptions
        created.configurePeers(options.network?.peers ?? [])
        created.#reconnectTimer = setInterval(
          () => { void created.#reconnectTick() },
          reconnectOptions.initialDelayMs,
        )
        created.#reconnectTimer.unref?.()
        void created.#reconnectTick()
      } else {
        for (const peer of options.network?.peers ?? []) await created.connect(peer)
      }
      return created
    } catch (error) {
      try {
        if (transport !== undefined) await transport.close()
        else if (sbot !== undefined) {
          await closeSbot(sbot)
          await releaseStorage(ownership)
        } else await releaseStorage(ownership)
      } catch (cleanupError) {
        throw new AggregateError(
          [asError(error), asError(cleanupError)],
          'SSB_OPEN_AND_CLEANUP_FAILED',
          { cause: cleanupError },
        )
      }
      throw error
    }
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

  /** Replaces the allow-listed replication peers without restarting the SSB database. */
  configurePeers(peers: readonly SsbPeer[]): void {
    const nextIds = new Set(peers.map((peer) => peer.feedId))
    for (const feedId of this.#configuredPeers.keys()) {
      if (!nextIds.has(feedId)) this.#configuredPeers.delete(feedId)
    }
    for (const peer of peers) {
      if (!peer.feedId.startsWith('@') || peer.address.length === 0) throw new Error('SSB_PEER_INVALID')
      this.requestFeed(peer.feedId)
      const current = this.#configuredPeers.get(peer.feedId)
      if (current) {
        current.address = peer.address
        current.nextAttemptAt = Math.min(current.nextAttemptAt, Date.now())
      } else {
        this.#configuredPeers.set(peer.feedId, { ...peer, attempts: 0, nextAttemptAt: Date.now() })
        this.#feedProgress.set(peer.feedId, { sequence: 0n, advancedAt: Date.now() })
      }
    }
    void this.#reconnectTick()
  }

  async connect(peer: SsbPeer): Promise<void> {
    if (this.#closed) throw new Error('transport is closed')
    if (!this.#sbot.connect) throw new Error('SSB_NETWORK_UNAVAILABLE')
    this.requestFeed(peer.feedId)
    await new Promise<void>((resolve, reject) => {
      this.#sbot.connect!(peer.address, (error, rpc) => {
        if (error) reject(error)
        else {
          if (rpc) this.#registerRpc(rpc.id ?? peer.feedId, rpc)
          else this.#peers.add(peer.feedId)
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
            try {
              // Persist the exact signed classic message synchronously before
              // the append log's debounced block write can become visible to
              // EBT. Retaining a tail window prevents a torn later rewrite
              // from rolling the local author behind an already-shared head.
              this.#authorRecovery.remember(kvt)
            } catch (error) {
              reject(error)
              return
            }
            const record = normalize(kvt)
            if (!record) reject(new Error('SSB-DB2 returned an invalid Chronolog message'))
            else {
              // create() returns when the record is only in db2's in-memory
              // block. A successful Chronolog publish is a durability promise.
              void waitForIndex(this.#sbot.db, 'base').then(() => resolve(record), reject)
            }
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
          else {
            const records = (values ?? []).map(normalize).filter((value): value is TransportRecord => value !== undefined)
            for (const record of records) this.#noteProgress(record)
            resolve(records)
          }
        }),
      )
    })
  }

  subscribe(signal?: AbortSignal): AsyncIterable<TransportRecord> {
    if (this.#closed || signal?.aborted) return emptyAsyncIterable()
    const operators = require('ssb-db2/operators') as {
      where(operator: unknown): unknown
      type(value: string): unknown
      batch(size: number): unknown
      toPullStream(): unknown
    }
    const source = this.#sbot.db.query(
      operators.where(operators.type('chronolog-envelope/v1')),
      operators.batch(256),
      operators.toPullStream(),
    ) as PullSource<SsbKvt>
    const history = new PullStreamIterable(source, signal, async (kvt) => {
      await waitForIndex(this.#sbot.db, 'base')
      const record = normalize(kvt)
      if (record === undefined) throw new Error('SSB_CHRONOLOG_RECORD_INVALID')
      this.#noteProgress(record)
      return record
    }, (error) => {
      if (error !== undefined && !this.#closed) {
        this.#lastCatchUpError = asError(error).message
      }
    })
    const queue = new AsyncQueue<TransportRecord>(4_096)
    const closeSubscriber = async () => {
      signal?.removeEventListener('abort', abort)
      this.#queueSubscribers.delete(subscriber)
      queue.close()
      await history.close()
    }
    const abort = () => { void closeSubscriber() }
    const subscriber: TransportSubscriber = { queue, history, close: closeSubscriber }
    this.#queueSubscribers.add(subscriber)
    signal?.addEventListener('abort', abort, { once: true })
    return {
      async *[Symbol.asyncIterator]() {
        const maximumSequences = new Map<string, bigint>()
        try {
          for await (const record of history) {
            const maximum = maximumSequences.get(record.author) ?? 0n
            if (record.sequence > maximum) maximumSequences.set(record.author, record.sequence)
            yield record
          }
          for await (const record of subscriber.queue) {
            const maximum = maximumSequences.get(record.author) ?? 0n
            if (record.sequence <= maximum) continue
            maximumSequences.set(record.author, record.sequence)
            yield record
          }
        } finally {
          await closeSubscriber()
        }
      },
    }
  }

  async status(): Promise<TransportStatus> {
    const [records, clock] = await Promise.all([countChronologRecords(this.#sbot.db), readEbtClock(this.#sbot)])
    const feedIds = new Set([...Object.keys(clock), ...this.#feedProgress.keys(), ...this.#configuredPeers.keys()])
    const feedStates = [...feedIds].map((feedId) => {
      const contiguousThrough = BigInt(clock[feedId] ?? 0)
      const maximumSequence = bigintMaximum(contiguousThrough, this.#feedProgress.get(feedId)?.sequence ?? 0n)
      return {
        feedId,
        contiguousThrough: contiguousThrough.toString(10),
        maximumSequence: maximumSequence.toString(10),
        hasGaps: maximumSequence > contiguousThrough,
      }
    }).sort((left, right) => left.feedId.localeCompare(right.feedId))
    return {
      identity: this.identity,
      records,
      closed: this.#closed,
      peers: [...this.#peers].sort(),
      configuredPeers: [...this.#configuredPeers.values()]
        .sort((left, right) => left.feedId.localeCompare(right.feedId))
        .map((peer) => ({
          feedId: peer.feedId,
          address: peer.address,
          connected: this.#peers.has(peer.feedId),
          attempts: peer.attempts,
          ...(peer.lastError === undefined ? {} : { lastError: peer.lastError }),
          ...(this.#feedProgress.get(peer.feedId) === undefined ? {} : { lastProgressAt: this.#feedProgress.get(peer.feedId)!.advancedAt }),
          maximumSequence: (clock[peer.feedId] ?? this.#feedProgress.get(peer.feedId)?.sequence ?? 0).toString(),
        })),
      feedStates,
      feedsWithGaps: feedStates.filter((feed) => feed.hasGaps).length,
      ...(this.#lastCatchUpError === undefined ? {} : { lastCatchUpError: this.#lastCatchUpError }),
      ...(this.#recoveredAfterUncleanClose ? { recoveredAfterUncleanClose: true } : {}),
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    if (this.#reconnectTimer) clearInterval(this.#reconnectTimer)
    this.#unsubscribe?.()
    await Promise.all([...this.#queueSubscribers].map((subscriber) => subscriber.close()))
    this.#queueSubscribers.clear()
    await closeSbot(this.#sbot)
    await releaseStorage(this.#ownership)
  }

  async #reconnectTick(): Promise<void> {
    if (this.#closed || this.#reconnectOptions === undefined) return
    const now = Date.now()
    await Promise.all([...this.#configuredPeers.values()].map(async (peer) => {
      const progress = this.#feedProgress.get(peer.feedId)
      const stale = this.#reconnectOptions!.staleAfterMs !== undefined && progress !== undefined &&
        now - progress.advancedAt >= this.#reconnectOptions!.staleAfterMs
      if (this.#peers.has(peer.feedId) && !stale) return
      if (stale) this.#recyclePeer(peer.feedId, now)
      if (this.#connecting.has(peer.feedId) || peer.nextAttemptAt > now) return
      this.#connecting.add(peer.feedId)
      try {
        await withTimeout(this.connect(peer), this.#reconnectOptions!.connectTimeoutMs)
        peer.attempts = 0
        peer.nextAttemptAt = Number.MAX_SAFE_INTEGER
        delete peer.lastError
      } catch (error) {
        peer.attempts += 1
        peer.lastError = error instanceof Error ? error.message : String(error)
        const delay = Math.min(
          this.#reconnectOptions!.maximumDelayMs,
          this.#reconnectOptions!.initialDelayMs * 2 ** Math.min(peer.attempts - 1, 20),
        )
        peer.nextAttemptAt = Date.now() + delay
      } finally {
        this.#connecting.delete(peer.feedId)
      }
    }))
  }

  #registerRpc(feedId: string, rpc: SsbRpc): void {
    this.#peers.add(feedId)
    const connections = this.#peerRpcs.get(feedId) ?? new Set<SsbRpc>()
    if (connections.has(rpc)) return
    connections.add(rpc)
    this.#peerRpcs.set(feedId, connections)
    let closed = false
    rpc.on?.('closed', () => {
      if (closed) return
      closed = true
      connections.delete(rpc)
      if (connections.size > 0) return
      this.#peerRpcs.delete(feedId)
      this.#peers.delete(feedId)
      const configured = this.#configuredPeers.get(feedId)
      if (configured) configured.nextAttemptAt = Date.now()
    })
  }

  #recyclePeer(feedId: string, now: number): void {
    this.#feedProgress.set(feedId, { sequence: this.#feedProgress.get(feedId)?.sequence ?? 0n, advancedAt: now })
    const connections = this.#peerRpcs.get(feedId)
    if (connections) for (const rpc of connections) rpc.close?.(new Error('SSB_FEED_PROGRESS_STALE'))
    this.#peerRpcs.delete(feedId)
    this.#peers.delete(feedId)
    const configured = this.#configuredPeers.get(feedId)
    if (configured) configured.nextAttemptAt = now
  }

  #noteProgress(record: TransportRecord): void {
    const current = this.#feedProgress.get(record.author)
    if (current !== undefined && record.sequence <= current.sequence) return
    this.#feedProgress.set(record.author, { sequence: record.sequence, advancedAt: Date.now() })
  }

  async #flushProgressAfterDrain(): Promise<void> {
    if (this.#closed || this.#progressDrainRunning) return
    this.#progressDrainRunning = true
    try {
      while (!this.#closed && this.#pendingAdded.length > 0) {
        await waitForIndex(this.#sbot.db, 'base')
        const records = this.#pendingAdded.splice(0)
        for (const record of records) {
          this.#noteProgress(record)
          for (const subscriber of this.#queueSubscribers) {
            if (!subscriber.queue.push(record)) void subscriber.close()
          }
        }
      }
      this.#lastCatchUpError = undefined
    } catch (error) {
      if (!this.#closed) this.#lastCatchUpError = error instanceof Error ? error.message : String(error)
    } finally {
      this.#progressDrainRunning = false
      if (!this.#closed && this.#pendingAdded.length > 0) void this.#flushProgressAfterDrain()
    }
  }
}

const MAXIMUM_PENDING_DURABILITY_EVENTS = 4_096

type PullEnd = true | Error | null
type PullSource<T> = (end: PullEnd, callback: (end: PullEnd, value?: T) => void) => void

class PullStreamIterable<Input, Output> implements AsyncIterable<Output>, AsyncIterator<Output> {
  #pending: {
    readonly resolve: (result: IteratorResult<Output>) => void
    readonly reject: (error: unknown) => void
  } | undefined
  #closed = false
  #finished = false
  readonly #abort = () => { void this.close() }

  constructor(
    readonly source: PullSource<Input>,
    readonly signal: AbortSignal | undefined,
    readonly transform: (value: Input) => Output | Promise<Output>,
    readonly onDone: (error?: unknown) => void,
  ) {
    if (signal?.aborted) this.#closed = true
    else signal?.addEventListener('abort', this.#abort, { once: true })
  }

  [Symbol.asyncIterator](): AsyncIterator<Output> { return this }

  next(): Promise<IteratorResult<Output>> {
    if (this.#closed) return Promise.resolve({ value: undefined, done: true })
    if (this.#pending !== undefined) return Promise.reject(new Error('SSB_SUBSCRIPTION_CONCURRENT_NEXT'))
    return new Promise((resolve, reject) => {
      const pending = { resolve, reject }
      this.#pending = pending
      this.source(null, (end, value) => {
        if (this.#pending !== pending) return
        if (end) {
          this.#pending = undefined
          if (end instanceof Error) {
            reject(end)
            this.#finish(end)
          } else {
            resolve({ value: undefined, done: true })
            this.#finish()
          }
          return
        }
        if (value === undefined) {
          this.#pending = undefined
          const error = new Error('SSB_SUBSCRIPTION_MISSING_VALUE')
          reject(error)
          this.#finish(error)
          return
        }
        void Promise.resolve(this.transform(value)).then(
          (transformed) => {
            if (this.#pending !== pending) return
            this.#pending = undefined
            resolve({ value: transformed, done: false })
          },
          (error: unknown) => {
            if (this.#pending !== pending) return
            this.#pending = undefined
            reject(error)
            this.#finish(error)
          },
        )
      })
    })
  }

  async return(): Promise<IteratorResult<Output>> {
    await this.close()
    return { value: undefined, done: true }
  }

  async throw(error?: unknown): Promise<IteratorResult<Output>> {
    this.#finish(error ?? new Error('SSB_SUBSCRIPTION_ABORTED'))
    throw error
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    const pending = this.#pending
    this.#pending = undefined
    pending?.resolve({ value: undefined, done: true })
    try { this.source(true, () => {}) } catch { /* Source was already closed. */ }
    this.#finish()
  }

  #finish(error?: unknown): void {
    if (this.#finished) return
    this.#finished = true
    this.#closed = true
    this.signal?.removeEventListener('abort', this.#abort)
    try { this.source(true, () => {}) } catch { /* Source was already closed. */ }
    this.onDone(error)
  }
}

const AUTHOR_RECOVERY_WINDOW = 1_024

class AuthorRecoveryStore {
  readonly #records = new Map<number, SsbKvt>()

  constructor(readonly path: string) {
    if (!existsSync(path)) return
    const decoded = JSON.parse(readFileSync(path, 'utf8')) as unknown
    if (!isAuthorRecoveryFile(decoded)) throw new Error('SSB_AUTHOR_RECOVERY_FILE_INVALID')
    for (const record of decoded.records) this.#records.set(record.value.sequence, record)
  }

  records(): readonly SsbKvt[] { return [...this.#records.values()].sort((left, right) => left.value.sequence - right.value.sequence) }

  remember(record: SsbKvt): void {
    const existing = this.#records.get(record.value.sequence)
    if (existing !== undefined && existing.key !== record.key) throw new Error('SSB_AUTHOR_RECOVERY_SEQUENCE_CONFLICT')
    this.#records.set(record.value.sequence, record)
    const ordered = this.records()
    for (const stale of ordered.slice(0, Math.max(0, ordered.length - AUTHOR_RECOVERY_WINDOW))) this.#records.delete(stale.value.sequence)
    this.#persist()
  }

  #persist(): void {
    const temporary = `${this.path}.tmp`
    const value: AuthorRecoveryFile = { format: 'chronolog-ssb-author-recovery', records: this.records() }
    writeFileSync(temporary, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600 })
    fsyncFile(temporary)
    renameSync(temporary, this.path)
    fsyncDirectory(dirname(this.path))
  }
}

async function recoverAuthorTail(database: SsbDb, recovery: AuthorRecoveryStore): Promise<void> {
  for (const record of recovery.records()) {
    if (await databaseHas(database, record.key)) continue
    await new Promise<void>((resolve, reject) => database.add(record.value, (error, added) => {
      if (error) reject(new Error('SSB_AUTHOR_TAIL_RECOVERY_FAILED', { cause: error }))
      else if (added?.key !== record.key) reject(new Error('SSB_AUTHOR_TAIL_RECOVERY_ID_MISMATCH'))
      else resolve()
    }))
  }
  await waitForIndex(database, 'base')
}

function databaseHas(database: SsbDb, id: string): Promise<boolean> {
  return new Promise((resolve, reject) => database.get(id, (error, value) => {
    if (error) {
      if (/not.?found/i.test(error.message)) resolve(false)
      else reject(error)
    } else resolve(value !== undefined)
  }))
}

function isAuthorRecoveryFile(value: unknown): value is AuthorRecoveryFile {
  if (typeof value !== 'object' || value === null || (value as { format?: unknown }).format !== 'chronolog-ssb-author-recovery') return false
  const records = (value as { records?: unknown }).records
  return Array.isArray(records) && records.every((record) => {
    if (typeof record !== 'object' || record === null) return false
    const candidate = record as { key?: unknown; value?: { author?: unknown; sequence?: unknown; previous?: unknown; content?: unknown } }
    return typeof candidate.key === 'string' && typeof candidate.value?.author === 'string' &&
      Number.isSafeInteger(candidate.value.sequence) && Number(candidate.value.sequence) >= 1 &&
      (candidate.value.previous === null || typeof candidate.value.previous === 'string') && candidate.value.content !== undefined
  })
}

function fsyncFile(path: string): void {
  const descriptor = openSync(path, 'r')
  try { fsyncSync(descriptor) } finally { closeSync(descriptor) }
}

function fsyncDirectory(path: string): void {
  const descriptor = openSync(path, 'r')
  try { fsyncSync(descriptor) } finally { closeSync(descriptor) }
}

const OWNERSHIP_MARKER = '.chronolog-ssb-open'
const OWNERSHIP_LEASE = '.chronolog-ssb-owner'
const OWNERSHIP_FORMAT = 'chronolog-ssb-owner-v1'

interface OwnershipMarkerFile {
  readonly format: typeof OWNERSHIP_FORMAT
  readonly pid: number
  readonly hostname: string
  readonly token: string
  readonly openedAt: string
  /** Linux process start tick, used to distinguish PID reuse after restart. */
  readonly processStart?: string
}

interface LegacyOwnershipMarkerFile {
  readonly pid: number
  readonly openedAt: string
}

type ObservedOwnershipMarker = OwnershipMarkerFile | LegacyOwnershipMarkerFile

async function claimStorage(path: string, recover: boolean): Promise<StorageOwnership> {
  const marker = join(path, OWNERSHIP_MARKER)
  // Fast, conservative preflight. The lease below is the authority; this only
  // avoids waiting through retries when an older/current owner is plainly live.
  const preflight = await readOwnershipMarker(marker)
  if (preflight !== undefined && ownerLiveness(preflight) === true) throw new Error('SSB_STORAGE_IN_USE')
  let releaseLease: (() => Promise<void>) | undefined
  try {
    releaseLease = await lockFile(join(path, OWNERSHIP_LEASE), {
      realpath: false,
      stale: 5_000,
      update: 1_000,
      retries: { retries: 30, factor: 1, minTimeout: 200, maxTimeout: 200, randomize: true },
    })
  } catch (error) {
    throw new Error('SSB_STORAGE_IN_USE', { cause: error })
  }
  try {
    const previousOwner = await readOwnershipMarker(marker)
    // The lease is authoritative across containers/hosts. A marker from a
    // different hostname has unknown PID liveness locally, but after acquiring
    // a non-live/stale lease it is safe to recover. A same-host live PID still
    // prevents stale-lock stealing during event-loop stalls.
    if (previousOwner !== undefined && ownerLiveness(previousOwner) === true) throw new Error('SSB_STORAGE_IN_USE')
    const recovered = previousOwner !== undefined
    if (recovered && !recover) throw new Error('SSB_STORAGE_UNCLEAN_CLOSE')
    if (recovered) {
      // db2/jit and db2/indexes are rebuildable projections of log.bipf. An
      // abrupt kill can leave them beyond the append-only log's recovered tail.
      // The exclusive lease is already held before anything is removed.
      await Promise.all([
        rm(join(path, 'db2', 'jit'), { recursive: true, force: true }),
        rm(join(path, 'db2', 'indexes'), { recursive: true, force: true }),
      ])
    }
    const token = randomUUID()
    const processStart = readProcessStart(process.pid)
    const contents: OwnershipMarkerFile = {
      format: OWNERSHIP_FORMAT,
      pid: process.pid,
      hostname: hostname(),
      token,
      openedAt: new Date().toISOString(),
      ...(processStart === undefined ? {} : { processStart }),
    }
    await writeFile(marker, `${JSON.stringify(contents)}\n`, { encoding: 'utf8', flag: 'w', mode: 0o600 })
    fsyncFile(marker)
    fsyncDirectory(path)
    return { marker, token, recovered, releaseLease }
  } catch (error) {
    await releaseLease()
    throw error
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`SSB_RECONNECT_INVALID_${field.toUpperCase()}`)
  return value
}

function parseReconnectOptions(
  value: NonNullable<SsbDb2TransportOptions['network']>['reconnect'] | undefined,
): ReconnectOptions | undefined {
  if (value === false) return undefined
  const reconnect = value ?? {}
  const options: ReconnectOptions = {
    initialDelayMs: positiveInteger(reconnect.initialDelayMs ?? 250, 'initialDelayMs'),
    maximumDelayMs: positiveInteger(reconnect.maximumDelayMs ?? 10_000, 'maximumDelayMs'),
    connectTimeoutMs: positiveInteger(reconnect.connectTimeoutMs ?? 5_000, 'connectTimeoutMs'),
    ...(reconnect.staleAfterMs === undefined ? {} : { staleAfterMs: positiveInteger(reconnect.staleAfterMs, 'staleAfterMs') }),
  }
  if (options.maximumDelayMs < options.initialDelayMs) throw new Error('SSB_RECONNECT_MAXIMUM_BEFORE_INITIAL')
  return options
}

async function readOwnershipMarker(path: string): Promise<ObservedOwnershipMarker | undefined> {
  let decoded: unknown
  try {
    decoded = JSON.parse(await readFile(path, 'utf8')) as unknown
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return undefined
    throw new Error('SSB_STORAGE_OWNER_INVALID', { cause: error })
  }
  if (!isOwnershipMarkerFile(decoded) && !isLegacyOwnershipMarkerFile(decoded)) {
    throw new Error('SSB_STORAGE_OWNER_INVALID')
  }
  return decoded
}

function isOwnershipMarkerFile(value: unknown): value is OwnershipMarkerFile {
  if (typeof value !== 'object' || value === null) return false
  const marker = value as Partial<OwnershipMarkerFile>
  return marker.format === OWNERSHIP_FORMAT && Number.isSafeInteger(marker.pid) && Number(marker.pid) > 0 &&
    typeof marker.hostname === 'string' && marker.hostname.length > 0 && typeof marker.token === 'string' &&
    marker.token.length > 0 && typeof marker.openedAt === 'string' &&
    (marker.processStart === undefined || typeof marker.processStart === 'string')
}

function isLegacyOwnershipMarkerFile(value: unknown): value is LegacyOwnershipMarkerFile {
  if (typeof value !== 'object' || value === null) return false
  const marker = value as Partial<LegacyOwnershipMarkerFile>
  return Number.isSafeInteger(marker.pid) && Number(marker.pid) > 0 && typeof marker.openedAt === 'string'
}

function ownerLiveness(owner: ObservedOwnershipMarker): boolean | undefined {
  if ('hostname' in owner && owner.hostname !== hostname()) return undefined
  try {
    process.kill(owner.pid, 0)
    if ('processStart' in owner && owner.processStart !== undefined) {
      const currentStart = readProcessStart(owner.pid)
      if (currentStart !== undefined && currentStart !== owner.processStart) return false
    }
    return true
  } catch (error) {
    return hasErrorCode(error, 'ESRCH') ? false : undefined
  }
}

function readProcessStart(pid: number): string | undefined {
  if (process.platform !== 'linux') return undefined
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const fields = stat.slice(stat.lastIndexOf(') ') + 2).trim().split(/\s+/u)
    const startTicks = fields[19]
    return startTicks === undefined ? undefined : startTicks
  } catch {
    return undefined
  }
}

async function releaseStorage(ownership: StorageOwnership): Promise<void> {
  let markerError: unknown
  try {
    const marker = await readOwnershipMarker(ownership.marker)
    if (marker !== undefined && (!('token' in marker) || marker.token !== ownership.token)) {
      throw new Error('SSB_STORAGE_OWNERSHIP_LOST')
    }
    await rm(ownership.marker, { force: true })
    fsyncDirectory(dirname(ownership.marker))
  } catch (error) {
    markerError = error
  }
  try {
    await ownership.releaseLease()
  } catch (error) {
    if (markerError !== undefined) {
      throw new AggregateError(
        [asError(markerError), asError(error)],
        'SSB_STORAGE_RELEASE_FAILED',
        { cause: error },
      )
    }
    throw error
  }
  if (markerError !== undefined) throw asError(markerError)
}

function closeSbot(sbot: Sbot): Promise<void> {
  return new Promise((resolve, reject) => sbot.close((error) => {
    if (error && !hasErrorCode(error, 'ERR_SERVER_NOT_RUNNING')) reject(error)
    else resolve()
  }))
}

function countChronologRecords(database: SsbDb): Promise<number> {
  const operators = require('ssb-db2/operators') as {
    where(operator: unknown): unknown
    type(value: string): unknown
    count(): unknown
    toCallback(callback: (error: Error | null, count?: number) => void): unknown
  }
  return new Promise((resolve, reject) => database.query(
    operators.where(operators.type('chronolog-envelope/v1')),
    operators.count(),
    operators.toCallback((error, count) => error ? reject(error) : resolve(count ?? 0)),
  ))
}

function readEbtClock(sbot: Sbot): Promise<Readonly<Record<string, number>>> {
  if (sbot.ebt?.clock === undefined) return Promise.resolve({})
  return new Promise((resolve, reject) => sbot.ebt!.clock!((error, clock) => error ? reject(error) : resolve(clock ?? {})))
}

function bigintMaximum(left: bigint, right: bigint): bigint { return left > right ? left : right }

function emptyAsyncIterable<T>(): AsyncIterable<T> {
  return { async *[Symbol.asyncIterator]() {} }
}

function asError(value: unknown): Error {
  if (value instanceof Error) return value
  return new Error(typeof value === 'string' ? value : 'UNKNOWN_ERROR')
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('SSB_CONNECT_TIMEOUT')), timeoutMs)
    timer.unref?.()
    promise.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error: unknown) => { clearTimeout(timer); reject(error) },
    )
  })
}

function waitForIndex(database: SsbDb, indexName: string): Promise<void> {
  if (database.onDrain === undefined) return Promise.resolve()
  return new Promise((resolve, reject) => database.onDrain!(indexName, (error) => error === undefined ? resolve() : reject(error)))
}

function waitForEbt(sbot: Sbot): Promise<void> {
  if (sbot.ebt?.clock === undefined) return Promise.resolve()
  return new Promise((resolve, reject) => {
    sbot.ebt!.clock!((error) => error ? reject(error) : resolve())
  })
}
