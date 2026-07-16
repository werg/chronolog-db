# Deterministic SQLite-Compatible SQL Transactions

Status: normative implementation target for the next unreleased prototype

This specification replaces the current schema-manifest and canonical
relational-IR transaction design with signed SQL source interpreted by the
Chronolog deterministic SQL compiler. It is a direct prototype cutover. Where
this document conflicts with the existing SQL dialect or implementation
specifications, this document is authoritative.

Chronolog has no deployed protocol, persistent user data, or compatibility
obligation. The implementation SHALL be edited in place. No legacy decoder,
schema migration, compatibility profile, dual RPC method, or database upgrade
path may be introduced.

The key words **MUST**, **MUST NOT**, **REQUIRED**, **SHALL**, **SHALL NOT**,
**SHOULD**, **SHOULD NOT**, **RECOMMENDED**, **NOT RECOMMENDED**, **MAY**, and
**OPTIONAL** in this document are to be interpreted as described by BCP 14
when, and only when, they appear in all capitals.

## 1. Decision summary

Chronolog SHALL expose two deliberately separate SQL paths:

1. **Replicated transaction SQL** is signed, ordered, replayed, and executed
   through the Chronolog deterministic SQLite-compatible dialect.
2. **Local query SQL** is read-only SQLite SQL executed against an immutable
   local materialized revision. It is not consensus input and need not be
   replay-deterministic.

Replicated transactions SHALL contain exact SQL source, canonical typed
bindings, explicit precondition expectations, and signed transaction context.
They SHALL NOT contain a serialized public command taxonomy such as
`CreateTableCommand`, `UpdateCommand`, or `DropIndexCommand`.

The Chronolog compiler MAY and normally will parse SQL into an internal
abstract syntax tree or logical plan containing such classifications. That
representation is private compiler state. It is neither signed nor part of the
application API.

Schema definition is ordinary replicated SQL:

- `CREATE`, `ALTER`, and `DROP` statements travel through the same transaction
  stream as `INSERT`, `UPDATE`, and `DELETE`;
- DDL and DML may appear together in one ordered SQL body;
- the application schema at any ordered prefix is the schema materialized by
  the accepted transaction prefix;
- schema assumptions are ordinary SQL preconditions over SQLite catalog data;
- there is no authoritative schema manifest, global schema digest,
  schema-change event type, migration runner, or special schema transaction;
  and
- in this prototype, every admitted writer may execute supported DDL. The
  fine-grained database-native policy language is deferred.

The SQLite authorizer is REQUIRED as defense in depth but is explicitly
insufficient as the deterministic language validator. Perfect replay
determinism is established by the complete compiler, execution profile,
controlled runtime, canonical values/results, and conformance suite.

## 2. Goals

The implementation SHALL satisfy all of the following goals.

### 2.1 Determinism

For an execution profile `P`, ordered prefix database `S`, and signed
transaction `T`, reduction is a pure operation:

```text
reduce(P, S, T) -> (S', outcome)
```

Every conforming replica with identical inputs MUST derive identical:

- precondition outcomes;
- statement effects;
- application and schema state;
- constraint, trigger, and generated-value behavior;
- canonical returned values and result digests;
- accepted or rejected outcome;
- stable failure attribution; and
- protected transaction-log row.

### 2.2 SQLite compatibility

The Chronolog consensus dialect SHALL use SQLite lexical rules, identifier
rules, parameter syntax, statement syntax, catalog model, type behavior, and
SQL semantics as its baseline.

A SQLite feature MUST NOT be removed merely because it is complex, difficult
to type statically, or absent from the current compiler. A feature may be
rejected from consensus execution only when at least one of the following is
true:

1. it consumes ambient or external state that has no deterministic substitute;
2. it escapes the candidate's atomic database transaction;
3. its result or side effects are not reproducible under the selected profile;
4. it can mutate protected Chronolog state;
5. it cannot be bounded by deterministic semantic limits; or
6. it has not yet passed the conformance gates required to establish the
   preceding properties.

An implementation gap is not a language-design justification. Temporarily
gated syntax MUST be recorded as unimplemented, with the missing conformance
work identified. Documentation MUST NOT claim that it is intrinsically
nondeterministic without evidence.

### 2.3 Minimal special machinery

Chronolog-specific behavior SHALL exist only where replication requires it:

- signed transaction context;
- explicit preconditions and expected results;
- deterministic time and entropy;
- protected transaction-log access;
- stable error attribution;
- deterministic resource accounting; and
- execution-profile pinning.

Schema definition, indexes, views, triggers, constraints, defaults, generated
columns, and ordinary data mutations SHALL otherwise use SQLite SQL.

### 2.4 Clean prototype cutover

The final tree SHALL contain one transaction representation and one consensus
execution path. Existing databases, feeds, snapshots, fixtures, generated
bindings, and protocol bytes SHALL be recreated.

## 3. Non-goals

This specification does not provide:

- compatibility with any current unreleased Chronolog transaction bytes;
- migration of a database created from `schema.cbor`;
- a general-purpose distributed SQL session;
- cross-transaction connection-local state;
- arbitrary host, filesystem, network, or extension access;
- a promise that every SQLite build or extension is portable;
- schema-administrator or statement-level capability enforcement; or
- SQL-standard syntax that SQLite itself does not accept, unless a future
  profile explicitly adds and lowers that syntax.

The dialect is maximally SQLite-compatible. It does not claim complete ISO SQL
conformance.

## 4. Language surfaces

### 4.1 Replicated transaction surface

The replicated surface accepts Chronolog deterministic SQL. It includes:

- read-only precondition statements;
- DML;
- DDL;
- deterministic catalog reads;
- deterministic triggers, views, defaults, generated columns, and indexes;
- registered deterministic scalar, aggregate, window, and virtual-table
  features; and
- Chronolog context and assertion functions where SQLite has no equivalent.

The SQL source and its canonical bindings are signed and replayed exactly.

### 4.2 Local query surface

The local surface accepts broad read-only SQLite syntax against a pinned,
immutable published revision. It MAY expose ambient presentation behavior such
as `datetime('now')`, `random()`, locally available JSON functions, math
functions, aggregates, and windows.

Local SQL:

- MUST be enforced as read-only;
- MUST NOT attach databases, load extensions, mutate pragmas, or call Dolt
  control functions;
- MUST remain bounded by local statement, step, row, and byte limits;
- MUST be labeled `consensusSafe: false` at RPC boundaries;
- MUST NOT be copied into a signed precondition without being reparsed and
  validated by the consensus compiler; and
- MAY produce results that vary across time or nodes.

### 4.3 Transaction observations

The transaction builder SHALL offer a deterministic observation path distinct
from local querying. An observation:

1. uses Chronolog deterministic SQL;
2. executes at the draft's pinned materialized revision;
3. canonicalizes its result under a declared result mode; and
4. becomes, or can directly produce, a signed expectation precondition.

This is the only query path whose result may be promoted automatically into a
transaction precondition.

## 5. Component architecture

```text
                         local query
application ------------------------------------------+
    |                                                  |
    | transaction SQL                                 v
    v                                      immutable local reader
canonical transaction encoder                         |
    |                                      read-only SQLite profile
    v                                                  |
signed/replicated SQL                                  v
    |                                      non-consensus result
    v
Chronolog SQL parser
    |
    v
internal semantic AST / logical plan
    |
    +--> catalog resolution and type analysis
    +--> effect and protected-object analysis
    +--> determinism analysis
    +--> ordering and result-mode analysis
    +--> semantic resource planning
    +--> stable error attribution
    |
    v
pinned SQLite/DoltLite preparation
    |
    +--> native authorizer backstop
    +--> deterministic function/context registry
    +--> progress and result budgets
    |
    v
candidate transaction/savepoint
    |
    v
accepted/rejected log + checkpoint/replay
```

## 6. Transaction representation

### 6.1 Transaction core

The unreleased `TransactionCore` SHALL be edited directly. Its application
program portion SHALL have the following logical shape:

```ts
interface SqlTransactionProgram {
  readonly version: 1
  readonly preconditions: readonly SqlPrecondition[]
  readonly body: readonly SqlStatement[]
}

interface SqlStatement {
  readonly sql: string
  readonly bindings: readonly SqlBinding[]
}

interface SqlBinding {
  readonly parameter:
    | { readonly kind: 'index'; readonly index: number }
    | { readonly kind: 'name'; readonly name: string }
  readonly value: SqlBindingValue
}

type SqlBindingValue =
  | LogicalValue
  | { readonly kind: 'real'; readonly bits: Uint8Array }

interface SqlPrecondition {
  readonly id: number
  readonly query: SqlStatement
  readonly resultMode: 'scalar' | 'ordered' | 'multiset' | 'set'
  readonly expectation:
    | { readonly kind: 'assert_true' }
    | { readonly kind: 'inline'; readonly result: CanonicalSqlResult }
    | { readonly kind: 'digest'; readonly digest: Uint8Array }
  readonly label?: string
}
```

This shape is normative at the semantic level. The canonical CBOR field
numbers are assigned in the protocol codec and MUST have golden fixtures.

The surrounding transaction core continues to commit to group identity,
membership revision, validation policy, author identity, author timestamp,
transaction nonce, execution-manifest digest, and optional application
metadata. It SHALL NOT contain a schema digest.

### 6.2 Exact SQL source

SQL source SHALL be encoded as canonical CBOR text and therefore MUST be valid
UTF-8. Each signed `SqlStatement.sql` entry:

- MUST NOT contain U+0000;
- MUST satisfy the execution profile's byte limit;
- MUST be signed exactly as authored;
- MUST NOT undergo Unicode normalization, keyword case normalization,
  whitespace normalization, comment removal, or pretty-printing; and
- MUST contain exactly one SQLite statement, with optional surrounding comments
  and whitespace.

Different whitespace or comments produce different transaction bytes and IDs.
That is intentional and has no semantic consequence.

The pinned parser MUST confirm that the entry contains one statement and that
the preparation tail contains trivia only. Trigger bodies and other grammar
that contains internal semicolons remain one statement. Implementations MUST
NOT identify statement boundaries by splitting on semicolons or slice
JavaScript strings using native UTF-8 byte offsets.

The signed protocol has no multi-statement source alternative. A client-side
script convenience MAY use the pinned parser to turn one authored script into
an ordered `SqlStatement[]`, but that list is the only representation that is
reviewed, signed, transmitted, and replayed.

### 6.3 Bindings

The dialect SHALL preserve SQLite parameter spellings: `?`, `?NNN`, `:name`,
`@name`, and `$name`.

A named binding uses the exact parameter token reported by
`sqlite3_bind_parameter_name()`, including its leading `:`, `@`, or `$` and any
SQLite-permitted suffix syntax. Client conveniences MAY accept bare names but
must resolve them to this exact representation before signing.

Bindings are scoped to their containing `SqlStatement`. Parameter numbering
and aliasing within that statement follow SQLite exactly.

The compiler MUST reject:

- a binding for a nonexistent parameter;
- conflicting values for aliases of the same SQLite parameter index;
- an unbound referenced parameter;
- duplicate bindings that do not encode the identical canonical binding value; and
- values that cannot be represented under the active value profile.

Bindings carry canonical values, not JavaScript or native SQLite values.
Logical values retain their existing canonical encoding. A storage REAL uses
the reserved binding tuple `[11, ieee754_binary64_be_8]`; only finite binary64
bits are accepted and negative zero is preserved. Lowering to SQLite storage
values is part of the execution profile.

### 6.4 Preconditions

Every transaction MUST contain at least one precondition. Each precondition
query MUST contain exactly one read-only SQL statement.

Preconditions execute in signed array order against the ordered database prefix
and before any body statement. The first failure stops evaluation and records
its precondition ID, array index, optional label, and stable error code.

`assert_true` requires a scalar result containing exactly one non-null true
value under Chronolog Boolean coercion. False, null, no row, multiple rows, or
multiple columns fail deterministically.

Inline and digest expectations compare canonical results under the declared
result mode.

### 6.5 Body

The body is a nonempty ordered list of `SqlStatement` entries. It MAY combine
DDL, DML, and read statements in any order supported by the dialect.

The body MUST contain at least one effect-capable replicated statement, even if
its predicates or `IF EXISTS`/`IF NOT EXISTS` clause make its actual effect a
no-op at the ordered prefix. Read-only work belongs on the local query surface
unless it is a precondition or supports an effect-capable body.

Chronolog owns the outer candidate transaction. Transaction-control statements
inside the body are prohibited as specified in Section 10.

### 6.6 Statement identity and attribution

Body statements are numbered from zero in signed array order. The compiler
records for each statement:

- statement index;
- UTF-8 source spans within its statement entry;
- statement class in the internal AST;
- resolved read and write effects;
- canonical parameter mapping; and
- source context for diagnostics.

The transaction log SHALL record a failing statement index rather than a
caller-assigned command ID. Source spans and SQLite English messages are local
diagnostics and are not consensus data.

The canonical accepted-result envelope, result digest, protected storage, and
full precondition/statement/finalization attribution contract are specified in
`11-transaction-results-and-ordered-mutations.md`.

## 7. Determinism contract

### 7.1 Permitted inputs

Consensus execution may depend only on:

- the exact ordered-prefix database, including its application schema;
- the signed SQL source and canonical bindings;
- signed transaction context;
- authenticated transport identity fields explicitly admitted into that
  context;
- the exact execution manifest;
- deterministic registered code and immutable data named by that manifest;
  and
- fixed semantic limits named by that manifest.

### 7.2 Forbidden ambient inputs

Consensus execution MUST NOT depend on uncommitted:

- host time or timezone;
- host randomness;
- filesystem contents or paths;
- environment variables;
- process, thread, scheduler, or locale state;
- network services;
- connection history preceding the current candidate;
- local Dolt branch names, remotes, commits, or working-set state;
- dynamically loaded native code;
- host temporary-file visibility; or
- resource availability such as current free memory or disk space.

Operational exhaustion may abort local replay, but it MUST NOT be converted
into a canonical author rejection unless the same failure is defined by a
deterministic semantic budget.

### 7.3 Execution manifest

Every transaction continues to pin an execution-manifest digest. The manifest
MUST identify every semantic input, including:

- Chronolog dialect version and compiler digest;
- SQL parser identity and digest;
- SQLite and DoltLite source/build digests;
- compile options and required native configuration;
- database encoding, page, foreign-key, trigger, and planner configuration;
- query-planner stability policy;
- logical-value and storage-value profiles;
- integer, decimal, floating-point, text, JSON, and vector semantics;
- collation implementations and Unicode data versions;
- scalar, aggregate, window, and virtual-table registries;
- deterministic time and entropy semantics;
- trigger, foreign-key, conflict, and generated-column semantics;
- semantic resource limits;
- result canonicalization rules; and
- stable error mapping digest.

The manifest no longer contains or references an application schema digest.

## 8. SQLite compatibility policy

### 8.1 Grammar baseline

The accepted grammar SHALL track the pinned SQLite grammar. Chronolog SHOULD
reuse the SQLite parser or a mechanically synchronized grammar rather than
inventing alternate syntax for ordinary SQLite operations.

The SQL frontend MUST preserve SQLite behavior for:

- quoted and unquoted identifiers;
- comments and whitespace;
- common table expressions;
- `RETURNING`;
- conflict clauses and UPSERT;
- window and aggregate syntax;
- DDL, triggers, views, generated columns, and expression indexes;
- table options such as `STRICT` and `WITHOUT ROWID`;
- parameter numbering and names; and
- catalog and table-valued pragma queries.

Chronolog-specific syntax SHOULD be avoided when a deterministic function,
ordinary SQL expression, or transaction envelope field can express the same
operation.

### 8.2 Semantic compatibility ledger

The repository SHALL maintain a machine-readable feature ledger with one entry
for every SQLite statement family, expression family, built-in function,
pragma family, virtual-table module, and compile-time extension relevant to the
pinned build.

Each entry has one status:

```text
portable
profile_pinned
determinized
local_only
temporarily_gated
prohibited
```

Every `local_only`, `temporarily_gated`, or `prohibited` entry MUST state the
specific determinism, atomicity, external-effect, or missing-conformance
reason. Unknown new SQLite features fail closed until classified.

The current audited baseline is
[`docs/sqlite-compatibility-ledger.json`](../sqlite-compatibility-ledger.json).

### 8.3 No preference-based restrictions

The compiler MUST NOT require `STRICT`, `WITHOUT ROWID`, an explicit primary
key, a naming convention, or a Chronolog logical type merely as an architectural
preference. Such requirements are valid only where the active profile proves
they are necessary for deterministic semantics.

SQLite dynamic typing, rowid tables, autoincrement, affinities, defaults, and
ordinary collations SHALL remain available when their exact behavior is
reproducible under the profile.

## 9. SQL compiler

### 9.1 Authorizer insufficiency

`sqlite3_set_authorizer()` is a compile-time access-control interface. It
reports coarse actions such as reads, writes, function names, DDL classes, and
transaction control. It does not provide a complete semantic AST and normally
does not run during statement evaluation.

The authorizer alone cannot establish:

- whether function arguments make an otherwise conditional function ambient;
- stable row selection or result ordering;
- canonical aggregate, window, set, or multiset behavior;
- numeric and collation portability;
- deterministic trigger and cascade ordering;
- connection-state initialization;
- semantic resource accounting;
- stable constraint attribution; or
- whether a registered implementation actually satisfies its declared
  deterministic contract.

Consequently, authorizer approval MUST never be interpreted as proof of
determinism.

### 9.2 Compiler pipeline

The consensus compiler SHALL perform:

```text
exact one-statement SQL entry
    |
    v
UTF-8/source validation
    |
    v
SQLite-compatible parsing and tail validation
    |
    v
internal AST construction
    |
    v
catalog/name resolution at the ordered prefix
    |
    v
parameter and value analysis
    |
    v
effect and protected-object analysis
    |
    v
determinism and ambient-input analysis
    |
    v
ordering/result-mode analysis
    |
    v
resource plan and stable error plan
    |
    v
SQLite lowering/preparation
    |
    v
authorizer and runtime backstops
```

Structural parsing and profile-feature validation may occur before transaction
admission. Catalog-dependent resolution occurs during reduction against the
actual ordered prefix.

### 9.3 Internal AST

The compiler AST MAY classify statements, expressions, relations, effects,
and schema objects as needed for exhaustive implementation. It MUST NOT become
a second public transaction language.

No canonical encoding, hash domain, RPC representation, client builder API, or
stored transaction field may expose the internal AST.

### 9.4 Sequential compilation

Preconditions MUST be compiled and evaluated sequentially. This permits an
initial catalog expectation to fail cleanly before a later precondition is
compiled against a missing or incompatible object.

Body statements MUST also be prepared and executed sequentially. An accepted
DDL statement changes the schema against which following statements in the
same body are resolved.

After DDL, the implementation MUST:

- invalidate affected compiler and prepared-statement caches;
- refresh catalog state;
- retain the authorizer during any automatic SQLite reprepare; and
- ensure subsequent bindings still refer to their signed statement indices.

### 9.5 Parser and planner pinning

If the implementation uses SQLite itself as the parser, the native binding
MUST expose reliable UTF-8 statement-tail offsets and all metadata required for
bindings and diagnostics.

If Chronolog maintains a separate parser, its grammar and semantic version are
manifest inputs and its SQLite compatibility corpus is a release gate.

Query-planner stability configuration MUST be enabled where the profile relies
on stable plan selection. A stable planner does not replace semantic ordering
analysis: SQL whose logical result depends on an unspecified row choice still
requires canonicalization or compiler-derived ordering completion.

### 9.6 SQL stored by schema objects

DDL may store SQL that SQLite executes later, including view queries, trigger
bodies, generated-column expressions, defaults, check constraints, partial
index predicates, and expression-index expressions.

The compiler MUST parse and validate every such nested program when its schema
object is created or altered. Validation covers the complete transitive view
and trigger dependency graph and applies the same function, ambient-input,
effect, ordering, resource, and protected-object rules as an immediately
executed statement.

Schema-stored SQL MUST be revalidated when opened under an execution profile
and whenever SQLite reparses it. A protected compiler/profile identity records
which semantic profile validated the current schema. Direct edits through
`writable_schema` are prohibited.

An allowed outer statement does not make an unsafe trigger or view safe. The
authorizer's trigger/view source argument is checked as a backstop, while the
compiler remains responsible for semantic validation.

## 10. Statement and feature policy

### 10.1 Ordinary DML and DDL

The consensus dialect SHALL admit deterministic forms of:

- `SELECT` and `VALUES`;
- `INSERT`, `UPDATE`, `DELETE`, and UPSERT;
- `CREATE`, `ALTER`, and `DROP TABLE`;
- `CREATE` and `DROP INDEX`;
- `CREATE` and `DROP VIEW`;
- `CREATE` and `DROP TRIGGER`;
- generated columns, constraints, foreign keys, and conflict clauses;
- `REINDEX` when its collation and iteration semantics are pinned; and
- registered deterministic virtual tables and extension operations.

The compiler SHALL not route DDL through a separate reducer.

### 10.2 Transaction control

The following are prohibited in transaction SQL because Chronolog owns the
candidate boundary:

- `BEGIN` or `START TRANSACTION`;
- `COMMIT` or `END`;
- `ROLLBACK`;
- application-created `SAVEPOINT`, `RELEASE`, or `ROLLBACK TO`; and
- any statement that changes autocommit state.

This restriction is required for atomicity, not schema policy.

### 10.3 Database and process control

The following are prohibited from consensus SQL unless a future profile gives
them transactional, deterministic, replica-local semantics:

- `ATTACH` and `DETACH`;
- dynamic extension loading;
- `VACUUM` and statements that require leaving the current transaction;
- Dolt branch, remote, commit, merge, or working-set control;
- writable-schema mechanisms;
- filesystem-backed import/export; and
- process or connection administration.

### 10.4 Pragmas

Read-only deterministic pragma information MAY be used, including table-valued
pragma functions used for schema preconditions.

A pragma that changes connection state, planner behavior, storage behavior, or
constraint enforcement is prohibited from transaction SQL unless:

1. its setting is scoped entirely to the candidate;
2. it is restored before candidate completion;
3. it is committed by the execution profile; and
4. differential replay tests prove identical behavior.

Profile configuration belongs at database creation/startup, not in arbitrary
application transactions.

### 10.5 Temporary state

`TEMP` objects and temp-schema writes are local connection state and are not
part of a Dolt application checkpoint. They are local-only unless a future
profile gives them explicit deterministic lifetime and replay semantics.

### 10.6 Maintenance statements

Maintenance statements such as `ANALYZE`, `REINDEX`, and optimization pragmas
MUST be classified individually. They SHALL NOT be blanket-rejected merely for
being maintenance operations. If admitted, their stored state, planner effects,
ordering, and checkpoint behavior are consensus semantics and require
cross-replay tests.

## 11. Functions and ambient behavior

### 11.1 Function classes

Every callable function is classified as one of:

```text
pure_from_arguments
transaction_context
argument_conditional
candidate_connection_state
profile_pinned
external_or_ambient
```

- `pure_from_arguments` functions are portable when their numeric, text, and
  error semantics are fixed.
- `transaction_context` functions read only signed transaction fields.
- `argument_conditional` functions require AST and runtime-argument analysis.
- `candidate_connection_state` functions are allowed only after the candidate
  connection state is deterministically initialized.
- `profile_pinned` functions require a named implementation and conformance
  profile.
- `external_or_ambient` functions are prohibited unless determinized.

The authorizer function callback provides only a function name and is therefore
not sufficient for the argument-conditional classes.

### 11.2 Time

SQLite time syntax SHOULD be preserved. Uses of `CURRENT_TIME`,
`CURRENT_DATE`, `CURRENT_TIMESTAMP`, or date/time functions with `now` SHALL
read the signed transaction timestamp through a controlled SQLite time source,
not the host clock.

Timezone or `localtime` behavior requires immutable timezone rules identified
by the execution profile. Without such a profile, host-local timezone behavior
is prohibited while UTC behavior remains available.

### 11.3 Entropy

Host randomness is prohibited. The dialect SHALL retain random functionality
through deterministic entropy derived from the signed transaction nonce.

The entropy design MUST define results independently of optimizer-chosen
function invocation count. Acceptable designs include explicit labels and row
keys, compiler-assigned stable call-site identities, or another construction
with equivalent conformance evidence.

Raw SQLite `random()` and `randomblob()` MAY be admitted only if the profile
defines deterministic seeding, invocation identity, statement retry behavior,
and row-evaluation semantics. Until those properties are established, the
dialect SHALL offer an explicit deterministic entropy function rather than
silently removing random-value functionality.

### 11.4 Candidate connection state

Functions such as `changes()` and `last_insert_rowid()` are useful across an
ordered transaction body but depend on prior connection activity by default.
Before each candidate, the runtime SHALL initialize all exposed
connection-state values to specified constants.

Within the candidate, their values then evolve according to signed statement
order and pinned SQLite semantics. No state from a preceding candidate may be
visible.

### 11.5 Version and build functions

Functions such as `sqlite_version()` MAY be consensus-safe when the execution
manifest requires the exact same value on every participating node. They SHALL
not be rejected simply because they could change in a different profile.

### 11.6 Application-defined functions

`SQLITE_DETERMINISTIC` is a promise to SQLite and an optimizer hint; it is not
independent proof. Every consensus function implementation requires:

- immutable identity and code digest;
- fixed argument and result conventions;
- stable error mapping;
- bounded resource behavior;
- required innocuous/direct-only/subtype flags;
- cross-platform or exact-native classification; and
- positive and adversarial conformance fixtures.

## 12. Numeric, text, and value semantics

### 12.1 Canonical bindings

Signed bindings use Chronolog canonical binding values: the logical-value
profile plus finite exact-bit binary64 REAL. SQLite literals remain available,
but the compiler MUST define their exact parsing, range, affinity, and storage
behavior through the pinned SQLite profile.

### 12.2 Integers

Integer overflow, division, modulo, casts, affinity conversion, and aggregate
accumulation MUST have stable outcomes. Where native SQLite behavior is stable
under the pinned build it SHOULD be preserved. Where it is not portable, the
compiler SHALL lower to deterministic kernels or gate the feature to an
exact-native profile.

### 12.3 Floating point

Floating-point functionality MUST NOT be removed wholesale. Each operation is
classified as portable software-defined, exact-native profile, or temporarily
gated. NaN representation, signed zero, rounding, aggregate order, formatting,
and comparison behavior are explicit profile inputs.

### 12.4 Text and collations

Binary SQLite text behavior is portable when encoding and invalid-input rules
are fixed. Locale or Unicode-aware collations require immutable implementation
and data-version digests. Host locale is never consulted.

### 12.5 JSON, vectors, FTS, and other extensions

These features remain available through registered profiles. Their parser,
canonical value, indexing, ranking, tie-breaking, rebuild, rollback, and error
semantics are consensus-visible and require the existing deterministic-kernel
and native-extension conformance gates.

## 13. Ordering and result semantics

### 13.1 Database effects

Physical row visitation order MUST NOT change logical database effects. The
compiler must analyze constructs where row choice, conflict order, trigger
order, aggregate order, or window ties can affect stored state.

When SQLite syntax supplies an explicit order, the compiler preserves it and
adds hidden stable tie-breakers where totality is semantically required. When
syntax leaves row choice unspecified, Chronolog deterministically completes the
order from candidate keys or canonical relational values whenever this
preserves SQLite's logical semantics. It rejects only when no such completion
can be derived.

### 13.2 Precondition result modes

Preconditions declare one of four modes:

- `scalar`: exactly one column and zero or one row; zero rows canonicalize as
  explicit absence, distinct from one row containing `NULL`, while multiple
  rows are a shape error;
- `ordered`: row order is significant and is deterministically completed by
  the compiler after any authored terms;
- `multiset`: row order is ignored but duplicate counts are significant; or
- `set`: row order and duplicate multiplicity are ignored.

Canonical comparison orders values by their tagged canonical encodings, not by
host serialization, locale, or object iteration order.

### 13.3 Body results

Rows produced by `SELECT`, `RETURNING`, or read-only pragma statements in the
body SHALL be stepped and bounded. The transaction's result digest commits to
the ordered per-statement vector of:

- statement index and class;
- canonical returned-result digest, if any;
- logical affected-row count where defined; and
- stable statement outcome.

The RPC MAY expose selected returned rows, but replicas derive acceptance from
the same bounded execution rather than from client-provided results.

For result-producing body statements, the compiler assigns result semantics as
follows:

- an outer query with `ORDER BY` is `ordered` after compiler completion of any
  unresolved ties;
- a result with no semantically guaranteed order is canonicalized as a
  `multiset`;
- `DISTINCT` does not by itself make row order significant; and
- `RETURNING` is a `multiset` unless the dialect/profile provides an explicit
  deterministic ordering construct.

Physical SQLite row order MUST NOT enter the result digest when SQL does not
make that order semantically significant.

For the initial protocol, every SQLite DML `RETURNING` is framed as a
`multiset`. Mutation target-selection order does not imply returned-row order.
Any future authored ordered-returning construct requires a separate signed
dialect/version decision. The exact envelope and digest are defined by
Specification 11.

### 13.4 Assertions after writes

The dialect SHALL preserve affected-row and post-write assertion functionality
without adding a public command taxonomy. It MAY provide deterministic SQL
functions such as:

```sql
SELECT chronolog_assert(changes() = 1, 'expected one account update');
```

Such functions use normal SQLite call syntax, raise stable Chronolog rejection
codes, and are included in the function registry. Their semantics and source
attribution are pinned by the execution manifest.

## 14. Schema and DDL

### 14.1 No application genesis schema

A fresh Chronolog database SHALL initialize only protected reducer objects and
the fixed execution profile required to replay transactions. Its application
schema is empty.

The first application transaction may create tables, indexes, views, triggers,
and seed rows using ordinary SQL.

### 14.2 No authoritative schema manifest or digest

The following concepts are deleted:

- `schema.cbor`;
- `CHRONOLOG_SCHEMA_FILE`;
- `SchemaManifest` and `SchemaBuilder` as protocol, consensus, or bootstrap
  concepts;
- canonical schema encoding and `digestSchemaManifest`;
- `schemaDigest` in transactions, materializer calls, revisions, RPC, and
  generated bindings;
- startup comparison against a caller-supplied application schema; and
- special schema-change transactions.

The execution manifest remains because it commits execution semantics rather
than application structure.

### 14.3 Catalog source of truth

SQLite's transactional schema and catalog are the initial source of truth.
Schema preconditions SHOULD use ordinary SQLite interfaces such as:

- `sqlite_schema`;
- `pragma_table_xinfo(...)`;
- `pragma_index_list(...)`;
- `pragma_index_xinfo(...)`;
- `pragma_foreign_key_list(...)`; and
- other deterministic table-valued catalog pragmas.

Consensus preconditions may read these interfaces but may not write protected
SQLite or Chronolog catalog structures directly.

The authorizer profile for compiler-approved DDL MAY permit SQLite's implicit
internal catalog writes while denying any caller-authored statement that
targets `sqlite_schema`, `sqlite_master`, or protected Chronolog objects. The
compiler classification and authorizer action/source context must agree; a
mismatch fails closed.

Chronolog MUST NOT introduce a parallel application catalog preemptively. If a
deterministic extension requires logical metadata SQLite cannot represent,
that metadata:

1. must be minimal and feature-specific;
2. must live in protected ordinary database tables;
3. must be updated atomically by the same SQL transaction;
4. must be included in checkpoints and replay; and
5. must be derivable or verifiable from accepted transaction history.

### 14.4 Downstream schema tooling

There is no universal language-level schema-binding standard. Chronolog SHALL
therefore expose the ordinary SQLite catalog and introspection interfaces
rather than define a second public schema DSL. Existing database-first tools
may introspect a materialized SQLite-compatible revision and produce their own
TypeScript types, query-builder interfaces, editor metadata, documentation, or
migration plans.

A `SchemaManifest` MAY exist only as a downstream tooling artifact. Such an
artifact MUST:

- be generated by introspecting one identified immutable materialized
  revision under one execution profile;
- be reproducible and disposable rather than supplied as database authority;
- identify its source revision and catalog/profile identity so stale tooling
  can be detected;
- never be signed into a transaction, admitted by validators, required for
  replay, used to initialize application schema, or consulted by consensus
  execution; and
- use any content hash only as a namespaced local cache key, never as a global
  application `schemaDigest`.

Chronolog-owned tooling SHOULD emit conventional database metadata or adapters
for established SQL builders before inventing a Chronolog-specific generated
client. Lossy tools MUST report unsupported SQLite objects instead of silently
becoming authoritative.

Schema migrations are ordinary Chronolog transactions containing SQLite DDL,
mandatory catalog/data preconditions, and any associated data changes. An
external migration tool MAY generate or organize the SQL. Applying that SQL
still goes through the Chronolog transaction path; Chronolog SHALL NOT add a
second migration protocol or treat an external migration ledger as schema
authority. If an application chooses to maintain such a ledger, it is ordinary
application data updated in the same transaction.

### 14.5 Minimal schema dependencies

Transactions state only the schema assumptions they need. For example:

```sql
SELECT name, type, "notnull", dflt_value, pk
  FROM pragma_table_xinfo('accounts')
 WHERE name IN ('id', 'balance')
 ORDER BY cid;
```

An exact expectation over this query depends on those columns without pinning
unrelated tables, indexes, or views.

Client tooling MAY derive a minimal dependency query from parsed transaction
SQL. The derived dependency becomes an explicit, reviewable signed SQL
precondition. No compiler or node may inject a hidden schema dependency after
the transaction is signed.

### 14.6 Atomic DDL

DDL executes in the same candidate savepoint as DML and the accepted protected
log row. On deterministic rejection, every schema, catalog, trigger, index, and
data change is rolled back before the rejected log row is written.

SQLite-native transactional DDL SHOULD be used directly. If a future dialect
feature requires compiler lowering to a table rebuild, the lowering is an
internal implementation plan and MUST preserve:

- SQLite-visible schema semantics;
- deterministic row and index reconstruction;
- foreign-key and trigger behavior;
- rollback and checkpoint behavior; and
- statement-level failure attribution.

### 14.7 Late schema predecessors

If a late admitted transaction inserts DDL before already materialized
transactions, suffix replay restores a prefix checkpoint and re-executes every
later transaction against the new schema.

A later transaction may consequently change from accepted to rejected or vice
versa. Its explicit schema and data preconditions, followed by ordinary SQL
compilation, determine the new outcome. There is no out-of-band migration
coordination.

## 15. Authorizer and native backstops

### 15.1 Consensus modes

The runtime SHALL install explicit authorization modes at least equivalent to:

```text
internal_bootstrap
consensus_precondition
consensus_body
local_read
derived_maintenance
```

The compiler determines language validity. The authorizer independently
enforces protected-object and effect boundaries.

### 15.2 Installation lifetime

The authorizer MUST remain installed during both prepare and step because
SQLite may automatically reprepare a statement after a schema change.

Unknown future authorizer action codes fail closed in consensus modes.

### 15.3 Defense-in-depth checks

In addition to the authorizer, the runtime SHALL use as applicable:

- `sqlite3_stmt_readonly()` for preconditions and local queries;
- total-change counters around read-only operations;
- `sqlite3_limit()` values;
- deterministic progress-handler budgets;
- database-size/page limits;
- defensive and trusted-schema configuration;
- disabled dynamic extension loading;
- zero attached-database allowance;
- query-planner stability configuration;
- fixed worker-thread configuration; and
- prepared-statement tail validation.

None of these replaces semantic compilation.

## 16. Candidate execution

### 16.1 Admission

Before validator attestation, a candidate SHALL be checked for:

- canonical protocol encoding;
- exact SQL UTF-8 and size validity;
- successful profile parser recognition;
- structurally valid bindings and expectations;
- prohibited transaction/process-control syntax;
- supported execution-manifest identity; and
- writer authorization under the current coarse write capability.

This version does not distinguish DDL authority from DML authority.

Validators do not execute application preconditions or require the latest
materialized application schema. Catalog-dependent errors are derived by the
reducer at the candidate's ordered prefix.

### 16.2 Reduction algorithm

For each candidate in ordered replay:

1. Select the exact prefix state and execution profile.
2. Begin the candidate's top-level SQLite transaction or equivalent isolated
   outer transaction.
3. Establish an application savepoint that excludes protected rejection-log
   persistence when required by DoltLite branch behavior.
4. Reset candidate connection state, deterministic time, and entropy context.
5. For each precondition in signed order:
   1. parse/resolve/compile it against the current prefix catalog;
   2. install the consensus-precondition authorizer;
   3. bind canonical values and transaction context;
   4. execute under semantic budgets;
   5. canonicalize the declared result mode; and
   6. stop at the first failed expectation.
6. Iterate the signed body list in array order, parsing each entry as exactly
   one statement.
7. For each body statement:
   1. resolve and validate it against the current in-transaction catalog;
   2. build its deterministic effect/error/resource plan;
   3. prepare it under the consensus-body authorizer;
   4. bind its canonical values;
   5. execute and step all results under limits;
   6. record its canonical effect/result summary; and
   7. refresh catalog and caches if it changed schema.
8. Compute the accepted transaction result digest.
9. Insert the accepted protected transaction-log row.
10. Release the application savepoint and commit the candidate transaction.

On deterministic rejection:

1. roll back every application, schema, catalog, trigger, index, and extension
   effect of the candidate;
2. retain or begin the protected outer transaction as required;
3. insert only the rejected transaction-log row with stable attribution; and
4. commit that row atomically.

On operational or unknown failure, abort local replay without deriving a
canonical transaction outcome.

### 16.3 Transaction log visibility

During candidate evaluation, the protected transaction log contains exactly
the preceding ordered prefix. It excludes the current and later transactions.

Rejected transactions remain visible to later preconditions. Application SQL
may read the public transaction-log relation but may never mutate it.

## 17. Error model

### 17.1 Error classes

Errors are divided into:

1. **Invalid candidate**: malformed encoding, invalid SQL source, structurally
   invalid bindings, prohibited profile, or unsupported syntax known before
   admission. It is not admitted to the ordered reducer.
2. **Rejected precondition**: a signed expectation fails at its ordered prefix.
3. **Rejected execution**: a body statement encounters a deterministic compile
   or execution failure at its ordered prefix.
4. **Operational failure**: local I/O, memory, corruption, busy/lock, native
   crash, or other environmental failure. It produces no canonical outcome.

### 17.2 Stable attribution

A canonical rejection records:

- stable rejection code;
- failing precondition ID and index, if applicable;
- failing body statement index, if applicable;
- constraint or trigger identity where deterministically available;
- result/effect digest accumulated before rejection only when specified; and
- no SQLite English error message.

Source byte spans and native messages may be retained in local diagnostics.

Deferred/final candidate failures MUST be attributed to a distinct finalization
phase rather than guessed to have been caused by the last body statement. See
Specification 11 for the canonical attribution fields and priority rules.

### 17.3 SQLite error mapping

Primary and extended SQLite result codes are inputs to a manifest-pinned error
mapper. English messages are not parsed for consensus.

Where SQLite exposes insufficient identity for stable simultaneous-error
selection, the compiler performs deterministic prechecks or postchecks. The
authorizer cannot provide this attribution.

### 17.4 Resource errors

A semantic budget failure is canonical only when every conforming
implementation charges the same units and reaches the same limit for the same
program. Native out-of-memory, host timeout, disk-full, or implementation-only
interrupts are operational.

## 18. Local query API

### 18.1 Client contract

The primary client distinction SHALL be visible in method names and types:

```ts
const rows = await db.query(sql, bindings)

const handle = await db.transaction(async (tx) => {
  const observed = await tx.observe(sql, bindings, { resultMode: 'ordered' })
  tx.expect(observed)
  tx.exec(statementSql, statementBindings)
  tx.exec(compiledStatement)
})
```

`db.query` is local read-only SQLite. `tx.observe`, `tx.expect`, and `tx.exec`
use the deterministic consensus dialect.

### 18.2 Read-only enforcement

Local queries execute on an immutable published reader. They MUST be rejected
if SQLite or the authorizer identifies any database, schema, pragma, virtual
table, or external side effect.

### 18.3 Reactive queries

Reactive local queries MAY be rerun whenever the published materialized
revision changes. Schema changes may cause a local SQLite prepare error or a
reset event. No global schema digest is needed; the materialized revision and
query outcome are sufficient.

### 18.4 Promotion prohibition

The client MUST NOT treat a prior `db.query` result as a deterministic
observation automatically. A user may manually use its values as signed input,
but concurrency/replay protection requires a deterministic precondition that
is independently executed at the transaction's pinned revision.

## 19. Client transaction workflow

### 19.1 Draft creation

A draft pins:

- group and author context;
- membership and validation policy revisions;
- materialized event-set revision;
- execution-manifest digest;
- author timestamp; and
- transaction nonce.

It does not pin a schema digest.

### 19.2 Observation and expectation

`tx.observe` executes one deterministic read statement at the pinned revision
and returns canonical columns, values, result mode, result digest, and exact
SQL/binding provenance.

`tx.expect(observation)` embeds that SQL and expected result into the signed
precondition list. Rebase reruns observations at one new immutable revision and
updates expectations atomically.

### 19.3 Body construction

The client SHALL permit arbitrary supported statement combinations by appending
one or more exact statements to the ordered body. Its minimum interoperability
surface accepts the conventional compiled-statement shape:

```ts
interface CompiledSqlStatement {
  readonly sql: string
  readonly parameters?:
    | readonly ClientSqlValue[]
    | Readonly<Record<string, ClientSqlValue>>
}
```

`tx.exec(sql, bindings)`, `tx.exec(compiledStatement)`, and
`tx.exec([statement1, statement2, ...])` are client conveniences over the same
signed `SqlStatement[]`. This permits existing SQL builders to integrate by
adapting their compiled `{ sql, parameters }` output; it does not require a
Chronolog query DSL.

Typed client helpers MAY parse SQL, infer result types, generate bindings, and
derive schema-dependency preconditions. They remain conveniences over the same
signed SQL representation.

A client MAY additionally offer `tx.execScript(script, bindings)` for authored
migration files or pasteable SQL. It MUST split the script with the pinned SQL
parser, not with semicolon heuristics, scope bindings to each resulting
statement, and expose the final ordered statement list for review before
signing. This is a client-only normalization step, not another protocol form.

A convenience binding object such as `{ id: 1n }` may target every matching
named parameter in a script or appended statement list. Before signing, the
client expands it into the exact statement-local `SqlBinding` records defined
in Section 6.3 and displays a diagnostic for conflicting or unused values.

### 19.4 Publication

Before signing, the node recompiles the complete draft using the pinned
revision and profile. Publication fails locally if the draft is structurally
invalid or uses unsupported dialect features. Prefix-dependent failure after a
late insertion remains a normal replay-derived rejection.

## 20. RPC changes

The RPC surface SHALL be edited directly to provide:

- local read-only SQL query and live-query methods;
- draft creation at a pinned revision;
- deterministic SQL observation;
- precondition addition using SQL plus expectations;
- ordered exact SQL statement and canonical binding replacement/addition;
- draft validation and rebase;
- publication and outcome streams; and
- deterministic compiler diagnostics with source spans.

IR-specific mutation/query payloads and global schema-digest fields SHALL be
deleted. There is no dual SQL/IR transaction RPC.

RPC limits apply to SQL bytes, statement count, binding count/bytes,
precondition count, result bytes, and draft lifetime.

Accepted outcome streams carry a bounded result reference; complete canonical
body results are fetched through the revision-stamped result RPC defined by
Specification 11. They are not reconstructed by reexecuting a mutation.

## 21. Materialization, checkpoints, and replay

### 21.1 Checkpoint contents

A checkpoint contains the complete ordinary database prefix, including:

- application tables and rows;
- SQLite application schema;
- indexes, views, and triggers;
- registered deterministic derived state;
- protected transaction-log prefix; and
- execution-profile metadata.

No external schema artifact is required to restore it.

### 21.2 Replay base

The materializer invocation SHALL remove schema-manifest artifacts and expected
schema digests. Its replay base database already contains the correct schema at
the selected prefix.

The invocation continues to commit expected engine/execution-manifest identity,
previous and target order digests, replay index, exact admitted suffix, and
immutable input/output references.

### 21.3 Replay equivalence

For the same admitted order and execution profile:

- clean replay from empty application schema;
- full replay from the genesis checkpoint;
- suffix replay from every retained checkpoint; and
- reopen/replay after process restart

MUST produce identical logical schema, application data, protected log,
transaction outcomes, result digests, and published state identity as defined
by the materializer contract.

## 22. Security boundary

Consensus determinism and SQL sandboxing are related but distinct.

The compiler establishes allowed semantics. The authorizer and native
configuration prevent compiler bugs or SQLite reprepare behavior from crossing
protected boundaries. Neither layer may be omitted.

Required protections include:

- reserved reducer namespace enforcement;
- immutable/read-only query connections;
- no dynamic extension loading;
- controlled registered functions and modules;
- no attachment or external database access;
- bounded SQL, VM work, recursion, rows, result bytes, and database growth;
- defensive SQLite configuration;
- exact native build measurement;
- authorizer coverage during prepare and reprepare; and
- negative tests for views, triggers, virtual tables, aliases, quoted names,
  and schema changes that attempt to bypass restrictions.

## 23. Capability boundary

This prototype uses the existing coarse writer authorization for the entire
deterministic SQL body. A writer may execute DML and DDL. This intentionally
creates one even-plane application-write authority while the deterministic SQL
and transactional-schema foundation is completed. It is not the intended final
application authorization model and does not weaken protected Chronolog
objects, execution-profile checks, or the SQL sandbox.

The compiler SHALL nevertheless emit a complete, deterministic effect summary
for each statement and transaction.

The planned capability system is database-native and transactional, analogous
in goal to PostgreSQL row-level security rather than to an out-of-band RPC
permission envelope. Its policy definitions and policy state SHALL live inside
the replicated database, be evaluated deterministically against the same
ordered prefix as the transaction, and be included in atomic commit, replay,
and checkpoints. It is expected to authorize row, table, schema, and statement
effects using the compiler's effect summary.

The exact policy SQL, ownership/delegation rules, bootstrap rules, and
PostgreSQL compatibility subset are deferred to the capability specification.
That work may authorize the existing effects without changing:

- transaction SQL source;
- transaction encoding;
- schema representation;
- replay semantics; or
- DDL execution machinery.

No temporary schema-admin capability layer, manifest permission field, or
out-of-band schema policy shall be added in this version. Membership-level
writer admission remains mandatory, as do transaction preconditions.

## 24. Conformance requirements

### 24.1 SQLite syntax compatibility

The suite SHALL contain positive parsing/execution fixtures for every supported
SQLite grammar family and negative fixtures only for documented profile
restrictions.

Compatibility testing MUST cover:

- identifier quoting and Unicode;
- comments/trivia and ordered statement lists, including trigger bodies with
  internal semicolons;
- all parameter forms;
- CTEs, compounds, aggregates, and windows;
- DML conflict forms and `RETURNING`;
- tables, indexes, views, triggers, generated columns, and constraints;
- `STRICT`, rowid, `WITHOUT ROWID`, and autoincrement tables;
- catalog and table-valued pragma reads; and
- supported extension syntax.

### 24.2 Determinism matrix

Every admitted function and statement feature requires fixtures for:

- clean versus suffix replay;
- prepared cache hit versus miss;
- schema-triggered automatic reprepare;
- index present versus absent when logical semantics should match;
- restart and reopened database;
- supported OS and architecture targets;
- boundary values and stable errors; and
- resource limit immediately below, at, and above the limit.

### 24.3 Authorizer insufficiency tests

Tests SHALL demonstrate cases where authorizer action approval alone would be
insufficient, including:

- argument-dependent date/time functions;
- connection-state functions;
- unordered `LIMIT` or window ties;
- ambient or incorrectly labeled application functions;
- floating-point aggregate order;
- triggers or views containing prohibited effects;
- schema changes followed by automatic reprepare; and
- deterministic versus operational resource failure.

These tests prevent future simplification from accidentally treating the
authorizer as the dialect validator.

### 24.4 DDL and replay tests

Required scenarios include:

1. The first streamed transaction creates and seeds the application schema.
2. DDL and DML in one body commit atomically.
3. A later failing statement rolls back preceding DDL and DML.
4. A failed precondition leaves the schema unchanged.
5. Create/drop/alter/index/view/trigger operations survive checkpoint and
   reopen.
6. A late predecessor DDL transaction changes a later transaction from accepted
   to rejected.
7. A late predecessor changes a later rejected transaction to accepted.
8. An unrelated schema change does not fail a minimally scoped catalog
   expectation.
9. Schema changes invalidate and reprepare following statements safely.
10. Replicas derive identical schema catalog rows and transaction logs.

### 24.5 Local/consensus separation tests

Tests SHALL prove that:

- local queries may use broader read-only SQLite functions;
- the same ambient construct is rejected or determinized in consensus mode;
- local SQL cannot write through direct statements, views, triggers, virtual
  tables, pragmas, or Dolt functions;
- local results cannot be promoted implicitly to expectations; and
- transaction observations always use the consensus compiler.

### 24.6 Distributed properties

At minimum:

1. all delivery permutations producing the same admitted set converge;
2. every candidate is atomic across data, DDL, derived state, and log row;
3. rejected candidates have no application or schema effects;
4. operational failures never become canonical rejections;
5. checkpoint selection changes performance only, never results;
6. compiler/parser/cache choices do not change consensus results; and
7. execution-profile mismatch prevents validation/materialization rather than
   producing divergent state.

## 25. Repository cutover

### 25.1 Delete

The cutover SHALL delete, rather than deprecate:

- `SchemaBuilder`, the current authoritative `SchemaManifest` representation,
  its protocol tags/codecs/digests, and schema seed-row machinery;
- `compileSchema()` as application genesis compilation;
- static `Catalog.fromManifest()` transaction compilation;
- `schema.cbor` creation/loading and `CHRONOLOG_SCHEMA_FILE`;
- `schemaDigest` and `canonicalSchema` fields throughout the protocol,
  materializer, workerd runtime, node, RPC, client, codegen, and tests;
- the `chronolog-accepted-result-v1` digest framing and protected-log shape;
- canonical query/mutation IR from the signed transaction representation;
- IR-only draft RPC methods and generated global schema bindings treated as
  protocol or consensus state; and
- documentation describing special future schema-change transactions.

Logical-value codecs, canonical results, deterministic kernels, compiler data
structures, and query builders MAY be retained where they serve the SQL
compiler or client conveniences. They SHALL no longer constitute a second
signed application language.

### 25.2 Add or refactor

The implementation requires:

- canonical SQL transaction protocol types/codecs;
- SQLite-compatible parser integration and internal semantic AST;
- statement/binding/source-span handling;
- deterministic function and feature ledger;
- dynamic prefix-catalog resolution;
- DDL-capable sequential candidate execution;
- deterministic and local-read SQL profiles;
- SQL observation/expectation/body RPC methods;
- SQL-first transaction client APIs;
- local SQLite query and live-query APIs;
- revision-stamped SQLite catalog introspection plus optional downstream
  `SchemaManifest`, type-generation, and established query-builder adapters;
- updated differential, chaos, and end-to-end workloads using streamed DDL.

### 25.3 No compatibility work

There SHALL be:

- no old transaction decoder;
- no schema file importer;
- no compatibility migration for current prototype database files;
- no feed or snapshot translation;
- no deprecated IR RPC aliases;
- no old/new execution profile switch; and
- no tests asserting compatibility with current prototype bytes.

Intermediate refactor commits may be broken. The completed branch must contain
one clean path and should be squashed or organized for review without runtime
compatibility scaffolding.

## 26. Completion criteria

The implementation is complete when all of the following are true:

1. Signed transactions contain SQL source, canonical bindings, expectations,
   and no public relational command AST.
2. The consensus compiler parses and semantically validates the deterministic
   SQLite-compatible dialect.
3. The authorizer is demonstrably a backstop rather than the sole validator.
4. Local read-only SQLite and deterministic transaction SQL are separate client
   and RPC paths.
5. DDL and DML can be freely combined in one atomic streamed transaction.
6. Fresh groups begin with an empty application schema created through the
   transaction stream.
7. `schema.cbor`, authoritative `SchemaManifest`, and global schema digests no
   longer exist; any tooling manifest is derived from a pinned revision and is
   absent from consensus.
8. Schema assumptions are explicit SQL preconditions over the prefix catalog.
9. Any writer can execute deterministic DDL in this prototype.
10. Clean and suffix replay converge across DDL, DML, triggers, indexes, and
    deterministic extensions.
11. Every rejected SQLite feature has a recorded necessary reason or an
    explicit temporary conformance gate.
12. The complete syntax, determinism, security, replay, and distributed
    conformance suites pass.

## 27. Illustrative examples

### 27.1 Initial application schema

```ts
await db.transaction(async (tx) => {
  const absent = await tx.observe(`
    SELECT count(*) = 0
      FROM sqlite_schema
     WHERE type = 'table' AND name = 'accounts'
  `, {}, { resultMode: 'scalar' })
  tx.expect(absent)

  tx.exec(`
    CREATE TABLE accounts (
      id INTEGER PRIMARY KEY,
      balance_cents INTEGER NOT NULL CHECK (balance_cents >= 0),
      currency TEXT NOT NULL DEFAULT 'EUR'
    ) STRICT
  `)

  tx.exec(`
    INSERT INTO accounts (id, balance_cents)
    VALUES (:id, :opening_balance)
  `, {
    id: 1n,
    opening_balance: 10_000n,
  })

  tx.exec(`CREATE INDEX accounts_currency_idx ON accounts(currency)`)
})
```

The schema, row, index, and accepted transaction-log row commit atomically.

### 27.2 Minimal schema and data dependency

```ts
await db.transaction(async (tx) => {
  const columns = await tx.observe(`
    SELECT name, type, "notnull", pk
      FROM pragma_table_xinfo('accounts')
     WHERE name IN ('id', 'balance_cents')
     ORDER BY cid
  `, {}, { resultMode: 'ordered' })
  tx.expect(columns)

  const account = await tx.observe(`
    SELECT balance_cents
      FROM accounts
     WHERE id = :id
  `, { id: 1n }, { resultMode: 'scalar' })
  tx.expect(account)

  tx.exec(`
    UPDATE accounts
       SET balance_cents = balance_cents - :amount
     WHERE id = :id
  `, { id: 1n, amount: 1_000n })

  tx.exec(`
    SELECT chronolog_assert(changes() = 1, 'account must exist')
  `)
})
```

Adding an unrelated table does not invalidate the column expectation. Changing
either referenced column or the account balance does.

### 27.3 Ordinary schema evolution

```ts
await db.transaction(async (tx) => {
  const prior = await tx.observe(`
    SELECT name, type, "notnull", dflt_value
      FROM pragma_table_xinfo('accounts')
     WHERE name = 'currency'
  `, {}, { resultMode: 'ordered' })
  tx.expect(prior)

  tx.exec(`
    ALTER TABLE accounts
      ADD COLUMN updated_at_ms INTEGER
  `)

  tx.exec(`
    UPDATE accounts
       SET updated_at_ms = chronolog_transaction_timestamp_ms()
     WHERE updated_at_ms IS NULL
  `)

  tx.exec(`
    CREATE INDEX accounts_updated_at_idx
        ON accounts(updated_at_ms)
  `)
})
```

This is a normal transaction. It has no migration version, from/to schema
digest, schema-admin envelope, or separate reducer.

### 27.4 Local query

```ts
const rows = await db.query(`
  SELECT datetime('now') AS displayed_at,
         random() AS presentation_nonce,
         id,
         balance_cents
    FROM accounts
   ORDER BY id
`)
```

This query is read-only and local. Its clock and random values do not enter the
replicated transaction stream.

## 28. References

- BCP 14 / RFC 2119 and RFC 8174
- RFC 8949, Concise Binary Object Representation
- SQLite compile-time authorization callbacks:
  <https://www.sqlite.org/c3ref/set_authorizer.html>
- SQLite statement preparation and tail handling:
  <https://www.sqlite.org/c3ref/prepare.html>
- SQLite deterministic functions:
  <https://www.sqlite.org/deterministic.html>
- SQLite application-defined function flags:
  <https://www.sqlite.org/c3ref/c_deterministic.html>
- SQLite query planner stability guarantee:
  <https://www.sqlite.org/queryplanner-ng.html>
- SQLite limits:
  <https://www.sqlite.org/c3ref/limit.html>
- SQLite defensive configuration:
  <https://www.sqlite.org/c3ref/c_dbconfig_defensive.html>
- SQLite schema table:
  <https://www.sqlite.org/schematab.html>
- SQLite pragma table-valued functions:
  <https://www.sqlite.org/pragma.html#pragma_functions>
- Drizzle Kit database-first schema introspection (non-normative tooling
  example): <https://orm.drizzle.team/docs/drizzle-kit-pull>
- Prisma database introspection and regeneration workflow (non-normative
  tooling example):
  <https://www.prisma.io/docs/orm/prisma-schema/introspection>
