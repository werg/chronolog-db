# Archived Relational IR Dialect Reference

Status: historical implementation reference; superseded by
[Specification 10](implementation-specs/10-deterministic-sql-transactions.md)

This document records the removed relational IR and renderer. It is not an
alternative signed protocol or a description of the current implementation.
Where it describes canonical IR, schema manifests, global schema digests,
special schema commands, or IR-only client/RPC surfaces, Specification 10 is
authoritative.

This document specifies the current deterministic relational intermediate
representation (IR), its execution semantics, and its mapping to DoltLite.
Chronolog is an unreleased prototype, so there is no compatibility reducer or
data migration for replacing this representation during the SQL-first cutover.

The key words **MUST**, **MUST NOT**, **REQUIRED**, **SHALL**, **SHALL NOT**,
**SHOULD**, **SHOULD NOT**, **RECOMMENDED**, **NOT RECOMMENDED**, **MAY**, and
**OPTIONAL** in this document are to be interpreted as described by BCP 14 when
they appear in all capitals.

## 1. Purpose

Chronolog replicas repeatedly execute a totally ordered set of signed
transactions. A transaction that arrives late may be inserted before the
current materialized head, causing the affected suffix to be restored from a
checkpoint and executed again. The language executed by the reducer must
therefore have one reproducible meaning for every supported implementation.

Chronolog does not attempt to make arbitrary SQLite programs replayable.
Instead, application developers formulate transactions in a rich,
deterministic relational language. Chronolog records:

1. the canonical signed IR;
2. its typed values and transaction-context references; and
3. a deterministic SQL rendering used by the DoltLite backend.

The IR is the normative program. The SQL rendering is an exact, human-readable
execution record and MUST be verified as the canonical rendering of that IR.
An implementation MUST NOT execute caller-supplied consensus SQL in place of
the verified rendering.

This design permits broad relational, JSON, full-text, spatial, vector, rule,
and extension functionality without inheriting every ambient or undefined
behavior of SQLite.

## 2. Scope and surfaces

Chronolog exposes three distinct language surfaces.

### 2.1 Consensus IR

The consensus IR defines:

- schema manifests and schema changes;
- transaction preconditions;
- relational mutations;
- deterministic queries whose results affect acceptance or state;
- schema rules and derived indexes;
- registered deterministic extensions.

Consensus IR is signed, validated before admission, and executed during every
replay. This document governs that surface.

### 2.2 Canonical SQL rendering

Each IR program has exactly one rendering for a specified renderer identity and
digest.
The renderer emits SQL statements plus an ordered typed parameter vector.
DoltLite executes only this rendering.

Canonical SQL is not an alternative input language. A validator or
materializer MUST reconstruct it from the IR and reject a candidate whose
committed rendering differs.

### 2.3 Local query SQL

Nodes MAY expose a broader read-only SQLite query API for diagnostics,
administration, and reactive user interfaces. Such queries:

- are not signed transaction programs;
- MUST NOT become preconditions without conversion to validated query IR;
- MUST NOT mutate replicated state;
- may have locally varying presentation behavior;
- remain subject to security and resource controls.

Local SQL features do not imply consensus-dialect support.

## 3. Determinism contract

For a transaction `T` at ordered prefix state `S`, the reducer is specified as
a pure state transition:

```text
reduce(profile, schema, S, T) -> (S', outcome)
```

For identical inputs, every conforming implementation MUST produce the same:

- precondition result;
- ordered or unordered canonical result values;
- application mutations;
- constraint and rule effects;
- stable outcome and rejection code; and
- replay-visible transaction-log row.

The only permitted inputs are:

- the exact replayed database prefix;
- the canonical signed transaction core;
- authenticated transport identity explicitly admitted by the protocol;
- the content-addressed schema and execution manifest; and
- registered extension code and data identified by that manifest.

Consensus execution MUST NOT read:

- a host or connection clock;
- an uncommitted PRNG or entropy source;
- connection history such as last inserted row identifiers or prior change
  counts;
- filesystem, environment, process, locale, or network state;
- local Dolt branch, remote, commit, or working-set state;
- unspecified row or trigger order;
- unregistered native or loadable extension behavior; or
- a local resource configuration not committed by the execution manifest.

Database-prefix state is not considered ambient. Transactions are expected to
depend on prior rows; preconditions make the application assumptions about
those rows explicit.

## 4. Conformance levels

Features are assigned one of four conformance levels.

### 4.1 Core

Every conforming portable-core implementation MUST support the feature with the
exact semantics in this specification.

### 4.2 Registered profile feature

The feature is consensus-safe only when an immutable execution manifest names
its implementation, semantic identity, code digest, limits, and configuration.
FTS5 and sqlite-vec are examples.

### 4.3 Exact-native profile feature

The feature is reproducible only under an exact engine binary, architecture,
compiler, and numeric profile. This level is permitted for controlled groups
but SHOULD NOT be the portable default.

### 4.4 Local-only

The feature may be exposed in non-consensus reads but MUST NOT affect
preconditions, mutations, schema-derived data, or canonical outcomes.

## 5. Consensus execution manifest

Every group SHALL select an immutable `ConsensusExecutionManifest`. Its
domain-separated digest is the execution profile committed by transactions.
The manifest MUST include:

```text
manifest format identity and digest
Chronolog IR semantic identity and digest
canonical IR codec digest
canonical SQL renderer digest
schema manifest digest
DoltLite source and patch digest
SQLite source ID and compile-option digest
supported architecture policy
SQLite database configuration and PRAGMA values
value, text, collation, and numeric profiles
function and aggregate registry
virtual-table and extension registry
FTS, spatial, JSON, and vector profiles
rule and recursion semantics
all semantic resource limits
stable error-code table digest
WASM runtime and ABI identities/digests, when enabled
```

The profile identifier SHOULD be encoded as:

```text
chronolog-ir:<base64url(sha256(canonical_manifest))>
```

A node MUST refuse to attest, materialize, or serve a writable profile when
its local implementation does not exactly satisfy the manifest. Unsupported
candidates MUST be rejected before admission or assigned a stable unsupported
profile state; they MUST NOT poison materialization of otherwise supported
transactions.

The node and materializer MUST compare their independently constructed
manifest digests at startup. A database MUST persist its manifest and schema
digests in reducer-protected metadata, and opening it under different values
MUST fail.

## 6. Canonical IR representation

The wire representation SHALL use deterministic CBOR following the repository's
canonical encoding rules. Every IR node is a tagged structure with:

- a stable integer node tag;
- a fixed field-number registry;
- explicitly typed child values;
- no unknown required fields;
- bounded depth and item counts; and
- no reliance on map iteration order.

Identifiers are nonempty, well-formed UTF-8 strings without NUL. Renderers
double-quote every identifier and escape embedded double quotes, so ordinary
SQL names may contain whitespace, punctuation, keywords, mixed case, and
Unicode without an arbitrary naming convention or 63-byte limit.

Name lookup follows SQLite: ASCII letters compare case-insensitively even for
quoted identifiers, while non-ASCII characters remain byte-distinct. Schema
validation rejects names that collide under that comparison. The `chronolog_`,
`sqlite_`, `dolt_`, `doltlite_`, and `pragma_` prefixes, plus backend eponymous
virtual-table names, are reserved for main-database schema objects. They do not
prohibit ordinary column, alias, projection, or constraint names.

Every precondition, command, schema object, expression, projection, ordering
term, and extension invocation carries a stable ID within its containing
object. These IDs permit stable error attribution and deterministic rule
ordering without using source position.

## 7. Value system

IR values have explicit logical types. SQLite storage classes are a backend
encoding, not the type system.

### 7.1 Null and Boolean

`Null` is distinct from every other value. `Boolean` has exactly `false` and
`true`. The DoltLite renderer stores Boolean as integer `0` or `1` but MUST
reject any other stored representation when reading a Boolean column.

### 7.2 Signed integers

`Int64` covers `[-2^63, 2^63-1]`. Integer operations are checked. Overflow
MUST yield `NUMERIC_OVERFLOW`; it MUST NOT silently promote to binary64.

Profiles MAY register wider bounded integer types implemented by deterministic
WASM or canonical byte encodings. Their width and arithmetic rules are part of
the manifest.

### 7.3 Decimal

`Decimal(p,s)` is an exact base-10 value with maximum precision `p` and scale
`s`. A value is represented canonically as a signed coefficient and scale.
Profiles MUST specify:

- maximum precision;
- rounding mode for explicit rescaling;
- overflow behavior;
- division result scale; and
- text and storage encoding.

Core arithmetic never rounds implicitly. The portable backend SHOULD store
decimal values as canonical text or a tagged binary encoding and implement
operations with the registered deterministic numeric kernel.

The implemented Int64 path checks negation, addition, subtraction,
multiplication, division, remainder, and left shift. SQLite REAL overflow
promotion and zero-divisor Null fallback are intercepted before a result is
observed and become `SQL_EVALUATION_ERROR`; no floating value enters the
canonical result or stored state. Shift counts are restricted to `[0, 63]`,
left shift proves reversibility, and bitwise XOR is lowered from exact bitwise
operations. TimestampMs plus/minus DurationMs, TimestampMs differences,
DurationMs addition/subtraction, and DurationMs scaling by Int64 use the same
checked representation.

### 7.4 Binary floating point

`Float32` and `Float64` are not portable-core scalar arithmetic types. A
registered exact-native or deterministic-software profile MAY enable them.
Such a profile MUST define:

- permitted bit patterns;
- NaN and infinity policy;
- negative-zero policy;
- rounding mode;
- operation and reduction order;
- canonical result bits; and
- cross-platform conformance vectors.

The RECOMMENDED policy rejects NaN and infinities and canonicalizes negative
zero unless exact bit preservation is explicitly required. Native SQLite
floating aggregation is local-only unless the exact-native profile says
otherwise.

### 7.5 Text

`Text` is a sequence of valid UTF-8 Unicode scalar values. Invalid UTF-8 MUST
be rejected before entering the IR or when read from backend storage. The core
does not perform implicit Unicode normalization or locale-sensitive case
conversion.

The default collation is `binary_utf8`, which compares unsigned UTF-8 bytes.
Other collations MUST be registered deterministic extensions that define a
total order and include their Unicode data and implementation digests.

### 7.6 Blob

`Blob` is a bounded byte string compared lexicographically by unsigned bytes.
No implicit text conversion is permitted.

### 7.7 UUID

`Uuid` is a 16-byte value with canonical RFC 4122 network byte order. UUID
generation occurs in the client or through labeled transaction entropy; it
never uses SQLite randomness.

### 7.8 Timestamp and duration

`TimestampMs` is a signed 64-bit count of milliseconds from the Unix epoch.
It has no implicit timezone. Calendar formatting and parsing require explicit
UTC or a registered, versioned timezone-data extension.

`DurationMs` is a checked signed 64-bit millisecond count. Timestamp arithmetic
is checked integer arithmetic.

### 7.9 JSON

`Json` is the canonical JSON value described in section 19. It is distinct
from unvalidated Text and from SQLite JSONB.

### 7.10 Vector

`Vector(element_type, dimensions)` is a fixed-length vector described in
section 21. Its dimensions and element type are part of the schema.

## 8. Transaction context

Transaction context makes legitimate contingent values explicit and
replay-stable. The IR MAY reference:

```text
group_id
membership_revision
validation_policy
author_id
author_timestamp_ms
transaction_nonce
candidate_digest
transport transaction_id
author_feed_sequence
```

Every value is authenticated by the transaction core or admitted transport
record. `author_timestamp_ms` is the author's signed effective-time claim, not
proof of objective civil time. Although the protocol's integer codec can carry
an unsigned 64-bit value, the Chronolog IR restricts `author_timestamp_ms` to
`[0, 2^63-1]` so it is a valid `TimestampMs` and can participate in checked
timestamp arithmetic without backend-specific unsigned coercion.

### 8.1 Draft allocation

When a builder needs the timestamp or entropy during observation, the node
SHALL reserve the draft's author timestamp and nonce before those observations
run. Publication MUST use the reserved values. A rebase that changes either
value MUST invalidate and refresh every dependent observation.

Nodes SHOULD persist a per-author timestamp floor and choose:

```text
max(local_wall_clock_ms, last_authored_timestamp_ms + 1)
```

This avoids accidental local backdating without changing the protocol's
wall-clock ordering semantics.

### 8.2 Labeled deterministic entropy

Sequential seeded PRNG calls are prohibited because results can depend on
evaluation count and order. Entropy is derived statelessly from the signed
transaction nonce.

For label `L`, unsigned index `I`, and output length `N`:

```text
PRK = HKDF-Extract-SHA256(salt = group_id, IKM = transaction_nonce)
info = "chronolog/entropy/v1" || 0x00 ||
       uint16be(utf8_length(L)) || utf8(L) || uint64be(I)
output = HKDF-Expand-SHA256(PRK, info, N)
```

Labels MUST be non-empty ASCII strings of at most 128 bytes. The profile caps
`N`. The same `(transaction, label, index, length)` always yields the same
bytes. Different semantic uses SHOULD use distinct labels.

This entropy is author-controlled. It is suitable for stable identifiers,
salts, sampling, and tie-breakers, but not for lotteries or other
manipulation-resistant randomness. Such applications require a registered VRF
or commit/reveal protocol.

## 9. Schema manifest

Genesis and every future schema change use canonical schema IR. Raw genesis SQL
and arbitrary schema DML are prohibited.

The schema manifest contains:

- schema digest and optional parent digest;
- tables, columns, keys, constraints, and indexes;
- views and materialized derived structures;
- rules;
- JSON, FTS, spatial, and vector indexes;
- registered functions, collations, and modules; and
- deterministic seed data encoded as typed literal rows.

The schema digest covers all of the above. Seed data MUST contain only literal
or transaction-independent canonical values. Genesis MUST NOT execute clocks,
entropy, pragmas, queries over local state, or unregistered extensions.

### 9.1 Tables

A table definition specifies:

```text
name
columns in declaration order
primary key
unique constraints
check constraints
foreign keys
row storage mode
table-level rules
```

Every application table MUST have an explicit primary key. The portable
default is `WITHOUT ROWID` where backend compatibility permits. If a rowid
table is used, every consensus insert MUST supply its integer primary key.
Implicit ROWID allocation is prohibited because SQLite can consult its PRNG at
the maximum ROWID.

`STRICT` storage is RECOMMENDED, but logical type validation remains the IR
executor's responsibility.

### 9.2 Columns

A column specifies its logical type, nullability, optional collation, optional
literal or deterministic default, and optional generated expression.

Defaults MAY depend on:

- typed literals;
- other explicitly permitted constant expressions; and
- transaction context, including timestamp and labeled entropy.

Backend SQL defaults cannot bind transaction context. The renderer MUST expand
contextual defaults into each mutation rather than relying on a SQLite
`DEFAULT` expression.

Generated columns MAY be virtual or stored. Their expressions may reference
same-row columns and registered pure functions. Cycles are prohibited.

### 9.3 Constraints

The dialect supports:

- primary and unique keys;
- not-null constraints;
- pure check expressions;
- immediate and deferred foreign keys; and
- `restrict`, `no_action`, `cascade`, `set_null`, and deterministic
  IR-defined `set_default` actions.

Deferred constraints are evaluated at the candidate's top-level transaction
boundary. A violation rejects that candidate, not the entire replay suffix.

Constraint names are required and determine stable error attribution. When
multiple constraints fail, the executor uses the order defined in section 17,
not backend diagnostic order.

### 9.4 Indexes

Ordinary, unique, expression, and partial indexes are supported. Index
expressions and predicates use pure expression IR. Indexes MUST NOT alter
logical query results; planner choice is not part of consensus semantics.

An index over floating or extension-derived values requires the exact profile
that defines those values. Index rebuilds MUST reproduce identical logical
entries even if physical pages differ.

### 9.5 Views

Views are named query IR and are supported. A view MUST declare explicit output
column names and types. View definitions are recursively validated.

Ordering inside a view does not establish consumer-visible order. A consuming
query must declare its own result mode and ordering. Writable views use
explicit rewrite rules; they do not acquire arbitrary implicit trigger
semantics.

### 9.6 Materialized derived data

Materialized views and secondary search structures are deterministic derived
data. Their maintenance program, rebuild algorithm, storage format, and
profile identity and digest are part of the manifest. They MUST be updated in the same
candidate transaction as their source rows or rebuilt before branch
publication.

## 10. Expression IR

Expression nodes are typed before execution. There are no implicit lossy
conversions. Core expressions include:

- literals and typed parameters;
- column, `old`, `new`, and transaction-context references;
- Boolean connectives and comparisons;
- null tests and null coalescing;
- checked integer and exact-decimal arithmetic;
- text and blob concatenation, length, slicing, and search;
- conditional expressions;
- deterministic casts;
- compiler-owned pinned SQLite functions for exact text/blob construction and
  inspection, null/conditional selection, pattern predicates, scalar extrema,
  hexadecimal and Unicode conversion, planner identity hints, and checked
  integer magnitude/sign;
- JSON expressions;
- registered pure scalar functions; and
- scalar, existence, membership, and quantified subqueries.

Compiler-owned functions are distinct from registered extension functions and
need no schema registration. The implemented set is `char`, `concat`,
`concat_ws`, `length`, `octet_length`, `lower`, `upper`, `trim`, `ltrim`,
`rtrim`, `replace`, `instr`, `substr`, `substring`, `hex`, `coalesce`,
`ifnull`, `nullif`, `if`, `iif`, `likely`, `unlikely`, the `glob()` and
`like()` function forms, scalar `min()`/`max()`, `quote`, `typeof`, `unhex`,
`unicode`, `unistr`,
`unistr_quote`, `zeroblob`, `abs`, and `sign`. Integer `abs` overflow is a
stable `SQL_EVALUATION_ERROR` consensus outcome, attributed to its precondition
or command; local reads retain native backend diagnostics.

Connection-history functions, randomness, extension loading, engine-build and
physical-offset introspection, current date/time forms, optional compile-time
functions, and floating or dynamic-format functions are not admitted through
this path. Remaining JSON1 routines require explicit canonical JSON IR
semantics rather than manifest-free generic scalar typing.

### 10.1 Three-valued logic

Relational predicates use SQL three-valued logic: `true`, `false`, and
`unknown`. `WHERE`, `HAVING`, partial-index predicates, and rule guards select
only `true`. Preconditions explicitly state whether `unknown` is failure or an
expected value.

### 10.2 Equality and ordering

Equality is type-aware. Integer `1`, Decimal `1`, Text `"1"`, and JSON number
`1` are not implicitly equal. Explicit casts are required.

Every orderable type defines one total order. Null placement is explicit on
each ordering term. The default is prohibited in consensus order clauses so a
renderer cannot inherit backend defaults accidentally.

### 10.3 Function registry

Every callable function has a manifest entry containing:

```text
stable function ID
argument and return types
null-propagation rules
purity and effect class
implementation/semantic digest
resource cost model
allowed schema contexts
```

Only functions classified `pure` may appear in consensus expressions. A
function marked deterministic by SQLite is not automatically registered.

## 11. Query IR

The dialect supports:

- projections and aliases;
- base tables, views, table functions, and registered virtual relations;
- inner, left, right, full, and cross joins;
- correlated and uncorrelated subqueries;
- `WHERE`, grouping, `HAVING`, and aggregates;
- window functions;
- `UNION ALL`, `UNION`, `INTERSECT`, and `EXCEPT`;
- nonrecursive and recursive common-table expressions;
- deterministic ordering, offset, and limit; and
- JSON, FTS, spatial, and vector relational operators.

### 11.1 Result modes

Every consensus query declares exactly one result mode.

#### Scalar

The query MUST return exactly one column and at most one row. Zero rows
canonicalize as explicit absence, distinct from one row containing `NULL`.
Additional rows or a different column count produce `RESULT_SHAPE_MISMATCH`.

#### Ordered

Row sequence is significant. Authored `ORDER BY` terms are preserved as the
leading order. The compiler completes ties with hidden canonical projected-row
terms; if no `ORDER BY` is present, explicitly requesting ordered mode uses the
canonical projected row as the complete order. Rows with identical canonical
projections are observationally interchangeable.

Candidate primary and non-null unique keys may provide a narrower completion
when their use does not introduce a hidden schema dependency. Applications do
not provide ordering-proof flags.

#### Multiset

Row sequence is not significant but duplicates are. Each row is canonically
encoded, rows are sorted lexicographically by encoded bytes, and duplicate
rows are retained. Column order and types remain significant.

#### Set

Row sequence and duplicates are not significant. Rows are encoded, sorted,
and deduplicated. Set mode must be requested explicitly; it is not the default.

### 11.2 Row-choice operations

`LIMIT`, `OFFSET`, top/bottom selection, window frames, order-sensitive
aggregates, and scalar subqueries that may observe more than one row require a
compiler-completed total order. The compiler adds deterministic tie-breakers
where relational provenance permits it and rejects only when the relevant
intermediate row identity cannot be ordered. An unordered physical scan MUST
NOT select the winner.

### 11.3 Grouping and aggregates

Core aggregates include count, exact integer sum, exact decimal sum, minimum,
maximum, Boolean all/any, and explicitly ordered collection aggregates.

- Integer sum is checked and never promotes to REAL.
- Decimal sum uses the registered exact decimal kernel.
- Collection, JSON, text, percentile, median, and user aggregates MUST declare
  an input order or prove themselves commutative and associative under the
  registered value semantics.
- Floating aggregates require a registered numeric profile.
- Bare non-grouped columns beside aggregates are prohibited.

The currently implemented portable subset includes `COUNT(*)`, `COUNT(expr)`,
`COUNT(DISTINCT expr)`, `MIN`, `MAX`, Boolean `EVERY`/`BOOL_AND`, and Boolean
`ANY`/`SOME`/`BOOL_OR`, including standard aggregate
`FILTER (WHERE ...)`, null behavior, and compiler-derived result nullability.
`MIN`/`MAX` are enabled only for logical
types whose canonical storage order is the declared logical order. Checked
integer/decimal sums, floating aggregates, and order-sensitive aggregates stay
gated until their pinned kernels or canonical input-order plans are available.
SQLite integer `SUM` cannot be admitted merely by normalizing overflow: whether
an intermediate overflow occurs can change with scan order even when the same
multiset has an in-range mathematical sum. Floating accumulation additionally
depends on evaluation order and an unregistered numeric profile. Collection,
text, and JSON aggregates need an explicit total input order and bounded result
plan rather than SQLite's incidental visitation order.

### 11.4 Window functions

Window partitions and frames are supported. An order-sensitive window MUST
end in a total tie-breaker. Frame boundaries, null placement, and exclusion
mode are explicit.

### 11.5 Recursive CTEs

Recursive CTEs declare:

- union mode;
- deterministic frontier ordering;
- cycle handling;
- maximum depth;
- maximum emitted rows; and
- a stable resource-limit outcome.

The portable profile uses breadth-first frontier order followed by the
declared total row key. A backend MAY execute differently only if it produces
the same canonical result and limit behavior.

### 11.6 Query plans

Query planner selection, index choice, and physical scan order are not
observable semantics. Implementations MUST obtain the same logical result
under every permitted plan. QPSG is defense in depth, not a substitute for
total-order or multiset rules.

## 12. Mutation IR

Mutations are explicit relational commands. The core supports insert, upsert,
update, delete, deterministic merge, and calls to registered stateful modules.

Every command declares:

```text
stable command ID
target relation
typed input or predicate
conflict policy
expected affected-row condition
optional returning query and result mode
```

### 12.1 Insert

Insert lists every target column or invokes `DEFAULT VALUES` through the
canonical empty-column/single-empty-row form. Every primary-key component MUST
be explicit or supplied by a deterministic schema default. Multirow input has
a canonical row order. `INSERT ... SELECT` preserves authored ordering and
then orders remaining ties by every projected logical value with explicit null
placement. Scalar, ordered, set, and multiset sources are therefore accepted
without making conflict handling depend on SQLite's unspecified visitation
order.

### 12.2 Upsert and conflict policy

Upsert names the exact unique constraint used for conflict detection and one
of:

```text
reject
ignore
update with expression IR
delete_then_insert
```

The affected existing row is identified by the named key, never by backend
conflict discovery order. Named SQLite upsert supports `DO NOTHING`,
`DO UPDATE SET`, and an optional `DO UPDATE ... WHERE` predicate. Its target is
always the exact column list of the named primary-key or unique constraint.
The input may be either one explicit values row or a typed query source;
query-source upserts receive the same width, type, and canonical application
ordering checks as ordinary insert-select.

For standard SQLite insert compatibility, the separately signed insert
policies `ignore` and `replace` lower explicitly to `INSERT OR IGNORE` and
`INSERT OR REPLACE`. `replace` intentionally has the pinned SQLite
delete-conflicting-row/insert-new-row behavior and is never substituted for a
named upsert update. A future portable `delete_then_insert` rule plan remains a
distinct higher-level operation.

Insert, update, delete, and upsert may carry quoted target aliases. The alias is
part of canonical IR rather than reconstructed from SQL text; `excluded`
remains reserved as SQLite's incoming-row scope during upsert.

### 12.3 Update and delete

Update and delete operate on a relation plus deterministic predicate. If row
order affects rules, returning results, limits, or conflicts, rows are
processed in primary-key order unless another total order is explicit.

Update expressions read the pre-update row unless a command explicitly refers
to a preceding assignment through a sequential-assignment construct. The
portable default evaluates all assignments from the same old row.

SQLite `UPDATE OR IGNORE` and `UPDATE OR REPLACE` are accepted only for a
compiler-proven single target row. `UPDATE ... FROM` is accepted when its named
query source is compiler-proven to produce at most one row globally, or a
simple source table is joined through a complete projected primary/unique key.
General multirow conflict updates and more complex update joins are gated until
the compiler can prove a canonical per-target source mapping; relying on
SQLite's physical row choice is not deterministic SQL semantics.

Surface `OR ABORT`, `OR FAIL`, and `OR ROLLBACK` normalize to the ordinary
`error` policy because every constraint failure rejects and rolls back the
whole atomic candidate. Row-value `SET` syntax normalizes to simultaneous
assignments once parsed, and `main.` is the application schema rather than a
distinct object namespace. UPDATE/DELETE `ORDER BY ... LIMIT` depends on an optional
SQLite build flag and does not control physical mutation order; it remains
gated pending canonical primary-key subset lowering.

The current compatibility frontend uses a typed parser generated from SQLite's
`parse.y` and lowers `DEFAULT VALUES`, `REPLACE INTO`, `UPDATE OR ...`, chained
`ON CONFLICT ... DO ...`, `UPDATE ... FROM`, row-value `SET`, mutation CTEs,
and `main.` as the application schema. The parser is a client adapter into the
current transitional canonical IR; it is not a second signed SQL protocol.

### 12.4 Merge

Merge consumes a deterministic source query, an explicit target key, and
ordered matched/not-matched actions. It MUST reject a source that maps multiple
rows to one target unless a deterministic conflict action is declared.

### 12.5 Expected effects

Every mutation SHOULD state an affected-row expectation:

```text
exactly N
at least N
at most N
between N and M
unconstrained
```

A mismatch rejects the transaction with `AFFECTED_ROWS_MISMATCH`. This makes
otherwise silent no-op mutations visible to application logic.

The count is defined by IR target rows, independently of trigger/rule auxiliary
writes.

### 12.6 Returning

Returning is a query over affected rows with scalar, ordered, multiset, or set
semantics. Returning data may be committed to the transaction's expected
effects or exposed diagnostically. It MUST be stepped and bounded
incrementally.

The current implementation rejects mutation `RETURNING`: the executor returns
only `changes()`, the accepted-result-v1 digest frames only precondition digests
and affected counts, and RPC outcomes contain no typed row envelope. SQLite's
RETURNING row order is also unspecified. A durable implementation therefore
needs a versioned result envelope and digest/RPC/client support, not just a
rendered SQL clause.

## 13. Preconditions

Every transaction carries at least one precondition. Preconditions run in
declared order against the database prefix before any command in that
transaction.

### 13.1 Assertion

An assertion is a scalar Boolean query. It passes only on `true`; `false`,
`unknown`, or a shape error fails with an attributed stable code.

### 13.2 Expectation

An expectation contains:

- validated query IR;
- scalar, ordered, multiset, or set result mode;
- either an inline canonical result or its domain-separated digest; and
- a stable precondition ID and optional application label.

Observed results MUST be captured from one immutable materialized revision.
Refreshing several observations MUST use one common snapshot.

### 13.3 Row and version helpers

Client libraries SHOULD provide higher-level helpers:

```text
require_row(key, projected values)
require_absent(key)
require_exists(query)
require_transaction_precedes(tx_id)
require_transaction_accepted(tx_id)
require_schema_digest(digest)
```

These compile to ordinary query IR. The replay-visible transaction log contains
only preceding transactions during evaluation.

### 13.4 Dependency completeness

Chronolog guarantees deterministic execution of the expressed program. It
cannot infer every business assumption. A trivial true precondition is valid
IR but provides no concurrency protection.

Transaction builders SHOULD record observed rows, synthesize primary-key
expectations, expose affected-row assertions, and warn when a mutation reads
state not covered by an observation. Stronger application profiles MAY require
read-set coverage.

### 13.5 Failure attribution

The transaction log records the first failing precondition ID and its index in
addition to the stable rejection code. Labels intended to be portable across
clients MUST be part of the signed IR.

## 14. Deterministic rules and trigger semantics

Chronolog supports schema rules rather than arbitrary SQLite trigger text. A
rule declares:

```text
stable rule ID
timing: before_validate | after_insert | after_update | after_delete |
        instead_of
target relation or view
optional changed-column set
pure guard expression
ordered command body
priority
recursion policy and limit
```

Rules with the same timing and target execute by `(priority, rule_id)`. For a
multirow mutation, rule invocations execute by the mutation's canonical target
row order. There is no backend-dependent trigger creation order.

`old`, `new`, and transaction context are explicit typed bindings. A rule body
is ordinary validated mutation IR. Rules cannot write reducer-protected
relations.

Portable `before_validate` rules may validate or derive `new` values but MUST
NOT delete or mutate the target row through a nested command. `after_*` rules
may perform ordinary mutations. `instead_of` rules define writable-view
rewrites.

Recursive invocation is disabled by default. When enabled, the rule declares a
maximum depth and cycle key. Exceeding the semantic limit yields
`RULE_RECURSION_LIMIT` and rejects the candidate.

The renderer MAY implement rules as SQLite triggers only if conformance tests
prove identical semantics. Expanding rule commands explicitly is preferred.

## 15. Candidate execution and atomicity

Each candidate executes in its own top-level SQLite transaction on the
disposable Dolt replay branch. Per-candidate savepoints inside one suffix-wide
SQLite transaction are not a sufficient isolation boundary because SQLite
rollback conflict policies, write interruption, and deferred constraints may
escape a savepoint.

The algorithm is:

1. Check protocol, admission proof, execution manifest, schema digest, and IR.
2. Begin a top-level candidate database transaction.
3. Evaluate all preconditions without application writes.
4. If they pass, execute commands, rules, and constraints.
5. Insert the accepted transaction-log row in the same transaction.
6. Commit the candidate transaction.
7. On deterministic rejection, ensure the candidate transaction is completely
   rolled back, begin a fresh transaction, insert only the rejected log row,
   and commit it.
8. On operational or unknown failure, abort local replay without deriving a
   canonical rejection.

Intermediate SQLite commits remain unpublished because the entire Dolt replay
branch is disposable. The materializer publishes only the verified final
branch ref after the suffix is complete.

An accepted application state and its log row are atomic. A rejected candidate
has no application effects but remains visible to later transaction-log
preconditions.

## 16. Canonical SQL rendering

The renderer identity and digest are part of the execution manifest. It SHALL:

- validate and quote all identifiers;
- use positional placeholders in deterministic depth-first IR traversal order;
- bind every value with an exact logical/storage type;
- emit explicit column lists, collations, null placement, conflict policies,
  and ordering;
- parenthesize expressions according to a fixed rendering grammar;
- emit one prepared statement per rendered command;
- reject non-trivia SQL tails; and
- never interpolate data values into SQL text.

Schema SQL is generated solely from schema IR. The canonical transaction log
stores the canonical IR and MAY store renderer output for audit. Replicas MUST
be able to regenerate and compare any stored rendering byte-for-byte.

Backend-only helper tables and statements use the reserved `chronolog_`
namespace and are excluded from application IR.

## 17. Error model

Only errors defined as deterministic by the active manifest become canonical
transaction rejections. Core codes include:

```text
PRECONDITION_FALSE
EXPECTATION_MISMATCH
RESULT_SHAPE_MISMATCH
AFFECTED_ROWS_MISMATCH
NOT_NULL_VIOLATION
UNIQUE_VIOLATION
FOREIGN_KEY_VIOLATION
CHECK_VIOLATION
NUMERIC_OVERFLOW
DIVISION_BY_ZERO
INVALID_UTF8
INVALID_JSON
JSON_PATH_ERROR
VECTOR_DIMENSION_MISMATCH
VECTOR_VALUE_INVALID
RULE_RECURSION_LIMIT
SEMANTIC_RESOURCE_LIMIT
SCHEMA_DIGEST_MISMATCH
EXECUTION_PROFILE_MISMATCH
EXTENSION_SEMANTIC_ERROR
```

Error selection is based on IR validation and named constraints, not SQLite
English error text. If multiple errors are simultaneously possible, priority
is:

1. profile and schema;
2. preconditions in declared order;
3. commands in declared order;
4. rule invocations in canonical order;
5. named constraints in canonical constraint-ID order;
6. returning and effect expectations.

I/O, corruption, lock, memory allocation, missing code, addon bugs, host
exceptions, and unknown SQLite errors are operational. They stop local replay
and MUST NOT be recorded as if the author deterministically caused rejection.

## 18. Resource semantics

All parser depth, IR size, parameter bytes, statement count, result rows,
result bytes, JSON depth, vector dimensions, recursive rows, rule depth, WASM
fuel, and deterministic module limits are committed by the manifest.

Consensus limits SHOULD be measured in semantic units. Approximate SQLite VM
progress callbacks and planner-dependent opcode counts are operational safety
limits unless the profile pins an exact interpreter and cost model. Exceeding
an operational limit marks the node unable to materialize; it does not create
a replica-specific rejected transaction.

Result limits MUST be enforced while stepping rows and encoding values, not
after eager materialization.

## 19. JSON profile

Chronolog provides a first-class Json type and full deterministic JSON IR.

### 19.1 Accepted form

Consensus JSON input MUST be strict RFC 8259. JSON5 input is local-only unless
a registered parser profile first converts it to canonical Json.

Object keys are unique Text values. Duplicate keys are rejected. Object member
order is semantically irrelevant; array order is significant. JSON null is
distinct from SQL Null and from a missing path.

JSON numbers are either Int64 or exact Decimal. Native binary floating JSON
numbers require the registered float profile.

### 19.2 Canonical encoding and storage

Canonical IR encoding represents JSON as a typed tree. Object entries are
ordered by unsigned UTF-8 key bytes for encoding and hashing.

The canonical text renderer:

- emits object keys in canonical order;
- emits no insignificant whitespace;
- escapes quotation mark, reverse solidus, and control characters;
- emits other valid Unicode scalar values directly;
- emits integers in minimal decimal form; and
- emits exact decimals without exponent notation, retaining one fractional
  digit to distinguish a Decimal from an Int64 when the normalized decimal is
  integral, and otherwise removing trailing fractional zeroes.

Canonical Json columns SHOULD store this UTF-8 text. A write-time canonicalizer
and validation constraint prevent noncanonical storage.

SQLite JSONB is an internal optimization, not a protocol value. A profile MAY
use JSONB as derived cache or generated storage only when its exact SQLite
source and format are pinned. JSONB blobs MUST NOT be signed as canonical Json
or exchanged between profiles.

### 19.3 JSON expressions

The IR supports:

- type, validity, equality, and containment;
- object and array construction;
- RFC 6901 pointer and typed path access;
- existence and missing-value tests;
- insert, replace, set, remove, and array splice;
- RFC 7396 Merge Patch;
- RFC 6902 JSON Patch;
- deterministic deep merge with an explicit conflict policy;
- object keys, array elements, recursive tree expansion;
- ordered array and object aggregation; and
- conversion between Json and compatible relational values.

SQLite JSON path syntax MAY be accepted by client tooling but is normalized to
canonical path IR before signing.

### 19.4 Equality and comparison

Json equality is structural after canonicalization. Object key order does not
matter. Number equality is type-aware unless an explicit numeric-coercion
operator is used. Json has no default total order; queries must order by a
scalar path, canonical encoding, or registered Json collation explicitly.

### 19.5 Relational expansion

`json_each` and `json_tree` are modeled as deterministic table functions with
explicit columns and path order. Object entries use canonical key order;
arrays use ascending index. Backend `json_each` physical order is not relied
upon.

### 19.6 JSON aggregates

JSON arrays preserve declared aggregate input order. JSON object aggregation
requires a key-uniqueness policy: reject, first by total order, last by total
order, or aggregate values. An arbitrary first or last scanned row is
prohibited.

### 19.7 JSON indexes and validation

Schema IR supports generated/indexed JSON paths, partial indexes over JSON
predicates, and unique constraints over extracted typed values.

JSON Schema validation MAY be supplied by a registered deterministic WASM
module. Its JSON Schema draft, vocabulary set, reference bundle, format rules,
and code digest are part of the manifest. Remote schema retrieval is
prohibited during execution.

### 19.8 DoltLite JSON mapping

The pinned DoltLite build currently contains SQLite's JSON and JSONB scalar,
aggregate, and table-function families. The renderer MAY use them only where
the execution manifest proves equivalence to Chronolog semantics. Duplicate
key rejection, canonical object ordering, exact decimal behavior, and
canonical storage require Chronolog validation or extension code in addition
to raw JSON1 behavior.

## 20. Full-text search profile

FTS is a registered schema feature represented as `FullTextIndex` IR. The
portable implementation may use statically compiled FTS5.

An index definition includes:

```text
index and source relation
explicit source primary key
indexed and unindexed columns
content-storage mode
tokenizer and ordered tokenizer options
prefix lengths
detail and column-size modes
normalization rules
ranking profile
module source and semantic digest
```

Only built-in, manifest-pinned tokenizers are allowed. Custom native tokenizers
are prohibited. A deterministic WASM tokenizer MAY be registered with fixed
Unicode data and no ambient imports.

The initial audited tokenizers may include `ascii`, `unicode61` with explicit
options and Unicode version, `porter` over a specified base tokenizer, and
`trigram`.

### 20.1 Content maintenance

Application transactions write source rows, not FTS shadow tables. Chronolog
maintains the FTS index transactionally in source primary-key order. External
content configuration is permitted only when generated and maintained by the
schema compiler. Direct shadow-table writes are prohibited.

FTS storage MUST live entirely in the Dolt-versioned database. Sidecar indexes
or host files are not consensus state.

### 20.2 Query grammar

FTS query strings are parsed into a canonical FTS query IR supporting terms,
phrases, prefixes, column filters, Boolean combination, and proximity. Raw
query strings are not signed without canonical parsing.

Matches are unordered unless the query declares a total order. Primary key is
the mandatory final tie-breaker for ranked results.

### 20.3 Ranking and snippets

Native FTS5 BM25 uses floating-point scoring and is local-only in the portable
profile. Consensus ranking SHALL use either:

- an exact fixed-point Chronolog BM25 implementation;
- a registered ranking implementation that emits a deterministic ordinal rank
  followed by primary-key ties; or
- an exact-native profile that pins architecture and implementation.

Snippet, highlight, and offset output is permitted when tokenizer and Unicode
semantics are pinned and results are bounded.

## 21. Vector profile and sqlite-vec mapping

Vector search is a registered schema feature represented as `VectorIndex` IR.
The preferred DoltLite backend is a statically compiled, source-pinned
sqlite-vec module. Dynamic extension loading remains disabled.

sqlite-vec is not assumed compatible merely because it compiles. A profile may
register it only after the Dolt conformance gates in section 21.8 pass.

### 21.1 Vector schema

A vector column declares:

```text
element type: bit | int8 | float32
positive fixed dimension
canonical byte order
nullability
normalization invariant, if any
```

Every indexed vector row has an explicit application primary key. Backend
rowid allocation is never implicit.

### 21.2 Canonical encoding

- Bit vectors pack bits from most significant to least significant within each
  byte and zero unused trailing bits.
- Int8 vectors encode two's-complement bytes.
- Float32 vectors encode IEEE-754 bits in big-endian element order at the IR
  boundary. Backend conversion is explicit.

Dimensions and payload length must match. Float profiles reject NaN and
infinities and define negative zero before indexing.

JSON arrays MAY be accepted by client tooling for vector input but are
converted to canonical binary Vector values before signing.

### 21.3 Exact distance functions

The portable profile supports:

```text
bit:    Hamming distance -> nonnegative Int64
int8:   Manhattan distance -> nonnegative Int64
int8:   squared Euclidean distance -> nonnegative Int64
int8:   dot product -> Int64
```

Dimension limits ensure accumulators cannot overflow; otherwise checked
overflow rejects execution. Euclidean ranking compares squared distance and
does not compute a square root.

Cosine similarity for integer vectors uses a registered exact rational or
fixed-point comparison kernel. Float32 L2, cosine, and dot products require a
deterministic software-float/WASM kernel or exact-native profile. Reduction
order is fixed by ascending dimension index.

### 21.4 Exact nearest-neighbor search

Exact KNN is the portable baseline and correctness oracle:

1. select every row satisfying structured filters;
2. compute registered distance in primary-key order;
3. sort by `(distance, primary_key)`;
4. return the first `k` rows.

Distance plus primary key is a total order. Pagination uses that tuple as its
cursor.

The backend MAY use sqlite-vec `vec0` scanning and distance functions after
they pass conformance. Backend result order is ignored and canonical ordering
is reapplied.

### 21.5 Approximate indexes

Approximate nearest-neighbor algorithms are optional registered features.
Their manifest includes construction, search, update, deletion, compaction,
and rebuild semantics plus all tuning parameters.

A deterministic graph index such as HNSW MUST derive randomized choices from
`hash(index_id, primary_key, purpose)` rather than a mutable PRNG stream. It
MUST use canonical insertion order, stable neighbor ordering by distance and
primary key, a single specified concurrency model, and a canonical rebuild.

IVF, DiskANN-style, and quantized indexes require similarly pinned training or
construction inputs. Approximation is acceptable; nondeterministic result sets
are not.

### 21.6 Embedding provenance

Embeddings are ordinarily produced outside the reducer and supplied as signed
transaction values. Chronolog guarantees their storage and search semantics,
not the truthfulness or reproducibility of the model that produced them.

In-reducer embedding generation requires a separate registered model profile
covering model weights, tokenizer, inference runtime, quantization, numeric
kernels, and fuel. Network model calls are prohibited.

### 21.7 sqlite-vec integration

The selected sqlite-vec source commit SHALL be vendored or checksum-pinned and
compiled into the same DoltLite artifact. The manifest records:

- upstream commit and source archive digest;
- Chronolog patches;
- compile flags and target architecture;
- module, storage, and function identities/digests;
- enabled vector types and metrics;
- exact or approximate algorithm configuration; and
- conformance corpus digest.

The Node binding MUST register it statically. `load_extension` remains
disabled. Application SQL cannot create arbitrary `vec0` tables; schema IR
creates only manifest-approved forms.

### 21.8 Dolt semantic conformance gate

Before sqlite-vec is enabled for a profile, tests MUST prove:

1. vector and shadow-table state is contained entirely in the active Dolt
   database;
2. insert, update, delete, rollback, and constraint failure are transactional;
3. Dolt commit, branch checkout, hard reset, and checkpoint restoration recover
   the matching vector index;
4. a late predecessor followed by suffix replay equals a clean replay of the
   same final order;
5. branch-local vector changes do not leak across readers or branches;
6. reopen and crash recovery preserve index/query results;
7. protected shadow tables cannot be mutated through application IR or local
   write APIs;
8. exact KNN vectors match the independent reference kernel;
9. equal-distance ties resolve by canonical primary key; and
10. every supported OS/architecture produces the profile's expected vectors.

If sqlite-vec fails these gates, Chronolog SHALL store canonical vector blobs
in ordinary Dolt tables and use its own deterministic scan/index module rather
than weakening replay semantics.

## 22. Spatial profile

Integer spatial indexing is a registered feature backed by `rtree_i32` or a
deterministic equivalent. Coordinates, overlap predicates, and result ties use
checked integers and explicit bounds.

The ordinary floating RTree module requires the float profile because it stores
32-bit floating-point coordinates. Spatial virtual tables are subject to the
same Dolt containment, rollback, shadow-table, and replay tests as vectors.

## 23. Hybrid retrieval

Hybrid queries combine structured relational/JSON filters, FTS matches, vector
neighbors, and spatial predicates through ordinary query IR.

The portable fusion operator is reciprocal-rank fusion over deterministic
ranked inputs. It declares positive integer weights and a fixed rank constant.
Scores are compared as exact rationals or bounded fixed-point values; arbitrary
native floating addition is prohibited. Final ties use application primary
key.

An example logical query is:

```text
hybrid_search(
  fts(index = documents_fts, query = parsed_fts_query),
  knn(index = documents_embedding, vector = $query_vector),
  filter = json_get(metadata, /status) = "published",
  fusion = reciprocal_rank(text_weight = 3, vector_weight = 2, k = 60),
  order = fused_score desc, document_id asc,
  limit = 20
)
```

## 24. Virtual tables and registered modules

A SQLite virtual table is an implementation callback boundary, not inherently
safe or unsafe. Generic virtual-table creation is prohibited. Each registered
module declares:

```text
module and implementation digest
configuration grammar
logical relational schema
read and write effect set
external import set
storage and shadow-table ownership
transaction and rollback guarantees
ordering guarantees
numeric and collation dependencies
resource model
Dolt replay conformance corpus
```

A consensus module MUST be a pure function of its committed storage, query
arguments, signed context, and manifest. Modules backed by files, networks,
process state, device state, host clocks, or uncommitted entropy are
local-only.

Dolt system virtual tables are reducer-internal. Application IR cannot read
branch or working-state relations unless a future protocol explicitly exposes
canonical committed data.

## 25. Deterministic WASM extensions

Deterministic WASM is the preferred application extension mechanism for scalar
functions, aggregates, collations, tokenizers, validators, table functions,
and pure indexing kernels.

### 25.1 Module manifest

A module entry includes:

```text
module bytes digest
WASM proposal/features subset
Chronolog extension ABI identity and digest
exported function signatures and effect classes
allowed imports
maximum linear memory and table size
fuel schedule and maximum fuel
canonical trap mapping
numeric profile
bundled immutable data digests
```

### 25.2 Host imports

The portable host may expose only deterministic operations:

- bounded memory access;
- canonical value encode/decode;
- exact integer and decimal kernels;
- explicit transaction-context reads;
- bounded reads of declared database inputs supplied to the invocation; and
- domain-separated hashing.

Clock, random, filesystem, socket, environment, process, thread, dynamic
library, and nondeterministic scheduler imports are prohibited. Entropy is
obtained only by explicit labeled transaction-context input.

### 25.3 Execution

Execution is single-threaded unless a future profile specifies deterministic
parallel scheduling. Fuel exhaustion produces `SEMANTIC_RESOURCE_LIMIT` only
when every implementation uses the identical runtime and cost table.

Traps map to stable codes. Stack traces and engine messages are diagnostic and
not consensus data.

### 25.4 Stateful extensions

Portable WASM functions are pure by default. A stateful virtual relation or
index uses a Chronolog-managed ordinary storage namespace and declares its
logical mutations. Arbitrary direct page, file, or shadow-table access is not
part of the portable ABI.

## 26. Schema evolution in the replacement runtime

The SQL-first runtime starts with an empty application schema. Supported
`CREATE`, `ALTER`, and `DROP` statements are ordinary signed transaction body
statements and may be combined atomically with DML. Catalog expectations are
ordinary SQL preconditions. No schema digest, schema delta language, migration
runner, or special schema-change transaction remains.

## 27. Capabilities

The language distinguishes:

- data-reader capability;
- data-writer capability;
- schema-admin capability;
- extension-admin capability; and
- local diagnostic SQL capability.

Creating a view or ordinary index is schema administration. Registering native
or WASM code, tokenizer data, vector algorithms, collations, or numeric kernels
requires extension administration in addition to schema administration.

Validators MUST verify the required capability and execution profile before
attesting to inclusion. Validators do not evaluate application preconditions,
but they do reject malformed or unsupported IR and profile references.

## 28. Direct prototype implementation

The unreleased prototype's `TransactionCore` is edited directly to replace raw
SQL preconditions and statements. There is one transaction representation, no
dual decoder, no compatibility execution profile, and no stored-data migration.
The transaction body contains:

```text
execution manifest digest
schema digest
reserved transaction context
ordered precondition IR
ordered mutation IR
optional canonical renderer commitment
application metadata
```

Existing development databases, SSB feeds, serialized candidates, and fixtures
are recreated. An incompatible local database fails startup rather than being
translated.

The TypeScript client SHOULD offer a typed builder and MAY offer a textual
Chronolog SQL parser that produces the same IR. A parser is a convenience; its
canonical output, not source spelling, is signed.

## 29. Conformance suite

Every profile release MUST publish canonical fixtures for:

- IR encoding, decoding, rejection, and hashing;
- SQL rendering and exact parameter order;
- value boundaries, invalid UTF-8, decimal overflow, and float policy;
- three-valued logic, casts, collations, and constraint priority;
- scalar, ordered, multiset, and set results;
- ties, null placement, grouping, windows, limits, and recursive CTEs;
- mutation conflicts, expected row counts, returning, and rules;
- transaction timestamp and labeled entropy derivation;
- JSON parsing, canonicalization, paths, patches, duplicate keys, and indexes;
- FTS tokenization, matching, ranking, snippets, and rebuild;
- vector encoding, distance, KNN ties, filters, rollback, and replay;
- spatial behavior;
- WASM ABI, traps, fuel, and forbidden imports;
- streamed SQL DDL and extension/profile changes when enabled;
- crash recovery at every candidate and branch publication boundary; and
- replay equivalence across supported OS and architecture targets.

Required distributed properties include:

1. clean replay and checkpoint suffix replay of the same ordered set produce
   the same logical state and outcomes;
2. transaction validation arrival never changes an admitted transaction's
   ordering key;
3. a failed candidate leaves no application or derived-index changes;
4. rejected transactions remain visible to later log preconditions;
5. reconnect, restart, checkpoint restoration, and branch checkout do not
   change query or precondition semantics;
6. changing any manifest input fails startup or profile validation; and
7. local operational failure never becomes a canonical author rejection.

Conformance should be tested against both the DoltLite implementation and an
independent reference evaluator for core IR, JSON canonicalization, exact
numeric operations, and vector distance.

## 30. Illustrative transaction

The following TypeScript-shaped syntax is illustrative; wire field names and
builder APIs are defined separately.

```ts
const handle = await db.transaction(async (tx) => {
  const account = await tx.observe(
    query.from('accounts')
      .where(eq(col('id'), param(accountId)))
      .select({ balance: col('balance_cents') })
      .scalar(),
  )

  tx.requireRow(
    'accounts',
    { id: accountId },
    { balance_cents: account.balance },
  )

  tx.update(
    'accounts',
    { id: accountId },
    {
      balance_cents: sub(
        col('balance_cents'),
        int64(1_000),
      ),
      updated_at_ms: tx.timestamp(),
    },
    { affectedRows: exactly(1) },
  )

  tx.insert('audit_events', {
    id: uuidFrom(tx.entropy('audit-event-id', 0)),
    account_id: accountId,
    event: json.value({
      type: 'debit',
      amountCents: 1_000,
      timestampMs: tx.timestamp(),
    }),
  })
})
```

If a late predecessor changes the observed balance, `requireRow` fails during
suffix replay, the update and audit insert are absent, and the rejected
transaction remains in `chronolog_transactions` with its attributed
precondition ID.

## 31. References

- RFC 2119, Key words for use in RFCs to Indicate Requirement Levels
- RFC 8174, Ambiguity of Uppercase vs Lowercase in RFC 2119 Key Words
- RFC 8949, Concise Binary Object Representation (CBOR)
- RFC 5869, HMAC-based Extract-and-Expand Key Derivation Function (HKDF)
- RFC 8259, The JavaScript Object Notation (JSON) Data Interchange Format
- RFC 6901, JavaScript Object Notation (JSON) Pointer
- RFC 6902, JavaScript Object Notation (JSON) Patch
- RFC 7396, JSON Merge Patch
- SQLite deterministic functions: <https://www.sqlite.org/deterministic.html>
- SQLite JSON and JSONB: <https://www.sqlite.org/json1.html>
- SQLite views: <https://www.sqlite.org/lang_createview.html>
- SQLite generated columns: <https://www.sqlite.org/gencol.html>
- SQLite triggers: <https://www.sqlite.org/lang_createtrigger.html>
- SQLite virtual tables: <https://www.sqlite.org/vtab.html>
- SQLite FTS5: <https://www.sqlite.org/fts5.html>
- SQLite floating point: <https://www.sqlite.org/floatingpoint.html>
- SQLite query planner stability guarantee:
  <https://www.sqlite.org/queryplanner-ng.html>
- sqlite-vec: <https://github.com/asg017/sqlite-vec>
