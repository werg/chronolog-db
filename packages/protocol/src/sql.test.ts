import { describe, expect, it } from 'vitest'

import {
  canonicalizeSqlResult,
  decodeCanonicalSqlResult,
  decodeSqlTransactionProgram,
  decodeTransactionCore,
  decodeTransactionResultEnvelope,
  digestTransactionResultEnvelope,
  encodeCanonicalSqlResult,
  encodeSqlTransactionProgram,
  encodeTransactionCore,
  encodeTransactionResultEnvelope,
  type SqlTransactionProgram,
  type TransactionCore,
  type TransactionResultEnvelopeV1,
} from './index.js'

const program: SqlTransactionProgram = {
  version: 1,
  preconditions: [{
    id: 7,
    query: {
      sql: 'SELECT value FROM accounts WHERE id = :id',
      bindings: [{ parameter: { kind: 'name', name: ':id' }, value: { kind: 'int64', value: 2n } }],
    },
    resultMode: 'scalar',
    expectation: { kind: 'assert_true' },
    label: 'account exists',
  }],
  body: [{
    sql: 'UPDATE accounts SET value = ? WHERE id = ? RETURNING id, value',
    bindings: [
      { parameter: { kind: 'index', index: 1 }, value: { kind: 'text', utf8: new TextEncoder().encode('next') } },
      { parameter: { kind: 'index', index: 2 }, value: { kind: 'int64', value: 2n } },
    ],
  }],
}

describe('canonical deterministic SQL protocol', () => {
  it('round-trips exact SQL, binding tokens, and a transaction core without a schema digest', () => {
    expect(decodeSqlTransactionProgram(encodeSqlTransactionProgram(program))).toEqual(program)
    const core: TransactionCore = {
      groupId: bytes32(1), membershipRevision: bytes32(2), validationPolicy: bytes32(3),
      authorId: bytes32(4), authorTimestampMs: 9n, nonce: bytes32(5),
      executionManifestDigest: bytes32(6), program,
    }
    const decoded = decodeTransactionCore(encodeTransactionCore(core))
    expect(decoded).toEqual(core)
    expect(decoded).not.toHaveProperty('schemaDigest')
  })

  it('sorts multisets by canonical tagged row bytes and preserves duplicates', () => {
    const result = canonicalizeSqlResult({
      mode: 'multiset',
      columns: [{ nameUtf8: new TextEncoder().encode('v'), type: { kind: 'dynamic' }, nullable: 'unknown' }],
      rows: [
        [{ kind: 'text', utf8: new TextEncoder().encode('z') }],
        [{ kind: 'integer', value: 2n }],
        [{ kind: 'integer', value: 2n }],
        [{ kind: 'null' }],
      ],
    })
    expect(decodeCanonicalSqlResult(encodeCanonicalSqlResult(result))).toEqual(result)
    expect(result.rows.map((row) => row[0]?.kind)).toEqual(['null', 'integer', 'integer', 'text'])
  })

  it('round-trips and domain-separates accepted transaction result envelopes', async () => {
    const envelope: TransactionResultEnvelopeV1 = {
      version: 1,
      preconditions: [{ index: 0, id: 7, resultDigest: bytes32(8) }],
      statements: [{ index: 0, statementClass: 'update', affectedRows: 1n, result: null }],
    }
    const bytes = encodeTransactionResultEnvelope(envelope)
    expect(decodeTransactionResultEnvelope(bytes)).toEqual(envelope)
    expect(await digestTransactionResultEnvelope(bytes)).toHaveLength(32)
  })

  it('rejects an inline expectation whose declared result mode disagrees', () => {
    expect(() => encodeSqlTransactionProgram({
      ...program,
      preconditions: [{
        ...program.preconditions[0]!,
        resultMode: 'ordered',
        expectation: {
          kind: 'inline',
          result: { mode: 'multiset', columns: [], rows: [] },
        },
      }],
    })).toThrow()
  })
})

function bytes32(seed: number): Uint8Array {
  return Uint8Array.from({ length: 32 }, (_value, index) => (seed + index) & 0xff)
}
