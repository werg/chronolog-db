# Extension and Advanced-Index Profile

Chronolog distinguishes modules compiled into the native SQLite build from
modules enabled by the consensus execution manifest. Native availability alone
never makes an extension consensus-safe.

## Enabled core surface

The core manifest admits the closed deterministic function allowlist, the
built-in `BINARY`, `NOCASE`, and `RTRIM` collations, JSON1 scalar functions,
and the JSON `->`/`->>` operators. Their implementation identity is the native
engine digest, which includes the pinned DoltLite/SQLite patch profile and
static extension source hashes. Trigger `RAISE(ABORT)`, `RAISE(FAIL)`, and
`RAISE(IGNORE)` are also admitted; candidate transaction rollback and stable
error attribution bound their effects. `RAISE(ROLLBACK)` remains gated because
it attempts to control the enclosing transaction.

All enabled operations share the manifest's SQL byte, expression depth, VM
step, result row/byte/value, and canonical sort-work limits. Differential and
reopen fixtures are included in the portable conformance digest.

## Fail-closed registries

The core manifest has empty external function, collation, and module
registries. Its constructor fixes `fts`, `spatial`, and `wasm` to false and
rejects attempts to advertise them. Unknown functions and collations, virtual
tables, and non-pragma table-valued functions fail in the compiler, before
validation or execution. Dynamic extension loading remains disabled natively.

FTS5, integer RTree, and sqlite-vec are statically present for local diagnostics
and have transactional, branch-isolation, and reopen tests. They are not active
consensus features: FTS tokenizer/resource identity, vector KNN tie completion,
spatial contracts, and immutable module registration are still absent.

## Maintenance statements

`ANALYZE` and `REINDEX` are characterized as physical/planner maintenance.
They remain gated because their stored planner/index effects are not part of a
portable logical replay contract. This is an intentional fail-closed result,
not an implied promise that native SQLite acceptance is sufficient.
