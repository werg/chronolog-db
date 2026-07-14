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
      writers: [base64(writer)],
      validators: [{ publicKey: base64(validator), capability: base64(capability) }],
      threshold: 1,
    }))
    const resolver = await loadStaticMembership(path, { groupId, membershipRevision, validationPolicy })
    const context = { groupId, membershipRevision, validationPolicy, writerId: writer }
    expect(await resolver.canWrite(context)).toBe(true)
    expect(await resolver.canWrite({ ...context, writerId: bytes(9) })).toBe(false)
    expect(await resolver.canValidate({ ...context, validatorId: validator, validatorCapability: capability })).toBe(true)
    expect(await resolver.canValidate({ ...context, validatorId: validator, validatorCapability: bytes(9) })).toBe(false)
    expect(await resolver.threshold(context)).toBe(1)
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
})

function bytes(seed: number): Uint8Array { return Uint8Array.from({ length: 32 }, (_value, index) => seed + index) }
function base64(value: Uint8Array): string { return Buffer.from(value).toString('base64') }
