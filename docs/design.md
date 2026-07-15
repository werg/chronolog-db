# Chronolog DB Protocol Design

Status: Historical protocol background. Its relational-IR transaction sections
are superseded by
[Specification 10](implementation-specs/10-deterministic-sql-transactions.md)
and [Specification 11](implementation-specs/11-transaction-results-and-ordered-mutations.md).

Date: 2026-07-13

## 1. Abstract

Chronolog DB is a decentralized, permissioned relational database with an
immutable transaction log and deterministic eventual convergence.

Writers publish exact typed relational transaction candidates through Secure
Scuttlebutt (SSB). Each candidate contains an immutable, author-attested wall-clock
timestamp. A configurable validation policy over trusted, dynamically
authorized validator capabilities notarizes the candidate through individual
attestations on append-only SSB feeds. Validators do not assign the ordering
timestamp, execute the transaction, vote on the resulting database, sign state
roots, or enumerate a globally complete transaction set.

Once a valid validation proof exists, the transaction becomes permanently
admissible. Its ordering key was already fixed by the signed candidate, so
additional attestations cannot move it. A transaction may remain hidden from
some replicas and arrive later. On arrival, all replicas insert it into the
same deterministic order, rewind to a DoltLite checkpoint, and replay the
affected suffix. Typed relational preconditions decide whether the transaction is accepted
in its derived position.

The protocol is best understood as an operation-set CRDT whose materialized
value is produced by a deterministic relational reducer backed by DoltLite. The replicated source of
truth is the set of admitted transaction events. The DoltLite database and
its commit graph are derived state and reusable checkpoints.

## 2. Goals

Chronolog DB should provide:

- A permissioned group with explicit reader, writer, validator, and
  administrator capabilities.
- Offline transaction creation and asynchronous peer-to-peer replication.
- An exact, signed log of typed relational IR transactions rather than
  state merges or row-diff merges.
- Mandatory transaction preconditions that are reevaluated whenever history
  changes underneath a transaction.
- A replay-visible, read-only transaction log through which relational preconditions
  can depend on particular preceding transactions and their outcomes.
- Deterministic accepted and rejected transaction outcomes on every replica.
- Protection against obtaining fresh validation for a transaction older than
  the validators' previously published acceptance cutoffs.
- Stable transaction ordering that never changes merely because more validator
  attestations arrive.
- Tolerance of delayed or temporarily hidden admitted transactions: discovery
  may cause rollback and replay, but not divergent results.
- Content privacy for permissioned readers, including membership-driven key
  rotation.
- A reactive client model that exposes query changes, transaction outcome
  changes, and the confidence attached to those observations.
- Pluggable membership establishment, including a root administrator,
  centralized authority, blockchain, or another external registry.

## 3. Non-goals

The initial protocol does not attempt to provide:

- Byzantine consensus on a database state.
- Validator signatures over state roots, event-set roots, or Dolt commits.
- Proof that every admitted transaction has already reached every replica.
- Permanent finality of a derived transaction outcome in a fully asynchronous network.
- Prevention of censorship by a validator quorum.
- Safety if a sufficient validation quorum colludes to ignore published
  timestamp cutoffs or improperly authorize a transaction.
- Revocation of information already downloaded by a former reader.
- Automatic merging of Dolt branches or database states.
- Arbitrary SQLite behavior, nondeterministic functions, external side effects,
  or unbounded SQL execution.

These exclusions are deliberate. Chronolog DB targets groups whose membership
and validators are meaningfully trusted, while retaining decentralized
storage, replication, offline operation, and independently derived state.

## 4. Architecture

```text
 Writer                    Validator feeds
   |                             |
   | publish candidate           | publish attestations
   v                             v
                  SSB replication
                         |
                         v
           admitted transaction operation set
                         |
                         v
             fixed timestamp order
                         |
                         v
       typed preconditions + atomic IR transaction replay
                         |
                         v
            DoltLite materialized database
                         |
                         v
        live queries + transaction outcome stream
```

### 4.1 Components

**Writer**

Creates an exact typed relational transaction with an immutable author-attested wall-clock
timestamp, signs it, publishes it on a dedicated group feed, and requests
validator attestations.
The candidate becomes admissible when its pinned validation policy is
satisfied.

**Validator**

Acts as a trusted transaction notary. It verifies admission-level rules,
then publishes an attestation on its own SSB feed before returning the
attestation to the requester.

**Replica**

Replicates group and validator feeds, verifies validation proofs, derives the
total transaction order, executes the deterministic relational reducer, and exposes the resulting
local database. Readers, writers, and validators may all operate replicas.

**Membership authority**

Defines identities, roles, validator capabilities, validation policies, and
encryption membership. Its implementation is external to the transaction
reducer, but its versioned decisions are replicated and auditable.

**DoltLite**

Stores the materialized SQL state and reusable historical checkpoints. Its
three-way merge behavior is not used in the convergence path.

## 5. Trust and failure model

The base design assumes:

1. Signature and hash primitives remain secure.
2. Every SSB feed is append-only and does not fork. A detected feed fork causes
   that identity to be quarantined until membership policy resolves it.
3. The membership mechanism correctly identifies group roles and validator
   keys for each membership epoch.
4. Validators persist their acceptance cutoff and SSB feed sequence, never
   lower a published cutoff, and never issue an attestation outside their
   public feed.
5. A transaction's validation proof contains enough currently valid validator
   capabilities to satisfy its pinned validation policy.
6. Every validation proof and every future-quorum blocking set contains at
   least one validator that follows the cutoff rules.
7. Messages may be delayed, duplicated, reordered, withheld, or delivered only
   to a subset of participants for an arbitrary amount of time.
8. Replicas may crash and later recover from local durable state.

The core ordering and backdating guarantees are therefore conditional and
explicit:

> A transaction's position is fixed by its signed author timestamp and
> deterministic tie-breakers before validation begins. After an honest
> validator publishes cutoff `F`, it will never newly attest a transaction
> whose author timestamp is at or before `F`.

An already attested transaction may still be revealed late and inserted at its
original position. If a sufficient validator quorum colludes, it can ignore
cutoffs, improperly authorize, or censor a transaction. Those cases are outside
the initial trust model and are not disguised as Byzantine-safe guarantees.

## 6. Membership and capabilities

Each group begins with a signed genesis manifest containing at least:

```text
protocol version
group identifier
genesis database/schema identifier
initial membership revision
reader and writer capabilities
validator capability classes and organization labels
absolute validation threshold and optional class constraints
clock and heartbeat policy
encryption policy
membership authority and recovery policy
```

The v0.1 reference membership mechanism is an SSB-replicated root capability
log. Genesis names the root administration key, the recovery keys, and the
capability-log feed. Other membership providers may later emit the same
normalized capability records, but they are adapters rather than alternative
v0.1 wire semantics.

### 6.1 Roles

**Reader**

May obtain group decryption material and materialize the database.

**Writer**

May author transaction candidates. A writer is not automatically a validator
or administrator.

**Validator**

May notarize transaction candidates while holding a valid validator capability.
A validator must be able to inspect enough of a candidate to enforce the
group's admission policy. In the initial privacy model, validators are also
readers.

**Administrator**

May request or authorize membership and capability changes according to the
configured membership mechanism.

Roles may be combined. Capabilities apply to device/feed keys, not merely to a
human-readable account, so that each device has an independently revocable
identity. Device capabilities identify an Ed25519 signing key and, for readers,
a distinct HPKE recipient public key.

### 6.2 Membership mechanisms

Membership decisions are normalized into signed, versioned capabilities.
The v0.1 authority is the root capability log. Future adapters may source
equivalent decisions from:

- A single root administrator whose successor is explicitly signed.
- A centralized database or identity service.
- A finalized blockchain contract.
- A threshold administrator group.
- Another application-specific external authority.

Every capability-log revision references the previous revision, contains a
deterministic set of grants and revocations, and is signed by the active root
administration key. Root-key rotation requires an explicit successor record.
Replicas derive the same capability state by replaying this log from genesis.

The transaction protocol depends on those normalized capabilities, not on which
authority implementation produced them. There is no globally fixed validator
set. Validators may be added, removed, reclassified, or made eligible under a
particular referenced validation policy.

Every validator capability contains at least:

```text
validator identity
capability revision and issuer
capability class and optional organization
valid-from membership revision
valid-until or revocation reference
minimum author timestamp it may attest
```

The minimum author timestamp is crucial. A newly added validator must inherit a
floor no lower than the group history it is allowed to help close. Otherwise,
adding a validator with a zero floor would reopen the entire past for fresh
backdated attestations.

A transaction pins a validation policy reference before attestations are
collected. The v0.1 policy grammar uses absolute capability thresholds with
optional organizational or capability-class constraints. For example, a group
may require three distinct validator capabilities, including at least one from
each of two named organizations. The integer threshold and any class constraints
are explicit genesis or membership-revision parameters.

Percentage thresholds are not part of the v0.1 profile. They require a fixed
denominator snapshot, obscure the actual failure assumptions, and add no
expressive power needed by the first implementation. Later membership changes
are prospective and do not invalidate attestations that were valid when
published and still satisfy the transaction's pinned policy.

### 6.3 Recovery

Genesis names three offline recovery keys, independent of active administrator,
writer, and validator device keys. The v0.1 recovery threshold is two of those
three keys. A recovery record carrying two valid recovery-key signatures
installs a new root administration key, successor capability-log feed,
membership revision, and validator capabilities while referencing the last
recognized membership state.

Any participant may relay a valid recovery record through SSB; its validity
depends on the embedded recovery signatures rather than the relay's feed. It
requires neither the active root key nor validator attestations, so recovery
remains available when the ordinary administration or validation path is
liveness-starved.

Recovery keys need not be readers and should normally remain offline in
separate custody. An explicit recovery may lower a timestamp floor, but doing
so reopens history and must be visible to clients. Because recovery may occur
during a partition, clients must display it as an authority-driven recovery
event rather than silently treating it as an ordinary membership update.

## 7. Transaction representation

The v0.1 canonical binary encoding is deterministic CBOR using the core
deterministic encoding requirements of RFC 8949. Protocol schemas assign
integer map keys, prohibit indefinite-length items, and require preferred
serialization. SQL binary64 parameters are carried as their exact eight-byte
bit pattern rather than as a CBOR floating-point value.

All v0.1 protocol digests use SHA-256. Protocol-level signatures use Ed25519;
SSB envelopes continue to follow the SSB feed-signature rules. Every signed or
hashed structure uses a distinct ASCII domain-separation prefix followed by a
zero byte and the deterministic CBOR payload. Implementations never hash or
sign an implementation-specific JSON serialization.

### 7.1 Transaction candidate

A transaction candidate contains, or cryptographically commits to, an encrypted
or plaintext transaction core:

```text
type:                 chronolog/transaction-candidate
group_id:             group identifier
membership_revision:  revision under which the writer acts
validation_policy:    immutable policy/capability reference
author_id:            writer device/feed identity
author_timestamp_ms:  immutable author-attested Unix timestamp in milliseconds
nonce:                random value preventing hash-guessing attacks
execution_manifest:   pinned deterministic runtime digest
schema_digest:        schema expected by the author
preconditions:        ordered typed query IR assertions/expectations
mutations:            ordered typed relational mutation IR
metadata:              optional application metadata
```

Before encryption, the writer calculates a domain-separated
`candidate_digest` over the canonical transaction core. The random nonce in the
core prevents useful dictionary guessing against this digest. Payload
encryption authenticates the visible routing header and `candidate_digest` as
associated data.

Small encrypted payloads may be inline in the candidate SSB message. Larger
payloads use a content-addressed chunk manifest in that message. The manifest
commits to the exact ciphertext, and the ciphertext commits to the canonical
core through `candidate_digest`. A candidate is not eligible for admission until
all referenced chunks are available and both commitments verify.

The candidate SSB message is signed by the writer feed, and its SSB message
identifier becomes the transaction identifier `tx_id`, regardless of inline or
manifest storage. This avoids any circular dependency between encryption and
the message ID.

`author_timestamp_ms` is the writer's signed claim about wall-clock time. It is
an ordering coordinate, not proof of objective time. It need not be monotonic
with the writer's SSB feed: a later feed message whose timestamp is lower may
sort earlier while that timestamp range remains open. Validators only attest
that the timestamp is above their deliberately lagging acceptance cutoffs and
within any configured future-time bound.

The complete immutable ordering key also uses values authenticated by the SSB
candidate envelope:

```text
(author_timestamp_ms, author_id, author_feed_sequence, tx_id)
```

The tie-breakers are required because distinct transactions can legitimately
have identical millisecond timestamps. An HLC or Lamport counter is not needed:
SSB feed sequence and `tx_id` already provide deterministic uniqueness, while
relational preconditions express the dependencies that matter to the application.

### 7.2 Typed relational values

Transaction IR preserves Chronolog logical types without lossy conversion,
including null, Boolean, signed integers, exact decimals, UTF-8 text, blobs,
UUIDs, timestamps, canonical JSON, and typed vectors. Float values are available
only through an enabled numeric profile and carry exact bits.

The canonical IR is preserved byte-for-byte. SQLite text is generated by the
pinned compiler for DoltLite execution and is never accepted as an alternative
signed transaction program.

## 8. Validator attestations

### 8.1 Attestation structure

A validator publishes one SSB message for every positive attestation:

```text
type:                 chronolog/transaction-attestation/v1
group_id:             group identifier
membership_revision:  capability revision used by the validator
validator_capability: capability identifier or proof
tx_id:                exact candidate SSB message identifier
validator_id:         validator feed identity
author_timestamp_ms:  exact ordering timestamp from the candidate
accepted_above_ms:    validator cutoff in force when signing
candidate_digest:     commitment to the verified candidate bytes
decision:             admit
policy_version:       admission-policy version
```

The SSB feed envelope signs the attestation, its validator sequence number, and
the previous validator-feed message. A detached representation may be returned
to the writer for convenience, but the feed message is the authoritative
attestation.

Negative decisions may be returned directly or published as optional audit
events. A negative decision does not enter the materialized transaction log.

### 8.2 Validator admission checks

Before attesting, a validator checks at least:

- The candidate and writer SSB signatures are valid.
- The group and membership revision are recognized.
- The author has the writer capability in that revision.
- The pinned validation policy recognizes the validator's current capability.
- Candidate size and statement counts are within policy limits.
- The execution profile and protocol version are supported.
- The author timestamp is well formed and strictly greater than the validator's
  current acceptance cutoff and the minimum timestamp in its capability.
- The author timestamp is not unreasonably far in the future under the
  validator's configured clock policy.
- The candidate digest matches the exact bytes inspected by the validator.
- The validator capability has not expired or been revoked.

Validators do not evaluate application preconditions or determine the SQL
outcome. In the v0.1 profile they validate the decoded envelope, capabilities,
canonical structure, declared counts, byte-size limits, timestamp bounds, and
candidate commitment, but do not parse SQL. Deterministic SQL parsing,
allow-list enforcement, and execution belong to the reducer. A syntactically or
semantically prohibited SQL candidate may therefore obtain attestations but is
excluded as `invalid_protocol` by every conforming reducer.

### 8.3 Publish-before-return rule

A validator must durably append its attestation to its local SSB feed before
returning success to the writer, after which ordinary SSB replication publishes
it to peers. An implementation must never create an off-feed positive
signature.

This rule makes validation observable: even if candidate or attestation
replication is delayed between some peers, each validator feed contains a
durable reference to the notarized `tx_id`.

### 8.4 Validator feed sequence and acceptance cutoff

Each validator maintains two durable monotonic values:

```text
validator SSB feed sequence
acceptance_cutoff_ms
```

The SSB sequence orders the validator's own audit feed. It is not part of
transaction ordering. `acceptance_cutoff_ms` is the lower bound on author
timestamps the validator will newly attest. Neither value may decrease after
clock rollback, membership change, or state restoration. Restoring a validator
from backup without its latest feed and cutoff state is a protocol violation.

Validators may reject requests when their wall clock is too uncertain or too
far from their configured time sources. A validator may also reject author
timestamps unreasonably far in the future to prevent operational abuse. These
admission checks happen before signing; replicas do not later derive transaction
validity from their own wall clocks.

Every genesis manifest supplies three clock-policy parameters:

```text
max_future_skew_ms
cutoff_lag_ms
heartbeat_interval_ms
```

At a trustworthy local time `now`, an active validator advances its cutoff no
further than `now - cutoff_lag_ms` and rejects an author timestamp greater than
`now + max_future_skew_ms`. It publishes a heartbeat at approximately
`heartbeat_interval_ms` while online, even during transaction inactivity. A
missed heartbeat stalls watermark progress but is not itself a safety failure.
The numerical values are group policy: deployments that support long offline
authoring choose a longer cutoff lag and consequently accept slower settlement.

## 9. Validation and admission

### 9.1 Monotonic validation proof

The author publishes one immutable transaction candidate. Validators then
publish independent attestations referencing its `tx_id`. A transaction becomes
admissible as soon as the attestations visible to a replica contain a subset
that satisfies the validation policy pinned in the candidate.

No author-published certificate is required for the ordering algorithm. Clients
may bundle a convenient validation proof containing a minimal satisfying set of
attestation references, but the proof is only evidence of admission. It does
not contribute to the order key.

Replicas assemble the authoritative proof locally from the candidate,
validator feeds, capability log, and pinned policy. Any participant may publish
an optional proof-bundle cache message listing those immutable references, but
the bundle has no authority of its own: replicas re-fetch or resolve every
referenced object, verify it independently, and may discard or reconstruct the
bundle at any time.

Admission is monotonic:

```text
pending + more attestations -> admissible
admissible + more attestations -> admissible
```

Capability revocation is prospective. It prevents new attestations; it does not
retroactively remove a transaction whose attestations were valid when published
and satisfy its pinned policy, unless an explicit recovery or fraud policy says
otherwise.

### 9.2 Stable ordering

The authoritative transaction time is always:

```text
effective_time(tx) = tx.author_timestamp_ms
order_key(tx) = (
  tx.author_timestamp_ms,
  tx.author_id,
  tx.author_feed_sequence,
  tx.tx_id
)
```

Validator timestamps, feed arrival order, number of attestations, and the choice
of a minimal satisfying proof never appear in the transaction order key.
Different replicas may observe the admission threshold at different moments,
but when they admit the transaction they insert it at exactly the same fixed
position. Later attestations cannot make that position wobble.

### 9.3 Dynamic validation policy

The protocol does not require a globally fixed validator set. A pinned
validation policy evaluates versioned validator capabilities. The v0.1 grammar
supports conjunctions of absolute constraints such as:

```text
at least 3 distinct validator capabilities valid when they attest
one validator from each of organizations A and B
at least 2 validator capabilities with class "financial-auditor"
```

Each attestation must come from a distinct validator capability. Constraints
are evaluated against the membership revision referenced by that capability;
they do not require a globally permanent validator set. Percentage thresholds,
weights, and hash-selected committees are deferred until a concrete deployment
requires them and their denominators and grinding resistance can be specified.

Attestations collected across membership changes may be combined only when the
pinned policy explicitly permits their capability revisions. In every case,
the policy and capability proofs make validation deterministic without making
validator membership globally static.

## 10. Validator heartbeats and observable watermarks

Validators may publish heartbeat messages even when no transactions are being
attested:

```text
type:                 chronolog/validator-heartbeat/v1
group_id:             group identifier
membership_revision:  validator capability revision
validator_id:         validator identity
acceptance_cutoff_ms: monotonic lower bound for future attestations
```

A heartbeat is not a state root, transaction root, or promise that every
participant has all transactions. It proves only that:

- The validator feed has advanced contiguously to this message.
- Every earlier attestation by that validator is present earlier in the feed.
- The validator will never later attest a transaction whose
  `author_timestamp_ms` is at or before `acceptance_cutoff_ms`.

The cutoff is intentionally allowed to lag the validator's current wall clock.
For example, a validator may publish `wall_clock - acceptance_grace_period`.
The heartbeat does not claim that the cutoff is the current time; it makes only
the narrower, durable promise that the closed timestamp range will not be
reopened by that validator.

Heartbeats allow clients to calculate an operational watermark relative to a
particular validation policy. A synchronized collection of validator feeds is
a blocking set for policy `P` when every possible future proof satisfying `P`
must contain at least one validator in that collection:

```text
for every proof Q satisfying P: Q intersects blocking_set
```

If a client has replicated those validator feeds contiguously through
heartbeats whose cutoffs exceed time `T`, then every future validation proof
must contain an attestation from at least one intersecting honest validator. It
cannot be newly validated with `author_timestamp_ms <= T`.

An already validated but hidden transaction may still appear. Because positive
attestations must be published on validator feeds, the synchronized feeds expose
at least one reference to any such transaction whose proof intersects them. A
client that wants stronger settlement confidence must resolve all such
transaction references and, where necessary, synchronize additional validator
feeds to determine whether they obtained a complete proof.

Dynamic validator admission does not reopen this watermark when new validator
capabilities inherit a minimum author timestamp above `T`. A membership or
recovery action that deliberately grants a lower floor is an explicit history
reopening event.

This is deliberately a confidence and discovery mechanism rather than global
state finality.

## 11. Timestamp order and dependencies

Admitted transactions form a set, not a causal DAG. Replicas sort the set
directly by the immutable `order_key` defined in section 9.2. There are no
required parent references and no topological-sort phase.

The resulting algorithm is:

1. Validate every candidate, attestation, capability, and admission proof.
2. Sort every admitted candidate by its fixed ordering key.
3. Execute transactions in that total order.

Timestamps do not need to encode causality. When a transaction requires another
transaction to precede it or to have succeeded, it expresses that requirement
as a mandatory query-IR precondition over the replay-visible transaction log. This
keeps application dependencies explicit without imposing a dependency graph on
unrelated transactions.

If a previously hidden transaction arrives, it may sort before the current
head. Every replica finds the same insertion point because the signed author
timestamp and SSB-authenticated tie-breakers were immutable before validation
began. The affected suffix is then replayed, including all transaction-log
preconditions.

## 12. Deterministic relational transaction semantics

The normative consensus language is the
[Chronolog deterministic SQL dialect and relational IR](sql-dialect.md). The
unreleased prototype's raw-SQL transaction fields are replaced directly. There
is no legacy decoder, compatibility reducer, or data migration; development
databases and serialized fixtures are recreated. Detailed implementation is
specified in the [implementation specification suite](implementation-specs/README.md).

### 12.1 Replay-visible transaction log

The materialized database contains a system-managed transaction log. Signed
candidate contents are immutable; derived outcome rows are reconstructed when
replay replaces an affected suffix. A conceptual initial schema is:

```text
chronolog_transactions (
  tx_id,
  author_id,
  author_timestamp_ms,
  author_feed_sequence,
  candidate_digest,
  canonical_candidate,
  outcome,
  rejection_code
)
```

`canonical_candidate` preserves the exact signed transaction core, including
its typed relational IR, transaction context, schema digest, execution-manifest
digest, mutations, and preconditions. Implementations may expose normalized
read-only views over this value for convenient inspection.
Application SQL may read the log but cannot insert, update, or delete its rows.
The execution profile reserves the `chronolog_` prefix so application schema
objects cannot shadow the protected relation during replay. The relation is a
table in the active Dolt database, not an attached companion database. SQLite
would interpret `chronolog.transactions` as an attached-database reference;
self-attaching the file can resolve a different branch during replay and is
therefore prohibited. Keeping the relation on the active branch also makes a
checkpoint commit cover the application state and its exact outcome-log prefix
together.

The reducer appends a transaction's log row only after deriving that
transaction's outcome. Consequently, while a transaction's preconditions are
being evaluated, the table contains exactly the transactions that precede it
in the current replay—not the current transaction or any later transaction.
Rejected preceding transactions remain present with their outcome and stable
rejection code.

This gives applications several useful dependency forms without protocol-level
parent fields:

```sql
-- Require another transaction merely to precede this one.
SELECT EXISTS (
  SELECT 1 FROM chronolog_transactions
  WHERE tx_id = :required_tx
);
```

```sql
-- Require the preceding transaction to have been accepted.
SELECT EXISTS (
  SELECT 1 FROM chronolog_transactions
  WHERE tx_id = :required_tx
    AND outcome = 'accepted'
);
```

A reference to the current or a later transaction is absent at evaluation time
and therefore fails. This rules out successful dependency cycles without a DAG
algorithm. If a referenced transaction is initially missing but later arrives
with an earlier order key, suffix replay can make the dependent precondition
pass. Until the relevant validator watermark advances, such an outcome remains
provisional like every other precondition-derived outcome.

### 12.2 Mandatory preconditions

Every transaction carries one or more typed IR preconditions in addition to
automatic protocol checks. An assertion contains a scalar Boolean query IR. An
expectation contains query IR, a declared result mode, and an inline canonical
result or digest. The client normally produces expectations from observations
made against one pinned materialized revision.

Queries define scalar, ordered, multiset, or set semantics. Every row-choice
operation has a provably total order. Preconditions can refer to the protected
transaction-log relation, including stable IDs and accepted/rejected outcomes
of preceding transactions.

### 12.3 Reducer execution

For each transaction in the derived order, a replica:

1. Checks protocol validity, admission proof, membership, capabilities, schema,
   execution manifest, and canonical IR.
2. Compiles the typed IR into the one canonical DoltLite execution plan.
3. Opens a top-level SQLite transaction for that candidate.
4. Runs every precondition against the replayed prefix.
5. Executes mutations, deterministic rules, constraints, and managed derived
   index maintenance.
6. Appends the accepted system-log row and commits atomically.
7. On deterministic rejection, fully rolls back, opens a fresh transaction,
   writes only the rejected log row, and commits it.
8. On operational failure, aborts local replay without deriving an outcome.

The result is atomic. A rejected transaction never partially modifies
application state, but it does remain visible to subsequent transaction-log
preconditions.

### 12.4 Derived outcomes

The accepted/rejected log is derived locally and is not separately voted upon.
For the same admitted event set and execution profile, all replicas derive the
same outcome.

Possible outcome classes include:

```text
rejected_precondition
rejected_execution
accepted
```

Invalid, unauthorized, insufficiently validated, or locally incomplete
candidates are not yet admitted reducer inputs and therefore do not receive a
row in the canonical replay log. Replicas track those ingestion states
separately, for example as `invalid_protocol`, `unauthorized`,
`pending_validation`, or `waiting_for_payload`.

Consensus-relevant error reasons use stable protocol codes. Human-readable
SQLite error text is diagnostic only.

When a hidden preceding transaction arrives, a transaction may change from
accepted to rejected or from rejected to accepted. Every later transaction is
replayed in order, and its own preconditions determine its new outcome.

## 13. Deterministic execution manifest

All replicas in a group execute an immutable content-addressed manifest. It
commits the IR codec and compiler, schema digest, DoltLite/SQLite source and
build, database configuration, value and collation rules, deterministic
kernels, functions, registered modules, JSON/FTS/vector/spatial/WASM profiles,
stable errors, and semantic resource limits.

Consensus transactions contain typed IR, never arbitrary SQL. The compiler
binds the signed transaction timestamp and labeled nonce-derived entropy
explicitly. Ambient clocks, randomness, locale, environment, filesystem,
network, dynamic extension loading, implicit row identifiers, unordered row
choice, and application access to reducer/Dolt metadata are prohibited.

Nodes persist and verify the schema and execution-manifest digests at startup.
A mismatch fails rather than attempting to reinterpret the fresh prototype
database.

## 14. DoltLite materialization and replay

SSB transaction events and validator attestations are the source of truth.
DoltLite is a materialized view.

The materializer maintains:

- The currently known admitted event set.
- The current deterministic event order.
- The replay-visible transaction log and outcomes at the current revision.
- Immutable local checkpoint branches mapping retained order prefixes to Dolt
  commits.
- The `chronolog_head` branch exposed to clients and a unique revision marker
  that commits to its revision, prefix length, and order digest.

When a newly discovered transaction inserts at position `k`:

1. Find the latest checkpoint strictly before `k`.
2. Create a disposable replay branch from that checkpoint commit.
3. Replay every later transaction and recompute outcomes.
4. Verify internal invariants and derived prefix metadata.
5. Commit the candidate, create its revision marker, and atomically force-move
   `chronolog_head` to the verified commit.
6. Reopen the query reader on the new head, notify reactive clients, and only
   then remove obsolete disposable refs.

Chronolog DB does not call Dolt merge to combine replica states and does not use
reset or revert as a convergence mechanism. Restoring a checkpoint branch and
replaying the exact signed relational IR is the normative operation.

Dolt commit hashes may contain local metadata. Unless deterministic commit
metadata is proven and enforced, a Dolt commit hash is a local checkpoint
pointer rather than a protocol-level state identifier.

## 15. Reactive client semantics

The client API should clearly distinguish transaction notarization from the
current relational transaction outcome.

A transaction handle may progress through:

```text
draft
candidate_published
collecting_attestations
validation_threshold_met
admissible
replicated
accepted | rejected
reordered
outcome_changed
```

Useful reactive surfaces include:

```text
liveQuery(query_ir, parameters)
queryLocalSql(sql, parameters)
transaction(builder)
transactionOutcome(tx_id)
settlementEvidence(tx_id)
validatorWatermark()
replicationStatus()
```

Every query emission contains a local revision identifier. Every outcome
emission identifies the event-set revision under which it was derived.

The v0.1 client does not expose settlement as a protocol boolean. Instead,
`settlementEvidence(tx_id)` returns an inspectable object containing at least:

```text
tx_id and current derived outcome
event-set revision and transaction order key
pinned validation policy and membership revision
policy-relative watermark timestamp
validator heartbeat references forming the blocking set
unresolved candidate or attestation references on those feeds
recovery or history-reopening events relevant to the timestamp range
```

An application applies its own policy to that evidence and may display labels
such as `provisional` or `settled-under-policy-P`. The library must not imply an
unconditional proof that no already admitted transaction remains hidden.
Irreversible external side effects should use idempotency keys alongside the
application-selected evidence policy.

## 16. Privacy and encryption

Encryption is independent of transaction notarization. Validator signatures
are over exact candidate identifiers and commitments; they are not the group
encryption mechanism.

The v0.1 encryption backend uses a random symmetric content key per membership
encryption epoch. The membership authority publishes an epoch manifest and
wraps the epoch key independently to every authorized reader device using
HPKE. The selected HPKE and payload-AEAD suite is identified by the genesis
protocol suite. Membership changes rotate the content key; deployments may
also rotate it periodically.

Transaction payload encryption uses authenticated associated data binding the
group, protocol version, encryption epoch, writer, and candidate commitment.
MLS and SSB Box2 remain possible adapters behind the encryption-epoch
interface, but they are not v0.1 interoperability requirements. This simple
HPKE scheme does not claim MLS-style post-compromise security within an epoch.

Attestations necessarily reveal some metadata, including validator activity and
an opaque transaction identifier. Padding, per-group feed identities, and
opaque routing identifiers can reduce but not eliminate traffic-analysis leaks.

Every reader capability carries one of two history scopes:

**Snapshot reader (the default)**

Receives a membership-authority-signed snapshot manifest, its checkpoint, the
current epoch key, and future epoch keys while authorized. The manifest states
the transaction prefix and database checkpoint being trusted. Its signature is
an explicit onboarding trust assertion, not a validator vote or state-finality
proof.

**Audit reader**

Also receives rewrapped historical epoch keys and verifies the transaction log
from genesis or from another explicitly trusted audit anchor.

Historical access is never inferred from ordinary reader membership. It must be
granted by the audit-reader capability, so adding a reader does not silently
disclose prior transaction history.

## 17. Security consequences

### 17.1 What the protocol prevents

- A writer cannot obtain fresh honest validation for an author timestamp at or
  below the validator's previously published acceptance cutoff.
- A non-writer cannot author a valid transaction without breaking signatures or
  the membership mechanism.
- A transaction cannot change after validators attest to its exact identifier.
- Additional attestations cannot move an admitted transaction in the order.
- Replicas that eventually receive the same admitted operation set cannot
  permanently disagree about order or transaction outcomes.
- A validator cannot lower its feed cutoff without producing publicly
  verifiable evidence of a protocol violation.

### 17.2 What the protocol permits

- An admitted transaction can reach one participant long after another.
- Late discovery can change database state and earlier provisional outcomes.
- A writer claims its author wall-clock timestamp and may choose a future time.
  Future dating orders its own transaction later and may be bounded by
  admission policy.
- A later message on a writer's feed may carry a lower timestamp and therefore
  sort earlier while validators still consider that timestamp range open.
- A writer may obtain genuine attestations before a heartbeat and the
  transaction may reach some replicas much later; validator feeds make the
  attestations discoverable but do not force timely network delivery.
- Validators may refuse to sign, causing censorship or liveness failure.
- Sufficient colluding validator capabilities can improperly authorize a
  transaction or ignore their published cutoffs.
- Any authorized reader can copy or disclose plaintext it has learned.

### 17.3 Feed and signing-key compromise

A compromised writer key can author transactions until the membership
authority revokes it. A compromised validator key can issue attestations,
including attestations that violate its cutoff, until revocation. Feed sequence
cutoffs should be recorded in revocation decisions so clients can reject
post-revocation feed messages deterministically.

Validator keys should use durable non-equivocation state, protected storage,
and operational backup rules that never restore an older signing counter.

## 18. Protocol lifecycle example

Alice transfers 10 units to Bob:

1. Alice reads her balance through the reactive client.
2. The client creates an `expect` precondition for that observed balance and an
   `assert` precondition that the balance remains at least 10.
3. It reserves Alice's wall-clock timestamp and transaction nonce, creates the
   signed typed mutation IR, and publishes candidate `T` on Alice's group writer
   feed.
4. Validators V1, V2, and V3 inspect `T`. Each verifies that
   `T.author_timestamp_ms` is above its acceptance cutoff and publishes an
   attestation referencing `T`.
5. Once the visible attestations satisfy `T`'s pinned policy, replicas admit it
   at the position fixed by `T`'s order key.
6. Further attestations for `T` do not change that position.
7. The preconditions pass, so replicas apply `T`, report `accepted`, and append
   its system transaction-log row.
8. Later, an offline replica reveals admitted transaction `U`, which sorts
   immediately before `T` and also spends Alice's balance.
9. Replicas restore the preceding DoltLite checkpoint and replay `U` followed
   by `T`.
10. `U` is accepted. `T` now fails its signed balance precondition and becomes
    `rejected_precondition`.
11. Reactive clients receive the database changes and the outcome change for
    `T`. Every replica derives the same result.

If `U` was newly notarized after the relevant validator heartbeats, its author
timestamp had to be above their published cutoffs. If it was genuinely
notarized earlier and merely hidden, it retains that earlier fixed position.

## 19. Initial implementation plan

The phases below are the protocol-level summary. The executable architecture is
specified in [implementation-design.md](implementation-design.md), and detailed
work items and release gates are in
[implementation-plan.md](implementation-plan.md).

### Phase 1: Protocol model

- Deterministic CBOR, SHA-256 domain-separated hashes, and Ed25519 signatures.
- Root capability log, two-of-three recovery, and dynamic validator
  capabilities.
- Transaction candidate, attestation, policy, and admission-proof validation.
- Signed author wall-clock timestamps, validator cutoffs, and deterministic
  tie-break ordering.
- Property tests over randomized delivery permutations.

### Phase 2: Deterministic relational reducer

- DoltLite integration.
- Canonical schema/transaction IR compiler and pinned execution manifest.
- Typed assertion and expectation preconditions.
- Immutable replay-visible transaction log and transaction-reference
  preconditions.
- Checkpoint restoration and suffix replay.
- Accepted/rejected outcome index.

### Phase 3: SSB transport

- Dedicated per-group writer and validator feeds.
- Candidate, attestation, heartbeat, capability, and membership message types.
- Feed-gap and fork detection.
- Partial replication and missing-payload retrieval.
- Locally assembled validation proofs and optional proof-bundle caches.

### Phase 4: Reactive client

- Transaction builder with observed-read preconditions.
- Live query invalidation and rerun.
- Outcome and reordering streams.
- Settlement-evidence, validator-watermark, and replication diagnostics.

### Phase 5: Privacy and recovery

- HPKE-wrapped group epoch keys behind the encryption-epoch abstraction.
- Snapshot-reader onboarding and explicit audit-history capabilities.
- Membership-provider adapters.
- Revocation cutoffs and recovery epochs.

## 20. Required tests and invariants

At minimum, automated tests must demonstrate:

- Independent implementations produce identical deterministic CBOR bytes,
  SHA-256 digests, and Ed25519 verification results for shared test vectors.
- Non-canonical encodings and signatures under the wrong domain prefix are
  rejected.
- All delivery permutations of the same admitted event set converge.
- Hidden transactions are inserted at the same position on every replica.
- A transaction's order key is its immutable author timestamp and signed
  tie-breakers, never an attestation timestamp or arrival time.
- Equal author timestamps and a writer's backward clock movement still produce
  one deterministic order.
- Validator clock rollback does not reduce its acceptance cutoff, and its SSB
  feed sequence continues monotonically.
- Later attestations cannot change a transaction's effective time.
- SSB feed gaps prevent a validator watermark from advancing.
- Reordering recomputes both accepted and rejected outcomes.
- Preconditions see exactly the preceding transaction-log prefix; they cannot
  see the current or later transactions.
- Rejected transactions remain queryable by later preconditions, and
  application SQL cannot mutate transaction-log rows.
- Late discovery of an older referenced transaction can deterministically
  change the dependent transaction's outcome.
- SQL execution is atomic under precondition and execution failure.
- Prohibited nondeterministic SQL cannot enter the reducer.
- Invalid, expired, or disallowed capability combinations cannot satisfy the
  pinned validation policy.
- Percentage or weighted policies are rejected by the v0.1 policy parser.
- Proof cache bundles cannot make an invalid or otherwise insufficient
  attestation set admissible.
- Settlement evidence reports its supporting heartbeat references and all
  known unresolved references rather than collapsing them into a boolean.
- Snapshot readers cannot obtain historical epoch keys without an explicit
  audit-reader grant.
- One recovery signature cannot change membership, while any valid two of the
  three genesis recovery keys can install a recovery revision.
- Adding a validator cannot lower the admissible timestamp floor unless an
  explicit recovery action authorizes history reopening.
- Revoked validator and writer feed sequences are rejected consistently.
- Checkpoint replay produces the same database as replay from genesis.

## 21. V0.1 decisions and deployment parameters

The initial profile fixes the previously open protocol choices:

- Deterministic CBOR, SHA-256, and Ed25519.
- Absolute validator-capability thresholds with optional organization or class
  constraints; no percentage policies.
- Author-attested wall-clock ordering with lagging monotonic validator cutoffs.
- Envelope and resource validation by validators; deterministic SQL validation
  by reducers.
- An SSB root capability log with two-of-three offline recovery.
- HPKE-wrapped symmetric epoch keys.
- Snapshot-reader and audit-reader history scopes.
- Structured settlement evidence rather than a finality boolean.
- Locally assembled validation proofs with non-authoritative cache bundles.

Each genesis manifest must still provide deployment values rather than relying
on hidden implementation defaults:

```text
absolute validator threshold and optional organization/class constraints
max_future_skew_ms
cutoff_lag_ms
heartbeat_interval_ms
HPKE and payload-AEAD protocol suite identifier
snapshot-manifest authority and checkpoint-retention policy
resource and SQL execution limits
```

Changing these values creates a new, explicitly referenced policy or membership
revision. It does not reinterpret existing candidates or attestations.

## 22. References

- DoltLite: <https://github.com/dolthub/doltlite>
- Secure Scuttlebutt protocol specification: <https://spec.scuttlebutt.nz/>
- SSB DB2: <https://github.com/ssbc/ssb-db2>
- Messaging Layer Security, RFC 9420: <https://www.rfc-editor.org/rfc/rfc9420.html>
- MLS Architecture, RFC 9750: <https://www.rfc-editor.org/rfc/rfc9750.html>
- Hybrid Public Key Encryption, RFC 9180:
  <https://www.rfc-editor.org/rfc/rfc9180.html>
- Concise Binary Object Representation, RFC 8949:
  <https://www.rfc-editor.org/rfc/rfc8949.html>
- Edwards-Curve Digital Signature Algorithm, RFC 8032:
  <https://www.rfc-editor.org/rfc/rfc8032.html>
- Secure Hash Standard, FIPS PUB 180-4:
  <https://csrc.nist.gov/pubs/fips/180-4/upd1/final>
- Collaborative Text Editing with Eg-walker:
  <https://arxiv.org/abs/2409.14252>
