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

  it('reports non-contiguous feed observations truthfully', async () => {
    const network = new MemoryTransportNetwork()
    const node = network.createNode('@observer.ed25519')
    node.receive({
      id: '%gap.sha256',
      author: '@remote.ed25519',
      sequence: 2n,
      receivedAtMs: 1,
      payload: Uint8Array.of(9),
    })

    expect(await node.status()).toMatchObject({
      feedsWithGaps: 1,
      feedStates: [{
        feedId: '@remote.ed25519',
        contiguousThrough: '0',
        maximumSequence: '2',
        hasGaps: true,
      }],
    })
  })
})
