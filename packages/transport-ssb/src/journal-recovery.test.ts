import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const requireFromDb2 = createRequire(require.resolve('ssb-db2'))

interface AppendOnlyLog {
  append(value: Buffer, callback: (error: Error | null, offset?: number) => void): void
  get(offset: number, callback: (error: Error | null, value?: Buffer) => void): void
  onDrain(callback: () => void): void
  close(callback: (error?: Error) => void): void
}

const openLog = requireAppendOnlyLog()

function requireAppendOnlyLog(): (path: string) => AppendOnlyLog {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  try {
    if (descriptor?.configurable) Reflect.deleteProperty(globalThis, 'localStorage')
    return requireFromDb2('async-append-only-log') as (path: string) => AppendOnlyLog
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor)
  }
}

it('replays a checksummed tail-block journal before scanning the append log', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chronolog-aaol-journal-'))
  const path = join(directory, 'log.bipf')
  try {
    let log = openLog(path)
    await append(log, Buffer.from('durable-prefix'))
    await drain(log)
    const prefixBlock = await readFile(path)
    const secondOffset = await append(log, Buffer.from('journalled-tail'))
    await drain(log)
    const completeBlock = await readFile(path)
    await close(log)

    await writeFile(path, prefixBlock)
    const magic = Buffer.from('CHRONJ01')
    const journal = Buffer.alloc(magic.length + 8 + 32 + completeBlock.length)
    magic.copy(journal)
    journal.writeBigUInt64LE(0n, magic.length)
    createHash('sha256').update(completeBlock).digest().copy(journal, magic.length + 8)
    completeBlock.copy(journal, magic.length + 8 + 32)
    await writeFile(`${path}.chronolog-journal`, journal)

    log = openLog(path)
    expect((await get(log, secondOffset)).toString()).toBe('journalled-tail')
    await close(log)
    expect((await readFile(`${path}.chronolog-journal`)).length).toBe(0)
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 3 })
  }
})

function append(log: AppendOnlyLog, value: Buffer): Promise<number> {
  return new Promise((resolve, reject) => log.append(value, (error, offset) => {
    if (error) reject(error)
    else if (offset === undefined) reject(new Error('append returned no offset'))
    else resolve(offset)
  }))
}

function get(log: AppendOnlyLog, offset: number): Promise<Buffer> {
  return new Promise((resolve, reject) => log.get(offset, (error, value) => {
    if (error) reject(error)
    else if (value === undefined) reject(new Error('get returned no value'))
    else resolve(value)
  }))
}

function drain(log: AppendOnlyLog): Promise<void> { return new Promise((resolve) => log.onDrain(resolve)) }
function close(log: AppendOnlyLog): Promise<void> {
  return new Promise((resolve, reject) => log.close((error) => error ? reject(error) : resolve()))
}
