# Transaction Results and Ordered Mutation Implementation

Status: normative supplement to
`10-deterministic-sql-transactions.md` for the unreleased SQL-first prototype

Implementation status: the result-envelope, multiset `RETURNING`, protected-
storage, retrieval-RPC, and raw-client foundations exist. The normative
tightening and conformance work in this document—especially aggregate result
limits, attribution identities, envelope/program verification, and the ordered
target-key subset—remains required before the corresponding compatibility-
ledger entries may be enabled.

This specification defines the protocol and execution work required to expose
results from replicated SQL body statements, including SQLite `RETURNING`, and
to admit mutation forms whose selected row set depends on ordering. It does not
create a second transaction language.

The signed protocol stores exact SQL source and canonical bindings as specified
by Specification 10. Compiler ASTs, mutation plans, and keyset plans are
private implementation details. They MUST NOT be added to the signed SQL
protocol, RPC contract, or transaction ID derivation. The removed public
mutation/query IR is not a transitional alternative.

Every transaction continues to require at least one signed precondition.

## 1. Decisions and scope

The initial implementation SHALL:

- use one canonical, versioned transaction-result envelope and keep the removed
  `chronolog-accepted-result-v1` digest path absent;
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
- reintroduce the removed signed mutation IR as an alternative protocol.

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

`CanonicalSqlValue` is individually tagged:

```ts
type CanonicalSqlValue =
  | { readonly kind: 'null' }
  | { readonly kind: 'integer'; readonly value: bigint }
  | { readonly kind: 'real'; readonly bits: Uint8Array }
  | { readonly kind: 'text'; readonly utf8: Uint8Array }
  | { readonly kind: 'blob'; readonly bytes: Uint8Array }
  | { readonly kind: 'logical'; readonly value: LogicalValue }
  | {
      readonly kind: 'registered'
      readonly typeId: number
      readonly implementationDigest: Uint8Array
      readonly canonicalPayload: Uint8Array
    }
```

Version 1 encodes SQL values as fixed arrays:

```text
null       = [0]
integer    = [1, signed_int64]
real       = [2, ieee754_binary64_be_8]
text       = [3, valid_utf8_bytes]
blob       = [4, bytes]
logical    = [5, canonical_logical_value]
registered = [6, type_id, implementation_digest_32, canonical_payload]
```

The initial binary REAL profile accepts only finite IEEE 754 binary64 values,
encodes their exact bits in network byte order, and preserves negative zero.
NaN and infinities fail with a manifest-defined deterministic error until a
future profile defines their SQLite and canonical-byte behavior. Registered
payload bytes are meaningful only under the matching type ID and immutable
implementation digest and remain subject to value-byte limits.

Boolean, TimestampMs, DurationMs, UUID, Decimal, JSON, and Vector are logical
variants only when the compiler/profile proves or registers that
interpretation. The protocol does not reinterpret an arbitrary SQLite INTEGER
or TEXT by convention.

Column inference is part of the versioned compiler profile, not an
implementation choice. Its precedence is `registered`, `logical`, `storage`,
then `dynamic`, but a descriptor may be selected only by an explicit inference
rule committed by the execution manifest. Nullability follows the same
profile: `false` requires a proof that Null cannot be produced, `true` requires
a rule proving the expression is nullable, and every unresolved case is
`unknown`. The minimum interoperable profile may emit `dynamic` and `unknown`
for every column. A compiler MUST NOT reject deterministic SQL merely to obtain
stronger metadata. Every row width must equal `columns.length`.

Descriptors are decoder-checked claims. A `storage` column may contain only
Null or the named storage tag; a `logical` column may contain only Null or a
matching logical value; and a `registered` column may contain only Null or a
registered value with the same type ID and implementation digest. A column
marked nonnullable may not contain Null. `dynamic` permits every admitted value
tag. Descriptor/value disagreement is corruption or noncanonical input, not a
request to weaken the descriptor during decoding.

### 2.2 Result modes

Canonicalization follows these rules:

- `scalar` has exactly one column and zero or one row. Zero rows is explicit
  absence and differs from one Null row.
- `ordered` preserves compiler-proven SQL order after deterministic completion
  of unresolved ties.
- `multiset` sorts rows by unsigned lexicographic comparison of canonical CBOR
  row bytes and preserves duplicates.
- `set` uses the same ordering and removes only rows with byte-identical
  canonical encodings.

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
`sqlite3_changes64()`-compatible definition. It counts rows changed directly
in real tables by the top-level INSERT, UPDATE, or DELETE; excludes trigger and
foreign-key auxiliary work; excludes rows deleted as auxiliary REPLACE
conflict resolution while counting the replacement insertion; reports zero
for a view mutation handled by an INSTEAD OF trigger; counts the insert or
update arm of UPSERT and reports zero for DO NOTHING; and follows the pinned
engine's `sqlite3_changes64()` rule for an UPDATE that assigns values equal to
their existing values. That last case is covered by a fixed differential
fixture rather than inferred from before/after value comparison. DDL and pure
reads use Null, not zero. Encoded counts are nonnegative Int64 values; overflow
is a deterministic semantic-limit failure, never a floating or decimal
fallback.

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
codes, noncanonical integers, invalid UTF-8, nonfinite or malformed REAL bits,
invalid logical or registered values, descriptor/value or nullability
disagreement, inconsistent row widths, invalid result modes, unsorted
multisets/sets, duplicate set rows, duplicate/noncontiguous indices, and
trailing fields. Golden byte fixtures cover empty results and every value
variant.

### 3.3 Digests

The accepted transaction result digest is:

```text
SHA-256(
  UTF8("chronolog-transaction-result-envelope-v1\0") ||
  canonical_envelope_bytes
)
```

The canonical SQL result digest used by preconditions and derived statement
helpers is:

```text
SHA-256(
  UTF8("chronolog-canonical-sql-result-v1\0") ||
  canonical_sql_result_bytes
)
```

Per-precondition result digests are encoded in the envelope. A per-statement
result digest MAY be derived as an API convenience when that statement has a
non-Null result, but it is not an additional envelope field. The accepted
transaction **result digest** commits to the complete envelope bytes. The
signed transaction digest and transaction ID do not: they are fixed before
execution, while replay may change or remove the derived result envelope.

The removed `chronolog-accepted-result-v1` concatenation of precondition
digests and decimal affected counts MUST remain absent. It has no decoder or
migration path. Fixtures, databases, feeds, and snapshots are recreated because
the protocol is unreleased.

The execution manifest commits to the envelope codec version, canonical SQL
value profile, result-mode canonicalization rules, and digest domains.

## 4. RETURNING execution

### 4.1 Supported initial shape

The compiler SHALL admit `RETURNING` for each DML family only after it can:

1. resolve every returned expression under the pinned SQLite target-table
   scope rules for that statement;
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

The compiler MUST maintain SQLite's exact RETURNING contract:

- RETURNING expressions may reference only the table being modified; auxiliary
  `UPDATE ... FROM` tables are not visible there;
- INSERT and UPDATE target-column references observe values produced by the
  top-level statement, while DELETE references observe pre-delete values;
- UPSERT returns rows handled by both its insert and update arms, but the
  compiler MUST NOT invent `old`, `new`, or `excluded` RETURNING namespaces
  that the pinned SQLite grammar/runtime does not expose;
- generated and default values follow the values visible to the top-level
  statement;
- values changed later by AFTER triggers are not substituted into RETURNING;
- RETURNING reports only rows directly handled by the top-level mutation, not
  trigger or foreign-key auxiliary rows;
- RETURNING is not accepted inside triggers, and UPDATE/DELETE RETURNING on
  virtual tables remains gated while unsupported by the pinned engine;
- top-level aggregates and windows in RETURNING remain rejected according to
  SQLite grammar/semantics; and
- a RETURNING subquery that reads the table being modified remains gated
  because SQLite leaves its evaluation relationship to the mutation
  indeterminate.

The pinned behavior is audited against SQLite's RETURNING contract at
<https://www.sqlite.org/lang_returning.html> and the direct-change contract at
<https://www.sqlite.org/c3ref/changes.html>.

Any DML/trigger/view/conflict combination for which the pinned engine does not
expose a stable returned-value or affected-count contract remains temporarily
gated with a conformance issue. In particular, an affected-count/RETURNING-row
equality check is enabled only for statement forms where SQLite guarantees that
relationship. The compiler MUST NOT silently substitute a post-write `SELECT`,
because statement semantics, triggers, defaults, generated values, and deleted
rows can differ.

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

1. execute one selection phase against the statement's pre-write snapshot,
   evaluating each ORDER BY expression for each candidate row under SQLite
   expression semantics and evaluating the scalar LIMIT/OFFSET expressions once;
2. resolve SQLite null placement and collation behavior under the profile;
3. identify each candidate row by a stable table identity: rowid/IPK for rowid
   tables or the complete primary key for `WITHOUT ROWID` tables;
4. append that identity as a hidden tie-breaker when authored terms are not
   total;
5. select the exact bounded identity vector in that total order; and
6. freeze the vector in candidate-local internal state before mutation.

Hidden identity completion is fixed by the profile. Rowid/IPK values compare as
signed Int64. A `WITHOUT ROWID` identity appends primary-key components in
declaration order with their pinned affinity, direction, and collation rules;
primary-key uniqueness makes the completed identity order total. If the
compiler cannot prove that those rules distinguish every candidate identity,
the statement remains gated. The selected vector contains each identity at
most once and preserves SQLite's exact negative-LIMIT, LIMIT-zero, comma-form,
and OFFSET behavior.

Internal key materialization is compiler/runtime state. It is not signed SQL,
not an application TEMP object, and not retained in checkpoints.

The compiler MUST parse the authored UPDATE/DELETE-LIMIT grammar itself and
MUST NOT prepare the original statement when the pinned SQLite build lacks
`SQLITE_ENABLE_UPDATE_DELETE_LIMIT`. It lowers the accepted form into two
private operations:

1. a read-only target-selection statement that returns the bounded identity
   vector in completed order; and
2. one mutation statement whose compiler-owned CTE or equivalent identity
   relation contains that frozen vector and whose predicate consumes exactly
   those identities.

The mutation operation preserves the original assignments, conflict mode,
RETURNING expressions, and statement boundary. It does not reevaluate the
authored ORDER BY, LIMIT, or OFFSET. Rowid identities use exact signed Int64
values; `WITHOUT ROWID` identities use every primary-key component with the
pinned storage-class and collation semantics. Executing one application-visible
statement per selected row is prohibited. If the compiler cannot render and
authorize the private identity relation without changing SQLite semantics, the
authored form remains gated.

The selection and mutation operations are one logical body statement: no other
body work may interleave, both use the same signed statement index, and failure
in either operation rolls back the candidate with that index. Private SQL text,
bindings, and identity vectors are reproducible compiler output committed by
the execution-manifest identity but are not additional signed source.

### 5.2 Initial set-stable subset

The first implementation may apply the frozen identities as a set only when
the compiler proves that physical application order cannot change:

- final stored rows;
- which conflict action wins;
- trigger, foreign-key, generated-column, or registered-module effects;
- deterministic failure code/identity;
- affected-row count; or
- returned multiset.

The initial admissible subset MUST be mechanically provable and MUST require:

- a real `main` table with stable rowid/IPK or complete `WITHOUT ROWID`
  primary-key identity, not a view or virtual table;
- ordinary abort-on-error conflict behavior, with IGNORE, REPLACE, and other
  order-dependent conflict modes gated;
- row-local deterministic assignment evaluation with no subquery or function
  that can observe partially applied target mutations;
- no mutation of row identity, UNIQUE/FK key material, or generated-column
  dependencies whose conflicts or cascades can depend on application order;
- no target trigger, foreign-key action, registered effect, or virtual module
  whose effects can observe physical mutation order; and
- a stable error plan that either prechecks every row-dependent failure or
  proves that mutation visitation order cannot change the canonical failure
  code or identity.

These are hard safety conditions, not recommendations. The feature ledger
records each future relaxation and the exact proof and conformance fixtures
that justify it.

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

Version 1 encodes schema identities and attribution as fixed arrays:

```text
schema_identity = [0, object_kind_code, object_name_utf8,
                   containing_object_name_utf8_or_null]
attribution     = [phase_code, stable_code_text,
                   precondition_id_or_null, precondition_index_or_null,
                   statement_index_or_null,
                   constraint_identity_or_null, trigger_identity_or_null]

phase:       0 precondition, 1 statement, 2 finalize
object kind: 0 table, 1 index, 2 view, 3 trigger, 4 constraint
database:    0 main
```

Names are nonempty valid UTF-8 bytes. The stable error code is canonical CBOR
text matching `[A-Z][A-Z0-9_]*` and comes from the manifest-committed error
registry; arbitrary native error strings are invalid. The protected log stores
the canonical constraint and trigger identity bytes in nullable BLOB columns,
and RPC/client decoders expose the logical structure above. A rejected row
without a stable identity stores Null rather than a numeric manifest-era object
ID. Accepted rows store Null attribution fields.

Attribution decoding also enforces phase shape: `precondition` carries both a
precondition ID and index and no statement index; `statement` carries only a
statement index; and `finalize` carries none of those three indices. A
constraint identity has object kind `constraint`, and a trigger identity has
object kind `trigger`. Any other combination is noncanonical.

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
max_result_sort_work
max_ordered_mutation_targets
max_ordered_mutation_identity_bytes
max_ordered_mutation_bindings
```

Existing SQL byte, binding, expression, statement-count, VM/semantic work, and
database-size limits continue to apply.

Rows and values are charged while stepping. Per-statement canonical bytes
include column metadata, tagged values, row framing, and result framing.
Transaction result bytes include the complete envelope framing and
precondition and statement summaries. `max_transaction_result_rows` charges
every row stepped for successful preconditions and body results, even though
the envelope retains only precondition digests; `max_transaction_result_bytes`
charges the exact final envelope bytes. Implementations MUST use the same
canonical size calculation before storage; host object size is irrelevant.

Multiset/set canonicalization may retain at most the already charged bounded
rows and bytes. Version 1 charges result sorting independently of the host sort
algorithm as:

```text
result_sort_work = total_canonical_row_bytes
                 + row_count * ceil_log2(max(1, row_count))
```

Every multiset/set statement charges that value before sorting. Ordered target
selection separately charges its selected identity count and the canonical
bytes of the complete frozen identity vector. The total number of identity
components inserted into the private mutation plan is charged as internal
bindings and may not exceed either `max_ordered_mutation_bindings` or the pinned
SQLite variable limit. Exceeding any target limit fails before mutation begins.
Native VM-step backstops remain operational protection and do not replace these
semantic charges.

A statement limit failure is attributed to that precondition or body statement
and rolls back the candidate. A transaction-envelope limit reached while
appending a statement is attributed to that statement. A failure while encoding
fixed final framing is `finalize`. Implementations MUST calculate exact encoded
value, row, statement, and envelope sizes using the canonical codec rather than
an approximation or host allocation size.

RPC display-row limits and truncation are presentation limits. They do not
change envelope bytes or digests. The RPC transport must either admit the
maximum encoded envelope plus framing or provide deterministic chunk retrieval;
it MUST NOT silently truncate canonical bytes.

## 8. Protected storage, replay, and schema

### 8.1 Protected result storage

The protected log SHALL use nullable result columns because the same relation
also stores rejected outcomes:

```text
result_envelope_version INTEGER
result_envelope         BLOB
result_digest           BLOB
failing_constraint_identity BLOB
failing_trigger_identity    BLOB

CHECK (
  (outcome = 'accepted'
    AND result_envelope_version = 1
    AND result_envelope IS NOT NULL
    AND result_digest IS NOT NULL
    AND length(result_digest) = 32)
  OR
  (outcome <> 'accepted'
    AND result_envelope_version IS NULL
    AND result_envelope IS NULL
    AND result_digest IS NULL)
)

CHECK (
  outcome <> 'accepted'
  OR (failing_constraint_identity IS NULL
      AND failing_trigger_identity IS NULL)
)
```

The identity columns use Section 6.2's canonical encoding. Both are Null for
accepted rows and whenever the pinned error plan cannot supply a stable
identity. Existing phase/code/index columns remain scalar for efficient outcome
queries and MUST agree with the canonical attribution returned through RPC and
with Section 6.2's phase-shape rules. The removed numeric manifest-era
constraint/rule ID columns MUST NOT be retained as an alternative identity
path.

Rejected rows therefore store Null for all three result columns. Startup,
checkpoint verification, and reader publication decode the row's stored
canonical signed candidate and envelope together, recompute the result digest,
and verify:

- precondition count, contiguous indices, signed IDs, and signed order;
- body statement count, contiguous indices, and compiler-derived statement
  classes;
- which statement classes may carry affected counts or results; and
- the envelope's canonical reencoding and outcome-dependent Null invariant.

Any mismatch is operational corruption, not a replay-derived rejection.

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
}
```

`canonicalEnvelope` is base64url canonical bytes and is the only authoritative
result payload. A server MAY add a separately versioned optional display
projection, but every display value MUST decode from these exact bytes, carry
an explicit truncation marker, and remain outside digest calculation. The
minimum interoperable response has no display field; clients decode the
canonical envelope directly. Retrieval for a rejected outcome returns a typed
`RESULT_NOT_AVAILABLE`, not an empty envelope.

If `atMaterializedRevision` is omitted, the server reads the current published
revision. If the transaction's outcome changes during replay, the outcome
stream emits the new revision and result reference. Clients key caches by
`(group, transaction, materialized revision, digest)`.

If the requested immutable revision is no longer retained, retrieval returns a
typed `REVISION_NOT_RETAINED`; it MUST NOT silently substitute the current
outcome. A server MAY retain only its current published revision. A client that
loses the race between an outcome event and result retrieval handles
`REVISION_NOT_RETAINED` by observing the newer outcome; it never associates
bytes from one revision with a reference from another.

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

This work completes Specification 10's clean prototype cutover:

1. Define the canonical SQL value/result and envelope codecs with golden
   fixtures.
2. Replace the result digest implementation and protected log schema in one
   change set.
3. Recreate prototype databases, feeds, snapshots, fixtures, and generated
   bytes.
4. Add the result reference/retrieval RPC directly; do not retain an
   accepted-result-v1 or IR-result alias.
5. Verify that command-ID outcome fields and public mutation IR remain absent.

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

- fixed expected bytes and digests—not values regenerated by the production
  encoder—for no-row, one-Null-row, duplicate multiset, set, scalar absence,
  and ordered results;
- every SQL value tag and column-descriptor variant, including negative-zero
  REAL, rejected nonfinite REAL, registered type identity, and maximum payload
  boundaries;
- rejected unknown/noncanonical versions, tags, widths, indices, and UTF-8;
- statement-with-no-result versus statement-with-empty-result; and
- decode/reencode and digest recomputation by a small reference fixture that
  does not import the production result codec.

### 11.2 RETURNING matrix

For INSERT, UPDATE, DELETE, UPSERT, IGNORE, and REPLACE, cover:

- zero, one, and many directly affected rows;
- defaults, generated values, Null, blobs, dynamic values, and `RETURNING *`;
- conflict paths and inserted/updated target values for each UPSERT arm;
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

Fixtures also inspect the private target selection and identity-relation
lowering, prove that LIMIT/OFFSET expressions are evaluated once, exercise all
target count/byte/binding boundaries, and verify that a runtime without
`SQLITE_ENABLE_UPDATE_DELETE_LIMIT` never prepares the authored statement
directly.

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

Named constraint and trigger fixtures assert fixed canonical identity bytes,
protected-log round trips, RPC decoding, and Null identity for anonymous or
native-message-only failures. Unknown phase/object-kind codes, malformed UTF-8,
and error codes absent from the manifest registry are rejected.

### 11.5 Replay, storage, and RPC

Required scenarios include:

- clean replay, suffix replay, checkpoint replay, cache hit/miss, and reopen
  deriving identical envelope bytes and digest;
- protected-log rejection of every accepted/rejected Nullability violation and
  every envelope/program count, ID, order, or statement-class mismatch;
- late predecessors changing accepted returned values or flipping acceptance;
- DDL before and after RETURNING in one atomic body;
- crash injection before/after envelope encoding, protected-log insert,
  application commit, checkpoint, and publication;
- RPC round-trip of maximum-size envelopes without canonical truncation;
- display truncation leaving canonical bytes/digest unchanged; and
- client result resources updating or disappearing with revisioned outcomes.

### 11.6 Implementation sequence

Implementation completion proceeds in this order. Already-landed prototype
code earns a phase only after it conforms to the exact contract and gates in
this document:

1. lock canonical SQL value tags, REAL semantics, descriptor inference,
   result/envelope codecs, digests, and fixed golden fixtures;
2. enforce the outcome-dependent protected-log schema and verify every envelope
   against its stored signed program on append, reopen, and checkpoint restore;
3. step body reads and the explicitly supported DML RETURNING matrix as
   bounded multisets without post-write reconstruction;
4. implement per-value/column/statement/transaction/sort/target-key semantic
   limits and canonical rejection attribution storage;
5. expose outcome references, exact revision retrieval, raw client decoding,
   and typed revision-loss behavior;
6. validate stable draft-local statement handles and optional typed adapters;
7. implement the conservative ordered target-key subset from Section 5 with
   its private selection/identity-relation lowering; and
8. expand conflicts, triggers, modules, and other mutation forms only through
   ledger-recorded proofs and conformance fixtures.

Each phase must pass clean/suffix/checkpoint replay and crash-atomicity gates
before the next phase. Authored ordered RETURNING is not an implicit final
phase; it requires a separate dialect proposal.

### 11.7 Repository work packages

The implementation series has explicit ownership boundaries:

- `packages/protocol` and the canonical codec layer define SQL program/result
  types, value/result/envelope codecs, domains, golden bytes, and transaction
  identity fixtures. They do not import compiler AST types.
- `packages/compiler-sqlite` produces private statement result plans,
  inferred/dynamic column descriptors, target-key proofs, private selection and
  mutation lowering, stable error plans, and source diagnostics. There is no
  separate SQL frontend package or IR RETURNING path.
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

## 12. Related-specification and repository audit

Specification 10 is authoritative. Specifications 02-06 and `sql-dialect.md`
are historical implementation background wherever they describe public
query/mutation IR, schema manifests/digests, `IR_RETURNING_UNSUPPORTED`, or an
affected-count-only accepted digest. Those shapes MUST NOT return to runtime
code as aliases or compatibility paths.

The SQL-first repository audit requires all of the following:

- protocol codecs and transaction ID derivation accept only exact SQL programs
  and canonical bindings;
- DML RETURNING is a body result whose V1 mode is always multiset;
- protected-log verification uses the versioned complete envelope, never the
  removed accepted-result concatenation;
- RPC and client publication contain no command IDs, mutation IR, schema
  digest, or IR-result alias;
- `packages/compiler-sqlite` is the sole SQL semantic compiler package; and
- `packages/sql-frontend`, schema-generated consensus bindings, and legacy
  mutation renderers/executors remain absent.

The base result cutover does not by itself enable ordered target subsets. The
repository remains conformant while those syntax forms are explicitly gated in
the compatibility ledger. Enabling them requires Sections 5, 7, and 11.3 in
the same measured execution profile change.
