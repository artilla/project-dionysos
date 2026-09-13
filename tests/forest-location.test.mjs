import test from 'node:test';
import assert from 'node:assert/strict';
import { sqlite } from '../server/sqlite.mjs';
import { SharedStore } from '../server/shared.mjs';
import { forestLocation, locationUrl, parseForestLocation } from '../server/forest-location.mjs';

const id = 'ID02030082';
const address = '전북 장수군 번암면 예시길 12';
const sourceUrl = `https://www.foresttrip.go.kr/pot/fi/dr/selectDrctnsDtlView.do?hmpgId=${id}&menuId=002007`;
const fixture = (lat = '35.59', lng = '127.52', street = address) => `<!doctype html><html><body>
<script>const mapCenter = new kakao.maps.LatLng('${lat}', '${lng}');</script>
<div class="map_adress"><div><h4>상세 안내</h4>주소에 섞이면 안 되는 안내</div>
<div><h4>주소</h4>\n  ${street} / 대표전화 000-000-0000\n</div></div></body></html>`;
const expected = { id, lat: 35.59, lng: 127.52, address, sourceUrl };
const unavailable = error => error.code === 'LOCATION_UNAVAILABLE' && error.status === 502;
async function setup(t) {
  const db = sqlite(':memory:'); t.after(() => db.close());
  const shared = new SharedStore(db); await shared.init();
  return { db, shared };
}
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

test('official directions parser preserves latitude/longitude order and extracts only the address section', () => {
  assert.equal(locationUrl(id), sourceUrl);
  assert.deepEqual(parseForestLocation(fixture(), id), expected);
  const bareCoordinates = fixture().replace("LatLng('35.59', '127.52')", 'LatLng(35.59, 127.52)');
  assert.deepEqual(parseForestLocation(bareCoordinates, id), expected);
});

test('missing, non-numeric, swapped or out-of-range coordinates never become map locations', () => {
  for (const html of [
    '<html><p>공식 위치 정보를 준비하고 있습니다.</p></html>',
    fixture('NaN', '127.52'), fixture('35.59', 'Infinity'),
    fixture('127.52', '35.59'), fixture('0', '0'),
    fixture('32.99', '127.52'), fixture('39.01', '127.52'),
    fixture('35.59', '123.99'), fixture('35.59', '132.01')
  ]) assert.throws(() => parseForestLocation(html, id), unavailable);
});

test('a valid coordinate without an address remains usable without inventing an address', () => {
  const html = '<script>mapCenter = new kakao.maps.LatLng("37.5", "127.1")</script>';
  assert.deepEqual(parseForestLocation(html, '0103'), { id: '0103', lat: 37.5, lng: 127.1, address: '', sourceUrl: locationUrl('0103') });
});

test('public transport uses the official URL and fresh shared cache skips later upstream requests', async t => {
  const { db, shared } = await setup(t); let calls = 0;
  const transport = async (url, options) => {
    calls++;
    assert.equal(url, sourceUrl);
    assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(Object.keys(options.headers).some(name => /cookie|authorization|csrf/i.test(name)), false);
    return new Response(fixture(), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  };
  const first = await forestLocation({ id, shared, transport });
  assert.deepEqual(first.location, expected);
  assert.equal(first.cacheHit, false);
  assert.ok(Number.isFinite(Date.parse(first.observedAt)));
  const row = await db.prepare("SELECT * FROM shared_cache WHERE kind='location'").first();
  assert.equal(row.forest_id, id);
  assert.equal(row.expires_at - row.created_at, 30 * 24 * 60 * 60 * 1000);
  assert.deepEqual(JSON.parse(row.data), expected);
  const cached = await forestLocation({ id, shared: new SharedStore(db), transport });
  assert.deepEqual(cached, { ...first, cacheHit: true });
  assert.equal(calls, 1);
});

test('30-day expiry refreshes on the next request and persists the new location', async t => {
  const { shared } = await setup(t);
  let now = Date.parse('2026-09-13T00:00:00.000Z'), calls = 0;
  t.mock.method(Date, 'now', () => now);
  const transport = async () => new Response(++calls === 1 ? fixture() : fixture('35.6', '127.53', '변경된 공식 주소'));
  const first = await forestLocation({ id, shared, transport });
  now += 30 * 24 * 60 * 60 * 1000 - 1;
  assert.equal((await forestLocation({ id, shared, transport })).cacheHit, true);
  assert.equal(calls, 1);
  now++;
  const updated = await forestLocation({ id, shared, transport });
  assert.equal(updated.cacheHit, false);
  assert.equal(calls, 2);
  assert.equal(updated.location.lat, 35.6);
  assert.equal(updated.location.lng, 127.53);
  assert.equal(updated.location.address, '변경된 공식 주소');
  assert.notEqual(updated.observedAt, first.observedAt);
  assert.deepEqual(await forestLocation({ id, shared, transport }), { ...updated, cacheHit: true });
  assert.equal(calls, 2);
});

test('simultaneous requests for one forest share the same upstream fetch across store wrappers', async t => {
  const { db, shared } = await setup(t), started = deferred(), release = deferred();
  let calls = 0;
  const transport = async () => { calls++; started.resolve(); await release.promise; return new Response(fixture()); };
  const one = forestLocation({ id, shared, transport });
  await started.promise;
  const two = forestLocation({ id, shared: new SharedStore(db), transport });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
  release.resolve();
  const results = await Promise.all([one, two]);
  assert.deepEqual(results[0], results[1]);
  assert.deepEqual(results[0].location, expected);
  assert.equal(calls, 1);
});

test('failed location requests do not poison the cache or block a later retry', async t => {
  const { db, shared } = await setup(t); let calls = 0;
  const transport = async () => new Response(++calls === 1 ? '<p>No map coordinates</p>' : fixture());
  await assert.rejects(forestLocation({ id, shared, transport }), unavailable);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM shared_cache WHERE kind='location'").first()).n, 0);
  assert.deepEqual((await forestLocation({ id, shared, transport })).location, expected);
  assert.equal(calls, 2);
});
