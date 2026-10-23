/* global process, console, __dirname */
// Native (Chronolog-patched @dolthub/doltlite 0.11.29) scenario run.
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const addon = require(path.join(process.argv[2], 'build/Release/doltlite.node'))
;(async () => {
  const { runScenario } = await import(path.join(__dirname, 'scenario.mjs'))
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-native-'))
  const file = path.join(dir, 'db.doltlite')
  const db = new addon.DatabaseSync(file)
  const b = {
    exec: (sql) => db.exec(sql),
    scalar: (sql) => { const r = db.prepare(sql).get(); return r === undefined ? null : Object.values(r)[0] },
    rows: (sql) => db.prepare(sql).all(),
  }
  const out = runScenario(b)
  out.engine = addon.chronologNativeManifest()
  out.sqlite = b.scalar('select sqlite_version()')
  out.dolt = b.scalar('select dolt_version()')
  db.close()
  out.fileBytes = fs.statSync(file).size
  out.fileSha256 = require('node:crypto').createHash('sha256').update(fs.readFileSync(file)).digest('hex')
  console.log(JSON.stringify(out, null, 1))
  fs.rmSync(dir, { recursive: true, force: true })
})()
