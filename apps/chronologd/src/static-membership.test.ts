import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { loadStaticMembership } from './static-membership.js'

describe('static membership bootstrap', () => {
  const directories: string[] = []
  afterEach(async () => Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))))

  it('pins the group revision and policy while authorizing exact writer and validator capabilities', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'chronolog-membership-'))
    directories.push(directory)
    const groupId = bytes(1), membershipRevision = bytes(2), validationPolicy = bytes(3)
    const writer = bytes(4), validator = bytes(5), capability = bytes(6)
    const path = join(directory, 'membership.json')
    await writeFile(path, JSON.stringify({
      format: 'chronolog-static-membership',
      groupId: base64(groupId), membershipRevision: base64(membershipRevision), validationPolicy: base64(validationPolicy),
      writers: [{ publicKey: base64(writer), transportAuthor: '@writer.ed25519' }],
      validators: [{ publicKey: base64(validator), capability: base64(capability), transportAuthor: '@validator.ed25519' }],
      threshold: 1,
      policyVersion: '4',
    }))
    const resolver = await loadStaticMembership(path, { groupId, membershipRevision, validationPolicy })
    const context = { groupId, membershipRevision, validationPolicy, writerId: writer }
    expect(await resolver.canWrite(context)).toBe(true)
    expect(await resolver.canWrite({ ...context, writerId: bytes(9) })).toBe(false)
    expect(await resolver.canValidate({ ...context, validatorId: validator, validatorCapability: capability })).toBe(true)
    expect(await resolver.canValidate({ ...context, validatorId: validator, validatorCapability: bytes(9) })).toBe(false)
    expect(await resolver.threshold(context)).toBe(1)
    expect(await resolver.policyVersion?.(context)).toBe(4n)
    expect(await resolver.canUseTransportAuthor?.({
      groupId,
      membershipRevision,
      role: 'writer',
      signingId: writer,
      transportAuthor: '@writer.ed25519',
    })).toBe(true)
    expect(await resolver.canUseTransportAuthor?.({
      groupId,
      membershipRevision,
      role: 'writer',
      signingId: writer,
      transportAuthor: '@copied.ed25519',
    })).toBe(false)
  })

  it('rejects duplicate identities and thresholds larger than the validator set', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'chronolog-membership-invalid-'))
    directories.push(directory)
    const pins = { groupId: bytes(1), membershipRevision: bytes(2), validationPolicy: bytes(3) }
    const writer = base64(bytes(4)), validator = base64(bytes(5)), capability = base64(bytes(6))
    const path = join(directory, 'membership.json')
    await writeFile(path, JSON.stringify({
      format: 'chronolog-static-membership',
      groupId: base64(pins.groupId), membershipRevision: base64(pins.membershipRevision), validationPolicy: base64(pins.validationPolicy),
      writers: [writer], validators: [{ publicKey: validator, capability }], threshold: 2,
    }))
    await expect(loadStaticMembership(path, pins)).rejects.toThrow('STATIC_MEMBERSHIP_INVALID_THRESHOLD')
  })

  it('rejects unknown fields and malformed transport-author bindings', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'chronolog-membership-shape-'))
    directories.push(directory)
    const pins = { groupId: bytes(1), membershipRevision: bytes(2), validationPolicy: bytes(3) }
    const document = {
      format: 'chronolog-static-membership',
      groupId: base64(pins.groupId),
      membershipRevision: base64(pins.membershipRevision),
      validationPolicy: base64(pins.validationPolicy),
      writers: [{ publicKey: base64(bytes(4)), transportAuthor: 'not-a-feed' }],
      validators: [{ publicKey: base64(bytes(5)), capability: base64(bytes(6)), transportAuthor: '@validator.ed25519' }],
      threshold: 1,
    }
    const path = join(directory, 'membership.json')
    await writeFile(path, JSON.stringify(document))
    await expect(loadStaticMembership(path, pins)).rejects.toThrow('STATIC_MEMBERSHIP_INVALID_TRANSPORT_AUTHOR')
    await writeFile(path, JSON.stringify({ ...document, writers: [], ambientAuthority: true }))
    await expect(loadStaticMembership(path, pins)).rejects.toThrow('STATIC_MEMBERSHIP_INVALID')
  })
})

function bytes(seed: number): Uint8Array { return Uint8Array.from({ length: 32 }, (_value, index) => seed + index) }
function base64(value: Uint8Array): string { return Buffer.from(value).toString('base64') }
