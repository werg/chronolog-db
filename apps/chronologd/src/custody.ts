import { resolve } from 'node:path'

import { daemonSecretStoreFromEnvironment } from './secret-store.js'
import { exportRecoveryCustody, purgeExportedRecoveryCustody } from './governance-config.js'

const [command, directory, confirmation] = process.argv.slice(2)
const dataDirectory = resolve(process.env.CHRONOLOG_DATA_DIR ?? '.chronolog')
const secretStore = daemonSecretStoreFromEnvironment(process.env)

if (command === 'export' && directory !== undefined) {
  const manifest = await exportRecoveryCustody({
    dataDirectory,
    outputDirectory: resolve(directory),
    ...(secretStore === undefined ? {} : { secretStore }),
  })
  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`)
} else if (command === 'purge' && directory !== undefined) {
  await purgeExportedRecoveryCustody({
    dataDirectory,
    custodyDirectory: resolve(directory),
    ...(secretStore === undefined ? {} : { secretStore }),
    confirmExternalCustody: confirmation === '--confirm-external-custody',
  })
  process.stdout.write(`${JSON.stringify({ recoveryCustody: 'external' })}\n`)
} else {
  process.stderr.write('Usage: pnpm custody <export DIRECTORY|purge DIRECTORY --confirm-external-custody>\n')
  process.exit(1)
}
