# Chronolog Deterministic Relational Runtime Implementation Specifications

Status: implementation target for the current prototype

These documents specify how to replace Chronolog's current raw-SQL consensus
path with the deterministic relational language defined in
[the SQL dialect specification](../sql-dialect.md).

## Prototype cutover rule

Chronolog has no released protocol, deployed database, compatibility promise,
or user data to preserve. The implementation SHALL therefore be changed in
place.

The work MUST NOT introduce:

- a second transaction format;
- a legacy raw-SQL decoder or reducer;
- a compatibility execution profile;
- an upgrade or data-migration command;
- dual RPC methods for old and new drafts; or
- fallback behavior that accepts the current raw-SQL transaction body.

Existing development databases, SSB feeds, snapshots, fixtures, and serialized
messages are disposable. Tests SHALL create fresh repositories. The existing
format tag may retain its current numeric value while its unreleased structure
is edited directly.

This rule does not remove schema changes as an eventual database-language
feature. It only says that the current prototype is not itself migrated. The
first implementation may defer schema-change transactions until the core
runtime is stable.

## Specification map

1. [Direct prototype cutover](01-direct-cutover.md) defines repository scope,
   replacement order, and deletion criteria.
2. [Canonical values and relational IR](02-canonical-ir.md) defines package
   boundaries, data structures, codecs, validation, and builders.
3. [Schema, compiler, and execution manifest](03-schema-compiler.md) defines
   schema compilation, type checking, deterministic SQL generation, result
   semantics, and manifest construction.
4. [Reducer and DoltLite materializer](04-reducer-materializer.md) defines
   per-candidate atomicity, rejected outcomes, checkpoints, suffix replay,
   crash behavior, and publication.
5. [Protocol, node, validation, and transport](05-protocol-node.md) defines the
   edited transaction core, hashing, admission checks, validator behavior,
   draft ownership, SSB publication, and encrypted payload handling.
6. [Client, RPC, schema tooling, and reactive APIs](06-client-rpc-reactive.md)
   defines the application-facing builder, observations, generated schema
   bindings, wire methods, local queries, and React integration.
7. [Deterministic kernels](07-deterministic-kernels.md) defines checked numeric,
   text, JSON, entropy, canonical comparison, and extension-call semantics.
8. [FTS5, sqlite-vec, spatial, and deterministic WASM](08-native-extensions.md)
   defines native build integration, managed derived indexes, feature gates,
   and WASM execution.
9. [Conformance and delivery](09-conformance-delivery.md) defines fixtures,
   reference evaluation, property and fault testing, cross-platform checks,
   work packages, and completion gates.

## Component architecture

```text
application schema manifest
        |
        +---------------------> generated TypeScript bindings
        |
        v
typed client builder --> canonical IR bytes --> signed transaction candidate
                                                  |
SSB replication --> capability/admission checks --+
                                                  |
                                                  v
                                     IR decode and validation
                                                  |
                                     schema/type/effect checking
                                                  |
                                     canonical SQLite compilation
                                                  |
                            +---------------------+---------------------+
                            |                                           |
                            v                                           v
                  deterministic kernels                    managed derived indexes
                            |                              JSON / FTS / vector / spatial
                            +---------------------+---------------------+
                                                  |
                                                  v
                                   disposable Dolt replay branch
                                                  |
                                    accepted/rejected system log
                                                  |
                                     verified revision publication
                                                  |
                          revisioned queries and reactive notifications
```

## Package dependency direction

The implementation SHALL keep consensus dependencies acyclic:

```text
@chronolog/canonical
        |
        +--> @chronolog/ir
        |         |
        |         +--> @chronolog/compiler-sqlite
        |         +--> @chronolog/client
        |         +--> @chronolog/protocol
        |
        +--> @chronolog/kernels

@chronolog/protocol --> capabilities / crypto / control-store / transport

protocol + compiler + kernels + DoltLite --> materializer --> node-core --> rpc
client + rpc --> react
```

`@chronolog/canonical` contains no database, Node, transport, or application
dependencies. `@chronolog/ir` contains no SQLite or DoltLite imports. The
compiler does not import node, RPC, transport, or capability code. This keeps
the signed language independently testable.

## Universal implementation requirements

Every subsystem MUST follow these rules:

1. Consensus input is canonical IR, never caller-authored SQL.
2. Every received object is validated even if a trusted local client built it.
3. Every application table has an explicit primary key.
4. Every consensus-visible row choice has a declared deterministic order.
5. Host time and entropy enter only through signed transaction context.
6. Operational failures never become canonical author rejections.
7. The execution manifest and schema digest are checked before execution.
8. Derived indexes are disposable and reproducible from committed source rows.
9. The raw local query surface is read-only and cannot be reused as a signed
   precondition without parsing into IR.
10. All startup configuration that can affect semantics is measured and
    compared with the committed manifest.

## Definition of the first complete implementation

The direct replacement is complete when:

- the protocol contains no SQL strings in transaction preconditions or
  mutations;
- the client consensus API accepts only typed IR builders;
- genesis is produced from schema IR rather than `genesisSql`;
- every candidate uses a top-level SQLite transaction boundary;
- deterministic rejection writes only a rejected system-log row;
- fresh replay and checkpoint suffix replay produce identical logical state;
- JSON, FTS, and enabled vector profiles pass their feature gates;
- unsupported native or WASM features fail before validation or execution;
- all canonical fixtures pass on every supported release platform; and
- searches for the deleted raw-SQL fields and draft methods return no
  consensus-path matches.

