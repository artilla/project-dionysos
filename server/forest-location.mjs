import { parseHTML } from 'linkedom';
import { SourceError } from './foresttrip.mjs';

const TTL = 30 * 24 * 60 * 60 * 1000;
const MAX_BYTES = 1024 * 1024;
const jobs = new WeakMap();
export const locationUrl = id => `https://www.foresttrip.go.kr/pot/fi/dr/selectDrctnsDtlView.do?${new URLSearchParams({ hmpgId: id, menuId: '002007' })}`;
const unavailable = () => new SourceError('LOCATION_UNAVAILABLE', '공식 위치 정보를 확인하지 못했습니다. 잠시 후 다시 시도해주세요.', 502);
export function parseForestLocation(html, id) {
  const match = html.match(/\bmapCenter\s*=\s*new\s+kakao\.maps\.LatLng\(\s*['"]?(-?\d+(?:\.\d+)?)['"]?\s*,\s*['"]?(-?\d+(?:\.\d+)?)['"]?\s*\)/);
  const lat = Number(match?.[1]), lng = Number(match?.[2]);
  if (!match || !Number.isFinite(lat) || !Number.isFinite(lng) || lat < 33 || lat > 39 || lng < 124 || lng > 132) throw unavailable();
  const doc = parseHTML(html).document;
  const addressNode = [...doc.querySelectorAll('.map_adress > div')].find(n => n.querySelector('h4')?.textContent.trim() === '주소');
  const address = (addressNode?.textContent || '').replace(/^\s*주소\s*/, '').split(/대표전화/)[0].replace(/\s*\/\s*$/, '').replace(/\s+/g, ' ').trim().slice(0, 300);
  return { id, lat, lng, address, sourceUrl: locationUrl(id) };
}
export async function forestLocation({ id, shared, transport = fetch }) {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw new SourceError('INVALID_INPUT', '휴양림을 다시 선택해주세요.', 400);
  const key = `forest-directions-v1:${id}`;
  const cached = await shared.cached('location', key);
  if (cached) return { location: cached.value, observedAt: cached.observedAt, cacheHit: true };
  if (!jobs.has(shared.db)) jobs.set(shared.db, new Map());
  const pending = jobs.get(shared.db);
  if (pending.has(id)) return pending.get(id);
  const task = (async () => {
    try {
      const response = await transport(locationUrl(id), { signal: AbortSignal.timeout(10000), redirect: 'error', credentials: 'omit', headers: { Accept: 'text/html' } });
      if (!response.ok || Number(response.headers.get('content-length')) > MAX_BYTES) { await response.body?.cancel(); throw unavailable(); }
      const reader = response.body.getReader(), decoder = new TextDecoder(); let html = '', bytes = 0;
      try { while (true) { const { done, value } = await reader.read(); if (done) break; bytes += value.byteLength; if (bytes > MAX_BYTES) { await reader.cancel(); throw unavailable(); } html += decoder.decode(value, { stream: true }); } html += decoder.decode(); }
      finally { reader.releaseLock(); }
      const location = parseForestLocation(html, id), createdAt = Date.now(), observedAt = new Date(createdAt).toISOString();
      await shared.cache({ kind: 'location', key, forestId: id, value: location, observedAt, createdAt, expiresAt: createdAt + TTL });
      return { location, observedAt, cacheHit: false };
    } catch (error) { if (error instanceof SourceError) throw error; throw unavailable(); }
    finally { pending.delete(id); }
  })();
  pending.set(id, task); return task;
}
