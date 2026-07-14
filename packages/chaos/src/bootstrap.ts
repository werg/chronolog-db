import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'

import { encodeSchemaManifest } from '@chronolog/ir'
import { exportEd25519PrivateKey, generateEd25519KeyPair } from '@chronolog/protocol'

import type { SeededRandom } from './rng.js'
import { chaosSchema } from './schema.js'
import type { ChaosScenario, NodeName } from './types.js'

const require = createRequire(import.meta.url)

interface SsbKeys {
  readonly curve: 'ed25519'
  readonly public: string
  readonly private: string
  readonly id: string
}

export interface PreparedNode {
  readonly name: NodeName
  readonly directory: string
  readonly publicKey: string
  readonly validatorCapability: string
  readonly ssb: SsbKeys
}

export interface PreparedCluster {
  readonly groupId: string
  readonly groupIdUrl: string
  readonly nodes: readonly PreparedNode[]
}

export async function prepareCluster(
  runDirectory: string,
  scenario: ChaosScenario,
  random: SeededRandom,
): Promise<PreparedCluster> {
  const bytes = (length = 32): string => Buffer.from(random.bytes(length)).toString('base64')
  const groupId = bytes()
  const groupRoute = bytes()
  const membershipRevision = bytes()
  const validationPolicy = bytes()
  const epochContentKey = bytes()
  const ssbKeys = require('ssb-keys') as { generate(curve?: string, seed?: Buffer): SsbKeys }
  const nodes: PreparedNode[] = []

  for (let index = 0; index < scenario.nodes; index += 1) {
    const name: NodeName = `node-${index}`
    const directory = join(runDirectory, 'nodes', name)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const identity = await generateEd25519KeyPair()
    const publicKey = Buffer.from(identity.publicKeyBytes).toString('base64')
    const validatorCapability = bytes()
    const ssb = ssbKeys.generate('ed25519', Buffer.from(random.bytes(32)))
    await writeJson(join(directory, 'config.json'), {
      format: 'chronolog-daemon',
      groupId,
      groupRoute,
      membershipRevision,
      validationPolicy,
      validatorCapability,
      epoch: '1',
      epochContentKey,
      publicKey,
      privateKeyPkcs8: Buffer.from(await exportEd25519PrivateKey(identity.privateKey)).toString('base64'),
    }, 0o600)
    await writeFile(join(directory, 'secret'), `${JSON.stringify(ssb, null, 2)}\n`, { mode: 0o600 })
    await writeFile(join(directory, 'schema.cbor'), encodeSchemaManifest(chaosSchema(scenario.workload.accounts)), { mode: 0o600 })
    nodes.push({ name, directory, publicKey, validatorCapability, ssb })
  }

  const membership = {
    format: 'chronolog-static-membership',
    groupId,
    membershipRevision,
    validationPolicy,
    // Bind every inner protocol signer to its authenticated outer SSB feed.
    // Without this mapping, copying a valid signed message into another feed
    // would erase the provenance that the replication layer authenticated.
    writers: nodes.map((node) => ({ publicKey: node.publicKey, transportAuthor: node.ssb.id })),
    validators: nodes.map((node) => ({
      publicKey: node.publicKey,
      capability: node.validatorCapability,
      transportAuthor: node.ssb.id,
    })),
    threshold: scenario.threshold,
    watermarkThreshold: scenario.threshold,
  }
  await Promise.all(nodes.map((node) => writeJson(join(node.directory, 'membership.json'), membership, 0o600)))
  await writeJson(join(runDirectory, 'cluster.json'), {
    format: 'chronolog-chaos-cluster',
    groupId,
    membershipRevision,
    validationPolicy,
    threshold: scenario.threshold,
    nodes: nodes.map((node) => ({ name: node.name, publicKey: node.publicKey, validatorCapability: node.validatorCapability, ssbId: node.ssb.id })),
  })
  return { groupId, groupIdUrl: Buffer.from(groupId, 'base64').toString('base64url'), nodes }
}

async function writeJson(path: string, value: unknown, mode = 0o644): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode })
}
