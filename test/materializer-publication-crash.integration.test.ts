import { spawnSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { createCoreExecutionManifest } from '@chronolog/compiler-sqlite'
import {
  DeterministicMaterializer,
  readNativeEngineInfo,
  type MaterializerPublicationFaultPoint,
} from '@chronolog/materializer-doltlite'
import { afterEach, describe, expect, it } from 'vitest'

const directories: string[] = []
const prePublication: readonly MaterializerPublicationFaultPoint[] = [
  'after_candidate_commit',
  'after_revision_ref_created',
  'before_head_publish',
]
const postPublication: readonly MaterializerPublicationFaultPoint[] = [
  'after_head_publish',
  'after_reader_swap',
]

afterEach(async () => Promise.all(
  directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
))

describe('native publication crash recovery', () => {
  for (const point of [...prePublication, ...postPublication]) {
    it(`recovers an abrupt process death at ${point}`, async () => {
      const directory = await mkdtemp(join(tmpdir(), 'chronolog-publication-crash-'))
      directories.push(directory)
      const path = join(directory, 'application.db')
      const result = spawnSync(
        resolve('node_modules/.bin/tsx'),
        [resolve('test/fixtures/materializer-publication-crash.ts'), path, point],
        { cwd: resolve('.'), encoding: 'utf8', timeout: 20_000 },
      )
      // tsx forwards the worker's signal as the conventional shell status on
      // some platforms and as ChildProcess.signal on others.
      expect(
        result.signal === 'SIGKILL' || result.status === 128 + 9,
        `${result.stdout}\n${result.stderr}`,
      ).toBe(true)

      const native = readNativeEngineInfo()
      const manifest = createCoreExecutionManifest({
        profile: 'chronolog-native-production-v1',
        engine: native.descriptor,
        engineDigest: native.digest,
      })
      const reopened = await DeterministicMaterializer.open({
        path,
        executionManifest: manifest,
        checkpointEvery: 1,
      })
      try {
        const published = postPublication.includes(point)
        expect(reopened.revision).toBe(published ? 1n : 0n)
        expect(reopened.orderLength).toBe(published ? 1 : 0)
        expect(reopened.localSql(
          "SELECT count(*) FROM sqlite_schema WHERE type = 'table' AND name = 'crash_probe'",
        ).rows).toEqual([pinnedCount(published ? '1' : '0')])
      } finally {
        reopened.close()
      }
    })
  }
})

function pinnedCount(value: string) {
  return [{ kind: 'integer' as const, value }]
}
