# FTS5, sqlite-vec, Spatial, and Deterministic WASM Implementation

## 1. Responsibility

This specification defines registered features that cross SQLite module,
native-code, shadow-table, numeric, tokenizer, or WASM boundaries. None is
enabled merely because the local SQLite build exposes a function or module.
Each feature has a manifest entry, compiler lowering, protected storage,
reference behavior, and conformance gate.

## 2. Native DoltLite patch strategy

The existing pnpm patch to `@dolthub/doltlite` remains the single reviewed
native integration point. Extend it rather than loading arbitrary shared
libraries at runtime.

### 2.1 Source layout

Add repository-owned verified sources:

```text
native/
  manifest/
  kernels/
  wasm/
vendor/
  sqlite-vec/
    SOURCE.json
    sqlite-vec.c
    LICENSE-APACHE
    LICENSE-MIT
```

`SOURCE.json` records upstream repository, exact commit/tag, archive/source
digest, Chronolog patch digest, license files, and enabled compilation units.

### 2.2 Build integration

Update the patched `binding.gyp` to compile the kernel bridge and selected
sqlite-vec source into the DoltLite addon. Static SQLite extension sources use
`SQLITE_CORE` and unique named entry points.

Connection initialization order is fixed:

1. Open DoltLite connection.
2. Apply SQLite security configuration that must precede schema access.
3. Register statically linked modules/functions on that connection.
4. Register Chronolog kernel functions and collations.
5. Apply/verify limits and remaining per-connection configuration.
6. Measure native manifest.
7. Verify stored execution manifest.

Prefer direct named initialization on every connection over process-global
implicit state. Dynamic `load_extension` remains disabled.

### 2.3 Native addon API

Expose only reviewed operations:

```ts
interface NativeChronologFeatures {
  nativeManifest(): NativeManifest
  initializeChronologExtensions(): NativeExtensionStatus
  verifyChronologExtensions(): NativeExtensionStatus
  registerWasmManifest(manifestBytes: Uint8Array, moduleBytes: Uint8Array): void
}
```

Initialization is idempotent per connection. Applications cannot obtain a raw
SQLite pointer or register arbitrary native callbacks.

## 3. Managed derived index model

FTS, vector, spatial, and materialized indexes use the same model:

- ordinary application/source tables contain authoritative logical values;
- schema IR declares the derived index;
- only reducer internal mode creates or mutates index/shadow tables;
- maintenance happens in the candidate's top-level SQLite transaction;
- queries use typed IR operators rather than arbitrary module SQL;
- rebuild reads source rows in primary-key order;
- verification compares logical source/index membership; and
- failure rolls back the entire candidate or aborts replay operationally.

Physical page or shadow-table identity is not a protocol value. Logical query
results and consistency digests are.

## 4. FTS5

### 4.1 Schema

```ts
interface FullTextIndexManifest {
  readonly objectId: number
  readonly name: string
  readonly sourceRelationId: number
  readonly sourcePrimaryKey: readonly number[]
  readonly columns: readonly FullTextColumn[]
  readonly tokenizer: TokenizerManifest
  readonly prefixes: readonly number[]
  readonly detail: 'full' | 'column' | 'none'
  readonly columnSize: boolean
  readonly ranking: RankingManifest
}
```

The compiler creates managed external-content or contentless FTS tables only
from approved forms. Direct FTS DDL is absent from application IR.

### 4.2 Tokenization

Initial registered tokenizers:

- `ascii` with fixed behavior;
- `unicode61` with every option explicit and the SQLite source pinned;
- `porter` over an explicit base tokenizer; and
- `trigram` with explicit case/diacritic options.

Do not accept arbitrary tokenizer strings. Tokenizer option order is
canonicalized in the schema manifest.

### 4.3 Maintenance

For each changed source row, reducer maintenance derives old/new indexed text
and updates FTS state in primary-key order. Bulk rebuild deletes/recreates index
state on an unpublished branch and inserts source rows in primary-key order.

If FTS uses an integer rowid mapping, mapping is stored in a protected ordinary
table with explicit stable identity. Prefer an explicit supported application
integer primary key where possible. Mapping assignment and rebuild must be
deterministic and collision-safe.

### 4.4 Query

FTS query strings are parsed client/node-side into canonical FTS query IR. The
compiler renders the audited FTS5 grammar. Result order always ends in source
primary key.

Native BM25 floating score is local-only in the portable profile. Consensus
ranking uses:

- an exact fixed-point Chronolog ranking kernel; or
- deterministic ordinal ranks produced from a registered implementation.

Snippets/highlights are bounded display values unless committed by a
precondition, in which case tokenizer and formatting fixtures must cover them.

### 4.5 Gate

FTS is enabled only after transaction rollback, branch switching, Dolt commit,
checkpoint restore, late replay, rebuild, reopen, crash, tokenizer, ranking,
tie, and shadow-protection tests pass.

## 5. sqlite-vec

### 5.1 Source pin

Pin an exact sqlite-vec source release/commit and checksum. Its pre-1.0 status
means Chronolog SHALL NOT use a version range or infer semantic compatibility
from a future package release.

Only the core `sqlite-vec.c` functionality needed for exact `vec0` and scalar
distance operations is initially compiled. Experimental ANN compilation units
remain excluded.

### 5.2 Authoritative storage

Application vectors live in ordinary typed source columns as canonical BLOBs.
A `VectorIndex` schema object creates managed `vec0` derived storage.

The derived row uses an explicit stable primary key supported by the pinned
sqlite-vec form. If the module requires an integer rowid distinct from the
application key, Chronolog creates a protected mapping relation. Mapping cannot
use implicit SQLite rowid allocation. Its algorithm and collision behavior are
manifest-pinned.

### 5.3 Mutation maintenance

Insert/update/delete source changes synchronously mirror into vec0 inside the
candidate transaction. The adapter validates dimension, element type, byte
length, NaN/infinity policy, and stable key before invoking sqlite-vec.

Direct writes to vec0 or its shadow tables are rejected outside
`derived_index_maintenance` authorization.

### 5.4 Query lowering

Portable exact KNN semantics are:

```text
filter source candidates
compute exact registered distance
sort by distance, source primary key
take k
```

The compiler may use vec0 `MATCH` to obtain candidates only when its result is
proven complete for exact search. It always reapplies the Chronolog tie order.

For selective structured filters, the compiler may scan canonical vector blobs
from ordinary source rows and invoke the Chronolog reference distance kernel.
Correctness takes priority over forcing every query through vec0.

### 5.5 Numeric profiles

- Bit Hamming and int8 Manhattan/squared-L2/dot are portable when bounds prove
  no overflow.
- Float32 distances from sqlite-vec are initially local or exact-native only.
- Portable float consensus requires registered software-float results and
  cross-platform equality.
- Cosine comparison uses an exact rational/fixed-point kernel or an enabled
  numeric profile.

### 5.6 Dolt conformance gate

Before enabling sqlite-vec in any writable manifest, prove:

1. All vector and shadow state resides in the active Dolt database.
2. Insert, update, delete, rollback, and constraint failure are transactional.
3. Dolt commit/check-out/reset and checkpoint restoration recover matching
   vector state.
4. Late insertion plus suffix replay equals clean replay.
5. Writer/revision-reader and branch isolation hold.
6. Reopen and injected crash preserve/recover logical results.
7. Shadow writes are impossible through application/local APIs.
8. Exact results equal the independent Chronolog vector kernel.
9. Equal distances tie by application primary key.
10. Rebuild from ordinary source vectors reproduces results.
11. Every supported OS/architecture passes the same profile fixtures.
12. Native extension version/build changes alter the manifest digest.

Failure keeps the feature disabled. Ordinary vector storage and exact kernel
scan remain available, so failure does not require a different data model.

## 6. Approximate vector search

ANN is not part of the first implementation. When added, each algorithm has a
separate registered manifest covering construction order, seed derivation,
updates, deletes, compaction, rebuild, search parameters, tie order, concurrency,
and expected fixtures.

Experimental sqlite-vec DiskANN/IVF sources are not compiled simply because
they exist upstream. They undergo a separate source review and Dolt/replay gate.

Approximation may omit ideal neighbors according to its specified algorithm;
it may not vary its returned set across conforming replicas.

## 7. Spatial indexes

The initial portable spatial feature uses integer coordinates and `rtree_i32`
or an equivalent managed index. Authoritative geometry/bounds live in ordinary
tables. Query ties end in source primary key.

Floating RTree enters only through a numeric profile. Spatial modules undergo
the same storage, rollback, replay, branch, rebuild, shadow, crash, and
cross-platform tests as sqlite-vec.

## 8. Deterministic WASM

### 8.1 Runtime choice and integration

Use a pinned Wasmtime runtime through a repository-owned native bridge. Link it
into the addon or a tightly coupled native library; do not execute consensus
WASM through arbitrary JavaScript WebAssembly host objects.

The bridge registers one or more internal SQLite functions/table modules that
invoke prevalidated modules by content digest. Applications reference
manifest function IDs.

### 8.2 Module validation

Before registration, validate:

- exact module digest and declared exports;
- allowed WebAssembly feature subset;
- no WASI imports;
- imports restricted to the Chronolog deterministic ABI;
- memory/table minimum equals maximum or growth instructions are rejected;
- bounded globals, functions, code bytes, data segments, and nesting;
- relaxed SIMD disabled unless deterministic mode is pinned;
- threads, shared memory, sockets, component host access, and dynamic linking
  disabled; and
- export signatures exactly match the manifest.

Module validation is cached by digest but repeated after native runtime/profile
changes.

### 8.3 Runtime configuration

The portable configuration enables NaN canonicalization, deterministic relaxed
SIMD behavior or disables relaxed SIMD, fixes memory allocation behavior, and
uses fuel-based interruption. Epoch/wall-clock interruption is operational only
and cannot produce a canonical semantic rejection.

No host clock, entropy, filesystem, environment, process, network, or scheduler
import is available. Signed transaction context and labeled entropy are passed
as explicit arguments through the ABI.

### 8.4 ABI

The first ABI supports pure scalar functions:

```text
alloc_input(length) -> pointer
call(export_id, input_pointer, input_length, output_pointer_slot) -> status
free_output(pointer, length)
```

Arguments and results use canonical logical-value encoding. Host imports allow
only bounded canonical decode/encode, exact kernel calls, hashing, and explicit
context reads declared by the function manifest.

Aggregates receive explicit init/step/final calls and an ordered or proven
commutative input contract. Tokenizers/table functions use separate ABI
versions after scalar conformance is complete.

### 8.5 Fuel and traps

Fuel schedule and maximum are manifest fields. Out-of-fuel becomes
`SEMANTIC_RESOURCE_LIMIT` only when the pinned runtime and schedule are exact.
Host shutdown or operational interruption aborts replay.

Module traps map through a stable table. Trap strings and stack traces are local
diagnostics. A panic or bridge invariant failure is operational.

### 8.6 State

Initial WASM modules are pure. Stateful modules later receive Chronolog-managed
ordinary storage through explicit relational effects; they never access SQLite
pages, files, or raw database handles.

## 9. Extension administration

The initial schema manifest may register built-in native and WASM modules. A
future schema-change transaction that changes registries requires both schema
and extension administrator capabilities.

Nodes refuse to validate a group whose manifest enables an unavailable or
digest-mismatched extension. They may relay encrypted messages if authorized,
but they cannot advertise writable/materializing support.

## 10. Feature diagnostics

`chronolog doctor` reports:

- DoltLite and SQLite source IDs;
- compile options and security bits;
- compiled sqlite-vec source/version/digest;
- registered FTS tokenizers;
- RTree availability;
- Wasmtime/runtime/ABI digest;
- kernel self-test digest;
- supported versus active group manifest features; and
- conformance corpus version/digest.

Diagnostics never enable a missing feature automatically.

## 11. Tests

In addition to each feature gate, native tests cover:

1. Reproducible vendor source verification and build manifest.
2. Static registration on every writer and reader connection.
3. Dynamic extension loading remains disabled.
4. Application authorizer cannot create arbitrary virtual tables.
5. Derived-index authorization is narrowly scoped.
6. Native failure classification and cleanup.
7. FTS tokenizer/query/ranking golden fixtures.
8. Vector scalar/vec0/reference equality and tie fixtures.
9. Spatial integer boundary and overlap fixtures.
10. WASM forbidden imports/features, fixed memory, NaNs, SIMD, fuel, traps, and
    ABI malformed input.
11. Cross-platform native manifest and logical result comparison.
12. Sanitizer builds for vendored C/C++/Rust bridges where supported.

## 12. Completion criteria

- Native modules are statically built, source-pinned, manifest-measured, and
  registered on every connection.
- Dynamic extension loading remains disabled.
- Derived index source data always lives in ordinary authoritative tables.
- FTS and sqlite-vec cannot be enabled before their complete Dolt replay gates.
- Portable vector consensus begins with exact bit/int8 behavior.
- WASM has no ambient imports and uses deterministic runtime controls.
- Any unsupported or mismatched feature fails before attestation/materialization
  rather than falling back silently.

