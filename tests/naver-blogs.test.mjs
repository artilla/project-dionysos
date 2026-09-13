import test from 'node:test';
import assert from 'node:assert/strict';
import { NaverBlogSource } from '../server/naver-blogs.mjs';

// Every response in this file is invented test data; no live search is used.
const credentials = { clientId: 'synthetic-client-id', clientSecret: 'synthetic-client-secret' };
const item = (id = 1) => ({
  title: `합성 <b>테스트</b> 제목 ${id}`,
  link: `HTTPS://synthetic-blog.example.test:443/posts/${id}?q=%EA%B0%80&x=1#part`,
  description: `합성 요약 ${id} &amp; <b>강조</b>`,
  bloggername: `합성 블로그 ${id}`,
  bloggerlink: `http://synthetic-blog.example.test/writer/${id}`,
  postdate: '20260910'
});
const payload = (start = 1) => ({ lastBuildDate: 'Thu, 10 Sep 2026 12:34:56 +0900', total: 23, start, display: 2, items: [item(2), item(1)] });
const jsonResponse = (data = payload(), status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
const sourceFor = transport => new NaverBlogSource({ ...credentials, transport });

test('sends an API HUB 10-result request with server-only credentials and returns untouched public result fields', async () => {
  const upstream = { ...payload(), debug: 'synthetic-private-extra' };
  upstream.items[0].unrelated = 'extra item field';
  let calls = 0;
  const source = sourceFor(async (url, options) => {
    calls++;
    const target = new URL(url);
    assert.equal(target.origin + target.pathname, 'https://naverapihub.apigw.ntruss.com/search/v1/blog');
    assert.deepEqual(Object.fromEntries(target.searchParams), { query: ' 합성 테스트 & 검색 ', display: '10', start: '1', sort: 'sim', format: 'json' });
    assert.equal(options.method, 'GET');
    assert.equal(options.cache, 'no-store');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    assert.deepEqual(options.headers, { Accept: 'application/json', 'X-NCP-APIGW-API-KEY-ID': credentials.clientId, 'X-NCP-APIGW-API-KEY': credentials.clientSecret });
    assert.doesNotMatch(url, /synthetic-client/);
    return jsonResponse(upstream);
  });
  const result = await source.search({ query: ' 합성 테스트 & 검색 ' });
  assert.equal(calls, 1);
  assert.deepEqual(result, payload());
  assert.equal(result.items[0].link, upstream.items[0].link);
  assert.equal(result.items[0].title, upstream.items[0].title);
  assert.equal(result.items[0].description, upstream.items[0].description);
  assert.doesNotMatch(JSON.stringify(result), /synthetic-client|synthetic-private-extra|unrelated/);
});

test('repeated searches always call the transport, while date order and page 991 are passed through', async () => {
  let calls = 0;
  const source = sourceFor(async url => {
    calls++;
    const target = new URL(url);
    assert.equal(target.searchParams.get('start'), '991');
    assert.equal(target.searchParams.get('sort'), 'date');
    assert.equal(target.searchParams.get('display'), '10');
    return jsonResponse(payload(991));
  });
  await source.search({ query: '합성', sort: 'date', start: 991 });
  await source.search({ query: '합성', sort: 'date', start: 991 });
  assert.equal(calls, 2);
});

test('invalid input fails before fetching and preserves the allowed query boundary', async () => {
  let calls = 0;
  const source = sourceFor(async () => { calls++; return jsonResponse(); });
  for (const input of [undefined, null, [], {}, { query: '' }, { query: '   ' }, { query: 123 }, { query: '가'.repeat(201) }, { query: '합성', sort: 'random' }, { query: '합성', start: 0 }, { query: '합성', start: 2 }, { query: '합성', start: 1001 }, { query: '합성', start: '11' }, { query: '합성', start: 1.5 }]) {
    await assert.rejects(source.search(input), error => error.code === 'INVALID_INPUT' && error.status === 400);
  }
  assert.equal(calls, 0);
  await source.search({ query: '가'.repeat(200) });
  assert.equal(calls, 1);
});

test('missing or unsafe credentials cause a fixed configuration failure before transport', async () => {
  let calls = 0;
  for (const config of [{}, { clientId: 'synthetic-id' }, { ...credentials, clientId: ' ' }, { ...credentials, clientSecret: 'synthetic\r\nsecret' }]) {
    const source = new NaverBlogSource({ ...config, transport: async () => { calls++; return jsonResponse(); } });
    await assert.rejects(source.search({ query: '합성' }), error => error.code === 'NAVER_CONFIG_REQUIRED' && error.status === 503 && !/synthetic/.test(error.message));
  }
  assert.equal(calls, 0);
});

test('valid empty and short pages preserve metadata and item order without inventing results', async () => {
  for (const data of [
    { ...payload(), total: 0, display: 0, items: [] },
    { ...payload(), total: 1, display: 1, items: [item()] },
    { ...payload(), total: 1, display: 10, items: [item()] }
  ]) {
    assert.deepEqual(await sourceFor(async () => jsonResponse(data)).search({ query: '합성' }), data);
  }
});

test('one invalid item fails the entire response rather than filtering or rewriting it', async () => {
  const mutations = [
    item => { delete item.title; },
    item => { item.description = null; },
    item => { item.bloggername = {}; },
    item => { item.postdate = '2026-09-10'; },
    item => { item.postdate = '20260230'; },
    item => { item.link = 'javascript:alert(1)'; },
    item => { item.link = '/relative/path'; },
    item => { item.link = 'https://username:password@example.test/path'; },
    item => { item.bloggerlink = 'https://username@example.test/blog'; },
    item => { item.bloggerlink = 'https://example.test/\nblog'; },
    item => { item.bloggerlink = ' https://example.test/blog'; }
  ];
  for (const mutate of mutations) {
    const data = payload();
    mutate(data.items[1]);
    await assert.rejects(sourceFor(async () => jsonResponse(data)).search({ query: '합성' }), error => error.code === 'NAVER_INVALID_RESPONSE' && error.status === 502);
  }
});

test('invalid public metadata, invalid JSON and invalid UTF-8 fail the entire response', async () => {
  for (const data of [null, [], { ...payload(), lastBuildDate: 'not a date' }, { ...payload(), total: -1 }, { ...payload(), total: '23' }, { ...payload(), total: 0 }, { ...payload(), start: 11 }, { ...payload(), display: 11 }, { ...payload(), display: 1 }, { ...payload(), items: {} }]) {
    await assert.rejects(sourceFor(async () => jsonResponse(data)).search({ query: '합성' }), error => error.code === 'NAVER_INVALID_RESPONSE');
  }
  for (const body of ['{"items":', '<html>synthetic upstream error</html>', Uint8Array.of(0xff, 0xfe)]) {
    await assert.rejects(sourceFor(async () => new Response(body)).search({ query: '합성' }), error => error.code === 'NAVER_INVALID_RESPONSE');
  }
});

test('HTTP failures have fixed safe codes and messages without reading upstream body text', async () => {
  for (const [status, code, publicStatus] of [[401, 'NAVER_AUTH_FAILED', 503], [403, 'NAVER_AUTH_FAILED', 503], [429, 'NAVER_RATE_LIMITED', 429], [400, 'NAVER_UNAVAILABLE', 502], [503, 'NAVER_UNAVAILABLE', 502], [302, 'NAVER_UNAVAILABLE', 502]]) {
    let canceled = false;
    const body = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('synthetic-private-upstream-detail')); }, cancel() { canceled = true; } });
    await assert.rejects(sourceFor(async () => new Response(body, { status })).search({ query: '합성' }), error => error.code === code && error.status === publicStatus && !/synthetic-private/.test(error.message));
    assert.equal(canceled, true);
  }
});

test('transport errors and redirect failures never expose their raw message', async () => {
  for (const error of [new TypeError('synthetic-client-secret redirect failure'), new Error('synthetic-private-network-detail')]) {
    await assert.rejects(sourceFor(async () => { throw error; }).search({ query: '합성' }), result => result.code === 'NAVER_UNAVAILABLE' && result.status === 502 && !/synthetic/.test(result.message));
  }
});

test('eight-second timeout applies to both fetching and response streaming', async t => {
  for (const stage of ['fetch', 'body']) {
    const controller = new AbortController();
    const mock = t.mock.method(AbortSignal, 'timeout', milliseconds => { assert.equal(milliseconds, 8000); return controller.signal; });
    let canceled = false;
    const source = sourceFor(async (_url, options) => {
      if (stage === 'fetch') return await new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
        queueMicrotask(() => controller.abort(new DOMException('synthetic private timeout', 'TimeoutError')));
      });
      const stream = new ReadableStream({
        pull() { queueMicrotask(() => controller.abort(new DOMException('synthetic private timeout', 'TimeoutError'))); },
        cancel() { canceled = true; }
      });
      return new Response(stream);
    });
    await assert.rejects(source.search({ query: '합성' }), error => error.code === 'NAVER_TIMEOUT' && error.status === 504 && !/synthetic/.test(error.message));
    if (stage === 'body') assert.equal(canceled, true);
    mock.mock.restore();
  }
});

test('advertised or streamed responses beyond 512 KB are canceled and rejected', async () => {
  for (const advertised of [true, false]) {
    let canceled = false;
    const stream = new ReadableStream({
      pull(controller) { controller.enqueue(new Uint8Array(128 * 1024)); },
      cancel() { canceled = true; }
    });
    const source = sourceFor(async () => new Response(stream, { headers: advertised ? { 'Content-Length': String(512 * 1024 + 1) } : {} }));
    await assert.rejects(source.search({ query: '합성' }), error => error.code === 'NAVER_INVALID_RESPONSE');
    assert.equal(canceled, true);
  }
});
