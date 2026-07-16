import { readFile } from 'node:fs/promises'

import {
  combineRecoveryArtifacts,
  inspectRecoveryPayload,
  prepareRecoveryPayload,
  signRecoveryArtifact,
  verifyRecoveryArtifact,
  type RecoveryCustodyPublicManifest,
  type RecoveryPayloadSpec,
} from './ceremony.js'

const [command, ...args] = process.argv.slice(2)
if (command === 'prepare') {
  const spec = JSON.parse(await inlineOrFile(required(args[0], 'prepare SPEC_JSON_OR_@FILE'))) as RecoveryPayloadSpec
  process.stdout.write(`${prepareRecoveryPayload(spec)}\n`)
} else if (command === 'inspect') {
  const payload = (await inlineOrFile(required(args[0], 'inspect PAYLOAD_OR_@FILE'))).trim()
  process.stdout.write(`${JSON.stringify(inspectRecoveryPayload(payload), null, 2)}\n`)
} else if (command === 'sign') {
  const payload = (await inlineOrFile(required(args[0], 'sign PAYLOAD_OR_@FILE KEY_INDEX PRIVATE_KEY_@FILE'))).trim()
  const keyIndex = Number(required(args[1], 'sign PAYLOAD_OR_@FILE KEY_INDEX PRIVATE_KEY_@FILE'))
  const privateKey = await inlineOrFile(required(args[2], 'sign PAYLOAD_OR_@FILE KEY_INDEX PRIVATE_KEY_@FILE'))
  process.stdout.write(`${await signRecoveryArtifact(payload, keyIndex, privateKey)}\n`)
} else if (command === 'combine') {
  const payload = (await inlineOrFile(required(args.shift(), 'combine PAYLOAD_OR_@FILE SIGNED_ARTIFACT...'))).trim()
  const artifacts = await Promise.all(args.map(async (value) => (await inlineOrFile(value)).trim()))
  process.stdout.write(`${combineRecoveryArtifacts(payload, artifacts)}\n`)
} else if (command === 'verify') {
  const record = (await inlineOrFile(required(args[0], 'verify RECORD_OR_@FILE CUSTODY_MANIFEST_@FILE'))).trim()
  const manifest = JSON.parse(await inlineOrFile(required(args[1], 'verify RECORD_OR_@FILE CUSTODY_MANIFEST_@FILE'))) as RecoveryCustodyPublicManifest
  const valid = await verifyRecoveryArtifact(record, manifest)
  process.stdout.write(`${JSON.stringify({ valid })}\n`)
  if (!valid) process.exitCode = 2
} else {
  process.stderr.write('Usage: chronolog-recovery <prepare|inspect|sign|combine|verify> ...\n')
  process.exit(1)
}

async function inlineOrFile(value: string): Promise<string> { return value.startsWith('@') ? readFile(value.slice(1), 'utf8') : value }
function required(value: string | undefined, usage: string): string { if (value === undefined) throw new Error(`Usage: chronolog-recovery ${usage}`); return value }
