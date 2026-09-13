export function matchLocations(forests, locations) {
  const byId = new Map(locations.filter(p => typeof p.id === 'string' && Number.isFinite(p.lat) && Number.isFinite(p.lng) && p.lat >= 33 && p.lat <= 39 && p.lng >= 124 && p.lng <= 132).map(p => [p.id, p]));
  return { located: forests.filter(f => byId.has(f.id)).map(f => ({ ...f, location: byId.get(f.id) })), missing: forests.filter(f => !byId.has(f.id)) };
}

export function groupLocations(forests, project, size = 52) {
  const groups = new Map();
  for (const f of forests) {
    const p = project(f.location), key = `${Math.floor(p.x / size)}:${Math.floor(p.y / size)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(f);
  }
  return [...groups.values()];
}

export function createForestMap({ root, api, onOpen, loadLibrary = () => import('/leaflet.js') }) {
  let L, map, tiles, layer, loading, locations = [], active = false, forests = [], summaries = new Map(), located = [], lastIds = '', selectedId = null;
  const checked = new Set(), pending = new Set();
  let workers = 0, locationErrors = false, messageKind = 'general';
  const el = (tag, className, text) => { const n = document.createElement(tag); n.className = className; if (text) n.textContent = text; return n; };
  root.innerHTML = '<div class="map-toolbar"><p data-map-count role="status" aria-live="polite">위치를 확인하고 있어요.</p><button type="button" data-map-fit>전체 위치 보기</button></div><div class="map-message" data-map-message role="status" hidden></div><div class="forest-map-canvas" data-map-canvas aria-label="조건에 맞는 휴양림 지도"></div><p class="map-hint">숫자를 누르면 모여 있는 휴양림이 펼쳐집니다. 위치를 선택해 가능한 날짜를 확인하세요.</p><details class="map-missing" data-map-missing hidden><summary data-map-missing-title></summary><div data-map-missing-list></div></details>';
  const $ = name => root.querySelector(`[data-map-${name}]`);
  $('fit').addEventListener('click', () => fit());
  function showMessage(text, retry, kind = 'general') {
    messageKind = kind;
    const node = $('message'); node.replaceChildren(); node.hidden = !text;
    if (!text) return;
    node.append(el('span', '', text));
    if (retry) { const b = el('button', '', '다시 불러오기'); b.type = 'button'; b.addEventListener('click', retry); node.append(b); }
  }
  function fit() {
    if (!map) return;
    if (located.length) map.fitBounds(located.map(f => [f.location.lat, f.location.lng]), { padding: [40, 40], maxZoom: 12, animate: false });
    else map.setView([36.2, 127.7], 7, { animate: false });
  }
  function detailButton(f) {
    const b = el('button', 'map-detail-button', '가능한 날짜 보기 →'); b.type = 'button'; b.dataset.mapOpen = f.id;
    b.addEventListener('click', () => onOpen(f.id, b)); return b;
  }
  function popup(f) {
    const box = el('div', 'map-forest-popup');
    box.append(el('p', 'map-popup-region', `${f.region}${f.city ? ` · ${f.city}` : ''}`), el('h3', '', f.name));
    if (f.location.address) box.append(el('p', 'map-popup-address', f.location.address));
    box.append(el('p', 'map-popup-availability', summaries.get(f.id) || '가능한 날짜 확인'));
    if (f.stale || f.coverage !== 'complete') box.append(el('p', 'map-popup-note', `${f.stale ? '이전 확인 결과' : '일부 범위 확인'} · 상세에서 확인 시점을 확인하세요.`));
    box.append(detailButton(f));
    const source = el('a', 'map-popup-source', '위치 정보: 숲나들e ↗');
    source.href = f.location.sourceUrl; source.target = '_blank'; source.rel = 'noopener noreferrer'; box.append(source);
    return box;
  }
  function draw() {
    if (!map || !active) return;
    layer.clearLayers();
    for (const group of groupLocations(located, p => map.project([p.lat, p.lng], map.getZoom()))) {
      const many = group.length > 1, f = group[0];
      const point = many ? [group.reduce((n, f) => n + f.location.lat, 0) / group.length, group.reduce((n, f) => n + f.location.lng, 0) / group.length] : [f.location.lat, f.location.lng];
      const marker = L.marker(point, { icon: L.divIcon({ className: many ? 'forest-cluster' : 'forest-pin', html: many ? `<span>${group.length}</span>` : '<span aria-hidden="true">●</span>', iconSize: many ? [42, 42] : [30, 30], iconAnchor: many ? [21, 21] : [15, 15] }), title: many ? `휴양림 ${group.length}곳 펼치기` : f.name, alt: many ? `휴양림 ${group.length}곳 펼치기` : `${f.name}, ${summaries.get(f.id) || '가능한 날짜 보기'}`, keyboard: true }).addTo(layer);
      marker.getElement()?.setAttribute('aria-label', many ? `휴양림 ${group.length}곳 펼치기` : `${f.name}, ${summaries.get(f.id) || '가능한 날짜 보기'}`);
      if (many) marker.on('click', () => {
        selectedId = null;
        const bounds = L.latLngBounds(group.map(f => [f.location.lat, f.location.lng]));
        if (map.getZoom() >= 16 || bounds.getNorthEast().equals(bounds.getSouthWest())) {
          const box = el('div', 'map-group-popup'); box.append(el('h3', '', `이 위치의 휴양림 ${group.length}곳`));
          for (const f of group) { const row = el('div', 'map-group-row'); row.append(el('strong', '', f.name), detailButton(f)); box.append(row); }
          marker.bindPopup(box, { maxWidth: 280 }).openPopup();
        } else map.fitBounds(bounds, { padding: [40, 40], maxZoom: Math.min(16, map.getZoom() + 3) });
      });
      else {
        marker.bindPopup(popup(f), { minWidth: 210, maxWidth: 280 });
        marker.on('click', () => { selectedId = f.id; });
        if (selectedId === f.id) marker.openPopup();
      }
    }
  }
  function apply() {
    if (!map || !locations || !active) return;
    const result = matchLocations(forests, locations); located = result.located;
    result.missing = result.missing.filter(f => checked.has(f.id));
    if (!result.missing.length && messageKind === 'locations') showMessage('');
    if (located.length && messageKind === 'empty') showMessage('');
    const remaining = forests.filter(f => !checked.has(f.id)).length;
    $('count').textContent = `조건에 맞는 ${forests.length}곳 중 ${located.length}곳 표시${remaining ? ` · 위치 확인 중 ${remaining}곳` : ''}`;
    $('fit').disabled = !located.length;
    $('missing').hidden = !result.missing.length;
    $('missing-title').textContent = `위치 미확인 ${result.missing.length}곳 · 목록에서 확인`;
    $('missing-list').replaceChildren();
    for (const f of result.missing) { const row = el('div', 'map-group-row'); row.append(el('strong', '', f.name), detailButton(f)); $('missing-list').append(row); }
    const ids = forests.map(f => f.id).sort().join(',');
    if (!located.some(f => f.id === selectedId)) selectedId = null;
    if (lastIds !== ids) { lastIds = ids; fit(); }
    draw();
    if (!located.length && !remaining) showMessage(forests.length ? '이 결과의 위치를 아직 확인하지 못했어요. 아래 목록에서 상세 정보를 볼 수 있습니다.' : '현재 조건에 맞는 휴양림이 없어요. 날짜나 필터를 바꿔보세요.', null, 'empty');
  }
  function loadLocations() {
    if (!active || !map) return;
    while (workers < 3) {
      const next = forests.find(f => !checked.has(f.id) && !pending.has(f.id));
      if (!next) break;
      pending.add(next.id); workers++;
      void (async () => {
        try {
          const result = await api(`/api/forests/${encodeURIComponent(next.id)}/location`);
          if (result.location) locations.push(result.location);
        } catch { locationErrors = true; }
        finally {
          checked.add(next.id); pending.delete(next.id); workers--;
          if (active) {
            apply(); loadLocations();
            if (!workers && forests.every(f => checked.has(f.id))) {
              fit();
              if (locationErrors && matchLocations(forests, locations).missing.length) showMessage('일부 위치를 불러오지 못했어요. 위치 미확인 목록에서도 상세 정보를 볼 수 있습니다.', () => {
                const known = new Set(locations.map(p => p.id));
                for (const f of forests) if (!known.has(f.id)) checked.delete(f.id);
                locationErrors = false; showMessage('위치를 다시 확인하고 있어요.', null, 'locations'); apply(); loadLocations();
              }, 'locations');
            }
          }
        }
      })();
    }
  }
  async function ensure() {
    if (loading || map) return;
    showMessage('지도를 불러오고 있어요.'); $('fit').disabled = true;
    loading = (async () => {
      try {
        L = L || await loadLibrary();
        if (!active) return;
        if (!map) {
          map = L.map($('canvas'), { scrollWheelZoom: false, minZoom: 6, maxZoom: 18 }).setView([36.2, 127.7], 7);
          map.zoomControl.setPosition('bottomright');
          map.zoomControl._zoomInButton.title = '지도 확대'; map.zoomControl._zoomInButton.setAttribute('aria-label', '지도 확대');
          map.zoomControl._zoomOutButton.title = '지도 축소'; map.zoomControl._zoomOutButton.setAttribute('aria-label', '지도 축소');
          map.attributionControl.setPrefix(false);
          let tileFailed = false;
          tiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, referrerPolicy: 'strict-origin-when-cross-origin', attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors' }).addTo(map);
          tiles.on('tileerror', () => { tileFailed = true; showMessage('배경 지도를 불러오지 못했어요. 위치 선택과 상세 보기는 계속 이용할 수 있습니다.', () => { tileFailed = false; showMessage('배경 지도를 다시 불러오고 있어요.', null, 'tiles'); tiles.redraw(); }, 'tiles'); });
          tiles.on('load', () => { if (!tileFailed && located.length && messageKind === 'tiles') showMessage(''); });
          layer = L.layerGroup().addTo(map); map.on('zoomend', draw);
          map.on('click', () => { selectedId = null; });
        }
        showMessage(''); map.invalidateSize(); apply(); loadLocations();
      } catch { $('count').textContent = '지도를 불러오지 못했어요'; showMessage('지도 연결을 확인한 뒤 다시 시도해주세요. 목록 보기는 계속 이용할 수 있어요.', () => ensure()); }
      finally { loading = null; }
    })();
    await loading;
  }
  return { render(nextForests, options) {
    forests = nextForests; summaries = options.summaries; active = options.active; root.hidden = !active;
    if (!active) return;
    if (map) { map.invalidateSize(); apply(); loadLocations(); } else void ensure();
  } };
}
