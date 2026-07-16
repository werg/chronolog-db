export interface NatDiscoveryResult {
  readonly address: string | null
  readonly source: 'explicit' | 'discovery-service' | 'none'
  readonly error?: string
}

export async function discoverPublicSsbAddress(options: {
  readonly explicitAddress?: string
  readonly discoveryUrl?: string
  readonly timeoutMs: number
  readonly fetch?: typeof fetch
}): Promise<NatDiscoveryResult> {
  if (options.explicitAddress !== undefined) {
    return { address: validateAddress(options.explicitAddress), source: 'explicit' }
  }
  if (options.discoveryUrl === undefined) return { address: null, source: 'none' }
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort('NAT discovery timed out'), options.timeoutMs)
  timeout.unref?.()
  try {
    const response = await (options.fetch ?? globalThis.fetch)(options.discoveryUrl, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    })
    if (!response.ok) throw new Error(`HTTP_${response.status}`)
    const declaredLength = Number(response.headers.get('content-length') ?? '0')
    if (declaredLength > 16 * 1024) throw new Error('NAT_DISCOVERY_RESPONSE_LIMIT')
    const text = await response.text()
    if (Buffer.byteLength(text, 'utf8') > 16 * 1024) throw new Error('NAT_DISCOVERY_RESPONSE_LIMIT')
    const value = JSON.parse(text) as unknown
    if (typeof value !== 'object' || value === null || Array.isArray(value) ||
        Object.keys(value).some((key) => key !== 'address') ||
        typeof (value as { address?: unknown }).address !== 'string') {
      throw new Error('NAT_DISCOVERY_RESPONSE_INVALID')
    }
    return {
      address: validateAddress((value as { address: string }).address),
      source: 'discovery-service',
    }
  } catch (error) {
    return {
      address: null,
      source: 'discovery-service',
      error: error instanceof Error ? error.message : String(error),
    }
  } finally {
    clearTimeout(timeout)
  }
}

function validateAddress(address: string): string {
  if (address.length > 2048 || !/^net:[^~\s]+~shs:[A-Za-z0-9+/=]+$/u.test(address)) {
    throw new Error('CHRONOLOG_PUBLIC_SSB_ADDRESS_INVALID')
  }
  return address
}
