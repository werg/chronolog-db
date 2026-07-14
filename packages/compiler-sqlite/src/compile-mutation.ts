import type {
  Assignment,
  Expr,
  Mutation,
  SchemaColumn,
  SchemaTable,
  TransactionProgram,
} from '@chronolog/ir'
import { validateTransactionProgram } from '@chronolog/ir'

import type { Catalog } from './catalog.js'
import { compileQuery } from './compile-query.js'
import { quoteIdentifier, SqlRenderer, type RelationScope } from './render.js'
import { CompilerError, type CompiledMutation, type CompiledPrecondition, type CompiledProgram } from './types.js'

export function compileProgram(program: TransactionProgram, catalog: Catalog): CompiledProgram {
  const validation = validateTransactionProgram(program, { schema: catalog.schema, manifest: catalog.manifest })
  if (!validation.ok) {
    const diagnostic = validation.diagnostics[0]!
    throw new CompilerError(diagnostic.code, diagnostic.nodeId ?? null)
  }
  if (program.preconditions.length === 0) throw new CompilerError('IR_PRECONDITION_REQUIRED')
  if (program.mutations.length === 0) throw new CompilerError('IR_MUTATION_REQUIRED')
  return {
    preconditions: program.preconditions.map((precondition): CompiledPrecondition => {
      try {
        return {
          id: precondition.id,
          kind: precondition.kind,
          query: compileQuery(precondition.query, catalog),
          ...(precondition.kind === 'expect' ? { expected: precondition.expected } : {}),
        }
      } catch (error) {
        if (error instanceof CompilerError) throw new CompilerError(error.code, precondition.id, 'precondition')
        throw error
      }
    }),
    mutations: program.mutations.map((mutation) => {
      try { return compileMutation(mutation, catalog) }
      catch (error) {
        if (error instanceof CompilerError) throw new CompilerError(error.code, mutation.id, 'command')
        throw error
      }
    }),
  }
}

export function compileMutation(mutation: Mutation, catalog: Catalog): CompiledMutation {
  if (mutation.returning !== undefined) throw new CompilerError('IR_RETURNING_UNSUPPORTED', mutation.id, 'command')
  if (mutation.kind === 'merge' || mutation.kind === 'stateful_call') {
    throw new CompilerError('IR_MUTATION_UNSUPPORTED', mutation.id, 'command')
  }
  const table = catalog.table(mutation.target)
  const renderer = new SqlRenderer(catalog)
  const targetScope: RelationScope = { alias: table.name, table }
  let sql: string
  if (mutation.kind === 'insert') {
    if (mutation.conflict !== 'error') throw new CompilerError('IR_INSERT_CONFLICT_UNSUPPORTED', mutation.id, 'command')
    const columns = resolveColumns(table, mutation.columns, catalog)
    if (mutation.rows.length === 0) throw new CompilerError('IR_INSERT_ROW_REQUIRED', mutation.id, 'command')
    const rows = mutation.rows.map((row) => {
      if (row.length !== columns.length) throw new CompilerError('IR_INSERT_ARITY', mutation.id, 'command')
      return `(${row.map((expression, index) => {
        assertExpressionAssignable(expression, columns[index]!)
        return renderer.expression(expression, [])
      }).join(', ')})`
    }).join(', ')
    sql = `INSERT INTO ${quoteIdentifier(table.name)} (${columns.map((column) => quoteIdentifier(column.name)).join(', ')}) VALUES ${rows}`
  } else if (mutation.kind === 'update') {
    if (mutation.assignments.length === 0) throw new CompilerError('IR_UPDATE_ASSIGNMENT_REQUIRED', mutation.id, 'command')
    const assignments = renderAssignments(mutation.assignments, table, catalog, renderer, targetScope, false)
    const where = mutation.where === undefined ? '' : ` WHERE ${renderer.expression(mutation.where, [targetScope], targetScope)}`
    sql = `UPDATE ${quoteIdentifier(table.name)} AS ${quoteIdentifier(table.name)} SET ${assignments}${where}`
  } else if (mutation.kind === 'delete') {
    const where = mutation.where === undefined ? '' : ` WHERE ${renderer.expression(mutation.where, [targetScope], targetScope)}`
    sql = `DELETE FROM ${quoteIdentifier(table.name)} AS ${quoteIdentifier(table.name)}${where}`
  } else {
    const columns = resolveColumns(table, mutation.columns, catalog)
    if (mutation.row.length !== columns.length) throw new CompilerError('IR_UPSERT_ARITY', mutation.id, 'command')
    const values = mutation.row.map((expression, index) => {
      assertExpressionAssignable(expression, columns[index]!)
      return renderer.expression(expression, [])
    }).join(', ')
    const constraint = catalog.namedUnique(table, mutation.constraint)
    const conflict = constraint.columnIds.map((id) => quoteIdentifier(catalog.columnById(table, id).name)).join(', ')
    const updates = renderAssignments(mutation.updates, table, catalog, renderer, targetScope, true)
    if (updates.length === 0) throw new CompilerError('IR_UPSERT_UPDATE_REQUIRED', mutation.id, 'command')
    sql = `INSERT INTO ${quoteIdentifier(table.name)} AS ${quoteIdentifier(table.name)} (${columns.map((column) => quoteIdentifier(column.name)).join(', ')}) VALUES (${values}) ON CONFLICT (${conflict}) DO UPDATE SET ${updates}`
  }
  return { id: mutation.id, source: mutation, sql, parameters: renderer.parameters }
}

function resolveColumns(table: SchemaTable, names: readonly string[], catalog: Catalog): SchemaColumn[] {
  const seen = new Set<string>()
  return names.map((name) => {
    if (seen.has(name)) throw new CompilerError('IR_DUPLICATE_MUTATION_COLUMN', table.id, 'command')
    seen.add(name)
    return catalog.column(table, name)
  })
}

function renderAssignments(
  assignments: readonly Assignment[],
  table: SchemaTable,
  catalog: Catalog,
  renderer: SqlRenderer,
  targetScope: RelationScope,
  allowNew: boolean,
): string {
  const seen = new Set<string>()
  return assignments.map((assignment) => {
    if (seen.has(assignment.column)) throw new CompilerError('IR_DUPLICATE_MUTATION_COLUMN', table.id, 'command')
    seen.add(assignment.column)
    if (!allowNew && containsNewReference(assignment.value)) throw new CompilerError('IR_NEW_VALUE_UNSUPPORTED', assignment.value.id, 'command')
    const column = catalog.column(table, assignment.column)
    assertExpressionAssignable(assignment.value, column)
    return `${quoteIdentifier(column.name)} = ${renderer.expression(assignment.value, [targetScope], targetScope)}`
  }).join(', ')
}

function assertExpressionAssignable(expression: Expr, column: SchemaColumn): void {
  if (expression.kind === 'entropy') {
    if (column.valueType.logical.kind === 'uuid') {
      if (expression.length !== 16) throw new CompilerError('IR_ENTROPY_UUID_LENGTH', expression.id, 'command')
      return
    }
    if (column.valueType.logical.kind === 'blob') {
      if (column.valueType.logical.maxBytes !== undefined && expression.length > column.valueType.logical.maxBytes) {
        throw new CompilerError('IR_ENTROPY_BLOB_LENGTH', expression.id, 'command')
      }
      return
    }
    throw new CompilerError('IR_ENTROPY_TARGET_TYPE_MISMATCH', expression.id, 'command')
  }
  if (expression.kind === 'literal') {
    if (expression.value.kind === 'null') {
      if (!column.valueType.nullable) throw new CompilerError('IR_NULL_NOT_ALLOWED', expression.id, 'command')
      return
    }
    if (expression.value.kind !== column.valueType.logical.kind) throw new CompilerError('IR_MUTATION_TYPE_MISMATCH', expression.id, 'command')
    if (expression.value.kind === 'decimal' && column.valueType.logical.kind === 'decimal') {
      if (expression.value.scale > column.valueType.logical.scale) throw new CompilerError('IR_DECIMAL_SCALE_MISMATCH', expression.id, 'command')
      const delta = column.valueType.logical.scale - expression.value.scale
      const coefficient = expression.value.coefficient * 10n ** BigInt(delta)
      const digits = (coefficient < 0n ? -coefficient : coefficient).toString(10).length
      if (digits > column.valueType.logical.precision) throw new CompilerError('IR_DECIMAL_PRECISION_OVERFLOW', expression.id, 'command')
    }
    if (expression.value.kind === 'vector' && column.valueType.logical.kind === 'vector') {
      const width = expression.value.element === 'i8' || expression.value.element === 'u8' ? 1 : expression.value.element === 'i16' ? 2 : expression.value.element === 'f64' ? 8 : 4
      if (expression.value.element !== column.valueType.logical.element ||
          expression.value.dimensions !== column.valueType.logical.dimensions ||
          expression.value.bytes.length !== width * expression.value.dimensions) {
        throw new CompilerError('IR_VECTOR_SHAPE_MISMATCH', expression.id, 'command')
      }
    }
  }
}

function containsNewReference(expression: Expr): boolean {
  switch (expression.kind) {
    case 'old_new': return expression.scope === 'new'
    case 'unary': return containsNewReference(expression.operand)
    case 'binary': return containsNewReference(expression.left) || containsNewReference(expression.right)
    case 'conditional': return expression.branches.some((branch) => containsNewReference(branch.when) || containsNewReference(branch.then)) || containsNewReference(expression.otherwise)
    case 'function':
    case 'json': return expression.args.some(containsNewReference)
    case 'membership': return containsNewReference(expression.value) || expression.values?.some(containsNewReference) === true
    default: return false
  }
}
