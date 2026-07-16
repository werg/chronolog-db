# Protocol, Node, Validation, and Transport Implementation

Status: historical relational-IR protocol plan; the active transaction format
is defined by Specifications 10 and 11

## 1. Responsibility

This specification defines the direct edit to the signed transaction core and
the node workflows that build, validate, attest, encrypt, publish, ingest,
order, and materialize it. Ordering, capability, transaction-level validator
attestation, heartbeat cutoff, SSB identity, and encryption semantics remain as
already designed unless this document changes their data dependencies.

There is one transaction representation. It contains relational IR and no
consensus SQL strings.

## 2. Transaction core

Edit the existing `TransactionCore` directly:

```ts
interface TransactionCore {
  readonly groupId: Uint8Array
  readonly membershipRevision: Uint8Array
  readonly validationPolicy: Uint8Array
  readonly authorId: Uint8Array
  readonly authorTimestampMs: bigint
  readonly nonce: Uint8Array
  readonly executionManifestDigest: Uint8Array
  readonly schemaDigest: Uint8Array
  readonly program: TransactionProgram
  readonly metadata?: ReadonlyMap<string, Uint8Array>
}
```

Delete `executionProfile`, `preconditions: SqlPrecondition[]`, and
`statements: SqlStatement[]`. Preconditions and mutations are encoded inside
`program` using the canonical IR codec.

The existing top-level transaction record tag is edited in place. There is no
alternate legacy record or protocol negotiation.

## 3. Canonical encoding and candidate identity

The transaction codec:

1. Validates all fixed-size identifiers and digests.
2. Restricts `authorTimestampMs` to `[0, 2^63-1]`.
3. Requires a sufficiently large nonce.
4. Requires at least one IR precondition and mutation.
5. Encodes the program as a canonical nested value, not an opaque caller byte
   string with unchecked contents.
6. Rejects unknown transaction fields and non-canonical IR.

Candidate digest and signature cover the complete canonical transaction core,
including schema and execution-manifest digests. Transaction ID derivation
continues using the signed candidate plus authenticated SSB transport identity
according to the existing protocol design.

Adding validator attestations cannot change the candidate digest or ordering
tuple.

## 4. Validation tiers

### 4.1 Decode validation

All ingesting nodes perform bounded canonical decode and reject malformed
fields, IR tags, values, sizes, identifiers, and timestamps before storage in
the candidate index.

### 4.2 Admission validation

Admission verifies:

- author signature and transport binding;
- group and membership identity;
- writer capability at the referenced revision;
- validation-policy identity;
- author timestamp above applicable validator cutoffs and within configured
  future-skew limits;
- validator attestations over the exact candidate digest;
- required validator classes/organizations; and
- immutable ordering identity.

Application preconditions are not evaluated by validators.

### 4.3 Language validation

Before signing an attestation, a validator additionally verifies:

- execution manifest is exactly supported;
- schema digest/revision is exactly supported;
- IR is structurally valid;
- names/types/effects resolve against the schema;
- every function/module/profile is registered;
- no forbidden or local-only feature appears;
- semantic size limits are satisfied; and
- the candidate requests only writer capabilities it possesses.

Validators need the IR validator and manifests but do not need to materialize
the candidate or predict whether its preconditions will pass.

### 4.4 Materializer validation

The materializer repeats canonical encoding, manifest, schema, and language
validation. Validator signatures are not trusted to substitute for local
execution safety.

## 5. Draft state

Drafts live in node-local memory or a local ephemeral store and are never
replicated before publication.

```ts
interface TransactionDraftRecord {
  readonly draftId: string
  readonly groupId: Uint8Array
  readonly ownerPrincipal: string
  readonly pinnedRevision: bigint
  readonly schemaDigest: Uint8Array
  readonly executionManifestDigest: Uint8Array
  readonly reservedAuthorTimestampMs: bigint
  readonly reservedNonce: Uint8Array
  readonly expiresAtOperationalMs: number
  readonly observations: ReadonlyMap<string, DraftObservation>
  readonly preconditions: readonly Precondition[]
  readonly mutations: readonly Mutation[]
  readonly diagnostics: readonly IrDiagnostic[]
}
```

`expiresAtOperationalMs` governs local resource cleanup and is not signed or
consensus-visible.

## 6. Reserving transaction context

Beginning a draft selects and persists:

```text
author_timestamp_ms = max(local_wall_clock_ms, author_timestamp_floor + 1)
nonce = secure_random(profile_nonce_length)
```

The author timestamp floor is updated atomically before returning the draft.
The returned context remains fixed for the draft lifetime so observations that
use timestamp or entropy remain reproducible.

Rebasing normally changes only the pinned materialized revision and refreshes
observations. If the caller explicitly requests new context, the node reserves
a new timestamp and nonce and invalidates every observation and value depending
on context.

## 7. Draft operations

The node exposes internal service operations equivalent to:

```text
beginDraft
observeQueryIr
addAssertionIr
addExpectationFromObservation
addMutationIr
validateDraft
rebaseDraft
cancelDraft
publishDraft
```

Each addition decodes canonical IR, validates it against the draft's schema and
manifest, copies it into draft state, and returns diagnostics. The node assigns
or validates stable IDs according to the API contract; publication never
silently renumbers signed nodes.

Observations execute against the draft's single pinned immutable revision. An
observation result records its query, result mode, canonical result, schema
digest, revision, and context dependencies.

## 8. Publication

`publishDraft` performs:

1. Authenticate draft ownership and writer capability.
2. Check draft expiry and pinned schema/manifest availability.
3. Require at least one precondition and mutation.
4. Re-run complete IR validation.
5. Ensure every observation-derived expectation still refers to the draft's
   pinned revision and reserved context.
6. Construct `TransactionProgram` and `TransactionCore`.
7. Canonically encode twice through independent construction paths in tests.
8. Hash and sign the core with the author device key.
9. Encrypt the signed candidate under the active group epoch.
10. Publish it to the author's SSB feed.
11. Persist the exact SSB message ID/feed sequence binding.
12. Return transaction identity and reactive outcome/evidence handles.

An SSB publication failure leaves the draft retryable with identical signed
content. Idempotency keys map retries to the same signed candidate and prevent
accidental new timestamp/nonce allocation.

## 9. Validator worker

On candidate ingestion, an eligible validator:

1. Verifies envelope, encryption epoch, author signature, and transport
   identity.
2. Resolves membership and writer capability.
3. Checks its latest published acceptance cutoff.
4. Rejects locally if the candidate timestamp is at or below that cutoff.
5. Runs admission and language validation.
6. Ensures it has not signed conflicting content for the same transaction
   identity.
7. Publishes one `admit` attestation over the individual candidate digest.

The validator does not execute preconditions, sign a database root, or assign a
new order position. Attestation arrival does not alter candidate contents.

Unsupported manifest or schema is a local refusal to attest, not a canonical
transaction rejection.

## 10. Heartbeat worker

Heartbeat logic remains independent of database execution. Before publishing
cutoff `T`, a validator ensures all candidates it has accepted or may still
accept with timestamps at or below `T` have been processed under its policy.
After the heartbeat, it never signs a newly discovered candidate at or below
`T`.

Language changes do not allow a heartbeat to rewrite, finalize, or exclude an
already valid individual attestation.

## 11. Control store

The control store persists:

- encrypted candidate envelopes and canonical candidate bytes;
- SSB message/author/feed sequence identity;
- decoded candidate indexes and validation status;
- attestations and heartbeats;
- capability and encryption epoch records;
- admission proofs;
- desired ordered transaction IDs;
- materialized revision coordination state; and
- local diagnostics.

It SHOULD store schema and execution-manifest digests alongside parsed
candidates for indexing, but canonical candidate bytes remain authoritative.
All parsed/indexed control state is rebuildable from verified messages.

Because the transaction shape is edited directly, existing development control
stores are deleted and rebuilt. No local schema translator is implemented.

## 12. Admission and ordering coordinator

When a candidate becomes admitted:

1. Build its fixed order key from author timestamp and authenticated transport
   tie-breakers.
2. Insert it into the sorted admitted index.
3. Determine append or earliest insertion position.
4. Emit a desired-order revision to the materializer coordinator.
5. Coalesce multiple arrivals while preserving the earliest affected index.

The coordinator serializes materializer calls. If the admitted set changes
during replay, it schedules the newest complete desired set after the current
attempt; it does not mutate an in-progress reducer input.

## 13. SSB and encryption

The candidate envelope remains opaque encrypted payload to unauthorized peers.
Canonical IR does not leak through routing metadata. Payload chunking, digest
verification, and epoch decryption operate on exact candidate bytes.

Readers that may query application state need the data epoch key. Validators
need enough access to decrypt and validate candidates; if a deployment wants
blind relays, relay capability remains distinct from validator capability.

Group epoch rotation never changes already signed candidate bytes. Rewrapping
or republishing old plaintext under a new epoch, if later supported, must retain
the original candidate digest and transport identity rules.

## 14. Capability effects

Language operations map to capabilities:

| Operation | Required capability |
|---|---|
| Publish ordinary transaction | writer |
| Query application data | reader |
| Validate and attest candidate | validator plus required read access |
| Define initial schema/group | administrator |
| Submit schema-change transaction when enabled | schema administrator |
| Register native/WASM function or module | extension administrator |
| Run local diagnostic SQL | local node authorization |

The IR validator derives required effect capabilities from the program. The
candidate cannot understate them in metadata.

## 15. Node configuration

Group runtime configuration references:

- schema manifest bytes/path/module;
- expected schema digest;
- expected execution-manifest digest or reproducible build profile;
- database path;
- SSB and key-store configuration;
- resource and operational limits; and
- enabled local read/query surfaces.

Consensus-semantic settings belong in the execution manifest. Environment or
CLI values may select a manifest but cannot silently override fields inside it.

## 16. Tests

Required protocol/node tests:

1. Canonical transaction bytes contain IR and no SQL source fields.
2. Old raw-SQL fixture bytes are rejected.
3. Candidate digest changes for every signed manifest/schema/program/context
   field.
4. Draft timestamp/nonce remain fixed across ordinary rebase.
5. Context-changing rebase invalidates dependent observations.
6. Publication idempotency yields identical candidate bytes.
7. Validator accepts well-formed supported IR without executing preconditions.
8. Validator refuses unsupported schema/manifest/features.
9. Heartbeat cutoff prevents backdated attestation.
10. Attestation arrival does not change order.
11. SSB replication preserves exact encrypted and plaintext candidate digests.
12. Delivery permutations produce the same admitted order.
13. Control-store rebuild reproduces parsed IR indexes.
14. Capability checks derive from IR effects.
15. Materializer coordination handles changes arriving during replay.

## 17. Completion criteria

- The only transaction codec directly encodes relational IR.
- No node or validator path accepts transaction SQL strings.
- Draft context is reserved before observations and signed unchanged.
- Validators attest individual candidates after admission/language checks and
  never execute application preconditions.
- Schema and execution-manifest support is checked before attestation.
- Control-store and SSB test state are recreated rather than migrated.
- Ordering and heartbeat semantics remain independent of validation arrival and
  database outcome.
