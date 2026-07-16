# `@chronolog/runtime-workerd`

This experimental package is the transport-neutral Chronolog adapter for the
generic content-addressed database reducer contract. It provides:

- a pure controller with named immutable `previous` and `replayBase` inputs;
- exact CAS reads without existence tests or enumeration;
- private database output, typed artifact, finalize, and checkpoint hooks;
- canonical named result selectors and Chronolog application-result bytes;
- deterministic standard-mode run/follow coordination; and
- a differential-backend adapter for the existing portable fixture harness.

It also contains a Worker-bundle-shaped boundary. A concrete
portable SQL kernel can be bound with `createChronologReducerWorkerModule()`
and exported directly from a modules-syntax Worker. The resulting object has
the implemented workerd signature `reduce(databases, input, env, ctx)`; its
three-argument `reduceChronologMaterialization(databases, input, ctx, kernel)`
core keeps standard-mode bindings outside the pure Chronolog kernel. It:

- resolves a canonical invocation/object bundle through the portable
  materializer package;
- requires the exact named `previous`/`replayBase` inputs and pre-registered
  `materialized` private output;
- passes synchronous input/output handle interfaces to the kernel;
- returns one canonical `materialized` or `checkpoint` handle selector; and
- freezes the application payload and sorted exact-read set before handoff.

`ChronologWorkerdHostClient` is the corresponding typed run/follow/publish
seam. Its run payload mirrors the generated workerd binding, while follow and
publication remain injectable metadata operations. Publication intent is
created only from a verified selected immutable output and is never exposed to
the reducer Worker.

The reducer never receives a mutable ref or publication capability. Publishing
is represented by a separate `ChronologPublicationRequest` value for another
component to execute conditionally.

The current database kernel and host transport are still injected. There is no
checked-in real-workerd binary fixture and no claim that this is a production
runtime. `publishChronologCasIntent()` defines and tests the future host-side
boundary: exact immutable-output verification precedes a generation-guarded
compare-and-swap, and an ambiguous failure is reconciled without blindly
repeating publication. The selected first production path is the native daemon
described in [`docs/production-execution.md`](../../docs/production-execution.md).
