import { describe, expect, it } from 'vitest'

import { compileSqlStatement } from './sql-compiler.js'

describe('SQL compiler deterministic fuzz corpus', () => {
  it('classifies arbitrary bounded source without process-level failures', () => {
    let state = 0x53514c46
    for (let index = 0; index < 3_000; index += 1) {
      state = next(state)
      const sql = source(state, state % 256)
      try {
        const compiled = compileSqlStatement({ sql, bindings: [] }, index % 2 === 0 ? 'precondition' : 'body')
        expect(compiled.source.sql).toBe(sql)
      } catch (error) {
        expect(error).toBeInstanceOf(Error)
      }
    }
  })
})

function source(seed: number, length: number): string {
  let state = seed
  let result = ''
  for (let index = 0; index < length; index += 1) {
    state = next(state)
    result += String.fromCodePoint(state % 5 === 0 ? state % 0x80 : 32 + (state % 95))
  }
  return result
}

function next(state: number): number {
  let value = state | 0
  value ^= value << 13
  value ^= value >>> 17
  value ^= value << 5
  return value >>> 0
}
