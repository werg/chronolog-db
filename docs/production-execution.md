# Production execution target

Status: accepted for the first pilot release

The first Chronolog deployment target is the native `chronologd` daemon with
the pinned, patched DoltLite runtime. Pure workerd execution remains an
experimental portability boundary and is not part of the first release.

## Decision

The native path is selected because it is the only path that presently owns
the complete deterministic SQL compiler, restrictive SQLite authorizer,
DoltLite branch/checkpoint lifecycle, protected transaction log, suffix
replay, governance integration, RPC service, and operational daemon. Selecting
workerd now would require a custom workerd/JSG database-reducer build, a
portable DoltLite kernel, immutable database export/import, durable CAS
metadata, and a daemon cutover. None of those are prerequisites for validating
the native pilot, and claiming them prematurely would create a second,
unproven consensus runtime.

The transport-neutral `runtime-workerd` package is retained as a fail-closed
contract and future portability target. It does not advertise a deployed
workerd feature. Its CAS publication helper verifies immutable reachability
before a generation-guarded ref compare-and-swap and reconciles ambiguous
failures by exact ref read.

## Release evidence

`pnpm conformance:production` runs the checked-in SQLite differential corpus
and the replay fixture through both:

1. the direct native reference materializer; and
2. the `chronologd` composition's coordinator/publication runtime adapter.

Their state, outcome, result, and replay evidence digests must be identical.
The report advertises `deployment-native-daemon-v1` only when the
`native-daemon-production-v1` group passes.

Native publication moves `chronolog_head` only after the candidate commit,
revision marker, and independent reader validation succeed. The crash suite
terminates a child process after the candidate commit, after revision-marker
creation, immediately before and after the atomic head move, and after the
reader swap. Reopen must expose exactly the old revision before the head move
or exactly the new revision after it; startup removes orphan replay/revision
branches.

## Reconsidering workerd

Pure workerd becomes a selectable production target only after all of the
following are independently implemented and pass the same report:

- a pinned custom workerd/JSG database-reducer distribution;
- the complete deterministic SQL/DoltLite kernel without native Node imports;
- exact immutable CAS export, import, reachability verification, and garbage
  collection;
- durable execution-key follow and generation-guarded publication metadata;
- process-level crash tests around export, finalization, CAS, and publication;
- daemon configuration and cutover with no dual-writer window; and
- cross-platform replay evidence matching the native reference digest.

Until then, workerd code is experimental and cannot satisfy an active manifest
feature or replace the daemon materializer.
