# Chronolog DB Implementation Design

Status: Historical implementation background. The SQL-first runtime is defined
by the [implementation specification suite](implementation-specs/README.md).

Date: 2026-07-13

This document translates the [protocol design](design.md) into an executable
software architecture. The accompanying [implementation plan](implementation-plan.md)
defines the original scaffold delivery sequence. The
[deterministic runtime implementation specifications](implementation-specs/README.md)
define the direct replacement now being implemented.

## 1. Scope

The first implementation must provide:

- A long-running replica node that can act as a reader, writer, validator,
  relay, or any permitted combination.
- Secure Scuttlebutt replication of candidates, attestations, heartbeats,
  capabilities, recovery events, and encryption-epoch metadata.
- Deterministic admission, ordering, signed SQL reduction, checkpointing, and suffix
  replay.
- A local API for typed/local SQL reads, typed transaction construction, reactive queries,
  outcomes, membership administration, and settlement evidence.
- A framework-neutral TypeScript client, React bindings, and an administration
  CLI.
- Reproducible protocol test vectors and a network simulation harness.

The first implementation does not include native Swift or Kotlin replicas,
browser-to-browser production replication, validator state voting, Dolt state
merges, or a public unauthenticated SQL server.

## 2. Architectural principles

1. **One node implementation, multiple roles.** Reader, writer, validator, and
   relay behavior are capability-controlled modules in the same daemon.
2. **Replicated operations are authoritative.** SSB messages and referenced
   payloads are the source of truth. Control indexes and DoltLite state can be
   rebuilt from them.
3. **Only the node implements protocol semantics.** Client libraries do not
   independently order, validate, encrypt, or replay transactions.
4. **Application writes are transactions, never raw database writes.** All
   mutations pass through canonical construction, mandatory preconditions,
   signing, validation, and replay.
5. **One deterministic reducer writer.** A serialized materializer owns all
   changes to the published database head.
6. **Published revisions are immutable observations.** Queries and stream
   emissions always identify the revision against which they were evaluated.
7. **Transport and storage have narrow adapters.** The protocol kernel must be
   testable without SSB, DoltLite, wall clocks, or operating-system key stores.
8. **No hidden consensus.** Local checkpoints, RPC acknowledgements, relay
   availability, and cache bundles never acquire protocol authority.

## 3. System overview

```text
 Applications
      |
      | local authenticated streaming RPC
      v
+---------------------------------------------------------------+
| chronologd                                                    |
|                                                               |
|  RPC/API        transaction builder       reactive publisher  |
|      |                  |                         ^            |
|      v                  v                         |            |
|  query broker      protocol kernel       revision coordinator |
|      |                  |                         ^            |
|      |          admission + order                |            |
|      |                  |                         |            |
|      +----------> materializer actor ------------+            |
|                         |                                      |
|                      DoltLite                                  |
|                                                               |
|  capability log   crypto/key manager   validator/heartbeat    |
|          \              |                    /                |
|           +---------- SSB adapter ----------+                 |
+--------------------------|------------------------------------+
                           v
                  SSB peers and relays
```

Every participating device normally runs one `chronologd`. Applications on
that device use a local client library. Multiple non-authoritative relay or
bootstrap nodes are recommended for availability, but they do not determine
membership, order, admission, or SQL state.

## 4. Technology baseline

### 4.1 Runtime and language

The v0.1 node and primary libraries use TypeScript on a pinned supported Node.js
LTS release. The repository is a `pnpm` workspace with strict TypeScript
settings and reproducible lockfiles.

This choice minimizes integration risk: SSB-DB2 is a Node/Secret Stack plugin,
while DoltLite exposes the SQLite C API and documents Node/Bun and WASM
distributions. The protocol kernel remains free of Node-only APIs except behind
interfaces so future implementations can share the same conformance vectors.

### 4.2 DoltLite

The daemon uses the native DoltLite binding for persistent materialization. A
small narrow adapter exposes only the operations Chronolog requires:

```text
open and close database
prepare, bind, step, and interrupt SQL
set authorizer and resource limits
begin, commit, and rollback
create and resolve checkpoints
create, switch, and delete replay branches
publish a materialized head
inspect engine, native-build, manifest, and schema identities
```

Opening a materializer requires an explicit persistent path. In-memory or
plain-SQLite fallbacks cannot preserve the head, revision, and checkpoint refs
that make publication and restart recovery well-defined.

The adapter deliberately does not expose merge, pull, push, or arbitrary Dolt
administration to the reducer or clients. The DoltLite WASM package is reserved
for a later embedded-browser mode.

### 4.3 Secure Scuttlebutt

SSB-DB2 supplies the local append-only transport log, feed verification,
indexes, and peer replication. Chronolog uses a narrow adapter rather than
exposing Secret Stack APIs throughout the daemon.

The initial transport uses ordinary SSB feed envelopes whose content contains
a small visible Chronolog routing header and a base64 representation of the
binary protocol payload. Deterministic CBOR remains the protocol encoding; the
SSB envelope follows its own feed-format signing rules.

A custom binary SSB feed format is deferred until measurements show that the
classic envelope is a material cost.

### 4.4 RPC

The local API is described by directly edited structured schemas. The first
transport supports streaming RPC over a Unix-domain socket on Unix, a named
pipe or loopback socket on Windows, and authenticated loopback TCP when local
IPC is unavailable.

RPC serialization is not a consensus format. Protocol Buffers may evolve
independently of the deterministic CBOR wire structures after the first release.
During the current prototype, client and server schemas change together and no
compatibility layer is retained.

## 5. Repository layout

```text
apps/
  chronologd/                 daemon entry point and process lifecycle
  chronolog/                  CLI entry point

packages/
  canonical/                  deterministic CBOR, bytes, UTF-8 and hashing
  ir/                         values, schema, expressions, queries and mutations
  compiler-sqlite/            validation and canonical DoltLite lowering
  kernels/                    integer, decimal, JSON, entropy and vector kernels
  protocol/                   signed messages, order and transport identities
  capabilities/               genesis, grants, revocations, policies, recovery
  crypto/                     HPKE epochs, manifests and key-store interfaces
  transport-ssb/              SSB-DB2 and peer-management adapter
  control-store/              rebuildable protocol indexes and cursors
  materializer-doltlite/      deterministic reducer and checkpoint management
  node-core/                  orchestration, queues and revision coordination
  rpc/                        Protobuf schemas and generated bindings
  client/                     framework-neutral TypeScript client
  react/                      React hooks and subscription integration
  testkit/                    fake clocks, feeds, networks and fault injection
  conformance/                fixtures, reference evaluator and replay harness

packages/conformance/fixtures/
  protocol/                   canonical bytes, digests and signatures
  ir/                         values, schemas, programs and renderer plans
  kernels/                    numeric, JSON, FTS, vector and WASM cases
  replay/                     checkpoint, crash and delivery scenarios
```

Package imports form a directed graph. In particular, `protocol` imports no
transport, database, RPC, client, or process package.

## 6. Runtime roles

### 6.1 Reader node

A reader node receives encryption-epoch keys, decrypts candidates, validates
admission proofs, materializes SQL state, serves queries, and reports evidence.

### 6.2 Writer node

A writer additionally owns an authorized per-group feed key and may construct
and publish transaction candidates. Transaction creation remains available
while disconnected from peers.

### 6.3 Validator node

A validator additionally runs the admission worker and heartbeat scheduler. It
must reconcile its SSB feed sequence and acceptance cutoff, then durably journal
each signing intent before publication. Validators are readers in v0.1 because
they must decrypt and inspect the canonical candidate envelope and resource
declarations.

### 6.4 Relay/bootstrap node

A relay helps peers discover one another and replicates authorized feed data.
It need not possess reader keys and may store only ciphertext. Relay status
confers no membership or validation authority.

### 6.5 Administration and recovery

An administrator uses the same node and CLI to create capability-log records.
Offline recovery signing is supported as a detached CLI operation so recovery
keys never need to be installed in the running daemon.

## 7. Persistent storage

### 7.1 Data directory

```text
data/
  identity/
    device.json                 public identity metadata
    keystore.ref                operating-system key-store references
  groups/<group-id>/
    ssb/                        SSB-DB2 log and indexes
    control.db                  rebuildable protocol control store
    state.db                    DoltLite materialized database
    payloads/                   encrypted payload/blob cache
    snapshots/                  imported and exported snapshot manifests
    runtime/                    locks, sockets and transient branch metadata
```

Private keys are not stored directly in configuration files. The key-store
interface supports operating-system secure storage, hardware-backed keys where
available, and an encrypted-file provider for development.

### 7.2 Source-of-truth classification

| Data | Authority | Rebuildable |
|---|---|---|
| SSB feed messages | Replicated protocol source | No |
| Candidate payload blobs | Content-addressed protocol source | Fetchable |
| Control indexes | Local derived state | Yes |
| DoltLite application tables | Local materialized state | Yes |
| `chronolog_transactions` | Local replay-derived log | Yes |
| DoltLite commits/branches | Local checkpoints | Yes |
| Private device and epoch keys | Local secret state | No |
| Proof bundles | Non-authoritative cache | Yes |

### 7.3 Control store

`control.db` is separate from the replayed application database. It stores:

```text
parsed message headers and verification state
candidate-to-payload references
attestation indexes
capability revisions and derived grants
admission status and satisfying proof references
immutable transaction ordering keys
feed continuity, gaps and fork quarantines
validator cutoffs and heartbeat cursors
cached published revision and checkpoint-ref map
ingestion errors and retry state
```

It may use a separate DoltLite/SQLite file through the same database adapter,
but it never participates in application rewind. Every table has a rebuild
path from SSB data plus local key material.

## 8. Protocol kernel

The protocol package implements pure functions over bytes and explicit context:

```text
encode and decode deterministic CBOR
calculate domain-separated SHA-256 digests
sign and verify Ed25519 structures
validate transaction, attestation, heartbeat and capability schemas
derive transaction IDs and immutable order keys
evaluate absolute capability policies
verify recovery records
assemble and verify admission proofs
classify protocol errors with stable codes
```

No function reads the ambient wall clock, filesystem, network, random source,
or database. Callers provide those dependencies explicitly.

JavaScript `number` is not used for signed 64-bit SQL integers, feed sequence
numbers, or protocol timestamps. Those values use `bigint` internally and
range-checked canonical encodings. Binary64 SQL values are carried as their
exact eight-byte bit pattern. Byte ordering uses unsigned lexicographic
comparison, not locale-aware strings.

Generated fixtures contain the canonical bytes, digest, signature, decoded
value, and expected error for malformed variants. Any future language
implementation must pass these fixtures before joining a group.

## 9. SSB transport integration

### 9.1 Message envelope

The initial SSB content shape is conceptually:

```text
type: chronolog-envelope/v1
group_route: opaque group routing identifier
message_type: candidate | attestation | heartbeat | capability | recovery | ...
encryption_epoch: epoch identifier or null
payload_digest: SHA-256 commitment
payload_inline: base64 bytes or null
payload_manifest: content-addressed blob manifest or null
```

The payload is deterministic CBOR, optionally encrypted. Small payloads are
inline. Larger candidates use a content-addressed blob manifest whose chunks
can be fetched independently. The candidate feed message remains `tx_id`; the
manifest commits to the exact encrypted payload, and the decrypted
`candidate_digest` commits to the canonical transaction core.

A candidate cannot become admissible until the entire payload is present,
decrypted, and verified. Missing chunks produce the local ingestion state
`waiting_for_payload`, not a canonical transaction outcome.

### 9.2 Ingestion pipeline

```text
SSB message persisted
  -> feed continuity and fork check
  -> envelope size and schema check
  -> payload resolution
  -> decryption and digest verification
  -> canonical protocol decoding
  -> signature and capability validation
  -> control-store index update
  -> admission/order delta
  -> materializer notification
```

Every stage is idempotent. The durable SSB append completes before the message
enters the pipeline. Restart resumes from stored feed and index cursors.

### 9.3 Peer management

The adapter supports configured peers, invitation/bootstrap records, reconnect
backoff, feed allow-lists, replication progress, and feed-gap retrieval.
Protocol correctness never depends on peer arrival order.

### 9.4 Validator discovery

Validators automatically inspect newly discovered eligible candidates and
publish attestations when local policy permits. A writer may send a direct
`validation-hint(tx_id)` to reduce latency, but the hint is neither required
nor authoritative.

## 10. Capabilities and encryption

### 10.1 Capability log

The capability component reduces the root capability log into immutable
membership revisions. It verifies root succession, grants, revocations,
validator timestamp floors, reader history scopes, and two-of-three recovery.

The derived capability snapshot is cached in `control.db`. Transactions pin a
policy revision; later revisions do not reinterpret existing attestations.

### 10.2 Key hierarchy

Separate keys are used for:

- SSB/Ed25519 feed signing.
- Offline recovery signatures.
- HPKE reader-device recipients.
- Symmetric transaction content encryption per group epoch.
- Optional local storage encryption.

Ed25519 feed keys are never mechanically reused as HPKE recipient keys.

### 10.3 Epoch management

The active administrator creates a random epoch content key, wraps it to every
authorized reader HPKE key, and publishes a signed epoch manifest. Nodes retain
only the historical keys their reader scope permits. Revocation rotates the
active epoch but cannot erase keys or plaintext already obtained.

Snapshot readers import a signed snapshot manifest and current epoch material.
Audit readers may fetch historical envelopes and validate from genesis.

## 11. Admission and ordering

The admission index consumes verified candidates, attestations, capabilities,
and policies. Each candidate is in one local state:

```text
waiting_for_payload
pending_validation
admissible
invalid_protocol
unauthorized
quarantined
```

Admission is monotonic except when an explicit recovery/fraud rule creates a
new protocol interpretation. Ordinary revocation prevents new attestations but
does not remove proofs valid when their attestations were published.

Admissible transactions are stored in a sorted index by:

```text
(author_timestamp_ms, author_id, author_feed_sequence, tx_id)
```

Adding attestations cannot modify this key. A new admissible transaction
produces either an append delta or an insertion delta identifying the earliest
affected order position.

## 12. Deterministic relational reducer

The [Chronolog deterministic SQL dialect and relational IR](sql-dialect.md) is
implemented directly by replacing the unreleased raw-SQL transaction path.
There is no compatibility reducer or stored-data migration. The complete
subsystem design is in the
[implementation specification suite](implementation-specs/README.md). The
authorizer remains defense in depth for canonically compiled IR.

### 12.1 Backend authorizer enforcement

The DoltLite adapter must expose SQLite authorizer, progress-handler, statement
tail, and resource-limit functionality. The reducer uses them to:

- Permit only statements generated by the pinned compiler/manifest profile.
- Deny ambient time, randomness, filesystem, network and extension access.
- Deny direct Dolt branch, merge, remote and checkpoint functions.
- Reserve all `chronolog_` main-database objects against shadowing or mutation.
- Deny `ATTACH`; the replay-visible log and materializer metadata live on the
  active Dolt branch rather than in a companion database.
- Enforce statement, memory, recursion and execution-step limits.
- Ensure each generated plan statement contains exactly one prepared SQL
  statement with no non-trivia tail.

If the official Node binding does not expose the required controls, the project
will add a minimal N-API shim rather than substituting string-based SQL
filtering.

### 12.2 Transaction execution

For each transaction, the reducer:

1. Parses and validates the exact signed SQL and canonical bindings against the
   pinned execution manifest and current prefix catalog.
2. Opens a top-level SQLite transaction for that candidate.
3. Evaluates mandatory assertion/expectation SQL preconditions in order.
4. Executes the ordered SQL body, including DDL, DML, and bounded results.
5. Appends the accepted `chronolog_transactions` row and commits atomically.
6. On deterministic rejection, fully rolls back and writes only the rejected
   row in a fresh top-level transaction.
7. On operational failure, aborts replay without deriving an outcome.

The transaction-log row is visible to later transactions even when application
changes were rejected. During evaluation, only the already replayed prefix is
present. Because the protected log is a main-database table, each Dolt
checkpoint commits the application state and matching outcome-log prefix as a
single versioned snapshot.

### 12.3 Schema construction and evolution

Fresh groups start with an empty application schema. Ordinary replicated SQL
DDL creates and evolves it in the same atomic body as data changes. The schema
at a prefix is restored by the selected checkpoint and replayed suffix; there
is no authoritative schema artifact or schema digest.

## 13. Materialization and checkpoints

### 13.1 Materializer actor

One actor serializes all changes to `state.db`. Network ingestion, RPC handlers,
and validators never write it directly. The actor accepts coalesced event-set
deltas and publishes monotonically increasing local revision identifiers.

### 13.2 Append path

When all newly admissible transactions follow the published head, the actor
creates a disposable candidate branch from `chronolog_head`, executes them
sequentially, records outcomes, commits, verifies, and publishes one new
revision through the same branch-move procedure used after replay.

### 13.3 Insertion/replay path

For an insertion at order position `k`:

1. Coalesce all currently queued admission changes.
2. Locate the nearest retained `chronolog_cp_...` prefix at or before `k`.
3. Create and check out a disposable `chronolog_replay_...` branch from that
   commit.
4. Replay the complete suffix, updating application tables and
   `chronolog_transactions` together.
5. Commit and verify the candidate's log length, order digest, and reducer
   invariants.
6. Create an immutable checkpoint branch when required by policy.
7. Create the new `chronolog_rev_...` revision marker at the verified commit.
8. Open a verification reader pinned to that immutable revision marker.
9. Atomically force-move `chronolog_head` to the verified commit.
10. Swap the query broker to the verified reader, publish the local revision,
    and only then retire the old reader and delete the disposable branch and
    superseded revision marker.

No Dolt merge or state merge is used. Hard reset is limited to discarding a
failed or crash-orphaned disposable working set; it is never the publication
operation.

### 13.4 Atomic publication and crash recovery

`chronolog_head` is the durable publication pointer. A crash before its atomic
force-move leaves the previous commit authoritative. A crash after the move
causes startup to select the new commit, even if cleanup did not run.

Startup checks out `chronolog_head`, requires exactly one matching
`chronolog_rev_r<revision>_p<prefix>_<digest>` marker, and verifies the committed
transaction-log length and order digest before serving queries. It discovers
checkpoint branches from the Dolt ref graph rather than trusting a separate
metadata database, then removes orphan replay and revision branches only after
head validation succeeds.

### 13.5 Checkpoint policy

Checkpoint branches are immutable refs to already verified commits. The public
checkpoint descriptor records its prefix length, branch ref, Dolt commit hash,
content hash, and creation revision. The initial implementation creates a
checkpoint after a configurable transaction count and retains:

- Genesis.
- The most recent configured number of checkpoint prefixes.
- The latest published head through the separate `chronolog_head` ref.

Checkpoint tuning affects performance and disk use, never protocol results.

## 14. Query broker and reactive revisions

The query broker serves only a fully published revision. Each response includes:

```text
group_id
local_revision
published_order_length
schema_digest
rows or canonical result digest
```

An in-flight query may finish against its pinned old revision while a replay is
building. New queries switch to the new head only after atomic publication.

The initial `liveQuery` implementation reruns every registered query after a
published revision and emits only when its canonical result changes. Query-to-
table dependency tracking and incremental maintenance are later optimizations.

## 15. RPC surface

The initial service groups are:

```text
NodeService
  GetStatus
  StreamStatus

QueryService
  Query
  LiveQuery

TransactionService
  BeginDraft
  Observe
  AddAssertion
  AddExpectation
  AddStatement
  PublishDraft
  GetOutcome
  StreamOutcome

EvidenceService
  GetSettlementEvidence
  StreamSettlementEvidence

MembershipService
  GetRevision
  ListCapabilities
  ProposeCapabilityRecord
  ExportRecoveryPayload
  ImportRecoveryRecord

SnapshotService
  ExportSnapshot
  ImportSnapshot
```

RPC errors distinguish transport failure, local node state, protocol rejection,
and derived transaction outcome. A successful `PublishDraft` means the
candidate was durably appended locally; it does not mean admissible, accepted,
replicated, or settled.

### 15.1 Authentication

The daemon binds locally by default and creates scoped client tokens. Scopes
separate query, transaction, membership, validator diagnostics, snapshot, and
recovery operations. Remote TCP requires mutually authenticated encryption and
is disabled by default.

### 15.2 Prototype API replacement

The unreleased RPC and client APIs are edited directly. Raw-SQL draft methods
are deleted and replaced with canonical IR methods; there are no deprecated
aliases, dual request shapes, or compatibility adapters. Existing generated
fixtures and development clients are updated together.

## 16. Client libraries

### 16.1 Framework-neutral client

`@chronolog/client` owns connection management, typed parameter conversion,
draft construction, retry-safe request IDs, async iterators/observables, and
revision-aware errors. It does not hold group signing or encryption keys.

### 16.2 Transaction builder

A draft is pinned to the local revision at `BeginDraft` and receives a reserved
transaction timestamp and nonce. `Observe` runs typed query IR at that revision
and stores its canonical expected result. Assertions and mutation IR are
accumulated on the daemon, which validates and signs the canonical candidate on
publication.

```ts
const handle = await db.transaction(async (tx) => {
  const account = await tx.observe(
    accounts.where(eq(accounts.id, aliceId))
      .select({ balance: accounts.balance })
      .scalar(),
  )

  tx.expect(account)

  tx.update(accounts, eq(accounts.id, aliceId), {
    balance: sub(accounts.balance, int64(10n)),
  }, { affectedRows: exactly(1) })
})
```

The application may explicitly choose a newer revision and rebase the draft,
but the library never silently changes captured observations.

### 16.3 Reactive APIs

The client exposes:

```text
liveQuery(query_ir, parameters)
queryLocalSql(sql, parameters)
transaction(builder)
transactionOutcome(tx_id)
settlementEvidence(tx_id)
validatorWatermark()
replicationStatus()
```

Streams reconnect from the last observed local revision. If retained history
cannot bridge a gap, the server emits a reset snapshot rather than pretending
no updates were missed.

### 16.4 React package

`@chronolog/react` provides hooks over the framework-neutral client. Hooks must
surface loading, disconnected, replaying, rejected, provisional, and evidence
states rather than collapsing them into a single success boolean.

### 16.5 Future native clients

Swift and Kotlin libraries should initially wrap generated RPC clients. An
embedded native replica is a separate later project and must pass the protocol
and reducer conformance suites.

## 17. Node concurrency model

The main process owns RPC, peer connections, and supervision. Dedicated workers
handle:

- Protocol decoding and cryptographic verification.
- Materialization and DoltLite access.
- Optional payload compression and snapshot packaging.

State-changing commands flow through bounded queues. Backpressure pauses SSB
index consumption before memory becomes unbounded. Read APIs report replay and
index lag explicitly.

All commands use idempotency keys or immutable message IDs. Retrying ingestion,
attestation publication, draft publication, replay, or subscription delivery
must not duplicate authoritative effects.

## 18. Validator implementation

The validator worker processes eligible candidates in feed order but may
complete independent cryptographic checks concurrently. Signing is serialized
through a crash-safe journal because the control store and SSB log cannot share
one atomic transaction:

1. Reconcile the signer journal with the durable validator feed and recover the
   maximum published cutoff.
2. Reload the current capability, feed head, and cutoff.
3. Verify candidate envelope and resource policy without parsing SQL.
4. Confirm the author timestamp exceeds the durable cutoff and capability
   floor and is within the configured future bound.
5. Construct the exact attestation and durably write its signing intent,
   expected feed sequence, and content digest.
6. Append that exact message to the validator SSB feed and wait for durable
   persistence.
7. Mark the journal entry committed and only then report success.

On restart, an intent missing from the feed is either completed with the exact
journaled bytes or abandoned without reusing its signing state; a feed message
missing a committed marker is recovered from the feed. The heartbeat scheduler
uses the same journaled signer and feed writer. Clock uncertainty pauses cutoff
advancement and validation but never lowers the recovered cutoff.

## 19. Settlement evidence

Evidence is calculated from a consistent control-store revision. The node
returns the pinned validation policy, membership revision, transaction order
key and outcome, policy-relative watermark, blocking-set heartbeat references,
feed continuity, unresolved candidate references, and history-reopening events.

The API may calculate convenience labels from an application-supplied policy,
but stored protocol state never contains an unconditional `settled` flag.

## 20. Snapshots and onboarding

Snapshot export creates:

```text
signed snapshot manifest
DoltLite checkpoint package or content-addressed reference
transaction-prefix identity and schema version
membership and encryption epoch references
optional suffix of SSB messages after the anchor
```

Snapshot import verifies the authority signature, hashes, capability revision,
and checkpoint structure before publishing it locally. Snapshot readers record
the trusted anchor in settlement evidence. Audit readers obtain historical keys
and replay or verify from genesis.

Snapshots accelerate onboarding but do not replace SSB transactions as the
source of future truth.

## 21. Observability and operations

The daemon emits structured logs without plaintext SQL parameters or key
material by default. Metrics include:

```text
SSB feed and byte lag
payloads waiting for retrieval or decryption
pending and admissible candidate counts
attestation and heartbeat publication latency
validator cutoff and policy watermarks
materialized order length and revision
replay start position, suffix length and duration
checkpoint count, age and disk use
live-query count and rerun duration
RPC error counts by stable category
```

The CLI provides status, feed-gap, proof, ordering, replay, capability,
heartbeat, snapshot, and key-epoch diagnostics. It must redact secrets unless an
explicit unsafe diagnostic mode is selected.

## 22. Distribution and deployment

The initial release produces:

- Standalone `chronologd` binaries or platform packages with native DoltLite.
- A `chronolog` CLI.
- Signed container images for Linux server/validator deployments.
- Published TypeScript client and React packages.
- Protocol fixtures and a conformance runner.

A typical group operates participant nodes plus two or more replaceable
bootstrap/relay instances. Validators should use durable disks, protected keys,
reliable time sources, and backup procedures that preserve their latest SSB
feed and cutoff state.

## 23. Security boundaries

The implementation treats the following as untrusted:

- All replicated messages and payload blobs before verification.
- Canonical IR, logical values, local SQL text, and schema definitions.
- Client RPC input, even over a local socket.
- Snapshot archives and proof bundles.
- Author and peer wall-clock claims.
- Relay availability and message ordering.

Critical protections include bounded decoding, canonical re-encoding checks,
cryptographic domain separation, SQL authorizer controls, database resource
limits, durable validator non-equivocation state, scoped RPC authentication,
encrypted key storage, crash-consistent head publication, and fuzzing at every
binary/parser boundary.

## 24. Prototype format policy and manifest identity

Chronolog has no released format or state to upgrade. The transaction core,
RPC contracts, control store, and application database are edited in place.
Incompatible development databases, feeds, and fixtures are recreated; no
migration or dual interpretation is implemented.

The node still persists content identities needed for deterministic execution:

```text
canonical IR codec digest
schema digest
execution-manifest digest
DoltLite/SQLite source and native build digest
registered kernel/module digests
```

These fields prove that replicas execute the same language. They are not a
compatibility mechanism for the current prototype. A mismatch fails startup or
refuses attestation/materialization.

## 25. Principal engineering risks

1. **DoltLite binding completeness.** The Node binding may not expose authorizer,
   progress, limit, branch, and atomic publication APIs. Mitigation: prove these
   first and add a narrow N-API shim if required.
2. **Atomic branch publication.** Concurrent reader behavior and crash recovery
   must be proven against the exact DoltLite build.
3. **SSB ecosystem age and integration surface.** Keep SSB-DB2 behind an adapter,
   pin dependencies, and maintain transport-level fixtures.
4. **SQL determinism.** Use SQLite authorizer and resource APIs, a pinned engine
   build, prohibited-function tests, and cross-process replay checks.
5. **Large candidate transport.** Use committed blob manifests, bounded chunks,
   resumable retrieval, and explicit `waiting_for_payload` state.
6. **Replay amplification.** Coalesce insertions, checkpoint adaptively, and
   measure adversarial old-but-still-open transactions.
7. **Key loss or validator rollback.** Separate recovery keys, persist signing
   state before acknowledgement, and test backup restoration procedures.
8. **Cross-language drift.** Publish fixtures before additional implementations
   and reject non-canonical encodings.

## 26. References

- [Chronolog DB protocol design](design.md)
- [Chronolog DB implementation plan](implementation-plan.md)
- [DoltLite repository and API overview](https://github.com/dolthub/doltlite)
- [DoltLite releases](https://github.com/dolthub/doltlite/releases)
- [SSB-DB2 repository](https://github.com/ssbc/ssb-db2)
- [Secure Scuttlebutt protocol specification](https://spec.scuttlebutt.nz/)
- [Protocol Buffers documentation](https://protobuf.dev/)
