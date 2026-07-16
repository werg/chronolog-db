# Canonical Values and Relational IR Implementation

Status: historical relational-IR design; not the active signed transaction
contract

## 1. Responsibility

This specification defines the implementation of the signed relational
program. It covers canonical primitives, logical values, schema/query/mutation
ASTs, stable codecs, validation stages, traversal, builders, and resource
bounds. It does not cover SQLite lowering or database execution.

The normative language semantics remain in
[the SQL dialect specification](../sql-dialect.md). This document fixes the
code structure used to implement those semantics.

## 2. `@chronolog/canonical`

### 2.1 Scope

`@chronolog/canonical` SHALL own only consensus-safe general primitives:

- deterministic CBOR encoding and strict decoding;
- byte equality, unsigned lexicographic comparison, and concatenation;
- strict UTF-8 encode/decode;
- domain-separated SHA-256;
- fixed-width integer byte encodings;
- canonical map-key ordering helpers; and
- bounded decoder infrastructure.

It MUST NOT import Node-only APIs in its public implementation. Cryptographic
hashing MAY use a platform adapter behind one interface, provided official
fixtures prove byte equivalence.

### 2.2 Decoder limits

Every decode call receives a `DecodeLimits` value:

```ts
interface DecodeLimits {
  readonly maxBytes: number
  readonly maxDepth: number
  readonly maxArrayItems: number
  readonly maxMapItems: number
  readonly maxTextBytes: number
  readonly maxBlobBytes: number
}
```

The decoder MUST enforce limits while consuming input, reject trailing bytes,
reject non-shortest integer encodings, reject indefinite-length objects, and
reject duplicate or incorrectly ordered map keys.

### 2.3 Domain registry

Hash domains are centralized and tested for uniqueness:

```ts
const HASH_DOMAINS = {
  transaction: 'chronolog/transaction',
  schema: 'chronolog/schema',
  executionManifest: 'chronolog/execution-manifest',
  queryResult: 'chronolog/query-result',
  expectation: 'chronolog/expectation',
  module: 'chronolog/module',
  entropy: 'chronolog/entropy',
} as const
```

The helper hashes a length-prefixed UTF-8 domain, a zero separator, and the
payload. Callers cannot supply arbitrary domain strings; they select a typed
registry key.

## 3. Logical values

### 3.1 Representation

Values use discriminated immutable structures rather than JavaScript primitive
coercions:

```ts
type LogicalValue =
  | { readonly kind: 'null' }
  | { readonly kind: 'boolean'; readonly value: boolean }
  | { readonly kind: 'int64'; readonly value: bigint }
  | { readonly kind: 'decimal'; readonly coefficient: bigint; readonly scale: number }
  | { readonly kind: 'text'; readonly utf8: Uint8Array }
  | { readonly kind: 'blob'; readonly bytes: Uint8Array }
  | { readonly kind: 'uuid'; readonly bytes: Uint8Array }
  | { readonly kind: 'timestamp_ms'; readonly value: bigint }
  | { readonly kind: 'duration_ms'; readonly value: bigint }
  | { readonly kind: 'json'; readonly value: CanonicalJsonValue }
  | { readonly kind: 'vector'; readonly type: VectorElementType; readonly dimensions: number; readonly bytes: Uint8Array }
```

Float values are added only through an enabled numeric profile and carry exact
bit patterns. The portable core SHALL not use JavaScript `number` for integers,
timestamps, decimal coefficients, or consensus comparisons.

Text constructors validate UTF-8 once. Public convenience constructors accept
JavaScript strings, encode them strictly, and store immutable copies. Blob and
vector constructors also copy inputs so later caller mutation cannot change a
signed program.

### 3.2 Type descriptors

Schema and expression types use canonical descriptors:

```ts
type LogicalType =
  | { readonly kind: 'boolean' }
  | { readonly kind: 'int64' }
  | { readonly kind: 'decimal'; readonly precision: number; readonly scale: number }
  | { readonly kind: 'text'; readonly collation: CollationId }
  | { readonly kind: 'blob'; readonly maxBytes?: number }
  | { readonly kind: 'uuid' }
  | { readonly kind: 'timestamp_ms' }
  | { readonly kind: 'duration_ms' }
  | { readonly kind: 'json' }
  | { readonly kind: 'vector'; readonly element: VectorElementType; readonly dimensions: number }

interface ValueType {
  readonly logical: LogicalType
  readonly nullable: boolean
}
```

Nullability is not encoded by a separate union alternative in expression
nodes; it is part of the resolved `ValueType`.

### 3.3 Canonical value encoding

Each value is a CBOR array whose first element is a stable integer tag. Decimal
coefficient and scale are encoded independently. Text is encoded as CBOR text
only after strict validation. JSON is encoded as its canonical tree, not as
SQLite JSONB. Vector payloads include type and dimension even when the schema
already implies them, so standalone results remain self-describing.

The codec has round-trip, rejection, and ordering fixtures for every boundary:

- minimum and maximum `Int64`;
- timestamp zero and `2^63-1`;
- decimal normalization and overflow;
- empty and maximum-sized text/blob;
- invalid UTF-8;
- JSON nesting and duplicate keys; and
- every vector element type and dimension mismatch.

## 4. Node identity and source locations

Every schema object, precondition, mutation, rule, projection, ordering term,
and extension call carries a stable ID. IDs are unsigned integers unique within
their containing program or manifest.

Builder-generated IDs are assigned monotonically in builder call order. A
textual parser may use source order. IDs affect attribution and canonical
encoding, so rebuilds that intend to create identical transactions must retain
them.

Diagnostic source locations are optional and excluded from canonical encoding:

```ts
interface IrDiagnosticLocation {
  readonly file?: string
  readonly startOffset?: number
  readonly endOffset?: number
  readonly builderLabel?: string
}
```

Canonical objects MUST NOT retain mutable diagnostic maps. The validator returns
diagnostics that refer to node IDs.

## 5. Expression IR

### 5.1 Unresolved input nodes

The public IR accepts named references but never embeds executable callbacks:

```ts
type Expr =
  | LiteralExpr
  | ParameterExpr
  | ColumnExpr
  | ContextExpr
  | OldNewExpr
  | UnaryExpr
  | BinaryExpr
  | ConditionalExpr
  | CastExpr
  | BuiltinFunctionExpr
  | FunctionExpr
  | AggregateExpr
  | JsonExpr
  | ScalarSubqueryExpr
  | ExistsExpr
  | MembershipExpr
```

Every variant contains `kind` and `id`. Operator names are closed enum values,
not arbitrary strings. Function calls reference stable manifest function IDs.
Pinned SQLite core calls use a separate closed-name `BuiltinFunctionExpr` with
compiler-owned arity, argument, result, collation, and nullability rules. They
do not require application schema registration and cannot be relabeled through
an execution manifest. Registered extension calls remain `FunctionExpr`.
Core aggregate nodes use the closed `count | min | max | every | any` operation
enum, an optional value (`COUNT(*)` omits it), and an explicit `distinct` bit.
`every` and `any` are the canonical Boolean operations behind standard
`EVERY`/`ANY`/`SOME` and common `BOOL_AND`/`BOOL_OR` spellings. Aggregate calls
are not represented as registered scalar functions. An optional typed Boolean
`filter` expression represents standard `FILTER (WHERE ...)`; aggregate calls
cannot be nested in its predicate.

### 5.2 Resolved nodes

Resolution produces a separate immutable tree with:

- schema object and column IDs replacing names;
- exact argument and result types;
- nullability;
- collation;
- effect class;
- deterministic function registry entry; and
- calculated semantic cost bounds.

The unresolved tree is what is signed. The resolved tree is derived and never
accepted over the network.

### 5.3 Transaction context

Context expressions use a closed enum:

```ts
type ContextField =
  | 'group_id'
  | 'membership_revision'
  | 'validation_policy'
  | 'author_id'
  | 'author_timestamp_ms'
  | 'transaction_nonce'
  | 'candidate_digest'
  | 'transaction_id'
  | 'author_feed_sequence'
```

Labeled entropy is a distinct expression node containing a non-empty ASCII
label, unsigned index, and requested length. It is not represented as a generic
function call.

## 6. Query IR

### 6.1 Query structure

Queries use a relational tree:

```ts
interface Query {
  readonly id: number
  readonly ctes: readonly Cte[]
  readonly from?: Relation
  readonly joins: readonly Join[]
  readonly where?: Expr
  readonly groupBy: readonly Expr[]
  readonly having?: Expr
  readonly projection: readonly Projection[]
  readonly windows: readonly WindowDefinition[]
  readonly compounds: readonly CompoundTerm[]
  readonly orderBy: readonly OrderTerm[]
  readonly page?: PageClause
  readonly resultMode: ResultMode
}
```

Relations include tables, views, subqueries, CTE references, registered table
functions, FTS relations, vector searches, and spatial searches. Generic
virtual-table module names are not accepted.

### 6.2 Result modes

Result mode is encoded in every consensus query:

```ts
type ResultMode =
  | { readonly kind: 'scalar' }
  | { readonly kind: 'ordered' }
  | { readonly kind: 'multiset' }
  | { readonly kind: 'set' }
```

The resolver computes a typed output schema with stable projection IDs and
names. Scalar mode requires one projected value. For ordered mode, the compiler
preserves authored terms and derives any missing canonical-row tie-breakers.
Multiset and set modes cause result rows to be encoded and sorted by canonical
bytes by the execution layer.

### 6.3 Ordering proof

The ordering validator tracks candidate keys through relational operators and
can use the final canonical projected row as a universal observable
tie-breaker. Proof metadata is compiler-derived; applications never mark an
order term as canonical. Authored terms remain first, so completion only
chooses among rows whose order SQLite otherwise leaves unspecified.

Proof metadata is derived, not signed:

```ts
interface OrderingProof {
  readonly total: boolean
  readonly reason: 'unique_key' | 'canonical_row' | 'not_total'
  readonly keyProjectionIds: readonly number[]
}
```

`LIMIT`, `OFFSET`, scalar row choice, order-sensitive windows, and ordered
aggregates trigger automatic completion. Validation fails only when the
operation depends on intermediate row identity for which neither a candidate
key nor canonical relational value can be derived.

### 6.4 Parameters

Signed consensus queries contain typed literal values or transaction-context
references. Client-only query templates MAY contain named parameters. Draft
publication must substitute them with copied typed values before canonical
encoding.

## 7. Mutation IR

```ts
type Mutation =
  | InsertMutation
  | UpdateMutation
  | DeleteMutation
  | UpsertMutation
  | MergeMutation
  | RegisteredStatefulCall
```

Every mutation includes:

- stable command ID;
- target object ID or unresolved name;
- explicit values or predicate;
- exact conflict policy;
- affected-row expectation;
- optional returning query; and
- optional application label.

Target mutations may also carry a quoted SQL alias. Insert has exactly one
source form: an explicit values-row array, a typed query source, or the
canonical `columns: [], rows: [[]]` representation of `DEFAULT VALUES`. The
query form is canonical IR, not caller-provided SQL. Upsert carries one values
row or query source, a named unique constraint, an update list (empty means
`DO NOTHING`), and an optional update predicate corresponding to SQLite's
`DO UPDATE ... WHERE`. Update may carry a conflict policy and a named query
source for deterministic `UPDATE ... FROM`.

An insert never relies on positional table-column order. An upsert names a
unique constraint. Update assignments are an ordered array, but default
semantics evaluate right-hand expressions against the old row. Sequential
assignment requires a distinct explicit node.

For `INSERT ... SELECT`, the compiler makes source application order
deterministic. It preserves authored ordering terms and completes ties with the
entire projected logical row, including explicit null placement. This permits
scalar, ordered, set, and multiset query sources without exposing SQLite's
otherwise unspecified visitation order to conflict handling.

Affected-row expectations are encoded closed variants. `unconstrained` is
explicit and can be prohibited by an application policy.

## 8. Preconditions and observations

```ts
type Precondition =
  | {
      readonly kind: 'assert'
      readonly id: number
      readonly query: Query
      readonly unknownIsFailure: true
    }
  | {
      readonly kind: 'expect'
      readonly id: number
      readonly query: Query
      readonly expected: InlineResult | ResultDigest
    }
```

Every transaction contains at least one precondition. Expected results include
the resolved output type schema and result mode in their digest input.

An observation record is local draft state, not signed independently:

```ts
interface DraftObservation {
  readonly observationId: string
  readonly query: Query
  readonly revision: bigint
  readonly schemaDigest: Uint8Array
  readonly result: CanonicalQueryResult
  readonly dependsOnContext: readonly ContextField[]
}
```

Turning an observation into a precondition copies the query and canonical
expected result into the transaction. Several observations in one draft MUST
share the same pinned materialized revision.

## 9. Schema IR

The schema manifest contains stable numeric object IDs, names, declaration
order, and definitions for:

- tables and columns;
- primary, unique, check, and foreign-key constraints;
- indexes and generated expressions;
- views;
- rules;
- FTS, vector, and spatial derived indexes;
- registered functions, collations, modules, and WASM code;
- deterministic seed rows; and
- semantic feature and resource settings.

Schema object names are nonempty, well-formed Unicode without NUL. All ordinary
quoted SQL names are accepted; object and column collisions are detected using
SQLite's ASCII-only case folding. The schema codec sorts definitions by numeric
object ID, not JavaScript insertion order.

Seed data is represented as explicit typed rows in primary-key order. It cannot
contain transaction context, database queries, or entropy.

## 10. Transaction program

The IR portion of a candidate is:

```ts
interface TransactionProgram {
  readonly preconditions: readonly Precondition[]
  readonly mutations: readonly Mutation[]
  readonly metadata?: ReadonlyMap<string, Uint8Array>
}
```

The protocol owns author, group, capability, timestamp, nonce, manifest, and
schema fields. IR context expressions resolve against those protocol fields at
execution.

At least one mutation and one precondition are required. Read-only consensus
transactions may be added later through an explicit program kind; an empty
mutation array is not silently accepted.

## 11. Codec registry

### 11.1 Stable tags

Maintain one checked registry file containing numeric ranges:

```text
0-31       logical values and types
32-127     expressions
128-191    relations and queries
192-255    mutations
256-287    preconditions and result modes
288-383    schema objects
384-447    rules and registered extensions
448-511    reserved
```

Actual tag values are assigned once in code and fixtures. CI rejects duplicate
tags. Unknown tags fail closed. Reserved tags are never reused after the first
published format, but there is no compatibility machinery in the prototype.

### 11.2 Field encoding

IR records use integer-keyed CBOR maps when optional fields are common and
fixed arrays when every field is mandatory. Codec code lists known fields
explicitly and rejects unknown keys until an extension rule is intentionally
specified.

Encode/decode functions are total over validated TypeScript structures:

```ts
encodeTransactionProgram(program): Uint8Array
decodeTransactionProgram(bytes, limits): TransactionProgram
encodeSchemaManifest(schema): Uint8Array
decodeSchemaManifest(bytes, limits): SchemaManifest
```

Decoded arrays, maps, and byte strings are copied and frozen at public
boundaries.

## 12. Validation pipeline

Validation returns all safe-to-report structural diagnostics up to a configured
cap, but execution uses the first error under canonical priority.

### 12.1 Structural

- Known tags and fields.
- Nonempty, well-formed identifier text without NUL.
- SQLite-equivalent ASCII case-fold collision checks for schema objects and
  columns.
- Stable IDs unique within scope.
- Bounded collections and nesting.
- Required precondition and mutation counts.
- Logical value representation.

### 12.2 Catalog resolution

- Every object and column exists.
- Aliases are unique and unambiguous.
- View and CTE recursion follows declared rules.
- Constraint and index references are valid.
- Extension IDs exist in the execution manifest.

### 12.3 Type checking

- Operator argument types are exact.
- Nullability is propagated.
- Casts are explicit and permitted.
- JSON and vector dimensions are known.
- Projection and expected-result types match.
- Mutation assignments match target columns.

### 12.4 Effect and purity checking

Expressions are pure. Queries read only declared relations. Mutations write
only their target and rule-declared effect set. Application IR cannot read or
write backend-internal main-database objects (`chronolog_`, `sqlite_`, `dolt_`,
`doltlite_`, and `pragma_` namespaces or protected eponymous virtual tables).
These restrictions do not apply to ordinary column, alias, projection, or
constraint names.

### 12.5 Determinism checking

- Row-choice operations have total order.
- Aggregates declare order or safe algebraic properties.
- Functions and collations are registered.
- Context and entropy uses are explicit.
- Float, FTS, vector, spatial, and WASM uses are enabled by the manifest.
- Schema expressions contain only allowed pure functions.

### 12.6 Semantic resource checking

Validation computes upper bounds where possible and rejects programs that
exceed manifest limits before SQLite preparation. Runtime enforces result rows,
result bytes, recursion, rule depth, vector dimensions, JSON depth, and WASM
fuel in semantic units.

## 13. Builders

Builders provide ergonomic immutable construction while producing ordinary IR
objects. They SHALL NOT embed closures, class instances, symbols, dates, or
database handles in signed structures.

The low-level builder is schema-independent and useful for tests. The generated
builder binds schema object and column identities and narrows TypeScript types.

Builder APIs perform eager checks but cannot replace node-side validation.
Calling `build()` returns a deep-frozen program and a diagnostic-source map.

## 14. Visitors and transformations

Provide exhaustive visitors for:

- walking child nodes;
- collecting context dependencies;
- collecting relation read/write sets;
- replacing draft parameters with values;
- assigning stable IDs;
- producing diagnostic renderings; and
- computing semantic complexity.

Every visitor uses an exhaustive `never` check so adding an IR variant causes
compile failures in codec, validation, compiler, and reference evaluator.

## 15. Tests

Required test groups:

1. Value boundary and immutability tests.
2. Canonical codec golden bytes.
3. Reject non-canonical and malformed encodings.
4. Every AST tag round-trips.
5. Duplicate ID and ambiguous-name rejection.
6. Nullability and cast matrices.
7. Total-order proof cases.
8. Effect-set enforcement.
9. Context and entropy dependency collection.
10. Builder versus hand-authored IR equivalence.
11. Decoder fuzzing under strict allocation limits.
12. Fixture decoding in browser and Node implementations where supported.

## 16. Completion criteria

- The package graph follows the required dependency direction.
- There is one canonical logical-value representation across protocol, client,
  compiler, RPC typed results, and tests.
- Every IR node has a stable tag, codec, validator, visitor, and fixture.
- Received IR cannot bypass structural, type, effect, determinism, and resource
  validation.
- No signed IR object contains SQL text or executable host callbacks.
- The same schema and transaction objects encode byte-for-byte identically on
  every supported platform.
