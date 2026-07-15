# `@chronolog/runtime-workerd`

This package is the transport-neutral Chronolog adapter for the generic
content-addressed database reducer contract. It provides:

- a pure controller with named immutable `previous` and `replayBase` inputs;
- exact CAS reads without existence tests or enumeration;
- private database output, typed artifact, finalize, and checkpoint hooks;
- canonical named result selectors and Chronolog application-result bytes;
- deterministic standard-mode run/follow coordination; and
- a differential-backend adapter for the existing portable fixture harness.

It also now contains the first deployable Worker-bundle boundary. A concrete
portable SQL kernel can be bound with `createChronologReducerWorkerModule()`
and exported directly from a modules-syntax Worker. The resulting object has
the implemented workerd signature `reduce(databases, input, env, ctx)`; its
three-argument `reduceChronologMaterialization(databases, input, ctx, kernel)`
core keeps standard-mode bindings outside the pure Chronolog kernel. It:

- resolves a canonical invocation/object bundle through the portable
  materializer package;
- requires the exact named `previous`/`replayBase` inputs and pre-registered
  `materialized` private output;
- passes real synchronous workerd input/output handles to the kernel;
- returns one canonical `materialized` or `checkpoint` handle selector; and
- freezes the application payload and sorted exact-read set before handoff.

`ChronologWorkerdHostClient` is the corresponding typed run/follow/publish
seam. Its run payload mirrors the generated workerd binding, while follow and
publication remain injectable metadata operations. Publication intent is
created only from a verified selected immutable output and is never exposed to
the reducer Worker.

A test-only native integration fixture drives this controller through
`createDoltLitePortableKernel` backed by two real, independently opened pinned
`DeterministicMaterializer` repositories. It proves append and late-predecessor
replay parity across protected logs, outcomes, query results, revisions, and
projected immutable output/artifact identities. Native compiler, N-API, and
Node dependencies remain dev-only and outside the production import graph.

The reducer never receives a mutable ref or publication capability. Publishing
is represented by a separate `ChronologPublicationRequest` value for another
component to execute conditionally.

The current database kernel and host transport are still injected. A shadow
integration test executes the real Worker module object and typed client
against an in-memory implementation of the exact public run/result contract,
including ambiguous-run follow and separate publication. The native fixture
is Chronolog replay/materialization evidence, not Dolt merge evidence.

`workerd-binary.integration.test.ts` adds an opt-in executable contract fixture
for the local workerd fork. Its standard bootstrap reducer creates and seals a
real immutable Dolt replay base in `databaseReducerLocal`; the Chronolog service
runs with `profile = pure`, receives that exact named input (including the
canonical genesis commit explicitly returned by the bootstrap reducer), forks
a private output, executes a cross-database query and write through the real
synchronous handles, commits it, and returns through
`ChronologWorkerdHostClient`. Run it with:

```sh
WORKERD_DATABASE_REDUCER_BIN=/absolute/path/to/workerd \
  pnpm vitest run packages/runtime-workerd/src/workerd-binary.integration.test.ts
```

The test is skipped unless the variable names an existing binary, preventing a
stock published workerd from being mistaken for the fork. The injected binary
kernel writes only a bounded smoke table; it does not claim the complete
Chronolog SQL materializer, typed artifact finalization, follow/publication,
native merge semantics, or production metadata durability. Until this test is
run against a freshly built fork, its checked-in config and bundled entry are
source- and bundle-verified executable evidence, not a recorded runtime pass.
