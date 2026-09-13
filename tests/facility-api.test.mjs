import test from 'node:test';
import assert from 'node:assert/strict';
import { sqlite } from '../server/sqlite.mjs';
import { Store } from '../server/store.mjs';
import { SharedStore } from '../server/shared.mjs';
import { createApp } from '../server/app.mjs';
import { createWorker } from '../server/worker.mjs';

async function setup(t) {
  const db = sqlite(':memory:'); t.after(() => db.close());
  const store = new Store(db, 's'.repeat(64)); await store.init();
  const shared = new SharedStore(db); await shared.init();
  const calls = [], assets = [], assetId = 'c'.repeat(64);
  let result = { detail: { title: '데크 20', images: [] }, checkedAt: '2026-09-10T00:00:00.000Z', stale: false };
  const facilityCache = {
    async get(query) { calls.push(query); return result; },
    async asset(id) { assets.push(id); return id === assetId ? { bytes: new Uint8Array([1, 2, 3]), contentType: 'image/png', etag: `"${id}"` } : null; }
  };
  const handle = createApp({ store, facilityCache });
  const request = (path, options = {}) => handle(new Request('http://localhost:5178' + path, options));
  const path = '/api/forests/ID02030062/units/deck20?type=camp';
  return { db, store, shared, request, calls, assets, assetId, path, setResult(value) { result = value; } };
}

test('facility reads require previous access and a known unit before requesting the source', async t => {
  const h = await setup(t);
  assert.equal((await h.request(h.path)).status, 403);
  await h.store.set('catalog', { months: [], regions: [] });
  assert.equal((await h.request(h.path)).status, 404);
  assert.equal((await h.request(h.path.replace('camp', 'invalid'))).status, 400);
  assert.equal(h.calls.length, 0);
  await h.shared.publish({ snapshots: [{ forestId: 'ID02030062', regionId: '43', month: '202609', type: 'camp', units: [{ id: 'deck20', name: '데크 20', type: 'camp' }], days: {}, status: 'complete' }] });
  assert.equal((await h.request(h.path, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  const response = await h.request(h.path);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).detail.title, '데크 20');
  assert.deepEqual(h.calls, [{ forestId: 'ID02030062', unitId: 'deck20', type: 'camp' }]);
  assert.equal((await h.request(h.path.replace('camp', 'stay'))).status, 404);
});

test('legacy snapshots can open facility information and cold or stale recovery state reaches the UI', async t => {
  const h = await setup(t);
  await h.store.set('catalog', { months: [], regions: [] });
  await h.store.set('snapshot:202609:ID02030062:camp', { forestId: 'ID02030062', type: 'camp', units: [{ id: 'deck20' }] });
  for (const detail of [null, { title: '이전 자료', images: [] }]) {
    const value = { detail, stale: !!detail, refreshing: false, retryAfter: '2026-09-10T00:05:00Z', error: { code: 'NETWORK', message: '잠시 후 다시 확인해주세요.' } };
    h.setResult(value);
    const response = await h.request(h.path);
    assert.equal(response.status, 200); assert.deepEqual(await response.json(), value);
  }
});

test('cached image bytes support HEAD and conditional reads without invoking a source fetch', async t => {
  const h = await setup(t), path = `/api/facility-assets/${h.assetId}`;
  assert.equal((await h.request(path)).status, 403);
  await h.store.set('catalog', {});
  const first = await h.request(path);
  assert.equal(first.headers.get('content-type'), 'image/png');
  assert.deepEqual(new Uint8Array(await first.arrayBuffer()), new Uint8Array([1, 2, 3]));
  const head = await h.request(path, { method: 'HEAD' });
  assert.equal(head.status, 200); assert.equal((await head.arrayBuffer()).byteLength, 0);
  assert.equal((await h.request(path, { headers: { 'If-None-Match': first.headers.get('etag') } })).status, 304);
  assert.equal((await h.request(`/api/facility-assets/${'d'.repeat(64)}`)).status, 404);
  assert.equal(h.calls.length, 0);
});

test('the hosted adapter keeps background refresh alive with the request execution context', async t => {
  const db = sqlite(':memory:'); t.after(() => db.close());
  const pending = Promise.resolve(), scheduled = [];
  const bucket = { async get() { return null; } };
  const worker = createWorker(options => async () => {
    assert.equal(options.assetStore.bucket, bucket);
    options.waitUntil(pending);
    return Response.json({ ok: true });
  });
  const result = await worker.fetch(new Request('https://test.example/api/session'), { DB: db, SESSION_SECRET: 's'.repeat(64), FACILITY_IMAGES: bucket }, { waitUntil(promise) { scheduled.push(promise); } });
  assert.equal(result.status, 200); assert.deepEqual(scheduled, [pending]);
});
