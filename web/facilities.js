const escapeText = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const closeIcon = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="m6 6 12 12M6 18 18 6"/></svg>';
const externalIcon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13 3h8v8m0-8L10 14M9 3H3v18h18v-6"/></svg>';
const tabs = [{ id: 'info', label: '시설 정보' }, { id: 'guide', label: '이용안내' }, { id: 'map', label: '배치도' }];
const asArray = value => Array.isArray(value) ? value : [];
const timeValue = value => value ? Date.parse(value) || 0 : 0;
const checkedDate = value => timeValue(value) ? new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: 'long', day: 'numeric' }).format(new Date(value)) : '확인 날짜 없음';
const assetUrl = value => typeof value === 'string' && /^\/api\/facility-assets\/[A-Za-z0-9_-]+$/.test(value) ? value : '';
function officialUrl(value) {
  try { const url = new URL(value); return url.protocol === 'https:' && ['foresttrip.go.kr', 'www.foresttrip.go.kr'].includes(url.hostname) ? url.href : ''; }
  catch { return ''; }
}

// A separate native dialog keeps the forest's selected date and scroll position intact.
export function createFacilityViewer({ api, document: suppliedDocument } = {}) {
  let dialog, doc, context, snapshot = null, requestVersion = 0, busy = false;
  let pollTimer = null, retryTimer = null, polls = 0, pollingStopped = false, activeTab = 'info', contentKey = '';
  const panelScroll = new Map();
  const element = name => dialog.querySelector(`[data-facility-${name}]`);
  const current = version => dialog?.open && version === requestVersion;

  function stopTimers() { clearTimeout(pollTimer); clearTimeout(retryTimer); pollTimer = retryTimer = null; }
  function createDialog() {
    if (dialog) return;
    doc = suppliedDocument || globalThis.document;
    dialog = doc.createElement('dialog');
    dialog.id = 'facilityDialog';
    dialog.className = 'facility-dialog';
    dialog.setAttribute('aria-labelledby', 'facilityTitle');
    dialog.innerHTML = `<div class="facility-shell"><div class="facility-head"><div><p class="facility-kicker" data-facility-forest></p><h2 id="facilityTitle" data-facility-title></h2></div><button type="button" class="close-btn" data-facility-close aria-label="시설 정보 닫기">${closeIcon}</button></div><div class="facility-status" data-facility-status role="status" aria-live="polite"></div><div class="facility-tabs" data-facility-tabs role="tablist" aria-label="시설 자료" hidden>${tabs.map(tab => `<button type="button" id="facilityTab-${tab.id}" role="tab" aria-controls="facilityPanel" data-facility-tab="${tab.id}" aria-selected="${tab.id === activeTab}" tabindex="${tab.id === activeTab ? '0' : '-1'}">${tab.label}</button>`).join('')}</div><div id="facilityPanel" class="facility-panel" data-facility-panel tabindex="0"></div><div class="facility-actions"><button type="button" class="secondary" data-facility-back>시설 목록으로</button><a class="facility-source" data-facility-source target="_blank" rel="noopener noreferrer">숲나들e 원본 ${externalIcon}</a></div></div>`;
    doc.body.append(dialog);
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
    dialog.addEventListener('close', () => {
      requestVersion++; busy = false; stopTimers();
      for (const [node, top] of context?.parentScroll || []) if (node.isConnected) node.scrollTop = top;
      const trigger = context?.trigger?.isConnected ? context.trigger : Array.from(context?.parent?.querySelectorAll('[data-facility-unit]') || []).find(button => button.dataset.facilityUnit === context.unitId && button.dataset.facilityType === context.type);
      if (trigger?.isConnected) trigger.focus({ preventScroll: true });
      else if (context?.parent?.open) context.parent.querySelector('[data-close]')?.focus({ preventScroll: true });
    });
    dialog.addEventListener('click', event => {
      if (event.target === dialog) { const rect = dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) close(); return; }
      const button = event.target.closest('button');
      if (!button) return;
      if (button.hasAttribute('data-facility-close') || button.hasAttribute('data-facility-back')) close();
      else if (button.dataset.facilityTab) selectTab(button.dataset.facilityTab);
      else if (button.hasAttribute('data-facility-retry') && !button.disabled && !busy) { polls = 0; pollingStopped = false; void load(requestVersion); }
    });
    dialog.addEventListener('keydown', event => {
      const tab = event.target.closest('[data-facility-tab]');
      if (!tab || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const index = tabs.findIndex(item => item.id === activeTab);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      selectTab(tabs[next].id);
      dialog.querySelector(`[data-facility-tab="${activeTab}"]`).focus({ preventScroll: true });
    });
    dialog.addEventListener('error', event => {
      const image = event.target;
      if (image.tagName !== 'IMG' || !image.closest('[data-facility-image]')) return;
      image.hidden = true;
      image.parentElement.hidden = true;
      const note = image.closest('[data-facility-image]').querySelector('.facility-image-error');
      if (note) note.hidden = false;
    }, true);
  }

  function selectTab(id) {
    if (!tabs.some(tab => tab.id === id) || activeTab === id) return;
    panelScroll.set(activeTab, element('panel').scrollTop);
    activeTab = id; contentKey = ''; renderContent();
    element('panel').scrollTop = panelScroll.get(activeTab) || 0;
  }

  function imagesMarkup(images) {
    return `<div class="facility-images">${images.map(image => {
      const url = assetUrl(image.url), label = image.label || (image.kind === 'photo' ? '시설 사진' : '배치도');
      return `<figure class="facility-image" data-facility-image><div class="facility-image-frame">${url ? `<a href="${escapeText(url)}" target="_blank" rel="noopener noreferrer" aria-label="${escapeText(label)} 원본 크기로 보기"><img src="${escapeText(url)}" alt="${escapeText(label)}" loading="lazy" decoding="async"></a>` : ''}<p class="facility-image-error" ${url ? 'hidden' : ''}>저장된 이미지를 불러오지 못했어요.<br>숲나들e 원본에서 확인해주세요.</p></div><figcaption><span>${escapeText(label)}</span>${url ? `<a href="${escapeText(url)}" target="_blank" rel="noopener noreferrer">크게 보기 ${externalIcon}</a>` : ''}</figcaption></figure>`;
    }).join('')}</div>`;
  }

  function renderContent() {
    const detail = snapshot?.detail, panel = element('panel');
    element('tabs').hidden = !detail;
    if (!detail) {
      const key = snapshot?.error ? 'error' : pollingStopped ? 'waiting' : snapshot && !snapshot.refreshing ? 'empty' : 'loading';
      if (contentKey === key) return;
      contentKey = key;
      panel.removeAttribute('role'); panel.removeAttribute('aria-labelledby');
      panel.innerHTML = `<div class="facility-empty" data-state="${key}"><strong>${key === 'error' ? '시설 자료를 불러오지 못했어요' : key === 'empty' ? '저장된 시설 자료가 없습니다' : key === 'waiting' ? '아직 자료를 확인하고 있어요' : '시설 자료를 불러오고 있어요'}</strong><p>${key === 'error' || key === 'empty' ? '잠시 후 다시 시도하거나 숲나들e 원본에서 확인해주세요.' : '처음 조회하는 시설은 정보를 가져오는 데 시간이 걸릴 수 있어요.'}</p></div>`;
      return;
    }
    panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', `facilityTab-${activeTab}`);
    for (const button of dialog.querySelectorAll('[data-facility-tab]')) { const selected = button.dataset.facilityTab === activeTab; button.setAttribute('aria-selected', String(selected)); button.tabIndex = selected ? 0 : -1; }
    const key = `${activeTab}:${JSON.stringify(detail)}`;
    if (contentKey === key) return;
    contentKey = key;
    const top = panel.scrollTop;
    const focusedLink = doc.activeElement?.closest?.('a');
    const restoreLink = focusedLink && panel.contains(focusedLink) ? focusedLink.getAttribute('href') : null;
    const images = asArray(detail.images);
    if (activeTab === 'info') {
      const facts = asArray(detail.facts).filter(fact => fact && (fact.label || fact.value));
      const photos = images.filter(image => image.kind === 'photo');
      panel.innerHTML = `${facts.length ? `<dl class="facility-facts">${facts.map(fact => `<div><dt>${escapeText(fact.label)}</dt><dd>${escapeText(fact.value)}</dd></div>`).join('')}</dl>` : '<p class="facility-empty-note">등록된 시설 설명이 없습니다.</p>'}${photos.length ? `<h3 class="facility-section-title">시설 사진</h3>${imagesMarkup(photos)}` : '<p class="facility-empty-note">등록된 시설 사진이 없습니다.</p>'}`;
    } else if (activeTab === 'guide') {
      const guide = asArray(detail.guide).filter(line => typeof line === 'string' && line.trim());
      panel.innerHTML = guide.length ? `<div class="facility-guide">${guide.map(line => `<p>${escapeText(line)}</p>`).join('')}</div>` : '<div class="facility-empty"><strong>등록된 이용안내가 없습니다</strong><p>이용 조건은 숲나들e 원본에서 확인해주세요.</p></div>';
    } else {
      const maps = images.filter(image => image.kind === 'map' || image.kind === 'floorplan');
      panel.innerHTML = maps.length ? imagesMarkup(maps) : '<div class="facility-empty"><strong>등록된 배치도가 없습니다</strong><p>시설 위치는 숲나들e 원본에서 확인해주세요.</p></div>';
    }
    if (restoreLink) (Array.from(panel.querySelectorAll('a')).find(link => link.getAttribute('href') === restoreLink) || panel).focus({ preventScroll: true });
    panel.scrollTop = top;
  }

  function renderStatus() {
    clearTimeout(retryTimer);
    const status = element('status'), detail = snapshot?.detail, error = snapshot?.error;
    const retryAt = timeValue(snapshot?.retryAfter), coolingDown = retryAt > Date.now();
    const seconds = Math.ceil((retryAt - Date.now()) / 1000);
    const retryText = coolingDown ? `${seconds > 60 ? `${Math.ceil(seconds / 60)}분` : `${seconds}초`} 후 다시 시도` : pollingStopped ? '갱신 결과 확인' : '다시 시도';
    const badge = detail ? `<span class="facility-cache-badge" data-stale="${Boolean(snapshot.stale)}">${snapshot.stale ? '이전 저장 자료' : '서버 저장 자료'}</span><span class="facility-checked">${escapeText(checkedDate(snapshot.checkedAt))} 확인</span>` : '';
    let message = '';
    if (busy && !detail) message = '서버에 저장된 자료를 확인하고 있어요.';
    else if (busy) message = '저장된 자료를 표시하고 있어요. 갱신 결과를 확인 중입니다.';
    else if (error) message = `${detail ? '저장된 자료를 표시하고 있어요. ' : ''}${error.message || '원본 자료를 갱신하지 못했어요.'}`;
    else if (snapshot?.refreshing) message = pollingStopped ? '아직 갱신 중이에요. 잠시 후 결과를 다시 확인해주세요.' : detail ? '저장된 자료를 먼저 표시하고 있어요. 최신 자료를 확인 중입니다.' : '원본에서 시설 자료를 가져오고 있어요.';
    else if (detail && snapshot.stale) message = '이전 확인 자료입니다. 이용 전 원본의 최신 안내를 확인해주세요.';
    else if (!detail) message = '저장된 자료가 없습니다. 다시 시도해주세요.';
    status.dataset.state = error ? 'error' : snapshot?.refreshing || busy ? 'refreshing' : snapshot?.stale ? 'stale' : 'ready';
    status.innerHTML = `<div class="facility-status-copy">${badge ? `<div class="facility-cache-line">${badge}</div>` : ''}${message ? `<p>${escapeText(message)}</p>` : ''}</div>${error || pollingStopped || (!detail && !busy && !snapshot?.refreshing) ? `<button type="button" class="facility-retry" data-facility-retry ${busy || coolingDown ? 'disabled' : ''}>${busy ? '확인 중…' : escapeText(retryText)}</button>` : ''}`;
    if (coolingDown && dialog.open && (error || pollingStopped)) retryTimer = setTimeout(renderStatus, Math.min(retryAt - Date.now(), 1000));
  }

  function render() {
    const detail = snapshot?.detail;
    element('title').textContent = detail?.title || context.title || '시설 정보';
    const source = officialUrl(detail?.sourceUrl) || `https://www.foresttrip.go.kr/pot/rm/fa/selectFcltsArmpDtlView.do?${new URLSearchParams({ insttId: context.forestId, goodsId: context.unitId })}`;
    element('source').href = source;
    renderStatus(); renderContent();
  }

  async function load(version) {
    if (!current(version) || busy) return;
    clearTimeout(pollTimer); busy = true; renderStatus();
    try {
      const result = await api(`/api/forests/${encodeURIComponent(context.forestId)}/units/${encodeURIComponent(context.unitId)}?${new URLSearchParams({ type: context.type })}`);
      if (!current(version)) return;
      snapshot = result;
    } catch (error) {
      if (!current(version)) return;
      snapshot = { ...snapshot, refreshing: false, error: { code: error.code, message: error.message }, retryAfter: error.retryAfter || null };
    } finally {
      if (current(version)) {
        busy = false;
        if (snapshot?.refreshing && !snapshot.error) {
          if (polls < 30) { polls++; pollTimer = setTimeout(() => void load(version), 2000); }
          else pollingStopped = true;
        }
        render();
      }
    }
  }

  function open({ forestId, unitId, type, title, forestName, trigger }) {
    createDialog(); stopTimers(); requestVersion++;
    const parent = trigger?.closest('dialog');
    context = { forestId, unitId, type, title, trigger, parent, parentScroll: parent ? Array.from(parent.querySelectorAll('.dialog-content,.room-list'), node => [node, node.scrollTop]) : [] };
    snapshot = null; busy = false; polls = 0; pollingStopped = false; activeTab = 'info'; contentKey = ''; panelScroll.clear();
    element('forest').textContent = forestName || '시설 정보·배치도';
    if (!dialog.open) dialog.showModal();
    element('panel').scrollTop = 0; render();
    element('close').focus({ preventScroll: true });
    void load(requestVersion);
  }
  function close() { if (dialog?.open) dialog.close(); }
  return { open, close };
}
