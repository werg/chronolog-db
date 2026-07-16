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
remove them from the online host.

On Linux, set `CHRONOLOG_SECRET_STORE=secret-service` to keep the daemon
signing key, epoch content key, governance recipient key, and development
recovery keys in the host Secret Service through `secret-tool`.
`CHRONOLOG_SECRET_SERVICE` optionally changes the service namespace. Existing
inline `config.json` and `governance.json` files are migrated atomically to
reference-only v2 documents on the first successful start. Secret values are
sent over stdin and never placed in process arguments.

The host needs `libsecret-tools`, a reachable Secret Service provider, and an
unlocked collection for the daemon account. Startup fails closed if a v2
document is opened without that provider or a referenced secret is missing.
Back up custody before enabling migration; switching the environment back to
`file` does not copy secrets into JSON. One OS account is still one failure
domain. The custody tool performs an explicit two-step handoff:

```sh
CHRONOLOG_SECRET_STORE=secret-service pnpm custody export /media/handoff
# Give exactly one recovery-share-N file to each independent custodian.
# Each custodian verifies and stores their share on their offline device.
CHRONOLOG_SECRET_STORE=secret-service pnpm custody purge /media/handoff \
  --confirm-external-custody
```

Export verifies all three private shares against the immutable genesis public
keys and writes mode-`0600` files plus a public custody manifest. Purge verifies
those files again, requires the literal confirmation flag, changes
`governance.json` to v3 `recoveryCustody: external`, and removes the online
Secret Service references. The daemon then starts without loading any recovery
private key. Purge does not delete the handoff files: deleting or sanitizing the
transfer medium is an operator action after the three independent copies have
been tested. Do not treat three files on one medium, three secrets under one OS
account, or three shares held by one person as a quorum.

Recovery signing itself is network-independent:

```sh
pnpm recovery prepare @recovery-spec.json > payload.base64url
pnpm recovery inspect @payload.base64url
# Run separately on two isolated custodian devices:
pnpm recovery sign @payload.base64url 0 @recovery-share-0.pkcs8.base64 > share-0.signed
pnpm recovery sign @payload.base64url 2 @recovery-share-2.pkcs8.base64 > share-2.signed
# Combine and verify where only public custody data is needed:
pnpm recovery combine @payload.base64url @share-0.signed @share-2.signed > recovery-record.base64url
pnpm recovery verify @recovery-record.base64url @recovery-custody.json
pnpm cli governance recover @recovery-record.base64url
```

The prepare specification pins the current `groupId`, governance revision and
revision digest from `chronolog governance status`, the replacement root/feed,
the complete replacement validator grants and timestamp floors, and whether
the action explicitly reopens history. Custodians should inspect the decoded
payload, compare it over an independent channel, and never expose their PKCS#8
share to the online daemon. A pilot must still execute and record the actual
three-person handoff and two-person recovery drill before release.

## Live operations

The daemon exposes the control plane through authenticated `governance.*` RPC
methods and the `chronolog governance` CLI. Remote administration uses the
same required bearer token as every other remote RPC; a static-membership node
fails these commands with `failed_precondition`.

```sh
pnpm cli governance status
pnpm cli governance grant @reader-grant.json
pnpm cli governance revoke CAPABILITY_ID
pnpm cli governance rotate
pnpm cli governance history SUBJECT_ID
pnpm cli governance recover @signed-recovery-record.base64url
```

A grant file contains public material only. For example:

```json
{
  "subjectId": "BASE64URL_SUBJECT_ID",
  "signingPublicKey": "BASE64URL_ED25519_PUBLIC_KEY",
  "transportAuthor": "@participant-feed.ed25519",
  "role": "reader",
  "readerScope": "snapshot",
  "hpkePublicKey": "BASE64URL_X25519_PUBLIC_KEY"
}
```

Reader grants require a scope and HPKE public key. Validator grants default
their minimum author timestamp to the daemon's current time unless an explicit
unsigned decimal value is supplied. Epoch keys are generated inside the
daemon and never returned by RPC. Recovery accepts only a canonical, already
threshold-signed record for the same group, so custodians can authorize it
offline and an untrusted participant can relay it.

`GovernanceControlPlane` in `@chronolog/node-core` backs that surface:

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
