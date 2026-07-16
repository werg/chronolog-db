# Release hardening

Status: active; the repository is not yet a production release

This guide separates checks that run on every change from slower or
toolchain-mutating release checks. Passing these commands is necessary but does
not replace an external security review or operator pilot.

## Deterministic fuzz corpora

```sh
pnpm test:fuzz
```

The checked-in seeds cover arbitrary bounded canonical CBOR, mutations of the
transaction-result envelope, and arbitrary bounded SQL compiler input. Every
accepted mutation must re-encode byte-for-byte; rejected inputs must fail with
an ordinary error rather than terminate the process. Seeds and case counts are
fixed so CI failures reproduce locally. These tests complement, rather than
replace, coverage-guided native fuzzing.

## Publication crash recovery

```sh
pnpm test:publication-crash
```

Each case starts a child materializer and sends it `SIGKILL` after a named
durability boundary. Reopen must expose the previous revision before the atomic
head move and the new revision after it. No intermediate revision is valid.

## Recovery soak and resource characterization

```sh
pnpm characterize
pnpm test:soak
```

Both commands repeatedly append transactions, inject older predecessors,
replay suffixes, close and reopen the native repository, and verify the exact
protected log and application row count. The JSON report splits deterministic
workload/replay/state evidence from operational wall time, RSS, and repository
bytes. Compare operational values only on equivalent release hardware; compare
the deterministic section everywhere.

The scheduled release-hardening workflow preserves soak reports as CI
artifacts. Pilot sizing must record the exact commit, engine digest, platform,
storage class, and characterization options rather than presenting one machine
as a universal capacity promise.

## Native sanitizers

```sh
pnpm test:native-sanitizers
```

This command rebuilds the installed DoltLite native dependency with Clang
AddressSanitizer and UndefinedBehaviorSanitizer, then runs native SQL,
authorizer, and publication-crash integration tests. It mutates the local
native build and should run in a clean CI checkout or disposable worktree. A
normal `pnpm install --force` restores the pinned non-sanitized dependency.

## Native distribution, SBOM, and provenance

```sh
pnpm release:distribution
pnpm test:distribution-upgrade
pnpm release:metadata
```

The distribution command requires a clean worktree and uses pnpm's isolated
deployment to assemble the daemon, online CLI, custody tool, offline recovery
CLI, TypeScript runtime, and native dependencies for the current OS and
architecture. It rejects escaping symlinks, records every regular file's hash
and size, emits a relocatable tar archive, and includes `chronolog-verify` for
post-extraction verification. Node.js 22 or later remains a host prerequisite.

The upgrade drill verifies the package, starts it on a fresh persistent data
directory, checks health and CLI status, stops cleanly, verifies the replacement
package, and reopens the same identity, SSB feed, execution manifest,
governance revision, and epoch. With no prior published release, the default
drill is same-build package replacement; pass `--from` and `--to` to the tool
for the mandatory previous-release-to-candidate drill once a prior artifact
exists.

Metadata generation builds the repository, emits a CycloneDX 1.6 component
inventory, and writes an in-toto/SLSA provenance statement covering compiled
files, native patches, and distribution artifacts. Dependency identity is tied
to the exact pnpm lock digest. Tag and manual release workflows run production
conformance and the package/upgrade drill on Linux and macOS, then request
GitHub OIDC build-provenance attestations over the archive and evidence.

## OS-backed key custody

Linux pilot hosts can set `CHRONOLOG_SECRET_STORE=secret-service` to migrate
daemon identity, epoch, recipient, and bootstrap-recovery private material out
of JSON and into the host Secret Service. See the governance guide for host
requirements, migration behavior, and the remaining requirement to separate
recovery shares across custodians. The verified export/purge workflow and
network-independent signer prove key/genesis matching and absence from the
daemon store; release evidence must additionally record a real handoff to
three independent custodians and a two-custodian drill.

## Network and observability

`/health` returns readiness/replay/degraded state and uses HTTP 503 for feed
gaps, quarantines, or node errors. `/metrics` emits bounded label-free
Prometheus metrics and requires the configured bearer token. It covers
materialized revision, order/candidate/admission counts, replay pending state,
feed gaps/quarantines, transport records, RSS, and heap use.

Set `CHRONOLOG_PUBLIC_SSB_ADDRESS` for an operator-verified public multiserver
address, or configure an HTTPS `CHRONOLOG_NAT_DISCOVERY_URL` that returns
`{"address":"net:host:port~shs:key"}`. Discovery is bounded and non-fatal. It
does not create a router mapping or prove inbound reachability.

Every consumed feed is checked by author, sequence, record ID, and previous
link. A conflict is persisted to `feed-continuity.json`, makes the node
non-writable, and appears in status/metrics. The repair primitive accepts only
a complete prefix ending at an explicitly trusted head, but operators must not
apply it until the trusted snapshot/full derived-state rebuild workflow lands.

Signed snapshot manifests and the offline snapshot CLI now provide exact
archive hashing, signer/group/manifest/rollback checks, independent staged
Dolt/log validation, atomic database replacement with backup, derived-state
rebuild, and signed-head-bound fork repair. Content-addressed blob stores
provide local chunk integrity; cross-node fetching remains disabled.

## Outstanding release gates

- previous-release-to-candidate upgrade evidence (self-verifying Linux/macOS
  artifacts, same-build replacement, SBOM, provenance, and CI attestations are
  implemented);
- macOS/Windows OS key providers and hardware-backed custody policy (Linux
  Secret Service migration and independent recovery export/sign/purge tooling
  are implemented; the pilot ceremony remains required);
- production drill evidence for trusted snapshot import/fork repair and the
  still-disabled cross-node large-payload fetch path;
- NAT discovery, sizing envelopes, alertable observability, and runbooks;
- resolution or explicit acceptance of every finding in the
  [internal threat review](security-threat-review.md);
- an independent external security review of the release candidate.

The active manifest must never advertise one of these operational capabilities
merely because an interface or test fixture exists.
