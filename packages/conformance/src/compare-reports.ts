import { readdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { assertConformanceReport, type ConformanceReport } from './conformance-report.js'

export interface CompareOptions {
  /** Platform prefixes (for example `linux`, `darwin`) that at least one report must match. */
  readonly requiredPlatforms?: readonly string[]
}

export async function compareConformanceReports(
  directory: string,
  options: CompareOptions = {},
): Promise<readonly ConformanceReport[]> {
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
  const commit = reports[0]?.operational.sourceCommit
  if (reports.some((report) => report.operational.sourceCommit !== commit)) {
    throw new Error('CONFORMANCE_SOURCE_COMMIT_MISMATCH')
  }
  for (const required of options.requiredPlatforms ?? []) {
    if (!reports.some((report) => report.operational.platform.startsWith(required))) {
      throw new Error(`CONFORMANCE_REQUIRED_PLATFORM_MISSING:${required}`)
    }
  }
  return reports
}

function parseArgs(argv: readonly string[]): { readonly directory: string; readonly requiredPlatforms: readonly string[] } {
  const requiredPlatforms: string[] = []
  let directory: string | undefined
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--require-platform') {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--')) throw new Error('CONFORMANCE_REQUIRE_PLATFORM_VALUE_MISSING')
      requiredPlatforms.push(value)
      index += 1
    } else if (arg !== undefined && arg.startsWith('--')) {
      throw new Error(`CONFORMANCE_UNKNOWN_FLAG:${arg}`)
    } else if (arg !== undefined && directory === undefined) {
      directory = arg
    }
  }
  return { directory: resolve(directory ?? 'artifacts/conformance-platforms'), requiredPlatforms }
}

async function main(): Promise<void> {
  const { directory, requiredPlatforms } = parseArgs(process.argv.slice(2))
  const reports = await compareConformanceReports(directory, { requiredPlatforms })
  process.stdout.write(`${JSON.stringify({
    format: 'chronolog-conformance-comparison-v1',
    sourceCommit: reports[0]?.operational.sourceCommit,
    portableSemanticDigest: reports[0]?.deterministic.portableSemanticDigest,
    platforms: reports.map((report) => report.operational.platform).sort(),
  }, null, 2)}\n`)
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main()
