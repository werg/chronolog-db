# Application migrations

`@chronolog/migrations` evolves application schemas using ordinary signed SQL
transactions. It does not introduce a privileged schema transaction or an
authoritative consensus schema manifest. Migration DDL, backfills, and the
history insert commit or roll back together.

```ts
import {
  MigrationManager,
  defineMigration,
  schemaVersionAssumption,
} from '@chronolog/migrations'

const migration = defineMigration({
  component: 'profiles',
  id: 'profiles-v2-email',
  version: 2,
  statements: [
    { sql: 'ALTER TABLE profiles ADD COLUMN email TEXT' },
    { sql: 'UPDATE profiles SET email = lower(display_name) || \'@example.test\'' },
  ],
})

const migrations = new MigrationManager(client)
const result = await migrations.apply(migration, { requireWatermark: true })
```

The history convention is `application_migrations(component, id, version,
checksum, applied_at_ms)`. Versions are contiguous per component. Reapplying
the identical ID/version/checksum is safe; changing an already-used ID or
version returns `conflicting_checksum`. Concurrent attempts are serialized by
signed predecessor, absence, and checksum preconditions.

Application transactions can make schema assumptions explicit:

```ts
const schema = schemaVersionAssumption('profiles', {
  exact: 2,
  checksum: migration.checksum,
})

await client.transaction((tx) => {
  tx.assert(schema.sql, schema.parameters, {
    applicationLabel: schema.applicationLabel,
  })
  tx.exec('INSERT INTO profiles (id, display_name, email) VALUES (?, ?, ?)', [
    1n, 'Ada', 'ada@example.test',
  ])
})
```

`minimum` assumptions support additive old/new-client overlap. Both forms use
portable `COUNT`/`EXISTS` queries, so they remain inside the current consensus
SQL profile.

`inspectCatalog(client, revision)` reads `sqlite_schema` and
`pragma_table_xinfo` at one pinned materialized revision. `diffCatalogs`
compares two snapshots. `generateTypeScriptBindings` includes the pinned
revision and catalog digest in generated output, which is advisory and never
becomes consensus schema state.

The CLI accepts the same migration document:

```sh
pnpm cli migrations status @migration.json
pnpm cli migrations apply @migration.json --watermark
pnpm cli migrations wait TRANSACTION_ID --watermark
pnpm cli catalog inspect MATERIALIZED_REVISION
pnpm cli catalog diff OLD_REVISION NEW_REVISION
pnpm cli catalog bindings MATERIALIZED_REVISION
```

`MigrationManager.settlement()`, `migrationChanges()`, and `schemaChanges()`
provide resumable live resources for settlement evidence, history changes, and
catalog revisions.
