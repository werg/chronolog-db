import { bytesToHex, compareBytes, protocolInvariant, utf8 } from '@chronolog/protocol'
import type { PolicyEvaluation, ValidationPolicy, ValidatorEvidence } from './types.js'

function missingConstraints(policy: ValidationPolicy, evidence: readonly ValidatorEvidence[]): string[] {
  const missing: string[] = []
  if (BigInt(evidence.length) < policy.minimumValidators) {
    missing.push(`validators:${policy.minimumValidators - BigInt(evidence.length)}`)
  }
  for (const [className, minimum] of [...policy.classMinimums].sort(([a], [b]) => compareBytes(utf8(a), utf8(b)))) {
    const count = BigInt(evidence.filter((item) => item.validatorClass === className).length)
    if (count < minimum) missing.push(`class:${className}:${minimum - count}`)
  }
  for (const organization of [...policy.requiredOrganizations].sort((a, b) => compareBytes(utf8(a), utf8(b)))) {
    if (!evidence.some((item) => item.organization === organization)) missing.push(`organization:${organization}`)
  }
  return missing
}

function selectionOrder(left: readonly ValidatorEvidence[], right: readonly ValidatorEvidence[]): number {
  if (left.length !== right.length) return left.length - right.length
  for (let index = 0; index < left.length; index += 1) {
    const order = compareBytes(left[index]?.capabilityId ?? new Uint8Array(), right[index]?.capabilityId ?? new Uint8Array())
    if (order !== 0) return order
  }
  return 0
}

function stateKey(policy: ValidationPolicy, evidence: readonly ValidatorEvidence[]): string {
  const total = BigInt(Math.min(evidence.length, Number(policy.minimumValidators)))
  const classes = [...policy.classMinimums].sort(([a], [b]) => compareBytes(utf8(a), utf8(b))).map(([name, minimum]) => {
    const count = BigInt(evidence.filter((item) => item.validatorClass === name).length)
    return `${name}:${count < minimum ? count : minimum}`
  })
  const organizations = [...policy.requiredOrganizations]
    .sort((a, b) => compareBytes(utf8(a), utf8(b)))
    .map((name) => evidence.some((item) => item.organization === name) ? '1' : '0')
  return `${total}|${classes.join(',')}|${organizations.join('')}`
}

export function evaluateValidationPolicy(
  policy: ValidationPolicy,
  evidence: readonly ValidatorEvidence[],
): PolicyEvaluation {
  protocolInvariant(policy.minimumValidators > 0n, 'SCHEMA_INVALID', 'Validation threshold must be positive')
  const uniqueCapabilities = new Map<string, ValidatorEvidence>()
  const canonicalEvidence = [...evidence].sort((left, right) => {
    const capabilityOrder = compareBytes(left.capabilityId, right.capabilityId)
    if (capabilityOrder !== 0) return capabilityOrder
    return compareBytes(left.validatorId, right.validatorId)
  })
  for (const item of canonicalEvidence) {
    const capabilityKey = bytesToHex(item.capabilityId)
    if (!uniqueCapabilities.has(capabilityKey)) uniqueCapabilities.set(capabilityKey, item)
  }
  const sorted = [...uniqueCapabilities.values()].sort((a, b) => compareBytes(a.capabilityId, b.capabilityId))
  const allMissing = missingConstraints(policy, sorted)
  if (allMissing.length > 0) return { satisfied: false, selected: [], missing: allMissing }

  // Dynamic programming over capped policy states finds the smallest proof,
  // then the lexicographically smallest capability list for stable caching.
  let states = new Map<string, readonly ValidatorEvidence[]>([[stateKey(policy, []), []]])
  for (const item of sorted) {
    const next = new Map(states)
    for (const selected of states.values()) {
      const candidate = [...selected, item]
      const key = stateKey(policy, candidate)
      const existing = next.get(key)
      if (existing === undefined || selectionOrder(candidate, existing) < 0) next.set(key, candidate)
    }
    states = next
  }
  const satisfying = [...states.values()].filter((items) => missingConstraints(policy, items).length === 0)
    .sort(selectionOrder)[0]
  protocolInvariant(satisfying !== undefined, 'SCHEMA_INVALID', 'Policy solver failed to retain a satisfying state')
  return { satisfied: true, selected: satisfying, missing: [] }
}
