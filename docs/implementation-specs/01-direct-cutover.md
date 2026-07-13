# Direct Prototype Cutover

## 1. Purpose

This document translates the no-compatibility rule into concrete repository
work. Chronolog is an unreleased prototype. The current implementation is an
engineering scaffold, not a historical protocol to preserve.

The change replaces the raw-SQL consensus path atomically at source level. A
partially converted branch may fail tests while under development, but the
completed tree MUST contain only the relational-IR path.

## 2. Current implementation seams

The replacement touches these existing surfaces:

| Surface | Current form | Required form |
|---|---|---|
| Protocol | `SqlPrecondition`, `SqlStatement` | `IrPrecondition`, `IrMutation` |
| Candidate core | SQL strings and parameters | canonical relational IR |
| Draft RPC | `observe`, `addAssertion`, `addExpectation`, `addStatement` with SQL | IR query observation and IR command addition |
| Client | raw SQL transaction methods | schema-aware typed builders |
| Genesis | `genesisSql` strings | `SchemaManifest` |
| Reducer | prepare caller SQL | validate and compile IR |
| Candidate isolation | suffix transaction plus savepoints | one top-level transaction per candidate |
| Values | SQLite storage values | logical Chronolog values |
| Results | column names plus SQLite values | typed result schema and declared result mode |
| Profile | string constant | measured execution-manifest digest |

Local read-only query SQL remains available, but its types and methods SHALL
live outside the consensus transaction model.

## 3. Direct-edit policy

### 3.1 Serialized data

Edit the existing transaction encoder and decoder directly. Do not add a union
with the old representation. The decoder MUST reject old serialized fixtures
because their fields no longer match the edited schema.

The transaction's top-level format tag may remain `1` because there has been no
published interpretation of that tag. Nested IR node tags use their own stable
registry from the first complete implementation onward.

### 3.2 Stored data

Delete and recreate local DoltLite databases during development. Remove tests
that reopen a raw-SQL-era database and replace them with tests that reopen a
fresh IR-created database.

No code may inspect an old system table and attempt to translate it. Startup
against an incompatible development database SHOULD fail with
`DATABASE_MANIFEST_MISSING` or `DATABASE_MANIFEST_MISMATCH` and tell the
developer to recreate it.

### 3.3 Network data

Development SSB feeds and encrypted envelopes are disposable. Tests create new
feed identities and group keys. Nodes do not advertise, decode, or relay the
old candidate representation.

### 3.4 Public TypeScript APIs

Remove old transaction methods rather than deprecating them. Compile failures
are the intended feedback for the prototype's callers. Query-only SQL APIs
must be renamed if necessary to make the local/consensus boundary unmistakable.

## 4. Repository additions

Create these packages:

```text
packages/canonical/
  package.json
  src/cbor.ts
  src/hash.ts
  src/utf8.ts
  src/index.ts

packages/ir/
  package.json
  src/value.ts
  src/expression.ts
  src/query.ts
  src/mutation.ts
  src/precondition.ts
  src/schema.ts
  src/context.ts
  src/codec.ts
  src/validate.ts
  src/visit.ts
  src/builders.ts
  src/index.ts

packages/compiler-sqlite/
  package.json
  src/catalog.ts
  src/resolve.ts
  src/types.ts
  src/effects.ts
  src/order.ts
  src/render.ts
  src/compile-query.ts
  src/compile-mutation.ts
  src/compile-schema.ts
  src/manifest.ts
  src/index.ts

packages/kernels/
  package.json
  src/integer.ts
  src/decimal.ts
  src/text.ts
  src/json.ts
  src/vector.ts
  src/entropy.ts
  src/encoding.ts
  src/index.ts

packages/conformance/
  package.json
  src/reference/
  src/fixtures/
  src/harness/
  src/index.ts
```

Names may be adjusted to repository conventions, but responsibilities and
dependency direction SHALL remain as specified.

## 5. Existing package edits

### 5.1 `@chronolog/protocol`

- Move reusable canonical CBOR, strict UTF-8, byte comparison, and hashing
  primitives to `@chronolog/canonical`.
- Replace `SqlParameter`, `SqlPrecondition`, `SqlStatement`, and their codecs.
- Embed canonical transaction-context, precondition, and mutation IR.
- Commit the execution-manifest digest and schema digest.
- Preserve ordering, attestation, heartbeat, capability, envelope, and payload
  semantics unless their types refer to removed SQL structures.

### 5.2 `@chronolog/materializer-doltlite`

- Replace `genesisSql` with a validated schema manifest.
- Replace SQL statement preparation with IR compilation.
- Separate local query SQL from consensus query execution.
- Replace suffix-wide transaction/savepoint behavior with top-level candidate
  transactions.
- Expand the system log with stable failing precondition, command, rule, and
  constraint identifiers.
- Persist and verify execution and schema manifests.

### 5.3 `@chronolog/node-core`

- Store canonical IR in drafts.
- Reserve timestamp and nonce when a draft begins.
- Validate IR before candidate signing and again before validator attestation.
- Remove raw statement mutation methods.
- Carry typed observation results and observation provenance.

### 5.4 `@chronolog/rpc`

- Replace SQL draft request bodies with canonical IR bytes.
- Return typed query schemas and result modes.
- Include reserved transaction context and manifest identifiers in draft
  responses.
- Retain raw read-only query methods only under explicitly local names.

### 5.5 `@chronolog/client` and `@chronolog/react`

- Add schema-aware builders and logical values.
- Make observations produce expectation helpers.
- Remove SQL strings from transaction drafts.
- Make reactive queries accept query IR and include schema/manifest metadata in
  reset decisions.

### 5.6 Apps, examples, and testkit

- Rewrite the daemon configuration around a schema-manifest path or module.
- Rewrite CLI transaction commands around typed JSON-to-IR operations or
  application scripts; do not retain arbitrary consensus SQL execution.
- Rewrite the end-to-end example to use generated schema bindings.
- Replace testkit SQL transaction helpers with IR factories.

## 6. Replacement sequence

The repository will be easiest to keep understandable in this order:

1. Extract `@chronolog/canonical` without changing bytes for non-transaction
   protocol objects.
2. Add the logical value model, core IR types, codec, validator, and golden
   fixtures.
3. Add schema IR, catalog construction, and canonical schema SQL compilation.
4. Add execution-manifest construction and native measurement.
5. Change the materializer to per-candidate top-level transactions while its
   old reducer tests still expose the isolation change.
6. Implement core query and mutation compilation.
7. Edit `TransactionCore` and its codec directly to carry IR.
8. Edit node drafts and RPC contracts directly.
9. Replace the client API and rewrite examples.
10. Implement deterministic kernels and advanced registered features.
11. Delete all remaining consensus raw-SQL types, helpers, fixtures, and tests.
12. Run the complete conformance and distributed replay suites.

Steps 5 and 7 create temporary integration breakage if landed independently.
On the working branch, the final state—not compatibility between intermediate
commits—is the requirement.

## 7. Removal checklist

At cutover completion, searches for the following MUST have no consensus-path
matches:

```text
SqlPrecondition
SqlStatement
addStatement
transaction.addStatement
genesisSql
chronolog-sql-v1
SAVEPOINT chronolog_application_transaction
```

Occurrences in historical design discussion are also removed or clearly
marked as superseded. `sql` remains valid in the local read-only query API,
canonical renderer, security layer, and generated backend plans.

## 8. Failure and recovery during development

- Incompatible local database: delete and recreate it.
- Incompatible SSB feed: create a fresh test group/feed.
- Incompatible fixture: regenerate it from the canonical fixture generator and
  review the byte change.
- Partially edited RPC client: update client and server together.
- Native manifest change: rebuild the addon and recreate the test database.

No automatic recovery logic is appropriate for these cases before the first
released format exists.

## 9. Completion criteria

The direct cutover is complete when:

1. `TransactionCore` contains only IR preconditions and mutations.
2. The protocol test corpus contains no raw-SQL candidate fixture.
3. The node cannot publish a raw SQL mutation.
4. The validator validates IR structure, schema, effects, and manifest support.
5. The materializer never prepares caller-supplied consensus SQL.
6. The client transaction builder is schema-aware and type-safe.
7. Genesis is compiled from schema IR.
8. Development databases and fixtures are recreated without any migration
   step.
9. All local-query SQL paths are explicitly read-only and separately named.
10. The deletion checklist passes in CI.

