/* global process, console */
// WASM scenario run (published @dolthub/doltlite-wasm 0.11.29) in Node.
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { runScenario } from './scenario.mjs'
const root = process.argv[2]
const { default: init } = await import(pathToFileURL(`${root}/sqlite3-node.mjs`).href)
const sqlite3 = await init()
const db = new sqlite3.oo1.DB('/scenario.doltlite', 'c')
const b = {
  exec: (sql) => db.exec(sql),
  scalar: (sql) => db.selectValue(sql),
  rows: (sql) => db.selectObjects(sql),
}
const out = runScenario(b)
out.sqlite = b.scalar('select sqlite_version()')
out.dolt = b.scalar('select dolt_version()')
let exported = null
if (process.env.TRY_EXPORT) try { exported = sqlite3.capi.sqlite3_js_db_export(db) } catch (e) { out.exportError = String(e.message).slice(0, 120) }
db.close()
if (exported) {
  out.exportBytes = exported.length
  out.exportSha256 = createHash('sha256').update(exported).digest('hex')
}
console.log(JSON.stringify(out, null, 1))
