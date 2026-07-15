# Transaction Results and Ordered Mutation Implementation

Status: normative supplement to
`10-deterministic-sql-transactions.md` for the next unreleased prototype

This specification defines the protocol and execution work required to expose
results from replicated SQL body statements, including SQLite `RETURNING`, and
to admit mutation forms whose selected row set depends on ordering. It does not
create a second transaction language.

The signed protocol stores exact SQL source and canonical bindings as specified
by Specification 10. Compiler ASTs, mutation plans, keyset plans, and the
current public mutation/query IR are private transitional implementation
details. They MUST NOT be added to the signed SQL protocol, RPC contract, or
transaction ID derivation.

Every transaction continues to require at least one signed precondition.

## 1. Decisions and scope

The initial implementation SHALL:

- replace the current `chronolog-accepted-result-v1` digest with one canonical,
  versioned transaction-result envelope;
- commit successful precondition result digests, per-statement affected-row
  counts, and complete bounded body results into that envelope;
- persist the envelope atomically with the accepted protected log row;
- treat SQLite `RETURNING` as a `multiset`, because SQLite does not define its
  physical row order;
- expose accepted envelopes through revision-stamped RPC and client resources;
- attribute precondition failures by signed ID and index, and body failures by
  signed statement index; and
- implement ordered mutation subsets only where the compiler proves that
  keyset selection and mutation execution preserve pinned SQLite semantics.

The initial implementation SHALL NOT:

- expose SQLite's physical `RETURNING` row order;
- infer ordered `RETURNING` from `UPDATE` or `DELETE` target-selection order;
- add an `ORDER BY` clause to SQLite `RETURNING` through preprocessing;
- persist a partial result envelope for a rejected transaction;
- reexecute a write statement later to reconstruct returned rows;
- assign a body command ID outside its signed array position; or
- extend the transitional signed mutation IR as an alternative protocol.

An authored ordered-returning extension is future dialect work. It requires an
explicit syntax/profile and protocol-version decision. It is not part of the
initial multiset framing defined here.

## 2. Canonical SQL result values

### 2.1 SQL-first value model

The SQL-first protocol cannot assume that every result column has one fixed IR
logical type. Ordinary SQLite tables may be non-`STRICT`, expressions may be
dynamically typed, and values in one result column may have different SQLite
storage classes.

`CanonicalSqlResult` SHALL therefore contain:

```ts
interface CanonicalSqlResult {
  readonly mode: 'scalar' | 'ordered' | 'multiset' | 'set'
  readonly columns: readonly CanonicalSqlColumn[]
  readonly rows: readonly (readonly CanonicalSqlValue[])[]
}

interface CanonicalSqlColumn {
  readonly nameUtf8: Uint8Array
  readonly type:
    | { readonly kind: 'dynamic' }
    | { readonly kind: 'storage'; readonly storage: 'integer' | 'real' | 'text' | 'blob' }
    | { readonly kind: 'logical'; readonly logicalType: LogicalType }
    | { readonly kind: 'registered'; readonly typeId: number; readonly implementationDigest: Uint8Array }
  readonly nullable: boolean | 'unknown'
}
```

`CanonicalSqlValue` is individually tagged. The portable base variants are
Null, signed Int64, profile-defined binary real, UTF-8 text bytes, and blob
bytes. Registered logical/subtype values carry their immutable type identity.
Boolean, TimestampMs, DurationMs, UUID, Decimal, JSON, and Vector are logical
variants only when the compiler/profile proves or registers that interpretation;
the protocol does not reinterpret an arbitrary SQLite INTEGER or TEXT by
convention.

The compiler emits the strongest reproducible column descriptor it can prove.
Otherwise it emits `dynamic`; it MUST NOT reject deterministic SQL merely to
obtain a fixed type. Every row width must equal `columns.length`.

### 2.2 Result modes

Canonicalization follows these rules:

- `scalar` has exactly one column and zero or one row. Zero rows is explicit
  absence and differs from one Null row.
- `ordered` preserves compiler-proven SQL order after deterministic completion
  of unresolved ties.
- `multiset` sorts rows by canonical row bytes and preserves duplicates.
- `set` sorts rows by canonical row bytes and removes duplicate rows.

Column order and metadata are significant in every mode. A zero-row result is
distinct from the absence of a result-producing statement.

Body `SELECT`, `VALUES`, and read-only pragma statements are `ordered` only
when their outer SQL semantics establish an order that the compiler completes
to totality. Otherwise they are `multiset`. `DISTINCT` removes duplicates as
SQL semantics but does not make physical row order significant.

Every initial SQLite DML `RETURNING` result is `multiset`, including a mutation
whose target subset was chosen by `ORDER BY`. Target selection order is not an
authored returned-row order.

## 3. Accepted transaction result envelope

### 3.1 Logical shape

An accepted transaction produces exactly one envelope:

```ts
interface TransactionResultEnvelopeV1 {
  readonly version: 1
  readonly preconditions: readonly AcceptedPreconditionResult[]
  readonly statements: readonly AcceptedStatementResult[]
}

interface AcceptedPreconditionResult {
  readonly index: number
  readonly id: number
  readonly resultDigest: Uint8Array
}

interface AcceptedStatementResult {
  readonly index: number
  readonly statementClass:
    | 'read'
    | 'insert'
    | 'update'
    | 'delete'
    | 'schema'
    | 'pragma'
    | 'registered_effect'
  readonly affectedRows: bigint | null
  readonly result: CanonicalSqlResult | null
}
```

Precondition entries appear in signed precondition order and include every
successful mandatory precondition. Statement entries appear in signed body
order and include every successfully completed statement. Indices are
contiguous and start at zero.

`affectedRows` is present only where the pinned SQLite profile defines a direct
logical change count. For ordinary DML it follows the pinned
`sqlite3_changes64()`-compatible definition: directly changed rows, excluding
trigger and foreign-key auxiliary work and retaining the profile's explicit
UPSERT and REPLACE rules. DDL and pure reads use Null, not zero.
Encoded counts are nonnegative Int64 values; overflow is a deterministic
semantic-limit failure, never a floating or decimal fallback.

`result` is non-Null for every statement that produces a result, even when it
produces zero rows. A DML statement without `RETURNING` has no result. A DML
statement with `RETURNING` has a result whose row count is checked against the
profile's direct affected-row semantics where SQLite guarantees that
relationship.

### 3.2 Encoding

The canonical codec SHALL encode the envelope as the following fixed arrays:

```text
envelope     = [1, precondition_entries, statement_entries]
precondition = [index, id, result_digest_32]
statement    = [index, statement_class_code, affected_rows_or_null,
                canonical_sql_result_or_null]
sql_result   = [result_mode_code, columns, rows]
column       = [name_utf8, type_descriptor, nullable_code]
```

Version 1 fixes these codes:

```text
result mode:     0 scalar, 1 ordered, 2 multiset, 3 set
statement class: 0 read, 1 insert, 2 update, 3 delete,
                 4 schema, 5 pragma, 6 registered_effect
nullable:        0 false, 1 true, 2 unknown
column type:     0 dynamic, 1 storage, 2 logical, 3 registered
storage type:    0 integer, 1 real, 2 text, 3 blob
```

Logical and registered type descriptors use their existing canonical type
codecs and immutable identities. Canonical SQL results reuse one canonical
result/value codec shared by preconditions, body results, RPC, and client
decoding. Maps, host object iteration, native row objects, and JSON
serialization are not consensus encodings. New class/type variants require a
new envelope version unless the versioned decoder explicitly defines a
skippable extension position.

Decoding MUST reject unknown envelope versions, unknown non-skippable class
codes, noncanonical integers, invalid UTF-8, invalid logical values, inconsistent
row widths, invalid result modes, duplicate/noncontiguous indices, and trailing
fields. Golden byte fixtures cover empty results and every value variant.

### 3.3 Digests

The accepted transaction result digest is:

```text
SHA-256(
  UTF8("chronolog-transaction-result-envelope-v1\0") ||
  canonical_envelope_bytes
)
```

Per-precondition and per-statement result digests use the canonical SQL result
digest domain defined by the shared result codec. They are API conveniences;
the transaction digest commits to the complete envelope bytes.

The current `chronolog-accepted-result-v1` concatenation of precondition
digests and decimal affected counts SHALL be deleted in the same cutover. It
has no decoder or migration path. Fixtures, databases, feeds, and snapshots are
recreated because the protocol is unreleased.

The execution manifest commits to the envelope codec version, canonical SQL
value profile, result-mode canonicalization rules, and digest domains.

## 4. RETURNING execution

### 4.1 Supported initial shape

The compiler SHALL admit `RETURNING` for each DML family only after it can:

1. resolve every returned expression against the correct old/new/excluded
   scopes for that SQLite statement;
2. derive reproducible column names and type descriptors;
3. validate functions, subqueries, collations, and extensions under the
   consensus profile;
4. step every returned row before the statement is considered complete;
5. canonicalize the rows as a bounded multiset; and
6. retain the complete canonical result until the candidate commits.

An executor that calls only `run()` or reads only `changes()` is not a
RETURNING implementation. It must use a statement path that steps result rows
and then obtains the pinned direct affected-row count without executing the
mutation twice.

### 4.2 SQLite semantic fidelity

The compiler MUST maintain SQLite distinctions among:

- values visible to `INSERT`, `UPDATE`, `DELETE`, and UPSERT `RETURNING`;
- `excluded` values and stored values after conflict actions;
- generated/default values;
- BEFORE, AFTER, and INSTEAD OF trigger effects;
- foreign-key cascades;
- REPLACE deletion/insertion behavior; and
- zero directly affected rows versus one returned Null row.

Any DML/trigger/view combination for which the pinned engine does not expose a
stable returned-value or affected-count contract remains temporarily gated
with a conformance issue. The compiler MUST NOT silently substitute a
post-write `SELECT`, because concurrent statement semantics, triggers,
defaults, generated values, and deleted rows can differ.

### 4.3 Returned-row ordering

SQLite's physical RETURNING order is ignored. Rows are buffered only within
the deterministic result limits, encoded, sorted by canonical row bytes, and
retained with duplicates.

A future authored ordered-returning feature must be distinguishable in signed
SQL syntax or an explicit signed statement option, must define order terms and
total tie-breaking, and must advance the dialect/program profile. It cannot be
activated by changing the interpretation of an existing SQLite RETURNING
statement.

## 5. Ordered mutation subsets

### 5.1 Target-key plan

`UPDATE` or `DELETE` forms whose target set uses `ORDER BY`, `LIMIT`, or
`OFFSET` require a target-key plan. Before application writes, the compiler
and executor SHALL:

1. evaluate order, limit, and offset expressions once against the statement's
   pre-write snapshot;
2. resolve SQLite null placement and collation behavior under the profile;
3. identify each candidate row by a stable table identity: rowid/IPK for rowid
   tables or the complete primary key for `WITHOUT ROWID` tables;
4. append that identity as a hidden tie-breaker when authored terms are not
   total;
5. select the exact bounded identity vector in that total order; and
6. freeze the vector in candidate-local internal state before mutation.

Internal key materialization is compiler/runtime state. It is not signed SQL,
not an application TEMP object, and not retained in checkpoints.

### 5.2 Initial set-stable subset

The first implementation may apply the frozen identities as a set only when
the compiler proves that physical application order cannot change:

- final stored rows;
- which conflict action wins;
- trigger, foreign-key, generated-column, or registered-module effects;
- deterministic failure code/identity;
- affected-row count; or
- returned multiset.

The initial admissible subset SHOULD require ordinary abort-on-error conflict
behavior, same-row assignment evaluation, stable row identity, no
order-sensitive trigger/module behavior, and no write to a key whose conflicts
can depend on application order. The feature ledger records each relaxed proof.

If those conditions do not hold, the form remains gated until an ordered
logical mutation executor proves equivalence to the pinned SQLite statement.
Executing one SQLite statement per row is not automatically equivalent: it can
change trigger context, connection-state functions, deferred constraints,
change counts, conflict handling, and failure priority.

### 5.3 Other order-sensitive mutations

The same proof obligation applies to:

- multirow `INSERT` and `INSERT ... SELECT` with conflicts;
- multirow UPSERT where several inputs target one key;
- `UPDATE ... FROM` with more than one source row per target;
- REPLACE/IGNORE forms whose winner depends on visit order; and
- registered virtual-table writes.

The compiler completes input order from authored terms plus canonical values
or stable identities only where doing so preserves SQLite logical semantics.
Otherwise the feature remains gated; planner or table scan order is never the
tie-breaker.

## 6. Execution and attribution

### 6.1 Candidate pipeline

For an accepted candidate, the reducer SHALL:

1. evaluate mandatory preconditions sequentially and retain their result
   digests;
2. compile, prepare, bind, execute, and fully step each body statement in
   signed order;
3. finish canonicalization and limit checks for that statement before starting
   the next statement;
4. append its affected count and complete result to the in-memory envelope;
5. invalidate catalog/compiler/statement caches immediately after accepted DDL;
6. run deferred/final candidate checks;
7. encode the complete envelope and compute its digest;
8. insert envelope bytes, version, and digest in the accepted protected log
   row; and
9. commit application/schema effects and the protected result atomically.

No accepted outcome is visible before the envelope validates and persists.

On deterministic rejection, the application savepoint is rolled back and no
envelope or result digest is retained. Results from earlier statements in the
failed candidate are not public transaction results. Local diagnostics MAY
show bounded previews but are explicitly non-consensus.

### 6.2 Stable attribution

The canonical rejection attribution shape is:

```ts
interface SqlRejectionAttribution {
  readonly phase: 'precondition' | 'statement' | 'finalize'
  readonly code: string
  readonly preconditionId: number | null
  readonly preconditionIndex: number | null
  readonly statementIndex: number | null
  readonly constraintIdentity: CanonicalSchemaIdentity | null
  readonly triggerIdentity: CanonicalSchemaIdentity | null
}
```

`CanonicalSchemaIdentity` is a SQL-first identity, not a manifest object ID:

```ts
interface CanonicalSchemaIdentity {
  readonly database: 'main'
  readonly objectKind: 'table' | 'index' | 'view' | 'trigger' | 'constraint'
  readonly objectNameUtf8: Uint8Array
  readonly containingObjectNameUtf8: Uint8Array | null
}
```

Anonymous constraints have no canonical identity unless the compiler assigns a
stable catalog-derived ordinal under the active schema profile. Native error
text is not used to synthesize one.

Rules:

- A precondition parse/profile error known independently of the ordered prefix
  is an invalid candidate. A prefix-catalog resolution, prepare, step, result,
  limit, or expectation failure is attributed to that precondition's signed ID
  and index.
- A body parse/profile error known independently of the prefix is an invalid
  candidate. A prefix-catalog resolution, prepare, step, result, affected-count,
  or limit failure is attributed to its signed statement index.
- Deferred constraints and other end-of-candidate failures use `finalize` and
  no statement index unless the profile exposes a stable causal identity. The
  reducer MUST NOT guess the last statement as the cause.
- Constraint and trigger identities are included only when the compiler or
  pinned native API supplies a stable schema identity. English messages and
  source spans are never consensus fields.
- Preconditions and body statements stop at the first failure in signed array
  order. Within one statement, the compiler's stable error plan defines
  precheck, engine, result, affected-count, and limit priority.

The SQL-first cutover removes public `commandId` and rule-ID attribution from
the protocol. Body identity is its signed array index. Optional application
labels are presentation metadata and never replace canonical indices.

### 6.3 Prepare versus execution errors

Profile/compiler mismatch, missing native code, schema corruption, and other
operational faults abort replay. Only manifest-defined deterministic SQLite
codes or compiler/runtime rejection classes become canonical outcomes.

Mapping a statement-step SQLite code to a stable generic evaluation error does
not make plan-order-dependent SQL deterministic. Ordering, conflict, aggregate,
and simultaneous-error proofs remain compiler obligations.

## 7. Deterministic limits

The execution manifest SHALL define at least:

```text
max_result_columns_per_statement
max_result_rows_per_statement
max_result_bytes_per_statement
max_transaction_result_rows
max_transaction_result_bytes
max_result_value_bytes
```

Existing SQL byte, binding, expression, statement-count, VM/semantic work, and
database-size limits continue to apply.

Rows and values are charged while stepping. Per-statement canonical bytes
include column metadata, tagged values, row framing, and result framing.
Transaction bytes include the complete envelope framing and precondition and
statement summaries. Implementations MUST use the same canonical size
calculation before storage; host object size is irrelevant.

Multiset/set canonicalization may retain at most the already charged bounded
rows and bytes. Sorting work is charged by the manifest's semantic result-cost
model. A statement limit failure is attributed to that precondition or body
statement and rolls back the candidate. A transaction-envelope limit reached
while appending a statement is attributed to that statement. A failure while
encoding fixed final framing is `finalize`.

RPC display-row limits and truncation are presentation limits. They do not
change envelope bytes or digests. The RPC transport must either admit the
maximum encoded envelope plus framing or provide deterministic chunk retrieval;
it MUST NOT silently truncate canonical bytes.

## 8. Protected storage, replay, and schema

### 8.1 Protected result storage

The accepted protected log row SHALL store:

```text
result_envelope_version INTEGER NOT NULL
result_envelope         BLOB NOT NULL
result_digest           BLOB NOT NULL
```

Rejected rows store Null for all three. Startup, checkpoint verification, and
reader publication decode the envelope, recompute its digest, verify contiguous
indices against the signed transaction, and fail operationally on corruption.

Replay replaces the current row's result atomically when late predecessors
change statement effects or returned values. Immutable published revisions may
retain historical outcomes; every RPC response is stamped with the revision
from which its envelope was read.

### 8.2 DDL and migration interactions

Body statements compile sequentially against the in-transaction SQLite
catalog. Consequently:

- DDL before a result-producing statement determines its name resolution and
  result descriptors;
- `RETURNING *` expands against the table shape at that exact statement;
- generated/default columns and trigger/view definitions use the catalog
  version active for the mutation;
- a later DDL statement cannot reinterpret an earlier stored result; and
- rollback removes both schema changes and all candidate result state.

The envelope stores complete column descriptors and tagged values, so clients
do not need the current schema to decode an old result.

Migration scripts remain client conveniences that normalize to signed ordered
SQL statements. They use the same result envelope and attribution rules as any
other transaction. There is no migration-result side channel, migration
version field, schema-manifest digest, or special schema command.

## 9. RPC and client surfaces

### 9.1 Outcome and retrieval RPC

Outcome streams remain small and include a result reference only for an
accepted outcome:

```ts
interface AcceptedResultReference {
  readonly envelopeVersion: 1
  readonly digest: string
  readonly byteLength: number
}
```

Add a revision-stamped retrieval method with the semantic shape:

```ts
interface GetTransactionResultRequest {
  readonly groupId: string
  readonly transactionId: string
  readonly atMaterializedRevision?: string
}

interface GetTransactionResultResponse {
  readonly revision: RevisionMetadata
  readonly transactionId: string
  readonly reference: AcceptedResultReference
  readonly canonicalEnvelope: string
  readonly statementDisplay: readonly StatementDisplayResult[]
}
```

`canonicalEnvelope` is base64url canonical bytes. Display values may be
truncated under an explicit presentation limit and MUST decode from the same
canonical envelope. Retrieval for a rejected outcome returns a typed
`RESULT_NOT_AVAILABLE`, not an empty envelope.

If `atMaterializedRevision` is omitted, the server reads the current published
revision. If the transaction's outcome changes during replay, the outcome
stream emits the new revision and result reference. Clients key caches by
`(group, transaction, materialized revision, digest)`.

If the requested immutable revision is no longer retained, retrieval returns a
typed `REVISION_NOT_RETAINED`; it MUST NOT silently substitute the current
outcome.

### 9.2 Client transaction results

`tx.exec` SHALL return a draft-local statement handle. Publication freezes the
body and maps each live handle to its final signed statement index. Removing,
replacing, or inserting statements before publication either updates handles
atomically or invalidates affected handles with a draft error; a stale handle
must never resolve to a different signed statement. Typed SQL adapters may
attach a decoder inferred from the SQL and catalog observation; raw SQL handles
expose canonical SQL columns and tagged values.

After publication, `TransactionHandle` exposes a revisioned accepted-result
resource. It resolves statement handles from the envelope only while the
transaction is accepted at that revision. Rebase or late-predecessor replay may
change or remove a result, so it is not a one-shot promise.

The client MUST distinguish:

- no result-producing clause;
- an accepted empty result;
- an accepted row containing Null; and
- a rejected transaction with no envelope.

Draft validation may return inferred column descriptors but MUST NOT execute a
write to preview RETURNING values. Returned values come only from materialized
accepted execution.

## 10. Versioning and cutover

This work is part of Specification 10's clean prototype cutover:

1. Define the canonical SQL value/result and envelope codecs with golden
   fixtures.
2. Replace the result digest implementation and protected log schema in one
   change set.
3. Recreate prototype databases, feeds, snapshots, fixtures, and generated
   bytes.
4. Add the result reference/retrieval RPC directly; do not retain an
   accepted-result-v1 or IR-result alias.
5. Remove current command-ID outcome fields when the SQL transaction protocol
   replaces public mutation IR.

The SQL program may remain semantic `version: 1` because the entire SQL-first
protocol is unreleased and cut over atomically. The result envelope has its own
explicit version. Future changes that reinterpret existing result modes,
RETURNING ordering, value tags, or statement classes require a new envelope
and, where signed semantics change, dialect/program version and execution
manifest identity.

There is no compatibility decoder, database migration, feed translation, or
dual execution profile.

## 11. Conformance and acceptance gates

### 11.1 Codec and digest fixtures

Tests SHALL cover:

- golden bytes and digests for no-row, one-Null-row, duplicate multiset, set,
  scalar absence, and ordered results;
- every SQL value and column-descriptor variant;
- rejected unknown/noncanonical versions, tags, widths, indices, and UTF-8;
- statement-with-no-result versus statement-with-empty-result; and
- independent decode/reencode and digest recomputation.

### 11.2 RETURNING matrix

For INSERT, UPDATE, DELETE, UPSERT, IGNORE, and REPLACE, cover:

- zero, one, and many directly affected rows;
- defaults, generated values, Null, blobs, dynamic values, and `RETURNING *`;
- conflict paths and excluded/stored values;
- supported trigger/view/foreign-key combinations and explicit negative gates;
- affected-count/returned-row invariants; and
- row visitation changes caused by indexes or planner choices yielding the same
  multiset bytes and digest.

### 11.3 Ordered mutation matrix

Cover total and nontotal authored orders, hidden row-identity tie-breakers,
Null placement, collations, rowid and `WITHOUT ROWID` identity, LIMIT zero,
OFFSET, parameterized bounds, index present/absent, key updates, uniqueness
conflicts, triggers, cascades, and registered modules. Positive fixtures exist
only where the set-stability proof succeeds; every gate names the failed proof.

Verify explicitly that target-selection order never becomes RETURNING order.

### 11.4 Attribution and rollback

Inject deterministic failures during precondition resolution, prepare, step,
expectation comparison, body resolution, prepare, step, result encoding,
affected-count checking, per-statement limits, transaction limits, named
constraints/triggers, and deferred finalization.

Assert exact phase and indices, absence of English messages, complete rollback
of data/schema/result bytes, and no partial envelope. Operational profile,
corruption, I/O, and memory failures must abort replay without a canonical
rejection.

### 11.5 Replay, storage, and RPC

Required scenarios include:

- clean replay, suffix replay, checkpoint replay, cache hit/miss, and reopen
  deriving identical envelope bytes and digest;
- late predecessors changing accepted returned values or flipping acceptance;
- DDL before and after RETURNING in one atomic body;
- crash injection before/after envelope encoding, protected-log insert,
  application commit, checkpoint, and publication;
- RPC round-trip of maximum-size envelopes without canonical truncation;
- display truncation leaving canonical bytes/digest unchanged; and
- client result resources updating or disappearing with revisioned outcomes.

### 11.6 Implementation sequence

Implementation proceeds in this order:

1. canonical SQL values/results, envelope codec, digest, and golden fixtures;
2. protected log schema and accepted-envelope persistence without RETURNING;
3. executor stepping for body reads and safe DML RETURNING as multiset;
4. deterministic limits and rejection attribution;
5. outcome references, retrieval RPC, and raw client decoding;
6. typed statement handles/adapters;
7. initial ordered target-key subset; and
8. proof-driven expansion of conflicts, triggers, modules, and other mutation
   forms.

Each phase must pass clean/suffix/checkpoint replay and crash-atomicity gates
before the next phase. Authored ordered RETURNING is not an implicit final
phase; it requires a separate dialect proposal.

### 11.7 Repository work packages

The implementation series has explicit ownership boundaries:

- `packages/protocol` and the canonical codec layer define SQL program/result
  types, value/result/envelope codecs, domains, golden bytes, and transaction
  identity fixtures. They do not import compiler AST types.
- `packages/sql-frontend` and `packages/compiler-sqlite` produce private
  statement result plans, inferred/dynamic column descriptors, target-key
  proofs, stable error plans, and source diagnostics. The current
  `IR_RETURNING_UNSUPPORTED` path is removed only when its executor contract is
  available.
- `packages/materializer-doltlite` steps result-producing statements, enforces
  limits, builds the envelope, persists it with the protected log, verifies it
  on reopen, and removes the old digest implementation.
- `packages/node-core` carries revisioned accepted-result references through
  replay/outcome changes without treating result bytes as validator input.
- `packages/rpc` adds canonical result retrieval and presentation decoding;
  its schemas remove IR command IDs and never expose compiler plans.
- `packages/client` adds raw SQL result decoding, typed adapter hooks, stable
  draft statement handles, and revisioned accepted-result resources.
- native/Workerd adapters must implement the same stepping, value tagging,
  error, and limit contract or refuse the execution profile.

A change that adds RETURNING only to the renderer, only to the client, or only
to an RPC response is incomplete and must not enable the feature ledger entry.

## 12. Related-specification cutover audit

Specification 10 is authoritative during the SQL-first cutover. The following
older contracts must be edited or deleted in the same implementation series;
they are not alternate designs:

- Specification 02 currently exposes `Mutation.returning?: Query` and a fixed
  IR result schema. That field may remain private compiler plan state but is
  removed from the signed protocol. SQL result envelopes use the dynamic/value-
  tagged model in Section 2.
- Specification 03 currently requires `IR_RETURNING_UNSUPPORTED` because the
  executor returns only an affected count. That gate is removed only after
  Sections 2-8 of this specification are implemented; rendering alone is not
  sufficient.
- Specification 04 describes accumulating returning rows but its implementation
  and accepted digest retain only precondition digests and affected counts. Its
  reducer algorithm, protected schema, replay verification, and crash matrix
  must adopt the envelope atomically.
- Specification 05's draft/program records carry public mutation IR and a
  schema digest. Specification 10 replaces them with signed SQL/bindings,
  statement indices, and prefix-catalog resolution; no result work should
  deepen the obsolete protocol.
- Specification 06's IR-only RPC and client result types become the SQL
  observation, outcome-reference, result-retrieval, and statement-handle
  surfaces in Section 9.
- `sql-dialect.md` currently describes mutation returning as a query with four
  selectable modes. For the initial SQLite-compatible SQL protocol,
  preconditions retain explicit modes, ordinary body queries derive their mode,
  and DML RETURNING is always multiset. An ordered-returning mode is a future
  authored dialect extension, not an interpretation of current SQLite syntax.

The repository cutover is incomplete while any public RPC, protocol codec,
transaction ID derivation, protected-log verifier, or client publication path
still accepts both SQL statements and canonical mutation IR.
