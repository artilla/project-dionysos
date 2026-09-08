import { parseHTML } from 'linkedom';
import { CookieJar } from 'tough-cookie';
import { normalizePrice } from './pricing.mjs';

export const BASE = 'https://www.foresttrip.go.kr';
export const MONTH_URL = `${BASE}/rep/or/sssn/monthRsrvtSmplStatus.do`;
const QUEUE_URL = 'https://nf.foresttrip.go.kr/ts.wseq';
const HOSTS = new Set(['www.foresttrip.go.kr', 'foresttrip.go.kr', 'nf.foresttrip.go.kr']);
export class SourceError extends Error {
  constructor(code, message, status = 502) { super(message); this.code = code; this.status = status; }
}
export function parseQueue(text, expected) {
  const match = text.match(/result\s*=\s*['"]([^'"]*)['"]/);
  const parts = match?.[1].match(/^(\d+):(\d+):(.*)$/);
  if (!parts || !expected.includes(parts[1])) throw new SourceError('SOURCE_CHANGED', '대기열 응답을 확인할 수 없습니다. 잠시 후 다시 연결해주세요.');
  const data = Object.fromEntries(new URLSearchParams(parts[3]));
  const code = Number(parts[2]);
  if (code !== 200 && code !== 201 && code !== 202) throw new SourceError('ACCESS_LIMIT', '원천 대기열에서 조회를 허용하지 않았습니다. 공식 사이트를 확인해주세요.', 429);
  if (parts[1] !== '5004' && !data.key) throw new SourceError('SOURCE_CHANGED', '대기열 인증 정보가 누락되어 조회를 멈췄습니다.');
  const ttl = Number(data.ttl);
  if (code !== 200 && (!Number.isFinite(ttl) || ttl <= 0)) throw new SourceError('SOURCE_CHANGED', '대기 시간을 확인할 수 없어 조회를 멈췄습니다.');
  return { raw: match[1], key: data.key, granted: code === 200, waitUntil: Date.now() + (code === 200 ? 0 : ttl * 1000) };
}
function escapeCookie(value) {
  return [...value].map(c => /[A-Za-z0-9@*_+./-]/.test(c) ? c : c.charCodeAt(0) < 256 ? `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}` : `%u${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`).join('');
}
export class Foresttrip {
  constructor(state, transport = (...args) => fetch(...args)) {
    this.jar = state?.cookies ? CookieJar.deserializeSync(state.cookies) : new CookieJar();
    this.csrf = state?.csrf || '';
    this.catalog = state?.catalog || null;
    this.connectedAt = state?.connectedAt || null;
    this.transport = transport;
  }
  export() { return { cookies: this.jar.serializeSync(), csrf: this.csrf, catalog: this.catalog, connectedAt: this.connectedAt }; }
  async request(url, { method = 'GET', body, headers = {} } = {}) {
    for (let redirects = 0; redirects < 6; redirects++) {
      const target = new URL(url);
      if (target.protocol !== 'https:' || !HOSTS.has(target.hostname)) throw new SourceError('SOURCE_CHANGED', '예상하지 못한 주소로 이동하여 조회를 멈췄습니다.');
      const cookie = this.jar.getCookieStringSync(url);
      let response;
      try {
        response = await this.transport(url, { method, body, redirect: 'manual', signal: AbortSignal.timeout(25000), headers: { Referer: MONTH_URL, ...headers, ...(cookie ? { Cookie: cookie } : {}) } });
      } catch (error) {
        if (/Illegal invocation|incorrect.*this/i.test(error?.message || '')) {
          throw new SourceError('SOURCE_REQUEST_ERROR', '서버에서 숲나들e 연결 요청을 처리하지 못했습니다.', 500);
        }
        const timedOut = ['TimeoutError', 'AbortError'].includes(error?.name);
        throw new SourceError('NETWORK', timedOut ? '숲나들e 응답 대기 시간이 초과됐습니다. 잠시 후 다시 시도해주세요.' : '숲나들e에 연결하지 못했습니다. 잠시 후 다시 시도해주세요.');
      }
      for (const item of response.headers.getSetCookie()) this.jar.setCookieSync(item, url, { ignoreError: true });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        url = new URL(response.headers.get('location'), url).href;
        if ([301, 302, 303].includes(response.status)) { method = 'GET'; body = undefined; }
        await response.body?.cancel();
        continue;
      }
      if ([403, 429].includes(response.status)) throw new SourceError('ACCESS_LIMIT', '숲나들e에서 조회를 제한했습니다. 잠시 후 공식 사이트를 확인해주세요.', 429);
      return response;
    }
    throw new SourceError('AUTH_REQUIRED', '로그인 상태를 확인할 수 없습니다. 다시 연결해주세요.', 401);
  }
  async login(id, password) {
    if (!id || !password) throw new SourceError('CONFIG_REQUIRED', '서버에 숲나들e 계정 설정이 필요합니다.', 503);
    const entry = await this.request(MONTH_URL);
    let html = await entry.text();
    let { document } = parseHTML(html);
    const form = document.querySelector('#fripPotForm');
    if (form) {
      const fields = new URLSearchParams();
      for (const input of form.querySelectorAll('input[type="hidden"][name]')) fields.set(input.name, input.getAttribute('value') || '');
      fields.set('loginId', id); fields.set('loginPwd', password);
      const action = new URL(form.getAttribute('action'), BASE).href;
      if (action !== `${BASE}/com/login`) throw new SourceError('SOURCE_CHANGED', '로그인 방식이 변경되었습니다. 공식 사이트를 확인해주세요.');
      const response = await this.request(action, { method: 'POST', body: fields.toString(), headers: { Origin: BASE, 'Content-Type': 'application/x-www-form-urlencoded' } });
      html = await response.text(); document = parseHTML(html).document;
      if (document.querySelector('#fripPotForm')) throw new SourceError('AUTH_REQUIRED', 'ID와 비밀번호를 확인해주세요. 추가 인증이 필요한 경우 숲나들e 공식 사이트에서 먼저 확인해주세요.', 401);
    }
    if (!document.querySelector('#monthSelectBox')) {
      const response = await this.request(MONTH_URL);
      html = await response.text(); document = parseHTML(html).document;
    }
    this.csrf = document.querySelector('input[name="_csrf"]')?.getAttribute('value') || document.querySelector('meta[name="_csrf"]')?.getAttribute('content');
    let months = [...document.querySelectorAll('#monthSelectBox option')].map(o => ({ id: o.getAttribute('value'), name: o.textContent.trim() })).filter(o => /^\d{6}$/.test(o.id));
    const today = html.match(/monthRsrvtStatus\.today\s*=\s*['"](\d{8})['"]/)?.[1];
    const monthCount = [...html.matchAll(/\$\(['"]#monthSelectBox['"]\)\.append\(/g)].length;
    // The official page builds these options in JavaScript from its server date.
    if (!months.length && today && monthCount > 0 && monthCount <= 12) {
      months = Array.from({ length: monthCount }, (_, n) => {
        const date = new Date(Date.UTC(+today.slice(0, 4), +today.slice(4, 6) - 1 + n, 1));
        return { id: date.toISOString().slice(0, 7).replace('-', ''), name: `${date.getUTCFullYear()}년 ${date.getUTCMonth() + 1}월` };
      });
    }
    const regionSelect = [...document.querySelectorAll('select')].find(s => /sido/i.test(s.id || s.getAttribute('name') || ''));
    const regions = [...(regionSelect?.querySelectorAll('option') || [])].map(o => ({ id: o.getAttribute('value'), name: o.textContent.trim() })).filter(o => o.id && !/선택|전체/.test(o.name));
    if (!this.csrf || !months.length || !regions.length) throw new SourceError('SOURCE_CHANGED', '월별 조회 정보를 읽지 못했습니다. 공식 사이트의 조회 화면을 확인해주세요.');
    this.catalog = { months, regions, today }; this.connectedAt = new Date().toISOString();
    return this.catalog;
  }
  async json(path, payload, extra = {}) {
    if (!this.csrf) throw new SourceError('AUTH_REQUIRED', '숲나들e를 먼저 연결해주세요.', 401);
    const response = await this.request(`${BASE}${path}`, { method: 'POST', body: JSON.stringify(payload), headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-CSRF-TOKEN': this.csrf, 'X-Requested-With': 'XMLHttpRequest', Origin: BASE, ...extra } });
    const text = await response.text();
    if (response.status === 401 || /fripPotForm|loginPwd/.test(text)) throw new SourceError('AUTH_REQUIRED', '숲나들e 연결이 만료됐습니다. 다시 연결 후 이어서 조회해주세요.', 401);
    if (!response.ok) throw new SourceError('NETWORK', '숲나들e 조회에 실패했습니다. 해당 범위를 다시 시도해주세요.');
    try { return JSON.parse(text); } catch { throw new SourceError('SOURCE_CHANGED', '예상하지 못한 조회 응답입니다. 이 범위는 확인 필요로 남겼습니다.'); }
  }
  async forests(region) {
    const rows = await this.json('/rep/or/selectInsttListForMonthRsrvt.do', { srchSido: region.id });
    if (!Array.isArray(rows) || rows.some(r => !r.insttId || typeof r.insttNm !== 'string')) throw new SourceError('SOURCE_CHANGED', '휴양림 목록을 읽을 수 없습니다.');
    return rows.map(r => ({ id: String(r.insttId), name: r.insttNm.replace(/^\[[^\]]+\]\s*/, '').replace(/^\([^)]*\)\s*/, ''), city: r.insttNm.match(/\(([^)]+)\)/)?.[1] || '', operator: r.insttNm.match(/\[([^\]]+)\]/)?.[1] || '', regionId: region.id, region: region.name }));
  }
  async policy(forestId) {
    const data = await this.json('/rep/or/selectSthngListForMonthRsrvt.do', { insttId: forestId });
    const policy = data?.rsrvtPolcy;
    const types = data?.sthngList;
    if (!policy || !Array.isArray(types)) throw new SourceError('SOURCE_CHANGED', '숙박시설 정보를 읽지 못했습니다.');
    let lastDay = String(policy.rsrvtCycleTpeCd === 'WEEK' ? policy.weekLastDay : policy.monthLastDay);
    if (data.gnrlRsrvtTrnseDtm && String(data.gnrlRsrvtTrnseDtm) > lastDay) lastDay = String(data.gnrlRsrvtTrnseDtm);
    if (!/^\d{8}$/.test(lastDay)) throw new SourceError('SOURCE_CHANGED', '예약 가능 기간을 확인할 수 없습니다.');
    return { types, lastDay };
  }
  async queue(previous) {
    if (previous?.waitUntil > Date.now()) return previous;
    const opcode = previous ? '5002' : '5101';
    const params = new URLSearchParams({ opcode, nfid: '0', prefix: `NetFunnel.gRtype=${opcode};`, sid: 'service_1', aid: 'action8', js: 'yes' });
    if (previous) { params.set('key', previous.key); params.set('ttl', String(previous.ttl || 1)); }
    const response = await this.request(`${QUEUE_URL}?${params}&${Date.now()}`);
    const result = parseQueue(await response.text(), [opcode, '5002']);
    return { ...result, ttl: Math.max(1, Math.ceil((result.waitUntil - Date.now()) / 1000)) };
  }
  async completeQueue(queue) {
    const params = new URLSearchParams({ opcode: '5004', key: queue.key, nfid: '0', prefix: 'NetFunnel.gRtype=5004;', js: 'yes' });
    const response = await this.request(`${QUEUE_URL}?${params}&${Date.now()}`);
    parseQueue(await response.text(), ['5004']);
    this.jar.setCookieSync('NetFunnel_ID=; Max-Age=0; Path=/; Secure', BASE);
  }
  async goods(scope, queue) {
    if (!queue.granted) throw new SourceError('QUEUE_WAIT', '순서를 기다리는 중입니다.');
    this.jar.setCookieSync(`NetFunnel_ID=${escapeCookie(queue.raw)}; Max-Age=600; Path=/; Secure`, BASE);
    const result = await this.json('/rep/or/sssn/selectRsrvtGoodsListForMonthRsrvtSmpl.do', { ...scope, goodsClsscCd: '', netfunnelKey: queue.key }, { 'X-Ajax-call': 'true' });
    if (result.netfunnelRslt !== 'Y' || !Array.isArray(result.rsrvtGoodsList)) throw new SourceError('ACCESS_LIMIT', '대기열 인증이 만료됐습니다. 이 범위를 다시 조회해주세요.', 429);
    return result;
  }
  async days(scope, ids) {
    if (!ids.length || ids.length > 5) throw new Error('Invalid goods batch');
    const result = await this.json('/rep/or/selectRsrvtAvailInfoListForMonthRsrvtSmpl.do', { ...scope, goodsIdList: ids });
    if (!Array.isArray(result) || result.some(r => !ids.includes(r.goodsId))) throw new SourceError('SOURCE_CHANGED', '날짜별 응답 범위를 확인할 수 없습니다.');
    return result;
  }
  async price(query) {
    const data = await this.json('/rep/or/innerFcfsRsrvtPssblGoodsDtlSmpl.do', {
      srchInsttId: query.forestId, srchGoodsId: query.unitId, srchRsrvtBgDt: query.date, srchSthngCnt: String(query.nights)
    }, { 'X-Ajax-call': 'true' });
    const quote = normalizePrice(data, query);
    if (!quote) throw new SourceError('PRICE_UNAVAILABLE', '선택한 숙박기간의 요금을 확인하지 못했습니다. 숲나들e에서 확인해주세요.');
    return quote;
  }
}
