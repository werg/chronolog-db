# Upcoming Work

Status: active ordered roadmap for the unreleased SQL-first prototype

This file is the execution queue. Work proceeds from top to bottom. A project
is complete only when its acceptance checks pass and the implementation status
and compatibility ledger describe the resulting boundary accurately.

Intentional prohibitions such as transaction control, attachments, temporary
state, dynamic extensions, `VACUUM`, and protected-state access are not backlog
items unless a separate design decision changes that policy.

## Project 1 — Reconcile roadmap and specification status

Status: complete

- Make Specifications 10 and 11 the clearly identified normative SQL-first
  contract.
- Mark Specifications 1–9 and the former implementation plan as historical
  relational-IR design material where they conflict with Specification 10.
- Update the result/ordered-mutation implementation status to match the
  compatibility ledger and executable coverage.
- Make `docs/implementation-status.md` the concise human-readable source of
  current capability and `docs/sqlite-compatibility-ledger.json` the
  machine-readable feature boundary.

Acceptance:

- [x] No roadmap index describes relational IR as the active transaction path.
- [x] Specifications 10/11, implementation status, README, and ledger agree.
- [x] Documentation links identify historical versus normative material.

## Project 2 — SQLite parser alignment and differential corpus

Status: complete

- Align the parser grammar with the pinned SQLite 3.54 runtime, or pin a
  measured compatibility boundary when an exact grammar is unavailable.
- Add a corpus runner that compares parse category, prepare outcome, statement
  class, parameters, result shape, affected rows, and stable errors.
- Cover every ledger statement/expression family plus malformed and
  version-skew fixtures.
- Fail closed on any unclassified parser/runtime disagreement.

Acceptance:

- [x] `pnpm conformance:sqlite` runs the checked-in differential corpus.
- [x] Every mismatch is classified in the compatibility ledger.
- [x] The parser/runtime temporary-debt entry is resolved or narrowed with
      executable evidence.

## Project 3 — Machine-readable conformance and platform CI

Status: complete

- Add `pnpm conformance` and a versioned report schema containing source,
  manifest, fixture, platform, feature, test-group, and replay digests.
- Check canonical fixtures and replay digests across supported platforms.
- Add Linux/macOS CI, with Windows enabled only if the native runtime is
  supportable without weakening the profile.
- Publish reports and failure artifacts from CI.

Acceptance:

- [x] Reports are deterministic except explicitly operational metadata.
- [x] CI compares portable semantic digests across supported platforms.
- [x] Enabled features have linked passing evidence for the exact manifest.

## Project 4 — Migration and revisioned schema tooling

Status: complete

- Provide an application migration-history convention with IDs, versions,
  checksums, and signed exact/minimum-version assertions.
- Add revision-pinned catalog inspection and catalog diffing.
- Add CLI `migrations status`, `apply`, and `wait` workflows with explicit
  accepted, rejected, conflicting-checksum, and watermark-excluded states.
- Generate optional TypeScript bindings from a pinned catalog revision without
  introducing an authoritative consensus schema manifest.
- Add live resources for migration settlement and schema revision changes.

Acceptance:

- [x] Migration helpers are application-facing rather than chaos-only.
- [x] Reapplying an identical migration is safe and a checksum conflict fails.
- [x] CLI and client integration tests cover replay and concurrent old/new
      clients.

## Project 5 — Operational capability and epoch control plane

Status: complete

- Implement live onboarding/removal, capability grant/revocation, recovery,
  epoch/content-key rotation, and historical-access policy.
- Persist and replicate administration events instead of requiring matching
  static membership files and restarts.
- Add compromised-node replacement and quorum-loss recovery workflows.

Acceptance:

- [x] Multi-node tests onboard, revoke, rotate, recover, and converge.
- [x] Removed participants cannot author, validate, or decrypt new epochs.
- [x] Recovery and history-reopening effects are visible in settlement evidence.

## Project 6 — Deterministic SQL row-choice expansion

Status: in progress

- Add canonical REAL input bindings.
- Complete scalar subqueries and nested/unordered `LIMIT` proofs.
- Add `INSERT ... SELECT`, `CREATE TABLE ... AS SELECT`, `UPDATE ... FROM`,
  and conflict-sensitive mutation forms only with explicit row-choice proofs.
- Expand ordered update/delete support through ledger-recorded conformance.

Acceptance:

- [ ] Each enabled surface has compiler, reference, replay, result, and fault
      fixtures.
- [ ] Corresponding ledger entries move from `temporarily_gated` only after
      those fixtures pass.

## Project 7 — Aggregates, compounds, and windows

Status: pending

- Determinize `DISTINCT`, `GROUP BY`, representative-sensitive `MIN`/`MAX`,
  distinct compounds, windows, and ordered/order-sensitive aggregates.
- Define canonical peer/tie completion and bounded sort/resource behavior.

Acceptance:

- [ ] Independent reference and DoltLite results agree for adversarial ties,
      Nulls, dynamic types, and duplicate encodings.
- [ ] Replay and cross-platform digests agree.

## Project 8 — Registered extensions and advanced indexes

Status: pending

- Complete registered deterministic functions and collations.
- Gate virtual tables and table-valued functions behind immutable identities
  and resource contracts.
- Complete replay gates for JSON operators, trigger `RAISE`, FTS, sqlite-vec,
  spatial features, and deterministic WASM.
- Characterize `ANALYZE` and `REINDEX`; keep them gated if physical effects
  cannot be made replay-safe.

Acceptance:

- [ ] Every enabled extension has a pinned implementation digest, reference
      behavior, resource limits, and cross-platform replay evidence.
- [ ] Unavailable modules fail before validation or execution.

## Project 9 — Production workerd/CAS execution path

Status: pending

- Decide and record whether the first deployment target is pure workerd or the
  native daemon.
- If workerd remains the target, implement the fail-closed JSG/DoltLite kernel,
  immutable CAS export/import, real workerd execution, and daemon publication
  cutover.
- Preserve exact stepping, result, error, limit, checkpoint, and replay
  contracts across adapters.

Acceptance:

- [ ] The selected production path runs the same conformance corpus and replay
      digests as the reference native path.
- [ ] Publication and CAS failure boundaries are crash-tested.

## Project 10 — Release and operational hardening

Status: pending

- Add fuzzing, native sanitizers, crash injection at publication boundaries,
  long-running recovery/storage tests, and deterministic resource/performance
  characterization.
- Produce signed native distributions, provenance/SBOMs, and OS-backed key
  storage.
- Add feed-fork quarantine/repair, snapshot trust workflows, blob manifests,
  NAT discovery, deployment sizing, and operational observability.
- Complete authorizer/protocol threat review and external security review.

Acceptance:

- [ ] No unresolved release-blocking fuzz, sanitizer, crash, or security finding.
- [ ] Pilot operators can install, onboard, rotate, recover, inspect, and
      upgrade without editing internal stores.
- [ ] The active manifest advertises no unimplemented or unproven feature.
