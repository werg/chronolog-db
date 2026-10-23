/* global process, console, WebAssembly */
import { readFileSync } from 'node:fs'
const file = process.argv[2]
const m = new WebAssembly.Module(readFileSync(file))
const imps = WebAssembly.Module.imports(m), exps = WebAssembly.Module.exports(m)
console.log('imports', imps.length); console.log(imps.map(i=>`${i.module}.${i.name}:${i.kind}`).join('\n'))
console.log('exports', exps.length)
const names = exps.map(e=>e.name)
for (const k of ['sqlite3_set_authorizer','sqlite3_progress_handler','sqlite3_limit','sqlite3_interrupt','sqlite3_create_function_v2','sqlite3_vec_init','sqlite3_auto_extension','sqlite3_vfs_register','sqlite3_db_config','sqlite3_vtab_config','sqlite3_wasm_db_config_i','sqlite3_extended_result_codes','sqlite3_serialize','sqlite3_deserialize'])
  console.log(k, names.includes(k) || names.includes('_'+k))
console.log(names.filter(n=>/dolt|vec|chronolog|vfs/i.test(n)).join(' '))
