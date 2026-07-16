# Conformance, Testing, and Delivery Implementation

Status: historical relational-IR delivery plan; its general conformance
methods remain roadmap input, while Specifications 10/11 and the compatibility
ledger define the active feature contract

## 1. Responsibility

This specification turns deterministic behavior into executable release gates
and divides the direct replacement into reviewable work packages. Chronolog is
not considered implemented because unit tests pass on one machine. It is
implemented when canonical fixtures, independent evaluation, Dolt replay,
delivery permutations, crash injection, native feature gates, and supported
platforms agree.

There is no compatibility or migration work package. Development state is
recreated as needed.

## 2. Test layers

```text
L0  static package/dependency/API checks
L1  canonical value, codec, IR and kernel units
L2  compiler golden and reference differential tests
L3  single-candidate reducer atomicity
L4  Dolt branch/checkpoint/replay/crash tests
L5  node admission/order/SSB/encryption tests
L6  client/RPC/reactive end-to-end tests
L7  delivery-permutation and fault simulation
L8  cross-platform native and replay conformance
L9  fuzz, sanitizer, resource and performance characterization
```

Failures at a lower layer block interpretation of higher-layer results.

## 3. Fixture repository

Store reviewed fixtures under:

```text
packages/conformance/fixtures/
  values/
  ir/
  schema/
  renderer/
  results/
  errors/
  kernels/
  json/
  fts/
  vector/
  spatial/
  wasm/
  replay/
  distributed/
```

Each fixture contains:

- human-readable source description;
- canonical input bytes in hex/base64url;
- input digest;
- expected resolved types/effects/order proof where relevant;
- canonical renderer output and parameter encodings;
- expected result/state/outcome/error;
- applicable manifest/schema digests; and
- fixture generator name and source digest.

Fixture files contain no generation timestamp, absolute path, host name, or
unordered object serialization.

Updating a canonical fixture requires explicit review. Tests do not rewrite
goldens automatically during ordinary runs.

## 4. Reference evaluator

### 4.1 Scope

Implement a deliberately slow in-memory relational evaluator for the portable
core:

- logical values and comparisons;
- table scans over canonical row maps;
- filters, projections, joins, grouping and core aggregates;
- total ordering, limits and result modes;
- insert, update, delete and basic upsert;
- preconditions and affected-row expectations;
- checked integers, decimals, canonical JSON; and
- exact bit/int8 vector scans.

It does not need SQLite, DoltLite, compiler SQL, native extensions, SSB, or node
code. Shared canonical codecs are acceptable, but semantic operations SHOULD
have independent implementations where feasible.

### 4.2 Differential harness

For a schema, prefix rows, transaction IR and context:

1. Run the reference evaluator.
2. Compile and execute through DoltLite on a fresh branch.
3. Canonically export application rows and transaction outcome.
4. Compare logical values, accepted/rejected state, attribution and result
   digests.

Random generators shrink a mismatch to a minimal schema/query/transaction.

## 5. Canonical and compiler tests

Required coverage:

- every value/IR/schema tag and field;
- accepted and rejected canonical CBOR encodings;
- identifier and resource limits;
- type/nullability/cast matrices;
- relation scope and ambiguous references;
- total-order proofs and row-choice rejection;
- exact parameter traversal order;
- renderer whitespace/quoting/parentheses;
- query modes and canonical row sorting;
- mutation conflict/effect behavior;
- named constraint/error priority;
- rule order and recursion; and
- manifest digest sensitivity.

Run selected query fixtures with alternate indexes, `ANALYZE` state, and
reverse-unordered-scan diagnostics where available. Logical output must remain
identical.

## 6. Reducer property suite

For generated admitted transaction sequences:

```text
cleanReplay(sequence) == incrementalAppend(sequence)
cleanReplay(sequence) == everyCheckpointSuffixReplay(sequence)
cleanReplay(sort(permutation(sequence))) == cleanReplay(sequence)
```

Equality covers:

- every application table's canonical rows;
- system transaction log and attribution;
- schema/manifest metadata;
- FTS/vector/spatial logical digests; and
- published content hash where Dolt promises history-independent content.

Generate candidates whose preconditions change outcome after insertion, whose
rules create secondary writes, and whose constraints fail at different points.

## 7. Atomicity and fault injection

Instrument materializer lifecycle hooks in tests. For every hook, terminate or
throw before and after it, reopen the database, and require one of:

- previously published revision intact; or
- newly published fully verified revision intact.

Never accept partial candidate effects, missing accepted log rows, rejected
application effects, or a published ref pointing at an unverifiable state.

Native feature fault tests inject errors during shadow-table maintenance and
WASM/kernel calls. Deterministic declared failures reject the candidate;
unexpected failures abort replay.

## 8. Distributed simulation

The simulator creates writers, validators, readers and relays with independent
control/materializer stores. It varies:

- candidate/attestation/heartbeat/capability delivery order;
- partitions and reconnection;
- duplicate messages;
- delayed/hidden backdated candidates;
- validator subset visibility;
- node restarts and durable cursor resumes;
- encryption epoch message order;
- payload chunk delay/corruption; and
- materializer speed versus message arrival.

After convergence, capable replicas must derive identical admitted sets,
ordering, database rows, transaction outcomes and settlement evidence. Nodes
without a required manifest feature must refuse attestation/materialization
without corrupting relay behavior.

## 9. Cross-platform matrix

At minimum run native conformance on intended release targets such as:

```text
Linux x64
Linux arm64
macOS arm64
macOS x64 where supported
Windows x64
```

Each job records native manifest, canonical fixture digest, kernel self-test
digest, SQLite/DoltLite source IDs, sqlite-vec status, and replay-result digest.

Portable profiles require equal semantic digests. Exact-native profiles, if
ever enabled, publish distinct manifest digests and fixtures rather than being
mistaken for portable equivalence.

## 10. Fuzzing and sanitizers

Fuzz targets:

- canonical CBOR and IR decoders;
- schema/catalog construction;
- expression/query/mutation validators;
- JSON parser/path/patch;
- canonical result decoder;
- FTS query parser;
- vector encoders and sqlite-vec adapter;
- WASM manifest/module validation and ABI; and
- RPC canonical-byte decoders.

Properties include no crash/panic, bounded allocation, stable error class,
round-trip for valid values, and no accepted non-canonical encoding.

Run AddressSanitizer/UndefinedBehaviorSanitizer for vendored C/C++ paths and
Rust sanitizer/Miri-equivalent checks where practical. Native fuzz findings
block the corresponding registered feature.

## 11. Resource tests

Test every semantic limit at `limit-1`, `limit`, and `limit+1`:

- candidate/program bytes;
- AST depth and node counts;
- parameters and literal bytes;
- result rows and bytes;
- JSON depth/nodes/string/number digits;
- query recursion and rule depth;
- decimal precision;
- vector dimensions/candidates;
- FTS tokens/query depth;
- WASM bytes/memory/table/fuel; and
- derived-index rebuild rows.

Also test operational limits such as memory exhaustion and SQLite progress
interrupt separately; they must abort local replay rather than create canonical
rejections.

## 12. Performance characterization

Performance is not consensus, but unacceptable architecture costs should be
found before APIs harden. Measure:

- IR encode/decode/validate/compile latency by node count;
- prepared-plan cache hit/miss;
- candidate apply and rejected-log cost;
- append versus late checkpoint replay;
- checkpoint spacing/retention tradeoffs;
- JSON parse/path/patch;
- FTS maintenance/query/rebuild;
- exact vector scan and vec0 query/rebuild;
- WASM invocation/fuel overhead;
- live-query fanout; and
- SSB encrypted payload throughput.

Benchmarks fix inputs and report native manifest. They do not alter semantic
limits automatically.

## 13. Work packages

### WP0 — Baseline and direct-cutover guard

- Add the new package skeletons and dependency-cycle check.
- Add CI search that forbids raw consensus SQL symbols after cutover.
- Add a test helper that creates/deletes fresh group databases and feeds.
- Document that local state is disposable.

Exit: package graph builds and no migration framework exists.

### WP1 — Canonical foundation

- Extract canonical CBOR/hash/UTF-8/bytes.
- Implement logical core values and canonical result encoding.
- Preserve non-transaction protocol fixture bytes where structures are
  unchanged.

Exit: value/canonical fixtures pass in Node and supported browser build.

### WP2 — Core IR and schema

- Implement ASTs, codecs, IDs, visitors, schema manifest and validator.
- Implement builder primitives and schema code generation foundation.
- Add golden and fuzz fixtures.

Exit: representative schema/query/precondition/mutation programs round-trip and
validate without SQLite.

### WP3 — Compiler and manifest

- Implement catalog/type/effect/order passes.
- Implement schema and core query/mutation rendering.
- Implement native measurement and execution-manifest persistence.
- Add compiler/reference differential harness.

Exit: fresh schema IR initializes DoltLite and core programs match reference
results.

### WP4 — Candidate atomicity and replay

- Replace suffix transaction/savepoints with candidate top-level transactions.
- Add structured outcome attribution.
- Add manifest/schema startup verification and crash injection.

Exit: atomicity, append, late replay, checkpoint and crash suites pass.

### WP5 — Protocol and node direct edit

- Replace transaction SQL fields with `TransactionProgram`.
- Rewrite codecs, draft store, publication, validator language checks and
  control-store indexes.
- Recreate protocol/control/SSB fixtures.

Exit: multi-node simulation admits, orders and materializes IR candidates only.

### WP6 — RPC, client, React, CLI, example

- Replace draft/query contracts with canonical IR.
- Implement typed schema bindings and transaction/query builders.
- Implement observation provenance, rebase, typed results and reactive APIs.
- Rewrite CLI and end-to-end example.

Exit: application creates a fresh group and demonstrates late replay without a
consensus SQL string.

### WP7 — Core deterministic kernels and JSON

- Build/register native kernels.
- Lower checked numeric/text/JSON operations.
- Complete exact JSON parser, canonicalizer, paths, patches and aggregates.

Exit: kernel/reference/cross-platform JSON and numeric suites pass.

### WP8 — FTS and vector feasibility

- Complete FTS managed-index adapter and gate.
- Vendor/statically register sqlite-vec.
- Keep vectors authoritative in ordinary tables.
- Run complete Dolt/replay/crash/reference gate.

Exit: enabled features pass every gate; sqlite-vec remains disabled if it does
not.

### WP9 — Rules, spatial, and WASM

- Implement reducer-expanded rules and recursion.
- Add integer spatial profile.
- Add pinned deterministic Wasmtime bridge and scalar ABI.

Exit: rule/spatial/WASM conformance and fault suites pass.

### WP10 — Full dialect completion and hardening

- Complete remaining joins, compounds, windows, recursive CTEs, merge,
  generated columns, views, aggregates and extension forms.
- Run full fuzz, sanitizer, distributed and cross-platform matrix.
- Characterize performance and document enabled feature matrix.

Exit: every feature claimed by the active dialect profile has code, fixtures,
reference/differential coverage, and platform evidence.

## 14. CI gates

Every change runs format/lint/typecheck/unit tests. Consensus changes also run:

- canonical fixture comparison;
- manifest sensitivity tests;
- compiler/reference differential suite;
- replay equivalence suite; and
- raw-consensus-SQL deletion guard.

Native or registered feature changes run their complete feature gate. Scheduled
CI runs fuzz budgets, sanitizers, large distributed permutations, and all
platforms. A native digest change requires reviewed manifest/fixture updates.

## 15. Completion evidence

The repository SHALL produce a machine-readable conformance report containing:

```ts
interface ConformanceReport {
  readonly sourceCommit: string
  readonly schemaDigest: string
  readonly executionManifestDigest: string
  readonly fixtureCorpusDigest: string
  readonly platform: string
  readonly enabledFeatures: readonly string[]
  readonly testGroups: readonly TestGroupResult[]
  readonly replayDigest: string
  readonly generatedAtOperationally: string
}
```

Generation time is report metadata and excluded from every consensus digest.
Reports link to logs and artifacts. A feature is advertised only when its
required groups passed for the exact manifest.

## 16. Overall completion criteria

The implementation plan is complete when:

1. Direct-edit deletion checks pass.
2. Canonical/IR/compiler/kernel fixtures pass.
3. Independent reference and DoltLite agree for the portable core.
4. Candidate atomicity and all replay equivalence properties hold.
5. Distributed delivery permutations converge.
6. Client/RPC/reactive behavior survives late predecessor replay.
7. Every enabled native/WASM feature has passed its specific gate.
8. Supported platforms produce the expected portable semantic digests.
9. Fuzz/sanitizer work has no unresolved release-blocking findings.
10. The active manifest advertises no unimplemented or unproven feature.
