import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePrice } from '../server/pricing.mjs';
import { parseHTML } from 'linkedom';
globalThis.document = parseHTML('<html><body></body></html>').document;
const { priceMarkup } = await import('../web/prices.js');
delete globalThis.document;

const query = { forestId: 'f1', unitId: 'u1', type: 'stay', date: '20260930', nights: 2 };
const source = () => ({ insttId: 'f1', goodsId: 'u1', upperGoodsClsscCd: '01', rsrvtBgDt: '20260930', rsrvtEdDt: '20261002', sthngQnt: 2, mnmmAccptCnt: 4, mxmmAccptCnt: 6, addtnNofpr: 'Y', sumGoodsUnprc: 320000,
  listGoodsUnprc: [{ rsrvtDate: '20260930', goodsUnprc: 140000, addNofprUnprc: '10000', ssnTpnm: '비수기', dtTpnm: '평일' }, { rsrvtDate: '20261001', goodsUnprc: 180000, addNofprUnprc: '15000', ssnTpnm: '비수기', dtTpnm: '주말' }], privateUser: 'do-not-return' });

test('price sums actual nightly rates across months and keeps extra guest charges separate', () => {
  const quote = normalizePrice(source(), query);
  assert.equal(quote.baseTotal, 320000); assert.equal(quote.baseGuests, 4); assert.equal(quote.extraPerGuestTotal, 25000);
  assert.deepEqual(quote.daily.map(d => d.date), ['20260930', '20261001']); assert.equal(quote.checkout, '20261002');
  assert.ok(!JSON.stringify(quote).includes('do-not-return'));
  const markup = priceMarkup(quote, 6);
  assert.ok(markup.includes('320,000원')); assert.ok(markup.includes('2박 기본요금 · 기준 4명')); assert.ok(markup.includes('추가 1인 · 2박 25,000원'));
  assert.ok(!priceMarkup(quote, 4).includes('기준 4명 초과'));
  assert.ok(priceMarkup({ ...quote, observedAt: '2026-09-08T16:00:00Z' }, 4).includes('9. 9. 오전 01:00'));
});
test('wrong unit, range, total, missing night and duplicate day never produce a quote', () => {
  for (const patch of [{ goodsId: 'other' }, { insttId: 'other' }, { upperGoodsClsscCd: '02' }, { rsrvtBgDt: '20260929' }, { rsrvtEdDt: '20261003' }, { sthngQnt: 1 }, { cmpngDailyRsrvtYn: 'Y' }, { sumGoodsUnprc: 140000 }]) assert.equal(normalizePrice({ ...source(), ...patch }, query), null);
  for (const rows of [source().listGoodsUnprc.slice(0, 1), [null, null], [source().listGoodsUnprc[0], source().listGoodsUnprc[0]]]) assert.equal(normalizePrice({ ...source(), listGoodsUnprc: rows }, query), null);
});
test('unconfirmed amounts stay unknown; confirmed zero is retained and text is escaped', () => {
  for (const amount of [null, undefined, '', ' ', false, -1, '140,000', 'oops', 1.5, Infinity]) {
    const data = source(); data.listGoodsUnprc[0].goodsUnprc = amount; assert.equal(normalizePrice(data, query), null);
  }
  const data = source(); data.listGoodsUnprc.forEach(d => { d.goodsUnprc = 0; d.addNofprUnprc = null; d.ssnTpnm = '<img onerror=alert(1)>'; }); data.sumGoodsUnprc = 0;
  const quote = normalizePrice(data, query); assert.equal(quote.baseTotal, 0); assert.equal(quote.extraPerGuestTotal, null);
  const html = priceMarkup(quote, 6); assert.ok(html.includes('0원')); assert.ok(!html.includes('<img'));
});
