import test from 'node:test';
import assert from 'node:assert/strict';
import { Foresttrip, BASE, MONTH_URL } from '../server/foresttrip.mjs';

test('default fetch preserves its global receiver through login, cookies and redirects', async t => {
  const originalFetch = globalThis.fetch, calls = [];
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async function (url, options) {
    // Node tolerates foreign receivers; Workers rejects them before network I/O.
    if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation');
    calls.push({ url, method: options.method });
    if (url === BASE + '/com/login') {
      const fields = new URLSearchParams(options.body);
      assert.equal(fields.get('loginId'), 'fixture-id');
      assert.equal(fields.get('loginPwd'), 'fixture-password');
      assert.equal(fields.get('_csrf'), 'fixture-token');
      return new Response(null, { status: 302, headers: { Location: MONTH_URL, 'Set-Cookie': 'fixture=connected; Path=/; Secure; HttpOnly' } });
    }
    assert.equal(url, MONTH_URL);
    if (!options.headers.Cookie) return new Response('<form id="fripPotForm" action="/com/login"><input type="hidden" name="_csrf" value="fixture-token"></form>', { status: 401 });
    assert.match(options.headers.Cookie, /fixture=connected/);
    return new Response('<input name="_csrf" value="fixture-token"><select id="monthSelectBox"><option value="202609">2026년 9월</option></select><select id="sido"><option value="1">경기</option></select>');
  };
  const source = new Foresttrip();
  const catalog = await source.login('fixture-id', 'fixture-password');
  assert.deepEqual(calls.map(c => c.method), ['GET', 'POST', 'GET']);
  assert.equal(catalog.months[0].id, '202609');
  assert.equal(catalog.regions[0].id, '1');
  assert.ok(source.connectedAt);
});

test('timeout, connection failure and runtime invocation failure remain distinguishable', async () => {
  for (const [error, code, status, message] of [
    [new DOMException('fixture timeout', 'TimeoutError'), 'NETWORK', 502, /대기 시간이 초과/],
    [new TypeError('fetch failed'), 'NETWORK', 502, /연결하지 못했습니다/],
    [new TypeError('Illegal invocation: incorrect this reference'), 'SOURCE_REQUEST_ERROR', 500, /요청을 처리하지 못했습니다/]
  ]) {
    const source = new Foresttrip(null, async () => { throw error; });
    await assert.rejects(source.request(MONTH_URL), e => e.code === code && e.status === status && message.test(e.message));
  }
});
