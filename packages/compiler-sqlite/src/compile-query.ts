import type { ExecutionManifest, Query } from '@chronolog/ir'

import type { Catalog } from './catalog.js'
import { SqlRenderer } from './render.js'
import type { CompiledQuery } from './types.js'
import { CompilerError } from './types.js'

export function compileQuery(query: Query, catalog: Catalog, _manifest: ExecutionManifest = catalog.manifest): CompiledQuery {
  const renderer = new SqlRenderer(catalog)
  const rendered = renderer.query(query)
  if (renderer.parameters.length > 1_000) throw new CompilerError('IR_PARAMETER_LIMIT', query.id)
  return {
    source: query,
    sql: rendered.sql,
    parameters: renderer.parameters,
    columns: rendered.columns,
    resultMode: query.resultMode,
  }
}
