import { parseHTML } from 'linkedom';
import { SourceError } from './foresttrip.mjs';

const BASE = 'https://www.foresttrip.go.kr';
const IMAGE_BASE = 'https://image.foresttrip.go.kr';
const DETAIL_PATH = '/pot/rm/fa/selectFcltsArmpDtlView.do';
const DETAIL_HOSTS = new Set(['www.foresttrip.go.kr', 'foresttrip.go.kr']);
const DETAIL_LIMIT = 1024 * 1024, IMAGE_LIMIT = 8 * 1024 * 1024;
const changed = message => new SourceError('SOURCE_CHANGED', message || '시설 안내 응답을 확인하지 못했습니다. 숲나들e에서 확인해주세요.');
const blockedElements = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT', 'IFRAME', 'OBJECT', 'FORM', 'INPUT', 'BUTTON']);
const blockElements = new Set(['P', 'DIV', 'LI', 'UL', 'OL', 'SECTION', 'ARTICLE', 'TR', 'PRE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6']);

function allowedUrl(value, kind) {
  let url;
  try { url = new URL(value); } catch { throw changed('시설 자료의 주소를 확인하지 못했습니다.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) throw changed('허용되지 않은 시설 자료 주소입니다.');
  if (kind === 'detail' ? !DETAIL_HOSTS.has(url.hostname) || url.pathname !== DETAIL_PATH
    : url.hostname !== 'image.foresttrip.go.kr' || !/^\/ino\/(?:instt|goods)\/[^/]+$/.test(url.pathname) || /(?:no[_-]?img|no[_-]?image)/i.test(url.pathname)) {
    throw changed('허용되지 않은 시설 자료 주소입니다.');
  }
  url.hash = '';
  return url.href;
}

// Walk text only. The source sometimes nests <p> inside <p class="wd_txt">,
// leaving wd_txt empty after HTML parsing; callers therefore pass its whole tab.
function lines(root, skipHeading = false) {
  if (!root) return [];
  const output = [], stack = [{ node: root, preserve: false }];
  while (stack.length) {
    const entry = stack.pop();
    if (entry.break) { output.push('\n'); continue; }
    const { node } = entry;
    if (node.nodeType === 3) {
      output.push(entry.preserve ? node.textContent.replace(/\r\n?/g, '\n') : node.textContent.replace(/\s+/g, ' '));
      continue;
    }
    if (node.nodeType !== 1) continue;
    const tag = node.tagName;
    if (blockedElements.has(tag) || (skipHeading && /^H[1-6]$/.test(tag) && node.textContent.trim() === '이용안내')) continue;
    if (tag === 'BR') { output.push('\n'); continue; }
    const block = blockElements.has(tag);
    if (block) { output.push('\n'); stack.push({ break: true }); }
    const preserve = entry.preserve || tag === 'PRE' || /white-space\s*:\s*(?:pre(?:-wrap|-line)?|break-spaces)/i.test(node.getAttribute('style') || '');
    for (let i = node.childNodes.length - 1; i >= 0; i--) stack.push({ node: node.childNodes[i], preserve });
  }
  return output.join('').split('\n').map(line => line.replace(/[\s\u00a0]+/g, ' ').trim()).filter(Boolean);
}

function parseDetail(html, query, sourceUrl) {
  const { document } = parseHTML(html);
  const tabs = [...document.querySelectorAll('#tab_con > .con_item')];
  const title = lines(document.querySelector('.head_title')).join(' ');
  const table = tabs[0]?.querySelector('table');
  if (!title || !table || tabs.length < 2) throw changed();
  const facts = [...table.querySelectorAll('tr')].flatMap(row => {
    const label = lines(row.querySelector('th')).join(' '), value = lines(row.querySelector('td')).join('\n');
    return label && value && !/요금|가격/.test(label) ? [{ label, value }] : [];
  });
  if (!facts.length) throw changed();
  const guide = lines(tabs.find(tab => tab.querySelector('.wd_txt')) || tabs[1], true);
  const images = [], seen = new Set();
  for (const [id, kind, fallback] of [['1', 'photo', '시설 사진'], ['2', 'map', '배치도'], ['3', 'floorplan', '평면도']]) {
    const wrap = document.querySelector(`#photo_wrap_${id}`);
    const list = wrap?.querySelector('.photo_list') || wrap?.querySelector('.photo_view');
    for (const img of list?.querySelectorAll('img') || []) {
      let imageUrl;
      const raw = img.closest('a')?.getAttribute('href') || img.getAttribute('src');
      if (!raw || /no[_-]?(?:img|image)/i.test(raw)) continue;
      try { imageUrl = allowedUrl(new URL(raw, IMAGE_BASE).href, 'image'); } catch { continue; }
      const key = `${kind}:${imageUrl}`;
      if (seen.has(key)) continue;
      seen.add(key);
      images.push({ kind, label: (img.getAttribute('alt') || fallback).replace(/\s+/g, ' ').trim(), sourceUrl: imageUrl });
    }
  }
  return { ...query, title, sourceUrl, facts, guide, images };
}

async function boundedBytes(response, limit, signal) {
  const advertised = Number(response.headers.get('content-length'));
  if (Number.isFinite(advertised) && advertised > limit) {
    await response.body?.cancel();
    throw changed('시설 자료가 너무 커서 저장하지 못했습니다.');
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader(), chunks = [];
  let size = 0;
  const abort = () => { reader.cancel(signal.reason).catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    signal.throwIfAborted();
    while (true) {
      const { value, done } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw changed('시설 자료가 너무 커서 저장하지 못했습니다.'); }
      chunks.push(value);
    }
  } finally { signal.removeEventListener('abort', abort); reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

function imageType(bytes) {
  const starts = signature => signature.every((n, i) => bytes[i] === n);
  if (bytes.length >= 3 && starts([0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (bytes.length >= 8 && starts([137, 80, 78, 71, 13, 10, 26, 10])) return 'image/png';
  const ascii = (start, end) => String.fromCharCode(...bytes.subarray(start, end));
  if (bytes.length >= 6 && ['GIF87a', 'GIF89a'].includes(ascii(0, 6))) return 'image/gif';
  if (bytes.length >= 16 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP' && ['VP8 ', 'VP8L', 'VP8X'].includes(ascii(12, 16))) return 'image/webp';
  throw changed('지원하는 시설 이미지 형식이 아닙니다.');
}

function networkError(error) {
  if (error instanceof SourceError) return error;
  return new SourceError('NETWORK', ['TimeoutError', 'AbortError'].includes(error?.name)
    ? '숲나들e 시설 자료 응답 대기 시간이 초과됐습니다. 잠시 후 다시 시도해주세요.'
    : '숲나들e 시설 자료에 연결하지 못했습니다. 잠시 후 다시 시도해주세요.');
}

export class FacilitySource {
  constructor(transport = (...args) => fetch(...args)) { this.transport = transport; }

  async request(value, kind, headers = {}) {
    const signal = AbortSignal.timeout(25000);
    let url = allowedUrl(value, kind);
    for (let redirects = 0; redirects < 6; redirects++) {
      const response = await this.transport(url, { method: 'GET', credentials: 'omit', redirect: 'manual', signal, headers: { Accept: kind === 'image' ? 'image/jpeg,image/png,image/webp,image/gif' : 'text/html', ...headers } });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (!location) throw changed();
        url = allowedUrl(new URL(location, url).href, kind);
        continue;
      }
      if (response.status === 304 && kind === 'image' && (headers['If-None-Match'] || headers['If-Modified-Since'])) return { response, signal, url };
      if (!response.ok) {
        await response.body?.cancel();
        if ([403, 429].includes(response.status)) throw new SourceError('ACCESS_LIMIT', '숲나들e에서 시설 자료 조회를 제한했습니다. 잠시 후 공식 사이트를 확인해주세요.', 429);
        if (response.status === 404) throw new SourceError('FACILITY_NOT_FOUND', '시설 자료를 찾을 수 없습니다. 숲나들e에서 확인해주세요.', 404);
        if (response.status === 401) throw new SourceError('AUTH_REQUIRED', '시설 자료를 공개 화면에서 확인하지 못했습니다. 숲나들e에서 확인해주세요.', 401);
        throw new SourceError('NETWORK', '숲나들e 시설 자료 조회에 실패했습니다. 잠시 후 다시 시도해주세요.');
      }
      return { response, signal, url };
    }
    throw changed('시설 자료의 이동 주소를 확인하지 못했습니다.');
  }

  async detail({ forestId, unitId, type }) {
    if (![forestId, unitId].every(id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(id)) || !['stay', 'camp'].includes(type)) {
      throw new SourceError('INVALID_INPUT', '시설 자료를 확인할 시설을 다시 선택해주세요.', 400);
    }
    const sourceUrl = `${BASE}${DETAIL_PATH}?${new URLSearchParams({ insttId: forestId, goodsId: unitId })}`;
    try {
      const { response, signal, url } = await this.request(sourceUrl, 'detail');
      const contentType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
      if (contentType && !['text/html', 'application/xhtml+xml'].includes(contentType)) { await response.body?.cancel(); throw changed(); }
      const bytes = await boundedBytes(response, DETAIL_LIMIT, signal);
      return parseDetail(new TextDecoder().decode(bytes), { forestId, unitId, type }, url);
    } catch (error) { throw networkError(error); }
  }

  async image(url, { etag, lastModified } = {}) {
    try {
      const headers = {};
      if (typeof etag === 'string' && etag.length <= 512 && !/[\r\n]/.test(etag)) headers['If-None-Match'] = etag;
      if (typeof lastModified === 'string' && lastModified.length <= 128 && !/[\r\n]/.test(lastModified)) headers['If-Modified-Since'] = lastModified;
      const { response, signal } = await this.request(url, 'image', headers);
      if (response.status === 304) return { notModified: true };
      const bytes = await boundedBytes(response, IMAGE_LIMIT, signal), contentType = imageType(bytes);
      const declared = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
      if (declared && declared !== 'application/octet-stream' && declared !== contentType) throw changed('시설 이미지의 파일 형식을 확인하지 못했습니다.');
      return { bytes, contentType, etag: response.headers.get('etag'), lastModified: response.headers.get('last-modified') };
    } catch (error) { throw networkError(error); }
  }
}
