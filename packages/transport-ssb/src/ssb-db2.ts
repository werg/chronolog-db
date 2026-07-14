import { mkdir, rm, writeFile } from 'node:fs/promises'
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

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
  query(...operators: unknown[]): void
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
  readonly config?: Readonly<Record<string, unknown>>
  /** Polling safety net for replicated records not surfaced by db2's live hook. */
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
  readonly seen: Set<string>
  timer?: ReturnType<typeof setInterval>
  polling: boolean
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
  readonly #catchUpIntervalMs: number
  readonly #ownershipMarker: string
  readonly #recoveredAfterUncleanClose: boolean
  readonly #authorRecovery: AuthorRecoveryStore
  #lastCatchUpError: string | undefined
  #closed = false

  private constructor(
    sbot: Sbot,
    catchUpIntervalMs: number,
    ownershipMarker: string,
    recoveredAfterUncleanClose: boolean,
    authorRecovery: AuthorRecoveryStore,
  ) {
    this.#sbot = sbot
    this.#catchUpIntervalMs = catchUpIntervalMs
    this.#ownershipMarker = ownershipMarker
    this.#recoveredAfterUncleanClose = recoveredAfterUncleanClose
    this.#authorRecovery = authorRecovery
    const unsubscribe = sbot.db.onMsgAdded((event) => {
      // db2 announces an append before async-append-only-log's debounced write
      // is fsynced. Never let the node persist control/materialized state ahead
      // of the authoritative transport log.
      void waitForIndex(sbot.db, 'base').then(() => {
        if (this.#closed) return
        const record = normalize(event.kvt)
        if (!record) return
        this.#noteProgress(record)
        for (const subscriber of this.#queueSubscribers) this.#deliver(subscriber, record)
      }).catch((error: unknown) => {
        if (!this.#closed) this.#lastCatchUpError = error instanceof Error ? error.message : String(error)
      })
    })
    if (typeof unsubscribe === 'function') this.#unsubscribe = unsubscribe
    sbot.on?.('rpc:connect', (...arguments_: unknown[]) => {
      const rpc = arguments_[0] as SsbRpc | undefined
      if (rpc?.id === undefined) return
      this.#registerRpc(rpc.id, rpc)
    })
  }

  static async open(options: SsbDb2TransportOptions): Promise<SsbDb2Transport> {
    await mkdir(options.path, { recursive: true })
    const ownership = await claimStorage(options.path, options.recoverIndexesOnUncleanClose ?? true)
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
    const sbot = stack.use(db2).use(db2EbtCompat).use(ebt).call(null, {
      path: options.path,
      keys,
      ...networkConfig,
      ...options.config,
    })
    await waitForIndex(sbot.db, 'base')
    await waitForIndex(sbot.db, 'ebt')
    await recoverAuthorTail(sbot.db, authorRecovery)
    await waitForEbt(sbot)
    // EBT only serves a local feed when it is part of the requested set. A
    // social-graph scheduler normally does this; Chronolog has no such ambient
    // graph, so it explicitly enables its own feed and only configured peers.
    sbot.ebt?.request(sbot.id, true)
    const transport = new SsbDb2Transport(
      sbot,
      positiveInteger(options.catchUpIntervalMs ?? 1_000, 'catchUpIntervalMs'),
      ownership.marker,
      ownership.recovered,
      authorRecovery,
    )
    if (options.network?.reconnect !== false) {
      const reconnect = options.network?.reconnect ?? {}
      transport.#reconnectOptions = {
        initialDelayMs: positiveInteger(reconnect.initialDelayMs ?? 250, 'initialDelayMs'),
        maximumDelayMs: positiveInteger(reconnect.maximumDelayMs ?? 10_000, 'maximumDelayMs'),
        connectTimeoutMs: positiveInteger(reconnect.connectTimeoutMs ?? 5_000, 'connectTimeoutMs'),
        ...(reconnect.staleAfterMs === undefined ? {} : { staleAfterMs: positiveInteger(reconnect.staleAfterMs, 'staleAfterMs') }),
      }
      if (transport.#reconnectOptions.maximumDelayMs < transport.#reconnectOptions.initialDelayMs) {
        throw new Error('SSB_RECONNECT_MAXIMUM_BEFORE_INITIAL')
      }
      transport.configurePeers(options.network?.peers ?? [])
      transport.#reconnectTimer = setInterval(
        () => { void transport.#reconnectTick() },
        transport.#reconnectOptions.initialDelayMs,
      )
      transport.#reconnectTimer.unref?.()
      void transport.#reconnectTick()
    } else {
      for (const peer of options.network?.peers ?? []) await transport.connect(peer)
    }
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
    const queue = new AsyncQueue<TransportRecord>()
    const subscriber: TransportSubscriber = { queue, seen: new Set(), polling: false }
    this.#queueSubscribers.add(subscriber)
    void this.#catchUp(subscriber)
    subscriber.timer = setInterval(() => { void this.#catchUp(subscriber) }, this.#catchUpIntervalMs)
    subscriber.timer.unref?.()
    const abort = () => {
      this.#queueSubscribers.delete(subscriber)
      if (subscriber.timer) clearInterval(subscriber.timer)
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
      configuredPeers: [...this.#configuredPeers.values()]
        .sort((left, right) => left.feedId.localeCompare(right.feedId))
        .map((peer) => ({
          feedId: peer.feedId,
          address: peer.address,
          connected: this.#peers.has(peer.feedId),
          attempts: peer.attempts,
          ...(peer.lastError === undefined ? {} : { lastError: peer.lastError }),
          ...(this.#feedProgress.get(peer.feedId) === undefined ? {} : {
            lastProgressAt: this.#feedProgress.get(peer.feedId)!.advancedAt,
            maximumSequence: this.#feedProgress.get(peer.feedId)!.sequence.toString(10),
          }),
        })),
      ...(this.#lastCatchUpError === undefined ? {} : { lastCatchUpError: this.#lastCatchUpError }),
      ...(this.#recoveredAfterUncleanClose ? { recoveredAfterUncleanClose: true } : {}),
    }
  }

  close(): Promise<void> {
    if (this.#closed) return Promise.resolve()
    this.#closed = true
    if (this.#reconnectTimer) clearInterval(this.#reconnectTimer)
    this.#unsubscribe?.()
    for (const subscriber of this.#queueSubscribers) {
      if (subscriber.timer) clearInterval(subscriber.timer)
      subscriber.queue.close()
    }
    this.#queueSubscribers.clear()
    return new Promise<void>((resolve, reject) => {
      this.#sbot.close((error) => {
        // multiserver may observe the remote half closing its listener while
        // two connected peers are shutting down concurrently. Node reports
        // that already-complete state as ERR_SERVER_NOT_RUNNING; transport
        // close is idempotent, so it is safe to finish releasing ownership.
        if (error && !hasErrorCode(error, 'ERR_SERVER_NOT_RUNNING')) reject(error)
        else resolve()
      })
    }).then(() => rm(this.#ownershipMarker, { force: true }))
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

  #deliver(subscriber: TransportSubscriber, record: TransportRecord): void {
    if (subscriber.seen.has(record.id)) return
    subscriber.seen.add(record.id)
    subscriber.queue.push(record)
  }

  async #catchUp(subscriber: TransportSubscriber): Promise<void> {
    if (this.#closed || subscriber.polling || !this.#queueSubscribers.has(subscriber)) return
    subscriber.polling = true
    try {
      for (const record of await this.history()) this.#deliver(subscriber, record)
      this.#lastCatchUpError = undefined
    } catch (error) {
      if (!this.#closed) this.#lastCatchUpError = error instanceof Error ? error.message : String(error)
    } finally {
      subscriber.polling = false
    }
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

async function claimStorage(path: string, recover: boolean): Promise<{ marker: string; recovered: boolean }> {
  const marker = join(path, OWNERSHIP_MARKER)
  const contents = `${JSON.stringify({ pid: process.pid, openedAt: new Date().toISOString() })}\n`
  try {
    await writeFile(marker, contents, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    return { marker, recovered: false }
  } catch (error) {
    if (!isAlreadyExists(error)) throw error
  }
  if (!recover) throw new Error('SSB_STORAGE_UNCLEAN_CLOSE')

  // db2/jit and db2/indexes are rebuildable projections of log.bipf. An
  // abrupt kill can leave them pointing beyond the append-only log's recovered
  // tail. Never remove the log, feed keys, or EBT replication state here.
  await Promise.all([
    rm(join(path, 'db2', 'jit'), { recursive: true, force: true }),
    rm(join(path, 'db2', 'indexes'), { recursive: true, force: true }),
  ])
  await writeFile(marker, contents, { encoding: 'utf8', flag: 'w', mode: 0o600 })
  return { marker, recovered: true }
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST'
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`SSB_RECONNECT_INVALID_${field.toUpperCase()}`)
  return value
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
