import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { SsbDb2Transport } from './ssb-db2.js'

describe('SsbDb2Transport', () => {
  const paths: string[] = []

  afterEach(async () => {
    await Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 })))
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
      // jitdb persists a completed query index just after its callback. Give
      // that same-process test work a turn before removing the temporary tree.
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  })

  it('rebuilds disposable indexes after an unclean prior owner', async () => {
    const path = await mkdtemp(join(tmpdir(), 'chronolog-ssb-recovery-'))
    paths.push(path)
    const dbPath = join(path, 'db')
    let transport = await SsbDb2Transport.open({ path: dbPath })
    const record = await transport.publish(Uint8Array.of(7, 8, 9))
    await transport.close()

    const sentinel = join(dbPath, 'db2', 'jit', 'stale-index')
    await mkdir(join(dbPath, 'db2', 'jit'), { recursive: true })
    await writeFile(sentinel, 'stale')
    await writeFile(join(dbPath, '.chronolog-ssb-open'), 'unclean')
    transport = await SsbDb2Transport.open({ path: dbPath })
    try {
      expect((await transport.status()).recoveredAfterUncleanClose).toBe(true)
      expect((await transport.get(record.id))?.payload).toEqual(Uint8Array.of(7, 8, 9))
      await expect(access(sentinel)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await transport.close()
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  })

  it('restores an exact signed author tail before publishing after rollback', async () => {
    const path = await mkdtemp(join(tmpdir(), 'chronolog-ssb-author-tail-'))
    paths.push(path)
    const dbPath = join(path, 'db')
    let transport = await SsbDb2Transport.open({ path: dbPath })
    const first = await transport.publish(Uint8Array.of(1))
    const prefixBlock = await readFile(join(dbPath, 'db2', 'log.bipf'))
    const second = await transport.publish(Uint8Array.of(2))
    const third = await transport.publish(Uint8Array.of(3))
    await transport.close()

    await writeFile(join(dbPath, 'db2', 'log.bipf'), prefixBlock)
    await writeFile(join(dbPath, '.chronolog-ssb-open'), 'unclean')
    transport = await SsbDb2Transport.open({ path: dbPath })
    try {
      expect((await transport.get(first.id))?.payload).toEqual(Uint8Array.of(1))
      expect((await transport.get(second.id))?.payload).toEqual(Uint8Array.of(2))
      expect((await transport.get(third.id))?.payload).toEqual(Uint8Array.of(3))
      const fourth = await transport.publish(Uint8Array.of(4))
      expect(fourth.sequence).toBe(4n)
      expect(fourth.previous).toBe(third.id)
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
      const controller = new AbortController()
      const observed: number[] = []
      const consume = (async () => {
        for await (const record of right.subscribe(controller.signal)) observed.push(record.payload[0] ?? -1)
      })()
      right.requestFeed(left.identity)
      await new Promise((resolve) => setTimeout(resolve, 250))
      await left.connect({ address, feedId: right.identity })
      await eventually(
        async () => (await right.get(published.id)) !== undefined,
        () => JSON.stringify({ left: left.feedReplicationStatus(left.identity), right: right.feedReplicationStatus(left.identity) }),
      )
      expect((await right.get(published.id))?.payload).toEqual(Uint8Array.of(11, 22, 33))
      const live = await left.publish(Uint8Array.of(44, 55, 66))
      await eventually(
        () => observed.includes(44) && (right.get(live.id).then((record) => record !== undefined)),
        () => JSON.stringify({ observed, left: left.feedReplicationStatus(left.identity), right: right.feedReplicationStatus(left.identity) }),
      )
      expect((await left.status()).peers).toContain(right.identity)
      controller.abort()
      await consume
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
