import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { chronologNativeManifest, DatabaseSync } from '@dolthub/doltlite'
import { afterEach, describe, expect, it } from 'vitest'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('statically linked sqlite-vec DoltLite seam', () => {
  it('registers the pinned extension without enabling dynamic loading', () => {
    expect(chronologNativeManifest()).toMatchObject({
      doltliteVersion: '0.11.29',
      sqliteVecVersion: '0.1.9',
      sqliteVecSourceSha256: '3acd67cb4aff080c7050926fd3cf8227905fe5b7ee3829d8ee5024ab1283cf61',
      dynamicExtensions: false,
    })
    const database = new DatabaseSync(':memory:')
    expect(database.prepare('SELECT vec_version() AS version').get()).toEqual({ version: 'v0.1.9' })
    expect(database.prepare('PRAGMA module_list').all()).toContainEqual({ name: 'vec0' })
    expect(database.configureSecurity().loadExtension).toBe(true)
    database.close()
  })

  it('keeps vec0 writes transactional and isolated by Dolt branch', () => {
    const database = new DatabaseSync(':memory:')
    database.exec(`
      CREATE VIRTUAL TABLE vectors USING vec0(embedding int8[2]);
      INSERT INTO vectors(rowid, embedding)
      VALUES (1, vec_int8('[1,2]')), (2, vec_int8('[3,4]'));
    `)
    expect(database.prepare(`
      SELECT rowid, distance
      FROM vectors
      WHERE embedding MATCH vec_int8('[1,3]') AND k = 2
      ORDER BY distance
    `).all()).toEqual([
      { rowid: 1, distance: 1 },
      { rowid: 2, distance: 2.2360680103302 },
    ])

    database.exec(`BEGIN; INSERT INTO vectors(rowid, embedding) VALUES (3, vec_int8('[1,3]')); ROLLBACK`)
    expect(database.prepare('SELECT count(*) AS count FROM vectors').get()).toEqual({ count: 2 })
    database.exec(`BEGIN; UPDATE vectors SET embedding = vec_int8('[9,9]') WHERE rowid = 1; ROLLBACK`)
    expect(database.prepare(`SELECT vec_to_json(embedding) AS value FROM vectors WHERE rowid = 1`).get()).toEqual({ value: '[1,2]' })
    expect(() => database.exec(`INSERT INTO vectors(rowid, embedding) VALUES (1, vec_int8('[0,0]'))`)).toThrow()
    expect(database.prepare('SELECT count(*) AS count FROM vectors').get()).toEqual({ count: 2 })

    database.exec('DELETE FROM vectors WHERE rowid = 2')
    expect(database.prepare('SELECT count(*) AS count FROM vectors').get()).toEqual({ count: 1 })
    database.exec(`INSERT INTO vectors(rowid, embedding) VALUES (2, vec_int8('[3,4]'))`)

    database.doltCommit('vector baseline')
    const baseline = database.doltActiveBranch()
    database.doltBranch('vector-other')
    database.doltCheckout('vector-other')
    database.exec(`INSERT INTO vectors(rowid, embedding) VALUES (3, vec_int8('[1,3]'))`)
    expect(database.prepare('SELECT count(*) AS count FROM vectors').get()).toEqual({ count: 3 })
    database.doltCheckout(baseline)
    expect(database.prepare('SELECT count(*) AS count FROM vectors').get()).toEqual({ count: 2 })
    database.close()
  })

  it('persists vec0 shadow state through commit and reopen', () => {
    const directory = mkdtempSync(join(tmpdir(), 'chronolog-vec-'))
    temporaryDirectories.push(directory)
    const path = join(directory, 'database')
    const database = new DatabaseSync(path)
    database.exec(`
      CREATE VIRTUAL TABLE vectors USING vec0(embedding int8[2]);
      INSERT INTO vectors(rowid, embedding) VALUES (7, vec_int8('[-2,5]'));
    `)
    database.doltCommit('persist vector')
    database.close()

    const reopened = new DatabaseSync(path)
    expect(reopened.prepare(`
      SELECT rowid
      FROM vectors
      WHERE embedding MATCH vec_int8('[-2,4]') AND k = 1
      ORDER BY distance
    `).all()).toEqual([{ rowid: 7 }])
    reopened.close()
  })
})
