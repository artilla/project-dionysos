import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/store.mjs';
import { sqlite } from '../server/sqlite.mjs';
import { createApp } from '../server/app.mjs';
import { SharedStore, snapshotKey } from '../server/shared.mjs';
import { kstToday, monthDates } from '../server/domain.mjs';

// Two regions, two forests in region 1, one in region 2, six stay units each.
class Source {
  static calls = 0;
  constructor(auth) { this.connectedAt = auth?.connectedAt; }
  export() { return { connectedAt: this.connectedAt, cookies: {} }; }
  async login() { this.connectedAt = new Date().toISOString(); return { today: kstToday(), months: [{ id: kstToday().slice(0, 6), name: '이번 달' }], regions: [{ id: '1', name: '경기' }, { id: '2', name: '강원' }] }; }
  async forests(region) { return region.id === '1' ? [{ id: '0101', name: '첫 숲', region: '경기', regionId: '1' }, { id: '0102', name: '둘째 숲', region: '경기', regionId: '1' }] : [{ id: '0201', name: '강원 숲', region: '강원', regionId: '2' }]; }
  async policy() { return { types: [{ upperGoodsClsscCd: '01' }], lastDay: '20991231' }; }
  async queue() { return { key: 'k', raw: 'k', granted: true, waitUntil: 0 }; }
  async completeQueue() {}
  async goods() { return { netfunnelRslt: 'Y', rsrvtGoodsList: Array.from({ length: 6 }, (_, i) => ({ goodsId: 'g' + i, goodsNm: '시설' + i, mxmmAccptCnt: 4, mxmmStngDayCnt: 3 })), hldtInfoList: [] }; }
  async days(scope, ids) { Source.calls++; return ids.flatMap(goodsId => monthDates(scope.srchDate).map(useDt => ({ goodsId, useDt, rsrvtAvail: 'Y', rsrvtCnt: 0 }))); }
}
const month = kstToday().slice(0, 6);
async function world(t) {
  Source.calls = 0;
  const db = sqlite(':memory:'); t.after(() => db.close());
  const shared = new SharedStore(db); await shared.init();
  async function visitor(namespace, connect = true) {
    const store = new Store(db, 'a'.repeat(64), namespace); await store.init();
    const handle = createApp({ store, sourceFactory: auth => new Source(auth) }); let token;
    const call = async (path, body, headers = {}) => { const r = await handle(new Request('http://x' + path, { method: body === undefined ? 'GET' : 'POST', headers: { Origin: 'http://x', 'Content-Type': 'application/json', ...(token ? { 'X-CSRF-TOKEN': token } : {}), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })); return { status: r.status, data: await r.json() }; };
    token = (await call('/api/session')).data.csrfToken;
    if (connect) assert.equal((await call('/api/session/connect', { id: 'u', password: 'p' })).status, 200);
    const steps = async (limit = 40) => { let job; for (let i = 0; i < limit; i++) { job = (await call('/api/job/step', {})).data.job; if (job.status !== 'running') break; } return job; };
    return { call, store, steps };
  }
  const version = async key => (await db.prepare('SELECT version FROM shared_versions WHERE scope_key=?').bind(key).first())?.version || 0;
  return { db, shared, visitor, version };
}

test('two ordinary collections on one region finish without conflicts and share source responses', async t => {
  const { visitor, shared } = await world(t);
  const a = await visitor('aaaa'), b = await visitor('bbbb');
  await a.call('/api/sync', { month, type: 'stay', region: '1' }); await b.call('/api/sync', { month, type: 'stay', region: '1' });
  let ja, jb;
  for (let i = 0; i < 40; i++) {
    ja = (await a.call('/api/job/step', {})).data.job; jb = (await b.call('/api/job/step', {})).data.job;
    if (ja.status !== 'running' && jb.status !== 'running') break;
  }
  assert.equal(ja.status, 'complete'); assert.equal(jb.status, 'complete');
  assert.equal((await a.store.get('job')).conflictRetries, undefined); assert.equal((await b.store.get('job')).conflictRetries, undefined);
  assert.deepEqual(ja.failures, []); assert.deepEqual(jb.failures, []);
  // B walked one step behind A and reused every cached source response.
  assert.equal(Source.calls, 4);
  for (const id of ['0101', '0102']) { const s = await shared.snapshot(`snapshot:${month}:${id}:stay`); assert.equal(s.status, 'complete'); assert.equal(s.units.length, 6); }
  assert.equal(await shared.priceVersion('0101'), 0, 'ordinary collections do not invalidate prices');
});

test('an older ordinary collection cannot overwrite a newer targeted refresh and finishes as superseded', async t => {
  const { visitor, shared } = await world(t);
  const a = await visitor('aaaa');
  await a.call('/api/sync', { month, type: 'stay', region: '1' });
  for (let i = 0; i < 4; i++) await a.call('/api/job/step', {}); // region, policy ×2, queue+goods for 0101 → first partial snapshot published
  const partial = await shared.snapshot(`snapshot:${month}:0101:stay`);
  assert.equal(partial.status, 'partial');
  // A targeted refresh (compare-and-set) lands with a newer observation.
  const fresh = { ...partial, regionId: '1', status: 'complete', observedAt: new Date(Date.now() + 60000).toISOString(), units: [{ id: 'fresh', name: '새 시설', type: 'stay', capacity: 4, maxNights: 3 }], days: {} };
  const result = await shared.publish({ snapshots: [fresh], expected: await shared.generations(['0101']), invalidatePrices: ['0101'] });
  assert.equal(result.accepted, true);
  const job = await a.steps();
  assert.equal(job.status, 'complete'); assert.deepEqual(job.failures, []);
  const kept = await shared.snapshot(`snapshot:${month}:0101:stay`);
  assert.deepEqual(kept.units.map(u => u.id), ['fresh'], 'the newer targeted result stays in place');
  const stored = await a.store.get('job');
  assert.equal(stored.tasks.find(x => x.kind === 'scope' && x.forestId === '0101').superseded, true);
  assert.equal(stored.tasks.find(x => x.kind === 'scope' && x.forestId === '0102').superseded, undefined);
  const view = (await a.call(`/api/availability?month=${month}&type=stay&region=1`)).data;
  assert.equal(view.personal.forests['0101'].staleByJob, false, 'superseded data is newer, not stale');
  assert.equal(view.personal.forests['0101'].failed, false);
});

test('a complete ordinary scope may replace a partial one, but partial data never replaces a newer complete scope', async t => {
  const { shared } = await world(t);
  const base = { month, type: 'stay', forestId: '0101', regionId: '1', checkedUnits: 0, days: {} };
  const t0 = '2026-09-09T00:00:00.000Z', t1 = '2026-09-09T00:10:00.000Z';
  await shared.publish({ snapshots: [{ ...base, status: 'partial', observedAt: t1, units: [{ id: 'partial-new' }] }] });
  const older = await shared.publish({ snapshots: [{ ...base, status: 'complete', observedAt: t0, units: [{ id: 'complete-old' }] }] });
  assert.deepEqual(older.skipped, []);
  assert.equal((await shared.snapshot(snapshotKey(base))).units[0].id, 'complete-old');
  const stale = await shared.publish({ snapshots: [{ ...base, status: 'partial', observedAt: '2026-09-08T00:00:00.000Z', units: [{ id: 'stale' }] }] });
  assert.deepEqual(stale.skipped, [snapshotKey(base)]);
  assert.equal((await shared.snapshot(snapshotKey(base))).units[0].id, 'complete-old');
});

test('region and policy publications leave the catalog version and unrelated caches untouched', async t => {
  const { visitor, version } = await world(t);
  const a = await visitor('aaaa'), b = await visitor('bbbb');
  await a.call('/api/sync', { month, type: 'stay', region: '1' }); await a.steps();
  await a.call('/api/sync', { month, type: 'stay', region: '2' }); await a.steps();
  const paths = { r1: `/api/availability?month=${month}&type=stay&region=1`, r2: `/api/availability?month=${month}&type=stay&region=2`, detail: `/api/forests/0201?month=${month}&type=stay` };
  for (const path of Object.values(paths)) { await a.call(path); assert.equal((await a.call(path)).data.cacheHit, true, path); }
  const catalog = await version('catalog'), region1 = await version('forests:1');
  // A new job for region 1 republishes an unchanged forest list and policy.
  await b.call('/api/sync', { month, type: 'stay', region: '1' });
  await b.call('/api/job/step', {}); await b.call('/api/job/step', {});
  assert.equal(await version('catalog'), catalog, 'catalog version only moves when the catalog changes');
  assert.equal(await version('forests:1'), region1, 'unchanged forest records do not bump their region');
  for (const path of Object.values(paths)) assert.equal((await a.call(path)).data.cacheHit, true, path);
  // Continuing the collection republishes scopes of region 1 only.
  await b.steps();
  assert.equal((await a.call(paths.r1)).data.cacheHit, false, 'lists of the collected region recompute');
  assert.equal((await a.call(paths.r2)).data.cacheHit, true, 'other regions keep their cache');
  assert.equal((await a.call(paths.detail)).data.cacheHit, true, 'details of other forests keep their cache');
  assert.equal(await version('catalog'), catalog);
});

test('a changed forest record invalidates only its region lists, and a new region only itself', async t => {
  const { shared, version } = await world(t);
  const forest = { id: '0101', regionId: '1', name: '첫 숲', region: '경기' };
  const catalog = await version('catalog');
  await shared.publish({ forests: [forest], knownRegion: '1' });
  const r1 = await version('forests:1');
  await shared.publish({ forests: [forest], knownRegion: '1' });
  assert.equal(await version('forests:1'), r1, 'identical record and known region: no bump');
  await shared.publish({ forests: [{ ...forest, types: ['stay'] }] });
  assert.equal(await version('forests:1'), r1 + 1, 'changed record: one bump');
  assert.equal(await version('forests:2'), 0);
  await shared.publish({ knownRegion: '2' });
  assert.equal(await version('forests:2'), 1); assert.equal(await version('forests:1'), r1 + 1);
  assert.equal(await version('catalog'), catalog, 'publications never touch the catalog version');
});

test('a visitor with retained personal rows reuses the shared cache once shared data covers them', async t => {
  const { visitor } = await world(t);
  const a = await visitor('aaaa');
  await a.call('/api/sync', { month, type: 'stay', region: '1' }); await a.steps();
  const path = `/api/availability?month=${month}&type=stay&region=1`;
  await a.call(path);
  const c = await visitor('cccc');
  await c.store.set('forest:0101', { id: '0101', name: '첫 숲', region: '경기', regionId: '1', types: ['stay'] });
  await c.store.set(`snapshot:${month}:0101:stay`, { forestId: '0101', month, type: 'stay', status: 'complete', units: [], days: {}, observedAt: new Date().toISOString() });
  // A retained camp scope is not wanted for a stay-only forest and must not force a fallback.
  await c.store.set(`snapshot:${month}:0101:camp`, { forestId: '0101', month, type: 'camp', status: 'complete', units: [], days: {}, observedAt: new Date().toISOString() });
  const covered = (await c.call(path)).data;
  assert.equal(covered.cacheHit, true); assert.equal(covered.dataCoverage.state, 'shared'); assert.equal(covered.dataCoverage.fallbackScopes, 0);
  assert.equal(covered.forests[0].unitCount, 6, 'shared data wins over the retained personal scope');
  // A retained forest the shared store does not know still falls back, and that response is never cached.
  await c.store.set('forest:0199', { id: '0199', name: '사라진 숲', region: '경기', regionId: '1', types: ['stay'] });
  await c.store.set(`snapshot:${month}:0199:stay`, { forestId: '0199', month, type: 'stay', status: 'complete', units: [{ id: 'old', name: '이전 시설', type: 'stay', capacity: 4, maxNights: 3 }], days: {}, observedAt: new Date().toISOString() });
  const fallback = (await c.call(path)).data;
  assert.equal(fallback.cacheHit, false); assert.equal(fallback.dataCoverage.state, 'personal-fallback'); assert.equal(fallback.dataCoverage.fallbackScopes, 1);
  assert.deepEqual(fallback.personal.fallbackKeys, [`snapshot:${month}:0199:stay`]);
  assert.equal((await c.call(path)).data.cacheHit, false);
  assert.equal((await a.call(path)).data.cacheHit, true, 'other visitors keep hitting the shared cache');
});

test('a browser that never connected gets connect-required, distinct from not-yet-collected and confirmed-empty', async t => {
  const { visitor, shared, db } = await world(t);
  const a = await visitor('aaaa');
  await a.call('/api/sync', { month, type: 'stay', region: '1' }); await a.steps();
  const list = region => `/api/availability?month=${month}&type=stay&region=${region}`;
  // Never connected: shared reading is withheld, nothing is cached, the shared catalog still validates the query.
  const fresh = await visitor('nnnn', false);
  const withheld = (await fresh.call(list('1'))).data;
  assert.equal(withheld.dataCoverage.state, 'connect-required'); assert.deepEqual(withheld.forests, []); assert.equal(withheld.coverage.regionTotal, 1);
  assert.equal((await fresh.call(list('2'))).status, 200, 'region validation uses the shared catalog');
  assert.equal((await fresh.call(`/api/forests/0101?month=${month}&type=stay`)).data.dataCoverage.state, 'connect-required');
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM shared_cache WHERE kind='search'").bind().first()).n, 0, 'withheld responses are never cached');
  // Connected but region 2 was never collected: incomplete, not connect-required.
  const b = await visitor('bbbb');
  const uncollected = (await b.call(list('2'))).data;
  assert.equal(uncollected.dataCoverage.state, 'incomplete'); assert.equal(uncollected.coverage.missingRegions, 1);
  // Region 2 confirmed with a forest that has no facilities: empty.
  await shared.publish({ forests: [{ id: '0201', regionId: '2', region: '강원', name: '강원 숲', types: ['stay'] }], knownRegion: '2',
    snapshots: [{ month, type: 'stay', forestId: '0201', regionId: '2', status: 'complete', units: [], days: {}, checkedUnits: 0, observedAt: new Date().toISOString() }] });
  assert.equal((await b.call(list('2'))).data.dataCoverage.state, 'empty');
  // Collected data stays readable after disconnect and even after forgetting the account.
  assert.equal((await a.call('/api/session/disconnect', {})).data.connected, false);
  const afterDisconnect = (await a.call(list('1'))).data;
  assert.equal(afterDisconnect.dataCoverage.state, 'shared'); assert.equal(afterDisconnect.forests.length, 2);
  await a.call('/api/session/forget', {});
  assert.equal((await a.call('/api/session')).data.configured, false);
  assert.equal((await a.call(list('1'))).data.dataCoverage.state, 'shared');
  // The withheld browser reads shared data as soon as it connects once.
  await fresh.call('/api/session/connect', { id: 'u', password: 'p' });
  assert.equal((await fresh.call(list('1'))).data.dataCoverage.state, 'shared');
});

test('resume and retry reset the conflict budget without dropping the generation baseline', async t => {
  const { visitor } = await world(t);
  const a = await visitor('aaaa');
  await a.call('/api/sync', { month, type: 'stay', region: '1' }); await a.steps();
  await a.call('/api/sync', { month, type: 'stay', forestId: '0101' });
  const job = await a.store.get('job');
  job.conflictRetries = 3; job.status = 'partial'; job.regions[0].status = 'failed'; job.regions[0].error = { code: 'SOURCE_CONFLICT' };
  await a.store.set('job', job);
  await a.call('/api/job/retry', {});
  const retried = await a.store.get('job');
  assert.equal(retried.conflictRetries, 0); assert.equal(retried.status, 'running');
  assert.deepEqual(retried.generations, job.generations);
  assert.equal((await a.steps()).status, 'complete');
});
