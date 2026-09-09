import { DatabaseSync } from 'node:sqlite';
export function sqlite(path) {
  const db = new DatabaseSync(path); db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
  const statements = new WeakMap();
  function prepare(sql, args = []) {
    const bound = {
      bind(...values) { return prepare(sql, values); },
      async first() { return db.prepare(sql).get(...args) || null; },
      async all() { return { results: db.prepare(sql).all(...args) }; },
      async run() { return { meta: db.prepare(sql).run(...args) }; }
    };
    statements.set(bound, { sql, args });
    return bound;
  }
  return {
    exec(sql) { db.exec(sql); },
    prepare,
    async batch(batch) {
      // Keep the transaction synchronous: no other request can interleave its reads.
      db.exec('BEGIN IMMEDIATE');
      try {
        const results = batch.map(bound => {
          const entry = statements.get(bound);
          if (!entry) throw new TypeError('Statement belongs to another database');
          const statement = db.prepare(entry.sql);
          if (statement.columns().length) return { results: statement.all(...entry.args), success: true, meta: { changes: 0 } };
          return { results: [], success: true, meta: statement.run(...entry.args) };
        });
        db.exec('COMMIT');
        return results;
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    close() { db.close(); }
  };
}
