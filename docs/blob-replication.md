# Large-payload blob replication

Blob mode is an explicit daemon deployment option. Without
`CHRONOLOG_BLOB_MAX_INLINE_BYTES`, envelopes remain inline and no blob HTTP
route or remote fetcher is configured.

```sh
CHRONOLOG_BLOB_MAX_INLINE_BYTES=65536
CHRONOLOG_BLOB_CHUNK_BYTES=1048576
CHRONOLOG_BLOB_PEERS='[
  {"url":"https://node-b.example","token":"node-b-rpc-token"},
  {"url":"https://node-c.example","token":"node-c-rpc-token"}
]'
```

An author splits an encrypted envelope into bounded immutable chunks, stores
them below `CHRONOLOG_DATA_DIR/blobs`, and publishes only the signed payload
manifest through SSB. A reader first checks its local content-addressed store,
then tries configured peers in order over authenticated HTTPS. Loopback HTTP is
allowed for tests and single-host deployments. Each response is bounded by
declared and actual length, verified against the requested domain-separated
chunk digest, persisted locally, and verified again on every later read. Only
after all chunks reconstruct the manifest does the wire layer verify the outer
payload digest, decrypt, and verify the inner protocol signature.

The daemon serves `GET /blobs/HEX_DIGEST` under the same bearer-token policy as
RPC and metrics, with immutable caching headers. The route exposes encrypted
envelope chunks, not plaintext SQL or keys. Peer tokens should be distinct per
deployment, delivered through the supervisor, and protected by TLS. A remote
404 moves to the next peer; network or integrity failures are retryable ingest
errors and never substitute bytes into consensus state.

There is deliberately no automatic garbage collection yet: fetched and
authored chunks are retained. Operators must size `blobs/`, monitor disk use,
and keep at least two independently administered peers for manifests that are
not reconstructible from inline SSB history. Do not manually delete chunks
referenced by retained feed history. A future retention protocol must prove
global reachability before deletion and is a separate compatibility decision.

## Garbage-collection design analysis (not implemented)

Status: analysis only. No collector, quarantine, or `blob` command exists, and
nothing in this section changes the rule above: there is no automatic GC and no
distributed GC. The analysis records what a future operator-invoked, local-only
collector would have to preserve.

### What "reachable" means today

- The daemon replays the entire local SSB history on every start
  (`ChronologNode.start` drains `transport.history()`), and `#decodeRecord`
  loads every manifest-backed candidate, attestation, and heartbeat envelope
  through the blob store. There is no replay horizon: history is never
  truncated and snapshots contain only `application.db` plus signed feed heads.
  Snapshot import therefore does not release any chunk; the log is replayed
  afterwards.
- So a chunk is reachable if any record in any local feed, of any message type,
  names it in a payload manifest. This holds regardless of admission outcome,
  attestation, timestamp (including a late predecessor whose author timestamp
  precedes the materialized order), discard marker from fork repair, or age of
  the chunk file. Deleting such a chunk makes the next restart fail ingestion
  until a peer re-serves it.
- Chunks served to lagging peers are a subset of the above: peers can only ask
  for chunks of records that exist in our log.
- In-flight fetches and author-side puts (`storeEnvelopePayload` writes chunks
  before the envelope is published) are only safe to reason about with the
  daemon stopped, so any collector must hold the data-directory lock.
- Genuinely unreferenced files are therefore limited to: chunks stored by a
  publish that crashed before the envelope was appended, stale `*.tmp` files
  from interrupted writes, and files left by a rolled-back or replaced SSB log.

### Invariants a collector must preserve

1. Exclusive `chronolog.lock` is held for the whole mark and sweep.
2. Reachable set = union over every record returned by the transport history.
   The mark phase must fail closed if any envelope or manifest does not decode,
   a digest appears with conflicting sizes, any feed prefix is not contiguous
   from sequence 1 with intact previous links, the transport vector clock
   disagrees with the records seen, `feed-continuity.json` contains a
   `(feed, sequence, id)` the log lacks (a rolled-back log), or a feed is
   quarantined.
3. Referenced chunks are never candidates, whatever their age; referenced
   corrupt or missing chunks are reported, not removed.
4. Only unreferenced, canonical-path, regular files older than a grace window
   are candidates. Symlinks and unknown names are left alone.
5. Deletion is two-stage: atomic move into a same-filesystem quarantine with an
   fsynced intent journal, restore with digest verification, and a separate
   purge that re-marks and restores anything that became referenced.
6. Every stage is written to an append-only audit log before and after it acts.
7. Operator-supplied holds (snapshot archives, pre-snapshot backups, an explicit
   timestamp) may only lower the retention floor. A log that is behind a held
   snapshot's feed heads blocks collection.

### Evidence needed for a deletion to be provably safe

- The mark evidence digest (feed heads plus sorted reachable digests), computed
  under the lock, recorded in the journal and audit log.
- The file is unreferenced by that digest, canonical, unchanged between plan and
  move (size, mtime, inode), and older than the retention floor.
- For purge, a fresh mark showing it is still unreferenced and a quarantine age
  expiry.

### Peer-availability caveat

Local proof is not distributed proof. A collector can show that no record in
this node's log needs a chunk. It cannot show that no remote peer will need it.
The main case is a log rollback: if `ssb/` is restored from an older backup while
`blobs/` is newer, chunks we authored for records the log no longer holds may be
the only copy a lagging peer can fetch. Do not collect after restoring or
replacing the SSB log until every feed has re-replicated. Keep two independently
administered peers holding manifest chunks, as above.

### Open work

The collector, `blob stats|gc|restore|purge` command, and tests (late-predecessor
reference, partially fetched blob, corrupt manifest, concurrent daemon lock,
restore from quarantine, crash mid-sweep) have not been built.
