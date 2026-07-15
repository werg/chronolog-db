# `@chronolog/sql-frontend`

This package is a client-side compatibility frontend for standard SQLite SQL
and existing query builders. It accepts the common compiled-query structure
`{ sql, parameters }`, parses it with a typed parser generated directly from
SQLite's `parse.y`, and lowers supported syntax to Chronolog's canonical
relational IR.
SQL strings and parser ASTs never enter the signed protocol.

The parser import is pinned explicitly to
`sqlite3-parser/sqlite-3.53.0`; the package's moving `current` entry point is
not used. The selected DoltLite build currently embeds SQLite 3.54, so parser
upgrades must vendor or select the generated grammar for that exact source
revision before newly added 3.54 syntax is advertised. The canonical IR and
compiler, rather than either parser version, remain the consensus boundary.

```ts
const frontend = new SqliteConsensusFrontend({ schema, executionManifest })

const precondition = frontend.lowerAssertion({
  sql: 'SELECT balance >= ? AS ok FROM accounts WHERE id = ?',
  parameters: [10n, 7n],
})
const mutation = frontend.lowerCommand({
  sql: 'UPDATE accounts SET owner = ? WHERE id = ?',
  parameters: ['updated-owner', 7n],
}, { affectedRows: affectedRows.exactly(1n) })

const signedProgram = frontend.program([precondition], [mutation])
```

For the normal client draft workflow, wrap the same lowered values without
exposing their IR structure:

```ts
const query = defineLoweredQuery(
  frontend.lowerQuery(compiledSelect),
  { decodeResult: (result) => result.rows },
)
const mutation = defineLoweredMutation(frontend.lowerCommand(compiledUpdate))

await client.transaction(async (draft) => {
  const observed = await draft.observe(query)
  draft.expect(observed) // mandatory precondition
  draft.mutate(mutation)
})
```

The canonical IR is internal wire bytecode here, not a recommended application
query DSL. There is intentionally no `transactSql()` API.

Construction requires both the canonical schema and selected execution
manifest. Every result is run through the real schema-aware compiler before it
is returned; parser acceptance alone is never treated as executable support.
`program()` requires at least one precondition and one mutation. A frontend
instance owns a monotonic IR-node allocator, so all queries and commands for a
transaction should be lowered with the same instance.

## Supported grammar

- One statement at a time.
- `SELECT`/`SELECT ALL`/`SELECT DISTINCT` projections, aliases, `*`, table aliases,
  comma joins, `CROSS JOIN`, `JOIN`/`INNER JOIN`, `LEFT [OUTER] JOIN`,
  `RIGHT [OUTER] JOIN`, and `FULL [OUTER] JOIN`, including
  standard unconstrained joins and SQLite `CROSS JOIN ... ON`/`USING`;
  parenthesized joined-table groups preserve nested outer-join semantics,
  unaliased source qualifiers, and qualified stars. SQLite's grouped-table
  alias behavior is retained: `alias.column` is visible but `alias.*` is not.
  `WHERE`, `GROUP BY`, aliases/ordinals, `HAVING`, `ORDER BY`
  aliases/ordinals, canonical
  integral literal or parameterized `LIMIT`/`OFFSET`,
  ordinary and recursive CTEs with optional column-name lists, derived tables,
  scalar/correlated subqueries, `EXISTS`, `IN`/`NOT IN` (including SQLite's
  `expr IN one_column_table` shorthand), `UNION`/`UNION ALL`,
  and arbitrarily nested `INTERSECT`/`EXCEPT`. `NATURAL` and `USING` joins are
  catalog-expanded with SQLite's merged unqualified-column and `SELECT *`
  ordering/suppression semantics; qualified `table.*` remains physical.
  Explicit result aliases are fallback names in `WHERE`, join `ON`, `HAVING`,
  and nested `GROUP BY`/`ORDER BY` expressions; real input columns retain each
  clause's SQLite precedence, while a bare `ORDER BY` alias remains preferred.
- Ordinary quoted SQLite identifiers, including keywords and spaces. Computed
  projections without `AS` retain SQLite's exact authored expression text as
  their result name. Top-level duplicate names remain duplicates; derived-table
  and CTE boundaries use SQLite's case-insensitive `name:N` disambiguation.
- Decimal and hexadecimal integer, text, blob, boolean and null literals; positional `?`, numbered
  `?NNN` (1 through 32766), and named `:name`, `$name`, or `@name` parameters.
  SQLite parameter slots are assigned lexically before AST lowering, including
  repeated, sparse, or out-of-order numbered slots. Trailing array bindings
  beyond the highest referenced SQLite slot are rejected as likely mistakes.
  Exact object keys such as `:name`, `@name`, and `$name` preserve SQLite's
  distinct named-parameter namespaces. A prefix-free `name` key remains a
  convenience only when it is unambiguous in that statement.
  Parameters are embedded as typed canonical values during lowering. Decimal,
  UUID, timestamp, JSON and vector values use explicit `LogicalValue` inputs.
- Boolean/comparison, checked integer arithmetic, bitwise/shift, and
  concatenation expressions; searched and simple `CASE`, `BETWEEN`/`NOT BETWEEN`,
  SQLite `LIKE`/`NOT LIKE` with optional
  `ESCAPE`, binary-text `GLOB`/`NOT GLOB`, `ISNULL`/`NOTNULL`/`NOT NULL`,
  `IS DISTINCT FROM`/`IS NOT DISTINCT FROM`, unary `+`, safe `CAST` targets
  (the parser-supported SQLite integer, text, and blob type-name families),
  row-value comparisons and membership, JSON constructors and literal or
  runtime-text path accessors represented by IR; explicit SQLite `BINARY`,
  `NOCASE`, and `RTRIM`, Unicode-codepoint, and manifest-registered
  collations; and compiler-owned deterministic SQLite core functions:
  `char`, `concat`, `concat_ws`, `length`, `octet_length`, `lower`, `upper`,
  `trim`, `ltrim`, `rtrim`, `replace`, `instr`, `substr`, `substring`, `hex`,
  `coalesce`, `ifnull`, `nullif`, `if`/`iif`, `likelihood`/`likely`/`unlikely`, the
  `glob()`/`like()` function forms, scalar `min()`/`max()`, `quote`, `typeof`,
  `unhex`, `unicode`,
  `unistr`, `unistr_quote`, `zeroblob`, `abs`, and `sign`. These functions do
  not require schema or execution-manifest registration. Manifest-registered
  pure extension functions remain a separate path.
- `ORDER BY ... NULLS FIRST/LAST` at every query depth and exact `COUNT`,
  `COUNT(DISTINCT value)`, `MIN`, `MAX`, and Boolean `EVERY`/`BOOL_AND` and
  `ANY`/`SOME`/`BOOL_OR` aggregates, each with standard `FILTER (WHERE ...)`.
  SQLite aggregate-argument `ORDER BY` is accepted for these exact
  order-insensitive aggregates. Its expressions, directions, and null
  placement remain in canonical IR and compiled SQL so SQLite still performs
  ordinary name resolution, parameter binding, and expression evaluation.
  The compiler completes hidden canonical projected-row
  tie breakers when ordering or pagination can observe row choice; the
  frontend does not impose a primary-key-only rule.
- Named and inline window specifications, base-window inheritance,
  `ROWS`/`RANGE`/`GROUPS` frames and `EXCLUDE`, aggregate windows with `FILTER`,
  and `row_number`, `rank`, `dense_rank`, `ntile`, `lag`, and `lead`. The
  compiler preserves authored peer keys for ranking functions and adds a
  canonical intra-peer source-row order only for order-sensitive operations.
- `INSERT ... VALUES`, `INSERT DEFAULT VALUES`, deterministic `INSERT ... SELECT`,
  `INSERT OR IGNORE`, `INSERT OR REPLACE`/`REPLACE INTO`, `UPDATE` (including
  `OR IGNORE`/`OR REPLACE` and `UPDATE ... FROM`), and `DELETE`, including
  ordinary and recursive mutation CTEs, update/delete target aliases, modern
  chained SQLite `ON CONFLICT ... DO NOTHING` / `DO UPDATE` clauses, stable
  column/expression/partial-index conflict-target resolution, `excluded.*`,
  row-value `SET` from row expressions or multi-column scalar subqueries, and
  explicit affected-row expectations supplied outside SQL. Repeated assignment
  targets follow SQLite's rightmost-wins behavior. `UPDATE ... FROM` is accepted
  when the compiler can prove at most one source row per target row.

## Deliberate current gaps

The adapter fails closed on syntax it has not proven. Current expression/model
gaps include floating-point results, JSON `->>`/dynamically typed
scalar extraction, and extension-defined `REGEXP`/`MATCH`; SQLite has no
built-in XOR operator. Window gaps include `percent_rank`/`cume_dist` pending a
canonical floating-point result profile and `first_value`/`last_value`/
`nth_value` pending peer-preserving value-window lowering. Aggregate gaps
include `SUM`/`AVG`/`TOTAL` pending exact checked kernels and ordered collection
aggregates.

Mutation `RETURNING` is a result-envelope and digest-framing gap, not a parser
restriction. UPDATE/DELETE `ORDER BY ... LIMIT` still needs canonical key-subset
lowering. UPSERT conflict targets must resolve to a manifest UNIQUE constraint
or index, and update-from sources remain gated only when the compiler cannot
prove at most one source choice per target row. Database
qualifiers other than `main` would introduce another state namespace and are
outside the current single canonical database model.

Connection-history functions (`changes`, `total_changes`, and
`last_insert_rowid`), randomness, extension loading, SQLite build/physical
metadata, and current date/time keywords remain deliberately unavailable.
`format`/`printf`, `round`, Julian-day operations, and other
floating or dynamic-format surfaces remain outside the exact scalar profile.
The optional `soundex` and `sqlite_offset` functions are not compiled into the
pinned engine. Additional JSON1 routines require canonical JSON IR result and
duplicate-key semantics rather than generic scalar-function typing.

`LIKE` retains the pinned SQLite engine's standard behavior: ASCII letters are
case-folded while non-ASCII code points compare case-sensitively. SQLite does
not make LIKE case-sensitive merely by applying `COLLATE BINARY`; accepting
BINARY here means the operands remain in Chronolog's only currently supported
text type, not that the frontend substitutes nonstandard pattern semantics.

These are frontend gaps, not license to place raw SQL in consensus messages.
They should be closed incrementally with parser fixtures plus IR/compiler
round-trip tests. Applications can also implement `ConsensusSqlFrontend` for a
mature query builder's native AST, avoiding a SQL render/parse round trip while
preserving the same canonical IR boundary.
