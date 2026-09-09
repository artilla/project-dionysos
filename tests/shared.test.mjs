import test from 'node:test';
import assert from 'node:assert/strict';
import { sqlite } from '../server/sqlite.mjs';
import { SharedStore, snapshotKey } from '../server/shared.mjs';

async function setup(t) {
  const db = sqlite(':memory:'); t.after(() => db.close());
  const shared = new SharedStore(db); await shared.init();
  await db.batch(shared.catalogStatements({ today: '20260909', months: [{ id: '202609', name: '9월' }], regions: [{ id: '1', name: '경기' }] }));
  return { db, shared };
}
const forest = { id: 'f1', regionId: '1', name: '숲', types: ['stay'] };
const snapshot = (month = '202609') => ({ month, type: 'stay', forestId: 'f1', regionId: '1', status: 'complete', units: [], days: {}, checkedUnits: 0, observedAt: '2026-09-09T00:00:00Z' });
const query = { month: '202609', region: '1', type: 'stay', guests: 2, nights: 2, weekend: false, includeWait: false, today: '20260909' };

test('generation check guards all months, metadata, caches and versions together', async t => {
  const { db, shared } = await setup(t);
  const first = await shared.publish({ forests: [forest], snapshots: [snapshot(), snapshot('202610')], expected: { f1: 0 }, knownRegion: '1' });
  assert.equal(first.accepted, true);
  const before = await shared.read(query, 'f1');
  const rejected = await shared.publish({ forests: [{ ...forest, name: 'old writer' }], snapshots: [{ ...snapshot(), units: [{ id: 'old' }] }], expected: { f1: 0 }, invalidatePrices: ['f1'] });
  assert.equal(rejected.accepted, false);
  const after = await shared.read(query, 'f1');
  assert.deepEqual(after.forests, before.forests);
  assert.deepEqual(after.snapshots, before.snapshots);
  assert.equal(after.dependencies, before.dependencies);
  assert.equal((await shared.forest('f1')).name, '숲');
  assert.equal(await shared.priceVersion('f1'), 0);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM shared_publications').first()).n, 0);
});

test('a failure after a successful generation check rolls back the entire publication', async t => {
  const { db, shared } = await setup(t);
  await shared.publish({ forests: [forest], snapshots: [snapshot()], expected: { f1: 0 } });
  db.exec("CREATE TRIGGER reject_next BEFORE INSERT ON shared_snapshots WHEN NEW.month='202610' BEGIN SELECT RAISE(ABORT,'test failure'); END");
  await assert.rejects(shared.publish({ snapshots: [{ ...snapshot(), checkedUnits: 9 }, snapshot('202610')], expected: { f1: 1 } }));
  assert.equal((await shared.snapshot(snapshotKey(snapshot()))).checkedUnits, 0);
  assert.deepEqual(await shared.generations(['f1']), { f1: 1 });
});

test('shared snapshots strip private fields and bundle reads retain successful empty scopes', async t => {
  const { shared } = await setup(t);
  await shared.publish({ forests: [{ ...forest, cookie: 'secret' }], snapshots: [{ ...snapshot(), jobId: 'private-job', cookies: 'secret' }], expected: { f1: 0 }, knownRegion: '1' });
  const read = await shared.read(query);
  assert.equal(read.snapshots.length, 1);
  assert.equal(read.snapshots[0].status, 'complete');
  assert.deepEqual(read.snapshots[0].units, []);
  assert.ok(!JSON.stringify(read).includes('private-job'));
  assert.ok(!JSON.stringify(read).includes('secret'));
});

test('a large region is split into bounded bundle pages without losing forests', async t => {
  const { db, shared } = await setup(t);
  const forests = Array.from({ length: 10 }, (_, n) => ({ ...forest, id: `f${n}` }));
  const snapshots = forests.map(f => ({ ...snapshot(), forestId: f.id,
    units: Array.from({ length: 20 }, (_, n) => ({ id: `u${n}`, name: '가'.repeat(1200), type: 'stay', capacity: 4, maxNights: 3 })) }));
  await shared.publish({ forests, snapshots, expected: Object.fromEntries(forests.map(f => [f.id, 0])) });
  const pages = (await db.prepare('SELECT length(CAST(data AS BLOB)) AS bytes FROM shared_scope_bundles').all()).results;
  assert.ok(pages.length > 1);assert.ok(pages.every(p => p.bytes < 524288));
  const result = await shared.read(query);
  assert.equal(result.snapshots.length, 10);assert.equal(new Set(result.snapshots.map(s => s.forestId)).size, 10);
});
