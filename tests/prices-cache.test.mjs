import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
globalThis.document = parseHTML('<html><body></body></html>').document;
const { observePrices, invalidatePrices } = await import('../web/prices.js');
delete globalThis.document;

const quote = amount => ({ baseTotal: amount, nights: 1, baseGuests: 2, extraGuestFeeApplies: false,
  daily: [{ date: '20260920', amount }], observedAt: new Date().toISOString() });
const flush = async () => { for (let n = 0; n < 6; n++) await new Promise(resolve => setImmediate(resolve)); };
function surface(t, forestId, api, priceVersion = 0) {
  const original = globalThis.IntersectionObserver;
  globalThis.IntersectionObserver = class { constructor(callback) { this.callback = callback; } observe(target) { this.callback([{ target, isIntersecting: true }]); } unobserve() {} disconnect() {} };
  t.after(() => { globalThis.IntersectionObserver = original; });
  const { document } = parseHTML('<html><body><section><div data-price-unit="g0" data-price-type="stay"></div></section></body></html>');
  const container = document.querySelector('section');
  const stop = observePrices(container, { forestId, api, priceVersion, date: '20260920', nights: 1, guests: 2 });
  t.after(stop);
  return container;
}

test('prices reuse the 15 minute cache and invalidate only the refreshed forest', async t => {
  let calls = 0, amount = 120000;
  const api = async () => { calls++; return { quote: quote(amount) }; };
  surface(t, 'first', api); await flush();
  surface(t, 'second', api); await flush();
  surface(t, 'first', api); await flush(); assert.equal(calls, 2);
  amount = 150000; invalidatePrices('first');
  const first = surface(t, 'first', api); await flush();
  const second = surface(t, 'second', api); await flush();
  assert.equal(calls, 3); assert.match(first.textContent, /150,000/); assert.match(second.textContent, /120,000/);
});

test('a response started before invalidation cannot restore old prices', async t => {
  let resolveOld, calls = 0;
  const api = async () => { calls++; return calls === 1 ? new Promise(resolve => { resolveOld = resolve; }) : { quote: quote(180000) }; };
  const container = surface(t, 'race', api); await flush();
  invalidatePrices('race'); resolveOld({ quote: quote(120000) }); await flush();
  assert.equal(calls, 2); assert.match(container.textContent, /180,000/); assert.doesNotMatch(container.textContent, /120,000/);
  assert.equal(container.firstElementChild.getAttribute('aria-busy'), 'false');
  surface(t, 'race', api); await flush(); assert.equal(calls, 2);
});

test('another visitor publication invalidates browser prices when the detail version advances', async t => {
  let calls = 0;
  const api = async () => ({ quote: quote(++calls * 100000) });
  surface(t, 'versioned', api, 0); await flush();
  const next = surface(t, 'versioned', api, 1); await flush();
  assert.equal(calls, 2); assert.match(next.textContent, /200,000/);
});
