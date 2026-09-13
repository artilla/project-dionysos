import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';
import { createApiClient } from '../web/connection.js';
import { createFacilityViewer } from '../web/facilities.js';
import { normalizeRegions, selectedRegionIds, fetchRegionAvailability, withPersonalState } from '../web/regions.js';

const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
const source = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8').replace(/^import .*;\n/gm, '');
const uiSource = readFileSync(new URL('../web/ui.js', import.meta.url), 'utf8').replace(/export \{icon,esc,scene\};/, '');
const catalog = { months: [{ id: '202609', name: '2026년 9월' }, { id: '202610', name: '2026년 10월' }], regions: [{ id: '1', name: '서울/인천/경기' }, { id: '2', name: '강원' }] };
const jobFor = (input = {}, id = 'new') => ({ id, status: 'complete', scope: 'selection', month: '202610', region: 'all', type: 'all', nights: 1, listedMonths: ['202610'], regionsTotal: 2, regionsDone: 2, completedScopes: 1, remaining: 0, totalForests: 1, completedForests: 1, checkedUnits: 1, failures: [], updatedAt: Date.now(), ...input });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

async function setup(options = {}) {
  const { window, document } = parseHTML(html);
  const sessionCatalog = options.catalog || catalog;
  // linkedom has no browser select setter, focus, or dialog lifecycle.
  Object.defineProperty(window.HTMLSelectElement.prototype, 'value', { configurable: true,
    get() { const o = this.querySelector('option[selected]') || this.querySelector('option'); return o?.getAttribute('value') ?? o?.textContent ?? ''; },
    set(value) { for (const o of this.querySelectorAll('option')) o.toggleAttribute('selected', (o.getAttribute('value') ?? o.textContent) === String(value)); }
  });
  window.HTMLElement.prototype.scrollIntoView = function () {};
  window.HTMLElement.prototype.focus = function () {};
  for (const d of document.querySelectorAll('dialog')) { Object.defineProperty(d,'open',{get:()=>d.hasAttribute('open')});d.showModal = () => d.setAttribute('open', ''); d.close = () => {d.removeAttribute('open');d.dispatchEvent(new window.Event('close'));}; }
  const requests = [], filterUrls = [], storageWrites=[], priceInvalidations=[];
  let sessionState={connected:true,configured:true,...options.session};
  let currentJob = options.job || jobFor({}, 'previous');
  const context = vm.createContext({ document, window, console, URLSearchParams, Intl, Date, CSS: { escape: x => x },
    location: { pathname: '/', search: '?month=202610&region=all&type=all&guests=4&nights=1' },
    history: { replaceState(_state, _title, url) { filterUrls.push(url); } }, localStorage: { getItem: () => '[]', setItem(...args) {storageWrites.push(args);} },
    setTimeout(fn, ms) { if ([350,1000,2000,4000].includes(ms)) queueMicrotask(fn); return 1; }, clearTimeout() {},
    createForestMap: () => ({render: (forests, options) => {document.getElementById("forestMap").hidden = !options.active;}}),
    observePrices: () => () => {}, invalidatePrices: id => priceInvalidations.push(id), createApiClient, createFacilityViewer, normalizeRegions, selectedRegionIds, fetchRegionAvailability, withPersonalState,
    async fetch(path, init) {
      const body = init.body && JSON.parse(init.body); requests.push({ path, body });
      const override=await options.fetch?.({path,body,job:currentJob,setJob:value=>{currentJob=value;}});if(override!==undefined)return override;
      let value;
      if (path === '/api/session') value = { ...sessionState, csrfToken: 'fixture', catalog: sessionCatalog, job: currentJob };
      else if (path.startsWith('/api/availability?')) value = { forests: typeof options.forests==='function'?options.forests():options.forests||[], coverage: {}, job: currentJob };
      else if (path === '/api/sync') {
        if (options.reject) return { ok: false, json: async () => ({ error: { message: '조회 요청 실패', code: 'SOURCE_ERROR' } }) };
        currentJob = options.sync ? await options.sync(body) : jobFor(body); value = { job: currentJob };
      } else if (path === '/api/job/step') { currentJob = await options.step(); value = { job: currentJob }; }
      else if (path === '/api/session/connect') {sessionState={connected:true,configured:true,accountLabel:'fi••••'};value={...sessionState,catalog:sessionCatalog};}
      else if (path === '/api/session/disconnect') {sessionState.connected=false;value={...sessionState};}
      else if (path === '/api/session/forget') {sessionState={connected:false,configured:false,accountLabel:null};value={...sessionState};}
      else if (path === '/api/job/resume' || path === '/api/job/retry') { currentJob = options.continueJob?await options.continueJob(path,currentJob):jobFor(); value = { job: currentJob }; }
      else throw new Error('Unexpected fixture request: ' + path);
      return { ok: true, json: async () => value };
    }
  });
  Object.assign(context, vm.runInContext(`(()=>{${uiSource};return {icon,esc,scene};})()`, context));
  const app = await vm.runInContext(`(async()=>{${source};return {state,run,refresh,setCatalog,updateForest,checkConnection,getDraft:()=>({...sourceDraft}),getJob:()=>job};})()`, context);
  const $ = id => document.getElementById(id);
  const change = (id, value) => { $(id).value = value; $(id).dispatchEvent(new window.Event('change', { bubbles: true })); };
  const regionCheckbox = id => document.querySelector(`[data-result-region][value="${id}"]`);
  const chooseRegion = (id, checked = true) => { const input = regionCheckbox(id); input.checked = checked; input.dispatchEvent(new window.Event('change', { bubbles: true })); };
  return { app, $, requests, filterUrls, storageWrites, priceInvalidations, change, chooseRegion, regionCheckbox, submit:id=>$(id).dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true})), click: selector => document.querySelector(selector).click() };
}

const settled = () => new Promise(resolve=>setImmediate(resolve));

test('collapsed query panels preserve independent drafts and reveal copied conditions',async()=>{
 const h=await setup({catalog:{...catalog,regions:[...catalog.regions,{id:'9',name:'제주'}]}});
 h.click('#sourceToggle');h.change('sourceRegion','2');h.change('sourceGuests','6');
 h.click('#sourceToggle');h.click('#resultToggle');h.change('guests','8');h.chooseRegion('1');h.chooseRegion('2');
 h.click('#resultToggle');await h.app.refresh();
 assert.match(h.$('sourceSummary').textContent,/강원.*6명/);
 assert.match(h.$('resultSummary').textContent,/서울\/인천\/경기 외 1개 지역.*8명/);
 assert.equal(h.$('sourceToggle').getAttribute('aria-expanded'),'false');
 assert.equal(h.$('resultToggle').getAttribute('aria-expanded'),'false');
 h.click('#copyResult');
 assert.equal(h.$('sourceToggle').getAttribute('aria-expanded'),'true');
 assert.equal(h.$('sourceGuests').value,'8');assert.equal(h.$('sourceRegion').value,'2');
 assert.equal(h.requests.some(r=>r.path==='/api/sync'),false);
});

test('inline connection can be cancelled and successful connection reveals collection fields',async()=>{
 const h=await setup({session:{connected:false,configured:false}});
 assert.equal(h.$('connectInline').hidden,false);
 h.click('#connectInline');assert.equal(h.$('accountDialog').open,true);
 h.click('#cancelAccount');assert.equal(h.$('accountDialog').open,false);
 assert.equal(h.requests.some(r=>r.path==='/api/session/connect'),false);
 h.click('#connectInline');h.$('accountId').value='fixture-id';h.$('accountPassword').value='fixture-password';h.submit('accountForm');await settled();
 assert.equal(h.$('connectInline').hidden,true);
 assert.equal(h.$('sourceToggle').getAttribute('aria-expanded'),'true');
 assert.equal(h.$('sync').disabled,false);
 assert.equal(h.$('accountDialog').open,false);
});

test('initial availability errors still offer direct connection from the empty card',async()=>{
 const h=await setup({session:{connected:false,configured:false},fetch:async({path})=>path.startsWith('/api/availability?')?{ok:false,json:async()=>({error:{code:'SOURCE_ERROR',message:'조회 요청 실패'}})}:undefined});
 assert.match(h.$('connectionError').textContent,/조회 요청 실패/);
 h.click('[data-recover="connect"]');assert.equal(h.$('accountDialog').open,true);
 assert.equal(h.requests.some(r=>r.path==='/api/session/connect'),false);
 const knownEmpty=await setup({session:{connected:false,configured:true},fetch:async({path})=>path.startsWith('/api/availability?')?{ok:true,json:async()=>({forests:[],coverage:{},dataCoverage:{state:'empty'}})}:undefined});
 assert.notEqual(knownEmpty.$('cards').querySelector('.empty').dataset.state,'connect-required');
});

test('first connection collects credentials, shows progress and stores nothing in browser storage',async()=>{
 const pending=deferred();
 const h=await setup({session:{connected:false,configured:false},fetch:async({path})=>{if(path==='/api/session/connect'){await pending.promise;}}});
 h.click('#connect');assert.equal(h.$('accountDialog').open,true);assert.equal(h.$('accountTitle').textContent,'숲나들e 연결');
 h.submit('accountForm');assert.match(h.$('accountError').textContent,/모두 입력/);assert.equal(h.requests.some(r=>r.path==='/api/session/connect'),false);
 h.$('accountId').value='fixture-id';h.$('accountPassword').value=' fixture-password ';h.submit('accountForm');
 assert.equal(h.$('saveAccount').disabled,true);assert.equal(h.$('closeAccount').disabled,true);assert.equal(h.$('saveAccount').textContent,'연결 중…');
 pending.resolve();await settled();
 assert.deepEqual(h.requests.find(r=>r.path==='/api/session/connect').body,{id:'fixture-id',password:' fixture-password '});
 assert.equal(h.$('accountDialog').open,false);assert.equal(h.$('accountPassword').value,'');assert.equal(h.$('accountId').value,'');
 assert.equal(h.$('connectionState').textContent,'숲나들e 연결됨');assert.equal(h.$('sync').disabled,false);assert.equal(h.$('changeAccount').hidden,false);assert.match(h.$('savedAccount').textContent,/fi••••/);
 assert.deepEqual(h.storageWrites,[]);assert.equal(h.filterUrls.some(url=>url.includes('fixture')),false);
 h.click('#disconnect');await settled();assert.equal(h.$('connectionState').textContent,'숲나들e 연결이 필요해요');assert.equal(h.$('changeAccount').hidden,false);
 h.click('#connect');await settled();assert.deepEqual(h.requests.filter(r=>r.path==='/api/session/connect').at(-1).body,{});assert.equal(h.$('accountDialog').open,false);
});

test('failed account replacement preserves active connection and clears password before retry or cancel',async()=>{
 let reject=true;
 const h=await setup({session:{accountLabel:'ol••••'},fetch:async({path})=>path==='/api/session/connect'&&reject?{ok:false,json:async()=>({error:{code:'AUTH_REQUIRED',message:'ID와 비밀번호를 확인해주세요.'}})}:undefined});
 h.click('#changeAccount');h.$('accountId').value='replacement';h.$('accountPassword').value='incorrect';h.submit('accountForm');await settled();
 assert.equal(h.$('accountDialog').open,true);assert.match(h.$('accountError').textContent,/ID와 비밀번호/);assert.equal(h.$('accountPassword').value,'');assert.equal(h.$('accountId').value,'replacement');
 assert.equal(h.$('connectionState').textContent,'숲나들e 연결됨');assert.match(h.$('savedAccount').textContent,/ol••••/);assert.equal(h.$('saveAccount').disabled,false);
 reject=false;h.$('accountPassword').value='correct';h.submit('accountForm');await settled();assert.equal(h.$('accountDialog').open,false);assert.match(h.$('savedAccount').textContent,/fi••••/);
 h.click('#changeAccount');h.$('accountPassword').value='unsent';h.click('#cancelAccount');assert.equal(h.$('accountPassword').value,'');h.click('#changeAccount');assert.equal(h.$('accountPassword').value,'');
});

test('forget requires explicit confirmation, keeps result conditions and returns to first connection',async()=>{
 const h=await setup();const before={...h.app.state};
 h.click('#forgetAccount');assert.equal(h.$('accountForm').hidden,true);assert.equal(h.$('forgetAccountForm').hidden,false);assert.match(h.$('accountDescription').textContent,/조회 결과와 찜은 유지/);
 h.click('#cancelForgetAccount');assert.equal(h.requests.some(r=>r.path==='/api/session/forget'),false);
 h.click('#forgetAccount');h.submit('forgetAccountForm');await settled();
 assert.equal(h.$('accountDialog').open,false);assert.equal(h.$('savedAccount').hidden,true);assert.equal(h.$('forgetAccount').hidden,true);assert.deepEqual({...h.app.state},before);
 h.click('#connect');assert.equal(h.$('accountDialog').open,true);assert.equal(h.$('accountTitle').textContent,'숲나들e 연결');
});

test('recovery without a saved account opens the input dialog rather than attempting an empty login',async()=>{
 const h=await setup({session:{connected:false,configured:false}});await h.app.checkConnection();assert.equal(h.$('accountDialog').open,true);assert.equal(h.requests.some(r=>r.path==='/api/session/connect'),false);assert.equal(h.$('saveAccount').disabled,false);
});

const multiRegionCatalog = { ...catalog, regions: [...catalog.regions, { id: '9', name: '제주' }] };

test('result region checkboxes preserve multiple choices across catalog and result renders', async () => {
  const h = await setup({ catalog: multiRegionCatalog });
  h.click('#regionToggle');
  assert.equal(h.$('regionToggle').getAttribute('aria-expanded'), 'true');
  h.chooseRegion('2'); h.chooseRegion('1');
  assert.equal(h.app.state.region, '1,2');
  assert.equal(h.$('regionSummary').textContent, '서울/인천/경기 외 1개 지역');
  assert.equal(new URL('http://local' + h.filterUrls.at(-1)).searchParams.get('region'), '1,2');
  const before = h.requests.length;
  await h.app.refresh(); h.app.setCatalog();
  assert.equal(h.app.state.region, '1,2');
  assert.equal(h.regionCheckbox('1').checked, true); assert.equal(h.regionCheckbox('2').checked, true);
  assert.equal(h.regionCheckbox('9').checked, false); assert.equal(h.regionCheckbox('all').checked, false);
  const reads = h.requests.slice(before).filter(r => r.path.startsWith('/api/availability?'));
  assert.deepEqual(reads.map(r => new URL('http://local' + r.path).searchParams.get('region')), ['1', '2']);
  assert.equal(h.requests.some(r => r.path === '/api/sync'), false);
  h.click('#regionDone'); assert.equal(h.$('regionPanel').hidden, true);
});

test('result regions support removing choices, nationwide selection and filter reset', async () => {
  const h = await setup({ catalog: multiRegionCatalog });
  h.chooseRegion('1'); h.chooseRegion('2'); h.chooseRegion('1', false);
  assert.equal(h.app.state.region, '2'); assert.equal(h.$('regionSummary').textContent, '강원');
  h.chooseRegion('all');
  assert.equal(h.app.state.region, 'all'); assert.equal(h.regionCheckbox('all').checked, true);
  assert.equal(h.regionCheckbox('2').checked, false);
  h.chooseRegion('1'); h.chooseRegion('2'); h.chooseRegion('9');
  assert.equal(h.app.state.region, 'all'); assert.equal(h.$('regionSummary').textContent, '전국 모든 지역');
  h.chooseRegion('2'); h.chooseRegion('2', false);
  assert.equal(h.app.state.region, 'all');
  h.chooseRegion('1'); h.chooseRegion('2'); h.click('#reset');
  assert.equal(h.app.state.region, 'all'); assert.equal(h.regionCheckbox('all').checked, true);
  assert.equal(h.regionCheckbox('1').checked, false); assert.equal(h.regionCheckbox('2').checked, false);
});

test('copying multiple result regions keeps the independently selected source region', async () => {
  const h = await setup({ catalog: multiRegionCatalog });
  h.change('sourceRegion', '9'); h.chooseRegion('1'); h.chooseRegion('2'); h.change('guests', '8');
  h.click('#copyResult');
  assert.equal(h.app.state.region, '1,2'); assert.equal(h.app.getDraft().region, '9');
  assert.equal(h.$('sourceRegion').value, '9'); assert.equal(h.$('sourceGuests').value, '8');
  assert.match(h.$('toast').textContent, /새 현황을 조회할 지역.*선택/);
  assert.equal(h.requests.some(r => r.path === '/api/sync'), false);
});

test('source edits and result filtering stay independent; copy and reset are explicit', async () => {
  const h = await setup();
  h.change('sourceMonth', '202609'); h.change('sourceRegion', '2'); h.change('sourceGuests', '6'); h.click('[data-source-type="camp"]');
  assert.equal(h.app.state.month, '202610'); assert.equal(h.app.state.type, 'all');
  h.change('region', '1'); h.change('guests', '8'); await h.app.refresh(); h.app.setCatalog();
  assert.equal(h.$('sourceRegion').value, '2'); assert.equal(h.$('sourceGuests').value, '6');
  assert.equal(h.requests.some(r => r.path === '/api/sync'), false);
  h.click('#copyResult'); assert.equal(h.$('sourceRegion').value, '1'); assert.equal(h.$('sourceGuests').value, '8');
  h.click('#sourceReset'); assert.equal(h.$('sourceGuests').value, '2'); assert.equal(h.app.state.guests, 8);
});

test('accepted search uses submitted snapshot once and keeps later result changes', async () => {
  const accepted = deferred(), step = deferred(), reachedStep = deferred();
  const h = await setup({ sync: () => accepted.promise, step: () => { reachedStep.resolve(); return step.promise; } });
  Object.assign(h.app.state, { search: 'old', day: 12, weekend: true, includeWait: true, savedOnly: true });
  h.change('sourceMonth', '202609'); h.change('sourceRegion', '2'); h.change('sourceNights', '2');
  const running = h.app.run('start', undefined, h.app.getDraft());
  h.change('sourceRegion', '1');
  const sent = h.requests.find(r => r.path === '/api/sync').body;
  assert.equal(sent.region, '2'); assert.equal(sent.nights, 2); assert.equal(sent.weekend, false);
  accepted.resolve(jobFor({ ...sent, status: 'running', remaining: 1 })); await reachedStep.promise;
  assert.equal(h.app.state.region, '2'); assert.equal(h.app.state.month, '202609');
  assert.equal(h.app.state.search, ''); assert.equal(h.app.state.day, null); assert.equal(h.app.state.savedOnly, false);
  h.change('region', 'all'); h.change('guests', '8');
  step.resolve(jobFor(sent)); await running;
  assert.equal(h.app.state.region, 'all'); assert.equal(h.app.state.guests, 8);
  assert.equal(h.$('sourceRegion').value, '1'); assert.equal(h.app.getJob().region, '2');
});

test('failed or reused search does not overwrite existing result filters', async () => {
  for (const options of [{ reject: true }, { sync: input => jobFor(input, 'previous') }]) {
    const h = await setup(options); h.change('sourceRegion', '2');
    await h.app.run('start', undefined, h.app.getDraft());
    assert.equal(h.app.state.region, 'all'); assert.equal(h.$('sourceRegion').value, '2');
  }
});

test('result edits during acceptance and detail/all/resume actions do not apply the draft', async () => {
  const accepted = deferred(); const h = await setup({ sync: () => accepted.promise });
  h.change('sourceRegion', '2'); const pending = h.app.run('start', undefined, h.app.getDraft());
  h.change('region', '1'); accepted.resolve(jobFor({ region: '2' })); await pending;
  assert.equal(h.app.state.region, '1');
  const other = await setup(); other.change('sourceRegion', '2'); other.change('region', '1');
  await other.app.run('start', 'forest-id');
  const detail = other.requests.find(r => r.path === '/api/sync').body;
  assert.equal(detail.region, '1'); assert.equal(detail.forestId, 'forest-id');
  await other.app.run('all'); await other.app.run('resume');
  assert.equal(other.app.state.region, '1'); assert.equal(other.$('sourceRegion').value, '2');
});

const cardForest = (dates = { '20261012': 3 }) => ({ id: 'forest-1', name: '시험자연휴양림', region: '강원', city: '삼척시', operator: '공립', dates, coverage: 'complete', stale: true, unitCount: 3, observedAt: '2026-09-08T00:00:00Z' });

test('forest detail links to the independent Naver review page in the same tab', async () => {
  const forest = { ...cardForest(), regionId: '2', units: [] };
  const h = await setup({ forests: [forest], fetch: async ({ path }) => path.startsWith('/api/forests/forest-1?') ? { ok: true, json: async () => ({ forests: [{ ...forest, dates: { '20261012': [] } }] }) } : undefined });
  h.click('[data-open="forest-1"]'); await settled();
  const naver = h.$('detail').querySelector('[data-naver-reviews]');
  assert.equal(naver.getAttribute('href'), '/naver-reviews.html?forestId=forest-1');
  assert.equal(naver.getAttribute('target'), null);
});

test('a card update under multiple result regions submits only that forest and its region', async () => {
  const h = await setup({ catalog: multiRegionCatalog, forests: [{ ...cardForest(), regionId: '2' }] });
  h.change('sourceRegion', '9'); h.chooseRegion('1'); h.chooseRegion('2'); await h.app.refresh();
  await h.app.updateForest('forest-1');
  const sent = h.requests.filter(r => r.path === '/api/sync');
  assert.equal(sent.length, 1); assert.equal(sent[0].body.forestId, 'forest-1'); assert.equal(sent[0].body.region, '2');
  assert.equal(h.app.state.region, '1,2'); assert.equal(h.app.getDraft().region, '9');
  assert.equal(h.$('cardUpdateNotice').dataset.state, 'complete');
});

test('a card detail under multiple result regions reads the selected forest with a valid single region parameter', async () => {
  const h = await setup({ catalog: multiRegionCatalog, forests: [{ ...cardForest(), regionId: '2' }], fetch({ path }) {
    if (path.startsWith('/api/forests/forest-1?')) return { ok: true, json: async () => ({ forests: [{ ...cardForest({ '20261012': [] }), units: [] }] }) };
  } });
  h.chooseRegion('1'); h.chooseRegion('2'); await h.app.refresh();
  h.click('[data-open="forest-1"]');
  for (let n = 0; n < 10 && h.$('detailTitle').textContent !== '시험자연휴양림'; n++) await new Promise(setImmediate);
  const request = h.requests.find(r => r.path.startsWith('/api/forests/forest-1?'));
  assert.ok(request); assert.equal(new URL('http://local' + request.path).searchParams.get('region'), 'all');
  assert.equal(h.$('detailTitle').textContent, '시험자연휴양림'); assert.equal(h.$('detail').hasAttribute('open'), true);
  assert.equal(h.app.state.region, '1,2');
});

test('official detail links preserve the forest and result scope across facility types and day changes', async () => {
  for (const [type, code] of [['all', null], ['stay', '01'], ['camp', '02']]) {
    const forest = { ...cardForest(), id: 'ID02030062', regionId: '3' };
    const h = await setup({ catalog: { ...multiRegionCatalog, regions: [...multiRegionCatalog.regions, { id: '3', name: '충북' }] }, forests: [forest], fetch({ path }) {
      if (path.startsWith('/api/forests/ID02030062?')) return { ok: true, json: async () => ({ forests: [{ ...forest, dates: { '20261012': [] }, units: [] }] }) };
    } });
    h.chooseRegion('1'); h.chooseRegion('3');
    h.change('sourceMonth', '202609'); h.change('sourceRegion', '9'); h.click('[data-source-type="stay"]');
    h.click(`[data-type="${type}"]`); await h.app.refresh();
    h.click('[data-open="ID02030062"]');
    for (let n = 0; n < 10 && !h.$('detail').querySelector('a.primary'); n++) await settled();
    const link = h.$('detail').querySelector('a.primary'); assert.ok(link);
    const url = new URL(link.getAttribute('href'));
    assert.equal(url.origin, 'https://www.foresttrip.go.kr');
    assert.equal(url.pathname, '/rep/or/sssn/monthRsrvtStatus.do');
    assert.deepEqual(Object.fromEntries(url.searchParams), { hmpgId: 'FRIP', menuId: '001004', srchSido: '3', insttId: forest.id, srchMonth: '202610', ...(code ? { upperGoodsClsscCd: code } : {}) });
    assert.equal(link.getAttribute('target'), '_blank');
    assert.equal(link.getAttribute('rel'), 'noopener noreferrer');
    assert.match(h.$('detail').querySelector('.detail-notice').textContent, /입실일·인원·숙박일수는 공식 사이트에서 다시 선택/);
    if (type === 'all') assert.match(h.$('detail').querySelector('.detail-notice').textContent, /숙소 또는 야영장/);
    h.click('[data-detailday="13"]');
    assert.equal(h.$('detail').querySelector('a.primary').getAttribute('href'), url.href);
  }
});

test('card update uses result conditions, prevents duplicates, and keeps later filter edits', async () => {
  const step = deferred(), reachedStep = deferred();
  const h = await setup({ forests: [cardForest()], sync: input => jobFor({ ...input, status: 'running', remaining: 1 }), step: () => { reachedStep.resolve(); return step.promise; } });
  h.change('sourceMonth', '202609'); h.change('sourceNights', '3');
  h.click('[data-update-forest="forest-1"]'); await reachedStep.promise;
  const sent = h.requests.find(r => r.path === '/api/sync').body;
  assert.equal(sent.forestId, 'forest-1'); assert.equal(sent.month, '202610'); assert.equal(sent.nights, 1);
  assert.equal(h.$('cards').querySelector('[data-update-forest]').disabled, true);
  assert.match(h.$('cardUpdateNotice').textContent, /시험자연휴양림.*최신/s);
  await h.app.updateForest('forest-1');
  assert.equal(h.requests.filter(r => r.path === '/api/sync').length, 1);
  h.change('guests', '8');
  step.resolve(jobFor(sent));
  for (let n=0;n<10&&h.$('cardUpdateNotice').dataset.state==='running';n++) await new Promise(setImmediate);
  assert.equal(h.$('cardUpdateNotice').dataset.state, 'complete');
  assert.equal(h.app.state.guests, 8); assert.equal(h.$('sourceNights').value, '3');
  assert.equal(h.$('cards').querySelector('[data-update-forest]').disabled, false);
});

test('card removal after fresh availability still leaves completion feedback', async () => {
  let hasSpace = true;
  const h = await setup({ forests: () => [cardForest(hasSpace?undefined:{})], sync: input => { hasSpace=false; return jobFor(input); } });
  await h.app.updateForest('forest-1');
  assert.equal(h.$('cards').querySelector('[data-update-forest]'), null);
  assert.equal(h.$('cardUpdateNotice').hidden, false);
  assert.match(h.$('cardUpdateNotice').textContent, /최신 현황을 반영.*목록에서 빠졌/s);
});

test('card source failure keeps its old result and partial failures can retry', async () => {
  const failed = await setup({ forests: [cardForest()], reject: true });
  await failed.app.updateForest('forest-1');
  assert.equal(failed.$('cardUpdateNotice').dataset.state, 'error');
  assert.ok(failed.$('cards').querySelector('[data-update-forest]'));
  assert.match(failed.$('cards').querySelector('[data-update-forest]').textContent, /다시 업데이트/);
  const partial = await setup({ forests: [cardForest()], sync: input => jobFor({ ...input, status: 'partial', failures: [{ name: '숙소', message: '응답 지연' }] }) });
  await partial.app.updateForest('forest-1');
  assert.equal(partial.$('cardUpdateNotice').dataset.state, 'error');
  await partial.app.updateForest('forest-1');
  assert.ok(partial.requests.some(r => r.path === '/api/job/retry'));
  assert.equal(partial.requests.filter(r => r.path === '/api/sync').length, 1);
  assert.equal(partial.$('cardUpdateNotice').dataset.state, 'complete');
});

test('card update leaves a different unfinished job available for continuation', async () => {
  const h = await setup({ forests: [cardForest()], job: jobFor({ status: 'paused', remaining: 3 }, 'unfinished') });
  await h.app.updateForest('forest-1');
  assert.equal(h.requests.some(r => r.path === '/api/sync'), false);
  assert.equal(h.app.getJob().id, 'unfinished');
  assert.match(h.$('cardUpdateNotice').textContent, /진행 중이던 조회.*조회 진행 상태/s);
});

const orderOf = h => Array.from(h.$('cards').querySelectorAll('[data-update-forest]'), b=>b.dataset.updateForest);
const secondForest = { ...cardForest({'20261012':2,'20261013':2}),id:'forest-2',name:'두번째휴양림' };

test('individual update keeps card order after completion until explicit reorder or filter change', async () => {
  let dates={'20261012':3,'20261013':3,'20261014':3};
  const step=deferred(), reachedStep=deferred();
  const h=await setup({forests:()=>[cardForest(dates),secondForest],sync:input=>jobFor({...input,status:'running',remaining:1}),step:()=>{reachedStep.resolve();return step.promise;}});
  const pending=h.app.updateForest('forest-1');await reachedStep.promise;
  assert.deepEqual(orderOf(h),['forest-1','forest-2']);
  assert.match(h.$('cards').textContent,/기존 결과 유지/);
  dates={'20261012':1};step.resolve(jobFor());await pending;
  assert.deepEqual(orderOf(h),['forest-1','forest-2']);
  assert.match(h.$('cards').querySelector('.avail-heading').textContent,/총 1일/);
  assert.equal(h.$('resultOrderNotice').hidden,false);
  h.click('#reorderResults');assert.deepEqual(orderOf(h),['forest-2','forest-1']);
  assert.equal(h.$('resultOrderNotice').hidden,true);
  await h.app.updateForest('forest-1');h.change('guests','6');
  assert.equal(h.$('resultOrderNotice').hidden,true);
});

test('a lost accepted card update response reconnects Foresttrip once without starting another job', async () => {
  let lost=true;
  const h=await setup({forests:[cardForest()],fetch({path,body,setJob}){if(path==='/api/sync'&&lost){lost=false;setJob(jobFor({...body,onlyForestIds:[body.forestId]}));throw new TypeError('Failed to fetch');}}});
  await h.app.updateForest('forest-1');
  assert.equal(h.requests.filter(r=>r.path==='/api/sync').length,1);
  assert.equal(h.requests.filter(r=>r.path==='/api/session/connect').length,1);
  assert.equal(h.$('cardUpdateNotice').dataset.state,'complete');
  assert.deepEqual(h.priceInvalidations,['forest-1']);
  assert.match(h.$('networkMessage').textContent,/숲나들e.*다시 연결.*업데이트를 마쳤/s);
});

test('a lost completed step reconnects Foresttrip once and keeps the accepted completion', async () => {
  let lost=true;
  const h=await setup({forests:[cardForest()],sync:input=>jobFor({...input,status:'running',remaining:1}),fetch({path,job,setJob}){
    if(path==='/api/job/step'&&lost){lost=false;setJob(jobFor({...job,status:'complete',remaining:0}));throw new TypeError('Failed to fetch');}
  }});
  await h.app.updateForest('forest-1');
  assert.equal(h.requests.filter(r=>r.path==='/api/sync').length,1);
  assert.equal(h.requests.filter(r=>r.path==='/api/job/step').length,1);
  assert.equal(h.requests.filter(r=>r.path==='/api/session/connect').length,1);
  assert.equal(h.$('cardUpdateNotice').dataset.state,'complete');
});

test('exhausted transport recovery retains card and supports connection check then retry', async () => {
  let offline=false;
  const h=await setup({forests:[cardForest()],fetch(){if(offline)throw new TypeError('Failed to fetch');}});
  offline=true;await h.app.updateForest('forest-1');
  assert.equal(h.$('cardUpdateNotice').dataset.state,'error');
  assert.ok(h.$('cards').querySelector('[data-update-forest]'));
  assert.equal(h.$('checkConnection').hidden,false);
  assert.match(h.$('networkMessage').textContent,/저장된 결과는 유지/);
  offline=false;await h.app.checkConnection();await h.app.updateForest('forest-1');
  assert.equal(h.$('cardUpdateNotice').dataset.state,'complete');
});

test('repeated source network failures reconnect once and retry saved scopes once before stopping', async () => {
  const failing=input=>jobFor({...input,status:'partial',failures:[{name:'숙소',code:'NETWORK',message:'응답 지연'}]});
  const h=await setup({forests:[cardForest()],sync:failing,continueJob:(_,j)=>failing(j)});
  await h.app.updateForest('forest-1');
  assert.equal(h.requests.filter(r=>r.path==='/api/job/retry').length,1);
  assert.equal(h.requests.filter(r=>r.path==='/api/session/connect').length,1);
  assert.equal(h.requests.filter(r=>r.path==='/api/sync').length,1);
  assert.equal(h.$('cardUpdateNotice').dataset.state,'error');
  assert.equal(h.$('networkNotice').dataset.state,'failed');
});

test('HTTP source NETWORK reconnects once and retries the same step; repeated failure stops', async () => {
  for(const failsAgain of [false,true]){
    let calls=0;
    const h=await setup({forests:[cardForest()],sync:input=>jobFor({...input,status:'running',remaining:1}),step:()=>jobFor(),fetch({path}){
      if(path==='/api/job/step'&&(++calls===1||failsAgain))return{ok:false,json:async()=>({error:{code:'NETWORK',message:'숲나들e 응답 지연'}})};
    }});
    await h.app.updateForest('forest-1');
    assert.equal(h.requests.filter(r=>r.path==='/api/session/connect').length,1);
    assert.equal(h.requests.filter(r=>r.path==='/api/sync').length,1);
    assert.equal(h.requests.filter(r=>r.path==='/api/job/step').length,2);
    assert.equal(h.$('cardUpdateNotice').dataset.state,failsAgain?'error':'complete');
  }
});

test('expired source session reconnects once and resumes; a second expiry stops', async () => {
  for(const expiresAgain of [false,true]){
    const h=await setup({forests:[cardForest()],sync:input=>jobFor({...input,status:'auth_required',remaining:1}),continueJob:(_,j)=>jobFor({...j,status:expiresAgain?'auth_required':'complete',remaining:expiresAgain?1:0})});
    await h.app.updateForest('forest-1');
    assert.equal(h.requests.filter(r=>r.path==='/api/session/connect').length,1);
    assert.equal(h.requests.filter(r=>r.path==='/api/job/resume').length,1);
    assert.equal(h.$('cardUpdateNotice').dataset.state,expiresAgain?'error':'complete');
  }
});

test('source restrictions are not automatically retried or reconnected',async()=>{
  const h=await setup({forests:[cardForest()],sync:input=>jobFor({...input,status:'blocked',error:{code:'ACCESS_LIMIT',message:'조회 제한'},remaining:1})});
  await h.app.updateForest('forest-1');
  assert.equal(h.requests.some(r=>['/api/job/retry','/api/session/connect'].includes(r.path)),false);
  assert.equal(h.$('cardUpdateNotice').dataset.state,'error');
});

for (const region of ['all', '1,2']) test(`a never-connected browser sees a connect prompt and opens the dialog for regions ${region}`,async()=>{
  const availability={forests:[],coverage:{discovered:0,complete:0,pending:0,missingRegions:1,regionTotal:1},dataCoverage:{state:'connect-required',sharedScopes:0,fallbackScopes:0,missingScopes:0,emptyScopes:0,legacyForests:0},personal:{job:null,fallbackKeys:[],forests:{}}};
  const h=await setup({catalog:multiRegionCatalog,session:{connected:false,configured:false},fetch:async({path})=>{if(path.startsWith('/api/availability?'))return {ok:true,json:async()=>availability};}});
  if(region!=='all'){h.chooseRegion('1');h.chooseRegion('2');}
  const before=h.requests.length;
  await h.app.refresh();
  assert.deepEqual(h.requests.slice(before).filter(r=>r.path.startsWith('/api/availability?')).map(r=>new URL('http://local'+r.path).searchParams.get('region')),region.split(','));
  assert.match(h.$('coverageNote').textContent,/한 번 연결한 브라우저/);
  assert.doesNotMatch(h.$('coverageNote').textContent,/미조회|모아볼/);
  const empty=h.$('cards').querySelector('.empty');
  assert.equal(empty.dataset.state,'connect-required');
  assert.match(empty.querySelector('h3').textContent,/연결이 필요해요/);
  assert.doesNotMatch(empty.textContent,/확인하지 못했어요|가능한 숲이 없어요|조회하지 않은 범위/);
  h.click('[data-recover="connect"]');
  assert.equal(h.$('accountDialog').open,true);assert.equal(h.$('accountTitle').textContent,'숲나들e 연결');
  assert.equal(h.requests.some(r=>r.path==='/api/session/connect'),false,'no empty login attempt without saved credentials');
  h.click('#cancelAccount');
  assert.equal(h.$('accountDialog').open,false);assert.equal(h.app.state.region,region);
  assert.equal(h.$('cards').querySelector('.empty').dataset.state,'connect-required');
});

test('not-yet-collected and confirmed-empty states keep their own guidance',async()=>{
  const base={forests:[],coverage:{discovered:0,complete:0,pending:0,missingRegions:1,regionTotal:1},personal:{job:null,fallbackKeys:[],forests:{}}};
  const incomplete=await setup({fetch:async({path})=>{if(path.startsWith('/api/availability?'))return {ok:true,json:async()=>({...base,dataCoverage:{state:'incomplete'}})};}});
  await incomplete.app.refresh();
  assert.equal(incomplete.$('cards').querySelector('.empty').dataset.state,undefined);
  assert.match(incomplete.$('cards').textContent,/확인하지 못했어요/);assert.doesNotMatch(incomplete.$('cards').textContent,/연결이 필요해요/);
  const empty=await setup({fetch:async({path})=>{if(path.startsWith('/api/availability?'))return {ok:true,json:async()=>({...base,coverage:{discovered:1,complete:1,pending:0,missingRegions:0,regionTotal:1},dataCoverage:{state:'empty'}})};}});
  await empty.app.refresh();
  assert.match(empty.$('coverageNote').textContent,/조회된 시설이 없습니다/);assert.doesNotMatch(empty.$('cards').textContent,/연결이 필요해요/);
});

test('map/list switch preserves result conditions and propagates filtered results without another search', async()=>{
 const h=await setup({forests:[cardForest()]});const before=h.requests.length;
 h.click('#mapView');assert.equal(h.app.state.view,'map');assert.equal(h.$('cards').hidden,true);assert.equal(h.$('forestMap').hidden,false);
 assert.equal(h.$('mapView').getAttribute('aria-pressed'),'true');assert.match(h.filterUrls.at(-1),/view=map/);assert.equal(h.requests.length,before);
 h.app.state.search='없는 숲';h.click('#mapView');assert.equal(h.$('forestMap').hidden,true);assert.equal(h.$('cards').hidden,false);
 h.click('#listView');assert.equal(h.app.state.view,'list');assert.equal(h.$('cards').hidden,false);assert.equal(h.$('forestMap').hidden,true);
 assert.equal(h.app.state.guests,4);assert.equal(h.app.state.month,'202610');assert.doesNotMatch(h.filterUrls.at(-1),/view=map/);
});
