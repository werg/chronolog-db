# Workerd reconstruction plan (feasibility analysis)

Status: analysis only. Nothing here changes the production path or advertises
a feature. The first pilot target remains the native `chronologd` daemon
([production execution](production-execution.md)). This document was written
from a time-boxed investigation; every claim is labeled **verified-run**
(executed here), **verified-read** (read from source/docs/registry), or
**unverified**.

## 1. Situation

The earlier forked-workerd/DoltLite work is lost. What exists is the
fail-closed `packages/runtime-workerd` contract. Its Worker-facing surface
(`reduce(databases, input, env, ctx)` with `getInput`/`getOutput` handles that
offer `query`, `execute`, `transactionSync`, `commit`) and its generated
binding shape (`run({inputs, outputs, canonicalInput})`) describe a **forked
workerd with a JSG "database reducer" API that does not exist upstream**. The
repo's own `DatabaseLike` seam (`packages/materializer-doltlite/src/types.ts`)
is what any engine must satisfy: exec/prepare/step, authorizer, progress
handler, `setLimit`, `interrupt`, and `dolt_*` branch/commit/reset functions.

## 2. Facts established

### Workerd (verified-read, WebFetch of the workerd README)

- Build is Bazel (Bazelisk recommended); Linux needs clang/LLVM, libc++ and
  LLD **22 or newer**, plus Python 3 and Tcl 8.6. macOS needs Xcode 16.3.
  Command: `bazel build //src/workerd/server:workerd` (`--config=release`,
  `--config=thin-lto`).
- Prebuilt workerd is shipped on npm; Linux prebuilts need glibc 2.35+.
  `RELEASE.md`, `build-releases.sh` and `Dockerfile.release` exist; **their
  contents were not read**.
- **Unverified (not fetched)**: the exact upstream SQLite-in-Durable-Objects
  source layout (`src/workerd/util/sqlite*`, `api/sql.*`), how its VFS is
  built, which SQLite compile options it uses, and whether the SQLite is
  swappable for DoltLite. Treat the claims in section 4 about "replace the
  vendored SQLite with DoltLite" as a hypothesis until that code is read.
- Local assessment (verified-run): this machine has gcc/g++, cmake, make,
  python3, node 22, rustc 1.93 (x86_64 only), 16 cores, 30 GB RAM, ~400 GB
  free disk, working network. It has **no clang, no Bazel/Bazelisk, no
  emscripten, no wasi-sdk, no rustup/wasm targets**. A workerd build would
  require clang 22 and a Bazel toolchain download plus a multi-hour build; no
  build was started. An unmodified prebuilt workerd (1.20261002.1) exists in
  another checkout on this machine; it was not exercised.

### DoltLite (verified-read of the pinned 0.11.29 source in node_modules)

- A DoltLite database is **one append-only chunk-store file** (manifest at
  offset 0, `CS_WAL_TAG_CHUNK`/`ROOT` records, in-memory chunk index),
  accessed exclusively through the SQLite VFS (`sqlite3Os*` calls in
  `chunk_store.c`/`chunk_wal.c`). Chunks are content-addressed internally
  (prolly tree, BLAKE3-based hashes), but the on-disk container is not a
  per-chunk object store. Consequences: (a) a custom VFS is a natural and
  small integration point; (b) a CAS-backed store means either a block-mapped
  VFS over CAS or a chunk-store backend patch, and **immutable export/import,
  reachability, and GC must be built from a chunk walk** (`doltlite_gc.c`,
  `doltlite_chunk_walk.c` exist) rather than being free.
- The amalgamation also contains remote/HTTP/TLS/remotesrv code
  (`doltlite_remote*.c`, `doltlite_tls.c`) which must be compiled out or
  stubbed for any sandboxed target; the published WASM build imports
  `getaddrinfo`, `socket`, `connect` (stubs required).
- Upstream README states DoltLite is beta, format version 12 is frozen, and a
  `@dolthub/doltlite-wasm` distribution exists.

### Published DoltLite WASM (verified-read + verified-run)

- `@dolthub/doltlite-wasm@0.11.29` exists on npm: the **same version as the
  pinned native package**. Tarball sha1 `4fd81ffa8e9fadbbf55c2d937fb811049eb21237`
  matched the registry. It is an Emscripten build of the SQLite WASM API
  (3.54.0, clang 20) with `doltliteInstallAutoExt()` wired into
  `sqlite3_wasm_extra_init`.
- Loads and runs in Node 22 (verified-run): `dolt_version()` = `v0.11.29`,
  JSON/FTS5/R-Tree compiled in, `dolt_commit`, `dolt_hashof`, `dolt_branch`,
  `dolt_log` work; a 600-row two-commit-plus-branch scenario ran correctly.
  The module exports `sqlite3_set_authorizer`, `sqlite3_progress_handler`,
  `sqlite3_limit`, `sqlite3_interrupt`, `sqlite3_create_function_v2`,
  `sqlite3_vfs_register`, i.e. the callbacks the native patch added are
  reachable from JS. VFS list: unix (Emscripten FS/MEMFS), memdb, unix-excl,
  unix-dotfile, unix-none.
- **Not in the published build**: sqlite-vec (`vec_version()` fails; Chronolog's
  patch registers it statically in the native addon). Rebuilding requires
  emscripten, which is not installed here.
- `sqlite3_js_db_export` (serialize) **crashed with "memory access out of
  bounds"** in this build (the crash occurred in the export/close step; the
  scenario itself passed). Whole-file export therefore needs a different
  route (VFS-level read of the chunk file).
- Imports include `strptime`, `timegm`/`localtime` and `__syscall_*` shims, so
  the WASM module is not freestanding: a hosting Worker must provide them, and
  time/locale behavior must be pinned.

### Determinism findings (verified-read of source + verified-run)

- **Upstream bug/hazard**: in `doltlite.c` the commit timestamp is
  `explicitTimestamp ? explicitTimestamp : time(0)`. `--date
  1970-01-01T00:00:00` parses to 0 and is treated as "unset", so wall-clock time
  is used. Confirmed by run: `dolt_log.date` showed the current time on both
  native 0.11.29 and WASM 0.11.29 for a commit made with that date.
  `DEFAULT_COMMIT.timestamp` in `runtime-workerd/src/host-client.ts` is exactly
  `1970-01-01T00:00:00`, so a real workerd run using it would produce
  non-reproducible commit hashes. Use a non-zero fixed epoch (or fix the
  sentinel in the pinned patch) and add a test.
- The repository seed commit ("Initialize data repository") is created with
  `time(0)` on first open, so commit hashes across independently created
  stores differ by construction. Cross-engine comparison must therefore
  start from an imported canonical genesis (as `ExactDatabaseRef` already
  models) or compare history-independent hashes (`dolt_hashof_table`,
  `dolt_hashof_db`, state digest).
- **Not completed**: a native-versus-WASM byte/hash comparison from a shared
  canonical genesis. The first attempt was invalidated by the two findings
  above. This is the first spike (section 6).

## 3. Options

| Option | What | Effort | Risk | Main unknowns |
| --- | --- | --- | --- | --- |
| A. Fork workerd, add JSG database-reducer module | Re-create the lost design: native DoltLite linked into workerd, JSG API matching `runtime-workerd` | Very high (Bazel + clang 22 toolchain, JSG/C++ API, pinned distribution, per-platform builds, upgrade treadmill) | High | Whether workerd's vendored SQLite can be replaced; build time/disk; maintaining a fork against upstream; release signing |
| B. DoltLite WASM in an unmodified workerd | Instantiate a pinned, repo-built DoltLite+sqlite-vec WASM module inside a Worker; implement the reducer handles in JS; CAS-backed VFS | Medium | Medium | Workerd WASM constraints (module must be precompiled/imported, memory ceiling, no threads); performance; Emscripten shim determinism; VFS/CAS design; sqlite-vec build |
| C. Native sidecar ("nanoservice") with a binding | Run the existing native materializer as a service behind a workerd service binding | Low-medium | Low technically, but it is not "pure workerd": it reuses the native runtime and adds nothing to the portability claim | Whether it satisfies the "Reconsidering workerd" intent at all |

## 4. Recommendation

1. Treat **B** as the reconstruction path and run the spikes below before any
   commitment. It removes the fork, the Bazel/clang 22 toolchain, and the
   distribution burden, and it reuses an upstream-published artifact at the
   identical pinned version as a starting point.
2. Keep **A** as a fallback only if B fails the memory, time, or determinism
   gates. Do not start A before reading the upstream workerd SQLite sources
   (unverified here).
3. Do not pursue **C** as the workerd target; it duplicates the native path.
4. Do not change `docs/production-execution.md` status until all items in its
   "Reconsidering workerd" list have passing executable gates.

## 5. Staged milestones and acceptance gates

Gates map to the "Reconsidering workerd" list.

| Stage | Deliverable | Executable acceptance gate | List item |
| --- | --- | --- | --- |
| M0 | Spike: shared-genesis native vs WASM equivalence | A script imports one canonical genesis into both engines, replays the same scenario with a non-zero fixed commit date, and asserts identical `dolt_hashof_table`/`dolt_hashof_db` and commit hashes, under at least two `TZ` values | cross-platform replay evidence |
| M1 | Run the published WASM inside an unmodified prebuilt workerd | A `workerd serve` config loads the WASM as a precompiled module (no runtime compilation), runs M0, and reports peak memory | pinned distribution (unmodified) |
| M2 | Repo-owned WASM build: pinned toolchain (emscripten or wasi-sdk version), patches ported (authorizer, progress, limits, tail offset, static sqlite-vec, remote/TLS compiled out), engine manifest digest equals a recorded value | Reproducible-build check: two clean builds produce the same wasm sha256; `chronologNativeManifest`-equivalent digest recorded; conformance corpus passes | pinned distribution; DoltLite kernel without native Node imports |
| M3 | `DatabaseLike` adapter over the WASM module plus the `runtime-workerd` handles (`getInput/getOutput`) | `pnpm conformance:production` extended: the SQLite differential corpus and replay fixture produce the same state/outcome/result/replay digests as the native reference | complete kernel; cross-platform replay |
| M4 | CAS-backed VFS and immutable export/import: chunk-file blocks to CAS objects, repository-root object, reachability walk, GC | Round-trip tests (export, import into empty runtime, byte-identical state digest); GC never removes a reachable object (property test); import rejects substituted objects | exact immutable CAS |
| M5 | Durable execution-key follow and generation-guarded publication metadata | Existing `publication.test.ts` semantics against a durable store; ambiguous-failure reconciliation test | durable follow/publication |
| M6 | Process-level crash tests around export, finalization, CAS, publication | Kill-point suite analogous to the native one (after export, after finalize, before/after CAS, after ref move); reopen exposes exactly old or exactly new revision | crash tests |
| M7 | Daemon configuration and cutover with a single-writer guard | Test proving no dual-writer window (fencing generation), plus rollback path | daemon cutover |
| M8 | Cross-platform evidence matrix (Linux x64/arm64, macOS arm64, as listed in spec 09) | Reports with identical replay digests to the native reference | cross-platform replay |

## 6. First spike (run next)

The probe scripts used for section 2 are kept in
[`experimental/workerd-wasm-spike/`](../experimental/workerd-wasm-spike/README.md)
(not wired into any build or test).

M0, then M1. Concretely:

1. Obtain `@dolthub/doltlite-wasm@0.11.29` (verify the sha1 above) and the
   locally built patched native addon (already built by `pnpm install`).
2. Create one canonical genesis in one engine, move it to the other (native
   file to WASM MEMFS via `sqlite3_js_posix_create_file`; the reverse
   direction needs a VFS-level read since serialize crashed), and replay the
   scenario with `--date` set to a non-zero epoch.
3. Compare history-independent hashes first, commit hashes second.
4. Repeat inside an unmodified prebuilt workerd with the `.wasm` imported as a
   compiled module.

Exit criteria: identical hashes and no memory fault, or a precise defect list
to carry into M2.

## 7. Honest unknowns

- Upstream workerd SQLite/JSG source layout and swap-ability (not read).
- Whether workerd's WASM limits (memory, module size, startup) fit DoltLite
  plus sqlite-vec on realistic databases (not measured).
- Whether the Emscripten shims (`strptime`, `timegm`, `localtime`,
  `getaddrinfo`) can be made fully deterministic in a Worker.
- Whether sqlite-vec builds and behaves identically under WASM (no toolchain
  here to try).
- Chunk-file-to-CAS mapping cost and GC design (needs a chunk-walk prototype).
- DoltLite is beta with a frozen format version 12; pinned-version policy and
  upstream defects (such as the zero-timestamp sentinel) need an owner.
- Independent security review of any new runtime (SEC-007, SEC-008).

## 8. Sources

- workerd README (build requirements, distribution):
  <https://github.com/cloudflare/workerd>
- DoltLite README (storage format, platforms, WASM mention):
  <https://github.com/dolthub/doltlite>
- npm registry metadata for `@dolthub/doltlite-wasm` (versions, integrity,
  README): <https://registry.npmjs.org/@dolthub%2fdoltlite-wasm>
- Pinned DoltLite 0.11.29 source in `node_modules` (files `doltlite.c`,
  `chunk_store.c`, `chunk_store.h`, `scripts/download.js`,
  `scripts/build-amalgamation.js`, `binding.gyp`) and
  `patches/@dolthub__doltlite@0.11.29.patch`.
