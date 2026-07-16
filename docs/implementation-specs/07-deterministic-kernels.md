# Deterministic Kernel Implementation

Status: historical relational-IR work package; kernel requirements apply only
when enabled by the active SQL execution profile and compatibility ledger

## 1. Responsibility

Deterministic kernels implement logical operations that cannot safely inherit
SQLite, JavaScript, locale, or host-library behavior. The compiler calls them
for checked numeric operations, canonical values and comparison, strict text
and JSON behavior, labeled entropy, vector reference distances, result
encoding, and selected extension primitives.

Core kernels are part of the Chronolog implementation, not user extensions.
Their semantic and code digests are committed by the execution manifest.

## 2. Implementation form

The initial implementation SHOULD use a small Rust library with a stable C ABI
for native DoltLite registration and pure Rust calls for fixture/reference
generation. Rust is chosen for checked integer support, explicit byte handling,
and safe parser construction; it does not make unpinned third-party crate
semantics acceptable automatically.

The library SHALL:

- avoid ambient time, filesystem, environment, network, threads, and entropy;
- accept all inputs explicitly as bounded bytes and scalar metadata;
- return stable numeric status codes plus canonical output bytes;
- catch or eliminate panics across the C ABI;
- use no locale-sensitive host calls;
- expose a semantic manifest and self-test digest; and
- compile under fixed reviewed flags.

If the team keeps kernels in C++ instead, it must provide the same API,
memory-safety checks, independent fixtures, and manifest measurement.

## 3. ABI

Use a value-oriented ABI rather than exposing Rust/C++ objects:

```c
typedef struct {
  const uint8_t *ptr;
  size_t len;
} chronolog_bytes;

typedef struct {
  int32_t code;
  uint8_t *ptr;
  size_t len;
} chronolog_result;

chronolog_result chronolog_kernel_call(
  uint32_t operation_id,
  chronolog_bytes canonical_arguments,
  chronolog_bytes canonical_context,
  chronolog_bytes semantic_limits
);

void chronolog_kernel_free(uint8_t *ptr, size_t len);
```

Production may add typed fast paths, but the canonical call path remains the
conformance oracle. Allocation failure is operational and distinguishable from
a deterministic semantic error.

## 4. Error model

Kernel codes are stable integers mapped to dialect errors:

```text
OK
INVALID_ARGUMENT_ENCODING
TYPE_MISMATCH
NUMERIC_OVERFLOW
DIVISION_BY_ZERO
DECIMAL_RESCALE_REQUIRED
INVALID_UTF8
INVALID_JSON
JSON_DUPLICATE_KEY
JSON_DEPTH_LIMIT
JSON_PATH_ERROR
VECTOR_DIMENSION_MISMATCH
VECTOR_VALUE_INVALID
SEMANTIC_RESOURCE_LIMIT
UNSUPPORTED_OPERATION
INTERNAL_OPERATIONAL_FAILURE
```

Only documented semantic codes become canonical rejections. Internal failures
abort replay.

## 5. Checked integer kernel

Implement `Int64`:

- add, subtract, multiply, divide, remainder and negate;
- absolute value with minimum-value overflow;
- comparisons and total ordering;
- shifts with explicit range policy;
- conversion to/from exact decimal, text, timestamp and duration; and
- checked timestamp/duration arithmetic.

Division specifies truncation direction and the minimum-value divided by `-1`
overflow case. No operation promotes to float.

Aggregates use checked accumulators and a specified input sequence. `count`
uses bounded `Int64` and fails rather than wrapping.

## 6. Decimal kernel

Represent decimal as signed arbitrary-precision coefficient plus nonnegative
scale, bounded by the schema's declared precision and scale.

Operations:

- canonical parse and format;
- normalize without losing declared logical scale;
- compare across scales;
- add/subtract/multiply;
- explicit rescale with declared rounding mode;
- divide with declared result scale and rounding mode;
- remainder;
- sum/min/max aggregates; and
- checked conversions.

There is no implicit rounding. The schema/expression type checker determines
result precision and scale before invoking a kernel. A decimal canonical text
formatter distinguishes integral Decimal from Int64 as specified by the value
codec.

The initial rounding registry should implement exact/reject, toward zero,
floor, ceiling, half-up, half-down, and half-even with golden boundary cases.

## 7. Text kernel

Portable text operations work on valid UTF-8 scalar sequences and use binary
UTF-8 comparison by default.

Implement:

- validation and scalar/byte length;
- byte and scalar slicing with explicit indexing rules;
- concatenation with size checks;
- binary search/contains/prefix/suffix;
- exact replacement;
- ASCII-only case operations where explicitly named; and
- canonical escaping for diagnostics and JSON.

General Unicode normalization, case folding, segmentation, and collation
require a registered Unicode data bundle and algorithm digest. They are not
implemented by delegating to the host ICU or JavaScript runtime implicitly.

## 8. Canonical JSON

### 8.1 Tree representation

```ts
type CanonicalJsonValue =
  | { readonly kind: 'null' }
  | { readonly kind: 'boolean'; readonly value: boolean }
  | { readonly kind: 'number'; readonly coefficient: bigint; readonly scale: number }
  | { readonly kind: 'string'; readonly utf8: Uint8Array }
  | { readonly kind: 'array'; readonly values: readonly CanonicalJsonValue[] }
  | { readonly kind: 'object'; readonly entries: readonly CanonicalJsonEntry[] }
```

Object entries are stored by ascending unsigned UTF-8 key bytes. Duplicate keys
are rejected during parsing before sorting.

### 8.2 Parser

The parser accepts strict RFC 8259 JSON only:

- no comments, trailing commas, single quotes, NaN, infinity, or JSON5;
- valid escape sequences and surrogate pairing;
- strict UTF-8;
- bounded depth, tokens, string bytes, number digits, and total bytes;
- exact decimal number parsing; and
- duplicate-key rejection.

It does not parse through JavaScript `JSON.parse` because that loses exact
number representation and duplicate-key evidence.

### 8.3 Serialization

Canonical serialization emits:

- `null`, `true`, and `false` literals;
- exact normalized decimal text under the logical-number policy;
- shortest required JSON escapes with lowercase or fixed-case hex policy;
- arrays in stored order; and
- object keys in canonical byte order.

Serialization fixtures include every escape, Unicode boundary, decimal form,
and object ordering case.

### 8.4 Operations

Implement typed:

- JSON Pointer resolution;
- path existence, type, scalar extraction, array length, and object keys;
- object/array construction;
- set, insert, replace, remove and append;
- RFC 7396 Merge Patch;
- RFC 6902 JSON Patch;
- containment and structural comparison; and
- canonical array/object aggregation.

JSON Patch applies operations in declared order and produces stable indexed
failure attribution. Remote `$ref` or schema fetching is never allowed.

### 8.5 SQLite integration

Canonical JSON source columns store UTF-8 text. Registered scalar functions
decode, operate, and return canonical text or typed SQL storage values.

SQLite JSON1 may accelerate audited equivalent operations. The compiler must
route duplicate-key handling, exact numbers, canonical objects, patching, and
consensus-sensitive table expansion through Chronolog kernels/modules unless a
fixture proves exact equivalence.

SQLite JSONB is derived/internal only and is never a canonical kernel value.

## 9. Canonical comparison and result encoding

The kernel implements one total order per logical type and canonical row
encoding for multiset/set comparison.

Row encoding includes:

- result format marker;
- projection count;
- each projection ID and logical type;
- null marker; and
- canonical value bytes.

Comparison never uses backend text formatting or column names. Result digests
cover output schema, mode, and sorted/ordered encoded rows.

For large results, the executor uses bounded external-free in-memory sorting
under semantic row/byte limits. A future spill implementation must use a
managed deterministic store and cannot depend on host temp-file visibility for
consensus outcomes.

## 10. Labeled entropy

Implement the dialect's HKDF-SHA256 derivation exactly. Inputs are signed group
ID, transaction nonce, ASCII label, unsigned index, and output length.

Convenience operations derive:

- fixed bytes;
- UUID with explicitly set version/variant bits;
- bounded integer via rejection sampling with fixed labeled sub-indices; and
- deterministic shuffle keys by hashing item canonical identity.

No stateful PRNG object is exposed. Rejection sampling derives each attempt
from `(label, logical_index, attempt)` so evaluation order cannot alter output.

This entropy is author-controlled and APIs document that it is not a lottery or
unbiasable randomness source.

## 11. Vector reference kernel

Core vector encoding and exact operations live in the kernel even when
sqlite-vec is enabled. Implement:

- bit packing validation and Hamming distance;
- int8 encoding, Manhattan distance, squared L2, and dot product;
- overflow-bound calculation from dimensions;
- float32 bit validation and canonicalization policy;
- primary-key tie comparison; and
- exact scan KNN reference ordering.

Portable bit/int8 operations use integer accumulators. Float distance is
disabled for portable consensus until a deterministic software-float operation
is registered and passes cross-platform fixtures.

## 12. Numeric and vector SQL registration

The DoltLite addon registers kernel-backed SQLite functions on every connection
before schema verification. Functions are marked deterministic and innocuous
only when those SQLite flags accurately describe them. Schema-use permission is
separately controlled by the Chronolog registry.

Callbacks:

1. Validate SQLite storage classes and sizes.
2. Convert to canonical arguments.
3. Invoke the typed native fast path or canonical kernel ABI.
4. Map semantic errors to a private extended code/result channel.
5. Return exact INTEGER, TEXT, or BLOB storage.

They never call Node/JavaScript callbacks during consensus execution.

## 13. Resource accounting

Kernels receive semantic limits and charge deterministic units:

- input/output bytes;
- decoded scalar count;
- JSON nodes and path operations;
- big-integer limb operations under a specified schedule;
- vector dimensions and distance candidates; and
- aggregate items.

The accounting schedule is part of the semantic manifest. Host allocation
failure before the semantic limit is operational; reaching the deterministic
limit is a canonical resource rejection.

## 14. Third-party dependencies

Every parser, big-integer, hash, Unicode, or serialization dependency is pinned
by exact source/checksum and audited for:

- deterministic behavior;
- duplicate and malformed input policy;
- panic/exception behavior;
- resource bounds;
- unsafe code and C ABI safety;
- platform conditionals; and
- license.

The manifest records semantic dependency digests, not merely package version
strings. Dependencies with behavior outside our control are wrapped by golden
fixtures and explicit normalization.

## 15. Independent paths

At least two paths verify core semantics:

- production native kernel invoked by SQLite; and
- reference invocation from conformance tests using canonical arguments.

Where practical, a slow TypeScript reference implementation covers integer,
value comparison, JSON canonicalization, and bit/int8 distances. Shared code is
not considered independent proof.

## 16. Tests

Required kernel tests:

1. Exhaustive small integer operation matrices and boundary property tests.
2. Decimal parsing, scale, rounding, overflow, and algebraic fixtures.
3. UTF-8 and text boundary/fuzz tests.
4. JSON official-style syntax cases, duplicate keys, exact numbers, paths,
   patches, canonical bytes, and resource limits.
5. Result row encoding and total ordering.
6. HKDF/entropy official and Chronolog fixtures.
7. Vector encoding, overflow, distance, tie, and KNN fixtures.
8. C ABI malformed input and allocation/error handling.
9. Native SQLite callback versus direct kernel equivalence.
10. Cross-platform semantic manifest and fixture equality.
11. Fuzz parsers with bounded memory and no panics.

## 17. Completion criteria

- No core consensus arithmetic depends on SQLite promotion or JavaScript
  `number` behavior.
- JSON parsing preserves exact numbers and rejects duplicate keys.
- Text and collation behavior is explicit and manifest-pinned.
- Entropy is stateless, labeled, signed-context-derived, and reproducible.
- sqlite-vec results can be checked against an independent vector oracle.
- Kernel semantic failures and host operational failures are distinguishable.
- Every kernel and dependency affecting semantics contributes to the execution
  manifest digest.
