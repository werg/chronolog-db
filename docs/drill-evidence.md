# Drill evidence tooling

`pnpm drill` records, signs, verifies, and gates the human drills that the
release checklists require (custodian handoff, snapshot restore and fork repair,
multi-host blob fetch, public-address traversal, alert delivery, upgrade, and
external review). It turns "we ran the drill" into an offline-verifiable bundle
bound to one release commit. It is a bookkeeping and tamper-evidence tool; it
does not run any drill.

Implementation: `tools/drill.ts`, `tools/lib/drill-evidence.ts`,
`tools/lib/common.ts`. Tests: `tools/lib/drill-evidence.test.ts`.

## Workflow

1. Each participant creates a signing key once and shares only the public key:

   ```sh
   pnpm drill keygen --out alice.key.json   # mode 0600; prints fingerprint and public key
   ```

2. The release owner keeps a **roster** outside the evidence bundle
   (`chronolog-drill-roster-v1`): per fingerprint, the roles that key may hold
   and an `independenceGroup` (organization or team). Drills that require
   independent people check that groups differ. Pin the roster by its SHA-256,
   which the gate prints.

3. After the drill, draft an unsigned record next to its artifacts. Artifacts
   (logs, doctor output, manifests) must live under `--dir`; their SHA-256 and
   size are recorded:

   ```sh
   pnpm drill record --kind snapshot-repair --dir evidence/snapshot-repair \
     --commit "$(git rev-parse HEAD)" --started 2026-05-01T10:00:00Z \
     --completed 2026-05-01T11:00:00Z \
     --participant operator=<PUBLIC_KEY> --participant reviewer=<PUBLIC_KEY> \
     --env os=linux --env node=22 --env filesystem=ext4 --env storageClass=ssd \
     --check snapshot_exported_signed --check restore_on_disposable_host ... \
     --artifact snapshot-manifest=manifest.json ...
   ```

   `pnpm drill schema` prints the JSON Schema, including the required roles,
   environment keys, checks, and artifact names for every kind.

4. Every declared participant signs the same record with their own key:

   ```sh
   pnpm drill sign --record evidence/snapshot-repair/snapshot-repair.drill.json --key alice.key.json
   ```

5. Anyone can verify offline, and the release gate scans an evidence tree:

   ```sh
   pnpm drill verify --record <file> --roster roster.json --commit <sha>
   pnpm drill gate --roster roster.json --evidence evidence/ --commit <sha>
   ```

   The gate reports each drill as `SATISFIED`, `INVALID` (a record exists but
   fails verification, with the reasons), or `MISSING`, and exits non-zero unless
   all are satisfied. A drill with no evidence directory is `MISSING`.

## What verification checks

Fail-closed, with any unexpected error treated as invalid: exact record shape;
the exact release commit; sane timestamps; required environment keys and
details; every participant's key matching its fingerprint and present in the
roster with the claimed role; role quotas and independence groups; exactly one
valid Ed25519 signature per participant over the canonical CBOR body under the
`chronolog/drill-evidence/v1` domain, and none from anyone else; every required
check present and passed; every required artifact present, a regular file
inside the bundle, with matching size and SHA-256 recomputed from disk; and
kind-specific rules (an upgrade must cross versions; an external review must
name the packet manifest digest).

## What it cannot prove

- That the signing keys belong to distinct real people, or that roster
  independence groups are honest. The roster is an input the release owner
  supplies and must vouch for out of band.
- That the drill actually happened, or that the checks recorded as passed are
  true. Signatures prove only that the key holders attested to the record;
  artifacts prove only that those bytes existed and were not altered later.
- That the artifacts are meaningful. The tool hashes files; a human reviewer
  must read them. A satisfied gate explicitly does not replace that review.
- Freshness beyond the record's own timestamps, or revocation of a compromised
  participant key (rotate the roster and re-sign).

## Status

`tools/lib/review-packet.ts` (an evidence-packet builder for external
reviewers) is present but unfinished: it is not wired into `pnpm drill` or any
script, is untested, and should not be relied on yet.
