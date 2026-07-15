import { readdir, readFile } from 'node:fs/promises'

import { describe, expect, it } from 'vitest'

describe('runtime-workerd import boundary', () => {
  it('keeps Node, native, process, and SSB dependencies out of runtime sources', async () => {
    const sourceDirectory = new URL('.', import.meta.url)
    const names = (await readdir(sourceDirectory))
      .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    const sources = await Promise.all(names.map(async (name) => ({
      name,
      source: await readFile(new URL(name, sourceDirectory), 'utf8'),
    })))
    const forbidden = [
      /(?:from|import\s*)\s*['"]node:/,
      /@dolthub\/doltlite/,
      /(?:^|[^A-Za-z])process(?:[^A-Za-z]|$)/,
      /transport-ssb|ssb-db|secret-stack/,
      /node-gyp|N-API|node-addon-api/,
    ]
    for (const file of sources) {
      for (const pattern of forbidden) expect(file.source, `${file.name}: ${pattern}`).not.toMatch(pattern)
    }
  })
})
