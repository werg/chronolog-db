# Implementation Status

This repository is the direct, unreleased Chronolog prototype. It has one
canonical transaction format and no compatibility decoder or migration path.
This page distinguishes working behavior from deliberately gated dialect
features; an execution manifest must never advertise a gated feature.

## End-to-end path

Implemented and covered by executable tests:

- canonical CBOR, typed hash domains, Ed25519 messages, strict IR/schema codecs;
- immutable ordering by author timestamp, author key, feed sequence, and SSB ID;
- transaction-level validator attestations whose arrival cannot change order;
- revision-pinned reader/writer/validator/admin capability reduction and
  offline two-of-three root recovery in the control-plane libraries;
- validator acceptance cutoffs, heartbeats, watermark evidence, and explicit
  history-reopening evidence;
- HPKE epoch-key wrapping primitives and authenticated encrypted SSB envelopes;
- memory and durable SSB-DB2 transport, allow-listed EBT replication, exact
  signed-author-tail recovery, checksummed append-log journaling, per-feed
  contiguous/gap status, and restart;
- canonical relational transaction programs with mandatory `assert`/`expect`
  preconditions and no consensus SQL strings;
- a compiler-validated SQLite SQL frontend generated from SQLite 3.53
  `parse.y`, explicitly pinned rather than imported through a moving parser
  alias, for the tested SELECT and INSERT/UPDATE/DELETE surface, with canonical
  IR kept as internal signed wire bytecode;
- checked Int64 and timestamp/duration scalar arithmetic, exact bitwise
  operations, compiler-owned deterministic SQLite scalar functions, standard
  Boolean aggregates, and deterministic ordering completion without schema
  registration for core SQL functions;
- deterministic mutation lowering for `DEFAULT VALUES`, insert-select and
  query-source named upsert, singleton `UPDATE OR IGNORE/REPLACE`, and
  compiler-proven scalar or key-preserving `UPDATE ... FROM`;
- exact-SQL lowering for recursive and forward-referencing CTEs, nested
  compounds, windows and frames, outer/NATURAL/USING joins, row values,
  `DEFAULT VALUES`, `REPLACE INTO`, chained SQLite UPSERT, `UPDATE FROM`,
  row-value `SET`, mutation CTEs, and the `main.` application-schema qualifier;
- schema and execution manifests committed by digest to every transaction;
- native DoltLite-only materialization, protected accepted/rejected transaction
  log, one top-level transaction per candidate, real Dolt checkpoints, suffix
  replay, and outcome-change attribution;
- a backend-neutral materializer contract with exact immutable object/database
  dependencies, canonical invocation/suffix/continuation/outcome codecs,
  explicit pure context, a DoltLite oracle adapter, and a differential fixture
  harness ready for a workerd backend;
- an isolated transport-neutral workerd materializer controller with named
  `previous`/`replayBase` inputs, exact-only CAS access, private output and
  checkpoint/finalize hooks, typed artifacts, deterministic standard-mode
  run/follow coordination, exact result-selector verification, separate
  publication intent, and a differential-harness adapter;
- a test-only pinned native DoltLite differential composition that routes a
  real append and late-predecessor replay through that controller and matches
  an independent real materializer on revisions, protected logs, outcomes,
  query results, and projected immutable output/artifact identities;
- a modules-syntax Chronolog reducer-bundle factory over the implemented named
  input/output handle contract, canonical application-result selectors, and a
  typed host client whose run/follow/publication transports remain injectable;
  an in-memory shadow host executes the actual module boundary, reconciles an
  ambiguous run by deterministic key, and publishes only through the separate
  client-side intent;
- portable coordinator, immutable-query, and publication-store interfaces;
  `node-core` dependency inversion through a behavior-preserving DoltLite
  adapter; and RPC handlers typed against a narrow service contract instead of
  the concrete node class;
- explicit read-only transaction-log IR for dependencies on preceding
  transactions;
- reserved transaction timestamp/nonce context, structural named parameters,
  exact typed results, revision-pinned and live queries;
- HTTP/NDJSON and in-process RPC with abort-aware bounded shutdown, TypeScript
  client drafts, React stream hooks, IR CLI, daemon, and runnable
  late-predecessor demonstration;
- exact int64/decimal/text/JSON/entropy/vector kernel implementations;
- pinned, statically linked sqlite-vec with dynamic extension loading disabled;
  and
- seeded container chaos/stress testing with directed Toxiproxy links, Docker
  process/resource faults, finality-aware checkers, telemetry, offline feed
  inspection, replayable artifacts, and CI profiles.

The default execution manifest enables the compiler's portable core plus exact
decimal and canonical JSON values. Ordinary vector values are available when a
manifest sets a positive vector-dimension bound.

The workerd package currently executes an injected database kernel and host
transport. Its pinned native differential fixture strengthens the evidence
from fake-only kernel tests to real Chronolog replay/materialization, and the
shadow bundle test now executes the real typed Worker/client boundary. It
still does not execute a workerd binary, provide the complete Chronolog SQL
kernel through the current minimal JSG statement surface, import or export a
database through workerd CAS, exercise Dolt merge, finalize typed artifacts,
or prove that a fail-closed pure workerd JSG context can execute the Chronolog
kernel. `chronologd` does not publish through workerd metadata.
The daemon still composes the legacy DoltLite adapter; no production authority
or publication cutover has occurred.

## Daemon operational profiles

The shipped daemon has two explicit bootstrap profiles. Its generated default
is a single participant that is both writer and validator. Setting
`CHRONOLOG_STATIC_MEMBERSHIP_FILE` loads an out-of-band multi-member snapshot
pinned to the daemon configuration's group ID, membership revision, and
validation policy. That snapshot sets validator and watermark thresholds and
binds every protocol signer to the exact authenticated SSB feed allowed to
carry its messages; `policyVersion` is an optional decimal string that defaults
to `"1"`.

This static snapshot is not a replicated capability log. The capability and
crypto packages contain signed revision/recovery and epoch-wrapping machinery,
and `node-core` can consume a capability-backed membership resolver, but the
daemon does not currently administer those logs or expose live onboarding,
revocation, recovery, or epoch-rotation commands. Multi-member operators must
provision matching snapshots and epoch configuration out of band and restart
participants. See the root README for the static membership JSON shape.

## Deliberately gated

The following IR/schema forms are represented and rejected before consensus
execution because their complete conformance gates have not been satisfied:

- managed FTS, sqlite-vec, and spatial derived indexes;
- deterministic WASM modules and registered extension calls;
- floating-point portable vector distance;
- rules/triggers, generated columns, merge, views, checked sums and
  order-sensitive aggregates, registered runtime collations/functions beyond
  the implemented core, table-valued functions, and parenthesized join trees;
- canonical representative selection for collation-equal but byte-distinct
  `DISTINCT`, set-compound, grouping, and `MIN`/`MAX` results;
- semantic recursive-row/depth limits beyond the current canonical frontier
  order and VM/result backstops;
- mutation `RETURNING` result delivery and digest framing;
- schema-change transactions and multi-member operational onboarding commands.

Native FTS5, JSON1, RTree, and sqlite-vec availability is diagnostic only.
Their presence in the measured engine does not enable their consensus feature
bit. sqlite-vec transaction, rollback, Dolt branch, commit, and reopen behavior
is tested as feasibility evidence, not advertised as a completed derived-index
profile.

## Release gates still outside this prototype

- independent reference evaluator and randomized differential corpus;
- crash injection at every publication lifecycle hook;
- delivery-permutation/fault simulation at production scale;
- Linux arm64, macOS, and Windows native replay CI;
- fuzzing, native sanitizers, resource/load characterization, signed artifacts,
  keystore integrations, and external security review.

The detailed acceptance criteria remain in the
[conformance and delivery specification](implementation-specs/09-conformance-delivery.md).
The SQL-first cutover and transaction result/ordered-mutation protocol work are
specified in
[deterministic SQL transactions](implementation-specs/10-deterministic-sql-transactions.md)
and
[transaction results and ordered mutations](implementation-specs/11-transaction-results-and-ordered-mutations.md).
Features move from gated to enabled only by changing code, tests, and the
measured manifest together.
