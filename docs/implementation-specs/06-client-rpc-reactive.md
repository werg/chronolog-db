# Client, RPC, Schema Tooling, and Reactive API Implementation

Status: historical relational-IR client plan; the active SQL client/RPC
contract is defined by Specifications 10 and 11

## 1. Responsibility

This specification defines how applications construct deterministic queries
and transactions without writing consensus SQL. It covers generated schema
bindings, the TypeScript builder, draft and query RPC contracts, observations,
rebasing, typed results, transaction handles, local SQL separation, React
resources, and CLI/example changes.

The client improves correctness and ergonomics but is not trusted. Nodes decode
and validate all canonical IR received from a client.

## 2. Public API surfaces

Chronolog exposes two deliberately separate query surfaces:

```ts
client.query(queryIr, parameters?)       // typed deterministic query IR
client.liveQuery(queryIr, parameters?)   // reactive typed query IR
client.queryLocalSql(sql, parameters?)   // read-only diagnostic/application SQL
```

Only the first two can be observed and embedded in a transaction precondition.
`queryLocalSql` returns locally typed SQLite values and carries an explicit
warning that its text is not consensus input.

Transaction drafts expose no method accepting a SQL string.

## 3. Schema source and generation

### 3.1 Source of truth

The canonical `SchemaManifest` is the source of truth. Applications may author
it through a TypeScript schema DSL, but the generated canonical bytes and
digest are reviewed artifacts.

```ts
export const schema = defineSchema(schemaBuilder => {
  schemaBuilder.table('accounts', table => {
    table.uuid('id').primaryKey()
    table.int64('balance_cents')
    table.timestampMs('updated_at_ms')
    table.json('metadata').nullable()
  })
})
```

Schema DSL callbacks run at build/development time and produce plain schema IR;
callbacks never enter canonical encoding.

### 3.2 Code generation

`chronolog schema generate` reads canonical schema bytes and emits:

- typed table and column descriptors;
- row, insert, and update TypeScript types;
- key helper types;
- view result types;
- JSON path declarations where schema metadata supplies them;
- vector dimension/element branded types; and
- the expected schema digest.

Generated output is deterministic and checked in or verified in CI. The header
contains no generation timestamp or absolute path.

### 3.3 Runtime schema check

Client construction accepts generated schema bindings. The first status or
query response includes node schema and execution-manifest digests. A mismatch
throws `CLIENT_SCHEMA_MISMATCH` before transaction building.

## 4. Builder type model

### 4.1 Expressions

```ts
interface Expr<T, Nullable extends boolean = false> {
  readonly ir: ExpressionIr
  readonly logicalType: LogicalTypeDescriptor<T>
  readonly nullable: Nullable
}
```

Column descriptors implement expressions. Operators constrain logical types:

- arithmetic accepts matching numeric types;
- Boolean connectives accept Boolean expressions;
- equality requires identical types or an explicit cast;
- JSON extraction requires a declared result type;
- vector distance requires matching dimensions and element types; and
- nullable expressions require explicit null handling where needed.

### 4.2 Queries

Query builders carry row type and result mode through generics:

```ts
Query<Row, 'ordered' | 'multiset' | 'set'>
ScalarQuery<Value>
```

Calling `.limit()` does not require a user-supplied proof term. The node
preserves any authored `ORDER BY` and derives a canonical projected-row order
when the query otherwise leaves row choice unspecified.

### 4.3 Values

Client constructors avoid unsafe JavaScript coercion:

```ts
int64(1000n)
decimal('12.340', { precision: 12, scale: 3 })
timestampMs(1_720_000_000_000n)
uuid(bytes)
jsonValue(jsValueOrCanonicalJson)
vectorInt8(Int8Array)
vectorFloat32(Float32ArrayOrExactBits)
```

JavaScript numbers are accepted only for safe bounded convenience cases and
are converted eagerly. Dates are not accepted as consensus timestamps without
an explicit UTC millisecond conversion call.

## 5. Transaction API

```ts
const handle = await client.transaction(async tx => {
  const observed = await tx.observe(
    accounts
      .where(eq(accounts.id, accountId))
      .select({ balance: accounts.balanceCents })
      .scalar(),
  )

  tx.expect(observed)

  tx.update(
    accounts,
    eq(accounts.id, accountId),
    { balanceCents: sub(accounts.balanceCents, int64(1000n)) },
    { affectedRows: exactly(1) },
  )
})
```

The transaction callback may await observations. Mutation builder methods are
locally synchronous and queue canonical IR additions. Publication waits for the
queue and fails if any operation produced a diagnostic.

### 5.1 Draft context API

```ts
tx.timestamp()                         // ContextExpr<TimestampMs>
tx.entropy(label, index, length)       // ContextEntropyExpr
tx.uuid(label, index)                  // derived convenience expression
tx.authorId()
tx.transactionId()
```

These methods create context expression nodes; they do not read local time or
randomness in the client.

### 5.2 Mandatory preconditions

The builder tracks whether a precondition was added and refuses publication
locally if none exists. It offers:

```text
assert(query)
expect(observation)
expect(query, canonicalResult)
requireRow(table, key, projectedValues)
requireAbsent(table, key)
requireTransactionAccepted(transactionId)
requireTransactionPrecedes(transactionId)
```

The node independently enforces the same requirement.

### 5.3 Observation provenance

An observed value includes an opaque observation token plus typed result. Only
the originating draft can convert it into a precondition. The token identifies
stored node-side query/result/revision/context provenance and prevents a caller
from claiming arbitrary observation metadata.

### 5.4 Rebase

```ts
await tx.rebase({
  toRevision,
  refreshObservations: true,
  renewContext: false,
})
```

Refreshing observations reruns all queries against one new pinned revision.
The client exposes changed expected results before publication. If context is
renewed, all context-dependent observations and derived literal values are
invalidated and rebuilt.

## 6. RPC encoding

Canonical IR and logical values cross the HTTP/NDJSON boundary as base64url
canonical bytes plus typed metadata needed for routing. The server always
decodes the bytes; it never trusts a client-provided JSON AST.

For in-process transport, use the same request types and copy byte arrays to
avoid mutation differences.

## 7. RPC contract

Replace raw-SQL draft methods with:

```text
transaction.beginDraft
transaction.observeIr
transaction.addAssertionIr
transaction.addExpectation
transaction.addMutationIr
transaction.validateDraft
transaction.rebaseDraft
transaction.cancelDraft
transaction.publishDraft
```

Query methods become:

```text
query.executeIr
query.liveIr
query.localSql
```

The exact method names may use existing naming conventions, but there must be
no `addStatement` or consensus `sql` field.

### 7.1 Begin response

```ts
interface BeginDraftResponse {
  readonly draftId: string
  readonly pinnedRevision: RevisionMetadata
  readonly schemaDigest: string
  readonly executionManifestDigest: string
  readonly reservedAuthorTimestampMs: string
  readonly transactionNonce: string
  readonly expiresAt: string
}
```

`expiresAt` is operational presentation metadata. Timestamp and nonce are
returned so builder context expressions and deterministic client-side derived
values can be previewed; the node remains authoritative.

### 7.2 Observation response

```ts
interface ObserveIrResponse {
  readonly observationId: string
  readonly revision: RevisionMetadata
  readonly schema: readonly LogicalResultColumn[]
  readonly resultMode: ResultModeName
  readonly canonicalResult: string
  readonly displayRows: readonly DisplayValue[][]
}
```

The canonical bytes are used for expectations. Display rows are a convenience
and must decode to the same values.

### 7.3 Mutation responses

Draft mutation responses include the draft revision counter and structured
diagnostics with node IDs, stable codes, severity, and optional builder labels.
English messages are presentation only.

## 8. Typed results

The client decoder maps logical values to:

| Logical value | Client representation |
|---|---|
| Null | `null` |
| Boolean | `boolean` |
| Int64 | `bigint` |
| Decimal | immutable decimal value/string wrapper |
| Text | `string` after strict UTF-8 validation |
| Blob | copied `Uint8Array` |
| UUID | branded 16-byte value and formatting helper |
| TimestampMs | branded `bigint` with UTC formatting helper |
| Json | immutable canonical JSON tree/application decode helper |
| Vector | branded copied typed vector |

No integer or timestamp is converted to JavaScript `number` implicitly.

## 9. Transaction handles and outcome changes

Retain the existing conceptual handle:

```ts
interface TransactionHandle {
  readonly transactionId: string
  readonly publication: PublicationReceipt
  readonly outcome: StreamResource<TransactionOutcome>
  readonly evidence: StreamResource<SettlementEvidence>
}
```

Outcome adds structured attribution:

```ts
interface RejectionAttribution {
  readonly code: string
  readonly preconditionId?: number
  readonly commandId?: number
  readonly ruleId?: number
  readonly constraintId?: number
  readonly applicationLabel?: string
}
```

A transaction may move from accepted to rejected or vice versa after late
predecessor replay. Streams therefore remain revisioned resources rather than
one-shot promises.

## 10. Live queries

`liveQuery(queryIr)` stores canonical query bytes and parameter values locally.
On every published materialized revision:

1. Check schema and manifest digest.
2. If either changed incompatibly, emit a reset/error instead of reusing the
   query.
3. Execute against the new pinned reader.
4. Decode canonical typed results.
5. Compare result digest with the previous value.
6. Emit changed values with revision metadata.

Initial implementation may rerun complete queries. Incremental view maintenance
is an optimization and cannot change emitted semantics.

Resume cursors contain group, query digest, and last delivered local revision.
If retained event history cannot cover the cursor, the server emits a reset
with a full current result.

## 11. React API

React hooks wrap stable resources:

```ts
useChronologQuery(query, parameters?, options?)
useChronologTransactionOutcome(transactionId)
useChronologSettlement(transactionId)
useChronologStatus()
```

Query identity is the canonical query digest plus canonical parameter digest,
not JavaScript object identity. Hooks unsubscribe on unmount, use
`useSyncExternalStore`-compatible snapshots, and never expose partially decoded
rows.

The hook result distinguishes loading, value, reset, deterministic query error,
transport error, and schema mismatch.

## 12. Local SQL API

`queryLocalSql` is retained for applications that need broad SQLite reads. It:

- executes only on a pinned reader;
- is authorized read-only;
- returns backend-oriented typed values;
- is never accepted by transaction builder methods;
- is not cached as an observation; and
- carries the revision at which it ran.

It accepts either `(sql, parameters)` or the structural compiled-query shape
used by SQL builders and ORMs configured with a SQLite dialect:

```ts
const compiled = externalQueryBuilder
  .selectFrom('accounts')
  .select(['id', 'balance'])
  .where('id', '=', accountId)
  .compile()

const result = await client.queryLocalSql(compiled)
```

Chronolog has no runtime dependency on that builder. Generated schema modules
export ordinary row interfaces and `ChronologSqlReadDatabase`, a table-to-row
map that can parameterize an external TypeScript SQLite query builder for this
read-only surface. Generated bindings are therefore not a mandate to adopt a bespoke
application query DSL.

Compiled SQL remains local and non-consensus. An external builder that targets
consensus uses `@chronolog/sql-frontend` (or another `ConsensusSqlFrontend`
implementation) to lower its structural `{ sql, parameters }` output locally.
The shipped SQLite frontend validates every result against the canonical
schema, selected execution manifest, and real compiler before returning it.
Canonical IR is internal signed wire bytecode rather than the recommended
application authoring DSL. Merely copying a SQL string into the protocol would
still discard signed logical types, explicit transaction context, resource
limits, and canonical result semantics, so no raw `transactSql` route exists.

The frontend is deliberately fail-closed and its exact supported syntax is
documented in `packages/sql-frontend/README.md`. The client workflow remains
`draft.observe(loweredQuery)`, `draft.expect(observation)`, then
`draft.mutate(loweredCommand)`; SQL lowering never weakens the mandatory
precondition invariant.

The CLI may expose `chronolog query-sql` but MUST NOT expose a corresponding
`transact-sql` command.

## 13. CLI and examples

The CLI supports:

- applying/inspecting a schema manifest for a fresh group;
- printing schema and execution-manifest digests;
- executing query IR supplied as canonical bytes or a checked application
  module;
- running local read-only SQL;
- inspecting transaction outcomes and rejection attribution;
- validator and replication status; and
- native feature diagnostics.

The end-to-end example defines a schema, generates/imports typed bindings,
authors transactions through the builder, partitions peers, inserts a late
predecessor, and shows reactive outcome/result changes.

## 14. Authentication and draft ownership

RPC authentication maps a local principal to allowed groups and operations.
Draft IDs are unguessable, expire operationally, and are bound to the creating
principal. Canonical IR never contains bearer tokens or local authentication
metadata.

Request IDs and idempotency keys are retained for retry safety. Retried draft
operations return the original response rather than adding duplicate IR nodes.

## 15. Tests

Required client/RPC tests:

1. Generated bindings match schema digest and compile under strict TypeScript.
2. Builder operator type tests using compile-success/failure fixtures.
3. Canonical builder output equals hand-authored IR fixtures.
4. Unsafe number, mutable bytes, invalid UTF-8, decimal, JSON, and vector inputs
   are rejected.
5. Draft RPC byte copying and canonical decoding.
6. Observation-to-expectation provenance.
7. Rebase refresh and context invalidation.
8. Publication retry/idempotency.
9. Typed result decoding without integer loss.
10. Outcome transitions after late replay.
11. Live-query reconnect, resume, reset, and schema mismatch.
12. React subscription lifecycle and stable snapshots.
13. Local SQL cannot enter a transaction draft.
14. CLI contains no arbitrary consensus-SQL mutation path.

## 16. Completion criteria

- Transaction builders accept no SQL source text.
- Generated bindings provide schema-aware expressions, values, keys, and rows.
- RPC carries canonical IR bytes and returns typed canonical results.
- Observations are pinned, attributable, and safely convertible to expectations.
- Raw SQL is visibly local/read-only and cannot be promoted implicitly.
- Reactive queries and outcomes retain revision and late-replay semantics.
- Old draft methods are deleted rather than deprecated or retained.
