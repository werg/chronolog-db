import { access, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
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
      const status = await transport.status()
      expect(status.records).toBe(1)
      expect(status.feedsWithGaps).toBe(0)
      expect(status.feedStates).toContainEqual({
        feedId: transport.identity,
        contiguousThrough: '1',
        maximumSequence: '1',
        hasGaps: false,
      })
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
    await writeStaleOwnershipMarker(dbPath)
    const staleLease = join(dbPath, '.chronolog-ssb-owner.lock')
    await mkdir(staleLease)
    await utimes(staleLease, new Date(0), new Date(0))
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

  it('recovers a stale lease left by a previous container hostname', async () => {
    const path = await mkdtemp(join(tmpdir(), 'chronolog-ssb-container-restart-'))
    paths.push(path)
    const dbPath = join(path, 'db')
    await mkdir(dbPath, { recursive: true })
    await writeStaleOwnershipMarker(dbPath, 'previous-container')
    const staleLease = join(dbPath, '.chronolog-ssb-owner.lock')
    await mkdir(staleLease)
    await utimes(staleLease, new Date(0), new Date(0))

    const transport = await SsbDb2Transport.open({ path: dbPath })
    expect((await transport.status()).recoveredAfterUncleanClose).toBe(true)
    await transport.close()
  })

  it('does not mistake a reused PID for the previous storage owner', async () => {
    const path = await mkdtemp(join(tmpdir(), 'chronolog-ssb-pid-reuse-'))
    paths.push(path)
    const dbPath = join(path, 'db')
    await mkdir(dbPath, { recursive: true })
    await writeFile(join(dbPath, '.chronolog-ssb-open'), `${JSON.stringify({
      format: 'chronolog-ssb-owner-v1',
      pid: process.pid,
      hostname: hostname(),
      token: 'previous-process-instance',
      openedAt: new Date(0).toISOString(),
      processStart: '0',
    })}\n`)
    const staleLease = join(dbPath, '.chronolog-ssb-owner.lock')
    await mkdir(staleLease)
    await utimes(staleLease, new Date(0), new Date(0))

    const transport = await SsbDb2Transport.open({ path: dbPath })
    expect((await transport.status()).recoveredAfterUncleanClose).toBe(true)
    await transport.close()
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
    await writeStaleOwnershipMarker(dbPath)
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

  it('refuses a concurrent owner without deleting its indexes', async () => {
    const path = await mkdtemp(join(tmpdir(), 'chronolog-ssb-contention-'))
    paths.push(path)
    const dbPath = join(path, 'db')
    const first = await SsbDb2Transport.open({ path: dbPath })
    const sentinel = join(dbPath, 'db2', 'jit', 'live-owner-index')
    try {
      await mkdir(join(dbPath, 'db2', 'jit'), { recursive: true })
      await writeFile(sentinel, 'must-not-be-removed')
      await expect(SsbDb2Transport.open({ path: dbPath })).rejects.toThrow('SSB_STORAGE_IN_USE')
      await expect(access(sentinel)).resolves.toBeUndefined()
      expect((await first.status()).closed).toBe(false)
    } finally {
      await first.close()
    }
    const reopened = await SsbDb2Transport.open({ path: dbPath })
    await reopened.close()
  })

  it('releases ownership when opening fails before db2 initialization', async () => {
    const path = await mkdtemp(join(tmpdir(), 'chronolog-ssb-open-failure-'))
    paths.push(path)
    const dbPath = join(path, 'db')
    await mkdir(dbPath, { recursive: true })
    const recoveryPath = join(dbPath, 'author-recovery.json')
    await writeFile(recoveryPath, '{invalid')
    await expect(SsbDb2Transport.open({ path: dbPath })).rejects.toThrow()
    await rm(recoveryPath)
    const transport = await SsbDb2Transport.open({ path: dbPath })
    await transport.close()
  })

  it('does not allow generic SecretStack config to redirect the locked storage path', async () => {
    const path = await mkdtemp(join(tmpdir(), 'chronolog-ssb-config-path-'))
    paths.push(path)
    const dbPath = join(path, 'owned-db')
    const redirectedPath = join(path, 'redirected-db')
    const transport = await SsbDb2Transport.open({ path: dbPath, config: { path: redirectedPath } })
    try {
      await transport.publish(Uint8Array.of(1))
      await expect(access(join(dbPath, 'db2', 'log.bipf'))).resolves.toBeUndefined()
      await expect(access(redirectedPath)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await transport.close()
    }
  })

  it('streams existing and live records once with abortable backpressure', async () => {
    const path = await mkdtemp(join(tmpdir(), 'chronolog-ssb-subscribe-'))
    paths.push(path)
    const transport = await SsbDb2Transport.open({ path: join(path, 'db') })
    try {
      const first = await transport.publish(Uint8Array.of(1))
      const controller = new AbortController()
      const iterator = transport.subscribe(controller.signal)[Symbol.asyncIterator]()
      await expect(within(iterator.next(), 'existing subscription record')).resolves.toMatchObject({ done: false, value: { id: first.id } })
      const second = await transport.publish(Uint8Array.of(2))
      await expect(within(iterator.next(), 'live subscription record')).resolves.toMatchObject({ done: false, value: { id: second.id } })
      controller.abort()
      await expect(iterator.next()).resolves.toEqual({ value: undefined, done: true })
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

async function writeStaleOwnershipMarker(dbPath: string, markerHostname = hostname()): Promise<void> {
  await writeFile(join(dbPath, '.chronolog-ssb-open'), `${JSON.stringify({
    format: 'chronolog-ssb-owner-v1',
    pid: 2_147_483_647,
    hostname: markerHostname,
    token: 'stale-test-owner',
    openedAt: new Date(0).toISOString(),
  })}\n`)
}

async function eventually(predicate: () => boolean | Promise<boolean>, details: () => string): Promise<void> {
  const deadline = Date.now() + 10_000
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error(`SSB replication timed out: ${details()}`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

function within<T>(promise: Promise<T>, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), 5_000)
    promise.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error: unknown) => { clearTimeout(timer); reject(error) },
    )
  })
}
