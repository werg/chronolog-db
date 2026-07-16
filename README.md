# Chronolog DB

Chronolog DB is a working TypeScript prototype of a decentralized,
permissioned SQL database. It replicates exact signed transactions, orders them
by immutable author-asserted wall-clock timestamps, validates inclusion with
transaction-level validator attestations, and deterministically replays late
predecessors. Validators never sign database roots or vote on state.

The core behavior is implemented end to end:

- Strict deterministic CBOR, domain-separated SHA-256, and Ed25519 protocol
  messages.
- Signed capability-revision and recovery primitives with readers, writers,
  validators, administrators, class/organization validation policies, and
  2-of-3 recovery.
- RFC 9180 HPKE epoch-key wrapping primitives and AES-256-GCM encrypted SSB
  envelopes.
- Durable SSB-DB2 feeds plus authenticated, explicitly allow-listed EBT peer
  replication.
- Direct signed SQL transaction programs with mandatory `assert` or exact-result
  `expect` preconditions.
- A replay-visible, reducer-protected `chronolog_transactions` log containing
  accepted and rejected transactions.
- Checkpointed suffix replay when an older transaction arrives, including
  reactive outcome changes.
- A long-running daemon, HTTP/NDJSON streaming RPC, TypeScript client, React
  hooks, and CLI.

The protocol background is described in [the design](docs/design.md). The
current deterministic transaction architecture is specified in
[deterministic SQL transactions](docs/implementation-specs/10-deterministic-sql-transactions.md),
[transaction results and ordered mutations](docs/implementation-specs/11-transaction-results-and-ordered-mutations.md),
and the rest of the
[implementation specification suite](docs/implementation-specs/README.md).
The exact working/gated feature boundary is tracked in
[implementation status](docs/implementation-status.md), and the ordered work
queue is maintained in [upcoming work](upcoming.md). Container fault and
load testing is documented in the [chaos testing guide](docs/chaos-testing.md).
The first pilot targets the native daemon; the rationale and executable gate
are documented in [production execution](docs/production-execution.md). Slow
fuzz, sanitizer, crash, soak, and sizing gates are in the
[release-hardening guide](docs/release-hardening.md).

This is a direct implementation with no legacy transaction decoder, schema
migration path, state-merge fallback, or alternate SQLite backend. Development
databases, feeds, and fixtures are recreated when the canonical schema changes.

## Quick start

Requirements are Node.js 22 or newer, pnpm, Python 3, and a C/C++ build
toolchain supported by `node-gyp`. The first install downloads the pinned
DoltLite 0.11.29 source archive, verifies its SHA-256 checksum, and compiles the
small patched binding locally.

```sh
pnpm install
pnpm test
pnpm demo
```

`pnpm demo` starts an encrypted memory-transport node backed by a temporary
DoltLite database. A late predecessor changes an already accepted transaction
to `rejected_precondition` after checkpoint restoration and suffix replay.

Start a persistent standalone node:

```sh
pnpm dev
```

The daemon creates `.chronolog/config.json` with mode `0600`, opens a durable
SSB feed and application/control stores, enables encrypted envelopes, starts a
single-root writer/validator bootstrap policy, and listens on
`http://127.0.0.1:8787`. Its ready event prints the group ID, SSB feed ID, and
SSB address. Application schemas are created and evolved by deterministic SQL
DDL in ordinary replicated transactions.

In another terminal:

```sh
pnpm cli status
pnpm cli query 'SELECT * FROM accounts WHERE id = ?' '[{"$int64":"1"}]'
pnpm cli transact @transaction.json
pnpm cli outcome TRANSACTION_ID
pnpm cli result TRANSACTION_ID
pnpm cli migrations status @migration.json
pnpm cli migrations apply @migration.json --watermark
pnpm cli catalog inspect
pnpm cli catalog bindings > generated-catalog.ts
```

`query` executes a local read-only SQL statement with an optional JSON array of
bindings. Transaction files contain `assertions`, `observations`, and a required
`statements` array; each entry has `sql`, optional `bindings`, and an optional
application `label`. Observations become exact-result preconditions unless
`expect` is explicitly false. JSON bindings use ordinary JSON scalars plus
`{"$int64":"..."}` and `{"$blob":"BASE64URL"}` for exact integers and blobs.

The TypeScript client accepts conventional compiled-query structures
(`{ sql, parameters }`) directly. Local reads use `client.query()`. Replicated
transactions use `tx.observe()`, `tx.expect()`, `tx.assert()`, and `tx.exec()`;
publication requires at least one precondition and an effect-capable body. SQL
text and canonical bindings are the signed transaction bytecode. The pinned
compiler parses every statement, validates the deterministic subset, and the
materializer executes the same bytes under a restrictive SQLite authorizer.

The CLI also supports `outcome`, `evidence`, `watermark`, and `replication`.
Set `CHRONOLOG_URL`, `CHRONOLOG_GROUP_ID`, and `CHRONOLOG_TOKEN` when connecting
to a non-default daemon. The daemon refuses to bind RPC to a non-loopback host
unless a non-empty `CHRONOLOG_TOKEN` is configured. Transaction specifications can be read from a file by
prefixing its path with `@`.

Application migrations are ordinary atomic SQL transactions recorded in
`application_migrations`; there is no privileged schema transaction or
authoritative schema manifest. Migration files contain `component`, `id`,
positive `version`, and `statements`; the CLI derives and verifies a checksum
over that exact bundle. `migrations wait` reports accepted, rejected,
watermark-excluded, or timeout settlement explicitly. See the
[migration package guide](packages/migrations/README.md) for signed schema
assumptions, revision-pinned catalog diffs, and advisory TypeScript generation.

## Container chaos testing

The repository includes a seeded, artifact-producing P2P chaos runner using
Testcontainers, directed Toxiproxy links, and Docker process/resource faults.
It checks canonical state, the exact protected transaction log, replay
quiescence, ingestion/materializer backlog, and validator-watermark exclusion
evidence rather than relying on state-root agreement alone.

```sh
pnpm chaos doctor
pnpm chaos:smoke
pnpm chaos:crash
pnpm chaos:stress
```

Each run retains histories, node logs and stores, convergence snapshots,
resource metrics, environment/image metadata, and an exact replay command
under `.chaos/`. See the [chaos testing guide](docs/chaos-testing.md) for custom
scenarios and failure triage.

## Connecting SSB peers

The daemon binds SSB to loopback on an ephemeral port by default. Configure a
stable listener and an explicit permissioned peer list with:

```sh
CHRONOLOG_SSB_HOST=0.0.0.0 \
CHRONOLOG_SSB_PORT=8008 \
CHRONOLOG_SSB_SCOPE=public \
CHRONOLOG_SSB_PEERS='[{"address":"net:host:8008~shs:PUBLIC_KEY","feedId":"@FEED.ed25519"}]' \
pnpm dev
```

For public discovery, set an operator-verified
`CHRONOLOG_PUBLIC_SSB_ADDRESS`, or point `CHRONOLOG_NAT_DISCOVERY_URL` at a
trusted HTTPS service returning one JSON multiserver address. The ready event
reports the source or failure. This discovers an address; it does not configure
router port forwarding.

Only configured feed IDs are requested through EBT. SSB authenticates the
connection and feed, while Chronolog independently verifies the inner protocol
signature, capability revision, validation policy, group route, epoch, and
ciphertext.

Without `CHRONOLOG_STATIC_MEMBERSHIP_FILE`, the daemon creates or reloads a
signed governance genesis in `governance.json`, consumes replicated capability,
recovery, and epoch-manifest records, and changes authorization and encryption
keys without a restart. The bootstrap grants the local identity administrator,
schema-administrator, writer, validator, and audit-reader roles and creates a
2-of-3 development recovery kit. The file is mode `0600`; production operators
must export the recovery keys to independent offline custody before treating a
group as durable. See the [governance guide](docs/governance.md).

Linux hosts can set `CHRONOLOG_SECRET_STORE=secret-service` (and optionally
`CHRONOLOG_SECRET_SERVICE`) to migrate daemon and governance private material
from JSON into an unlocked Secret Service collection. Startup then requires
that provider and fails closed on a missing reference.

`CHRONOLOG_STATIC_MEMBERSHIP_FILE` remains an explicit legacy/testing override.
It points every daemon at the same out-of-band JSON snapshot, whose group,
membership revision, and validation policy must match the corresponding values
in each node's `config.json`:

```json
{
  "format": "chronolog-static-membership",
  "groupId": "<canonical-base64-32-bytes>",
  "membershipRevision": "<canonical-base64-32-bytes>",
  "validationPolicy": "<canonical-base64-32-bytes>",
  "writers": [
    {
      "publicKey": "<canonical-base64-Ed25519-public-key>",
      "transportAuthor": "@writer-feed.ed25519"
    }
  ],
  "validators": [
    {
      "publicKey": "<canonical-base64-Ed25519-public-key>",
      "capability": "<canonical-base64-32-bytes>",
      "transportAuthor": "@validator-feed.ed25519"
    }
  ],
  "threshold": 1,
  "watermarkThreshold": 1,
  "policyVersion": "1"
}
```

Start each participant with, for example,
`CHRONOLOG_STATIC_MEMBERSHIP_FILE=/etc/chronolog/membership.json pnpm dev`.
`watermarkThreshold` defaults to `threshold`; the decimal-string
`policyVersion` defaults to `"1"` and is bound into validator attestations.
Every operational writer and validator entry must include the exact
`transportAuthor` SSB feed ID that may carry messages signed by that protocol
key. This outer-feed binding prevents a valid signed envelope copied into a
different feed from acquiring false authenticated provenance. Legacy shapes
without the mapping may parse, but cannot authorize that participant's
transport traffic.

The static file is an out-of-band bootstrap snapshot, not replicated consensus
state and not a live administration interface. In the default profile,
`chronolog governance` provides status, live grants/revocations, epoch
rotation, audit-history rewrapping, and relay of an offline-signed threshold
recovery record. Independent recovery custody and the packaged offline signing
ceremony remain release work.

## Workspace

| Package | Responsibility |
| --- | --- |
| `canonical` | Strict bounded CBOR, UTF-8, bytes, typed hash domains |
| `ir` | Canonical logical-value and execution-manifest codecs |
| `compiler-sqlite` | Deterministic SQL parsing, validation, and engine manifests |
| `conformance` | Versioned SQLite differential corpus, direct/native-daemon replay equivalence, and portable platform reports |
| `protocol` | Signed transaction/attestation messages and immutable order keys |
| `capabilities` | Genesis, grants, revocations, policies, recovery |
| `crypto` | HPKE, signed epochs, content encryption, key-store interfaces |
| `transport-ssb` | Durable SSB-DB2 feeds, EBT networking, deterministic simulator |
| `control-store` | Rebuildable candidates, attestations, order, heartbeats, evidence |
| `materializer` | Portable exact-ref contracts, coordinator/query/publication interfaces, and differential fixtures |
| `materializer-doltlite` | Profiled SQL execution, exact result/log storage, Dolt checkpoints, and suffix replay |
| `migrations` | Checksummed application migrations, signed schema assumptions, catalog snapshots/diffs, and advisory bindings |
| `runtime-workerd` | Experimental named immutable-input controller, run/follow contract, and crash-reconciling CAS publication seam |
| `node-core` | Ingestion, validation, admission, encryption, orchestration |
| `rpc` | Local service contract, in-process and HTTP transports |
| `client` / `react` | Reactive client, transaction drafts, framework bindings |
| `kernels` | Exact int64, decimal, text, JSON, entropy, and vector algorithms |
| `testkit` | Manual clocks, permutations, network test helpers |
| `chaos` | Container topology, fault scheduling, stress workloads, checkers, artifacts |

## Current engineering boundary

This is a comprehensive prototype, not a production release. The materializer
is native-DoltLite-only: it never opens a Dolt database through `node:sqlite`
and never silently falls back to an engine without Dolt commits. Startup fails
closed on schema/execution digest mismatch or when the patched binding lacks a
required reducer control. Checkpoints identify real Dolt commits and are
recovered from Dolt branch refs, then verified against the protected log.

The transport-neutral workerd adapter is implemented without Node, N-API, or
SSB runtime imports. It validates named `previous`/`replayBase` refs and the
engine/execution tuple before invoking an injected database kernel, accepts
only exact CAS reads, and keeps publication separate. Its CAS helper verifies
immutable output reachability before a generation-guarded ref move and
reconciles ambiguous failures by exact read. This is not actual workerd
execution: the host/kernel and immutable exporter remain unimplemented.

`node-core` consumes portable materialization coordinator, immutable query,
and publication-store interfaces instead of the concrete DoltLite class. The
shipped daemon composes those interfaces with the production-selected native
DoltLite adapter. `pnpm conformance:production` requires that composition to
match the direct native replay digest. RPC handlers
similarly consume a narrow service contract rather than constructing or typing
against `ChronologNode` directly.

DoltLite is patched at build time to statically register pinned sqlite-vec
0.1.9 while dynamic extension loading remains disabled. Native sqlite-vec,
FTS5, JSON1, and RTree are tested for Dolt transaction/branch behavior, but
FTS, spatial search, WASM, and sqlite-vec indexes remain disabled in consensus
IR until their cross-platform replay gates are satisfied. The engine-pinned
JSON scalar/arrow surface and deterministic trigger `RAISE` actions are enabled;
unknown functions, collations, modules, and table-valued functions fail during
compilation. Exact JSON, decimal, and ordinary vector values are available
through the deterministic compiler. See the [extension profile](docs/extensions.md)
for the native-versus-consensus boundary.

Before production use, the remaining work is operational hardening: a reviewed
and signed distribution of the small DoltLite authorizer shim, non-Linux and
hardware-backed key providers,
capability and epoch administration commands in the daemon, remote blob fetch,
trusted snapshot replacement and full fork repair, verified NAT traversal,
deployment-specific resource sizing, and external security review. The
implementation plan retains the full acceptance criteria for those items.
