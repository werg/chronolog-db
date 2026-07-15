# Reducer and DoltLite Materializer Implementation

## 1. Responsibility

The materializer derives one published database revision from the admitted,
totally ordered transaction set. It restores Dolt checkpoints, replays affected
suffixes, evaluates canonical IR, records accepted and rejected outcomes, and
publishes a verified branch ref.

The materializer does not decide group membership, validator sufficiency, or
transaction ordering. It receives a complete ordered admitted set from node
coordination and independently rechecks transaction identity, order, schema,
manifest, and canonical encoding.

## 2. State model

### 2.1 Authoritative input

The authoritative materializer input is the ordered sequence of admitted
candidate records:

```ts
interface AdmittedTransaction {
  readonly transactionId: Uint8Array
  readonly candidateDigest: Uint8Array
  readonly canonicalCandidate: Uint8Array
  readonly core: TransactionCore
  readonly authorFeedSequence: bigint
}
```

The sequence is strictly sorted by the protocol ordering tuple. Once admitted,
an existing transaction cannot disappear or change identity. New input is an
append or an insertion.

### 2.2 Derived state

All of the following are derived and rebuildable:

- application tables;
- `chronolog_transactions` outcomes;
- FTS, vector, spatial, and materialized-view indexes;
- Dolt replay branches;
- checkpoints;
- published revision refs; and
- reactive revision notifications.

Encrypted SSB/control-store records and group configuration remain outside the
materialized application database.

## 3. Reducer system schema

The compiler creates protected tables equivalent to:

```text
chronolog_execution_manifest (
  singleton_key,
  manifest_digest,
  canonical_manifest,
  schema_digest,
  canonical_schema
)

chronolog_transactions (
  transaction_id,
  order_index,
  author_id,
  author_timestamp_ms,
  author_feed_sequence,
  candidate_digest,
  canonical_candidate,
  outcome,
  rejection_code,
  failing_precondition_id,
  failing_command_id,
  failing_rule_id,
  failing_constraint_id,
  result_digest,
  PRIMARY KEY(transaction_id),
  UNIQUE(order_index)
)
```

Exact storage representations are defined by the schema compiler. Application
IR and local query authorization cannot mutate these tables. Local readers may
inspect an intentionally exposed read-only view.

## 4. Startup

Opening a group database performs:

1. Open the patched DoltLite writer connection.
2. Apply and verify security configuration and SQLite limits.
3. Measure the local execution manifest.
4. Discover the published ref.
5. If no published ref exists, require a schema manifest and initialize a fresh
   repository.
6. If a published ref exists, hard-reset uncommitted writer state and check out
   the published head.
7. Read and byte-compare stored execution/schema manifests and digests.
8. Verify the system log against the published-ref metadata.
9. Validate checkpoint refs and delete corrupt/orphan development refs.
10. Open a separate reader connection pinned to the immutable published
    revision ref.
11. Verify reader content hash and manifests.

Missing or mismatched manifests fail startup. Because the prototype has no data
migration, the diagnostic tells the developer to recreate the database.

## 5. Difference and replay-base selection

Compare current published transaction IDs with the desired ordered IDs.

- Identical sequence: no work.
- Existing sequence is a prefix: append from the published commit.
- First difference at index `i`: select the greatest verified checkpoint whose
  prefix length is at most `i`.

Before replay, verify that every existing published transaction still appears
with identical candidate digest, canonical bytes, and ordering identity.
Removal or identity change is an internal/admission-store error, not a replay
request.

## 6. Replay branch lifecycle

For desired materialized revision `R`:

1. Create an internal replay branch from the selected base commit.
2. Check out that branch on the writer.
3. Verify the base system-log prefix against desired transactions.
4. Apply candidates from the base prefix through the end.
5. Verify final log length, order, candidate identities, and manifests.
6. Verify every enabled derived index against its consistency checks.
7. Create one Dolt commit describing revision `R`.
8. Compare committed content hash with the writer working content hash.
9. Create an immutable revision ref.
10. Open a candidate reader on that immutable ref and independently verify it.
11. Atomically move the published discovery ref.
12. Swap active readers and notify subscribers.
13. Create/prune checkpoints and remove the replay branch when safe.

No Dolt merge, rebase, cherry-pick, or state merge is used.

## 7. Candidate execution algorithm

Each candidate owns a top-level SQLite transaction. The suffix does not use one
enclosing SQLite transaction.

```text
applyCandidate(candidate, orderIndex):
  verify candidate encoding, manifest, schema, and program

  BEGIN IMMEDIATE
  try:
    evaluate preconditions in signed order
    if one fails:
      ROLLBACK
      writeRejectedOutcomeInFreshTransaction()
      return

    execute mutations in signed order
    execute rules in canonical invocation order
    maintain derived indexes
    validate deferred constraints and expected effects
    compute accepted result digest
    insert accepted system-log row
    COMMIT
  catch deterministic rejection:
    ROLLBACK completely
    writeRejectedOutcomeInFreshTransaction()
  catch operational failure:
    ROLLBACK completely
    abort replay branch without deriving an outcome
```

`writeRejectedOutcomeInFreshTransaction` begins a new top-level transaction,
verifies that no application or derived-index change from the candidate is
visible, writes exactly one rejected system-log row, and commits.

The compiler never emits SQLite `OR ROLLBACK`, transaction control, or
savepoints. Top-level isolation nevertheless protects against constraint and
extension behavior that can escape savepoint expectations.

## 8. Precondition execution

Preconditions execute against the prefix including every earlier accepted or
rejected log row and excluding the current candidate.

For each precondition:

1. Compile or retrieve a cache entry keyed by program, schema, and manifest
   digest.
2. Bind signed transaction context and literal values.
3. Execute under `consensus_precondition` authorization.
4. Step and canonicalize results under semantic limits.
5. Apply assertion or expectation semantics.
6. On failure, return the stable precondition ID and code immediately.

Preconditions cannot make application writes. The authorizer and SQLite total
change counter are checked before and after as defense in depth.

## 9. Mutation and rule execution

For each mutation:

1. Materialize the bounded ordered target/source keys where required.
2. Evaluate deterministic prechecks and type invariants.
3. Apply logical row effects.
4. Invoke rules by `(timing, priority, rule_id, primary_key)`.
5. Update generated values and managed derived indexes.
6. Accumulate returning rows and logical affected-row count.
7. Check the mutation expectation.

The reducer maintains a rule stack containing `(rule_id, target_key)` and
enforces declared recursion depth/cycle policy.

## 10. Deterministic versus operational failures

### 10.1 Deterministic rejection

A failure is canonical only when it is defined by the IR/manifest and can be
reproduced from the same prefix and transaction. Examples include failed
preconditions, named constraint violations, checked overflow, invalid JSON,
vector dimension mismatch, rule recursion limit, and semantic result limit.

### 10.2 Operational failure

I/O, lock, memory allocation, corrupt database, native addon defect, missing
registered code, host exception, planner-dependent progress interruption,
process shutdown, and unknown SQLite errors abort the local replay. They do not
produce a rejected transaction row.

The error classifier matches numeric SQLite primary/extended codes and reducer
error classes. It never parses English SQLite messages for consensus meaning.

## 11. Compiler and statement caches

Caches are local optimizations keyed by:

```text
execution manifest digest
schema digest
canonical IR digest
compiler mode
```

Prepared statements are connection-local. They are finalized on reader swap,
schema change, or close. A cache miss cannot affect semantics. Cache sizes and
eviction order are operational, not committed manifest inputs.

## 12. Reader publication and reactive revisions

Readers never follow the movable published ref after opening. Each reader is
pinned to an immutable revision ref. Publication opens and verifies the new
reader before making it observable.

A materialized revision event includes:

```ts
interface MaterializedRevisionEvent {
  readonly previousRevision: bigint
  readonly revision: bigint
  readonly orderLength: number
  readonly contentHash: string
  readonly schemaDigest: Uint8Array
  readonly manifestDigest: Uint8Array
  readonly earliestChangedOrderIndex: number
  readonly outcomeChanges: readonly OutcomeChange[]
}
```

Live queries rerun against the new pinned reader. They never mix rows from two
revisions.

## 13. Checkpoints

A checkpoint records:

- prefix length;
- materialized revision at creation;
- Dolt commit hash;
- immutable internal ref;
- ordered-prefix digest;
- schema and execution-manifest digests; and
- optional derived-index consistency digest.

Checkpoint discovery verifies all fields against the checked-out state. Invalid
checkpoints are removed from consideration. The genesis checkpoint is always
retained. Other checkpoints follow configured spacing and retention, which
affect performance only.

## 14. Crash recovery

Inject crashes at every boundary:

- after replay branch creation;
- during each precondition and mutation;
- before/after candidate SQLite commit;
- during rejected-log transaction;
- before/after Dolt commit;
- after immutable revision ref creation;
- before/after published ref movement;
- during checkpoint creation/pruning; and
- before reader swap/notification.

On restart, only the published ref is authoritative. Unpublished replay and
revision refs are verified and removed. A partially written working set is hard
reset. If the published ref moved, its immutable revision metadata and system
log must verify before service starts.

## 15. Derived-index recovery

Source application rows are authoritative. Each managed derived index provides:

```ts
interface DerivedIndexAdapter {
  validateSchema(...): void
  maintain(changeSet, context): void
  verify(database): void
  rebuild(database, sourceRowsInPrimaryKeyOrder): void
  logicalDigest(database): Uint8Array
}
```

Rebuild happens on an unpublished branch in a top-level transaction. A rebuild
that cannot reproduce the expected logical digest aborts publication.

## 16. Local query execution

Local query SQL executes only on a pinned reader under `local_read`
authorization. It may use broader presentation functions but cannot:

- write any database object;
- access unapproved Dolt mutation functions;
- attach databases;
- load extensions;
- modify pragmas; or
- be copied verbatim into a consensus precondition.

Unlike consensus profiles, `local_read` does not reject clock, random,
connection-state, JSON, math, aggregate, window, or other ordinary read-only
SQLite functions for lack of replay determinism. It denies Dolt-control,
dynamic-extension, write, schema, attachment, pragma, and reserved-object
operations, and remains subject to statement, VM-step, row, and byte limits.
Compiled query IR continues to execute under the consensus-precondition
function allowlist even when invoked through a local observation endpoint.

Consensus query IR has a separate entry point returning typed result modes.

## 17. Tests

Required materializer tests:

1. Fresh schema-manifest initialization and reopen.
2. Manifest mismatch startup failure.
3. Accepted candidate atomicity.
4. Every rejection leaves no application or derived effects.
5. Operational failure leaves no canonical rejected row.
6. Rejected rows are visible to subsequent preconditions.
7. Append replay.
8. Late insertion from every checkpoint position.
9. Outcome changes after late insertion.
10. Clean replay equals suffix replay.
11. Reader remains pinned until publication.
12. Crash injection at every lifecycle boundary.
13. Corrupt/orphan checkpoint handling.
14. Constraint, rule, JSON, FTS, and vector rollback.
15. Statement/cache changes do not change logical results.
16. No direct application access to protected relations.

## 18. Completion criteria

- There is no suffix-wide SQLite transaction or per-candidate savepoint.
- Accepted state and its log row commit atomically.
- Rejected candidates have exactly one log effect and no application effect.
- Operational failures never become author rejections.
- Publication occurs only after independent branch and reader verification.
- Clean and checkpoint replay yield identical state, outcomes, and derived
  logical digests.
- Startup rejects rather than translates incompatible prototype state.
