import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'

import {
  canonicalizeSqlResult,
  decodeSqlRejectionAttribution,
  decodeCanonicalSqlResult,
  decodeSqlTransactionProgram,
  decodeTransactionCore,
  decodeTransactionResultEnvelope,
  digestTransactionResultEnvelope,
  digestCanonicalSqlResult,
  encodeCanonicalSqlResult,
  decodeSqlBindingValue,
  encodeSqlRejectionAttribution,
  encodeSqlBindingValue,
  encodeSqlTransactionProgram,
  encodeTransactionCore,
  encodeTransactionResultEnvelope,
  canonicalRealToNumber,
  numberToCanonicalReal,
  numberToSqlRealBinding,
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
  it('round-trips finite REAL bindings by exact binary64 bits', () => {
    const negativeZero = numberToSqlRealBinding(-0)
    expect(decodeSqlBindingValue(encodeSqlBindingValue(negativeZero))).toEqual(negativeZero)
    if (negativeZero.kind === 'real') {
      expect(Object.is(canonicalRealToNumber(negativeZero), -0)).toBe(true)
    }
    expect(() => numberToSqlRealBinding(Infinity)).toThrow(/finite/u)
  })

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

  it('matches fixed canonical result bytes and independently computed domain digests', async () => {
    const fixtures = [
      {
        result: { mode: 'ordered' as const, columns: [dynamicColumn('v')], rows: [] },
        bytes: '83018183417681000280',
        digest: '0d825ccd595ed0cb19d7d5ab13badc44619b0d4807033fd011edf67c9f297f33',
      },
      {
        result: { mode: 'scalar' as const, columns: [{ ...dynamicColumn('v'), nullable: true as const }], rows: [[{ kind: 'null' as const }]] },
        bytes: '83008183417681000181818100',
        digest: '3bd83dc09a835a9beca8a8edbbd4b444f968c379ebd89d57c6b60da6531dd92a',
      },
      {
        result: { mode: 'multiset' as const, columns: [dynamicColumn('v')], rows: [[{ kind: 'integer' as const, value: 2n }], [{ kind: 'integer' as const, value: 2n }]] },
        bytes: '830281834176810002828182010281820102',
        digest: 'a7651ee475d8718d162f63ff94b08c8865a830e0cdd04a8f20bb73fa7f2cff33',
      },
      {
        result: { mode: 'set' as const, columns: [dynamicColumn('v')], rows: [[{ kind: 'integer' as const, value: 2n }], [{ kind: 'integer' as const, value: 2n }]] },
        bytes: '8303818341768100028181820102',
        digest: '1611f4afce72a8df4f382a6e8025b9feb4a5bdb091d0792407944a6e446bd2c2',
      },
    ]
    for (const fixture of fixtures) {
      const encoded = encodeCanonicalSqlResult(fixture.result)
      expect(Buffer.from(encoded).toString('hex')).toBe(fixture.bytes)
      expect(Buffer.from(await digestCanonicalSqlResult(fixture.result)).toString('hex')).toBe(fixture.digest)
      const referenceDigest = createHash('sha256')
        .update('chronolog-canonical-sql-result-v1\0', 'utf8')
        .update(Buffer.from(fixture.bytes, 'hex'))
        .digest('hex')
      expect(referenceDigest).toBe(fixture.digest)
    }
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

  it('round-trips registered values and enforces descriptor identities', () => {
    const implementationDigest = bytes32(20)
    const result = {
      mode: 'ordered' as const,
      columns: [{
        nameUtf8: new TextEncoder().encode('custom'),
        type: { kind: 'registered' as const, typeId: 9, implementationDigest },
        nullable: false as const,
      }],
      rows: [[{
        kind: 'registered' as const,
        typeId: 9,
        implementationDigest,
        canonicalPayload: Uint8Array.of(1, 2, 3),
      }]],
    }
    expect(decodeCanonicalSqlResult(encodeCanonicalSqlResult(result))).toEqual(result)
    expect(() => encodeCanonicalSqlResult({
      ...result,
      rows: [[{ ...result.rows[0]![0]!, typeId: 10 }]],
    })).toThrow(/registered descriptor/u)
  })

  it('rejects nonfinite REAL bits and descriptor/nullability disagreement', () => {
    const infinity = new Uint8Array(8)
    new DataView(infinity.buffer).setFloat64(0, Infinity, false)
    expect(() => encodeCanonicalSqlResult({
      mode: 'scalar',
      columns: [{ nameUtf8: Uint8Array.of(118), type: { kind: 'dynamic' }, nullable: 'unknown' }],
      rows: [[{ kind: 'real', bits: infinity }]],
    })).toThrow(/finite/u)
    expect(() => encodeCanonicalSqlResult({
      mode: 'scalar',
      columns: [{ nameUtf8: Uint8Array.of(118), type: { kind: 'storage', storage: 'text' }, nullable: false }],
      rows: [[{ kind: 'null' }]],
    })).toThrow(/nonnullable/u)
  })

  it('round-trips every SQL value tag and preserves negative zero REAL bits', () => {
    const negativeZero = numberToCanonicalReal(-0)
    const digest = bytes32(90)
    const result = {
      mode: 'ordered' as const,
      columns: [dynamicColumn('v')],
      rows: [
        [{ kind: 'null' as const }],
        [{ kind: 'integer' as const, value: -1n }],
        [negativeZero],
        [{ kind: 'text' as const, utf8: new TextEncoder().encode('é') }],
        [{ kind: 'blob' as const, bytes: Uint8Array.of(0, 255) }],
        [{ kind: 'logical' as const, value: { kind: 'boolean' as const, value: true } }],
        [{ kind: 'registered' as const, typeId: 1, implementationDigest: digest, canonicalPayload: Uint8Array.of(9) }],
      ],
    }
    const decoded = decodeCanonicalSqlResult(encodeCanonicalSqlResult(result))
    expect(decoded).toEqual(result)
    const real = decoded.rows[2]?.[0]
    expect(real?.kind).toBe('real')
    if (real?.kind === 'real') expect(Object.is(canonicalRealToNumber(real), -0)).toBe(true)
  })

  it('round-trips canonical SQL-first rejection attribution', () => {
    const attribution = {
      phase: 'statement' as const,
      code: 'SQL_CONSTRAINT_VIOLATION',
      preconditionId: null,
      preconditionIndex: null,
      statementIndex: 3,
      constraintIdentity: {
        database: 'main' as const,
        objectKind: 'constraint' as const,
        objectNameUtf8: new TextEncoder().encode('accounts_value_check'),
        containingObjectNameUtf8: new TextEncoder().encode('accounts'),
      },
      triggerIdentity: null,
    }
    expect(decodeSqlRejectionAttribution(encodeSqlRejectionAttribution(attribution))).toEqual(attribution)
    expect(() => encodeSqlRejectionAttribution({ ...attribution, preconditionId: 1 })).toThrow(/invalid indices/u)
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
function dynamicColumn(name: string) {
  return { nameUtf8: new TextEncoder().encode(name), type: { kind: 'dynamic' as const }, nullable: 'unknown' as const }
}
