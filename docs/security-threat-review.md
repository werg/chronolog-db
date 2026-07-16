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
| Feed equivocation | Author/sequence/previous continuity registry; persistent quarantine; node becomes non-writable and degraded | Repair requires an offline trusted prefix and full derived-state rebuild |
| Unauthorized SQL or protected-state access | Whole-program compiler gates plus a native authorizer backstop; compiler and authorizer adversarial tests | Exact parser grammar remains one SQLite release behind and is measured by differential corpus |
| Ambient time/random/filesystem or transaction control | Closed function/pragma/module registries and explicit prohibited statement classes | Newly enabled native functions require a manifest identity and conformance evidence |
| Row, representative, peer, or conflict nondeterminism | Structural row-choice proofs, canonical result ordering, bounded ordered mutation identities, replay corpus | Broader catalog-dependent proofs remain gated |
| Partial candidate publication or crash | Private replay branch, independent reader verification, atomic head move, five-point `SIGKILL` matrix | Filesystem/hardware failure behavior still depends on the supported storage stack |
| Replay result substitution | Protected result bytes and domain-separated digest verified on reopen | Stored-data format migration is intentionally absent in the prototype |
| Capability or epoch rollback | Signed revision chain, exact previous digest, scoped readers, epoch chain, threshold recovery records | Recovery shares co-located under one account do not form a production quorum |
| Plaintext daemon private keys | Reference-only v2 config/governance documents and Linux Secret Service migration | Other OS/hardware providers and independent recovery custody remain open |
| Blob substitution or truncation | Per-chunk and total domain-separated digests, bounded resolution, content-addressed stores | No production cross-node chunk fetch protocol; blob mode is not active by default |
| Snapshot rollback or foreign-state import | Authorized signature, group/manifest match, minimum revision, exact DB/log/feed-head identities | Archive export/import and atomic replacement workflow remain open |
| RPC credential disclosure or unauthenticated remote bind | Remote bind requires bearer token; timing-safe comparison; metrics share authentication | Bearer tokens need deployment TLS/secret rotation outside this process |
| Dependency/build substitution | Pinned lockfile, native source checksum/patches, SBOM, subject hashes, OIDC provenance attestations | Installable platform distributions are not yet published or upgrade-tested |

## Findings and disposition

- `SEC-001` — Recovery keys generated for development remain co-located even
  when placed in one Secret Service collection. Release blocker: separate
  shares among independent custodians and test the ceremony.
- `SEC-002` — Blob manifests have exact local storage and wire verification but
  no authenticated inter-node fetch/retention protocol. Feature disabled by
  default; it must not appear in an active manifest.
- `SEC-003` — Snapshot manifests are signed and anti-rollback checked, but
  archive creation, import staging, and atomic store replacement are absent.
  Snapshot import is not an operator capability yet.
- `SEC-004` — Feed repair validation exists, but applying a repaired prefix
  safely requires the missing trusted snapshot/state rebuild. Quarantined nodes
  halt writing instead of attempting an unsafe online repair.
- `SEC-005` — NAT discovery trusts an explicitly configured HTTPS service and
  validates one SSB multiserver address. It does not create a port mapping or
  prove reachability; operator/firewall verification remains required.
- `SEC-006` — Release workflows attest conformance reports, SBOM, and
  provenance, but there is no installable signed distribution or upgrade test.
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
