# Container chaos and stress testing

Chronolog uses a hybrid rather than a ground-up chaos stack. [Testcontainers
for Node](https://node.testcontainers.org/) owns disposable Docker networks and
container lifecycles, one [Toxiproxy](https://github.com/shopify/toxiproxy) process
provides an independently controlled TCP path for every directed SSB link, and
Docker's API supplies process and resource faults. The Chronolog-specific layer
is deliberately small: permissioned cluster generation, seeded transaction
workloads, finality-aware checkers, histories, telemetry, and replay.

This division is important. Generic tools are good at making packets late and
processes disappear; they do not know that Chronolog convergence means the
canonical transaction order and protected transaction log agree, or that a
published candidate may be validly absent once validator watermarks prove it
can no longer be included.

## Why this stack

| Component | Responsibility | Reason for using it |
| --- | --- | --- |
| Testcontainers for Node | Networks, images, bind mounts, ports, cleanup | Native TypeScript API and reliable developer/CI lifecycle |
| Toxiproxy | Directed partitions, latency/jitter, bandwidth, timeout, reset | Repeatable application-level TCP faults without Kubernetes |
| Docker Engine API | Pause, `SIGKILL`, restart, CPU quota, stats | Exercises real process and persistence boundaries |
| Chronolog harness | Membership, workload, history, checkers, replay | Understands inclusion finality and deterministic SQL state |

[Chaos Mesh](https://chaos-mesh.org/) is a strong choice once a production
deployment itself runs on Kubernetes, but requiring a cluster and CRDs would
make the local loop much heavier. [Jepsen](https://github.com/jepsen-io/jepsen)
remains the reference model for histories, nemeses, and
checkers; using the complete Clojure/SSH deployment stack would duplicate the
container topology already needed here. The harness therefore borrows its
testing model, not its deployment machinery.

## Quick start

Docker must be reachable by the current user. The first image build compiles
the pinned DoltLite binding and is much slower than subsequent source-only
rebuilds.

```sh
pnpm chaos doctor
pnpm chaos list
pnpm chaos:smoke
pnpm chaos:crash
pnpm chaos:stress
```

Build once and iterate without rebuilding:

```sh
pnpm chaos image build
pnpm chaos run smoke --seed my-reproduction --no-build
```

Run the checked-in custom example:

```sh
pnpm chaos run chaos/scenarios/restart-partition.json --seed example
```

`smoke` is the pull-request gate: three validators, quorum two, directed
latency, a minority partition, and a graceful restart. `crash` is a focused
`SIGKILL`, durable-feed recovery, stale-session, and catch-up regression. `stress` runs five
validators with quorum three and combines partitions, latency, bandwidth,
timeouts, connection resets, pause, `SIGKILL`, CPU throttling, and restart.

## Topology and workload

Each run creates fresh identities, SSB keys, group encryption material, a
static permissioned membership snapshot, and a deterministic account schema.
Every node is both writer and validator in the built-in profiles. For `N`
nodes, the harness creates `N × (N - 1)` Toxiproxy listeners: a fault on
`node-0->node-2` never implicitly damages `node-2->node-0`.

The generated static snapshot also binds each node's inner Ed25519 writer and
validator identity to that node's exact authenticated SSB feed ID through
`transportAuthor`. This makes feed provenance part of admission: replaying an
otherwise valid signed candidate, attestation, or heartbeat through a different
feed is rejected.

Workers choose from a seeded mix of transactions:

1. isolated v1→v2 migration chains that record version/checksum history,
   backfill existing rows, replace an index/view/trigger set, and query the
   migrated projection and trigger audit;
2. deliberately failing migrations that create tables, indexes, views,
   triggers, and history before a constraint error, proving atomic catalog and
   history rollback;
3. concurrent legacy-client inserts that omit additive v2 columns and
   current-client inserts that populate them, both guarded by explicit signed
   schema-version assumptions;
4. observed balance updates with a mandatory `expect` precondition and an
   append-only ledger entry;
5. two-account transfers with two observations, two expectations, two ordered
   updates, and matching debit/credit ledger legs;
6. ordered `UPDATE ... RETURNING ... ORDER BY ... LIMIT ... OFFSET` mutations;
7. empty `RETURNING` result sets;
8. inserts containing text, blobs, and nullable values;
9. multi-statement `CREATE TABLE`, `ALTER TABLE`, and ordered schema queries;
10. deliberately false assertions that must produce precondition rejections;
11. deliberately duplicated primary keys after a large sentinel update, which
   must produce an attributed execution rejection and roll back the update.

The default percentages favor contended balance changes and transfers while
still exercising every class above. Short runs begin with one attempt of every
enabled class across the worker pool, then switch to weighted random selection.
If the nominal duration expires while a slower worker still owns a coverage
slot, that worker completes its remaining slots before stopping.
A scenario can override the mix with sparse
`workload.operationWeights`; omitted kinds then have weight zero. It can also
set `maximumTransfer` and `resultSampleSize`. Every invocation records its
operation kind, arguments, publication ID, expected outcome class, and local
submission failure.

Schema assumptions use the same signed precondition path as data assumptions.
`schemaVersionPrecondition(component, version)` builds a deterministic
`EXISTS` query against `chaos_schema_migrations`, including a useful application
label. Migration and client operations use it with `draft.assert(...)`, so a
schema mismatch is replay-visible and attributed instead of becoming an
unexplained body failure. Run output and `summary.json` report counts by
operation kind, making missing migration coverage immediately visible.

The random seed fixes workload choices and fault selection. OS scheduling,
network timing, cryptographic identities, and wall-clock transaction times are
intentionally real, so replay reproduces the experiment rather than promising
byte-identical timing.

## Scenario format

A scenario has the literal format `chronolog-chaos-scenario`, 2–6 nodes, a
validator threshold, workload duration, convergence timeout, checkpoint
cadence, validator cutoff lag, workload parameters, and scheduled faults. The
cutoff lag should exceed expected honest replication/validation delay; making
it too small mostly tests watermark exclusion instead of database replay. Validation fails before
containers start if nodes, links, groups, ranges, or timing are invalid.

Supported faults are:

- `partition`: disable all directed links crossing two or more complete groups;
- `latency`: add latency and jitter to selected links or `all`;
- `bandwidth`: cap selected links in Kbit/s;
- `timeout`: discard link traffic after a configured timeout;
- `reset`: reset peer TCP connections;
- `pause`: freeze and later unfreeze a container;
- `crash`: send `SIGKILL`, then start the same container and persistent store;
- `restart`: allow a bounded graceful stop and restart;
- `cpu`: apply and later remove a Docker CPU quota.

Faults can overlap. Link disablement is reference counted and all outstanding
toxics, pauses, quotas, and stopped nodes are healed in cleanup.

## Correctness oracle

After the workload and faults finish, the harness heals the topology and
requires three consecutive stable samples. A passing run proves:

- canonical application-state digests are identical on every node;
- application schema definitions, including workload-created tables, are
  identical on every node;
- protected `chronolog_transactions` digests and exact rows are identical;
- published order lengths agree and no node is replaying;
- no encrypted payload remains pending;
- the authoritative admitted order has no pending DoltLite projection;
- replicated-record ingestion is caught up, allowing only the small bounded
  in-flight tail created by one-second validator heartbeats;
- every admitted log outcome is terminal (`accepted` or a replay-visible
  rejection);
- every admitted workload transaction has an outcome allowed by its generated
  intent, including exact assertion and constraint rejection codes;
- accepted rows have a versioned, non-empty result envelope and no failure
  attribution, while rejected rows have no result envelope and have internally
  consistent precondition, statement, or finalize attribution;
- a configurable balanced sample of accepted and rejected publications is
  queried through `transaction.getResult`; accepted envelopes must decode and
  rejected transactions must return `result_not_available`;
- each account balance and committed-update version exactly matches the sum and
  count of its append-only ledger legs;
- neither the million-unit rejection sentinel nor an extra reserved ledger row
  escaped savepoint rollback;
- accepted migration chains retain v1/v2 history and only their current
  index/view/trigger set, rejected migrations leave no catalog or history
  objects, and both legacy and current schema clients commit compatible v2 rows
  with matching trigger audits;
- every acknowledged publication is either present in the canonical log or
  has `policy_watermark_reached` evidence showing that validators can no longer
  admit its backdated timestamp;
- the workload made progress.

The last condition is specific to Chronolog's inclusion-finality design. It
does not confuse a legitimate validator-watermark exclusion with lost data,
and it does not accept mere state-root agreement as transaction convergence.

## Artifacts and replay

Every run writes `.chaos/<timestamp>-<scenario>-<seed>/` and prints the exact
path. The directory contains:

| Artifact | Contents |
| --- | --- |
| `run.json`, `scenario.json` | command, seed, and immutable expanded scenario |
| `environment.json` | host, Docker API/runtime, image ID, and harness versions |
| `cluster.json` | group, node, validator, SSB, and topology metadata |
| `history.ndjson` | timestamped operations, faults, healing, and invariant events |
| `metrics.ndjson` | per-second CPU, memory, network, block I/O, state, and restart counts |
| `logs/node-*.log` | daemon stdout/stderr captured during the run |
| `snapshots.json` | final application rows, schema rows, protected log rows, digests, revisions, and replication status |
| `snapshots.last.json` | last readable samples when convergence times out |
| `nodes/node-*` | exact DoltLite database, SSB log, control store, keys, and configuration |
| `summary.json` | pass/fail result, counts, invariants, timing, and replay command |

Replay uses the stored scenario and seed but creates a new artifact directory:

```sh
pnpm chaos replay .chaos/<run-directory> --no-build
pnpm chaos inspect .chaos/<run-directory>
```

`inspect` opens the stopped SSB logs, reports per-feed maximum sequences,
gaps/duplicates, unclean markers, and control-store counts. It rebuilds only
disposable SSB indexes when a run was interrupted; authoritative logs and node
keys are not changed.

The node directories contain ephemeral private keys and content keys. Treat
them as sensitive even though built-in runs create throwaway groups.

## Failure triage

Start with `summary.json`, then correlate the last fault and operations in
`history.ndjson`. `snapshots.last.json` distinguishes state/log/order mismatch
from connectivity, pending-payload, ingestion-backlog, or materializer problems.
The replication API exposes `feedsWithGaps`, `ingestionBacklog`, and
`materializationPending`; its state remains `syncing` while a feed prefix has a
known gap, so connected peer counts alone do not prove that a node is current.
The offline inspector reports the corresponding per-feed sequences and gaps. Use
`metrics.ndjson` to find
CPU starvation, memory growth, network stalls, or write spikes. Node stores are
retained precisely so an SSB feed, control store, or DoltLite branch can be
opened offline without trying to reproduce a transient failure first.

The runner uses host UID/GID in containers so developers can inspect and remove
artifacts without root. SIGINT triggers healing and cleanup. Testcontainers'
reaper is a second line of defense for an abruptly killed runner.

## Hardening found by the suite

The container profiles exercise persistence and catch-up paths that ordinary
unit tests do not. During development they exposed and now regress:

- SSB-DB2 acknowledging an in-memory append before its base log was drained;
- `SIGKILL` rolling an author's mutable append-log tail back after peers had
  already replicated it, fixed by a checksummed tail-block journal plus an
  exact signed-author-tail recovery store;
- stale disposable DB2 indexes and live-hook delivery gaps after restart;
- an admissible persisted control order getting ahead of its derived DoltLite
  revision, fixed by startup reconciliation and bounded retry;
- full rollback on a replay rejection restoring DoltLite's previous branch
  working set, fixed by savepoint-scoped application rollback;
- per-event whole-snapshot control persistence causing quadratic catch-up,
  fixed by coalesced rebuildable snapshots and graceful flush.

These are system guarantees, not harness workarounds. Focused package tests
cover each minimized failure, while `crash` and `stress` retain the end-to-end
regressions.

## CI policy

`.github/workflows/chaos.yml` runs smoke for pull requests and main pushes,
runs stress weekly, and permits either profile manually. It always uploads the
artifact tree, including on failure. Seeds include the workflow run and attempt
IDs, making CI failures directly replayable after download.

## Deliberate boundaries

This suite tests honest-but-faulty participants and persistent-process/network
behavior. Protocol signature/capability malformation and deterministic-IR fuzz
cases belong in faster package-level property/conformance tests. Filesystem
exhaustion, host clock injection, NAT traversal, and Kubernetes-specific pod or
volume faults need separate profiles when those deployment targets exist.
Clock tests must distinguish author-injected transaction timestamps from
validator heartbeat clocks; simply changing a container clock would not test
the former.
