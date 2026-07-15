export function chaosBootstrapStatements(accountCount: number) {
  return [
    { sql: 'CREATE TABLE accounts (id INTEGER PRIMARY KEY, balance INTEGER NOT NULL) STRICT' },
    ...Array.from({ length: accountCount }, (_value, account) => ({
      sql: 'INSERT INTO accounts (id, balance) VALUES (?, ?)',
      parameters: [BigInt(account), 0n] as const,
    })),
  ]
}

export function balanceQuery(account: number) {
  return { sql: 'SELECT balance FROM accounts WHERE id = ?', parameters: [BigInt(account)] as const }
}

export function balanceUpdate(account: number, value: bigint) {
  return { sql: 'UPDATE accounts SET balance = ? WHERE id = ?', parameters: [value, BigInt(account)] as const }
}

export function stateQuery() {
  return { sql: 'SELECT id, balance FROM accounts ORDER BY id' }
}

export function transactionLogQuery() {
  return {
    sql: 'SELECT tx_id, order_index, author_id, author_timestamp_ms, outcome, rejection_code, result_digest FROM chronolog_transactions ORDER BY order_index, tx_id',
  }
}
