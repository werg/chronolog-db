# Trusted snapshots and feed repair

Snapshot operations are offline and take the same data-directory lock as the
daemon. Stop `chronologd` cleanly before running them; a live daemon causes a
fail-closed `DATA_DIRECTORY_LOCKED` error. A stale crash lock is quarantined,
not silently reused.

## Export and import

```sh
CHRONOLOG_DATA_DIR=/var/lib/chronolog chronolog-snapshot export /secure/snapshot-r120
CHRONOLOG_DATA_DIR=/var/lib/chronolog chronolog-snapshot import /secure/snapshot-r120 \
  --signer BASE64URL_AUTHORIZED_ADMIN_PUBLIC_KEY \
  --confirm-replace
```

An export contains only `application.db`, the canonical signed snapshot
manifest, and a fixed-name archive index. It never copies daemon signing,
recipient, epoch, recovery, RPC, or SSB secret material. The manifest binds the
group, execution manifest, materialized revision/order, Dolt content hash,
every protected transaction-log field, and canonical feed heads.

Import verifies fixed filenames, size and SHA-256 evidence, the authorized
signature, group and execution manifest, and a no-rollback floor equal to the
locally materialized revision. It copies to a same-directory stage, fsyncs it,
opens the stage through the production DoltLite adapter, and independently
rechecks revision, order, content hash, and the exact protected-log digest.
Only the literal confirmation flag permits the final atomic rename. The prior
database remains as `application.db.pre-snapshot-rREVISION`; the rebuildable
`control.json` is moved aside so the next start reconstructs it from the
authenticated transport log. Keep the backup until restart, health,
replication, governance, and application queries are verified.

The `--signer` value is an explicit operator trust decision. Obtain it from the
current governance state over an independent channel; possession of an archive
does not make its signer trusted.

## Quarantined-feed repair

Repair adds `--plan FILE` to the import operation:

```sh
chronolog-snapshot repair /secure/snapshot-r120 \
  --signer BASE64URL_AUTHORIZED_ADMIN_PUBLIC_KEY \
  --plan trusted-prefix.json \
  --confirm-replace
```

The plan names one quarantined feed, the trusted head, and the complete
sequence-1-through-head transport records with canonical base64url payloads.
The trusted head must exactly match that feed's head in the signed snapshot;
the prefix must be gap-free and every previous link must match. Repair records
the rejected side of the observed fork as discarded, clears quarantine only
after resolving the exact recorded conflict, and then rebuilds derived state.
When the old SSB history is replayed, explicitly discarded record identities
are skipped rather than re-quarantining or entering consensus state.

Do not use ordinary import to conceal a feed fork. Keep the original data
directory, archive, quarantine evidence, repair plan, previous database, and
restart diagnostics for forensic review.
