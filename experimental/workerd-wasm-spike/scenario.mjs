// Shared scenario: deterministic DDL/DML + two commits + branch. Backend supplies
// scalar(sql, ...params), rows(sql), exec(sql).
export const AUTHOR = 'Chronolog reducer <reducer@chronolog.invalid>'
export const DATE = '1970-01-01T00:00:00'

export function runScenario(b) {
  const out = {}
  b.exec(`CREATE TABLE accounts(id INTEGER PRIMARY KEY, name TEXT NOT NULL, balance INTEGER NOT NULL, meta BLOB)`)
  b.exec(`CREATE TABLE events(seq INTEGER PRIMARY KEY, kind TEXT, payload TEXT)`)
  b.exec(`CREATE INDEX events_kind ON events(kind)`)
  for (let i = 1; i <= 300; i += 1) {
    b.exec(`INSERT INTO accounts VALUES (${i}, 'user-${i}', ${i * 17 % 1000}, x'${(i * 2654435761 % 0xffffffff).toString(16).padStart(8, '0')}')`)
    b.exec(`INSERT INTO events VALUES (${i}, 'k${i % 7}', json_object('i', ${i}, 'sq', ${i * i}))`)
  }
  out.commit1 = b.scalar(`SELECT dolt_commit('-A', '-m', 'genesis', '--author', '${AUTHOR}', '--date', '${DATE}')`)
  out.head1 = b.scalar(`SELECT dolt_hashof('HEAD')`)
  b.exec(`UPDATE accounts SET balance = balance + 1 WHERE id % 3 = 0`)
  b.exec(`DELETE FROM events WHERE seq % 11 = 0`)
  out.commit2 = b.scalar(`SELECT dolt_commit('-A', '-m', 'second', '--author', '${AUTHOR}', '--date', '${DATE}')`)
  out.head2 = b.scalar(`SELECT dolt_hashof('HEAD')`)
  out.branch = b.scalar(`SELECT dolt_branch('replay')`)
  out.log = b.rows(`SELECT commit_hash, message, committer, date FROM dolt_log`)
  out.sum = b.scalar(`SELECT sum(balance) FROM accounts`)
  out.cnt = b.scalar(`SELECT count(*) FROM events`)
  return out
}
