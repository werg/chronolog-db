import { describe, expect, it, vi } from 'vitest'

import { discoverPublicSsbAddress, verifyPublicSsbReachability } from './nat-discovery.js'

const address = 'net:db.example:8008~shs:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='

describe('NAT/public address discovery', () => {
  it('prefers an explicit operator address without network access', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
    await expect(discoverPublicSsbAddress({
      explicitAddress: address,
      discoveryUrl: 'https://discovery.example/address',
      timeoutMs: 10,
      fetch,
    })).resolves.toEqual({ address, source: 'explicit' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('accepts one bounded address from a configured discovery service', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(
      JSON.stringify({ address }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ))
    await expect(discoverPublicSsbAddress({
      discoveryUrl: 'https://discovery.example/address',
      timeoutMs: 100,
      fetch,
    })).resolves.toEqual({ address, source: 'discovery-service' })
  })

  it('reports discovery failure without blocking private operation', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error('offline'))
    await expect(discoverPublicSsbAddress({
      discoveryUrl: 'https://discovery.example/address',
      timeoutMs: 100,
      fetch,
    })).resolves.toEqual({ address: null, source: 'discovery-service', error: 'offline' })
  })

  it('verifies the exact advertised address and server key from an external vantage', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (_input, init) => {
      expect(init?.method).toBe('POST')
      expect(typeof init?.body).toBe('string')
      expect(JSON.parse(init?.body as string)).toEqual({ address })
      return new Response(JSON.stringify({
        address,
        reachable: true,
        observedServerKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      }))
    })
    await expect(verifyPublicSsbReachability({
      address,
      verificationUrl: 'https://probe.example/ssb',
      timeoutMs: 100,
      fetch,
    })).resolves.toEqual({ status: 'verified', address })
  })

  it('fails closed on an external proof for a substituted key', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({
      address,
      reachable: true,
      observedServerKey: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=',
    })))
    await expect(verifyPublicSsbReachability({
      address,
      verificationUrl: 'https://probe.example/ssb',
      timeoutMs: 100,
      fetch,
    })).resolves.toEqual({ status: 'failed', address, error: 'NAT_VERIFICATION_PROOF_INVALID' })
  })
})
