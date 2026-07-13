import { describe, expect, it } from 'vitest'

import { MemoryTransportNetwork } from './memory.js'

describe('MemoryTransportNetwork', () => {
  it('replicates, partitions, and fills gaps deterministically', async () => {
    const network = new MemoryTransportNetwork()
    const alice = network.createNode('@alice.ed25519')
    const bob = network.createNode('@bob.ed25519')
    network.connect(alice, bob)

    const first = await alice.publish(new Uint8Array([1, 2, 3]), { timestampMs: 1 })
    expect(await bob.get(first.id)).toMatchObject({ author: alice.identity, sequence: 1n })

    network.disconnect(alice, bob)
    const hidden = await alice.publish(new Uint8Array([4]), { timestampMs: 2 })
    expect(await bob.get(hidden.id)).toBeUndefined()

    network.connect(alice, bob)
    expect(await bob.get(hidden.id)).toMatchObject({ id: hidden.id, sequence: 2n })
    expect((await bob.history()).map((record) => record.id)).toEqual([first.id, hidden.id])
  })

  it('replays existing messages to a new subscription and emits new messages once', async () => {
    const network = new MemoryTransportNetwork()
    const alice = network.createNode('@alice.ed25519')
    await alice.publish(new Uint8Array([1]))
    const controller = new AbortController()
    const iterator = alice.subscribe(controller.signal)[Symbol.asyncIterator]()
    expect((await iterator.next()).value?.sequence).toBe(1n)
    await alice.publish(new Uint8Array([2]))
    expect((await iterator.next()).value?.sequence).toBe(2n)
    controller.abort()
    expect((await iterator.next()).done).toBe(true)
  })
})
