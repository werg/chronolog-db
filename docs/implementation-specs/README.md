# Chronolog Implementation Specifications

Status: index for the active SQL-first prototype contract and historical design
material

Chronolog has one unreleased signed transaction format: exact SQL source with
canonical bindings, mandatory SQL preconditions, and ordered body statements.
There is no public relational command AST, authoritative schema manifest,
legacy transaction decoder, or compatibility execution path.

## Active normative contract

The current implementation is governed by:

1. [Deterministic SQLite-compatible SQL transactions](10-deterministic-sql-transactions.md),
   which defines the signed program, compiler boundary, DDL/DML execution,
   preconditions, replay, client workflow, and security profile.
2. [Transaction results and ordered mutations](11-transaction-results-and-ordered-mutations.md),
   which defines canonical SQL values, result envelopes, protected storage,
   attribution, semantic limits, retrieval, and the proven ordered-target
   subset.
3. The [SQLite compatibility ledger](../sqlite-compatibility-ledger.json),
   which is the machine-readable working, gated, and prohibited feature
   boundary.
4. [Implementation status](../implementation-status.md), which summarizes the
   current end-to-end and operational state for humans.
5. [Upcoming work](../../upcoming.md), which is the ordered execution roadmap.

When these sources conflict, Specifications 10 and 11 define semantics and the
compatibility ledger determines whether a surface is currently enabled.

## Historical relational-IR design series

Specifications 1–9 record the superseded relational-IR implementation plan.
They remain useful background for package boundaries, deterministic kernels,
native-extension threat analysis, and conformance methodology, but they do not
define the current signed transaction representation or client API:

1. [Direct prototype cutover](01-direct-cutover.md)
2. [Canonical values and relational IR](02-canonical-ir.md)
3. [Schema, compiler, and execution manifest](03-schema-compiler.md)
4. [Reducer and DoltLite materializer](04-reducer-materializer.md)
5. [Protocol, node, validation, and transport](05-protocol-node.md)
6. [Client, RPC, schema tooling, and reactive APIs](06-client-rpc-reactive.md)
7. [Deterministic kernels](07-deterministic-kernels.md)
8. [FTS5, sqlite-vec, spatial, and deterministic WASM](08-native-extensions.md)
9. [Conformance and delivery](09-conformance-delivery.md)

Any statement in Specifications 1–9 requiring relational IR, schema IR,
generated consensus SQL, typed-IR-only clients, or removal of signed SQL is
historical and must not be used as an implementation requirement. General
conformance or security requirements apply only when reaffirmed by
Specifications 10/11, the ledger, or a new decision record.

## Prototype cutover rule

Chronolog has no released protocol, deployed database, compatibility promise,
or user data to preserve. Formats and APIs are edited in place, and development
databases, feeds, snapshots, and fixtures are disposable.

The work must not introduce:

- a second transaction format;
- a legacy decoder or reducer;
- a compatibility execution profile;
- dual old/new RPC methods; or
- fallback behavior that bypasses the active deterministic SQL profile.

Ordinary application schema evolution is not compatibility work: tables,
indexes, views, triggers, backfills, and migration-history writes are authored
as atomic replicated SQL transactions with explicit schema assumptions.

## Current dependency direction

Consensus dependencies remain acyclic:

```text
canonical --> protocol SQL codecs --> capabilities / crypto / control-store
    |                 |
    +--> ir manifest/value codecs
    |                 |
    +--> compiler-sqlite --> materializer-doltlite
                                  |
transport-ssb ----------------> node-core --> rpc --> client --> react
                                  |
                           runtime-workerd adapter
```

Compiler ASTs, target-key plans, and mutation lowering are private. They never
enter signed protocol bytes. The authorizer is defense in depth; semantic
admission is decided by the compiler and active execution manifest.
