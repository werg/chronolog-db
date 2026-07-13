# Chronolog DB

Chronolog DB is a working TypeScript prototype of a decentralized,
permissioned SQL database. It replicates exact signed transactions, orders them
by immutable author-asserted wall-clock timestamps, validates inclusion with
transaction-level validator attestations, and deterministically replays late
predecessors. Validators never sign database roots or vote on state.

The core behavior is implemented end to end:

- Strict deterministic CBOR, domain-separated SHA-256, and Ed25519 protocol
  messages.
- Signed capability revisions with readers, writers, validators,
  administrators, class/organization validation policies, and 2-of-3 recovery.
- RFC 9180 HPKE epoch key wrapping and AES-256-GCM encrypted SSB envelopes.
- Durable SSB-DB2 feeds plus authenticated, explicitly allow-listed EBT peer
  replication.
- Mandatory typed-IR `assert` and exact-result `expect` preconditions.
- A replay-visible, reducer-protected `chronolog_transactions` log containing
  accepted and rejected transactions.
- Checkpointed suffix replay when an older transaction arrives, including
  reactive outcome changes.
- A long-running daemon, HTTP/NDJSON streaming RPC, TypeScript client, React
  hooks, and CLI.

The protocol and architecture are described in [the design](docs/design.md),
[deterministic SQL dialect and relational IR specification](docs/sql-dialect.md),
[implementation design](docs/implementation-design.md), and
[implementation plan](docs/implementation-plan.md). The direct implementation
of the deterministic runtime is specified subsystem by subsystem in the
[implementation specification suite](docs/implementation-specs/README.md).
The exact working/gated feature boundary is tracked in
[implementation status](docs/implementation-status.md).

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

The daemon creates `.chronolog/config.json` and `.chronolog/schema.cbor` with
mode `0600`, opens a durable SSB feed and application/control stores, enables
encrypted envelopes, starts a single-root writer/validator bootstrap policy,
and listens on
`http://127.0.0.1:8787`. Its ready event prints the group ID, SSB feed ID, and
SSB address. The default schema manifest is empty; applications normally
generate canonical `schema.cbor` with `SchemaBuilder` from `@chronolog/ir`, or
point `CHRONOLOG_SCHEMA_FILE` at one before the database is first opened.

In another terminal:

```sh
pnpm cli status
pnpm cli query @query.cbor '[]' '[]'
pnpm cli transact @transaction.json
pnpm cli local-sql 'SELECT * FROM chronolog_transactions'
pnpm cli schema-generate @schema.cbor schema.generated.ts --execution-digest BASE64URL_DIGEST
```

`query` takes canonical query IR bytes (or unpadded base64url), parameter names,
and exact logical parameters. A transaction file contains canonical assertion,
observation, and mutation IR. Observations become exact-result preconditions by
default. `local-sql` is intentionally separate and every result is marked
`consensusSafe: false`; raw SQL cannot enter a replicated transaction.

The CLI also supports `outcome`, `evidence`, `watermark`, and `replication`.
Set `CHRONOLOG_URL`, `CHRONOLOG_GROUP_ID`, and `CHRONOLOG_TOKEN` when connecting
to a non-default daemon. Transaction specifications can be read from a file by
prefixing its path with `@`.

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

Only configured feed IDs are requested through EBT. SSB authenticates the
connection and feed, while Chronolog independently verifies the inner protocol
signature, capability revision, validation policy, group route, epoch, and
ciphertext. A multi-member deployment supplies capability snapshots through
`CapabilityMembershipResolver`; the daemon's generated configuration is the
single-participant bootstrap mechanism.

## Workspace

| Package | Responsibility |
| --- | --- |
| `canonical` | Strict bounded CBOR, UTF-8, bytes, typed hash domains |
| `ir` | Relational AST, schema/execution manifests, codecs, validation, builders |
| `compiler-sqlite` | Catalog-aware IR lowering and deterministic engine manifests |
| `protocol` | Signed transaction/attestation messages and immutable order keys |
| `capabilities` | Genesis, grants, revocations, policies, recovery |
| `crypto` | HPKE, signed epochs, content encryption, key-store interfaces |
| `transport-ssb` | Durable SSB-DB2 feeds, EBT networking, deterministic simulator |
| `control-store` | Rebuildable candidates, attestations, order, heartbeats, evidence |
| `materializer-doltlite` | IR execution, exact log, Dolt checkpoints, suffix replay |
| `node-core` | Ingestion, validation, admission, encryption, orchestration |
| `rpc` | Local service contract, in-process and HTTP transports |
| `client` / `react` | Reactive client, transaction drafts, framework bindings |
| `kernels` | Exact int64, decimal, text, JSON, entropy, and vector algorithms |
| `testkit` | Manual clocks, permutations, network test helpers |

## Current engineering boundary

This is a comprehensive prototype, not a production release. The materializer
is native-DoltLite-only: it never opens a Dolt database through `node:sqlite`
and never silently falls back to an engine without Dolt commits. Startup fails
closed on schema/execution digest mismatch or when the patched binding lacks a
required reducer control. Checkpoints identify real Dolt commits and are
recovered from Dolt branch refs, then verified against the protected log.

DoltLite is patched at build time to statically register pinned sqlite-vec
0.1.9 while dynamic extension loading remains disabled. Native sqlite-vec,
FTS5, JSON1, and RTree are tested for Dolt transaction/branch behavior, but
FTS, spatial search, WASM, and sqlite-vec indexes remain disabled in consensus
IR until their cross-platform replay gates are satisfied. Exact JSON, decimal,
and ordinary vector values are available through the deterministic compiler;
the standalone kernel package supplies the fuller algorithms targeted for the
next execution-profile integration.

Before production use, the remaining work is operational hardening: a reviewed
distribution of the small DoltLite authorizer shim, OS-backed keystores, capability
and epoch administration commands in the daemon, blob manifests for large
payloads, feed-gap/fork quarantine, reconnection scheduling and NAT discovery,
resource sizing and load testing, cross-platform CI, and external security review. The
implementation plan retains the full acceptance criteria for those items.
