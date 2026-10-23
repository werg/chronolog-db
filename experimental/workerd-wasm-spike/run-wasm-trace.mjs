/* global process, console */
import { pathToFileURL } from 'node:url'
import { runScenario } from './scenario.mjs'
const { default: init } = await import(pathToFileURL(`${process.argv[2]}/sqlite3-node.mjs`).href)
const sqlite3 = await init()
const db = new sqlite3.oo1.DB('/scenario.doltlite', 'c')
let last = ''
const wrap = (f) => (sql) => { last = sql; try { return f(sql) } catch (e) { console.error('FAILED at:', last.slice(0, 120)); throw e } }
try {
  runScenario({ exec: wrap((s) => db.exec(s)), scalar: wrap((s) => db.selectValue(s)), rows: wrap((s) => db.selectObjects(s)) })
  console.log('scenario ok')
} catch (e) { console.error(String(e.message).slice(0, 100)) }
