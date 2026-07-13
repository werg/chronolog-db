import type { ExecutionManifest, Query, SchemaManifest, TransactionProgram } from './types.js'

export function portableExecutionManifestFixture(): ExecutionManifest {
  return {
    version: 1,
    profile: 'chronolog-portable-v1',
    engine: 'sqlite',
    engineDigest: new Uint8Array(32).fill(0x11),
    functions: [], collations: [], modules: [],
    features: { decimal: true, json: true, vector: false, fts: false, spatial: false, wasm: false },
    resources: {
      maxProgramNodes: 10_000, maxExpressionDepth: 128, maxQueryRows: 100_000,
      maxResultBytes: 8 * 1024 * 1024, maxJsonDepth: 64, maxVectorDimensions: 4_096,
      maxRuleDepth: 32, maxWasmFuel: 0n,
    },
  }
}

export function portableSchemaManifestFixture(): SchemaManifest {
  return {
    version: 1,
    name: 'fixture',
    objects: [{
      kind: 'table', id: 1, name: 'items', declarationOrder: 0, withoutRowId: false,
      columns: [
        { id: 2, name: 'id', declarationOrder: 0, valueType: { logical: { kind: 'int64' }, nullable: false } },
        { id: 3, name: 'value', declarationOrder: 1, valueType: { logical: { kind: 'text', collation: 'binary' }, nullable: false } },
      ],
      constraints: [{ kind: 'primary_key', id: 4, name: 'items_pk', columnIds: [2] }],
    }],
    seedRows: [{ tableId: 1, values: new Map([[2, { kind: 'int64', value: 1n }], [3, { kind: 'text', utf8: new TextEncoder().encode('seed') }]]) }],
    functionIds: [], collationIds: [], moduleIds: [],
  }
}

export function portableTransactionProgramFixture(): TransactionProgram {
  const assertionQuery: Query = {
    id: 2, ctes: [], joins: [], groupBy: [], windows: [], compounds: [], orderBy: [],
    projection: [{ id: 3, name: 'ok', expression: { kind: 'literal', id: 4, value: { kind: 'boolean', value: true } } }],
    resultMode: { kind: 'scalar' },
  }
  return {
    preconditions: [{ kind: 'assert', id: 1, query: assertionQuery, unknownIsFailure: true }],
    mutations: [{
      kind: 'insert', id: 5, target: { kind: 'name', name: 'items' }, columns: ['id', 'value'],
      rows: [[
        { kind: 'literal', id: 6, value: { kind: 'int64', value: 2n } },
        { kind: 'literal', id: 7, value: { kind: 'text', utf8: new TextEncoder().encode('fixture') } },
      ]],
      conflict: 'error', affectedRows: { kind: 'exactly', count: 1n },
    }],
    metadata: new Map([['fixture', Uint8Array.of(1, 2, 3)]]),
  }
}

export function transactionLogQueryFixture(): Query {
  return {
    id: 20, ctes: [], from: { kind: 'system_relation', id: 21, relation: 'transaction_log', alias: 'tx' },
    joins: [], groupBy: [], windows: [], compounds: [], orderBy: [],
    projection: [{ id: 22, name: 'transaction_id', expression: { kind: 'column', id: 23, relation: 'tx', name: 'transaction_id' } }],
    resultMode: { kind: 'set' },
  }
}
