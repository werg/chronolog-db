# Authorizer and protocol threat review

Status: internal review complete for the current prototype; independent review
pending

This review covers the code and active manifest at commit time. It is not an
external audit and does not authorize production use. Findings that describe a
disabled feature are still tracked so an interface cannot silently become a
release claim.

## Assets and trust boundaries

The protected assets are author and administrator signing keys, HPKE recipient
and epoch keys, exact signed transaction bytes, validator evidence, feed
continuity, the canonical transaction order, protected result/log rows, the
published Dolt head, and operator credentials.

The principal boundaries are:

1. unauthenticated network bytes to authenticated SSB records;
2. authenticated outer feed identity to the inner Chronolog signer;
3. signed protocol bytes to capability- and policy-authorized candidates;
4. authored SQL to the parser/compiler and native SQLite authorizer;
5. candidate replay state to the atomic published Dolt head;
6. local RPC callers to draft/query/publication authority;
7. JSON references to OS-held private material;
8. immutable blob/snapshot identities to locally trusted bytes; and
9. build source and lockfiles to release evidence.

## Reviewed controls

| Threat | Control and executable evidence | Residual boundary |
| --- | --- | --- |
| Non-canonical, oversized, or ambiguous protocol input | Strict bounded canonical CBOR; fixed-seed mutation fuzzing; versioned codecs | Coverage-guided native fuzzing remains scheduled release work |
| Feed impersonation or copied signed payload | SSB authentication plus capability-revision binding of inner signer to exact outer feed | A feed-key compromise remains equivalent to that transport identity |
| Feed equivocation | Author/sequence/previous continuity registry; persistent quarantine; node becomes non-writable and degraded; signed-head snapshot repair accepts only a complete prefix and discards the recorded losing identity during rebuild | Operator signer/head selection and the repair ceremony require pilot evidence |
| Unauthorized SQL or protected-state access | Whole-program compiler gates plus a native authorizer backstop; compiler and authorizer adversarial tests | Exact parser grammar remains one SQLite release behind and is measured by differential corpus |
| Ambient time/random/filesystem or transaction control | Closed function/pragma/module registries and explicit prohibited statement classes | Newly enabled native functions require a manifest identity and conformance evidence |
| Row, representative, peer, or conflict nondeterminism | Structural row-choice proofs, canonical result ordering, bounded ordered mutation identities, replay corpus | Broader catalog-dependent proofs remain gated |
| Partial candidate publication or crash | Private replay branch, independent reader verification, atomic head move, five-point `SIGKILL` matrix | Filesystem/hardware failure behavior still depends on the supported storage stack |
| Replay result substitution | Protected result bytes and domain-separated digest verified on reopen | Stored-data format migration is intentionally absent in the prototype |
| Capability or epoch rollback | Signed revision chain, exact previous digest, scoped readers, epoch chain, threshold recovery records, verified share export/purge, offline signing and threshold verification | A production quorum exists only after a recorded independent-custodian ceremony and drill |
| Plaintext daemon private keys | Reference-only v2 config/governance documents and Linux Secret Service migration | Other OS/hardware providers and independent recovery custody remain open |
| Blob substitution or truncation | Per-chunk and total domain-separated digests, bounded resolution, content-addressed stores | No production cross-node chunk fetch protocol; blob mode is not active by default |
| Snapshot rollback or foreign-state import | Fixed archive paths and hashes, authorized signature, group/manifest/no-rollback checks, staged production-adapter DB/log verification, fsynced atomic replacement and retained backup | Pilot restore/repair drill and platform filesystem qualification remain required |
| RPC credential disclosure or unauthenticated remote bind | Remote bind requires bearer token; timing-safe comparison; metrics share authentication | Bearer tokens need deployment TLS/secret rotation outside this process |
| Dependency/build substitution | Pinned lockfile, native source checksum/patches, clean-worktree native archives, per-file verification, SBOM, subject hashes, package replacement drill, OIDC provenance attestations | A prior-release-to-candidate drill and publication ceremony require an actual earlier release |

## Findings and disposition

- `SEC-001` — The daemon can now verify/export each genesis recovery share,
  remove all online references after explicit confirmation, and run canonical
  prepare/sign/combine/verify steps offline. Release blocker remains procedural:
  three independent custodians must complete the handoff and a two-person drill
  on the exact release candidate; a local test cannot establish human custody.
- `SEC-002` — Blob manifests have exact local storage and wire verification but
  no authenticated inter-node fetch/retention protocol. Feature disabled by
  default; it must not appear in an active manifest.
- `SEC-003` — Snapshot export/import now hashes fixed archive paths, validates a
  staged database against signed logical evidence, retains the old database,
  atomically replaces the materializer, and forces derived-state rebuild.
  Release evidence still needs a packaged pilot restore on each supported
  filesystem.
- `SEC-004` — Feed repair is now an offline signed-snapshot operation: the
  complete prefix must end at the signed head and resolve the recorded fork,
  while the losing identity is persistently discarded during replay. A pilot
  must execute and independently review the forensic repair ceremony.
- `SEC-005` — NAT discovery trusts an explicitly configured HTTPS service and
  validates one SSB multiserver address. It does not create a port mapping or
  prove reachability; operator/firewall verification remains required.
- `SEC-006` — Release workflows now build self-verifying platform archives,
  attest the archive and evidence, and run a packaged persistent-data
  replacement drill. Before the first non-bootstrap upgrade, run the same tool
  from the latest published artifact to the exact candidate; there is no prior
  release against which that evidence can yet be produced.
- `SEC-007` — The workerd/CAS implementation remains an experimental contract,
  not an active deployment target.
- `SEC-008` — Independent security review has not occurred. This is a release
  blocker even if all internal tests pass.

## Review gate

Any change to protocol domains/codecs, capability admission, wire encryption,
the SQL compiler allowlist, native authorizer, publication sequence, snapshot
trust, blob resolution, or secret storage must update this document and add or
identify executable evidence. An external reviewer must receive the exact
release commit, SBOM, provenance, conformance report, sanitizer/fuzz results,
and every unresolved finding above.
