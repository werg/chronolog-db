# EXPERIMENTAL: DoltLite WASM feasibility spike

Not part of any package, build, test suite, or production path. See
[`docs/workerd-reconstruction-plan.md`](../../docs/workerd-reconstruction-plan.md).

Inputs (not vendored): the published `@dolthub/doltlite-wasm@0.11.29` tarball
(`npm pack`, sha1 `4fd81ffa8e9fadbbf55c2d937fb811049eb21237`) extracted to a
scratch directory, and the Chronolog-patched native addon built by
`pnpm install`.

- `inspect-wasm.mjs <sqlite3.wasm>` - list imports/exports, check C API symbols.
- `wasm-probe.mjs <pkgdir>` - versions, compile options, sqlite-vec presence, VFS list.
- `run-native.cjs <doltlite addon dir>` / `run-wasm.mjs <pkgdir>` - same
  `scenario.mjs` on both engines (`TRY_EXPORT=1` reproduces the serialize crash).
- `run-wasm-trace.mjs`, `wasm-bisect.mjs` - crash bisection and `--date` probes.

Known: the scenario's `--date 1970-01-01T00:00:00` is ignored by DoltLite
(zero-timestamp sentinel), so commit hashes are wall-clock dependent; M0 in the
plan fixes this before comparing hashes.
