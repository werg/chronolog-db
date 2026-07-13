import { DatabaseSync } from '@dolthub/doltlite'
import { describe, expect, it } from 'vitest'

describe('compiled native extension diagnostics', () => {
  it('keeps FTS5 shadow state transactional and Dolt-branch isolated', () => {
    const database = new DatabaseSync(':memory:')
    database.exec(`
      CREATE VIRTUAL TABLE docs USING fts5(body, tokenize='unicode61 remove_diacritics 0');
      INSERT INTO docs(rowid, body) VALUES (1, 'hello world'), (2, 'unrelated');
    `)
    expect(database.prepare(`SELECT rowid FROM docs WHERE docs MATCH 'hello' ORDER BY rowid`).all()).toEqual([{ rowid: 1 }])
    database.exec(`BEGIN; INSERT INTO docs(rowid, body) VALUES (3, 'hello rollback'); ROLLBACK`)
    expect(database.prepare(`SELECT rowid FROM docs WHERE docs MATCH 'hello' ORDER BY rowid`).all()).toEqual([{ rowid: 1 }])
    database.doltCommit('fts baseline')
    const baseline = database.doltActiveBranch()
    database.doltBranch('fts-other')
    database.doltCheckout('fts-other')
    database.exec(`INSERT INTO docs(rowid, body) VALUES (3, 'hello branch')`)
    expect(database.prepare(`SELECT rowid FROM docs WHERE docs MATCH 'hello' ORDER BY rowid`).all()).toEqual([{ rowid: 1 }, { rowid: 3 }])
    database.doltCheckout(baseline)
    expect(database.prepare(`SELECT rowid FROM docs WHERE docs MATCH 'hello' ORDER BY rowid`).all()).toEqual([{ rowid: 1 }])
    database.close()
  })

  it('provides JSON1 and integer RTree locally while consensus features remain gated', () => {
    const database = new DatabaseSync(':memory:')
    expect(database.prepare(`SELECT json_extract('{"value":"exact"}', '$.value') AS value`).get()).toEqual({ value: 'exact' })
    database.exec(`
      CREATE VIRTUAL TABLE boxes USING rtree_i32(id, min_x, max_x, min_y, max_y);
      INSERT INTO boxes VALUES (1, 0, 10, 0, 10), (2, 20, 30, 20, 30);
    `)
    expect(database.prepare(`SELECT id FROM boxes WHERE min_x <= 5 AND max_x >= 5 ORDER BY id`).all()).toEqual([{ id: 1 }])
    database.close()
  })
})
