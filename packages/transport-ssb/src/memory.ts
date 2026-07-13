import { createHash, randomBytes } from 'node:crypto'

import { AsyncQueue } from './async-queue.js'
import { cloneRecord, type ChronologTransport, type PublishOptions, type TransportRecord, type TransportStatus } from './types.js'

function recordId(
  author: string,
  sequence: bigint,
  previous: string | undefined,
  payload: Uint8Array,
): string {
  const hash = createHash('sha256')
  hash.update('chronolog-memory-ssb-v1\0')
  hash.update(author)
  hash.update('\0')
  hash.update(sequence.toString(10))
  hash.update('\0')
  hash.update(previous ?? '')
  hash.update('\0')
  hash.update(payload)
  return `%${hash.digest('base64')}.sha256`
}

export class MemoryTransportNetwork {
  readonly #nodes = new Map<string, MemoryTransport>()
  readonly #links = new Set<string>()

  createNode(identity = `@${randomBytes(32).toString('base64')}.ed25519`): MemoryTransport {
    if (this.#nodes.has(identity)) throw new Error(`duplicate transport identity: ${identity}`)
    const node = new MemoryTransport(this, identity)
    this.#nodes.set(identity, node)
    return node
  }

  connect(left: string | MemoryTransport, right: string | MemoryTransport): void {
    const a = typeof left === 'string' ? this.#require(left) : left
    const b = typeof right === 'string' ? this.#require(right) : right
    if (a.identity === b.identity) return
    this.#links.add(this.#key(a.identity, b.identity))
    this.#links.add(this.#key(b.identity, a.identity))
    this.#synchronize(a, b)
    this.#synchronize(b, a)
  }

  disconnect(left: string | MemoryTransport, right: string | MemoryTransport): void {
    const a = typeof left === 'string' ? left : left.identity
    const b = typeof right === 'string' ? right : right.identity
    this.#links.delete(this.#key(a, b))
    this.#links.delete(this.#key(b, a))
  }

  connectAll(): void {
    const nodes = [...this.#nodes.values()]
    for (let i = 0; i < nodes.length; i += 1) {
      for (let j = i + 1; j < nodes.length; j += 1) {
        const left = nodes[i]
        const right = nodes[j]
        if (left && right) this.connect(left, right)
      }
    }
  }

  peers(identity: string): readonly string[] {
    return [...this.#nodes.keys()].filter((peer) => this.#links.has(this.#key(identity, peer)))
  }

  publish(source: MemoryTransport, record: TransportRecord): void {
    source.receive(record)
    for (const peer of this.peers(source.identity)) this.#nodes.get(peer)?.receive(record)
  }

  remove(identity: string): void {
    this.#nodes.delete(identity)
    for (const key of [...this.#links]) {
      if (key.startsWith(`${identity}\0`) || key.endsWith(`\0${identity}`)) this.#links.delete(key)
    }
  }

  #synchronize(source: MemoryTransport, target: MemoryTransport): void {
    for (const record of source.localHistory()) target.receive(record)
  }

  #require(identity: string): MemoryTransport {
    const node = this.#nodes.get(identity)
    if (!node) throw new Error(`unknown transport identity: ${identity}`)
    return node
  }

  #key(left: string, right: string): string {
    return `${left}\0${right}`
  }
}

export class MemoryTransport implements ChronologTransport {
  readonly #records = new Map<string, TransportRecord>()
  readonly #subscribers = new Set<AsyncQueue<TransportRecord>>()
  #sequence = 0n
  #previous: string | undefined
  #closed = false

  constructor(
    readonly network: MemoryTransportNetwork,
    readonly identity: string,
  ) {}

  async publish(payload: Uint8Array, options: PublishOptions = {}): Promise<TransportRecord> {
    this.#assertOpen()
    this.#sequence += 1n
    const record: TransportRecord = {
      id: recordId(this.identity, this.#sequence, this.#previous, payload),
      author: this.identity,
      sequence: this.#sequence,
      ...(this.#previous === undefined ? {} : { previous: this.#previous }),
      receivedAtMs: options.timestampMs ?? Date.now(),
      payload: payload.slice(),
    }
    this.#previous = record.id
    this.network.publish(this, record)
    return cloneRecord(record)
  }

  async get(id: string): Promise<TransportRecord | undefined> {
    const record = this.#records.get(id)
    return record ? cloneRecord(record) : undefined
  }

  async history(): Promise<readonly TransportRecord[]> {
    return this.localHistory().map(cloneRecord)
  }

  localHistory(): readonly TransportRecord[] {
    return [...this.#records.values()].sort((a, b) => {
      if (a.author !== b.author) return a.author.localeCompare(b.author)
      return a.sequence < b.sequence ? -1 : a.sequence > b.sequence ? 1 : 0
    })
  }

  receive(input: TransportRecord): void {
    if (this.#closed || this.#records.has(input.id)) return
    const record = cloneRecord(input)
    this.#records.set(record.id, record)
    for (const subscriber of this.#subscribers) subscriber.push(cloneRecord(record))
  }

  subscribe(signal?: AbortSignal): AsyncIterable<TransportRecord> {
    const queue = new AsyncQueue<TransportRecord>()
    for (const record of this.localHistory()) queue.push(cloneRecord(record))
    this.#subscribers.add(queue)
    const abort = () => {
      this.#subscribers.delete(queue)
      queue.close()
    }
    if (signal?.aborted) abort()
    else signal?.addEventListener('abort', abort, { once: true })
    return queue
  }

  async status(): Promise<TransportStatus> {
    return {
      identity: this.identity,
      records: this.#records.size,
      closed: this.#closed,
      peers: this.network.peers(this.identity),
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    this.network.remove(this.identity)
    for (const subscriber of this.#subscribers) subscriber.close()
    this.#subscribers.clear()
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error('transport is closed')
  }
}
