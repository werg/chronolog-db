import { readFile } from 'node:fs/promises'

import type { WatermarkPolicy } from '@chronolog/control-store'
import type { MembershipResolver } from '@chronolog/node-core'
import { equalBytes } from '@chronolog/protocol'

import { fromBase64 } from './config.js'

export interface StaticMembershipFile {
  readonly format: 'chronolog-static-membership'
  readonly groupId: string
  readonly membershipRevision: string
  readonly validationPolicy: string
  readonly writers: readonly (string | {
    readonly publicKey: string
    readonly transportAuthor: string
  })[]
  readonly validators: readonly {
    readonly publicKey: string
    readonly capability: string
    readonly transportAuthor?: string
  }[]
  readonly threshold: number
  readonly watermarkThreshold?: number
  readonly policyVersion?: string
}

/**
 * Loads a recovery-controlled, out-of-band membership snapshot. The file is a
 * bootstrap mechanism, not consensus state: every participant must pin the
 * same group, membership revision, and validation policy in its daemon config.
 */
export async function loadStaticMembership(
  path: string,
  pins: {
    readonly groupId: Uint8Array
    readonly membershipRevision: Uint8Array
    readonly validationPolicy: Uint8Array
  },
): Promise<MembershipResolver> {
  const document = parseStaticMembership(JSON.parse(await readFile(path, 'utf8')))
  const groupId = decode32(document.groupId, 'groupId')
  const membershipRevision = decode32(document.membershipRevision, 'membershipRevision')
  const validationPolicy = decode32(document.validationPolicy, 'validationPolicy')
  if (!equalBytes(groupId, pins.groupId)) throw new Error('STATIC_MEMBERSHIP_GROUP_MISMATCH')
  if (!equalBytes(membershipRevision, pins.membershipRevision)) throw new Error('STATIC_MEMBERSHIP_REVISION_MISMATCH')
  if (!equalBytes(validationPolicy, pins.validationPolicy)) throw new Error('STATIC_MEMBERSHIP_POLICY_MISMATCH')

  const writers = document.writers.map((value, index) => typeof value === 'string'
    ? { publicKey: decode32(value, `writers[${index}]`) }
    : {
        publicKey: decode32(value.publicKey, `writers[${index}].publicKey`),
        transportAuthor: transportAuthor(value.transportAuthor),
      })
  if (writers.length === 0) throw new Error('STATIC_MEMBERSHIP_REQUIRES_WRITER')
  assertUnique(writers.map((writer) => writer.publicKey), 'writer')
  const validators = document.validators.map((validator, index) => ({
    publicKey: decode32(validator.publicKey, `validators[${index}].publicKey`),
    capability: decode32(validator.capability, `validators[${index}].capability`),
    ...(validator.transportAuthor === undefined ? {} : { transportAuthor: transportAuthor(validator.transportAuthor) }),
  }))
  if (validators.length === 0) throw new Error('STATIC_MEMBERSHIP_REQUIRES_VALIDATOR')
  assertUnique(validators.map((validator) => validator.publicKey), 'validator public key')
  assertUnique(validators.map((validator) => validator.capability), 'validator capability')
  assertThreshold(document.threshold, validators.length, 'threshold')
  const watermarkThreshold = document.watermarkThreshold ?? document.threshold
  const policyVersion = parsePolicyVersion(document.policyVersion)
  assertThreshold(watermarkThreshold, validators.length, 'watermarkThreshold')
  const watermarkPolicy: WatermarkPolicy = {
    kind: 'threshold',
    policyId: Buffer.from(validationPolicy).toString('base64url'),
    validatorIds: validators.map((validator) => validator.publicKey),
    threshold: watermarkThreshold,
  }

  const matchesPins = (context: {
    readonly groupId: Uint8Array
    readonly membershipRevision: Uint8Array
    readonly validationPolicy: Uint8Array
  }): boolean => equalBytes(context.groupId, groupId) &&
    equalBytes(context.membershipRevision, membershipRevision) &&
    equalBytes(context.validationPolicy, validationPolicy)

  return {
    canWrite: (context) => matchesPins(context) && writers.some((writer) => equalBytes(writer.publicKey, context.writerId)),
    canValidate: (context) => matchesPins(context) && validators.some((validator) =>
      equalBytes(validator.publicKey, context.validatorId) &&
      equalBytes(validator.capability, context.validatorCapability)),
    threshold: (context) => matchesPins(context) ? document.threshold : Number.MAX_SAFE_INTEGER,
    policyVersion: (context) => matchesPins(context) ? policyVersion : -1n,
    canHeartbeat: (context) =>
      equalBytes(context.groupId, groupId) &&
      equalBytes(context.membershipRevision, membershipRevision) &&
      validators.some((validator) =>
        equalBytes(validator.publicKey, context.validatorId) &&
        equalBytes(validator.capability, context.validatorCapability)),
    canUseTransportAuthor: (context) => {
      if (!equalBytes(context.groupId, groupId) || !equalBytes(context.membershipRevision, membershipRevision)) return false
      if (context.role === 'writer') return writers.some((writer) =>
        equalBytes(writer.publicKey, context.signingId) && writer.transportAuthor === context.transportAuthor)
      return validators.some((validator) =>
        equalBytes(validator.publicKey, context.signingId) &&
        equalBytes(validator.capability, context.validatorCapability ?? new Uint8Array()) &&
        validator.transportAuthor === context.transportAuthor)
    },
    watermarkPolicy: (core) => matchesPins(core) ? watermarkPolicy : null,
  }
}

function parseStaticMembership(value: unknown): StaticMembershipFile {
  if (!isRecord(value) || value.format !== 'chronolog-static-membership') {
    throw new Error('STATIC_MEMBERSHIP_UNSUPPORTED')
  }
  const fields = new Set([
    'format', 'groupId', 'membershipRevision', 'validationPolicy', 'writers', 'validators',
    'threshold', 'watermarkThreshold', 'policyVersion',
  ])
  if (
    Object.keys(value).some((field) => !fields.has(field)) ||
    typeof value.groupId !== 'string' ||
    typeof value.membershipRevision !== 'string' ||
    typeof value.validationPolicy !== 'string' ||
    !Array.isArray(value.writers) || !value.writers.every((writer) =>
      typeof writer === 'string' || (isRecord(writer) &&
        hasOnlyKeys(writer, ['publicKey', 'transportAuthor']) &&
        typeof writer.publicKey === 'string' && typeof writer.transportAuthor === 'string')) ||
    !Array.isArray(value.validators) || !value.validators.every((validator) =>
      isRecord(validator) && hasOnlyKeys(validator, ['publicKey', 'capability', 'transportAuthor']) &&
      typeof validator.publicKey === 'string' &&
      typeof validator.capability === 'string' &&
      (validator.transportAuthor === undefined || typeof validator.transportAuthor === 'string')) ||
    typeof value.threshold !== 'number' ||
    (value.watermarkThreshold !== undefined && typeof value.watermarkThreshold !== 'number') ||
    (value.policyVersion !== undefined && typeof value.policyVersion !== 'string')
  ) throw new Error('STATIC_MEMBERSHIP_INVALID')
  return value as unknown as StaticMembershipFile
}

function parsePolicyVersion(value: string | undefined): bigint {
  if (value === undefined) return 1n
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new Error('STATIC_MEMBERSHIP_INVALID_POLICY_VERSION')
  return BigInt(value)
}

function transportAuthor(value: string): string {
  if (!value.startsWith('@') || !value.endsWith('.ed25519')) throw new Error('STATIC_MEMBERSHIP_INVALID_TRANSPORT_AUTHOR')
  return value
}

function decode32(value: string, field: string): Uint8Array {
  const decoded = fromBase64(value)
  if (decoded.length !== 32) throw new Error(`STATIC_MEMBERSHIP_INVALID_${field.toUpperCase().replaceAll(/[^A-Z0-9]/g, '_')}`)
  return decoded
}

function assertUnique(values: readonly Uint8Array[], label: string): void {
  const keys = values.map((value) => Buffer.from(value).toString('base64'))
  if (new Set(keys).size !== keys.length) throw new Error(`STATIC_MEMBERSHIP_DUPLICATE_${label.toUpperCase().replaceAll(' ', '_')}`)
}

function assertThreshold(value: number, validatorCount: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > validatorCount) {
    throw new Error(`STATIC_MEMBERSHIP_INVALID_${field.toUpperCase()}`)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = new Set(allowed)
  return Object.keys(value).every((key) => keys.has(key))
}
