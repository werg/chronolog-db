# Native-daemon pilot runbook

This is the release-candidate checklist for one Chronolog group. Record the
operators, release commit, archive SHA-256/attestation, OS, filesystem, storage
class, Node version, engine digest, and command results in the pilot evidence
bundle. A pilot is not production-ready while a threat-review finding remains
release-blocking.

## Install and preflight

1. Verify the GitHub OIDC build attestation and run `chronolog-verify` after
   extracting the OS/architecture archive.
2. Put `bin/` on `PATH`; provision a persistent mode-`0700`
   `CHRONOLOG_DATA_DIR` owned by the daemon account.
3. On Linux, install `libsecret-tools`, unlock a dedicated Secret Service
   collection, and set `CHRONOLOG_SECRET_STORE=secret-service`.
4. Supply RPC and blob-peer bearer tokens through the supervisor's secret
   environment. Non-loopback RPC without a token fails startup.
5. Supervise graceful `SIGTERM`, bounded restarts, and an open-file limit based
   on characterization. Never run two processes on one data directory.
6. Require `/health` HTTP 200 and run `chronolog doctor`. Preserve the ready
   event, doctor output, and `/metrics` baseline.

For public SSB, configure an operator-reviewed address or discovery service
and an independent HTTPS verification service:

```sh
CHRONOLOG_SSB_SCOPE=public
CHRONOLOG_PUBLIC_SSB_ADDRESS='net:public.example:8008~shs:KEY'
CHRONOLOG_NAT_VERIFICATION_URL='https://probe.example/verify-ssb'
```

The verifier must make a real SSB connection from an external network and
return the exact address and observed server key. A public node remains
degraded until this succeeds. Verification does not create a firewall/router
mapping.

## Onboard and validate

1. Exchange the participant's Ed25519 public key, authenticated SSB feed ID,
   and reader X25519 key over an independent channel.
2. Submit the minimum role using `chronolog governance grant @grant.json`.
   Validator timestamp floors default to grant time; record any override.
3. Run `chronolog governance rotate` after reader removal or key exposure.
   Confirm removed identities cannot write, validate, or decrypt new epochs.
4. Run governance status, replication, and doctor on every participant. Require
   the expected revision digest/epoch/roles and no gaps or quarantines.
5. Apply checksummed migrations, wait for settlement/watermark, inspect the
   pinned catalog, and run old/new client transactions with explicit schema
   assumptions.

## Capacity and alerting

Run characterization on the actual storage class with pilot-like rows, result
sizes, replay depth, and peer count. Record p50/p95/p99 operational latency,
RSS, repository/blob bytes, replay duration, and free-space headroom. Do not
present one host's measurements as protocol limits.

Alert when `chronolog_up == 0`, quarantined feeds or gaps are non-zero,
materialization exceeds the characterized p99 window, revision progress stalls
under traffic, RSS crosses budget, or free space falls below the larger of 20%
and two snapshot sizes. Blob deployments also alert on remote fetch failures
and size for indefinite immutable retention.

## Backup, restore, and upgrade

1. Stop the daemon and export a signed snapshot to protected storage. Back up
   Secret Service separately; snapshots deliberately contain no private keys.
2. Restore on a disposable host with an independently confirmed current admin
   signer. Restart, run doctor, compare catalog/queries, and keep the previous
   database through sign-off.
3. Before upgrade, back up data/secrets, unpack beside the old package, verify
   it, and run the explicit previous-package-to-candidate upgrade drill.
4. Start the candidate on unchanged data. Require stable group/node/SSB/
   manifest/governance/epoch identities, replication convergence, migration
   status, and an accepted canary. Downgrade only when release notes declare
   storage compatibility; otherwise restore the verified backup.

## Recovery and incidents

- For quorum loss, three independent custodians inspect the same payload via an
  independent channel. Any two sign offline; combine and verify publicly before
  publishing recovery. Record approvals and digests, never private shares.
- For a feed fork, stop and retain the original directory. Obtain the signed
  snapshot and complete prefix independently, then use snapshot repair. Keep
  both branch IDs, quarantine evidence, plan, backup, and rebuild diagnostics.
- For blob loss, never fabricate or bypass a digest. Restore an exact retained
  copy or authenticated peer; unresolved chunks remain pending.
- For key/token exposure, revoke capabilities, rotate epoch and service tokens,
  inspect history reopening, and decide whether threshold recovery is needed.

## Mandatory drills and exit evidence

Witness: clean install; two-node onboarding; schema migration with old/new
clients; reader removal/rotation; three-person custody plus two-person recovery;
previous-to-candidate upgrade when a prior release exists; snapshot restore;
synthetic fork repair; cache-miss multi-host blob fetch; externally verified
traversal; crash/restart; and alert delivery.

Attach conformance, fuzz/sanitizer/crash/soak results, SBOM, provenance,
attestations, characterization, doctor/health/metrics output, manifests,
ceremony records, incident artifacts, unresolved findings, and the exact commit
to the independent security-review packet.
