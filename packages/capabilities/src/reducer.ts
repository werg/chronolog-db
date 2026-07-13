import {
  DOMAINS,
  bytesToHex,
  compareBytes,
  encodeCanonicalCbor,
  equalBytes,
  hashDomain,
  integerMap,
  protocolInvariant,
  signDomain,
  verifyDomain,
} from '@chronolog/protocol'
import {
  capabilityCodecInternals,
  decodeCapabilityRevision,
  decodeGenesisManifest,
  encodeCapabilityRevision,
  encodeGenesisManifest,
} from './codec.js'
import type {
  CapabilityGrant,
  CapabilitySnapshot,
  EffectiveCapability,
  EffectivePolicy,
  GenesisManifest,
  SignedCapabilityRevision,
  SignedGenesis,
  ValidationPolicy,
} from './types.js'

export async function capabilityId(grant: CapabilityGrant): Promise<Uint8Array> {
  return hashDomain(DOMAINS.capabilityGrant, encodeCanonicalCbor(capabilityCodecInternals.grantToCbor(grant)))
}

export async function validationPolicyId(policy: ValidationPolicy): Promise<Uint8Array> {
  return hashDomain(DOMAINS.validationPolicy, encodeCanonicalCbor(capabilityCodecInternals.policyToCbor(policy)))
}

export async function signGenesis(manifest: GenesisManifest, rootPrivateKey: CryptoKey): Promise<SignedGenesis> {
  const bytes = encodeGenesisManifest(manifest)
  return { manifest, signature: await signDomain(DOMAINS.genesis, bytes, rootPrivateKey) }
}

export async function verifySignedGenesis(value: SignedGenesis): Promise<boolean> {
  return verifyDomain(DOMAINS.genesis, encodeGenesisManifest(value.manifest), value.signature, value.manifest.rootAdminPublicKey)
}

export async function signCapabilityRevision(
  revision: SignedCapabilityRevision['revision'],
  rootPrivateKey: CryptoKey,
): Promise<SignedCapabilityRevision> {
  return { revision, signature: await signDomain(DOMAINS.capabilityRevision, encodeCapabilityRevision(revision), rootPrivateKey) }
}

export async function capabilityRevisionDigest(revision: SignedCapabilityRevision['revision']): Promise<Uint8Array> {
  return hashDomain(DOMAINS.capabilityRevision, encodeCapabilityRevision(revision))
}

async function genesisSnapshot(genesis: SignedGenesis): Promise<CapabilitySnapshot> {
  protocolInvariant(await verifySignedGenesis(genesis), 'INVALID_SIGNATURE', 'Genesis signature is invalid')
  const manifest = decodeGenesisManifest(encodeGenesisManifest(genesis.manifest))
  const genesisDigest = await hashDomain(DOMAINS.genesis, encodeGenesisManifest(manifest))
  const capabilities = new Map<string, EffectiveCapability>()
  for (const grant of manifest.initialCapabilities) {
    protocolInvariant(grant.validFromRevision === 0n, 'SCHEMA_INVALID', 'Genesis capability must begin at revision zero')
    const id = await capabilityId(grant)
    protocolInvariant(!capabilities.has(bytesToHex(id)), 'SCHEMA_INVALID', 'Genesis contains a duplicate capability')
    capabilities.set(bytesToHex(id), { id, grant, grantedAtRevision: 0n })
  }
  const policies = new Map<string, EffectivePolicy>()
  for (const policy of manifest.validationPolicies) {
    const id = await validationPolicyId(policy)
    protocolInvariant(!policies.has(bytesToHex(id)), 'SCHEMA_INVALID', 'Genesis contains a duplicate policy')
    policies.set(bytesToHex(id), { id, policy, installedAtRevision: 0n })
  }
  return {
    groupId: manifest.groupId,
    revision: 0n,
    revisionDigest: genesisDigest,
    rootAdminPublicKey: manifest.rootAdminPublicKey,
    capabilityLogFeed: manifest.capabilityLogFeed,
    capabilities,
    policies,
    recoveryPublicKeys: manifest.recoveryPublicKeys,
    recoveryThreshold: manifest.recoveryThreshold,
    historyReopened: false,
  }
}

export async function reduceCapabilityLog(
  genesis: SignedGenesis,
  inputRevisions: readonly SignedCapabilityRevision[],
): Promise<CapabilitySnapshot> {
  let snapshot = await genesisSnapshot(genesis)
  const revisions = [...inputRevisions].sort((a, b) => a.revision.revision < b.revision.revision ? -1 : a.revision.revision > b.revision.revision ? 1 : 0)
  for (const signed of revisions) {
    const revision = decodeCapabilityRevision(encodeCapabilityRevision(signed.revision))
    protocolInvariant(equalBytes(revision.groupId, snapshot.groupId), 'SCHEMA_INVALID', 'Capability revision belongs to another group')
    protocolInvariant(revision.revision === snapshot.revision + 1n, 'SCHEMA_INVALID', 'Capability log contains a gap or conflicting revision')
    protocolInvariant(equalBytes(revision.previousRevisionDigest, snapshot.revisionDigest), 'DIGEST_MISMATCH', 'Capability revision does not extend current chain')
    protocolInvariant(equalBytes(revision.issuerRootPublicKey, snapshot.rootAdminPublicKey), 'INVALID_KEY', 'Capability revision has the wrong root issuer')
    protocolInvariant(await verifyDomain(DOMAINS.capabilityRevision, encodeCapabilityRevision(revision), signed.signature, snapshot.rootAdminPublicKey), 'INVALID_SIGNATURE', 'Capability revision signature is invalid')

    const capabilities = new Map(snapshot.capabilities)
    for (const revokedId of revision.revocations) {
      const key = bytesToHex(revokedId)
      const active = capabilities.get(key)
      protocolInvariant(active !== undefined, 'SCHEMA_INVALID', 'Capability revision revokes an unknown capability')
      protocolInvariant(active.revokedAtRevision === undefined, 'SCHEMA_INVALID', 'Capability is already revoked')
      capabilities.set(key, { ...active, revokedAtRevision: revision.revision })
    }
    for (const grant of revision.grants) {
      protocolInvariant(grant.validFromRevision === revision.revision, 'SCHEMA_INVALID', 'New capability must begin at its containing revision')
      if (grant.role === 'validator') {
        const currentFloor = [...capabilities.values()]
          .filter((entry) => entry.grant.role === 'validator' && entry.revokedAtRevision === undefined)
          .reduce((maximum, entry) => {
            const floor = entry.grant.minimumAuthorTimestampMs ?? 0n
            return floor > maximum ? floor : maximum
          }, 0n)
        protocolInvariant((grant.minimumAuthorTimestampMs ?? -1n) >= currentFloor, 'SCHEMA_INVALID', 'New validator would reopen closed timestamp history')
      }
      const id = await capabilityId(grant)
      protocolInvariant(!capabilities.has(bytesToHex(id)), 'SCHEMA_INVALID', 'Capability revision contains a duplicate grant')
      capabilities.set(bytesToHex(id), { id, grant, grantedAtRevision: revision.revision })
    }
    const policies = new Map(snapshot.policies)
    for (const policy of revision.validationPolicies) {
      const id = await validationPolicyId(policy)
      protocolInvariant(!policies.has(bytesToHex(id)), 'SCHEMA_INVALID', 'Capability revision repeats an existing policy')
      policies.set(bytesToHex(id), { id, policy, installedAtRevision: revision.revision })
    }
    const revisionDigest = await capabilityRevisionDigest(revision)
    snapshot = {
      ...snapshot,
      revision: revision.revision,
      revisionDigest,
      rootAdminPublicKey: revision.successorRootPublicKey ?? snapshot.rootAdminPublicKey,
      capabilityLogFeed: revision.successorCapabilityLogFeed ?? snapshot.capabilityLogFeed,
      capabilities,
      policies,
    }
  }
  return snapshot
}

export function isCapabilityActive(capability: EffectiveCapability, revision: bigint): boolean {
  return capability.grant.validFromRevision <= revision
    && (capability.grant.validUntilRevision === undefined || revision <= capability.grant.validUntilRevision)
    && (capability.revokedAtRevision === undefined || revision < capability.revokedAtRevision)
}

export function capabilitiesForSubject(
  snapshot: CapabilitySnapshot,
  subjectId: Uint8Array,
  revision = snapshot.revision,
): EffectiveCapability[] {
  return [...snapshot.capabilities.values()]
    .filter((capability) => equalBytes(capability.grant.subjectId, subjectId) && isCapabilityActive(capability, revision))
    .sort((a, b) => compareBytes(a.id, b.id))
}

export function hasRole(
  snapshot: CapabilitySnapshot,
  subjectId: Uint8Array,
  role: CapabilityGrant['role'],
  revision = snapshot.revision,
): boolean {
  return capabilitiesForSubject(snapshot, subjectId, revision).some((capability) => capability.grant.role === role)
}

export async function capabilitySnapshotDigest(snapshot: CapabilitySnapshot): Promise<Uint8Array> {
  const entries = [...snapshot.capabilities.values()].sort((a, b) => compareBytes(a.id, b.id))
  const policies = [...snapshot.policies.values()].sort((a, b) => compareBytes(a.id, b.id))
  const value = integerMap([
    [0, snapshot.groupId], [1, snapshot.revision], [2, snapshot.revisionDigest],
    [3, snapshot.rootAdminPublicKey], [4, snapshot.capabilityLogFeed],
    [5, entries.map((entry) => (awaitImportHackGrant(entry)))],
    [6, policies.map((entry) => (awaitImportHackPolicy(entry)))],
    [7, snapshot.historyReopened], [8, snapshot.recoveryEventDigest],
  ])
  return hashDomain(DOMAINS.capabilitySnapshot, encodeCanonicalCbor(value))
}

function awaitImportHackGrant(entry: EffectiveCapability) {
  return integerMap([
    [0, capabilityCodecInternals.grantToCbor(entry.grant)],
    [1, entry.id],
    [2, entry.grantedAtRevision],
    [3, entry.revokedAtRevision],
  ])
}

function awaitImportHackPolicy(entry: EffectivePolicy) {
  return integerMap([
    [0, capabilityCodecInternals.policyToCbor(entry.policy)],
    [1, entry.id],
    [2, entry.installedAtRevision],
  ])
}
