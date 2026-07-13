import { describe, expect, it } from 'vitest'
import {
  DOMAINS,
  generateEd25519KeyPair,
  hashDomain,
  signDomain,
  utf8,
  verifyDomain,
} from './index.js'

describe('domain-separated protocol cryptography', () => {
  it('signs and verifies only under the exact domain', async () => {
    const pair = await generateEd25519KeyPair()
    const payload = utf8('canonical protocol bytes')
    const signature = await signDomain(DOMAINS.transaction, payload, pair.privateKey)
    expect(signature).toHaveLength(64)
    expect(await verifyDomain(DOMAINS.transaction, payload, signature, pair.publicKeyBytes)).toBe(true)
    expect(await verifyDomain(DOMAINS.attestation, payload, signature, pair.publicKeyBytes)).toBe(false)
    expect(await verifyDomain(DOMAINS.transaction, utf8('changed'), signature, pair.publicKeyBytes)).toBe(false)
  })

  it('separates hashes for identical bytes in different structures', async () => {
    const payload = utf8('same')
    expect(await hashDomain(DOMAINS.transactionDigest, payload)).not.toEqual(
      await hashDomain(DOMAINS.canonicalResult, payload),
    )
  })
})

