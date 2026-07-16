# Replicated Governance

Chronolog's default daemon profile derives authorization and encryption state
from signed administration records carried by the same durable SSB transport as
transaction traffic. Static membership files are an explicit compatibility
override, not the normal multi-node control plane.

## Bootstrap and custody

On first start, `chronologd` writes `governance.json` with mode `0600`. It
contains the signed genesis, the local HPKE reader key, and a development
2-of-3 recovery kit. The genesis gives the local identity administrator,
schema-administrator, writer, validator, and audit-reader capabilities and
binds those protocol keys to the daemon's authenticated SSB feed.

The generated recovery keys make local development recoverable, but co-located
keys do not provide production quorum security. Before a durable deployment,
export the three recovery private keys to separate offline custodians and
remove them from the online host. OS-backed key storage and packaged recovery
ceremonies remain release-hardening gates.

## Live operations

`GovernanceControlPlane` in `@chronolog/node-core` is the current programmatic
administration surface:

- `publishCapabilityChange` atomically grants roles, revokes capability IDs,
  installs validation policies, or transfers the root/feed;
- `revoke` removes every selected active capability at the next revision;
- `rotateEpoch` publishes a fresh content key wrapped independently to every
  active reader;
- `grantHistoricalAccess` rewraps retained epochs only for an active audit
  reader; and
- `publishRecovery` relays a record authorized by the genesis recovery
  threshold, even when the active administrator is unavailable.

Every controller rebuilds the same revision snapshots and epoch chain from
transport history and follows new records live. Capability records and epoch
manifests must originate on the signed current administration feed. Recovery
records instead rely on their embedded threshold signatures so any participant
can relay one.

## Removal and history policy

Revocation immediately prevents new writes and validator proofs at the new
membership revision. Rotate the epoch after removing a reader: the removed
device may retain plaintext and old epoch keys it already possessed, but it is
not included in the new manifest and cannot decrypt later traffic.

A snapshot reader receives only epochs explicitly published to it while its
grant is active. An audit reader may receive historical keys through an
explicit rewrap. Historical access never changes old transaction bytes.

Recovery can install a new root, administration feed, and validator set. If it
deliberately lowers the accepted history floor, the signed record must set
`reopenHistory`; the daemon then records the recovery digest in the control
store and settlement evidence reports it for affected transactions.

## Static override

Setting `CHRONOLOG_STATIC_MEMBERSHIP_FILE` disables the replicated governance
profile for that process. This is useful for compatibility tests and controlled
fixtures, but changes require matching file distribution and restarts. Do not
mix static and governed nodes as though they shared one live membership model.
