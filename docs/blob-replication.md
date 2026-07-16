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
