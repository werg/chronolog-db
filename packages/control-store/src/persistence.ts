import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import type { ControlStorePersistence, ControlStoreSnapshot } from './types.js'

const BYTES_TAG = '$chronologBytes'
const BIGINT_TAG = '$chronologBigInt'

export function encodeControlStoreSnapshot(snapshot: ControlStoreSnapshot): string {
  return JSON.stringify(snapshot, (_key, value: unknown) => {
    if (typeof value === 'bigint') return { [BIGINT_TAG]: value.toString(10) }
    if (value instanceof Uint8Array) {
      return { [BYTES_TAG]: Buffer.from(value).toString('base64') }
    }
    return value
  })
}

export function decodeControlStoreSnapshot(text: string): ControlStoreSnapshot {
  const parsed = JSON.parse(text, (_key, value: unknown) => {
    if (isTagged(value, BIGINT_TAG)) return BigInt(value[BIGINT_TAG]!)
    if (isTagged(value, BYTES_TAG)) {
      return Uint8Array.from(Buffer.from(value[BYTES_TAG]!, 'base64'))
    }
    return value
  }) as ControlStoreSnapshot

  if (parsed.format !== 'chronolog-control-store/v1') {
    throw new Error('CONTROL_STORE_UNSUPPORTED_FORMAT')
  }
  return parsed
}

function isTagged(value: unknown, tag: string): value is Record<string, string> {
  return (
    typeof value === 'object' &&
    value !== null &&
    Object.keys(value).length === 1 &&
    typeof (value as Record<string, unknown>)[tag] === 'string'
  )
}

export class MemoryControlStorePersistence implements ControlStorePersistence {
  #encoded: string | null = null

  load(): ControlStoreSnapshot | null {
    return this.#encoded === null ? null : decodeControlStoreSnapshot(this.#encoded)
  }

  save(snapshot: ControlStoreSnapshot): void {
    this.#encoded = encodeControlStoreSnapshot(snapshot)
  }
}

/** A small crash-safe snapshot persistence for the rebuildable control index. */
export class JsonFileControlStorePersistence implements ControlStorePersistence {
  readonly #path: string

  constructor(path: string) {
    this.#path = path
  }

  load(): ControlStoreSnapshot | null {
    try {
      return decodeControlStoreSnapshot(readFileSync(this.#path, 'utf8'))
    } catch (error) {
      if (isMissingFile(error)) return null
      throw error
    }
  }

  save(snapshot: ControlStoreSnapshot): void {
    mkdirSync(dirname(this.#path), { recursive: true })
    const temporaryPath = `${this.#path}.tmp`
    writeFileSync(temporaryPath, encodeControlStoreSnapshot(snapshot), {
      encoding: 'utf8',
      mode: 0o600,
    })
    renameSync(temporaryPath, this.#path)
  }
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  )
}
