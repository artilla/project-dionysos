import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';

const html = readFileSync(new URL('../web/naver-reviews.html', import.meta.url), 'utf8');
const source = readFileSync(new URL('../web/naver-reviews.js', import.meta.url), 'utf8');
const forest = { id: 'F1', name: '박달재자연휴양림' }, query = `${forest.name} 후기`;
const items = Array.from({ length: 10 }, (_, index) => ({
  title: `제목 ${index} <b>강조 &amp; 읽기</b> <img src=x onerror=alert(1)>`,
  description: '원문 <b>설명</b> &lt;script&gt;실행안함&lt;/script&gt;\n설명 끝',
  link: `https://blog.example.test/post/${index}?a=1&b=2`, bloggername: `이름 &amp; ${index}`,
  bloggerlink: `https://blog.example.test/author/${index}`, postdate: '20260910'
}));
const settled = () => new Promise(resolve => setImmediate(resolve));

async function setup() {
  const { document, window } = parseHTML(html);
  let focused = null, closed = 0, clock = 1_000_000, timerId = 0, mode = 'success', held = false;
  const timers = new Map(), requests = [], waiting = [];
  window.HTMLElement.prototype.focus = function () { focused = this; };
  window.HTMLElement.prototype.scrollIntoView = function () {};
  window.history = { back() { closed++; } };
  document.referrer = 'http://fixture.test/';
  Object.defineProperty(window.HTMLSelectElement.prototype, 'value', {
    configurable: true,
    get() { return this.querySelector('option[selected]')?.value || this.querySelector('option')?.value; },
    set(value) { for (const option of this.querySelectorAll('option')) option.toggleAttribute('selected', option.value === value); }
  });
  class ClockDate extends Date { static now() { return clock; } }
  const context = vm.createContext({
    document, window, location: { search: '?forestId=F1', origin: 'http://fixture.test', assign() { closed++; } }, URL, URLSearchParams, AbortController, Date: ClockDate,
    setTimeout(fn, ms) { const id = ++timerId; timers.set(id, { fn, ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
    async fetch(path, init) {
      requests.push({ path, init });
      if (held) await new Promise((resolve, reject) => {
        waiting.push(resolve);
        init.signal.addEventListener('abort', () => reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })), { once: true });
      });
      const params = new URLSearchParams(path.split('?')[1]);
      return { ok: mode !== 'config', json: async () => mode === 'config'
        ? { forest, query, error: { code: 'NAVER_CONFIG_REQUIRED' } }
        : { forest, query, sort: params.get('sort'), start: Number(params.get('start')), display: 10, total: 1010,
          lastBuildDate: 'Thu, 10 Sep 2026 12:00:00 +0900', items: mode === 'empty' ? [] : items } };
    }
  });
  vm.runInContext(source, context);
  await settled();
  return {
    document, window, requests, timers, $: name => document.querySelector(`[data-naver-${name}]`),
    mode: value => { mode = value; }, hold: () => { held = true; }, release: () => { held = false; for (const resolve of waiting.splice(0)) resolve(); },
    advance: ms => { clock += ms; }, focus: () => focused, closed: () => closed,
    fireTimer(ms) { const entry = [...timers.entries()].find(([, timer]) => timer.ms === ms); assert.ok(entry, `timer ${ms} is scheduled`); timers.delete(entry[0]); entry[1].fn(); }
  };
}

test('renders the complete API fields in order with safe highlighting and exact outbound URLs', async () => {
  const h = await setup(), $ = h.$;
  assert.equal($('results').children.length, 10);
  assert.equal($('results').querySelectorAll('b').length, 20);
  assert.equal($('results').querySelector('img'), null);
  assert.equal($('results').querySelector('script'), null);
  assert.match($('results').textContent, /강조 & 읽기/);
  assert.match($('results').textContent, /<script>실행안함<\/script>/);
  const rows = Array.from($('results').children);
  for (let index = 0; index < rows.length; index++) {
    assert.match(rows[index].querySelector('h2').textContent, new RegExp(`^제목 ${index} `));
    assert.equal(rows[index].querySelector('[data-naver-original]').getAttribute('href'), items[index].link);
    assert.equal(rows[index].querySelector('[data-naver-blogger] a').getAttribute('href'), items[index].bloggerlink);
    assert.equal(rows[index].querySelector('[data-naver-blogger]').textContent, `이름 & ${index}`);
    assert.equal(rows[index].querySelector('[data-naver-postdate]').textContent, `게시일 ${items[index].postdate}`);
    for (const link of rows[index].querySelectorAll('a')) { assert.equal(link.target, '_blank'); assert.equal(link.rel, 'noopener noreferrer'); }
  }
  assert.equal($('attribution').getAttribute('href'), 'https://developers.naver.com');
  assert.equal($('attribution').querySelector('img').getAttribute('src'), '/naver-openapi.png');
  assert.equal(h.requests[0].init.cache, 'no-store');
  assert.equal(new URL($('bottom-source').href).searchParams.get('query'), query);
});

test('clears results before paging, preserves server sorting and provides a return from an empty later page', async () => {
  const h = await setup(), $ = h.$;
  h.hold(); $('next').click();
  assert.equal($('results').children.length, 0);
  assert.equal($('status').dataset.state, 'loading');
  assert.match(h.requests.at(-1).path, /start=11/);
  h.release(); await settled();
  assert.equal($('page').textContent, '2페이지');
  assert.equal(h.focus().tagName, 'A');
  $('sort').value = 'date'; $('sort').dispatchEvent(new h.window.Event('change')); await settled();
  assert.match(h.requests.at(-1).path, /sort=date&start=1/);
  h.mode('empty'); $('next').click(); await settled();
  assert.equal($('status').dataset.state, 'empty');
  assert.equal($('pagination').hidden, false);
  assert.equal($('prev').disabled, false); assert.equal($('next').disabled, true);
  h.mode('success'); $('prev').click(); await settled();
  assert.match(h.requests.at(-1).path, /start=1/);
  assert.equal($('results').children.length, 10);
});

test('shows configured-forest fallback and turns a timed-out request into a retryable error', async () => {
  const h = await setup(), $ = h.$;
  h.mode('config'); $('reload').click(); await settled();
  assert.equal($('results').children.length, 0);
  assert.equal($('status').dataset.state, 'config');
  assert.equal($('external').hidden, false);
  assert.equal(new URL($('external').href).searchParams.get('query'), query);
  h.mode('success'); h.hold(); $('retry').click();
  h.fireTimer(12000); await settled();
  assert.equal($('status').dataset.state, 'error');
  assert.match($('status').textContent, /응답이 늦어지고/);
  assert.equal($('retry').hidden, false); assert.equal($('reload').disabled, false);
  h.release(); $('retry').click(); await settled();
  assert.equal($('results').children.length, 10);
});

test('expires displayed results after 24 hours and clears pagehide, bfcache and close state', async () => {
  const h = await setup(), $ = h.$;
  h.advance(24 * 60 * 60 * 1000); h.fireTimer(24 * 60 * 60 * 1000);
  assert.equal($('results').children.length, 0); assert.equal($('status').dataset.state, 'expired');
  $('retry').click(); await settled(); assert.equal($('results').children.length, 10);
  h.window.dispatchEvent(new h.window.Event('pagehide'));
  assert.equal($('results').children.length, 0); assert.equal($('query').textContent, '');
  const count = h.requests.length, show = new h.window.Event('pageshow'); show.persisted = true;
  h.window.dispatchEvent(show); await settled();
  assert.equal(h.requests.length, count + 1); assert.equal($('results').children.length, 10);
  $('close').click();
  assert.equal(h.closed(), 1); assert.equal($('results').children.length, 0);
  assert.equal($('status').dataset.state, 'closed'); assert.equal(h.timers.size, 0);
});

test('pagehide aborts pending search without turning navigation into an error', async () => {
  const h = await setup(), $ = h.$;
  h.hold(); $('reload').click(); h.window.dispatchEvent(new h.window.Event('pagehide')); await settled();
  assert.equal(h.requests.at(-1).init.signal.aborted, true);
  assert.equal($('results').children.length, 0); assert.equal($('status').textContent, '');
  assert.equal(h.timers.size, 0);
});
