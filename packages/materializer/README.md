# `@chronolog/materializer`

This package is the portable boundary between Chronolog coordination and a
database materialization host. It intentionally has no workerd, Node, DoltLite,
filesystem, transport, clock, or random-source dependency.

It owns:

- exact object, artifact, and immutable database reference shapes;
- canonical CBOR codecs for invocation, admitted suffix, continuation, outcome,
  differential observation, and self-contained differential fixture values;
- resolution through an exact-reference-only object reader;
- an explicit pure context in which logical time and caller entropy are null in
  version 1; and
- a backend-neutral kernel and differential harness usable by both Node and
  workerd implementations.

Chronolog transaction timestamps and nonce-derived entropy remain inside each
signed transaction. A materializer host must not substitute ambient time or
randomness. The existing DoltLite implementation exposes a temporary oracle
adapter in `@chronolog/materializer-doltlite`; its output projector is injected
because only a CAS/export host can assign generic immutable output refs.

The package does not define mutable publication. Reduction returns immutable
candidates; a coordinator publishes those candidates separately.
