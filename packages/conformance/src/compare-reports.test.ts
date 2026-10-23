import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { compareConformanceReports } from './compare-reports.js'
import { generateConformanceReport } from './conformance-report.js'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function writeReports(
  entries: readonly { readonly platform: string; readonly sourceCommit: string }[],
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'chronolog-compare-'))
  directories.push(directory)
  for (const [index, entry] of entries.entries()) {
    const report = await generateConformanceReport({ ...entry, generatedAt: '2026-01-01T00:00:00.000Z' })
    await writeFile(join(directory, `report-${String(index)}.json`), JSON.stringify(report))
  }
  return directory
}

describe('conformance report comparison', () => {
  it('accepts matching reports from one commit covering every required platform', async () => {
    const directory = await writeReports([
      { platform: 'linux-x64-node24', sourceCommit: 'abc' },
      { platform: 'darwin-arm64-node24', sourceCommit: 'abc' },
    ])
    const reports = await compareConformanceReports(directory, { requiredPlatforms: ['linux', 'darwin'] })
    expect(reports).toHaveLength(2)
  })

  it('fails closed when a required platform is absent', async () => {
    const directory = await writeReports([
      { platform: 'linux-x64-node24', sourceCommit: 'abc' },
      { platform: 'linux-arm64-node24', sourceCommit: 'abc' },
    ])
    await expect(compareConformanceReports(directory, { requiredPlatforms: ['linux', 'darwin'] }))
      .rejects.toThrow('CONFORMANCE_REQUIRED_PLATFORM_MISSING:darwin')
  })

  it('fails closed when reports come from different source commits', async () => {
    const directory = await writeReports([
      { platform: 'linux-x64-node24', sourceCommit: 'abc' },
      { platform: 'darwin-arm64-node24', sourceCommit: 'def' },
    ])
    await expect(compareConformanceReports(directory)).rejects.toThrow('CONFORMANCE_SOURCE_COMMIT_MISMATCH')
  })

  it('requires at least two reports', async () => {
    const directory = await writeReports([{ platform: 'linux-x64-node24', sourceCommit: 'abc' }])
    await expect(compareConformanceReports(directory)).rejects.toThrow('CONFORMANCE_REPORTS_INSUFFICIENT')
  })
})
