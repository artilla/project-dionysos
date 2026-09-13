import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sqlite } from '../server/sqlite.mjs';
import { FacilityCache, facilityAddMonths } from '../server/facility-cache.mjs';

const query = { forestId: 'ID02030062', unitId: 'G123', type: 'camp' };
const imageUrl = 'https://image.foresttrip.go.kr/ino/goods/map.jpg';
const imageBytes = Uint8Array.from([1, 2, 3, 4]);
const detail = (changes = {}) => ({ ...query, title: '제1야영장 (데크 20)', sourceUrl: 'https://www.foresttrip.go.kr/pot/rm/fa/selectFcltsArmpDtlView.do',
  facts: [{ label: '면적', value: '12㎡' }], guide: ['쓰레기는 지정된 장소에 버려주세요.'],
  images: [{ kind: 'map', label: '전체배치도', sourceUrl: imageUrl }], ...changes });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function memoryAssets() {
  const values = new Map(); let puts = 0;
  return { values, get puts() { return puts; }, async put(id, bytes) { puts++; values.set(id, bytes.slice()); }, async get(id) { return values.get(id)?.slice() || null; }, async delete(id) { values.delete(id); } };
}
async function setup(t, extra = {}) {
  const db = extra.db || sqlite(':memory:'); if (!extra.db) t.after(() => db.close());
  let now = Date.parse('2026-01-31T03:00:00Z'), detailCalls = 0, imageCalls = 0;
  const source = {
    async detail() { detailCalls++; return detail(); },
    async image() { imageCalls++; return { bytes: imageBytes, contentType: 'image/jpeg', etag: 'origin-v1', lastModified: 'Tue, 20 Jan 2026 00:00:00 GMT' }; },
  };
  const assetStore = extra.assetStore || memoryAssets(), jobs = [];
  const options = { db, source, assetStore, clock: () => now, waitUntil: promise => jobs.push(promise), ...extra };
  const cache = new FacilityCache(options); await cache.init();
  return { db, cache, source, assetStore, jobs, options,
    get now() { return now; }, set now(value) { now = value; },
    get detailCalls() { return detailCalls; }, get imageCalls() { return imageCalls; } };
}
const idOf = result => result.detail.images[0].url.split('/').at(-1);

test('cold caches real image bytes; fresh reads make no upstream requests and expose only normalized fields', async t => {
  const state = await setup(t);
  state.source.detail = async () => detail({ cookies: 'private', credentials: 'secret' });
  const first = await state.cache.get(query);
  assert.equal(first.detail.title, '제1야영장 (데크 20)');
  assert.equal(first.checkedAt, '2026-01-31T03:00:00.000Z');
  assert.equal(first.refreshAfter, '2026-02-28T03:00:00.000Z');
  assert.equal(first.retainUntil, '2026-07-31T03:00:00.000Z');
  assert.equal(first.stale, false); assert.equal(first.refreshing, false); assert.equal(first.error, null);
  assert.ok(!JSON.stringify(first).includes('private')); assert.ok(!JSON.stringify(first).includes('secret'));
  const stored = await state.cache.asset(idOf(first));
  assert.deepEqual(stored.bytes, imageBytes); assert.equal(stored.contentType, 'image/jpeg');
  assert.equal(stored.etag, `"${idOf(first)}"`);
  state.source.detail = state.source.image = async () => { throw new Error('fresh must not fetch'); };
  assert.deepEqual(await state.cache.get(query), first);
  assert.deepEqual((await state.cache.asset(idOf(first))).bytes, imageBytes);
});

test('calendar expiry clamps month-end in Korea consistently including leap years', () => {
  assert.equal(new Date(facilityAddMonths(Date.parse('2024-01-30T16:00:00Z'), 1)).toISOString(), '2024-02-28T16:00:00.000Z');
  assert.equal(new Date(facilityAddMonths(Date.parse('2026-08-30T16:00:00Z'), 6)).toISOString(), '2027-02-27T16:00:00.000Z');
});

test('stale responds immediately while one background refresh updates text and reuses image 304 bytes', async t => {
  const state = await setup(t), first = await state.cache.get(query), ready = deferred();
  state.now = Date.parse(first.refreshAfter);
  state.source.detail = async () => { await ready.promise; return detail({ title: '변경된 배치도' }); };
  let conditional;
  state.source.image = async (url, headers) => { conditional = { url, ...headers }; return { notModified: true }; };
  const stale = await state.cache.get(query);
  assert.equal(stale.detail.title, first.detail.title); assert.equal(stale.stale, true); assert.equal(stale.refreshing, true);
  assert.equal(state.jobs.length, 1);
  const other = new FacilityCache(state.options);
  assert.equal((await other.get(query)).refreshing, true); assert.equal(state.jobs.length, 1);
  ready.resolve(); await state.jobs[0];
  const updated = await other.get(query);
  assert.equal(updated.detail.title, '변경된 배치도'); assert.equal(updated.stale, false);
  assert.equal(idOf(updated), idOf(first)); assert.equal(state.assetStore.puts, 1);
  assert.deepEqual(conditional, { url: imageUrl, etag: 'origin-v1', lastModified: 'Tue, 20 Jan 2026 00:00:00 GMT' });
});

test('a missing cached object recovers through an unconditional image request', async t => {
  const state = await setup(t), first = await state.cache.get(query);
  state.assetStore.values.delete(idOf(first)); state.now = Date.parse(first.refreshAfter);
  let conditional;
  state.source.image = async (url, headers) => { conditional = headers; return { bytes: imageBytes, contentType: 'image/jpeg', etag: 'origin-v1' }; };
  await state.cache.get(query); await state.jobs[0];
  assert.deepEqual(conditional, {});
  assert.equal((await state.cache.get(query)).error, null);
  assert.deepEqual((await state.cache.asset(idOf(first))).bytes, imageBytes);
});

test('failed refresh retains old snapshot and bytes, with five-minute retry cooldown', async t => {
  const state = await setup(t), first = await state.cache.get(query); state.now = Date.parse(first.refreshAfter);
  let attempts = 0;
  state.source.detail = async () => { attempts++; throw new Error('upstream failure carrying a secret'); };
  await state.cache.get(query); await state.jobs[0];
  const failed = await state.cache.get(query);
  assert.deepEqual(failed.detail, first.detail); assert.equal(failed.checkedAt, first.checkedAt);
  assert.equal(failed.error.code, 'FACILITY_REFRESH_FAILED'); assert.equal(failed.refreshing, false);
  assert.equal(Date.parse(failed.retryAfter), state.now + 300000); assert.equal(attempts, 1);
  assert.ok(!JSON.stringify(failed).includes('secret'));
  assert.deepEqual((await state.cache.asset(idOf(first))).bytes, imageBytes);
  state.now += 300001;
  const retrying = await state.cache.get(query);
  assert.equal(retrying.refreshing, true); assert.equal(retrying.error, null);
  await state.jobs[1]; assert.equal(attempts, 2);
});

test('cold rate limit returns a useful failure and a shared one-hour cooldown', async t => {
  const state = await setup(t); let calls = 0;
  state.source.detail = async () => { calls++; throw Object.assign(new Error('limited'), { status: 429 }); };
  const failed = await state.cache.get(query);
  assert.equal(failed.detail, null); assert.equal(failed.error.code, 'SOURCE_RATE_LIMITED');
  assert.equal(Date.parse(failed.retryAfter), state.now + 3600000);
  assert.deepEqual(await new FacilityCache(state.options).get(query), failed); assert.equal(calls, 1);
});

test('six-month expiration stops both detail and asset serving, and prunes expired stored bytes', async t => {
  const state = await setup(t), first = await state.cache.get(query), id = idOf(first);
  state.now = Date.parse(first.retainUntil);
  assert.equal(await state.cache.asset(id), null);
  state.source.detail = async () => { throw new Error('offline'); };
  const expired = await state.cache.get(query);
  assert.equal(expired.detail, null); assert.equal(expired.checkedAt, null);
  assert.equal(expired.error.code, 'FACILITY_REFRESH_FAILED');
  assert.equal(state.assetStore.values.size, 0);
  assert.equal((await state.db.prepare('SELECT COUNT(*) AS n FROM facility_assets').first()).n, 0);
});

test('shared SQLite lease prevents duplicate cold fetches across independent cache instances and connections', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'facility-concurrency-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const db = sqlite(join(dir, 'cache.sqlite')), db2 = sqlite(join(dir, 'cache.sqlite'));
  t.after(() => { db.close(); db2.close(); });
  const state = await setup(t, { db }), entered = deferred(), release = deferred(); let calls = 0;
  state.source.detail = async () => { calls++; entered.resolve(); await release.promise; return detail(); };
  const cold = state.cache.get(query); await entered.promise;
  const second = await new FacilityCache({ ...state.options, db: db2 }).get(query);
  assert.equal(second.detail, null); assert.equal(second.refreshing, true); assert.ok(second.retryAfter);
  release.resolve(); const complete = await cold;
  assert.equal((await new FacilityCache({ ...state.options, db: db2 }).get(query)).detail.title, complete.detail.title);
  assert.equal(calls, 1);
});

test('successful snapshots and source validators survive reopening the database', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'facility-persistence-')); t.after(() => rm(dir, { recursive: true, force: true }));
  let db = sqlite(join(dir, 'cache.sqlite')); t.after(() => db.close());
  const state = await setup(t, { db }), first = await state.cache.get(query);
  db.close(); db = sqlite(join(dir, 'cache.sqlite'));
  const fresh = new FacilityCache({ ...state.options, db, source: { async detail() { throw new Error('must not call'); } } });
  assert.deepEqual(await fresh.get(query), first);
  assert.deepEqual((await fresh.asset(idOf(first))).bytes, imageBytes);
});

test('content hashes deduplicate multiple source URLs and facilities, with only one stored object', async t => {
  const state = await setup(t);
  state.source.detail = async () => detail({ images: [
    { kind: 'photo', label: '사진', sourceUrl: imageUrl },
    { kind: 'map', label: '배치도', sourceUrl: `${imageUrl}?variant=2` },
  ] });
  const first = await state.cache.get(query), other = await state.cache.get({ ...query, unitId: 'G456' });
  assert.equal(first.detail.images[0].url, first.detail.images[1].url); assert.equal(idOf(first), idOf(other));
  assert.equal(state.assetStore.puts, 1); assert.equal(state.assetStore.values.size, 1);
  assert.equal((await state.db.prepare('SELECT COUNT(*) AS n FROM facility_assets').first()).n, 1);
  assert.equal((await state.db.prepare('SELECT COUNT(*) AS n FROM facility_asset_refs').first()).n, 2);
});

test('image-storage failure does not partially replace the published detail or its references', async t => {
  const state = await setup(t), first = await state.cache.get(query); state.now = Date.parse(first.refreshAfter);
  state.source.detail = async () => detail({ title: 'partial draft', images: [{ kind: 'photo', label: 'new', sourceUrl: `${imageUrl}?new` }] });
  state.source.image = async () => ({ bytes: Uint8Array.from([5, 6]), contentType: 'image/png' });
  state.assetStore.put = async () => { throw new Error('object write failed'); };
  await state.cache.get(query); await state.jobs[0];
  const failed = await state.cache.get(query);
  assert.deepEqual(failed.detail, first.detail); assert.equal(failed.error.code, 'FACILITY_REFRESH_FAILED');
  assert.deepEqual((await state.cache.asset(idOf(first))).bytes, imageBytes);
  const refs = (await state.db.prepare('SELECT asset_id FROM facility_asset_refs').all()).results;
  assert.deepEqual(refs.map(row => row.asset_id), [idOf(first)]);
});

test('transaction failure rolls back snapshot, image references and source validators together', async t => {
  const state = await setup(t), first = await state.cache.get(query); state.now = Date.parse(first.refreshAfter);
  state.db.exec("CREATE TRIGGER reject_facility BEFORE UPDATE OF data ON facility_cache WHEN NEW.data LIKE '%rejected draft%' BEGIN SELECT RAISE(ABORT,'publication failed'); END");
  state.source.detail = async () => detail({ title: 'rejected draft' });
  state.source.image = async () => ({ bytes: Uint8Array.from([7, 8, 9]), contentType: 'image/jpeg', etag: 'origin-v2' });
  await state.cache.get(query); await state.jobs[0];
  const failed = await state.cache.get(query);
  assert.deepEqual(failed.detail, first.detail);
  assert.equal((await state.db.prepare('SELECT etag FROM facility_asset_sources WHERE source_url=?').bind(imageUrl).first()).etag, 'origin-v1');
  assert.deepEqual((await state.cache.asset(idOf(first))).bytes, imageBytes);
});

test('late completion after timeout cannot publish over another lease owner', async t => {
  const state = await setup(t, { sourceTimeoutMs: 5 }), release = deferred();
  state.source.detail = async () => { await release.promise; return detail({ title: 'late response' }); };
  const failed = await state.cache.get(query);
  assert.equal(failed.error.code, 'FACILITY_TIMEOUT'); assert.equal(failed.detail, null);
  state.now += 300001;
  const replacement = new FacilityCache({ ...state.options, sourceTimeoutMs: 1000, source: {
    async detail() { return detail({ title: 'replacement' }); },
    async image() { return { bytes: imageBytes, contentType: 'image/jpeg' }; },
  } });
  assert.equal((await replacement.get(query)).detail.title, 'replacement');
  release.resolve(); await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal((await replacement.get(query)).detail.title, 'replacement');
});

test('timeout stops the image loop before any further source requests', async t => {
  const state = await setup(t, { sourceTimeoutMs: 5 }), release = deferred(); let imageCalls = 0;
  state.source.detail = async () => detail({ images: [
    { kind: 'photo', label: 'one', sourceUrl: imageUrl },
    { kind: 'map', label: 'two', sourceUrl: `${imageUrl}?second` },
  ] });
  state.source.image = async () => { imageCalls++; await release.promise; return { bytes: imageBytes, contentType: 'image/jpeg' }; };
  assert.equal((await state.cache.get(query)).error.code, 'FACILITY_TIMEOUT');
  release.resolve(); await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(imageCalls, 1); assert.equal(state.assetStore.puts, 0);
});

test('unconfigured storage fails only facility requests and invalid identifiers never fetch', async t => {
  const state = await setup(t), missing = new FacilityCache({ db: state.db, source: state.source });
  assert.equal((await missing.get(query)).error.code, 'CONFIG_REQUIRED');
  await assert.rejects(state.cache.get({ ...query, unitId: '../private' }), { code: 'INVALID_FACILITY' });
  assert.equal(state.detailCalls, 0); assert.equal(await missing.asset('a'.repeat(64)), null);
});
