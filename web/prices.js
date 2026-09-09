import { esc } from './ui.js';

const cache = new Map();
const epochs = new Map(), versions = new Map();
let pending = Promise.resolve();
export function invalidatePrices(forestId) {
  epochs.set(forestId, (epochs.get(forestId) || 0) + 1);
  for (const key of cache.keys()) if (key.startsWith(`${forestId}:`)) cache.delete(key);
}
const won = amount => `${amount.toLocaleString('ko-KR')}원`;
const shortDate = date => `${Number(date.slice(4, 6))}.${Number(date.slice(6))}`;

export function priceMarkup(quote, guests) {
  const extra = quote.baseGuests !== null && guests > quote.baseGuests;
  const extraNote = extra && quote.extraGuestFeeApplies !== false
    ? `<p class="price-extra">기준 ${quote.baseGuests}명 초과 · 추가 인원 요금 별도${quote.extraPerGuestTotal !== null ? `<br>추가 1인 · ${quote.nights}박 ${won(quote.extraPerGuestTotal)} (연령·적용 조건 확인)` : ''}</p>` : '';
  const checked = new Date(quote.observedAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  return `<div class="price-total"><strong>${won(quote.baseTotal)}</strong><span>${quote.nights}박 기본요금${quote.baseGuests !== null ? ` · 기준 ${quote.baseGuests}명` : ''}</span></div>${extraNote}<details class="price-breakdown"><summary>날짜별 요금</summary><dl>${quote.daily.map(d => `<div><dt>${shortDate(d.date)} <span>${esc([d.season, d.dayType].filter(Boolean).join(' · '))}</span></dt><dd>${won(d.amount)}</dd></div>`).join('')}</dl><p>${esc(checked)} 요금 확인 · 추가인원·옵션·감면 별도</p></details>`;
}

// Fetch only rooms entering the viewport; changing dates discards queued old work.
export function observePrices(container, { forestId, date, nights, guests, api, priceVersion }) {
  if (Number.isInteger(priceVersion) && priceVersion > (versions.get(forestId) ?? -1)) {
    if (versions.has(forestId)) invalidatePrices(forestId);
    versions.set(forestId, priceVersion);
  }
  let active = true;
  const current = element => active && element.isConnected;
  function enqueue(element) {
    if (element.dataset.loading === 'true') return;
    element.dataset.loading = 'true'; element.setAttribute('aria-busy', 'true');
    element.innerHTML = '<span class="price-pending">요금 확인 중…</span>';
    const body = { unitId: element.dataset.priceUnit, type: element.dataset.priceType, date, nights };
    const key = [forestId, body.type, body.unitId, date, nights].join(':');
    pending = pending.catch(() => {}).then(async () => {
      if (!current(element)) return;
      const epoch = epochs.get(forestId) || 0;
      let rerun = false;
      try {
        let quote = cache.get(key);
        if (!quote || Date.now() - Date.parse(quote.observedAt) >= 15 * 60 * 1000) {
          for (let attempt = 0; ; attempt++) {
            try { quote = (await api(`/api/forests/${encodeURIComponent(forestId)}/price`, body)).quote; break; }
            catch (error) {
              if (error.code !== 'BUSY' || attempt >= 2) throw error;
              await new Promise(resolve => setTimeout(resolve, 600));
              if (!current(element)) return;
            }
          }
          if (epoch !== (epochs.get(forestId) || 0)) {
            rerun = true;
            return;
          }
          cache.set(key, quote);
        }
        if (current(element)) element.innerHTML = priceMarkup(quote, guests);
      } catch (error) {
        if (current(element)) element.innerHTML = `<span class="price-unavailable">${esc(error.message)}</span><button type="button" class="price-retry">요금 다시 확인</button>`;
      } finally {
        if (current(element)) { element.dataset.loading = 'false'; element.setAttribute('aria-busy', 'false'); }
        if (rerun && current(element)) enqueue(element);
      }
    });
  }
  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) if (entry.isIntersecting) { observer.unobserve(entry.target); enqueue(entry.target); }
  }, { rootMargin: '80px 0px' });
  container.querySelectorAll('[data-price-unit]').forEach(element => observer.observe(element));
  const retry = event => { const button = event.target.closest('.price-retry'); if (button) enqueue(button.closest('[data-price-unit]')); };
  container.addEventListener('click', retry);
  return () => { active = false; observer.disconnect(); container.removeEventListener('click', retry); };
}
