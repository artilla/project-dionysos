const $ = name => document.querySelector(`[data-naver-${name}]`);
const forestId = new URLSearchParams(location.search).get('forestId') || '';
let state = { forest: null, query: '', sort: 'sim', start: 1, display: 10, total: 0, items: [], lastBuildDate: null };
let controller = null, requestTimer = null, requestVersion = 0, loading = false, pageHidden = false, closed = false;
let expiryTimer = null, resultsExpireAt = 0;
const maximumDisplayTime = 24 * 60 * 60 * 1000;

function decodeEntities(value) {
  const field = document.createElement('span');
  // Escape every opening angle bracket before decoding entities into text.
  field.innerHTML = String(value ?? '').replaceAll('<', '&lt;');
  return field.textContent;
}

function appendHighlighted(target, value) {
  let parent = target;
  for (const part of String(value ?? '').split(/(<\/?b\s*>)/gi)) {
    if (/^<b\s*>$/i.test(part)) { const bold = document.createElement('b'); parent.append(bold); parent = bold; }
    else if (/^<\/b\s*>$/i.test(part)) { if (parent !== target) parent = parent.parentNode; }
    else parent.append(document.createTextNode(decodeEntities(part)));
  }
}

function safeLink(value) {
  if (typeof value !== 'string' || !value) return null;
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) ? value : null; }
  catch { return null; }
}

function externalLink(href) {
  const link = document.createElement('a');
  link.setAttribute('href', href);
  link.target = '_blank'; link.rel = 'noopener noreferrer';
  return link;
}

function setStatus(kind, message) {
  $('status').dataset.state = kind;
  $('status').textContent = message;
}

function clearResults() {
  clearTimeout(expiryTimer); expiryTimer = null; resultsExpireAt = 0;
  state.items = []; state.total = 0; state.lastBuildDate = null;
  $('results').replaceChildren(); $('results').removeAttribute('aria-busy');
  $('count').textContent = ''; $('count').hidden = true;
  $('page').textContent = ''; $('pagination').hidden = true;
  $('bottom-source').hidden = true;
}

function clearPage() {
  requestVersion++; controller?.abort(); controller = null; loading = false;
  clearTimeout(requestTimer); requestTimer = null;
  clearResults();
  state = { forest: null, query: '', sort: 'sim', start: 1, display: 10, total: 0, items: [], lastBuildDate: null };
  $('title').textContent = '네이버 블로그 후기'; document.title = '네이버 블로그 후기';
  $('query').textContent = ''; $('query').hidden = true;
  for (const name of ['external', 'bottom-source']) $(name).href = 'https://search.naver.com/?where=blog';
  $('external').hidden = true; $('return').hidden = true; $('recovery').hidden = true;
  $('status').textContent = ''; $('status').removeAttribute('data-state');
  $('sort').value = 'sim'; $('sort').disabled = false; $('reload').disabled = false;
}

function updateIdentity(value) {
  if (value?.forest?.name && value.forest.id === forestId) state.forest = { id: value.forest.id, name: String(value.forest.name) };
  if (state.forest) {
    state.query = typeof value.query === 'string' && value.query ? value.query : `${state.forest.name} 후기`;
    $('title').textContent = `${state.forest.name} 후기`;
    document.title = `${state.forest.name} 후기 · 네이버 블로그 검색`;
    $('query').textContent = `검색어: ${state.query}`; $('query').hidden = false;
  }
  if (!state.query) return;
  const href = `https://search.naver.com/?${new URLSearchParams({ where: 'blog', query: state.query })}`;
  for (const name of ['external', 'bottom-source']) $(name).setAttribute('href', href);
}

function setLoading() {
  loading = true; $('sort').disabled = true; $('reload').disabled = true;
  $('recovery').hidden = true; $('return').hidden = true;
  $('results').setAttribute('aria-busy', 'true');
  setStatus('loading', '네이버 블로그 검색 결과를 불러오고 있어요.');
}

function expireResults() {
  if (!resultsExpireAt || Date.now() < resultsExpireAt) return;
  clearResults();
  setStatus('expired', '검색 결과 표시 시간이 지났어요. 다시 조회하면 네이버의 현재 결과를 볼 수 있어요.');
  $('recovery').hidden = false; $('retry').hidden = false; $('retry').textContent = '다시 조회';
  $('external').hidden = !state.query; $('return').hidden = true;
}

function renderResults() {
  resultsExpireAt = Date.now() + maximumDisplayTime;
  expiryTimer = setTimeout(expireResults, maximumDisplayTime);
  const fragment = document.createDocumentFragment();
  // Keep the API's order and complete field contents; no local ranking or trimming.
  for (const item of state.items) {
    const row = document.createElement('li'); row.className = 'review-item'; row.setAttribute('data-naver-item', '');
    const heading = document.createElement('h2'); heading.setAttribute('data-naver-item-title', '');
    const href = safeLink(item.link), title = href ? externalLink(href) : document.createElement('span');
    appendHighlighted(title, item.title); heading.append(title); row.append(heading);
    const description = document.createElement('p'); description.className = 'review-description'; description.setAttribute('data-naver-description', '');
    appendHighlighted(description, item.description); row.append(description);
    const meta = document.createElement('div'); meta.className = 'review-meta';
    const blogger = document.createElement('span'); blogger.className = 'review-blogger'; blogger.setAttribute('data-naver-blogger', '');
    const bloggerHref = safeLink(item.bloggerlink), bloggerName = bloggerHref ? externalLink(bloggerHref) : document.createElement('span');
    appendHighlighted(bloggerName, item.bloggername); blogger.append(bloggerName); meta.append(blogger);
    const date = document.createElement('span'); date.className = 'review-date'; date.setAttribute('data-naver-postdate', '');
    date.append(document.createTextNode('게시일 '), document.createTextNode(String(item.postdate ?? ''))); meta.append(date);
    if (href) { const original = externalLink(href); original.className = 'review-link'; original.textContent = '원문 보기 ↗'; original.setAttribute('data-naver-original', ''); meta.append(original); }
    row.append(meta); fragment.append(row);
  }
  $('results').replaceChildren(fragment);
  $('results').removeAttribute('aria-busy');
  if (!state.items.length) {
    setStatus('empty', state.start > 1 ? '이 페이지에 검색 결과가 없습니다. 이전 10건으로 돌아가거나 네이버에서 직접 검색해보세요.' : '이 검색어로 찾은 블로그 글이 없습니다. 네이버에서 직접 검색해보세요.');
    $('recovery').hidden = false; $('external').hidden = !state.query; $('retry').hidden = true;
    if (state.start > 1) { $('page').textContent = `${Math.floor((state.start - 1) / 10) + 1}페이지`; $('prev').disabled = false; $('next').disabled = true; $('pagination').hidden = false; }
    return;
  }
  const last = state.start + state.items.length - 1;
  setStatus('ready', '');
  $('count').textContent = `검색 결과 ${state.total.toLocaleString('ko-KR')}건 · ${state.start.toLocaleString('ko-KR')}–${last.toLocaleString('ko-KR')}번째`;
  $('count').hidden = false;
  $('page').textContent = `${Math.floor((state.start - 1) / 10) + 1}페이지`;
  $('prev').disabled = state.start <= 1;
  $('next').disabled = state.start >= 991 || state.start + 10 > state.total || state.items.length < 10;
  $('pagination').hidden = false; $('bottom-source').hidden = !state.query;
}

function showFailure(error) {
  $('retry').textContent = '다시 시도';
  const config = error.code === 'NAVER_CONFIG_REQUIRED';
  const invalid = error.code === 'INVALID_FOREST' || error.code === 'FOREST_NOT_FOUND' || !forestId;
  setStatus(config ? 'config' : invalid ? 'invalid' : 'error', config
    ? '네이버 블로그 검색이 아직 연결되지 않았어요. 네이버에서 직접 후기를 찾아볼 수 있어요.'
    : invalid ? '휴양림을 확인할 수 없어요. 휴양림 목록에서 다시 열어주세요.'
      : error.code === 'NETWORK_ERROR' ? '인터넷 연결을 확인한 뒤 다시 시도해주세요.'
        : error.code === 'TIMEOUT' ? '검색 응답이 늦어지고 있어요. 잠시 후 다시 시도하거나 네이버에서 직접 검색해주세요.'
        : '검색 결과를 불러오지 못했어요. 잠시 후 다시 시도하거나 네이버에서 직접 검색해주세요.');
  $('recovery').hidden = false; $('retry').hidden = invalid;
  $('external').hidden = !state.query; $('return').hidden = !invalid;
  if (!state.forest) $('title').textContent = '네이버 블로그 후기';
}

async function search({ sort = state.sort, start = state.start, focusResults = false } = {}) {
  if (closed || pageHidden) return;
  controller?.abort(); clearTimeout(requestTimer); controller = new AbortController(); const ownController = controller;
  const version = ++requestVersion;
  clearResults(); state.sort = sort === 'date' ? 'date' : 'sim'; state.start = Math.min(991, Math.max(1, start));
  $('sort').value = state.sort;
  if (!/^[A-Za-z0-9_-]+$/.test(forestId)) { showFailure({ code: 'INVALID_FOREST' }); return; }
  setLoading();
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; ownController.abort(); }, 12000);
  requestTimer = timeout;
  try {
    const response = await fetch(`/api/forests/${encodeURIComponent(forestId)}/naver-blogs?${new URLSearchParams({ sort: state.sort, start: String(state.start) })}`, { cache: 'no-store', signal: ownController.signal, headers: { Accept: 'application/json' } });
    const value = await response.json();
    if (version !== requestVersion || closed || pageHidden) return;
    updateIdentity(value);
    if (!response.ok || value.error) throw Object.assign(new Error('Search request failed'), { code: value.error?.code || 'SEARCH_FAILED' });
    if (!Array.isArray(value.items)) throw Object.assign(new Error('Invalid search response'), { code: 'INVALID_RESPONSE' });
    state = { ...state, sort: value.sort === 'date' ? 'date' : 'sim', start: Number(value.start) || state.start, display: Number(value.display) || 10, total: Math.max(0, Number(value.total) || 0), items: value.items, lastBuildDate: value.lastBuildDate ?? null };
    $('sort').value = state.sort; renderResults();
    if (focusResults) { $('status').scrollIntoView({ block: 'start' }); const first = $('results').querySelector('h2 a'); if (first) first.focus({ preventScroll: true }); else $('retry').hidden ? $('external').focus({ preventScroll: true }) : $('retry').focus({ preventScroll: true }); }
  } catch (error) {
    if (version !== requestVersion || (error.name === 'AbortError' && !timedOut) || closed || pageHidden) return;
    showFailure(timedOut ? { code: 'TIMEOUT' } : error instanceof TypeError ? { code: 'NETWORK_ERROR' } : error);
    if (focusResults) { $('status').scrollIntoView({ block: 'start' }); (!$('retry').hidden ? $('retry') : $('return')).focus({ preventScroll: true }); }
  } finally {
    clearTimeout(timeout);
    if (version === requestVersion && !closed && !pageHidden) { loading = false; controller = null; requestTimer = null; $('sort').disabled = false; $('reload').disabled = false; $('results').removeAttribute('aria-busy'); }
  }
}

$('sort').addEventListener('change', () => void search({ sort: $('sort').value, start: 1 }));
$('reload').addEventListener('click', () => { if (!loading) void search({ focusResults: true }); });
$('retry').addEventListener('click', () => { if (!loading) void search({ focusResults: true }); });
$('prev').addEventListener('click', () => { if (!loading && state.start > 1) void search({ start: state.start - 10, focusResults: true }); });
$('next').addEventListener('click', () => { if (!loading && state.start < 991 && state.start + 10 <= state.total) void search({ start: state.start + 10, focusResults: true }); });
$('close').addEventListener('click', () => {
  closed = true; clearPage();
  $('sort').disabled = true; $('reload').disabled = true;
  setStatus('closed', '검색 결과를 지웠어요. 휴양림 목록으로 돌아갑니다.');
  $('recovery').hidden = false; $('retry').hidden = true; $('return').hidden = false;
  let fromList = false;
  try { const from = new URL(document.referrer); fromList = from.origin === location.origin && from.pathname === '/'; } catch { /* Direct entry returns to the list. */ }
  if (fromList) window.history.back();
  else location.assign('/');
});
$('return').addEventListener('click', clearPage);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') expireResults(); });
window.addEventListener('pagehide', () => { pageHidden = true; clearPage(); });
window.addEventListener('pageshow', event => { if (event.persisted) { pageHidden = false; closed = false; void search(); } });
void search();
