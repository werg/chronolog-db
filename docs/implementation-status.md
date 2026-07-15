# Implementation Status

Chronolog is an unreleased prototype with one signed SQL transaction format,
one consensus execution path, and no compatibility decoder or migration path.
The exact working and gated SQLite boundary is machine-readable in the
[compatibility ledger](sqlite-compatibility-ledger.json).

## End-to-end path

Implemented and covered by executable tests:

- exact signed SQL source, canonical typed bindings, mandatory SQL
  preconditions, and ordered body statements;
- canonical scalar, ordered, multiset, and set results, plus versioned accepted
  transaction result envelopes and domain-separated digests;
- a SQLite 3.53 grammar parser pinned through `sqlite3-parser@0.7.1`, with the
  runtime pinned to the SQLite 3.54 DoltLite build and unknown syntax failing
  closed;
- semantic compilation of one statement at a time, exact SQLite parameter
  numbering, protected-object/effect analysis, deterministic function gates,
  ordering checks, stable diagnostics, and whole-program validation;
- separate local read-only SQLite and deterministic consensus SQL profiles;
- an authorizer backstop that denies protected state, attachments, transaction
  control, temporary state, unsafe pragmas/functions, and direct Dolt control;
- sequential DDL and DML in one candidate transaction, including tables,
  indexes, views, triggers, `ALTER`, drops, ordinary mutations, and bounded DML
  `RETURNING` results;
- empty-schema genesis, atomic schema/data rollback, prefix-catalog visibility,
  Dolt checkpoints, suffix replay, restart/reopen, and accepted/rejected outcome
  changes after late predecessors;
- protected accepted/rejected transaction-log rows with phase,
  precondition/statement attribution, result envelope version, bytes, and
  digest;
- SQL observation, expectation, assertion, statement, validation, rebase,
  local/live query, outcome, and result RPCs;
- TypeScript `query`, `observe`, `expect`, `assert`, and `exec` APIs accepting
  conventional `{ sql, parameters }` statements, with exact result-download
  verification and draft/statement provenance checks;
- SQL-first daemon, CLI, React hooks, examples, and chaos workloads; and
- canonical CBOR, signatures, capability/recovery primitives, encryption,
  durable allow-listed SSB replication, deterministic ordering, validator
  admission, checkpoints, and settlement evidence from the existing protocol
  layers.

There is no authoritative application schema manifest, schema digest,
`schema.cbor`, signed query/mutation IR, special schema transaction, or legacy
SQL/IR RPC pair. Logical-value and execution-manifest codecs remain internal
building blocks for the SQL protocol and compiler.

## Current deterministic SQL boundary

The compiler currently admits ordinary `SELECT`, values-based `INSERT`,
`UPDATE`, `DELETE`, supported read-only catalog pragmas, and streamed DDL.
Ordered results require an authored outer `ORDER BY`; the executor completes
ties with canonical returned-column keys. Unordered results are canonicalized
as tagged row sets or multisets. All authored statements are recompiled by the
node before publication and again under the same profile during replay.

The following valid SQLite surfaces remain explicitly gated pending the named
determinism/conformance work:

- SQLite 3.54-only parser coverage and parser/runtime differential fixtures;
- consensus REAL input bindings;
- scalar subqueries, nested or unordered `LIMIT`, and other unresolved row
  choices;
- `DISTINCT`, `GROUP BY`, distinct compounds, aggregate `MIN`/`MAX`, windows,
  and ordered/order-sensitive aggregates requiring canonical representative or
  peer selection;
- `INSERT ... SELECT`, `CREATE TABLE ... AS SELECT`, `UPDATE ... FROM`,
  conflict-sensitive update forms, and update/delete order-limit support;
- JSON arrow operators, trigger `RAISE`, registered functions/collations,
  virtual tables, and non-pragma table-valued functions; and
- `ANALYZE` and `REINDEX` replay conformance.

Transaction control, attachment, temporary objects, stateful pragmas, dynamic
extensions, Dolt control functions, physical maintenance such as `VACUUM`, and
protected-state access are prohibited rather than merely unimplemented.

## Daemon operational profile

The generated daemon configuration is a single participant acting as writer
and validator. `CHRONOLOG_STATIC_MEMBERSHIP_FILE` enables an out-of-band
multi-member snapshot pinned to group, membership revision, validation policy,
thresholds, and exact authenticated SSB feed mappings. It is not a replicated
administration interface; live onboarding, revocation, recovery, and epoch
rotation remain operational work.

## Release gates outside this prototype

- exact SQLite 3.54 parser synchronization and a larger differential corpus;
- cross-platform native replay CI and deterministic resource characterization;
- crash injection at all publication lifecycle boundaries;
- fuzzing, native sanitizers, signed distributions, OS-backed keystores, and
  external security review; and
- production workerd kernel/CAS integration and daemon publication cutover.

The broader delivery criteria remain in the
[conformance specification](implementation-specs/09-conformance-delivery.md),
[deterministic SQL specification](implementation-specs/10-deterministic-sql-transactions.md),
and [transaction result specification](implementation-specs/11-transaction-results-and-ordered-mutations.md).
