import { BUILTIN_FUNCTION_NAMES, sqliteIdentifierKey } from '@chronolog/ir'

/**
 * SQL functions whose implementations are part of the pinned DoltLite/SQLite
 * engine and are deterministic from their arguments. This is shared by the
 * compiler and runtime authorizer so an execution manifest cannot make an
 * ambient or stateful SQLite function deterministic merely by labelling it
 * `pure`.
 *
 * Registered-function IR models scalar calls. Aggregate-only functions are
 * emitted solely through AggregateExpr so they cannot be smuggled in as
 * manifest-declared scalar functions.
 */
interface FunctionArity {
  readonly minimum: number
  readonly maximum: number
  readonly step?: number
}

/** Closed, compiler-typed SQLite core functions represented by BuiltinFunctionExpr. */
export const DETERMINISTIC_SQLITE_BUILTIN_FUNCTIONS: ReadonlySet<string> = new Set(BUILTIN_FUNCTION_NAMES)

export function isDeterministicSqliteBuiltinFunction(name: string): boolean {
  return DETERMINISTIC_SQLITE_BUILTIN_FUNCTIONS.has(sqliteIdentifierKey(name))
}

const maximumArguments = 64
const variadic = (minimum: number, step = 1): FunctionArity => ({
  minimum,
  maximum: maximumArguments,
  step,
})
const exact = (...values: readonly number[]): readonly FunctionArity[] =>
  values.map((value) => ({ minimum: value, maximum: value }))

/** Arity is matched to the pinned SQLite 3.54 build and its runtime limit. */
const deterministicScalarArities: ReadonlyMap<string, readonly FunctionArity[]> = new Map([
  ['char', [variadic(0)]],
  ['coalesce', [variadic(2)]],
  ['concat', [variadic(1)]],
  ['concat_ws', [variadic(2)]],
  ['glob', exact(2)],
  ['hex', exact(1)],
  ['if', [variadic(2)]],
  ['ifnull', exact(2)],
  ['iif', [variadic(2)]],
  ['instr', exact(2)],
  ['json', exact(1)],
  ['json_array', [variadic(0)]],
  ['json_object', [variadic(0, 2)]],
  ['json_type', exact(1, 2)],
  ['length', exact(1)],
  ['like', exact(2, 3)],
  ['likelihood', exact(2)],
  ['likely', exact(1)],
  ['lower', exact(1)],
  ['ltrim', exact(1, 2)],
  ['nullif', exact(2)],
  ['octet_length', exact(1)],
  ['quote', exact(1)],
  ['replace', exact(3)],
  ['rtrim', exact(1, 2)],
  ['sign', exact(1)],
  ['substr', exact(2, 3)],
  ['substring', exact(2, 3)],
  ['trim', exact(1, 2)],
  ['typeof', exact(1)],
  ['unhex', exact(1, 2)],
  ['unicode', exact(1)],
  ['unlikely', exact(1)],
  ['upper', exact(1)],
  ['zeroblob', exact(1)],
])

export const DETERMINISTIC_SQLITE_SCALAR_FUNCTIONS: ReadonlySet<string> = new Set(
  deterministicScalarArities.keys(),
)

/** Functions emitted internally by deterministic query lowering. */
export const DETERMINISTIC_SQLITE_COMPILER_FUNCTIONS: ReadonlySet<string> = new Set([
  ...DETERMINISTIC_SQLITE_SCALAR_FUNCTIONS,
  ...DETERMINISTIC_SQLITE_BUILTIN_FUNCTIONS,
  '->',
  '->>',
  'count',
  'min',
  'max',
  // Admitted only when the SQL compiler proves a value-completed input order.
  'group_concat',
  // The compiler supplies deterministic ordering semantics for these window
  // functions before they reach SQLite.
  'row_number',
  'rank',
  'dense_rank',
  'ntile',
  'lag',
  'lead',
])

export function isDeterministicSqliteScalarFunction(name: string, arity?: number): boolean {
  const rules = deterministicScalarArities.get(sqliteIdentifierKey(name))
  if (rules === undefined) return false
  if (arity === undefined) return true
  return rules.some((rule) =>
    arity >= rule.minimum && arity <= rule.maximum &&
    (arity - rule.minimum) % (rule.step ?? 1) === 0)
}
