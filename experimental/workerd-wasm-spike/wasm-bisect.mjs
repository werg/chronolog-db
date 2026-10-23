/* global process, console */
import { pathToFileURL } from 'node:url'
const root = process.argv[2]
const { default: init } = await import(pathToFileURL(`${root}/sqlite3-node.mjs`).href)
const sqlite3 = await init()
const variants = [
  [`SELECT dolt_commit('-A', '-m', 'plain')`],
  [`SELECT dolt_commit('-A', '-m', 'author', '--author', 'Chronolog reducer <reducer@chronolog.invalid>')`],
  [`SELECT dolt_commit('-A', '-m', 'date', '--date', '1970-01-01T00:00:00')`],
  [`SELECT dolt_commit('-A', '-m', 'date2024', '--date', '2024-01-01T00:00:00')`],
]
for (const [sql] of variants) {
  const db = new sqlite3.oo1.DB(`/t${Math.random()}.db`, 'c')
  try {
    db.exec('CREATE TABLE t(x); INSERT INTO t VALUES (1)')
    console.log('OK ', sql.slice(0, 80), '=>', db.selectValue(sql))
  } catch (e) {
    console.log('ERR', sql.slice(0, 80), '=>', String(e.message).slice(0, 100))
  }
  try { db.close() } catch { /* best-effort close after a probe failure */ }
}
