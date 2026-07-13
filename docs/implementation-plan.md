# Chronolog DB Detailed Implementation Plan

Status: Draft 0.1

Date: 2026-07-13

> This document records the plan that produced the current end-to-end
> prototype. The direct replacement of its raw-SQL consensus path is specified
> by the [deterministic runtime implementation suite](implementation-specs/README.md).
> Chronolog is unreleased: the replacement edits formats and APIs in place and
> recreates development state. No compatibility or migration work is required.

This plan delivers the architecture in [implementation-design.md](implementation-design.md)
and the semantics in [design.md](design.md). It is ordered around risk removal
and executable vertical slices rather than package completion in isolation.

## 1. Delivery objective

The first usable release is complete when independent participant nodes can:

1. Create or join a permissioned group.
2. Author encrypted typed relational transactions with mandatory preconditions while
   offline from peers.
3. Replicate candidates and validator messages through SSB.
4. Derive the same admission set, total order, SQL state, and accepted/rejected
   log under every delivery permutation.
5. Insert a hidden older transaction by restoring a checkpoint and replaying
   the affected suffix.
6. Expose revisioned queries, live-query changes, outcomes, and structured
   settlement evidence to a TypeScript client.
7. Recover administration using two of three offline recovery keys without an
   active validator quorum.

## 2. Execution strategy

- Build the protocol kernel before the distributed daemon.
- Prove external dependency behavior before designing abstractions around it.
- Keep every derived store disposable and continuously test rebuilds.
- Deliver one end-to-end path early, then add privacy and operations without
  changing ordering or reducer semantics.
- Treat deterministic fixtures and randomized delivery tests as product
  artifacts, not incidental unit tests.
- Do not stabilize public RPC or client APIs until replay and outcome-changing
  behavior is observable end to end.

## 3. Dependency graph

```text
M0 Feasibility and repository foundation
 |
 +--> M1 Canonical protocol kernel
 |      |
 |      +--> M2 Capabilities and encryption
 |      |      |
 |      |      +--> M3 Admission/order simulator
 |      |                     |
 |      +---------------------+----+
 |                                  |
 +--> M4 DoltLite reducer/materializer
 |                                  |
 +--> M5 SSB transport/payloads ----+
                                    |
                                    v
                         M6 Integrated node/validator
                                    |
                                    v
                         M7 RPC and client libraries
                                    |
                                    v
                         M8 Onboarding and operations
                                    |
                                    v
                         M9 Hardening and v0.1 release
```

M1, M4, and M5 may proceed independently after M0. M6 is the integration gate:
public client work should not outrun it.

## 4. Repository and engineering baseline

The initial repository work establishes:

```text
pnpm workspace
strict TypeScript configuration
locked Node.js runtime range
format, lint, typecheck and unit-test commands
Vitest-based unit and integration tests
property-test and fuzz-test harnesses
platform-aware native dependency packaging
CI for Linux x64/arm64, macOS arm64/x64 and Windows x64 where available
dependency license and vulnerability reporting
release artifact signing and checksums
```

All packages expose explicit public entry points. Circular package imports fail
CI. Consensus-relevant packages may not use ambient time, locale, randomness,
filesystem, environment variables, or network APIs.

## 5. Milestone 0 — Feasibility and foundation

### Objective

Remove the highest-risk unknowns in DoltLite, SSB-DB2, deterministic encoding,
and cryptography before committing to the daemon API.

### Work items

#### M0-DOLT-1: Native binding proof

Build a Node program that:

- Opens a persistent DoltLite file.
- Creates schema and data, stages it, and creates commits.
- Creates a branch from an earlier commit and switches branches.
- Restores an earlier checkpoint without using merge.
- Maintains concurrent readers on an old published head while a replay branch
  is built.
- Reopens the correct published head after injected process termination.

Record exact DoltLite version, build flags, APIs, thread assumptions, and
platform behavior.

#### M0-DOLT-2: SQL sandbox proof

Confirm the binding exposes or can be extended to expose:

```text
sqlite3_set_authorizer
sqlite3_progress_handler and interrupt
sqlite3_limit
prepared-statement tail inspection
exact typed binding and column extraction
savepoints and deterministic error codes
```

If any are missing, implement a minimal N-API proof that wraps only the required
standard C APIs and Dolt checkpoint/ref operations. Do not approve regex-based
SQL filtering as a fallback.

#### M0-SSB-1: Two-peer replication proof

Run two isolated SSB-DB2 instances that:

- Create independent feeds.
- Exchange Chronolog-shaped envelope messages.
- Disconnect, publish independently, reconnect, and fill gaps.
- Surface the exact persisted message ID, author, and feed sequence.
- Resume ingestion from durable cursors after restart.
- Detect or expose enough information to quarantine a fork.

#### M0-SSB-2: Payload proof

Replicate one inline payload and one content-addressed chunk manifest. Interrupt
the transfer, resume it, reconstruct exact bytes, and reject a corrupted chunk.

#### M0-CRYPTO-1: Library selection

Evaluate maintained implementations for deterministic CBOR, SHA-256, Ed25519,
HPKE, and secure randomness. Selection criteria are:

- Standards compliance and test vectors.
- Typed-array APIs with no implicit string conversions.
- Browser portability for the protocol package where reasonable.
- Auditable dependency size and maintenance.
- Constant-time/native implementation for secret operations where available.
- License compatibility.

Create a minimal vector covering canonical encoding, signing, verification,
HPKE wrap/open, associated-data failure, and wrong-domain rejection.

#### M0-REPO-1: Workspace bootstrap

Create the package skeleton, shared tooling, CI, contribution documentation,
decision-record directory, and fixture conventions. Add a `doctor` command that
reports Node, native DoltLite, compiler, platform, and dependency versions.

### Exit criteria

- The DoltLite replay and publication path works on the primary development
  platform and has a documented path for every release platform.
- Required SQLite sandbox controls are callable from Node.
- Two SSB peers reproduce exact message identity and payload bytes after a
  partition and restart.
- Selected crypto/CBOR libraries pass initial official vectors.
- Any required DoltLite shim has a deliberately small reviewed API.

Failure of the atomic publication or SQL sandbox proof blocks later milestones
and requires an architecture revision.

## 6. Milestone 1 — Canonical protocol kernel

### Objective

Implement the byte-level structures and pure verification logic shared by all
node roles.

### Work items

#### M1-SCHEMA-1: Protocol schema registry

Assign integer CBOR keys and tags for:

```text
transaction candidate core
SSB Chronolog envelope and payload manifest
validator attestation and heartbeat
genesis and capability-log revision
recovery record
encryption-epoch manifest
validation proof bundle
snapshot manifest
stable protocol error
```

Document required, optional, reserved, and prohibited fields. Reject unknown
fields in the directly edited prototype schema.

#### M1-CBOR-1: Deterministic codec

Implement canonical encoding and strict decoding. Decoding must reject:

- Indefinite lengths.
- Non-preferred integer or length encodings.
- Duplicate or incorrectly ordered map keys.
- Out-of-range integers and timestamps.
- Text where protocol bytes are required.
- CBOR floating-point encoding for exact SQL binary64 parameters.
- Trailing bytes.

#### M1-CRYPTO-1: Hashing and signatures

Implement domain-separated SHA-256 and Ed25519 helpers. The API must make it
difficult to sign an object under the wrong domain. Verification returns stable
codes rather than library exception strings.

#### M1-TYPES-1: SQL typed parameters

Represent null, signed 64-bit integers, binary64 bit patterns, UTF-8 text, and
blob bytes without lossy conversion. Include explicit conversion failures for
unsafe JavaScript numbers.

#### M1-ORDER-1: Identifiers and ordering

Implement unsigned byte comparison and the exact order tuple:

```text
(author_timestamp_ms, author_id, author_feed_sequence, tx_id)
```

Test equal timestamps, non-ASCII-looking byte sequences, maximum feed
sequences, clock rollback, and duplicate candidate detection.

#### M1-VECTORS-1: Conformance corpus

Publish human-readable vector manifests plus exact binary inputs and outputs.
For every valid vector, generate single-fault variants for non-canonical bytes,
digest mismatch, signature mismatch, wrong group, wrong domain, overflow, and
unsupported version.

### Tests

- Unit tests for every field and error path.
- Property tests for encode/decode stability.
- Fuzz decoding with bounded memory and time.
- Cross-process byte equality tests under different locale/timezone settings.
- Snapshot tests for stable protocol error codes.

### Exit criteria

- Protocol functions are pure and have no imports from Node, SSB, DoltLite,
  RPC, or clients.
- Every supported structure has normative vectors.
- Re-encoding a valid decoded value produces identical bytes.
- Non-canonical but semantically similar encodings are rejected.

## 7. Milestone 2 — Capabilities and encryption

### Objective

Implement permission evaluation, administration recovery, reader scopes, and
group encryption independently of live networking.

### Work items

#### M2-CAP-1: Genesis and root log

Implement genesis validation and deterministic reduction of chained grants,
revocations, root succession, validator floors, organizations, classes, and
reader history scopes.

#### M2-POLICY-1: Validation policy grammar

Support conjunctions of:

```text
at least N distinct validator capabilities
at least N capabilities in class C
at least one capability for each named organization
```

Reject percentage, weight, and hash-committee clauses in v0.1. Produce a
minimal satisfying proof deterministically for caching, while accepting any
valid satisfying set.

#### M2-RECOVERY-1: Two-of-three recovery

Implement detached recovery payload export, independent signatures, signature
combination, successor root/feed installation, timestamp-floor reopening, and
conflict diagnostics. One signature must never install a revision.

#### M2-KEYS-1: Key-store abstraction

Define create, load, sign/open, list, rotate, export-public, and delete-reference
operations. Provide:

- An encrypted development-file provider.
- A mock provider for deterministic tests.
- Interfaces for macOS Keychain, Windows DPAPI/CNG, Linux secret service or
  hardware-backed implementations.

Private keys must not appear in ordinary logs or serialized error objects.

#### M2-HPKE-1: Epoch manifests

Implement content-key generation, per-reader HPKE wrapping, associated data,
epoch rotation, reader revocation, snapshot scope, audit scope, and manifest
verification. Exercise a group with multiple devices per person and independent
device revocation.

### Tests

- Randomized capability-log replay yields one state under every delivery order
  consistent with the log chain.
- Newly granted validators cannot attest below their inherited floor.
- Prospective revocation does not invalidate earlier valid attestations.
- Any two recovery keys succeed; zero or one fails.
- Wrong group, epoch, recipient, associated data, or ciphertext fails open.
- Snapshot readers cannot unwrap historical epochs without an audit grant.

### Exit criteria

- Capability snapshots have stable hashes and error codes.
- Policy evaluation never relies on a globally fixed validator set.
- Recovery can replace a lost root and capability-log feed without validators.
- Epoch rotation and history scopes pass the multi-device scenario suite.

## 8. Milestone 3 — Admission and ordering simulator

### Objective

Prove convergence and watermark semantics using an in-memory operation-set
model before introducing database or network behavior.

### Work items

#### M3-STORE-1: In-memory event store

Store candidates, payload presence, attestations, heartbeats, capability
revisions, recovery events, feed continuity, and local visibility.

#### M3-ADMIT-1: Admission state machine

Derive `waiting_for_payload`, `pending_validation`, `admissible`,
`invalid_protocol`, `unauthorized`, and `quarantined`. Prove that additional
valid attestations do not remove admission or alter order.

#### M3-ORDER-1: Sorted operation set

Maintain the immutable ordered set, detect the earliest changed position, and
produce append or replay deltas. Duplicate delivery must be a no-op.

#### M3-WATERMARK-1: Heartbeats and evidence

Implement monotonic validator cutoffs, policy blocking-set calculation, feed
continuity requirements, unresolved attestation references, dynamic validator
floors, and history-reopening events.

#### M3-SIM-1: Network simulator

The simulator controls:

```text
participant clocks and clock uncertainty
message creation and visibility
partitions, delay, duplication and reordering
payload withholding and corruption
validator additions, revocations and recovery
feed gaps and forks
crash/restart boundaries
```

It must serialize failing random seeds as permanent scenario fixtures.

### Tests

- Thousands of randomized delivery permutations converge on admission and
  order.
- Later attestations never move a transaction.
- An already attested hidden transaction can appear below a watermark, but a
  newly attested one cannot use a timestamp at or below an honest blocking-set
  cutoff.
- Adding a correctly floored validator cannot reopen closed history.
- Explicit recovery reopening is surfaced in evidence.
- Percentage policies and undefined denominators are rejected.

### Exit criteria

- All model invariants pass deterministic seeded simulation.
- Every state transition and evidence field has a stable explanation code.
- The simulator can replay a production diagnostic trace without networking.

## 9. Milestone 4 — DoltLite reducer and materializer

### Objective

Turn a deterministic admitted order into a crash-consistent DoltLite database
and replay-derived transaction log.

### Work items

#### M4-ADAPTER-1: DoltLite adapter

Convert the milestone-0 proof into a supported package. Pin the engine build,
expose only approved calls, normalize errors, and report the exact execution
profile identifier.

#### M4-SANDBOX-1: SQL authorizer

Create allow/deny tables for statements, functions, pragmas, virtual tables,
Dolt functions, schema objects, and reserved namespaces. Apply byte, row,
step, recursion, statement-count, and result-size limits.

#### M4-PRECOND-1: Preconditions

Implement ordered typed-IR assertion and expectation evaluation, canonical
query-result modes, deterministic row-order proofs, result digests, and stable
failure attribution.

#### M4-REDUCE-1: Atomic reducer

Implement one top-level SQLite transaction per candidate, canonical IR
compilation, typed binding, complete rollback, accepted/rejected outcomes, and
protected insertion into `chronolog_transactions`. Invalid protocol inputs and
operational failures never receive a canonical log row.

#### M4-SCHEMA-1: Schema manifest

Create fresh databases from canonical schema IR, reserve the `chronolog_`
main-database prefix, protect system tables from shadowing, prohibit attached
companion databases, and pin the schema and execution-manifest digests. The
current prototype database is recreated rather than migrated.

#### M4-CHECKPOINT-1: Checkpoint manager

Map order prefixes to Dolt commits, build replay branches, publish a verified
head, retain pinned checkpoints, and collect orphan branches.

#### M4-REPLAY-1: Suffix replay

Coalesce insertions, find the earliest affected index, restore the nearest
prior checkpoint, replay the suffix, verify prefix metadata, and atomically
publish the new local revision.

#### M4-CRASH-1: Crash injection

Terminate the materializer at every durable boundary: before/after application
rollback, log insertion, checkpoint commit, revision-marker creation, atomic
`chronolog_head` move, query-pool switch, and branch cleanup.

### Tests

- Replay from every retained checkpoint equals replay from genesis.
- Every delivery permutation of an admitted set produces identical application
  tables and outcome logs.
- A late predecessor can change a dependent transaction from rejected to
  accepted and vice versa.
- A transaction can query preceding accepted and rejected log rows but cannot
  see itself or later transactions.
- Prohibited SQL, ambient functions, namespace mutation, multi-statement tails,
  and runaway execution are rejected deterministically.
- Query readers observe either the old published revision or the new one, never
  a partially replayed state.
- Restart always selects a verified published head.

### Exit criteria

- The reducer passes the canonical IR/compiler/execution-manifest suite.
- Append, replay, and crash recovery are deterministic on all primary release
  platforms.
- No convergence path invokes Dolt merge, pull, push, or revert.

## 10. Milestone 5 — SSB transport and payload integration

### Objective

Replace simulated delivery with durable SSB replication without changing
protocol-kernel results.

### Work items

#### M5-ADAPTER-1: Transport interface

Implement append, subscribe, fetch-by-ID, feed-range retrieval, peer progress,
gap detection, and close/reopen operations behind `transport-ssb`.

#### M5-ENVELOPE-1: SSB mapping

Map every Chronolog protocol payload to the classic SSB envelope, preserve
exact feed identity and sequence, enforce size bounds, and validate routing
headers before payload allocation.

#### M5-BLOB-1: Payload manifests

Implement inline thresholds, bounded chunking, content hashes, parallel fetch
limits, resumable download, cache eviction, decryption after assembly, and
corruption quarantine.

#### M5-INDEX-1: Durable ingestion

Persist stage cursors and idempotently populate `control.db`. Support complete
index deletion and reconstruction from SSB logs and keys.

#### M5-PEER-1: Peer and relay operation

Implement configured peers, invitations/bootstrap metadata, allow-listing,
reconnect backoff, relay mode, and operator-visible replication diagnostics.

#### M5-FORK-1: Feed integrity

Quarantine invalid sequences, missing predecessors, signature failures, and
fork evidence without poisoning unrelated feeds or groups.

### Tests

- Two and five process topologies converge after arbitrary partitions.
- Restart during each ingestion stage neither loses nor duplicates an event.
- Rebuilding `control.db` derives identical state.
- Missing payloads remain non-admitted and become eligible after retrieval.
- A ciphertext relay cannot materialize plaintext without reader keys.
- One malformed or forked feed does not halt healthy group replication.

### Exit criteria

- Live transport produces the same event-store state as the simulator for the
  same trace.
- Payload and feed backpressure remain bounded under adversarial peers.
- Relay operation requires no database or reader authority.

## 11. Milestone 6 — Integrated node and validator

### Objective

Deliver the first complete multi-node vertical slice, including validation,
heartbeats, replay, and node lifecycle.

### Work items

#### M6-NODE-1: Process supervision

Create configuration loading, directory locking, graceful shutdown, worker
supervision, bounded queues, health checks, startup recovery, and structured
logging.

#### M6-COORD-1: Revision coordinator

Connect ingestion deltas to admission, order, materialization, query-head
publication, and reactive event generation. Coalesce bursts so many late
transactions cause one replay from the earliest insertion point.

#### M6-WRITER-1: Candidate publication

Construct canonical drafts, obtain an author timestamp, encrypt the payload,
append payload chunks and the candidate message durably, and return `tx_id`.
Retries use an idempotency key and never publish a second candidate silently.

#### M6-VALIDATOR-1: Attestation worker

Implement eligibility discovery, envelope/resource validation, cutoff checks,
serialized journaled signing, feed reconciliation, publish-before-complete,
negative local diagnostics, and optional validation hints.

#### M6-HEARTBEAT-1: Heartbeat scheduler

Advance cutoffs using injected wall-clock and uncertainty sources. Persist the
exact heartbeat signing intent before feed append, then recover the durable
cutoff as the maximum observed in the validator feed and committed journal.
Pause on excessive uncertainty or stale signer state.

#### M6-EVIDENCE-1: Evidence engine

Assemble policy-relative blocking sets, heartbeat references, feed continuity,
unresolved references, current outcome, and recovery reopenings from one
control-store revision.

### End-to-end scenarios

1. Three validators admit a transaction and two reader nodes derive the same
   accepted state.
2. A hidden older spend arrives and changes the later transaction outcome.
3. Additional attestations arrive without changing order.
4. Heartbeats advance a watermark while no transactions are authored.
5. A newly added validator inherits the closed timestamp floor.
6. A validator crashes after signing preparation and before/after feed append;
   only the durably published case counts.
7. A validator restores stale local files and refuses to sign until reconciled.
8. A partition heals through ciphertext-only relays.

### Exit criteria

- Two independently persisted nodes converge after every scenario.
- Validator feed and cutoff state survive crash and backup/restore tests.
- The node exposes internal status sufficient to diagnose every pending state.
- This milestone is tagged as the first developer pre-alpha.

## 12. Milestone 7 — RPC and client libraries

### Objective

Expose safe application semantics without leaking storage or transport details.

### Work items

#### M7-RPC-1: API schemas

Define the directly edited services for status, typed query IR, live query,
transaction drafts, outcomes, evidence, membership, and snapshots. Document
success semantics for every call; retain no raw-SQL draft request shape.

#### M7-AUTH-1: Local authorization

Implement Unix socket/named pipe defaults, scoped client tokens, token rotation,
loopback TLS configuration, rate limits, request-size limits, and audit events
for privileged operations.

#### M7-DRAFT-1: Server-side drafts

Implement revision-pinned draft sessions, observed-read expectations, explicit
assertions, typed mutation-IR accumulation, expiry, rebase, cancellation,
canonical publication, and retry-safe request IDs.

#### M7-QUERY-1: Query and live query

Return revision metadata with every result. Initially rerun subscribed queries
after each published revision, canonicalize results, suppress unchanged
emissions, and provide reset snapshots after unrecoverable stream gaps.

#### M7-CLIENT-1: TypeScript client

Implement connection lifecycle, query types, transaction builder, async streams,
outcome handles, settlement evidence, retry classification, and cancellation.

#### M7-REACT-1: React hooks

Implement hooks for live query, transaction outcome, replication status, and
settlement evidence. Test React strict mode, remounting, cancellation, and
connection loss.

#### M7-CLI-1: User operations

Provide group create/join, query, transaction status, feed status, validator
watermark, capability, snapshot, recovery, and diagnostic commands.

### Tests

- Raw RPC clients cannot mutate application tables outside transaction drafts.
- Draft observations remain pinned across node revisions until explicit rebase.
- Publish acknowledgement is distinguishable from admission and relational
  transaction outcome.
- Live query emits exactly once per changed canonical result and identifies the
  corresponding revision.
- Streams reconnect or emit an explicit reset; they never silently skip a gap.
- Client retries do not duplicate candidates.
- Settlement evidence never collapses to an unconditional boolean.

### Exit criteria

- A sample application uses only `@chronolog/client` to create schema, transact,
  query reactively, and inspect evidence.
- RPC tests cover the one directly edited IR contract; no raw-SQL compatibility
  surface remains.
- The TypeScript client and CLI have generated API documentation.

## 13. Milestone 8 — Onboarding, recovery, and operations

### Objective

Make groups deployable and recoverable without weakening the protocol model.

### Work items

#### M8-SNAPSHOT-1: Snapshot export/import

Package the signed manifest, checkpoint, transaction prefix, membership state,
encryption references, and optional SSB suffix. Stream large archives and
verify every component before publication.

#### M8-ONBOARD-1: Reader onboarding

Implement snapshot-reader and audit-reader flows, device HPKE grants, history
key delivery, capability display, and explicit trusted-anchor recording.

#### M8-RECOVERY-1: Offline recovery tooling

Export a deterministic recovery payload, sign on isolated devices, combine two
signatures, relay the record through any peer, switch capability-log feeds, and
surface history reopening.

#### M8-BACKUP-1: Backup and restore

Define separate procedures for:

- Replicable SSB/control/state data.
- Non-replicable device and epoch keys.
- Validator feed/cutoff state, which must never roll back.
- Offline recovery keys.

Validator restore must detect stale feed/cutoff state and fail closed.

#### M8-PACKAGE-1: Distribution

Build platform packages, Linux containers, npm clients, checksums, signatures,
SBOMs, fresh-group tooling, sample configurations, and recovery/rollback docs.

#### M8-OBS-1: Operations surface

Finalize redacted structured logs, metrics, health/readiness endpoints, disk
alerts, replay diagnostics, feed-gap tooling, and validator clock monitoring.

### Tests

- Snapshot reader materializes the trusted checkpoint and follows new events.
- Audit reader independently verifies history.
- Snapshot corruption or wrong authority never changes the published head.
- Two recovery signatures restore a group with no active administrator or
  validator; one cannot.
- All supported upgrade paths preserve keys, feed heads, cutoffs, event sets,
  outcomes, and published revisions.
- Restoring an old validator backup cannot produce a new valid attestation.

### Exit criteria

- A clean machine can join through both reader onboarding modes.
- An operator can backup, destroy, and restore a non-validator node.
- Validator recovery procedures are documented and fail closed when continuity
  cannot be proven.
- Release artifacts install and pass smoke tests on supported platforms.

## 14. Milestone 9 — Hardening and v0.1 release

### Objective

Establish that the implementation satisfies protocol invariants under hostile
input, failure, scale, and cross-platform execution.

### Work items

#### M9-FUZZ-1: Parser and API fuzzing

Continuously fuzz CBOR, SSB envelopes, payload manifests, capability records,
snapshot archives, SQL preparation boundaries, and RPC decoders. Seed corpora
with all conformance and regression fixtures.

#### M9-FAULT-1: Distributed fault suite

Automate process kill, disk-full, partial write, permission loss, corrupt local
index, clock jump, network partition, duplicate delivery, feed gap, payload
withholding, and stale backup scenarios.

#### M9-DETERMINISM-1: Cross-platform replay

Replay the same large admitted transaction corpus on every supported platform
and compare canonical application exports, transaction logs, outcomes, and
schema metadata. Dolt commit hashes are not compared unless separately proven
deterministic.

#### M9-PERF-1: Performance characterization

Measure:

```text
steady append throughput and latency
query latency during append and replay
late insertion cost by checkpoint distance
checkpoint time and disk amplification
SSB ingest and payload retrieval throughput
live-query rerun cost
startup, rebuild and snapshot import time
memory under pending payload and subscription pressure
```

Publish measured operating envelopes rather than unsupported capacity claims.

#### M9-SEC-1: Security review

Review cryptographic usage, domain separation, key storage, recovery,
capability transitions, RPC authentication, SQL sandboxing, archive extraction,
native boundary safety, secret redaction, dependency provenance, and validator
rollback prevention. Resolve all critical and high findings before release.

#### M9-DOC-1: Documentation

Complete protocol mapping, deployment guide, client tutorial, validator
operations, membership/recovery ceremony, snapshot trust explanation, threat
model, troubleshooting, manifest/conformance policy, and contribution guide.

### Release gates

- Required protocol and SQL conformance suites pass on every supported platform.
- No known critical/high security issue remains open.
- Randomized delivery, crash, and network suites pass their agreed sustained
  CI runs without an unexplained seed.
- Cross-platform replay produces identical canonical results.
- Upgrade, backup, restore, recovery, and snapshot drills pass from packaged
  artifacts.
- Performance envelopes and resource defaults are documented.
- A release candidate operates in a multi-node pilot before v0.1.0.

## 15. Test architecture

### 15.1 Test levels

| Level | Scope | Typical trigger |
|---|---|---|
| Unit | Pure functions and adapters | Every change |
| Conformance | Canonical protocol and SQL fixtures | Every change |
| Property | Ordering, policy, replay invariants | Every change, bounded |
| Integration | DoltLite, SSB, RPC, crypto | Every change on primary OS |
| Scenario | Multi-node partitions and recovery | Merge and nightly |
| Fault | Crash, disk and clock injection | Nightly |
| Fuzz | Parser/native boundaries | Continuous/nightly |
| Cross-platform | Identical corpus replay | Release candidates |
| Performance | Operating envelope and regressions | Scheduled/release |

### 15.2 Core invariant suite

Every release must demonstrate:

- Same admitted event set implies the same total order.
- Same order and execution profile imply the same database and outcome log.
- Attestation arrival never changes order.
- Replay from a checkpoint equals replay from genesis.
- Transaction preconditions see exactly their preceding log prefix.
- Rejected transactions remain visible to later preconditions.
- New honest validation cannot cross a published cutoff.
- Dynamic validators cannot reopen history without explicit recovery.
- Published database heads are crash atomic.
- Direct application mutation cannot bypass transaction construction.
- Invalid data cannot cause unbounded allocation or execution.

### 15.3 Scenario fixture format

Each distributed regression fixture records:

```text
genesis and keys represented by deterministic test identities
participant roles and clock policies
authored messages and payloads
delivery visibility timeline
clock, partition, crash and recovery actions
expected admission, order, outcome and evidence at checkpoints
random seed and simulator version
```

Production diagnostics may export a redacted fixture containing identifiers and
hashes but no plaintext SQL, parameters, or private keys.

## 16. Security and review gates

Changes require additional review when they affect:

- Canonical encoding, hashing, signing, ordering, or identifiers.
- Capability or recovery semantics.
- Validator cutoff persistence or feed publication.
- SQL allow-lists, authorizer callbacks, limits, or error classification.
- Materialized-head publication and crash recovery.
- Key storage, epoch rotation, snapshot trust, or historical access.
- RPC authentication or privileged scopes.
- Native C/N-API boundaries.

Consensus-relevant changes require new vectors and a protocol version decision.
Security-sensitive changes require a threat-model note and negative tests.

## 17. Risk register and decision gates

| Risk | Earliest gate | Required response |
|---|---|---|
| Missing DoltLite sandbox APIs | M0 | Add narrow shim or revise runtime choice |
| Non-atomic branch/head publication | M0/M4 | Fault-test the atomic `chronolog_head` ref move and startup verification |
| SSB feed/payload limitations | M0/M5 | Adapt envelope/blob transport behind interface |
| SSB dependency stagnation | M5 | Maintain pinned fork or replace adapter only |
| SQL cross-platform drift | M4/M9 | Narrow profile and pin engine/build further |
| Replay cost too high | M4/M9 | Coalesce, adapt checkpoints, limit open history |
| Native packaging unreliable | M0/M8 | Ship controlled native artifacts and smoke tests |
| HPKE library unsuitable | M0/M2 | Bind a reviewed implementation behind crypto API |
| Validator backup rollback | M6/M8 | Fail closed; require feed reconciliation/rekey |
| Snapshot trust misunderstood | M7/M8 | Make trust anchor explicit in API and UI |

Architecture changes resulting from these gates are recorded as decision
records and reflected in both implementation and protocol documents.

## 18. Release progression

### Developer pre-alpha

Reached at M6: command-line multi-node convergence works, but APIs and storage
formats may change.

### Alpha

Reached at M7: TypeScript applications can use stable-enough RPC and reactive
clients; deployment remains experimental.

### Beta

Reached at M8: onboarding, recovery, packaging, upgrades, and operations are
available for pilot groups.

### First released format

Reached only after M9 release gates. Compatibility policy begins only when a
format is actually released; it is not implemented for the present prototype.

## 19. Immediate next actions

The initial scaffold above is implemented. The current work queue is the direct
cutover in [the detailed delivery specification](implementation-specs/09-conformance-delivery.md):

1. Add canonical/IR/compiler/kernel/conformance package skeletons.
2. Extract canonical primitives and implement logical values.
3. Implement schema IR and canonical schema creation.
4. Add the execution manifest and per-candidate top-level transactions.
5. Edit `TransactionCore`, node drafts, RPC, and client APIs directly to IR.
6. Recreate fixtures, databases, SSB test groups, CLI examples, and tests.
7. Complete JSON and then run the FTS/sqlite-vec feature gates.

## 20. References

- [Chronolog DB protocol design](design.md)
- [Deterministic runtime implementation specifications](implementation-specs/README.md)
- [Chronolog DB implementation design](implementation-design.md)
- [DoltLite](https://github.com/dolthub/doltlite)
- [SSB-DB2](https://github.com/ssbc/ssb-db2)
- [Secure Scuttlebutt specification](https://spec.scuttlebutt.nz/)
