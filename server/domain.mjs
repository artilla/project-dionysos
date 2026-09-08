export const kstToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()).replaceAll('-', '');
export function addDays(date, count) {
  const d = new Date(Date.UTC(+date.slice(0, 4), +date.slice(4, 6) - 1, +date.slice(6, 8) + count));
  return d.toISOString().slice(0, 10).replaceAll('-', '');
}
export const nextMonth = month => addDays(`${month}28`, 4).slice(0, 6);
export const monthDates = month => Array.from({ length: new Date(Date.UTC(+month.slice(0, 4), +month.slice(4, 6), 0)).getUTCDate() }, (_, i) => `${month}${String(i + 1).padStart(2, '0')}`);
export const numberOrNull = value => value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? null : Number(value);
export function normalizeDay(row, { lastDay, holidays = [], today = kstToday() }) {
  const date = String(row.useDt || '');
  if (!/^\d{8}$/.test(date)) return null;
  let state = 'unknown';
  if (date < today || row.rsrvtAvail === 'BEFORE_DATE') state = 'past';
  else if (date > lastDay || row.rsrvtAvail === 'OVER_DATE') state = 'unopened';
  else if (holidays.some(h => h.dt === date && h.dtCd === '01') || row.rsrvtAvail === 'PRNSL_DAY') state = 'closed';
  else if (row.rsrvtAvail === 'Y') {
    const count = numberOrNull(row.rsrvtCnt), wait = numberOrNull(row.wtngCnt), max = numberOrNull(row.goodsMxmmWtngCnt);
    if (count === 0) state = 'available';
    else if (count > 0) state = row.wtngPssblYn === 'Y' && Number.isInteger(wait) && wait >= 0 && Number.isInteger(max) && wait < max ? 'wait' : 'full';
  } else state = ({ PRIOR: 'priority', DRLTS: 'lottery', WEEKEND_DRLTS: 'lottery', REPAIR: 'closed' })[row.rsrvtAvail] || 'unknown';
  return { date, state, capacity: numberOrNull(row.mxmmAccptCnt), maxNights: numberOrNull(row.mxmmStngDayCnt) };
}
export function normalizeUnit(row, type) {
  return { id: String(row.goodsId), name: String(row.goodsNm || '이름 미확인'), type, capacity: numberOrNull(row.mxmmAccptCnt), maxNights: numberOrNull(row.mxmmStngDayCnt), category: String(row.goodsClsscNm || '') };
}
function matchesStay(unit, date, query, days) {
  if (date < (query.today || kstToday())) return false;
  if (unit.capacity === null || unit.capacity < query.guests) return false;
  const maximum = days[date]?.maxNights ?? unit.maxNights;
  if (query.nights > 1 && (!Number.isInteger(maximum) || maximum < query.nights)) return false;
  if (maximum > 0 && query.nights > maximum) return false;
  if (query.weekend && ![5, 6].includes(new Date(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T12:00:00+09:00`).getUTCDay())) return false;
  return true;
}
const fitsDailyCapacity = (inventory, guests) => inventory && (inventory.capacity === null || inventory.capacity === undefined || inventory.capacity >= guests);
export function availableFor(unit, date, query, days) {
  if (!matchesStay(unit, date, query, days)) return false;
  for (let n = 0; n < query.nights; n++) {
    const inventory = days[addDays(date, n)];
    if (inventory?.state !== 'available' || !fitsDailyCapacity(inventory, query.guests)) return false;
  }
  return true;
}
export function waitingFor(unit, date, query, days) {
  // Official monthly UI submits waiting applications with sthngCnt = 1.
  return query.includeWait === true && query.nights === 1 && matchesStay(unit, date, query, days) && days[date]?.state === 'wait' && !!fitsDailyCapacity(days[date], query.guests);
}
export function summarizeForest(forest, snapshots, query, detail = false) {
  const units = new Map(); const times = [];
  for (const snapshot of snapshots) {
    if (snapshot.forestId !== forest.id || ![query.month, nextMonth(query.month)].includes(snapshot.month) || (query.type !== 'all' && snapshot.type !== query.type)) continue;
    times.push(snapshot.observedAt);
    for (const u of snapshot.units) {
      const key = `${u.type}:${u.id}`;
      if (!units.has(key)) units.set(key, { ...u, days: {} });
      const target = units.get(key);
      Object.assign(target.days, snapshot.days[u.id] || {});
    }
  }
  const dates = {}, dateCounts = {};
  for (const date of monthDates(query.month)) {
    const possible = [...units.values()].filter(u => availableFor(u, date, query, u.days));
    const waiting = [...units.values()].filter(u => waitingFor(u, date, query, u.days));
    if (possible.length + waiting.length) {
      dateCounts[date] = { available: possible.length, wait: waiting.length };
      dates[date] = detail ? [ ...possible.map(({ days, ...u }) => ({ ...u, bookingState: 'available' })), ...waiting.map(({ days, ...u }) => ({ ...u, bookingState: 'wait' })) ] : possible.length + waiting.length;
    }
  }
  const observedAt = times.sort().at(0) || null;
  return { ...forest, dates, dateCounts, observedAt, unitCount: units.size, ...(detail ? { units: [...units.values()] } : {}) };
}
