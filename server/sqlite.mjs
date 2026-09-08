import { DatabaseSync } from 'node:sqlite';
export function sqlite(path) {
  const db = new DatabaseSync(path); db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
  return {
    exec(sql) { db.exec(sql); },
    prepare(sql) {
      return { bind(...args) {
        const statement = db.prepare(sql);
        return { async first() { return statement.get(...args) || null; }, async all() { return { results: statement.all(...args) }; }, async run() { return { meta: statement.run(...args) }; } };
      } };
    },
    close() { db.close(); }
  };
}
