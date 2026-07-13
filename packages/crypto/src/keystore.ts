import {
  DOMAINS,
  ProtocolError,
  exportEd25519PrivateKey,
  generateEd25519KeyPair,
  signDomain,
  type ProtocolDomain,
} from '@chronolog/protocol'
import {
  exportX25519PrivateKey,
  generateX25519KeyPair,
  hpkeOpenBase,
} from './hpke.js'

export type KeyPurpose = 'signing' | 'hpke-recipient'

export interface StoredKeyDescriptor {
  readonly reference: string
  readonly purpose: KeyPurpose
  readonly publicKey: Uint8Array
}

export interface KeyStore {
  create(reference: string, purpose: KeyPurpose): Promise<StoredKeyDescriptor>
  import(reference: string, purpose: KeyPurpose, publicKey: Uint8Array, privateKey: CryptoKey): Promise<void>
  exportPublic(reference: string): Promise<StoredKeyDescriptor>
  list(): Promise<readonly StoredKeyDescriptor[]>
  sign(reference: string, domain: ProtocolDomain, payload: Uint8Array): Promise<Uint8Array>
  hpkeOpen(reference: string, encapsulatedKey: Uint8Array, ciphertext: Uint8Array, info: Uint8Array, aad: Uint8Array): Promise<Uint8Array>
  delete(reference: string): Promise<void>
}

interface KeyEntry extends StoredKeyDescriptor {
  readonly privateKey: CryptoKey
}

export class MemoryKeyStore implements KeyStore {
  private readonly entries = new Map<string, KeyEntry>()

  public async create(reference: string, purpose: KeyPurpose): Promise<StoredKeyDescriptor> {
    if (this.entries.has(reference)) throw new ProtocolError('INVALID_KEY', 'Key reference already exists', { reference })
    if (purpose === 'signing') {
      const pair = await generateEd25519KeyPair(false)
      await this.import(reference, purpose, pair.publicKeyBytes, pair.privateKey)
    } else {
      const pair = await generateX25519KeyPair(false)
      await this.import(reference, purpose, pair.publicKeyBytes, pair.privateKey)
    }
    return this.exportPublic(reference)
  }

  public async import(reference: string, purpose: KeyPurpose, publicKey: Uint8Array, privateKey: CryptoKey): Promise<void> {
    if (this.entries.has(reference)) throw new ProtocolError('INVALID_KEY', 'Key reference already exists', { reference })
    this.entries.set(reference, { reference, purpose, publicKey: publicKey.slice(), privateKey })
  }

  public async exportPublic(reference: string): Promise<StoredKeyDescriptor> {
    const entry = this.require(reference)
    return { reference: entry.reference, purpose: entry.purpose, publicKey: entry.publicKey.slice() }
  }

  public async list(): Promise<readonly StoredKeyDescriptor[]> {
    return Promise.all([...this.entries.keys()].sort().map((reference) => this.exportPublic(reference)))
  }

  public async sign(reference: string, domain: ProtocolDomain, payload: Uint8Array): Promise<Uint8Array> {
    const entry = this.require(reference, 'signing')
    return signDomain(domain, payload, entry.privateKey)
  }

  public async hpkeOpen(reference: string, encapsulatedKey: Uint8Array, ciphertext: Uint8Array, info: Uint8Array, aad: Uint8Array): Promise<Uint8Array> {
    const entry = this.require(reference, 'hpke-recipient')
    return hpkeOpenBase(entry.privateKey, entry.publicKey, encapsulatedKey, ciphertext, info, aad)
  }

  public async delete(reference: string): Promise<void> {
    this.entries.delete(reference)
  }

  private require(reference: string, purpose?: KeyPurpose): KeyEntry {
    const entry = this.entries.get(reference)
    if (entry === undefined || (purpose !== undefined && entry.purpose !== purpose)) {
      throw new ProtocolError('INVALID_KEY', 'Unknown key reference or wrong key purpose', { reference })
    }
    return entry
  }
}

export interface ExportedDevelopmentKey {
  readonly purpose: KeyPurpose
  readonly publicKey: Uint8Array
  readonly privateKeyPkcs8: Uint8Array
}

export async function exportDevelopmentKey(
  purpose: KeyPurpose,
  publicKey: Uint8Array,
  privateKey: CryptoKey,
): Promise<ExportedDevelopmentKey> {
  return {
    purpose,
    publicKey: publicKey.slice(),
    privateKeyPkcs8: purpose === 'signing'
      ? await exportEd25519PrivateKey(privateKey)
      : await exportX25519PrivateKey(privateKey),
  }
}

export { DOMAINS }

