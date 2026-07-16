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

## SBOM and provenance

```sh
pnpm release:metadata
```

The command builds the repository, emits a CycloneDX 1.6 component inventory,
and writes an in-toto/SLSA provenance statement covering every compiled file
and native patch. Dependency identity is tied to the exact pnpm lock digest.
Tag and manual release workflows run production conformance on Linux and macOS,
generate the metadata, and request GitHub OIDC build-provenance attestations.
These are release-evidence artifacts, not yet an installable distribution.

## OS-backed key custody

Linux pilot hosts can set `CHRONOLOG_SECRET_STORE=secret-service` to migrate
daemon identity, epoch, recipient, and bootstrap-recovery private material out
of JSON and into the host Secret Service. See the governance guide for host
requirements, migration behavior, and the remaining requirement to separate
recovery shares across custodians.

## Outstanding release gates

- signed, platform-specific installation artifacts and verified upgrade paths
  (SBOM, provenance generation, and CI attestations are implemented);
- macOS/Windows OS key providers and hardware-backed custody policy (Linux
  Secret Service migration is implemented);
- feed-fork quarantine/repair, trusted snapshot import/export, and large-payload
  blob manifests;
- NAT discovery, sizing envelopes, alertable observability, and runbooks;
- authorizer/protocol threat review with every finding resolved or accepted;
- an independent external security review of the release candidate.

The active manifest must never advertise one of these operational capabilities
merely because an interface or test fixture exists.
