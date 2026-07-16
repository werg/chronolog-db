# Implementation Status

Chronolog is an unreleased prototype with one signed SQL transaction format
and one consensus execution path. It has application-facing SQL migration
tooling, but no stored-data compatibility decoder or protocol migration path.
The exact working and gated SQLite boundary is machine-readable in the
[compatibility ledger](sqlite-compatibility-ledger.json).

## End-to-end path

Implemented and covered by executable tests:

- exact signed SQL source, canonical typed bindings, mandatory SQL
  preconditions, and ordered body statements;
- canonical scalar, ordered, multiset, and set results, plus versioned accepted
  transaction result envelopes and domain-separated digests;
- a SQLite 3.53 grammar parser pinned through `sqlite3-parser@0.7.1`, with the
  runtime pinned to the SQLite 3.54 DoltLite build, unknown syntax failing
  closed, and a differential corpus covering all 57 classified SQL families;
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
- checksummed application migration history, exact/minimum signed schema
  assumptions, revision-pinned catalog inspection/diffing, advisory TypeScript
  bindings, migration/schema live resources, and CLI status/apply/wait flows;
- replicated signed governance events for live capability grants/revocations,
  authenticated feed binding, validator changes, HPKE epoch rotation, scoped
  history access, and 2-of-3 administration recovery;
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
`UPDATE`, `DELETE`, supported read-only catalog pragmas, and streamed DDL. It
also admits scalar subqueries, unordered/nested `LIMIT`, `INSERT ... SELECT`,
`CREATE TABLE ... AS SELECT`, and `UPDATE ... FROM` when a syntactic
at-most-one-row proof removes every row choice; broader forms fail closed.
Representative-stable `DISTINCT`, grouping, distinct compounds, `MIN`/`MAX`,
peer-stable `rank`/`dense_rank`, and value-completed ordered `group_concat`
have similarly explicit structural proofs.
Ordered results require an authored outer `ORDER BY`; the executor completes
ties with canonical returned-column keys. Unordered results are canonicalized
as tagged row sets or multisets. All authored statements are recompiled by the
node before publication and again under the same profile during replay.

The following valid SQLite surfaces remain explicitly gated pending the named
determinism/conformance work:

- an exact SQLite 3.54 parser grammar (the current measured 3.53/3.54 boundary
  is executable through `pnpm conformance:sqlite`);
- catalog-dependent scalar-subquery uniqueness and multirow nested/unordered
  `LIMIT` choices;
- representative-sensitive `DISTINCT`, grouping, compounds, and `MIN`/`MAX`;
  peer-sensitive windows such as `row_number`, `ntile`, `lag`, and `lead`; and
  floating or incompletely ordered aggregates;
- multirow `INSERT ... SELECT`, `CREATE TABLE ... AS SELECT`, and `UPDATE ...
  FROM` without an input/source uniqueness proof, plus order-sensitive conflict
  modes;
- JSON arrow operators, trigger `RAISE`, registered functions/collations,
  virtual tables, and non-pragma table-valued functions; and
- `ANALYZE` and `REINDEX` replay conformance.

Transaction control, attachment, temporary objects, stateful pragmas, dynamic
extensions, Dolt control functions, physical maintenance such as `VACUUM`, and
protected-state access are prohibited rather than merely unimplemented.

## Daemon operational profile

The generated daemon configuration bootstraps a signed single-participant
genesis and persists its private governance material with mode `0600`. The
daemon replays and follows capability, recovery, and epoch-manifest messages,
uses revisioned capability snapshots for authorization, and decrypts retained
epochs through a live key ring. Snapshot readers receive only epochs published
while authorized; audit readers may receive explicit historical rewraps.
Threshold recovery replaces the root key and administration feed, revokes
capabilities tied to the compromised root, and records any deliberate history
reopening in settlement evidence.

`CHRONOLOG_STATIC_MEMBERSHIP_FILE` is retained as an explicit legacy/testing
override. Production key custody, packaging, and a polished operator CLI remain
release-hardening work; the bootstrap recovery keys must not remain co-located
for a real deployment.

## Release gates outside this prototype

- exact SQLite 3.54 parser synchronization, or continued executable proof of
  the measured 3.53/3.54 compatibility boundary;
- validation of the configured Linux/macOS portable replay digest comparison,
  plus deterministic resource characterization on release hardware;
- crash injection at all publication lifecycle boundaries;
- fuzzing, native sanitizers, signed distributions, OS-backed keystores, and
  external security review; and
- production workerd kernel/CAS integration and daemon publication cutover.

The broader delivery criteria remain in the
[conformance specification](implementation-specs/09-conformance-delivery.md),
[deterministic SQL specification](implementation-specs/10-deterministic-sql-transactions.md),
and [transaction result specification](implementation-specs/11-transaction-results-and-ordered-mutations.md).

## Active roadmap

The ordered implementation queue and acceptance criteria live in
[`upcoming.md`](../upcoming.md). The next implementation tranche is
deterministic SQL row-choice expansion. Historical relational-IR plans are kept
for design context but are not the active transaction roadmap.
