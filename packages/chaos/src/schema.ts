export function chaosBootstrapStatements(accountCount: number) {
  return [
    { sql: 'CREATE TABLE accounts (id INTEGER PRIMARY KEY, balance INTEGER NOT NULL, version INTEGER NOT NULL, touched INTEGER NOT NULL) STRICT' },
    { sql: 'CREATE TABLE chaos_ledger (operation_id TEXT NOT NULL, leg INTEGER NOT NULL, account_id INTEGER NOT NULL, delta INTEGER NOT NULL, note TEXT, payload BLOB, PRIMARY KEY (operation_id, leg)) WITHOUT ROWID, STRICT' },
    { sql: 'CREATE TABLE chaos_documents (document_id TEXT PRIMARY KEY NOT NULL, account_id INTEGER NOT NULL, title TEXT NOT NULL, payload BLOB NOT NULL, optional_text TEXT) STRICT' },
    { sql: 'CREATE TABLE chaos_schema_migrations (component TEXT NOT NULL, version INTEGER NOT NULL, checksum TEXT NOT NULL, PRIMARY KEY (component, version)) WITHOUT ROWID, STRICT' },
    { sql: 'CREATE TABLE chaos_profiles (profile_id TEXT PRIMARY KEY NOT NULL, display_name TEXT NOT NULL, email TEXT, schema_version INTEGER NOT NULL DEFAULT 2, metadata BLOB) STRICT' },
    { sql: 'CREATE TABLE chaos_profile_audit (profile_id TEXT PRIMARY KEY NOT NULL, schema_version INTEGER NOT NULL, email_seen INTEGER NOT NULL) WITHOUT ROWID, STRICT' },
    { sql: 'CREATE INDEX chaos_profiles_display_name_idx ON chaos_profiles(display_name)' },
    { sql: 'CREATE VIEW chaos_profiles_current AS SELECT profile_id, display_name, email, metadata FROM chaos_profiles WHERE schema_version = 2' },
    { sql: 'CREATE TRIGGER chaos_profiles_insert_audit AFTER INSERT ON chaos_profiles BEGIN INSERT INTO chaos_profile_audit VALUES (NEW.profile_id, NEW.schema_version, NEW.email IS NOT NULL); END' },
    { sql: "INSERT INTO chaos_schema_migrations VALUES ('profiles', 1, 'profiles-v1-base')" },
    { sql: "INSERT INTO chaos_schema_migrations VALUES ('profiles', 2, 'profiles-v2-additive-email-metadata')" },
    ...Array.from({ length: accountCount }, (_value, account) => ({
      sql: 'INSERT INTO accounts (id, balance, version, touched) VALUES (?, ?, 0, 0)',
      parameters: [BigInt(account), 0n] as const,
    })),
    { sql: "INSERT INTO chaos_ledger VALUES ('__reserved_constraint_key__', 0, 0, 0, NULL, X'')" },
  ]
}

export function balanceQuery(account: number) {
  return { sql: 'SELECT balance FROM accounts WHERE id = ?', parameters: [BigInt(account)] as const }
}

export function balanceUpdate(account: number, value: bigint) {
  return {
    sql: 'UPDATE accounts SET balance = ?, version = version + 1 WHERE id = ? RETURNING id, balance, version',
    parameters: [value, BigInt(account)] as const,
  }
}

/** A signed, replay-time schema assumption backed by application migration history. */
export function schemaVersionPrecondition(component: string, version: number) {
  return {
    sql: 'SELECT EXISTS (SELECT 1 FROM chaos_schema_migrations WHERE component = ? AND version = ?)',
    parameters: [component, BigInt(version)] as const,
    applicationLabel: `chaos.schema.${component}.v${version}`,
  }
}

export function stateQuery() {
  return {
    sql: `
      SELECT 0 AS row_kind, id AS key_one, 0 AS key_two,
             balance AS value_one, version AS value_two, touched AS value_three,
             NULL AS text_value, NULL AS payload
        FROM accounts
      UNION ALL
      SELECT 1, operation_id, leg, account_id, delta, 0, note, payload
        FROM chaos_ledger
      UNION ALL
      SELECT 2, document_id, 0, account_id, 0, 0, title, payload
        FROM chaos_documents
      UNION ALL
      SELECT 3, profile_id, schema_version, 0, 0, 0,
             display_name || '|' || COALESCE(email, ''), metadata
        FROM chaos_profiles
      UNION ALL
      SELECT 4, profile_id, schema_version, email_seen, 0, 0, NULL, NULL
        FROM chaos_profile_audit
      UNION ALL
      SELECT 5, component, version, 0, 0, 0, checksum, NULL
        FROM chaos_schema_migrations
       ORDER BY row_kind, key_one, key_two
    `,
  }
}

export function schemaQuery() {
  return {
    sql: `
      SELECT type, name, tbl_name, sql
        FROM sqlite_schema
       WHERE name NOT LIKE 'sqlite_%'
         AND name NOT LIKE 'dolt_%'
         AND name NOT LIKE 'chronolog_%'
       ORDER BY type, name
    `,
  }
}

export function transactionLogQuery() {
  return {
    sql: `
      SELECT tx_id, order_index, author_id, author_timestamp_ms, outcome,
             rejection_code, result_digest, result_envelope_version,
             length(result_envelope), failure_phase, failing_precondition_id,
             failing_precondition_index, failing_statement_index,
             failing_constraint_identity, failing_trigger_identity
        FROM chronolog_transactions
       ORDER BY order_index, tx_id
    `,
  }
}
