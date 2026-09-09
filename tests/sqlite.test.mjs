import test from 'node:test';
import assert from 'node:assert/strict';
import { sqlite } from '../server/sqlite.mjs';
import { readFile } from 'node:fs/promises';

test('batch reads its writes and rolls back every statement on failure', async t => {
  const db = sqlite(':memory:'); t.after(() => db.close());
  db.exec('CREATE TABLE value (id INTEGER PRIMARY KEY, amount INTEGER CHECK(amount >= 0))');
  const insert = db.prepare('INSERT INTO value VALUES (?, ?)');
  const result = await db.batch([insert.bind(1, 10), db.prepare('SELECT amount FROM value')]);
  assert.equal(result[0].meta.changes, 1);
  assert.equal(result[1].results[0].amount, 10);
  await assert.rejects(db.batch([insert.bind(2, 20), insert.bind(3, -1)]));
  assert.equal((await db.prepare('SELECT COUNT(*) AS total FROM value').first()).total, 1);
});

test('the shared cache migration preserves existing personal rows and is repeatable locally',async t=>{
  const db=sqlite(':memory:');t.after(()=>db.close());
  db.exec("CREATE TABLE kv (key TEXT PRIMARY KEY,value TEXT NOT NULL); INSERT INTO kv VALUES ('private:snapshot:old','retained')");
  const sql=await readFile(new URL('../migrations/0001_shared_cache.sql',import.meta.url),'utf8');
  db.exec(sql);db.exec(sql);
  assert.equal((await db.prepare('SELECT value FROM kv').first()).value,'retained');
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM shared_snapshots').first()).n,0);
});
