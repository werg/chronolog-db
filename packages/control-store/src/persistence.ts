import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { dirname } from 'node:path'

import type {
  ControlStorePersistence,
  ControlStoreSnapshot,
  ValidatorCutoffState,
} from './types.js'

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
  readonly #cutoffs = new Map<string, ValidatorCutoffState>()

  load(): ControlStoreSnapshot | null {
    return this.#encoded === null ? null : decodeControlStoreSnapshot(this.#encoded)
  }

  save(snapshot: ControlStoreSnapshot): void {
    this.#encoded = encodeControlStoreSnapshot(snapshot)
  }

  loadValidatorCutoffs(): readonly ValidatorCutoffState[] {
    return [...this.#cutoffs.values()].map(cloneCutoff)
  }

  initializeValidatorCutoffs(cutoffs: readonly ValidatorCutoffState[]): void {
    for (const cutoff of cutoffs) this.saveValidatorCutoff(cutoff)
  }

  saveValidatorCutoff(cutoff: ValidatorCutoffState): void {
    const key = Buffer.from(cutoff.validatorId).toString('base64url')
    const previous = this.#cutoffs.get(key)
    if (previous !== undefined && cutoff.acceptedAboveMs < previous.acceptedAboveMs) {
      throw new Error('CONTROL_STORE_VALIDATOR_CUTOFF_REGRESSION')
    }
    this.#cutoffs.set(key, cloneCutoff(cutoff))
  }
}

/** A small crash-safe snapshot persistence for the rebuildable control index. */
export class JsonFileControlStorePersistence implements ControlStorePersistence {
  readonly #path: string
  readonly #cutoffPath: string
  #cutoffs: Map<string, ValidatorCutoffState> | null = null
  #pendingSnapshot: (() => ControlStoreSnapshot) | null = null
  #saveTimer: ReturnType<typeof setTimeout> | undefined

  constructor(path: string) {
    this.#path = path
    this.#cutoffPath = `${path}.validator-cutoffs`
  }

  load(): ControlStoreSnapshot | null {
    this.flush()
    try {
      return decodeControlStoreSnapshot(readFileSync(this.#path, 'utf8'))
    } catch (error) {
      if (isMissingFile(error)) return null
      if (isCorruptSnapshot(error)) {
        if (!existsSync(this.#cutoffPath)) {
          throw new Error('CONTROL_STORE_CUTOFF_JOURNAL_MISSING', { cause: error })
        }
        this.#quarantine()
        return null
      }
      throw error
    }
  }

  save(snapshot: ControlStoreSnapshot): void {
    this.#write(snapshot)
  }

  loadValidatorCutoffs(): readonly ValidatorCutoffState[] | null {
    try {
      const cutoffs = decodeValidatorCutoffs(readFileSync(this.#cutoffPath, 'utf8'))
      this.#cutoffs = new Map(cutoffs.map((cutoff) => [cutoffKey(cutoff.validatorId), cutoff]))
      return cutoffs.map(cloneCutoff)
    } catch (error) {
      if (isMissingFile(error)) return null
      throw new Error('CONTROL_STORE_CUTOFF_JOURNAL_CORRUPT', { cause: error })
    }
  }

  initializeValidatorCutoffs(cutoffs: readonly ValidatorCutoffState[]): void {
    if (this.#cutoffs === null && existsSync(this.#cutoffPath)) this.loadValidatorCutoffs()
    this.#cutoffs ??= new Map()
    let changed = !existsSync(this.#cutoffPath)
    for (const cutoff of cutoffs) {
      const key = cutoffKey(cutoff.validatorId)
      const previous = this.#cutoffs.get(key)
      if (previous === undefined || cutoff.acceptedAboveMs > previous.acceptedAboveMs) {
        this.#cutoffs.set(key, cloneCutoff(cutoff))
        changed = true
      }
    }
    if (changed) this.#writeCutoffs()
  }

  saveValidatorCutoff(cutoff: ValidatorCutoffState): void {
    if (this.#cutoffs === null) this.loadValidatorCutoffs()
    this.#cutoffs ??= new Map()
    const key = cutoffKey(cutoff.validatorId)
    const previous = this.#cutoffs.get(key)
    if (previous !== undefined && cutoff.acceptedAboveMs < previous.acceptedAboveMs) {
      throw new Error('CONTROL_STORE_VALIDATOR_CUTOFF_REGRESSION')
    }
    if (previous?.acceptedAboveMs === cutoff.acceptedAboveMs) return
    this.#cutoffs.set(key, cloneCutoff(cutoff))
    try {
      this.#writeCutoffs()
    } catch (error) {
      if (previous === undefined) this.#cutoffs.delete(key)
      else this.#cutoffs.set(key, previous)
      throw error
    }
  }

  requestSave(snapshot: () => ControlStoreSnapshot): void {
    this.#pendingSnapshot = snapshot
    if (this.#saveTimer !== undefined) return
    this.#saveTimer = setTimeout(() => {
      this.#saveTimer = undefined
      this.flush()
    }, 100)
    this.#saveTimer.unref?.()
  }

  flush(): void {
    if (this.#saveTimer !== undefined) {
      clearTimeout(this.#saveTimer)
      this.#saveTimer = undefined
    }
    const snapshot = this.#pendingSnapshot
    this.#pendingSnapshot = null
    if (snapshot !== null) this.#write(snapshot())
  }

  recoverCorruptSnapshot(_error: unknown): boolean {
    if (!existsSync(this.#cutoffPath)) return false
    this.#quarantine()
    return true
  }

  #write(snapshot: ControlStoreSnapshot): void {
    writeCrashSafe(this.#path, encodeControlStoreSnapshot(snapshot))
  }

  #writeCutoffs(): void {
    writeCrashSafe(this.#cutoffPath, encodeValidatorCutoffs([...(this.#cutoffs?.values() ?? [])]))
  }

  #quarantine(): void {
    try {
      renameSync(this.#path, `${this.#path}.corrupt-${process.pid}-${Date.now()}`)
      syncPath(dirname(this.#path))
    } catch (error) {
      if (!isMissingFile(error)) throw error
    }
  }
}

function writeCrashSafe(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const temporaryPath = `${path}.tmp`
  writeFileSync(temporaryPath, contents, {
    encoding: 'utf8',
    mode: 0o600,
  })
  syncPath(temporaryPath)
  syncPath(dirname(path))
  renameSync(temporaryPath, path)
  syncPath(dirname(path))
}

function encodeValidatorCutoffs(cutoffs: readonly ValidatorCutoffState[]): string {
  return JSON.stringify({
    format: 'chronolog-validator-cutoffs/v1',
    cutoffs: cutoffs.map((cutoff) => ({
      validatorId: Buffer.from(cutoff.validatorId).toString('base64'),
      acceptedAboveMs: cutoff.acceptedAboveMs.toString(10),
    })),
  })
}

function decodeValidatorCutoffs(text: string): ValidatorCutoffState[] {
  const value = JSON.parse(text) as unknown
  if (!isRecord(value) || value.format !== 'chronolog-validator-cutoffs/v1' || !Array.isArray(value.cutoffs)) {
    throw new Error('CONTROL_STORE_CUTOFF_JOURNAL_INVALID')
  }
  const cutoffs = value.cutoffs.map((item) => {
    if (
      !isRecord(item) || typeof item.validatorId !== 'string' ||
      typeof item.acceptedAboveMs !== 'string' || !/^(0|[1-9][0-9]*)$/.test(item.acceptedAboveMs)
    ) throw new Error('CONTROL_STORE_CUTOFF_JOURNAL_INVALID')
    const validatorId = Uint8Array.from(Buffer.from(item.validatorId, 'base64'))
    if (
      validatorId.length === 0 ||
      Buffer.from(validatorId).toString('base64') !== item.validatorId
    ) throw new Error('CONTROL_STORE_CUTOFF_JOURNAL_INVALID')
    return { validatorId, acceptedAboveMs: BigInt(item.acceptedAboveMs) }
  })
  if (new Set(cutoffs.map((cutoff) => cutoffKey(cutoff.validatorId))).size !== cutoffs.length) {
    throw new Error('CONTROL_STORE_CUTOFF_JOURNAL_DUPLICATE')
  }
  return cutoffs
}

function cutoffKey(validatorId: Uint8Array): string {
  return Buffer.from(validatorId).toString('base64url')
}

function cloneCutoff(cutoff: ValidatorCutoffState): ValidatorCutoffState {
  return { validatorId: cutoff.validatorId.slice(), acceptedAboveMs: cutoff.acceptedAboveMs }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function syncPath(path: string): void {
  const descriptor = openSync(path, 'r')
  try {
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
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

function isCorruptSnapshot(error: unknown): boolean {
  return error instanceof SyntaxError || (
    error instanceof Error && error.message.startsWith('CONTROL_STORE_')
  )
}
