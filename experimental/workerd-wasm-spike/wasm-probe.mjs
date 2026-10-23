/* global process, console */
// Probe: load the published DoltLite WASM build in Node and report capabilities.
import { pathToFileURL } from 'node:url'
const root = process.argv[2]
const { default: init } = await import(pathToFileURL(`${root}/sqlite3-node.mjs`).href)
const sqlite3 = await init()
console.log('sqlite version', sqlite3.version.libVersion)
const db = new sqlite3.oo1.DB(':memory:')
const one = (sql) => db.selectValue(sql)
console.log('dolt_version', one('select dolt_version()'))
console.log('sqlite_source_id', one('select sqlite_source_id()'))
console.log('compile options', db.selectValues('pragma compile_options').join(','))
for (const f of ['vec_version()', "json('[1]')", "fts5(?)"]) {
  try { console.log(f, one('select ' + f.replace('(?)', '(1)'))) } catch (e) { console.log(f, 'ERR', String(e.message).slice(0, 80)) }
}
console.log('capi has set_authorizer', typeof sqlite3.capi.sqlite3_set_authorizer,
  'progress', typeof sqlite3.capi.sqlite3_progress_handler,
  'limit', typeof sqlite3.capi.sqlite3_limit,
  'interrupt', typeof sqlite3.capi.sqlite3_interrupt,
  'vfs_register', typeof sqlite3.capi.sqlite3_vfs_register)
console.log('vfs list', sqlite3.capi.sqlite3_js_vfs_list())
console.log('wasm keys has FS?', 'FS' in sqlite3.wasm, Object.keys(sqlite3.wasm).filter((k) => /fs|FS|file/.test(k)))
db.close()
