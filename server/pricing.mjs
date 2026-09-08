import { addDays } from './domain.mjs';

const money = value => (typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value))) && Number.isSafeInteger(Number(value)) && Number(value) >= 0 ? Number(value) : null;

// The official detail response quotes the whole facility, before personal discounts.
export function normalizePrice(data, { forestId, unitId, date, nights, type }) {
  if (!data || data.insttId !== forestId || data.goodsId !== unitId || data.rsrvtBgDt !== date || data.rsrvtEdDt !== addDays(date, nights) || Number(data.sthngQnt) !== nights || data.upperGoodsClsscCd !== ({ stay: '01', camp: '02' })[type] || data.cmpngDailyRsrvtYn === 'Y') return null;
  if (!Array.isArray(data.listGoodsUnprc) || data.listGoodsUnprc.length !== nights) return null;
  const daily = [];
  for (let n = 0; n < nights; n++) {
    const day = addDays(date, n), rows = data.listGoodsUnprc.filter(r => r?.rsrvtDate === day);
    if (rows.length !== 1 || money(rows[0].goodsUnprc) === null) return null;
    daily.push({ date: day, amount: money(rows[0].goodsUnprc), season: String(rows[0].ssnTpnm || ''), dayType: String(rows[0].dtTpnm || ''), extraPerGuest: money(rows[0].addNofprUnprc) });
  }
  const baseTotal = money(data.sumGoodsUnprc);
  if (baseTotal === null || daily.reduce((sum, d) => sum + d.amount, 0) !== baseTotal) return null;
  const baseGuests = money(data.mnmmAccptCnt);
  const extraGuestFeeApplies = type === 'camp' ? null : data.addtnNofpr === 'Y' ? true : data.addtnNofpr === 'N' ? false : null;
  return { forestId, unitId, type, date, checkout: addDays(date, nights), nights, currency: 'KRW', baseTotal, baseGuests: baseGuests > 0 ? baseGuests : null,
    extraGuestFeeApplies, extraPerGuestTotal: extraGuestFeeApplies === true && daily.every(d => d.extraPerGuest !== null) ? daily.reduce((sum, d) => sum + d.extraPerGuest, 0) : null,
    daily, observedAt: new Date().toISOString() };
}
