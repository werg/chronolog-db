import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { SsbDb2Transport } from './ssb-db2.js'

describe('SsbDb2Transport', () => {
  const paths: string[] = []

  afterEach(async () => {
    await Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true })))
  })

  it('durably appends and reads an exact Chronolog payload', async () => {
    const path = await mkdtemp(join(tmpdir(), 'chronolog-ssb-'))
    paths.push(path)
    const dbPath = join(path, 'db')
    let transport = await SsbDb2Transport.open({ path: dbPath })
    try {
      const payload = new Uint8Array([0, 1, 2, 254, 255])
      const record = await transport.publish(payload)
      expect(record.sequence).toBe(1n)
      expect((await transport.get(record.id))?.payload).toEqual(payload)
      expect((await transport.history()).map((item) => item.id)).toContain(record.id)
      await transport.close()
      transport = await SsbDb2Transport.open({ path: dbPath })
      expect((await transport.get(record.id))?.payload).toEqual(payload)
    } finally {
      await transport.close()
    }
  })

  it('replicates an explicitly allowed feed over an authenticated SSB connection', async () => {
    const path = await mkdtemp(join(tmpdir(), 'chronolog-ssb-network-'))
    paths.push(path)
    const left = await SsbDb2Transport.open({
      path: join(path, 'left-db'),
      secretPath: join(path, 'left-secret'),
      network: { listen: { port: 0 } },
    })
    const right = await SsbDb2Transport.open({
      path: join(path, 'right-db'),
      secretPath: join(path, 'right-secret'),
      network: { listen: { port: 0 } },
    })
    try {
      const address = right.address()
      if (address === undefined) throw new Error('test SSB address unavailable')
      const published = await left.publish(Uint8Array.of(11, 22, 33))
      right.requestFeed(left.identity)
      await new Promise((resolve) => setTimeout(resolve, 250))
      await left.connect({ address, feedId: right.identity })
      await eventually(
        async () => (await right.get(published.id)) !== undefined,
        () => JSON.stringify({ left: left.feedReplicationStatus(left.identity), right: right.feedReplicationStatus(left.identity) }),
      )
      expect((await right.get(published.id))?.payload).toEqual(Uint8Array.of(11, 22, 33))
      expect((await left.status()).peers).toContain(right.identity)
    } finally {
      await Promise.all([left.close(), right.close()])
    }
  })
})

async function eventually(predicate: () => boolean | Promise<boolean>, details: () => string): Promise<void> {
  const deadline = Date.now() + 10_000
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error(`SSB replication timed out: ${details()}`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}
