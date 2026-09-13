import test from 'node:test';
import assert from 'node:assert/strict';
import { sqlite } from '../server/sqlite.mjs';
import { Store } from '../server/store.mjs';
import { SharedStore } from '../server/shared.mjs';
import { createApp } from '../server/app.mjs';
import { createWorker } from '../server/worker.mjs';
import { SourceError } from '../server/foresttrip.mjs';

const page = { lastBuildDate: 'Thu, 10 Sep 2026 12:00:00 +0900', total: 2, start: 1, display: 2, items: [
  { title: '합성 테스트 B', description: '검증용 <b>본문</b>', link: 'https://example.org/b?from=fixture', bloggername: '검증 B', bloggerlink: 'https://example.org/b', postdate: '20260908' },
  { title: '합성 테스트 A', description: '임의 요약을 추가하지 않습니다.', link: 'https://example.org/a', bloggername: '검증 A', bloggerlink: 'https://example.org/a', postdate: '20260909' },
] };
async function setup(t, search = async () => page) {
  const db = sqlite(':memory:'); t.after(() => db.close());
  const store = new Store(db, 'fixture-secret-'.repeat(5)); await store.init(); await new SharedStore(db).init();
  const calls = [];
  const handle = createApp({ store, naverBlogs: { async search(query) { calls.push(query); return search(query); } } });
  const request = (suffix = '', options = {}) => handle(new Request('http://localhost/api/forests/forest1/naver-blogs' + suffix, options));
  const seed = async () => { await store.set('catalog', {}); await store.set('appCsrf', 'fixture'); await store.set('forest:forest1', { id: 'forest1', name: '검증숲' }); };
  return { db, store, calls, request, seed };
}

test('Naver search requires existing access and a known forest; invalid parameters never reach provider', async t => {
  const h = await setup(t);
  assert.equal((await h.request()).status, 403);
  await h.store.set('catalog', {});
  assert.equal((await h.request()).status, 404);
  await h.seed();
  for (const query of ['?sort=popular', '?start=0', '?start=1001', '?start=2', '?start=1e2']) assert.equal((await h.request(query)).status, 400);
  assert.equal((await h.request('', { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  assert.equal(h.calls.length, 0);
});

test('Naver API preserves every result and provider order without persistent cache or result writes', async t => {
  const h = await setup(t); await h.seed();
  const before = await h.db.prepare('SELECT * FROM kv ORDER BY key').all();
  for (let i = 0; i < 2; i++) {
    const response = await h.request('?sort=date&start=11');
    assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'private, no-store');
    const body = await response.json();
    assert.deepEqual(body.items, page.items); assert.equal(body.query, '검증숲 후기'); assert.equal(body.sort, 'date');
  }
  assert.deepEqual(h.calls, [{ query: '검증숲 후기', sort: 'date', start: 11 }, { query: '검증숲 후기', sort: 'date', start: 11 }]);
  assert.deepEqual(await h.db.prepare('SELECT * FROM kv ORDER BY key').all(), before);
  assert.equal((await h.db.prepare('SELECT COUNT(*) AS count FROM shared_cache').first()).count, 0);
});

test('Naver errors retain only forest context for an accurate fallback and never echo provider details', async t => {
  const h = await setup(t, async () => { throw new SourceError('NAVER_CONFIG_REQUIRED', '네이버 검색 연결을 준비 중입니다.', 503); });
  await h.seed();
  const result = await h.request(), body = await result.json();
  assert.equal(result.status, 503); assert.equal(body.error.code, 'NAVER_CONFIG_REQUIRED');
  assert.deepEqual(body.forest, { id: 'forest1', name: '검증숲' }); assert.equal(body.query, '검증숲 후기'); assert.equal(body.items, undefined);
  const unsafe = await setup(t, async () => { throw new Error('private-provider-body'); }); await unsafe.seed();
  assert.doesNotMatch(await (await unsafe.request()).text(), /private-provider-body/);
});

test('hosted Naver page is never cached and uses an isolated content policy', async () => {
  const worker = createWorker();
  for (const path of ['/naver-reviews', '/naver-reviews.html']) {
    const result = await worker.fetch(new Request('https://fixture.test' + path), { ASSETS: { fetch: async () => new Response('<p>fixture</p>', { headers: { 'cache-control': 'public,max-age=3600' } }) } });
    assert.equal(result.headers.get('cache-control'), 'private, no-store');
    assert.match(result.headers.get('content-security-policy'), /default-src 'none'/);
    assert.equal(result.headers.get('referrer-policy'), 'no-referrer');
  }
});
