# Documentation index

Chronolog is an unreleased prototype with one signed transaction format: exact
SQL source with canonical bindings and mandatory preconditions. Documents are
classified as follows.

| Class | Meaning |
| --- | --- |
| **Normative** | Defines behavior. When sources conflict, Specifications 10/11 define semantics and the compatibility ledger decides what is enabled. |
| **Status** | Describes the current boundary or roadmap; must track the code and ledger. |
| **Operational** | How to run, verify, or recover the system. |
| **Background** | Still useful context, but not a requirement. |
| **Historical** | Superseded relational-IR material. Never an implementation requirement. |

Run `pnpm docs:check` to verify that every relative Markdown link and anchor
resolves.

## Read first

- **Developer:** [README](../README.md) (quick start, workspace map), then
  [Specification 10](implementation-specs/10-deterministic-sql-transactions.md)
  and [Specification 11](implementation-specs/11-transaction-results-and-ordered-mutations.md),
  then the [migration guide](../packages/migrations/README.md).
- **Operator:** [Pilot runbook](pilot-runbook.md), then
  [governance](governance.md), [snapshot recovery](snapshot-recovery.md),
  [blob replication](blob-replication.md), and
  [release hardening](release-hardening.md).
- **Reviewer / security:** [Implementation status](implementation-status.md),
  [security threat review](security-threat-review.md), the
  [compatibility ledger](sqlite-compatibility-ledger.json), then
  [upcoming work](../upcoming.md).

## Normative

| Document | Status | Contents |
| --- | --- | --- |
| [implementation-specs/10-deterministic-sql-transactions.md](implementation-specs/10-deterministic-sql-transactions.md) | Normative | Signed SQL program, compiler boundary, DDL/DML execution, preconditions, replay, security profile. |
| [implementation-specs/11-transaction-results-and-ordered-mutations.md](implementation-specs/11-transaction-results-and-ordered-mutations.md) | Normative | Canonical values, result envelopes, protected log storage, attribution, ordered-target subset. |
| [sqlite-compatibility-ledger.json](sqlite-compatibility-ledger.json) | Normative (machine-readable) | Working, gated, and prohibited SQLite surfaces with conformance evidence. |
| [implementation-specs/README.md](implementation-specs/README.md) | Normative index | Precedence rules, cutover rule, dependency direction. |
| [extensions.md](extensions.md) | Normative profile | Native-versus-consensus extension boundary. |

## Status and roadmap

| Document | Status | Contents |
| --- | --- | --- |
| [implementation-status.md](implementation-status.md) | Status | What works end to end, what is gated, release gates. |
| [../upcoming.md](../upcoming.md) | Status (ordered roadmap) | Project queue and acceptance checks. |
| [security-threat-review.md](security-threat-review.md) | Status | Internal authorizer/protocol review and open findings. |
| [production-execution.md](production-execution.md) | Decision record | Why the first pilot is the native daemon, and criteria to reconsider workerd. |

## Operational

| Document | Status | Contents |
| --- | --- | --- |
| [pilot-runbook.md](pilot-runbook.md) | Operational | Install, onboard, capacity, backup, upgrade, recovery, mandatory drills. |
| [governance.md](governance.md) | Operational | Replicated capabilities, epochs, custody, recovery ceremony. |
| [snapshot-recovery.md](snapshot-recovery.md) | Operational | Signed snapshots, restore, feed-fork repair. |
| [blob-replication.md](blob-replication.md) | Operational | Opt-in authenticated envelope blob fetch and retention. |
| [release-hardening.md](release-hardening.md) | Operational | Fuzz, sanitizer, crash, soak, distribution, observability gates. |
| [chaos-testing.md](chaos-testing.md) | Operational | Container fault and load testing. |
| [drill-evidence.md](drill-evidence.md) | Operational | Recording, signing, verifying, and gating release drill evidence. |
| [../packages/migrations/README.md](../packages/migrations/README.md) | Operational | Application migrations, schema assumptions, catalog tooling. |

## Background

| Document | Status | Contents |
| --- | --- | --- |
| [design.md](design.md) | Background (partially superseded) | Protocol design: membership, attestation, ordering, watermarks, encryption. Its relational-IR sections are marked superseded in its header. |
| [../packages/materializer/README.md](../packages/materializer/README.md), [../packages/runtime-workerd/README.md](../packages/runtime-workerd/README.md) | Background | Portable materializer contract and experimental workerd adapter. |
| [workerd-reconstruction-plan.md](workerd-reconstruction-plan.md) | Background | Options and staged plan for a real workerd execution target. |
| [handover-2026-10-23.md](handover-2026-10-23.md) | Status (dated) | Review and hardening pass: fixes, verification, open items in priority order. |

## Historical

Everything below is superseded by Specifications 10 and 11 and carries a
banner saying so.

| Document | Status | Contents |
| --- | --- | --- |
| [sql-dialect.md](sql-dialect.md) | Historical (still at its original path) | Removed relational-IR dialect reference. Candidate for `archive/`. |
| [archive/implementation-plan.md](archive/implementation-plan.md) | Historical | Original scaffold delivery plan. |
| [archive/implementation-design.md](archive/implementation-design.md) | Historical | Original relational-IR architecture. |
| [archive/implementation-specs/01-direct-cutover.md](archive/implementation-specs/01-direct-cutover.md) to [09-conformance-delivery.md](archive/implementation-specs/09-conformance-delivery.md) | Historical | Relational-IR specification series 1-9 (cutover, canonical IR, compiler, reducer, protocol/node, client/RPC, kernels, native extensions, conformance). |
