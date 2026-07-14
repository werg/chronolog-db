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
- schema and execution manifests committed by digest to every transaction;
- native DoltLite-only materialization, protected accepted/rejected transaction
  log, one top-level transaction per candidate, real Dolt checkpoints, suffix
  replay, and outcome-change attribution;
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
- rules/triggers, generated columns, merge, views, CTEs, compounds, windows,
  aggregates, and custom collations/functions beyond the implemented core;
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
Features move from gated to enabled only by changing code, tests, and the
measured manifest together.
