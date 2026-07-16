import { readdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { assertConformanceReport, type ConformanceReport } from './conformance-report.js'

export async function compareConformanceReports(directory: string): Promise<readonly ConformanceReport[]> {
  const names = (await readdir(directory, { recursive: true }))
    .filter((name) => name.endsWith('.json'))
    .sort()
  if (names.length < 2) throw new Error('CONFORMANCE_REPORTS_INSUFFICIENT')
  const reports = await Promise.all(names.map(async (name) => {
    const value = JSON.parse(await readFile(resolve(directory, name), 'utf8')) as unknown
    assertConformanceReport(value)
    return value
  }))
  const expected = reports[0]?.deterministic.portableSemanticDigest
  if (expected === undefined || reports.some((report) => report.deterministic.portableSemanticDigest !== expected)) {
    throw new Error('CONFORMANCE_PORTABLE_PLATFORM_MISMATCH')
  }
  return reports
}

async function main(): Promise<void> {
  const directory = resolve(process.argv[2] ?? 'artifacts/conformance-platforms')
  const reports = await compareConformanceReports(directory)
  process.stdout.write(`${JSON.stringify({
    format: 'chronolog-conformance-comparison-v1',
    portableSemanticDigest: reports[0]?.deterministic.portableSemanticDigest,
    platforms: reports.map((report) => report.operational.platform).sort(),
  }, null, 2)}\n`)
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main()
