# Schema, SQLite Compiler, and Execution Manifest Implementation

Status: historical relational-IR compiler design; superseded where it conflicts
with Specifications 10 and 11

## 1. Responsibility

This subsystem converts validated relational IR into a deterministic backend
plan for the pinned DoltLite build. It owns catalog resolution, logical type
checking, effect analysis, ordering proof, schema generation, canonical SQL
rendering, parameter lowering, result canonicalization plans, and execution
manifest construction.

SQLite is the relational execution engine. It is not the language parser and
does not define Chronolog's value, error, ordering, or extension semantics.

## 2. Compiler pipeline

```text
canonical decoded IR
        |
        v
structural validation
        |
        v
catalog resolution and type checking
        |
        v
effect, purity, ordering and feature validation
        |
        v
normalized logical plan
        |
        +--> deterministic error/check plan
        |
        v
SQLite lowering
        |
        v
canonical SQL + typed parameters + result plan
```

Each stage returns an immutable object and diagnostics. No later stage repairs
invalid earlier input. Compiler entry points accept only schema and execution
manifests whose digests have already been verified.

## 3. Catalog

### 3.1 Construction

`Catalog.fromManifest(schema, executionManifest)` builds indexed maps by object
ID and SQLite lookup key. Lookup folds ASCII case only, including for quoted
identifiers, and leaves non-ASCII characters distinct. Construction validates:

- names unique under SQLite identifier comparison and unique IDs;
- reserved-name exclusions;
- primary and unique key composition;
- foreign-key type and collation equivalence;
- generated-column dependency acyclicity;
- view dependency acyclicity except declared recursive CTEs;
- rule target and write-set validity;
- extension registry references; and
- index expression legality.

Catalog lookup never queries `sqlite_schema` to discover language semantics.
SQLite introspection is used only after schema creation to verify that the
generated backend schema matches expectations.

### 3.2 Resolved identities

Resolved catalog objects contain numeric identities and backend names. Backend
names are generated deterministically from canonical schema names. Search
shadow objects live under `chronolog_derived_` and are inaccessible to
application IR.

## 4. Schema compilation

### 4.1 Initialization

Fresh repository initialization performs:

1. Decode and validate `SchemaManifest`.
2. Construct and verify `ConsensusExecutionManifest`.
3. Compile canonical schema statements.
4. Open a top-level SQLite transaction.
5. Create reducer system tables.
6. Execute application schema statements in object-ID order.
7. Insert seed rows in table-ID and primary-key order.
8. Create managed derived indexes in registered feature order.
9. Store canonical schema and execution manifests plus their digests.
10. Run schema introspection verification.
11. Commit SQLite state and create the genesis Dolt commit/checkpoint.

There is no `genesisSql` escape hatch. Tests that need unusual schemas build a
schema manifest.

### 4.2 Table rendering

Portable application tables compile to quoted explicit declarations. The
default is `STRICT, WITHOUT ROWID` where the logical type mapping permits it.
Every table declares an explicit primary key.

Logical types map to backend storage types through manifest entries, for
example:

| Logical type | Backend representation |
|---|---|
| Boolean | checked INTEGER 0 or 1 |
| Int64 | INTEGER |
| Decimal | canonical TEXT or tagged BLOB |
| Text | TEXT with registered collation |
| Blob | BLOB |
| UUID | 16-byte BLOB |
| TimestampMs/DurationMs | INTEGER |
| Json | canonical UTF-8 TEXT |
| Vector | canonical BLOB in source table |

Backend `CHECK` constraints are emitted as defense in depth. Chronolog's
preflight and post-write validation defines stable constraint attribution.

### 4.3 Defaults and generated values

Literal defaults may compile into schema SQL. Transaction-context or entropy
defaults are expanded into mutations because SQLite defaults cannot bind the
signed context. Generated expressions compile only when every operation has an
audited SQLite-equivalent lowering; otherwise the reducer materializes the
value explicitly.

### 4.4 Views and rules

Read-only views compile from query IR. Output columns are explicit. Ordering in
a view is omitted unless needed for a semantic row-choice operation internal to
the view.

Rules are normally expanded by the reducer. SQLite triggers may be generated
only after the rule conformance corpus proves identical event ordering,
recursion, error attribution, and multirow semantics. The initial
implementation SHALL use reducer expansion.

## 5. Execution manifest

### 5.1 Shape

```ts
interface ConsensusExecutionManifest {
  readonly irSemanticId: string
  readonly codecDigest: Uint8Array
  readonly rendererDigest: Uint8Array
  readonly schemaDigest: Uint8Array
  readonly doltliteSourceDigest: Uint8Array
  readonly doltlitePatchDigest: Uint8Array
  readonly sqliteSourceId: string
  readonly sqliteCompileOptions: readonly string[]
  readonly nativeBuildDigest: Uint8Array
  readonly platformPolicy: PlatformPolicy
  readonly databaseConfiguration: DatabaseConfiguration
  readonly valueProfile: ValueProfile
  readonly functionRegistry: readonly FunctionManifest[]
  readonly collationRegistry: readonly CollationManifest[]
  readonly moduleRegistry: readonly ModuleManifest[]
  readonly resourceLimits: SemanticLimits
}
```

The canonical manifest includes nested JSON, FTS, vector, spatial, and WASM
profiles even when disabled. Disabled features use explicit `enabled: false`
entries rather than omission.

### 5.2 Build measurement

The native addon SHALL expose a `nativeManifest()` method returning:

- `sqlite3_sourceid()`;
- sorted `PRAGMA compile_options`;
- DoltLite engine/source identifier;
- Chronolog patch digest embedded at build time;
- sqlite-vec source/version when compiled;
- architecture, pointer width, and endianness;
- enabled registered native functions/modules; and
- security configuration capability bits.

The TypeScript compiler package combines these measured values with canonical
IR, renderer, registry, and semantic-limit digests. Startup compares the result
with the database's stored manifest before opening a writable group.

### 5.3 Manifest source generation

A build script SHALL generate a small checked-in or build-output header from
verified source inputs. It must not use the current wall clock, filesystem path,
or nondeterministic archive metadata. CI rebuilds twice and compares manifest
bytes.

## 6. Expression lowering

### 6.1 Backend-safe operations

Operations with exact audited SQLite semantics may lower directly, including
null tests, Boolean connectives, binary collation comparisons, and bounded text
concatenation.

Checked Int64 negation, addition, subtraction, multiplication, division, and
remainder lower through compiler-owned SQL guards. SQLite's integer result is
accepted only when its storage class remains `integer`; REAL overflow promotion
and the Null result of a zero divisor instead trigger the stable consensus
`SQL_EVALUATION_ERROR`. Left shifts additionally require a count in `[0, 63]`
and prove no discarded sign bits by shifting the result back. Right shifts
require the same bounded count. Bitwise XOR is expressed from exact AND, OR,
and complement operations. The same checked representation supports
TimestampMs plus/minus DurationMs, TimestampMs differences, DurationMs
addition/subtraction, and DurationMs scaling by Int64. These guards expose no
floating result or value.

Compiler-owned builtin calls currently cover `char`, `concat`, `concat_ws`,
`length`, `octet_length`, ASCII `lower`/`upper`, `trim`/`ltrim`/`rtrim`,
`replace`, `instr`, `substr`/`substring`, `hex`,
`coalesce`/`ifnull`/`nullif`, `if`/`iif`, `likelihood`/`likely`/`unlikely`, the scalar
`glob()`/`like()` function forms, scalar `min()`/`max()`, `quote`, `typeof`,
`unhex`, `unicode`, `unistr`, `unistr_quote`, `zeroblob`, and integer
`abs`/`sign`. The compiler owns their closed names and typed overloads; no
schema function registration is required. SQL Null is polymorphic when
unifying conditional, compound, comparison, and null-selection expressions.
All-Null expressions retain the canonical nullable-Blob fallback when no
logical type can be inferred.

Minimum-Int64 `abs` overflow is normalized at consensus statement-execution
time to the stable `SQL_EVALUATION_ERROR` outcome without inspecting backend
error text; precondition or command identity provides attribution.
Prepare/profile failures remain operational failures, and local reads retain
the backend's native diagnostic. Connection-history, randomness, extension
loading, engine-build/physical introspection, ambient date/time, optional
compile-time functions, formatting, rounding, and floating-result functions
remain outside this builtin profile. Additional JSON1 calls require explicit
canonical JSON IR semantics rather than generic scalar typing.

### 6.2 Kernel operations

Operations whose SQLite semantics cannot be guarded without observing an
inexact value, or that need wider accumulators, normalization, or registered
rounding rules, lower to `chronolog_` kernel functions:

```text
chronolog_i64_add
chronolog_i64_sub
chronolog_i64_mul
chronolog_i64_div
chronolog_decimal_*
chronolog_text_*
chronolog_json_*
chronolog_vector_*
chronolog_entropy
chronolog_wasm_call
```

Function names are renderer-internal. Application IR references stable function
IDs, not these SQL names.

### 6.3 Parameters

The renderer assigns numbered placeholders by deterministic depth-first walk of
normalized IR. Parameters carry a logical type and backend binding operation.

```ts
interface BackendParameter {
  readonly ordinal: number
  readonly logicalType: LogicalType
  readonly storageClass: 'integer' | 'text' | 'blob' | 'null'
  readonly bytesOrValue: bigint | string | Uint8Array | null
}
```

Float bindings, when enabled, carry exact bits into a native binder; they are
not round-tripped through JavaScript decimal formatting.

## 7. Query compilation

### 7.1 Relations and joins

The compiler uses explicit aliases derived from node IDs. It renders join type
and predicates directly. Right and full joins MAY be rewritten into audited
equivalent forms if required by the selected SQLite build; the rewrite is part
of the renderer digest.

### 7.2 Projection

Each output expression receives a deterministic backend alias such as
`chronolog_p_<projection-id>`. User-visible names come from the resolved output
schema, never from SQLite's expression-name heuristics.

### 7.3 Grouping and aggregates

Checked integer and decimal aggregates use kernels. Order-sensitive aggregates
receive an explicitly ordered subquery or registered ordered aggregate. Bare
columns outside grouping are rejected before rendering.

The current portable compiler lowers order-insensitive `COUNT(*)`,
`COUNT(expr)`, `COUNT(DISTINCT expr)`, `MIN`, and `MAX`. `COUNT` is non-null
`Int64`; extrema preserve the input logical type and are nullable for empty or
all-null input. Standard aggregate `FILTER (WHERE ...)` predicates are typed as
Boolean and lowered without changing aggregate order semantics. Grouped
expressions accept qualified/unqualified references to the same resolved
column and columns functionally determined by a complete non-null primary or
unique key. Extrema are currently limited to exact SQLite storage orders:
Boolean, Int64, TimestampMs, DurationMs, binary/code-point Text, Blob, and
UUID. Exact integer/decimal sums remain gated on checked accumulator kernels;
SQLite's scan-order-dependent intermediate overflow is not accepted as their
consensus definition.

Boolean `EVERY`/`BOOL_AND` and `ANY`/`SOME`/`BOOL_OR` are also order-independent
and lower to `MIN` and `MAX` over compiler-typed Boolean values. They ignore
Null inputs and return Null for empty or all-Null input. A literal SQL Null is a
valid aggregate filter and simply selects no input rows.

### 7.4 Windows and recursive CTEs

Window terms include explicit collation and null placement. Recursive CTEs
include a semantic depth/row counter in their compiled plan. Planner-dependent
VM opcode counts are not used as canonical recursion limits.

### 7.5 Pagination

Consensus pagination compiles from a typed cursor containing every order term.
Offset pagination is compiled with a total order. Authored terms are preserved
and the compiler appends canonical tie-breakers as needed. Keyset pagination is
preferred for performance and renders a lexicographic predicate with explicit
null semantics.

## 8. Result plan

Every compiled query includes:

```ts
interface ResultPlan {
  readonly columns: readonly ResolvedOutputColumn[]
  readonly mode: ResultMode
  readonly maxRows: number
  readonly maxBytes: number
  readonly canonicalOrder?: readonly ResolvedOrderTerm[]
}
```

The executor steps rows incrementally, decodes each backend cell according to
its logical type, validates stored representation, and encodes a canonical row.

- Scalar mode rejects zero, two, or wider-than-one results.
- Ordered mode retains backend sequence after verifying the compiled total
  order.
- Multiset mode sorts canonical row bytes and retains duplicates.
- Set mode sorts and removes equal canonical row bytes.

Column names are not allowed to determine equality. The result digest covers
logical types, projection IDs, result mode, and canonical rows.

## 9. Mutation compilation

### 9.1 Target selection

Update and delete first compile a target-key query. The executor materializes
bounded primary keys in the declared order before applying row operations. This
prevents physical scan order from controlling rules, returning values, or
error priority.

### 9.2 Insert

Insert rendering always names target columns and quotes an optional target
alias. Explicit values retain their signed canonical IR order. Query sources
lower to `INSERT ... SELECT` with authored ordering preserved and deterministic
tie-breakers derived from every projected logical value. Source width, logical
types, and nullability are checked against target columns before SQL is
prepared. The canonical empty-column/single-empty-row shape lowers to
`DEFAULT VALUES`, inserting exactly one row under the explicit `error`,
`ignore`, or `replace` policy. Defaults remain schema-manifest values compiled
under the same deterministic checks as ordinary seed values.

The three encoded conflict policies lower directly under the pinned engine:
`error` to `INSERT`, `ignore` to `INSERT OR IGNORE`, and `replace` to
`INSERT OR REPLACE`. Affected-row expectations are still checked against the
statement's exact change count; ignored rows count zero and replacement counts
the inserted row according to SQLite semantics.

### 9.3 Upsert

The normalized upsert plan identifies one named primary-key or unique
constraint. The compiler emits its exact column list as the conflict target,
never an unqualified `ON CONFLICT`. A nonempty assignment list emits
`DO UPDATE SET`; an empty list emits `DO NOTHING`; and an optional predicate
emits `DO UPDATE ... WHERE`. `excluded` is reserved as the incoming-row scope,
so it cannot be used as an upsert target alias.

The input may also be a typed query. It receives canonical full-row ordering,
source width/type/nullability checks, and an unconditional outer `WHERE` to
resolve SQLite's documented `SELECT ... ON CONFLICT` parsing ambiguity before
the named conflict action is appended.

`INSERT OR REPLACE` is available only through the explicit insert `replace`
policy. It is not used to implement named upsert and therefore does not
silently substitute delete-and-insert behavior for `DO UPDATE`.

### 9.4 Update and delete

The initial executor applies target rows by primary key. All ordinary update
assignments read the old row. A mutation plan carries rule invocations and
returning evaluation after each logical row operation.

The current direct SQLite lowering quotes mutation aliases on `UPDATE` and
`DELETE`; qualified IR column references resolve case-insensitively to that
declared alias while the renderer preserves the schema's declared spelling.

`UPDATE OR IGNORE` and `UPDATE OR REPLACE` are lowered only when the predicate
proves the target is a single primary-key or unique-key lookup. Broad conflict
updates remain rejected because SQLite does not expose a portable logical row
visitation order, and the winning row can otherwise affect final state.

`UPDATE ... FROM` accepts a named typed query source when the compiler proves
it returns at most one row globally, or when a simple source table is joined
through every projected column of a primary or unique key. This covers
constant, aggregate, limited, unique-key lookup, and ordinary key-preserving
update sources without inheriting SQLite's arbitrary source-row choice when
several source rows match one target. More complex joins require a broader
per-target uniqueness proof and remain gated.

Equivalent surface syntax is normalized before canonical IR: explicit
`OR ABORT`, `OR FAIL`, and `OR ROLLBACK` are the ordinary `error` policy because
any constraint failure rejects and rolls back the entire atomic Chronolog
candidate, and a `main.` qualifier names the same manifest object. Canonical
update assignments already have SQLite's simultaneous old-row evaluation, so
row-value assignments require no execution-model extension once parsed.
Planner hints are not consensus semantics. The compile-option-dependent
UPDATE/DELETE `ORDER BY ... LIMIT` forms remain gated until they are lowered
through a canonical primary-key selection plan. SQLite documents that those
ordering terms choose the limited subset but do not control actual mutation or
RETURNING order.

The current token-aware SQL frontend directly repairs its selected parser's
missing `DEFAULT VALUES`, `REPLACE INTO`, and `UPDATE OR ...` grammar and
accepts `main.` as the application schema. That upstream parser also
rejects SQLite `UPDATE ... FROM`, `ON CONFLICT ... DO ...`, and row-value `SET`
syntax before producing an AST. The canonical IR and compiler paths are ready
for the first two and already model the third's simultaneous semantics, but
exposing those spellings through exact SQL awaits the planned parser replacement
rather than a second ad hoc SQL grammar hidden in preprocessing.

### 9.4.1 RETURNING implementation boundary

Mutation IR retains the optional returning query, but the current compiler
rejects it with `IR_RETURNING_UNSUPPORTED`. Supporting SQLite `RETURNING`
requires more than rendering a clause: the executor's mutation contract
currently returns only an affected-row count, the `chronolog-accepted-result-v1`
digest frames only precondition digests and counts, and RPC outcomes expose no
canonical returned rows. SQLite also does not guarantee RETURNING row order.
Enabling it therefore requires a versioned mutation-result envelope, canonical
result-mode handling and limits, digest framing, and an RPC/client result
surface. Silently executing and discarding RETURNING rows would be incompatible
with standard SQL ergonomics and is intentionally not done.

### 9.5 Merge

Merge materializes its bounded deterministic source result, validates target
key uniqueness, and applies matched/unmatched actions in source order. Multiple
source rows for one target cause a stable error unless the IR names an explicit
resolution.

### 9.6 Expected effects

The compiler emits an effect counter independent of SQLite's connection change
counter. It counts logical target rows, excluding rule and derived-index writes,
then compares the signed expectation.

## 10. Constraint and error plan

Backend constraint messages do not define canonical errors. The compiler
creates checks in stable priority:

1. target type and not-null checks;
2. named check constraints by constraint ID;
3. named unique constraints by constraint ID;
4. foreign keys by constraint ID; and
5. command expected effects.

SQLite constraints remain enabled as a backstop. A surprising backend error
that cannot be mapped from the deterministic check plan is operational and
aborts local replay.

Deferred foreign keys are checked immediately before the candidate's top-level
commit. Complex simultaneous unique-key updates require an explicit staged
mutation strategy; until implemented, the validator SHALL reject constructs
whose specified final-state semantics cannot be reproduced by ordered row
updates.

## 11. Rules

The compiler expands each rule into:

```ts
interface CompiledRule {
  readonly ruleId: number
  readonly timing: RuleTiming
  readonly guard: CompiledExpression
  readonly commands: readonly CompiledMutation[]
  readonly priority: number
  readonly recursion: CompiledRecursionPolicy
}
```

Invocation order is `(timing, priority, ruleId, targetPrimaryKey)`. A reducer
rule stack enforces depth and cycle policy. Derived index maintenance is not an
application rule and runs in its own fixed phase after source-row effects.

## 12. Canonical renderer

Renderer output is deterministic text plus ordered parameters. It:

- uses uppercase SQL keywords;
- quotes identifiers with double quotes and escapes embedded quotes;
- never emits comments;
- uses a single whitespace and line-breaking grammar;
- fully parenthesizes expressions under one precedence table;
- emits explicit `ASC`/`DESC` and `NULLS FIRST`/`NULLS LAST`;
- uses numbered placeholders;
- emits exactly one prepared statement per plan statement; and
- produces no non-trivia tail.

Renderer golden fixtures include complex nesting, joins, window frames, JSON,
FTS, vector searches, rules, and all conflict policies.

Canonical SQL is diagnostic and reproducible. Transactions sign IR and manifest
digests, not arbitrary rendered SQL. Nodes may store renderer output for audit.

## 13. Backend authorizer profile

The existing authorizer is changed from a language allowlist to a compiler
backstop. Execution uses explicit modes:

```text
internal_schema
consensus_precondition
consensus_mutation
derived_index_maintenance
local_read
```

Only `internal_schema` may create application schema. Only derived-index mode
may touch managed shadow objects. Consensus modes deny direct backend-internal
object access, including the `sqlite_`, `dolt_`, `doltlite_`, `chronolog_`, and
`pragma_` namespaces and protected eponymous virtual tables, plus pragmas,
attach/detach, dynamic extensions, transactions, savepoints, and unregistered
functions.

## 14. Tests

Required compiler tests include:

1. Catalog construction and dependency cycles.
2. Logical/backend type mapping.
3. Schema SQL golden output and introspection verification.
4. Every expression and query node lowering.
5. Parameter order and exact bindings.
6. Total-order acceptance and rejection.
7. Multiset/set result canonicalization.
8. Checked arithmetic and backend representation rejection.
9. Mutation target order and affected-row counts.
10. Constraint priority independent of SQLite English messages.
11. Rule ordering and recursion.
12. Authorizer denial of hand-written and shadow-table SQL.
13. Manifest digest sensitivity to every semantic input.
14. Identical renderer fixtures on all supported platforms.

## 15. Completion criteria

- Schema initialization contains no caller SQL.
- Every valid core IR program has exactly one backend plan for a manifest.
- Every invalid or unsupported program fails before preparing a statement.
- Result canonicalization is independent of physical scan order.
- Constraint and rule attribution use stable IR IDs.
- The execution manifest measures the actual native engine and configuration.
- Generated SQL remains fully subject to the native security authorizer.
