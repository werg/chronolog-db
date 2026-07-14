import { concatBytes, utf8 } from './bytes.js'

export const HASH_DOMAINS = Object.freeze({
  transaction: 'chronolog/transaction',
  schema: 'chronolog/schema',
  executionManifest: 'chronolog/execution-manifest',
  queryResult: 'chronolog/query-result',
  expectation: 'chronolog/expectation',
  module: 'chronolog/module',
  entropy: 'chronolog/entropy',
} as const)

export type HashDomainKey = keyof typeof HASH_DOMAINS

function bufferSource(value: Uint8Array): ArrayBuffer { return value.slice().buffer }

export function domainSeparatedBytes(domain: HashDomainKey, payload: Uint8Array): Uint8Array {
  const name = utf8(HASH_DOMAINS[domain])
  const size = new Uint8Array(4)
  new DataView(size.buffer).setUint32(0, name.length, false)
  return concatBytes(size, name, Uint8Array.of(0), payload)
}

export async function sha256(payload: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bufferSource(payload)))
}

export async function hashDomain(domain: HashDomainKey, payload: Uint8Array): Promise<Uint8Array> {
  return sha256(domainSeparatedBytes(domain, payload))
}
