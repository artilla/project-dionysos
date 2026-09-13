import { SourceError } from './foresttrip.mjs';

const ENDPOINT = 'https://naverapihub.apigw.ntruss.com/search/v1/blog';
const RESPONSE_LIMIT = 512 * 1024;
const errors = {
  NAVER_CONFIG_REQUIRED: [503, '네이버 블로그 검색 설정이 필요합니다. 잠시 후 다시 시도해주세요.'],
  NAVER_AUTH_FAILED: [503, '네이버 블로그 검색 연결을 확인하지 못했습니다. 잠시 후 다시 시도해주세요.'],
  NAVER_RATE_LIMITED: [429, '네이버 블로그 검색 요청이 많습니다. 잠시 후 다시 시도해주세요.'],
  NAVER_UNAVAILABLE: [502, '네이버 블로그 검색에 연결하지 못했습니다. 잠시 후 다시 시도해주세요.'],
  NAVER_TIMEOUT: [504, '네이버 블로그 검색 응답 대기 시간이 초과됐습니다. 다시 시도해주세요.'],
  NAVER_INVALID_RESPONSE: [502, '네이버 블로그 검색 결과를 확인하지 못했습니다. 잠시 후 다시 시도해주세요.']
};
const failure = code => new SourceError(code, errors[code][1], errors[code][0]);
const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function validateQuery(input) {
  const { query, sort = 'sim', start = 1 } = plainObject(input) ? input : {};
  if (typeof query !== 'string' || !query.trim() || Array.from(query).length > 200
    || !['sim', 'date'].includes(sort) || !Number.isInteger(start) || start < 1 || start > 991 || (start - 1) % 10 !== 0) {
    throw new SourceError('INVALID_INPUT', '검색어와 검색 순서, 페이지를 다시 확인해주세요.', 400);
  }
  return { query, sort, start };
}

function validPostdate(value) {
  if (typeof value !== 'string' || !/^[1-9]\d{3}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])$/.test(value)) return false;
  const year = Number(value.slice(0, 4)), month = Number(value.slice(4, 6)), day = Number(value.slice(6));
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function validUrl(value) {
  if (typeof value !== 'string' || !value || value.trim() !== value || /[\u0000-\u0020\u007f]/.test(value)) return false;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !!url.hostname && !url.username && !url.password;
  } catch { return false; }
}

function validateResponse(value, requestedStart) {
  if (!plainObject(value) || typeof value.lastBuildDate !== 'string' || !Number.isFinite(Date.parse(value.lastBuildDate))
    || !Number.isSafeInteger(value.total) || value.total < 0
    || value.start !== requestedStart || !Number.isInteger(value.display) || value.display < 0 || value.display > 10
    || !Array.isArray(value.items) || value.items.length > 10 || value.items.length > value.display || value.items.length > value.total) {
    throw failure('NAVER_INVALID_RESPONSE');
  }
  const items = value.items.map(item => {
    if (!plainObject(item) || !['title', 'description', 'bloggername'].every(key => typeof item[key] === 'string')
      || !validUrl(item.link) || !validUrl(item.bloggerlink) || !validPostdate(item.postdate)) {
      throw failure('NAVER_INVALID_RESPONSE');
    }
    return { title: item.title, link: item.link, description: item.description, bloggername: item.bloggername, bloggerlink: item.bloggerlink, postdate: item.postdate };
  });
  return { lastBuildDate: value.lastBuildDate, total: value.total, start: value.start, display: value.display, items };
}

async function readBody(response, signal) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > RESPONSE_LIMIT) {
    await response.body?.cancel();
    throw failure('NAVER_INVALID_RESPONSE');
  }
  if (!response.body) throw failure('NAVER_INVALID_RESPONSE');
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
      if (size > RESPONSE_LIMIT) { await reader.cancel(); throw failure('NAVER_INVALID_RESPONSE'); }
      chunks.push(value);
    }
  } finally { signal.removeEventListener('abort', abort); reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw failure('NAVER_INVALID_RESPONSE'); }
}

export class NaverBlogSource {
  constructor({ clientId, clientSecret, transport = (...args) => fetch(...args) } = {}) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.transport = transport;
  }

  async search(input) {
    const { query, sort, start } = validateQuery(input);
    if (![this.clientId, this.clientSecret].every(value => typeof value === 'string' && value.trim() && !/[\u0000-\u001f\u007f]/.test(value))) {
      throw failure('NAVER_CONFIG_REQUIRED');
    }
    const signal = AbortSignal.timeout(8000);
    const url = `${ENDPOINT}?${new URLSearchParams({ query, display: '10', start: String(start), sort, format: 'json' })}`;
    try {
      const response = await this.transport(url, {
        method: 'GET', cache: 'no-store', credentials: 'omit', redirect: 'error', signal,
        headers: { Accept: 'application/json', 'X-NCP-APIGW-API-KEY-ID': this.clientId, 'X-NCP-APIGW-API-KEY': this.clientSecret }
      });
      if (!response.ok) {
        await response.body?.cancel();
        if ([401, 403].includes(response.status)) throw failure('NAVER_AUTH_FAILED');
        if (response.status === 429) throw failure('NAVER_RATE_LIMITED');
        throw failure('NAVER_UNAVAILABLE');
      }
      const result = await readBody(response, signal);
      return validateResponse(result, start);
    } catch (error) {
      if (signal.aborted || ['TimeoutError', 'AbortError'].includes(error?.name)) throw failure('NAVER_TIMEOUT');
      if (error instanceof SourceError && Object.hasOwn(errors, error.code)) throw failure(error.code);
      throw failure('NAVER_UNAVAILABLE');
    }
  }
}
