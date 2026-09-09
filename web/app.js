import { icon, esc, scene } from './ui.js';
import { observePrices, invalidatePrices } from './prices.js';
import { createApiClient } from './connection.js';
import { normalizeRegions, selectedRegionIds, fetchRegionAvailability, withPersonalState } from './regions.js';
const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()).replaceAll('-', '');
const state = { month: params.get('month') || today.slice(0, 6), region: normalizeRegions(params.get('region')), type: ['all','stay','camp'].includes(params.get('type')) ? params.get('type') : 'all', guests: Number(params.get('guests') || 2), nights: Number(params.get('nights') || 1), weekend: params.get('weekend') === 'true', includeWait: params.get('includeWait') === 'true', search: '', sort: 'days', day: null, savedOnly: false };
const sourceFields = ['month','region','type','guests','nights'];
const sourceValues = value => Object.fromEntries(sourceFields.map(key => [key,value[key]]));
let sourceDraft = {...sourceValues(state),region:selectedRegionIds(state.region).length>1?'all':state.region}, resultRevision = 0, shownJobId = null;
let session = { connected: false }, data = { forests: [], coverage: {} }, job = null, csrf = '', running = false, stopAction = null, requestNumber = 0, busy = false;
let detailId = null, detailDay = null, detailData = null, returnFocus = null, toastTimer, queryTimer;
let stopPrices = () => {};
let cardUpdate = null, resultOrder = null, connectionRecovery = null, transportFailures = 0;
let accountReturnFocus = null, accountPending = false;
let saved = new Set(), storageAvailable = true;
try { const ids = JSON.parse(localStorage.getItem('forest-gap-live-saved') || '[]'); if(Array.isArray(ids)) saved = new Set(ids.filter(x => typeof x === 'string')); } catch { storageAvailable = false; }
const week = ['일','월','화','수','목','금','토'];
const typeName = () => ({ all:'숙소·야영장',stay:'숙소',camp:'야영장' })[state.type];
const accountStorage = () => session.storageLocation==='hosted'?'이 브라우저 전용 서버 공간':'이 Mac';
const unitName = () => state.type === 'camp' ? '사이트' : state.type === 'stay' ? '객실' : '시설';
const monthName = () => `${state.month.slice(0,4)}년 ${Number(state.month.slice(4))}월`;
const dateOf = day => `${state.month}${String(day).padStart(2,'0')}`;
const dateObject = date => new Date(`${date.slice(0,4)}-${date.slice(4,6)}-${date.slice(6,8)}T12:00:00+09:00`);
const weekday = day => dateObject(dateOf(day)).getUTCDay();
const dateLabel = day => `${Number(state.month.slice(4))}.${day}(${week[weekday(day)]})`;
const daysInMonth = () => new Date(Date.UTC(Number(state.month.slice(0,4)),Number(state.month.slice(4)),0)).getUTCDate();
const stamp = value => value ? new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}).format(new Date(value)) : '미확인';
const sleep = ms => new Promise(resolve => setTimeout(resolve,ms));
const queryString = () => new URLSearchParams(Object.fromEntries(['month','region','type','guests','nights','weekend','includeWait'].map(k=>[k,String(state[k])]))).toString();
function persistFilters(){ history.replaceState(null,'',`${location.pathname}?${queryString()}`); }
function notify(message){ clearTimeout(toastTimer); $('toast').textContent=message;$('toast').classList.add('show');toastTimer=setTimeout(()=>$('toast').classList.remove('show'),3500); }
function showError(message){ $('connectionError').textContent=message||'';$('connectionError').hidden=!message; }
function showRecovery(value){
 connectionRecovery=value;
 $('networkNotice').hidden=!value;$('networkNotice').dataset.state=value?.status||'';
 $('networkMessage').textContent=value?.message||'';
 $('checkConnection').hidden=value?.status!=='failed';
 renderCardUpdates();
}
const api=createApiClient({fetcher:(...args)=>fetch(...args),getCsrf:()=>csrf,getJob:()=>job,getSession:()=>session,sleep,
 onSession:value=>{csrf=value.csrfToken;session={...session,...value};},
 onRecovery:value=>{if(value.status==='retrying')transportFailures++;showRecovery(value);}});
async function checkConnection(){
 busy=true;$('checkConnection').disabled=true;renderConnection();
 try{const value=await api('/api/session');csrf=value.csrfToken;session={...session,...value};job=value.job;
  if(!session.configured){openAccount();return;}
  showRecovery({status:'retrying',message:'숲나들e에 다시 연결하고 있어요.'});
  session={...session,...await api('/api/session/connect',{})};setCatalog();
  if(await refresh()){showError('');showRecovery({status:'recovered',message:'숲나들e에 다시 연결됐어요. 중단된 업데이트를 이어서 시도할 수 있어요.'});}}
 catch(e){showError(e.message);showRecovery({status:'failed',message:e.message});}
 finally{busy=false;$('checkConnection').disabled=false;renderConnection();}
}
function baseForests(){const q=state.search.trim().toLowerCase(),regions=selectedRegionIds(state.region);return data.forests.filter(f=>(!regions.length||!f.regionId||regions.includes(f.regionId))&&(!state.savedOnly||saved.has(f.id))&&(!q||`${f.name} ${f.region} ${f.city}`.toLowerCase().includes(q)));}
const waitIncluded = () => state.includeWait && state.nights === 1;
function countsFor(f,date){const value=f.dateCounts?.[date],old=f.dates[date];return {available:value?.available??(Array.isArray(old)?old.length:Number(old)||0),wait:waitIncluded()?(value?.wait||0):0};}
function countText(counts){return `예약 ${counts.available}개${waitIncluded()?` · 대기 ${counts.wait}개`:''}`;}
function dayList(f){return Object.keys(f.dates).filter(date=>{const c=countsFor(f,date);return c.available+c.wait>0;}).map(d=>Number(d.slice(6))).sort((a,b)=>a-b);}
function calendar(forests,chosen,detail=false){
 let html='';const offset=weekday(1);for(let i=0;i<offset;i++)html+='<span aria-hidden="true"></span>';
 for(let day=1;day<=daysInMonth();day++){
  const date=dateOf(day),past=date<today,counts=forests.map(f=>countsFor(f,date));
  const available=detail?(counts[0]?.available||0):counts.filter(c=>c.available>0).length;
  const waiting=detail?(counts[0]?.wait||0):counts.filter(c=>!c.available&&c.wait>0).length;
  const count=available+waiting,waitOnly=!available&&waiting>0;
  const description=waitIncluded()?`예약 ${available}개 · ${detail?'대기':'대기만'} ${waiting}개`:`${count}개 ${detail?unitName():'휴양림'} 가능 확인`;
  html+=`<button class="day ${past?'past':waitOnly?'wait-only':count>5?'plenty':count?'available':''} ${day===chosen?'selected':''} ${date===today?'today':''}" ${past?'disabled':''} data-${detail?'detailday':'day'}="${day}" aria-pressed="${day===chosen}" aria-label="${dateLabel(day)}, ${past?'지난 날짜':description}"><span>${day}</span><span class="count">${past?'·':count||'—'}</span></button>`;
 }return html;
}
const updateScopeKey = () => `${state.month}:${state.type}:${state.nights}`;
const updateViewKey = () => `${queryString()}:${state.search}:${state.day}:${state.savedOnly}:${state.sort}`;
function preserveResultOrder(){if(resultOrder?.key!==updateViewKey())resultOrder={key:updateViewKey(),ids:Array.from($('cards').querySelectorAll('[data-update-forest]'),button=>button.dataset.updateForest)};}
function reorderResults(){resultOrder=null;render();}
const cardUpdateFor = id => cardUpdate?.id===id&&cardUpdate.key===updateScopeKey()?cardUpdate:null;
function updateButtonText(id){const update=cardUpdateFor(id);return update?.status==='running'?'업데이트 중':update?.status==='paused'?'이어서 업데이트':update?.status==='error'?'다시 업데이트':'최신 업데이트';}
function renderCardUpdates(){
 document.querySelectorAll('[data-update-forest]').forEach(button=>{const update=cardUpdateFor(button.dataset.updateForest);button.disabled=running||busy||cardUpdate?.status==='running'||(job?.status==='running'&&update?.jobId!==job.id);button.setAttribute('aria-busy',String(update?.status==='running'));button.innerHTML=icon('reset',14)+updateButtonText(button.dataset.updateForest);const feedback=button.closest('.forest-card')?.querySelector('.card-update-feedback');if(feedback&&update?.status==='running')feedback.textContent=connectionRecovery?.status==='retrying'?connectionRecovery.message:'기존 결과 유지 · 완료 후 반영';});
 $('cardUpdateNotice').hidden=!cardUpdate;
 if(cardUpdate){$('cardUpdateNotice').dataset.state=cardUpdate.status;$('cardUpdateNotice').innerHTML=`<div><strong>${esc(cardUpdate.name)} · ${esc(cardUpdate.scopeLabel)}</strong><p>${esc(cardUpdate.status==='running'&&connectionRecovery?.status==='retrying'?connectionRecovery.message:cardUpdate.message)}</p></div>${cardUpdate.recovery==='connection'?'<button class="text-button" data-show-connection>연결 관리</button>':cardUpdate.recovery==='job'?'<button class="text-button" data-show-job>조회 진행 상태</button>':''}`;}
}
async function updateForest(id){
 if(running||busy||cardUpdate?.status==='running')return;
 const forest=data.forests.find(f=>f.id===id);if(!forest)return;
 const previous=cardUpdateFor(id),sameJob=previous?.jobId===job?.id;
 const continuing=sameJob&&job?.remaining>0;
 const retrying=sameJob&&job?.failures?.length>0;
 const context={id,name:forest.name,key:updateScopeKey(),viewKey:updateViewKey(),scopeLabel:`${Number(state.month.slice(4))}월 · ${typeName()} · ${state.nights}박`};
 if(!session.connected){cardUpdate={...context,status:'error',message:'숲나들e 연결 후 업데이트할 수 있어요.',recovery:'connection'};render();notify('숲나들e를 다시 연결해주세요.');return;}
 if(!sameJob&&(job?.status==='running'||job?.remaining>0||job?.failures?.length)){cardUpdate={...context,status:'paused',message:'진행 중이던 조회를 먼저 마쳐주세요.',recovery:'job'};render();notify('저장된 조회를 먼저 완료해주세요.');return;}
 preserveResultOrder();
 cardUpdate={...context,status:'running',message:'기존 결과를 유지하며 최신 현황을 조회 중이에요. 완료되면 한 번에 반영합니다.'};render();
 const result=await run(retrying?'retry':continuing?'resume':'start',retrying||continuing?undefined:id);
 cardUpdate.jobId=result?.job?.id;
 const complete=!result?.error&&result?.refreshed&&result?.job?.status==='complete'&&(retrying||continuing||result?.started);
 if(complete){
  cardUpdate.status='complete';cardUpdate.message='최신 현황을 반영했어요.';
  const updated=data.forests.find(f=>f.id===id);
  if(context.viewKey===updateViewKey()&&(!updated||(state.day?!dayList(updated).includes(state.day):!dayList(updated).length)))cardUpdate.message+=' 현재 조건에 맞는 자리가 없어 목록에서 빠졌어요.';
 }else{
  cardUpdate.status=['paused','cancelled'].includes(result?.job?.status)?'paused':'error';
  cardUpdate.message=result?.error?.message||result?.job?.error?.message||(cardUpdate.status==='paused'?'업데이트가 중지됐어요. 이어서 확인할 수 있어요.':result?.job?.status==='partial'?'일부 시설을 확인하지 못했어요. 다시 업데이트해주세요.':'최신 현황을 확인하지 못했어요. 다시 시도해주세요.');
  if(!session.connected)cardUpdate.recovery='connection';
 }
 render();notify(`${forest.name}: ${cardUpdate.message}`);
 if(!document.activeElement||document.activeElement===document.body){const target=$('cards').querySelector(`[data-update-forest="${CSS.escape(id)}"]`)||$('cardUpdateNotice');target.focus({preventScroll:true});}
}
function card(f){const update=cardUpdateFor(f.id);const days=dayList(f),shown=state.day?[state.day]:days,stats=countsFor(f,dateOf(state.day||days[0]||1)),availableDays=days.filter(day=>countsFor(f,dateOf(day)).available>0).length;return `<article class="forest-card"><div class="card-image">${scene(Number(f.id.replace(/\D/g,''))%4)}<span class="card-region">${icon('pin',11)} ${esc(f.region)}${f.city?' · '+esc(f.city):''}</span><button class="save-btn" data-save="${esc(f.id)}" aria-pressed="${saved.has(f.id)}" aria-label="${esc(f.name)} ${saved.has(f.id)?'찜 해제':'찜하기'}">${icon('heart',16)}</button><span class="image-caption">ILLUSTRATION · 실제 장소의 사진이 아닙니다</span></div><div class="card-body"><div class="card-kicker">${esc(f.operator)} 자연휴양림<i></i>${esc(typeName())}${f.coverage!=='complete'?'<span class="coverage-tag">일부 확인</span>':''}${f.stale?'<span class="coverage-tag">이전 확인</span>':''}</div><h3>${esc(f.name)}</h3><p class="card-description">${f.unitCount}개 시설 정보 · ${f.failed?'조회 실패 범위가 있어요':f.coverage==='complete'?'선택한 범위 확인':'남은 시설을 확인 중이에요'}</p><div class="availability"><div class="avail-heading"><strong>${state.day?`${dateLabel(state.day)} · ${stats.available+stats.wait}개 ${unitName()}`:`${Number(state.month.slice(4))}월 ${waitIncluded()?'예약·대기':'입실'} 가능 · 총 ${days.length}일`}</strong><small>${state.nights}박 · ${state.guests}명</small></div>${waitIncluded()?`<p class="card-status-summary">${state.day?countText(stats):`예약 가능 ${availableDays}일 · <span class="wait-count">대기만 ${days.length-availableDays}일</span>`}</p>`:''}<div class="date-chips">${shown.slice(0,4).map(d=>`<button class="date-chip ${!countsFor(f,dateOf(d)).available&&countsFor(f,dateOf(d)).wait?'wait-date':[5,6].includes(weekday(d))?'weekend-date':''}" data-open="${esc(f.id)}" data-date="${d}">${dateLabel(d)}${!countsFor(f,dateOf(d)).available&&countsFor(f,dateOf(d)).wait?' · 대기':''}</button>`).join('')}${shown.length>4?`<button class="date-more" data-open="${esc(f.id)}">+${shown.length-4}일</button>`:''}</div></div></div><p class="checked-at">${stamp(f.observedAt)} 확인${f.stale?' · 이전 확인':''}</p>${update?`<p class="card-update-feedback" data-state="${update.status}">${esc(update.status==='running'?(connectionRecovery?.status==='retrying'?connectionRecovery.message:'기존 결과 유지 · 완료 후 반영'):update.message)}</p>`:''}<div class="card-footer"><button class="detail-btn" data-open="${esc(f.id)}">가능한 날짜 보기 ${icon('arrow',15)}</button><button class="card-update-button" data-update-forest="${esc(f.id)}" aria-label="${esc(f.name)} 최신 업데이트" title="선택한 월과 머무는 방식으로 이 휴양림만 다시 조회">${icon('reset',14)}${updateButtonText(f.id)}</button></div></article>`;}
function render(){
 $('search').value=state.search;
 $('heroMonth').textContent=Number(state.month.slice(4))+'월';
 renderRegionPicker();
 for(const id of ['month','guests','nights','sort']) if($(id).querySelector(`option[value="${state[id]}"]`))$(id).value=state[id];
 $('weekend').checked=state.weekend;
 $('includeWait').checked=waitIncluded();$('includeWait').disabled=state.nights!==1;
 $('waitHint').hidden=!state.includeWait&&state.nights===1;
 $('waitHint').textContent=state.nights!==1?'예약 대기는 1박 조건에서 볼 수 있어요.':'대기는 예약 확정이 아니며, 취소 자리가 생기면 예약 기회를 받을 수 있어요. 대기 신청은 1박 기준입니다.';
 $('calendarCaption').textContent=waitIncluded()?'숫자는 예약·대기 가능한 휴양림 수 (중복 제외)':'날짜 아래 숫자는 예약 가능한 휴양림 수';$('waitLegend').hidden=!waitIncluded();
 document.querySelectorAll('[data-type]').forEach(b=>{const active=b.dataset.type===state.type;b.classList.toggle('active',active);b.setAttribute('aria-pressed',active);});
 $('savedCount').textContent=saved.size;$('savedNav').classList.toggle('active',state.savedOnly);$('exploreNav').classList.toggle('active',!state.savedOnly);$('savedNav').setAttribute('aria-pressed',state.savedOnly);$('exploreNav').setAttribute('aria-pressed',!state.savedOnly);
 const months=session.catalog?.months||[];const index=months.findIndex(m=>m.id===state.month);$('prevMonth').disabled=index<=0;$('nextMonth').disabled=index<0||index===months.length-1;$('calendarTitle').textContent=monthName();
 const forests=baseForests();$('calendar').innerHTML=calendar(forests,state.day);$('clearDate').hidden=!state.day;$('dateSummary').textContent=state.day?`${dateLabel(state.day)} 입실 · ${state.nights}박`:'날짜를 누르면 목록을 좁혀볼 수 있어요';
 if(resultOrder?.key!==updateViewKey())resultOrder=null;
 const matches=forests.filter(f=>state.day?dayList(f).includes(state.day):dayList(f).length);
 matches.sort((a,b)=>state.sort==='name'?a.name.localeCompare(b.name,'ko'):state.sort==='soon'?(dayList(a)[0]-dayList(b)[0]):dayList(b).length-dayList(a).length||a.name.localeCompare(b.name,'ko'));
 if(resultOrder){const rank=new Map(resultOrder.ids.map((id,index)=>[id,index]));matches.sort((a,b)=>(rank.get(a.id)??Infinity)-(rank.get(b.id)??Infinity));}
 $('resultOrderNotice').hidden=!resultOrder||!matches.length;
 $('resultsTitle').innerHTML=`${state.savedOnly?'찜한 숲 중 가능한 곳':waitIncluded()?'예약·대기 가능한 휴양림':'예약 가능한 휴양림'} <em>${matches.length}곳</em>`;
 $('resultsSub').textContent=`${state.day?dateLabel(state.day)+' 입실':monthName()} · ${typeName()} · ${state.nights}박 · ${state.guests}명${state.weekend?' · 금·토 입실':''}${waitIncluded()?' · 예약 대기 포함':''}`;
 $('resultAnnouncement').textContent=`확인된 범위에서 조건에 맞는 휴양림 ${matches.length}곳`;
 const c=data.coverage;
 $('coverageNote').textContent=c.discovered?`목록 ${c.discovered}곳 중 ${c.complete}곳 범위 확인 · ${c.pending}곳 미확인/일부 확인${c.missingRegions?` · ${c.missingRegions}개 지역 목록 미조회`:''}. 결과는 확인 시점 기준입니다.`:session.connected?'위에서 새 현황 검색을 시작해주세요.': '숲나들e를 연결하면 실제 월별 현황을 모아볼 수 있어요.';
 const connectRequired=data.dataCoverage?.state==='connect-required';
 if(connectRequired)$('coverageNote').textContent='공통 현황은 숲나들e를 한 번 연결한 브라우저에서 볼 수 있어요. 연결 정보는 이 브라우저 전용 공간에만 저장되고, 연결을 해제해도 저장된 결과는 계속 볼 수 있습니다.';
 else if(data.dataCoverage?.state==='personal-fallback')$('coverageNote').textContent+=' 공통 현황이 없는 범위는 이 브라우저에 보관된 이전 결과를 포함합니다.';
 else if(data.dataCoverage?.state==='empty')$('coverageNote').textContent='선택한 범위를 확인했으며 조회된 시설이 없습니다. 다른 지역이나 시설 유형으로 찾아보세요.';
 if(matches.length)$('cards').innerHTML=matches.map(card).join('');
 else{const noSaves=state.savedOnly&&!saved.size;const missing=!c.discovered||c.pending||c.missingRegions;
 // A browser that never connected is told to connect, not that data is missing or empty.
 if(!noSaves&&(connectRequired||(!data.dataCoverage?.state&&!session.connected&&!data.forests.length)))$('cards').innerHTML=`<div class="empty" data-state="connect-required"><div class="empty-icon">${icon('leaf',26)}</div><h3>숲나들e 연결이 필요해요</h3><p>함께 모은 월별 현황은 숲나들e를 한 번 연결한 브라우저에서 볼 수 있어요.<br>연결 후에는 연결을 해제해도 저장된 결과를 계속 볼 수 있습니다.</p><button class="primary" data-recover="connect">숲나들e 연결 ${icon('arrow',15)}</button></div>`;
 else $('cards').innerHTML=`<div class="empty"><div class="empty-icon">${icon(noSaves?'heart':'leaf',26)}</div><h3>${noSaves?'아직 찜한 숲이 없어요':!session.connected&&!data.forests.length?'이번 달, 어디로 떠날까요?':missing?'아직 가능한 숲을 확인하지 못했어요':'이 조건에 가능한 숲이 없어요'}</h3><p>${noSaves?'마음에 드는 휴양림의 하트를 눌러보세요.':!session.connected?'위에서 숲나들e를 연결하고 월별 조회를 시작해주세요.':running?'시설을 차례로 확인 중입니다. 완료한 범위부터 표시해요.':missing?'조회하지 않은 범위가 남아 있어요.<br>위에서 조회를 시작하거나 이어서 조회해주세요.':'다른 날짜나 인원·숙박일수로 찾아보세요.'}</p><button class="secondary" data-recover="${noSaves?'explore':state.day?'date':'conditions'}">${noSaves?'휴양림 둘러보기':state.day?'한 달 전체 보기':'조회 조건으로 이동'} ${icon('arrow',15)}</button></div>`;}
 renderConnection();
}
function setQueryExpanded(kind,expanded){
 const source=kind==='source';
 $(source?'sourceForm':'resultFilterPanel').dataset.collapsed=String(!expanded);
 const toggle=$(source?'sourceToggle':'resultToggle');toggle.setAttribute('aria-expanded',String(expanded));
 toggle.textContent=`${source?'조건':'필터'} ${expanded?'접기':'펼치기'}`;
 if(!expanded&&!source)closeRegionPicker();
}
function querySummary(value){
 const regions=selectedRegionIds(value.region),catalog=session.catalog;
 const region=regions.length?(catalog?.regions.find(r=>r.id===regions[0])?.name||regions[0])+(regions.length>1?` 외 ${regions.length-1}개 지역`:''):'전국';
 return `${Number(value.month.slice(4))}월 · ${region} · ${{all:'숙소·야영장',stay:'숙소',camp:'야영장'}[value.type]} · ${value.guests}명 · ${value.nights}박`;
}
function renderSource(){
 $('sourceSummary').textContent=querySummary(sourceDraft);
 $('resultSummary').textContent=querySummary(state)+(state.weekend?' · 금·토 출발':'')+(waitIncluded()?' · 대기 포함':'')+(state.search?` · “${state.search}”`:'');
 for(const key of ['month','region','guests','nights']){const input=$('source'+key[0].toUpperCase()+key.slice(1));if(input.querySelector(`option[value="${sourceDraft[key]}"]`))input.value=sourceDraft[key];}
 document.querySelectorAll('[data-source-type]').forEach(b=>{const active=b.dataset.sourceType===sourceDraft.type;b.classList.toggle('active',active);b.setAttribute('aria-pressed',active);});
}
function useResultConditions(){const multiple=selectedRegionIds(state.region).length>1;sourceDraft={...sourceValues(state),region:multiple?sourceDraft.region:state.region};if(multiple)notify('여행 조건을 불러왔어요. 새 현황을 조회할 지역은 위에서 선택해주세요.');renderSource();setQueryExpanded('source',true);$('sourceOptions').open=false;$('sourceForm').scrollIntoView({block:'center',behavior:'smooth'});$('sourceMonth').focus({preventScroll:true});}
function renderConnection(){
 renderSource();renderCardUpdates();
 $('copyResult').textContent=selectedRegionIds(state.region).length>1?'월·유형·인원·숙박일수 불러오기':'현재 결과 조건 불러오기';
 $('connectionState').textContent=busy?'숲나들e에 연결 중이에요':session.connected?'숲나들e 연결됨':'숲나들e 연결이 필요해요';
 $('connectionHint').textContent=session.configured?`${accountStorage()}에 저장한 계정으로 다시 연결합니다. 연결을 해제해도 저장된 계정은 유지돼요.`:`처음 연결할 때 숲나들e ID와 비밀번호를 입력해주세요. 로그인에 성공하면 ${accountStorage()}에 암호화해 저장합니다.`;
 $('savedAccount').hidden=!session.configured;$('savedAccount').textContent=session.configured?`저장된 계정 · ${session.accountLabel||'등록됨'}`:'';
 for(const id of ['changeAccount','forgetAccount']){$(id).hidden=!session.configured;$(id).disabled=busy||running;}
 $('savedSummary').textContent=!session.connected?'계정을 연결하면 월별 현황을 가져올 수 있어요. 저장된 결과는 연결 없이도 볼 수 있습니다.':data.forests.length?'저장된 현황에서 조건을 바꿔 찾아보세요.':'아래 ‘새 현황 검색’에서 여행 조건을 고르면 현황을 가져올 수 있어요.';
 $('sync').textContent=running?'검색 중':'검색';
 const needsConnection=!session.connected;
 $('connectInline').hidden=!needsConnection;$('connectInline').disabled=busy||running;$('connectInline').textContent=busy?'연결 중…':'숲나들e 연결';$('connectInline').setAttribute('aria-busy',String(busy));
 document.querySelector('.source-status').classList.toggle('needs-connection',needsConnection);
 $('sourceHint').hidden=needsConnection||(!running&&job?.status!=='running');
 $('sourceHint').textContent=running?'선택한 범위의 현황을 가져오는 중이에요. 결과 내 검색은 계속 사용할 수 있어요.':'진행 중이던 조회가 저장되어 있어요. 아래에서 이어서 조회할 수 있습니다.';
 $('headerConnectionStatus').textContent=busy?'연결 중':session.connected?'연결됨':'연결 필요';
 $('headerConnectionStatus').classList.toggle('connected',!!session.connected);
 $('connect').textContent=busy?'연결 중…':session.connected?'다시 연결':'숲나들e 연결';$('connect').classList.toggle('is-connected',!!session.connected);$('connect').setAttribute('aria-busy',String(busy));$('connect').disabled=busy||running;$('sync').disabled=!session.connected||busy||running||cardUpdate?.status==='running'||job?.status==='running';$('syncAll').disabled=$('sync').disabled||!session.catalog?.months?.length;$('disconnect').hidden=!session.connected;$('disconnect').disabled=running||busy;
 const catalog=session.catalog;
 $('allScope').textContent=catalog?`${catalog.months.map(m=>m.name).join(' · ')} / 전국 ${catalog.regions.length}개 지역 / 숙소·야영장`:'연결하면 조회 가능한 모든 월과 지역을 확인할 수 있어요.';
 $('jobPanel').hidden=!job;if(!job)return;if(shownJobId!==job.id){$('jobPanel').open=!['complete','cancelled'].includes(job.status);shownJobId=job.id;}
 const labels={running:running?'조회하고 있어요':'저장된 조회가 있어요',paused:'조회가 일시 중지됐어요',cancelled:'조회를 종료했어요',complete:'선택한 조회를 마쳤어요',partial:'일부 범위를 확인하지 못했어요',auth_required:'연결이 만료되어 조회를 멈췄어요',blocked:'원천에서 조회를 제한했어요'};
 const all=job.scope==='all';
 $('jobTitle').textContent=stopAction?'진행 중인 배치가 끝나면 멈춥니다':`${all?'전체 월·전국':Number(job.month.slice(4))+'월 · '+job.nights+'박'} · ${labels[job.status]||'조회 상태'}`;
 $('jobCount').textContent=`휴양림 ${job.completedForests||0}/${job.totalForests}곳 완료 · 월·유형별 시설 ${job.checkedUnits}건 확인`;
 $('jobScope').hidden=false;$('jobScope').textContent=all?`${job.listedMonths.map(m=>`${m.slice(0,4)}.${Number(m.slice(4))}`).join(' · ')} / ${job.regionsTotal}개 지역 / 숙소·야영장 · 월말 연박 확인용 다음 달 포함`:`${job.month.slice(0,4)}년 ${Number(job.month.slice(4))}월 / ${job.region==='all'?'전국':session.catalog?.regions.find(r=>r.id===job.region)?.name||job.region} / ${{all:'숙소·야영장',stay:'숙소',camp:'야영장'}[job.type]} · 시작 시 정한 조회 범위`;
 $('jobHelp').textContent=job.status==='complete'?'조회한 범위 안에서 월·지역·인원·숙박일수를 바꿔 결과를 찾아볼 수 있어요.':running?(job.onlyForestIds?.length?'이 휴양림의 기존 결과를 유지합니다. 모든 시설 확인을 마치면 한 번에 반영해요.':'완료한 범위부터 아래 결과에 반영됩니다. 이 화면을 열어두세요. 중지한 뒤 이어서 조회할 수 있어요.'):'조회 진행 상황이 저장되어 있어요. 남은 범위는 이어서 조회하거나 실패한 범위를 다시 조회해주세요.';
 const done=job.completedScopes+job.regionsDone,total=done+job.remaining+job.failures.length;
 $('jobProgress').max=Math.max(total,1);$('jobProgress').value=job.status==='complete'?Math.max(total,1):done;
 const current=job.current;
 $('jobDetail').textContent=job.waitUntil&&job.waitUntil>Date.now()?`정상 대기열에서 순서를 기다립니다. ${new Date(job.waitUntil).toLocaleTimeString('ko-KR')} 이후 확인합니다.`:job.error?.message|| (current?`${current.name} · ${current.month?Number(current.month.slice(4))+'월 · ':''}${current.type?({stay:'숙소',camp:'야영장'})[current.type]+' · ':''}${({region:'휴양림 목록 확인',policy:'숙박시설 정보 확인',queue:'대기열 및 시설 목록 확인',completeQueue:'대기열 완료 처리',days:`${current.checked}/${current.total}개 시설 날짜 확인`})[current.stage]}`:`지역 목록 ${job.regionsDone}/${job.regionsTotal}개 확인 · ${stamp(job.updatedAt)} 저장`);
 $('pause').hidden=!running;$('pause').disabled=!!stopAction;$('resume').hidden=running||!['running','paused','cancelled','auth_required','blocked'].includes(job.status)||!job.remaining;$('resume').disabled=!session.connected||busy;
 $('retry').hidden=running||!job.failures.length;$('retry').disabled=!session.connected||busy;$('cancel').hidden=running||!job.remaining||job.status==='cancelled';
 $('failures').hidden=!job.failures.length;$('failureSummary').textContent=`조회 실패 ${job.failures.length}개 범위 보기`;$('failureList').innerHTML=job.failures.map(f=>`<li>${esc(f.name)}${f.month?' · '+Number(f.month.slice(4))+'월':''}${f.type?' · '+({stay:'숙소',camp:'야영장'})[f.type]:''} — ${esc(f.message||'조회 실패')}</li>`).join('');
}
async function refresh(){const serial=++requestNumber;try{const result=await fetchRegionAvailability(api,queryString());if(serial!==requestNumber)return;data=result;if(!running)job=result.job;render();return true;}catch(e){if(serial===requestNumber)showError(e.message);return false;}}
function changed(keepDay=false){resultRevision++;if(!keepDay)state.day=null;persistFilters();render();clearTimeout(queryTimer);queryTimer=setTimeout(refresh,120);}
function accountError(message){$('accountError').textContent=message||'';$('accountError').hidden=!message;}
function openAccount(mode='connect'){
 accountReturnFocus=document.activeElement;accountError('');$('accountId').value='';$('accountPassword').value='';
 const forget=mode==='forget';$('accountForm').hidden=forget;$('forgetAccountForm').hidden=!forget;
 $('accountTitle').textContent=forget?'저장된 계정 삭제':session.configured?'숲나들e 계정 변경':'숲나들e 연결';
 $('accountDescription').textContent=forget?`${accountStorage()}에 저장한 ID·비밀번호와 로그인 연결을 삭제합니다. 조회 결과와 찜은 유지돼요.`:session.configured?'새 계정으로 로그인에 성공하면 저장된 계정을 바꿉니다. 실패하면 기존 계정을 유지해요.':'숲나들e 계정으로 연결하고 월별 현황을 가져오세요.';
 $('accountStorageNote').textContent=`로그인에 성공한 ID와 비밀번호를 ${accountStorage()}에 암호화해 저장합니다. ${session.storageLocation==='hosted'?'같은 브라우저에서 30일 동안 다시 연결할 수 있어요. 공용 기기에서는 이용 후 저장된 계정을 삭제해주세요.':'다음 연결부터 자동으로 사용해요.'}`;
 $('accountDialog').showModal();(forget?$('cancelForgetAccount'):$('accountId')).focus();
}
function closeAccount(){if(accountPending)return;$('accountId').value='';$('accountPassword').value='';$('accountDialog').close();}
function setAccountPending(value){
 accountPending=value;for(const el of $('accountDialog').querySelectorAll('input,button'))el.disabled=value;
 $('accountDialog').setAttribute('aria-busy',String(value));$('saveAccount').textContent=value?'연결 중…':'연결하고 저장';$('confirmForgetAccount').textContent=value?'삭제 중…':'저장된 계정 삭제';
}
async function connect(credentials){
 if(busy||running)return;
 if(!credentials&&!session.configured){openAccount();return;}
 const entered=!!credentials;busy=true;showError('');accountError('');if(entered)setAccountPending(true);renderConnection();
 try{const result=await api('/api/session/connect',credentials||{});session={...session,...result};setCatalog();
  setQueryExpanded('source',true);
  if(entered){setAccountPending(false);accountReturnFocus=$('sourceMonth');closeAccount();}
  await refresh();$('sourceForm').scrollIntoView({block:'center',behavior:'smooth'});$('sourceMonth').focus({preventScroll:true});showRecovery(null);notify(entered?'계정을 저장하고 연결했어요. 조회 조건을 골라주세요.':'숲나들e에 다시 연결했어요. 조회를 시작하거나 이어서 진행해주세요.');
 }catch(e){
  if(entered){accountError(e.message);}
  else{if(e.code==='AUTH_REQUIRED')session.connected=false;showError(e.message);if(e.code==='CREDENTIALS_REQUIRED')session.configured=false;if(['CREDENTIALS_REQUIRED','AUTH_REQUIRED'].includes(e.code))openAccount();}
 }finally{credentials=null;busy=false;if(entered){setAccountPending(false);$('accountPassword').value='';if($('accountDialog').open)$('accountPassword').focus();}renderConnection();}
}
async function forgetAccount(){
 if(busy||running)return;busy=true;setAccountPending(true);accountError('');renderConnection();
 try{const result=await api('/api/session/forget',{});session={...session,...result};if(result.job)job=result.job;
  setAccountPending(false);accountReturnFocus=$('connect');closeAccount();await refresh();showError('');showRecovery(null);notify('저장된 계정과 연결을 삭제했어요. 조회 결과와 찜은 유지됩니다.');
 }catch(e){accountError(e.message);}finally{busy=false;setAccountPending(false);renderConnection();}
}
function setCatalog(){
 const catalog=session.catalog;if(!catalog)return;const months=catalog.months,regions=catalog.regions;
 const monthOptions=months.map(m=>`<option value="${esc(m.id)}">${esc(m.name)}</option>`).join('');
 const regionOptions='<option value="all">전국 모든 지역</option>'+regions.map(r=>`<option value="${esc(r.id)}">${esc(r.name)}</option>`).join('');
 for(const id of ['month','sourceMonth']){$(id).innerHTML=monthOptions;$(id).disabled=!months.length;}
 $('sourceRegion').innerHTML=regionOptions;
 $('regionOptions').innerHTML=[{id:'all',name:'전국 모든 지역'},...regions].map(r=>`<label class="region-option"><input type="checkbox" value="${esc(r.id)}" data-result-region><span>${esc(r.name)}</span></label>`).join('');
 state.region=normalizeRegions(state.region,regions);
 for(const target of [state,sourceDraft]){if(months.length&&!months.some(m=>m.id===target.month))target.month=months[0].id;if(target===sourceDraft&&target.region!=='all'&&!regions.some(r=>r.id===target.region))target.region='all';}
 renderSource();renderRegionPicker();persistFilters();
}
async function run(action='start',forestId,selection=null){
 if(running)return;
 const submitted=selection?{...sourceValues(selection),weekend:false,includeWait:false}:null;
 const previousJobId=job?.id,revision=resultRevision;
 let runError=null,refreshed=false,sourceReconnected=false;
 const transportAtStart=transportFailures;
 async function reconnectSource(){
  sourceReconnected=true;
  showRecovery({status:'retrying',message:'연결 오류로 숲나들e에 자동으로 다시 연결하고 있어요.'});
  const value=await api('/api/session/connect',{});session={...session,...value};setCatalog();
  showRecovery({status:'recovered',message:'숲나들e에 다시 연결됐어요. 저장된 진행 상황부터 이어갑니다.'});
 }
 async function reconnectAfterTransport(){
  if(transportFailures>transportAtStart&&!sourceReconnected&&session.configured===true&&!stopAction)await reconnectSource();
 }
 async function requestJob(path,body){
  let result;
  try{result=await api(path,body);}catch(e){
   if(!['AUTH_REQUIRED','NETWORK'].includes(e.code)||sourceReconnected||session.configured!==true)throw e;
   await reconnectSource();result=await api(path,body);
  }
  // Keep the accepted job if its response was lost; reconnect must not start it again.
  if(result.job)job=result.job;
  await reconnectAfterTransport();return result;
 }
 running=true;stopAction=null;showError('');showRecovery(null);renderConnection();
 try{
  const start=action==='start'||action==='all';
  const result=await requestJob(start?'/api/sync':`/api/job/${action}`,action==='all'?{scope:'all'}:action==='start'?{...(submitted||state),...(forestId?{forestId,region:data.forests.find(f=>f.id===forestId)?.regionId||(selectedRegionIds(state.region).length>1?'all':state.region)}:{})}:{});
  job=result.job;
  // Apply only a newly accepted search, once; later result edits remain independent.
  const accepted=submitted&&job?.id!==previousJobId&&job?.scope!=='all'&&['month','region','type','nights'].every(key=>job[key]===submitted[key]);
  if(accepted&&revision===resultRevision){resultOrder=null;clearTimeout(queryTimer);requestNumber++;Object.assign(state,submitted,{search:'',day:null,savedOnly:false});resultRevision++;persistFilters();await refresh();}
  renderConnection();$('jobPanel').open=true;

  while(job&&!stopAction){
   if(job.status==='auth_required'&&!sourceReconnected&&session.configured===true){await reconnectSource();job=(await api('/api/job/resume',{})).job;continue;}
   if(job.status==='partial'&&job.failures.length&&job.failures.every(f=>f.code==='NETWORK')&&!sourceReconnected&&session.configured===true){
    await reconnectSource();if(stopAction)break;
    job=(await requestJob('/api/job/retry',{})).job;continue;
   }
   if(job.status!=='running')break;
   if(job.waitUntil>Date.now()){await sleep(Math.min(1000,job.waitUntil-Date.now()));renderConnection();continue;}
   try{job=(await requestJob('/api/job/step',{})).job;}catch(e){if(e.code==='BUSY'){await sleep(1000);continue;}throw e;}
   renderConnection();await refresh();await reconnectAfterTransport();await sleep(350);
  }
  if(stopAction)job=(await api(`/api/job/${stopAction}`,{})).job;
  if(job?.status==='auth_required'){session.connected=false;showRecovery({status:'failed',message:'숲나들e 자동 재연결에 실패했어요. 연결 관리에서 로그인 상태를 확인해주세요.'});}
  if(job?.status==='complete'&&sourceReconnected)showRecovery({status:'recovered',message:'숲나들e에 다시 연결하고 업데이트를 마쳤어요.'});
  else if(connectionRecovery?.status==='retrying'||(sourceReconnected&&job?.status!=='complete'))showRecovery({status:'failed',message:'다시 연결한 뒤에도 업데이트를 마치지 못했어요. 기존 결과와 조회 진행 상황은 유지됩니다.'});
  if(job?.status==='complete')for(const id of job.onlyForestIds||[])invalidatePrices(id);
  if(detailId)await loadDetail(detailId,false);
 }catch(e){runError=e;showError(e.message);if(e.code==='AUTH_REQUIRED')session.connected=false;showRecovery({status:'failed',message:e.message});}
 finally{running=false;stopAction=null;refreshed=runError?.code==='NETWORK_OFFLINE'?false:await refresh();renderConnection();}
 return {job,error:runError,refreshed,started:job?.id!==previousJobId};
}
function toggleSaved(id){saved.has(id)?saved.delete(id):saved.add(id);try{localStorage.setItem('forest-gap-live-saved',JSON.stringify([...saved]));}catch{storageAvailable=false;}render();if(detailData)renderDetail();notify(storageAvailable?(saved.has(id)?'찜한 숲에 저장했어요.':'찜을 해제했어요.'):'브라우저 저장이 제한되어 이번 화면에서만 유지됩니다.');}
async function loadDetail(id,open=true,day=null,trigger=null){
 if(open){detailId=id;detailDay=day||state.day;returnFocus=trigger;$('detailContent').innerHTML='<div class="dialog-head"><h2 id="detailTitle">시설 현황을 불러오고 있어요</h2><button class="close-btn" data-close aria-label="상세 닫기">'+icon('close',18)+'</button></div><div class="dialog-content"><p>저장된 날짜별 상태를 확인합니다.</p></div>';$('detail').showModal();}
 try{const detailQuery=new URLSearchParams(queryString());detailQuery.set('region','all');const result=withPersonalState(await api(`/api/forests/${encodeURIComponent(id)}?${detailQuery}`));if(detailId!==id)return;detailData=result.forests[0];if(!detailData)throw new Error('시설 정보가 없습니다. 다시 조회해주세요.');detailDay=detailDay||dayList(detailData)[0]||Math.max(1,state.month===today.slice(0,6)?Number(today.slice(6)):1);renderDetail();if(open)$('detail').querySelector('[data-close]')?.focus({preventScroll:true});}
 catch(e){if(detailId!==id)return;$('detailContent').innerHTML=`<div class="dialog-head"><h2 id="detailTitle">시설 정보를 불러오지 못했어요</h2><button class="close-btn" data-close aria-label="상세 닫기">${icon('close',18)}</button></div><div class="dialog-content"><p>${esc(e.message)}</p><button class="secondary" data-detailretry>다시 불러오기</button></div>`;}
}
function renderDetail(){if(!detailId||!detailData)return;stopPrices();const f=detailData,date=dateOf(detailDay),possible=(f.dates[date]||[]).filter(u=>waitIncluded()||u.bookingState!=='wait'),stats=countsFor(f,date),end=dateObject(date);end.setUTCDate(end.getUTCDate()+state.nights);const names={available:'공실',wait:state.nights===1?'예약 대기':'대기는 1박만',full:'예약 완료',unopened:'미개시',closed:'휴무·공사',priority:'우선예약',lottery:'추첨',past:'지난 날짜',unknown:'확인 필요'};
 const rank=u=>{const match=possible.find(p=>p.id===u.id&&p.type===u.type);return match?(match.bookingState==='wait'?1:2):0;};
 const units=f.units.filter(u=>u.capacity===null||u.capacity>=state.guests).sort((a,b)=>rank(b)-rank(a)||a.name.localeCompare(b.name,'ko'));
 $('detailContent').innerHTML=`<div class="dialog-head"><div><div class="kicker">${esc(f.region)} · ${esc(f.operator)} 자연휴양림</div><h2 id="detailTitle">${esc(f.name)}</h2></div><button class="close-btn" data-close aria-label="시설 상세 닫기">${icon('close',18)}</button></div><div class="dialog-content"><div class="detail-preview"><div class="detail-scene">${scene(Number(f.id.replace(/\D/g,''))%4)}</div><div><p>${stamp(f.observedAt)} 확인${f.stale?' · 이전 확인 결과':''}<br>${f.coverage==='complete'?'선택한 범위 확인':'일부 범위만 확인했습니다.'}</p><div class="tags"><span class="tag">${typeName()} · ${state.guests}명 · ${state.nights}박</span></div></div></div><div class="detail-layout"><section class="detail-calendar" aria-label="입실 날짜 선택"><div class="calendar-heading"><h3>${Number(state.month.slice(4))}월 입실일</h3></div><div class="weekday" aria-hidden="true">${week.map(d=>`<span>${d}</span>`).join('')}</div><div class="calendar-grid">${calendar([f],detailDay,true)}</div><p class="detail-legend">숫자 = ${state.guests}명 · ${state.nights}박 ${waitIncluded()?'예약·대기 가능한':'가능한'} ${unitName()} 수${waitIncluded()?'<br>파란색 = 대기만 가능':''}</p></section><section aria-label="날짜별 시설 현황"><h3 class="rooms-head">${dateLabel(detailDay)} 입실 · ${possible.length}개 ${waitIncluded()?'예약·대기':'가능'}</h3>${waitIncluded()?`<p class="state-counts"><span class="available-count">예약 가능 ${stats.available}개</span><span class="wait-count">예약 대기 ${stats.wait}개</span></p>`:''}<p class="stay-summary">${Number(state.month.slice(4))}월 ${detailDay}일 → ${end.getUTCMonth()+1}월 ${end.getUTCDate()}일 퇴실</p><div class="room-list">${units.length?units.map(u=>{const match=possible.find(p=>p.id===u.id&&p.type===u.type),available=!!match&&match.bookingState!=='wait',inventory=u.days[date]?.state||'unknown';return `<div class="room"><div><div class="room-name">${esc(u.name)}</div><div class="room-cap">${u.capacity===null?'정원 확인 필요':'최대 '+u.capacity+'명'} · ${u.type==='stay'?'숙소':'야영장'}${u.maxNights>0?' · 최대 '+u.maxNights+'박':''}</div></div><span class="room-status" data-state="${available?'available':inventory==='wait'&&state.nights===1?'wait':'unknown'}">${available?'예약 가능':inventory==='available'?'조건 확인 필요':names[inventory]}</span><div class="room-price" ${['available','wait','full'].includes(inventory)?`data-price-unit="${esc(u.id)}" data-price-type="${esc(u.type)}"`:''}>${['available','wait','full'].includes(inventory)?'<span class="price-pending">요금 확인 중…</span>':'<span class="price-unavailable">요금은 숲나들e에서 확인해주세요.</span>'}</div></div>`;}).join(''):'<div class="room-empty">조건에 맞는 시설 정보가 없습니다. 다른 조건으로 조회해주세요.</div>'}</div></section></div><div class="detail-notice">${waitIncluded()?'예약 가능은 공실이 있는 시설, 예약 대기는 취소 자리를 기다리는 시설입니다. 대기 신청은 예약 확정이 아니며 1박 기준입니다.':'선택한 인원과 모든 숙박일의 공실을 확인한 결과입니다.'} 요금은 선택한 숙박기간의 시설 기본요금이며, 추가인원·옵션·감면에 따라 최종 결제금액이 달라질 수 있습니다. 별도 예약 자격·이용 조건과 최신 상태는 숲나들e에서 최종 확인해주세요. 공식 링크에 선택 조건이 자동 전달되지는 않습니다.</div><button class="secondary refresh-detail" data-refresh-forest ${running?'disabled':''}>이 휴양림 다시 조회</button></div><div class="dialog-actions"><button class="secondary" data-save="${esc(f.id)}" aria-pressed="${saved.has(f.id)}">${icon('heart',16)} ${saved.has(f.id)?'찜한 숲':'이 숲 찜하기'}</button><a class="primary" href="https://www.foresttrip.go.kr/rep/or/sssn/monthRsrvtSmplStatus.do" target="_blank" rel="noopener noreferrer">숲나들e에서 확인 ${icon('external',15)}</a></div>`;
 stopPrices=observePrices($('detailContent'),{forestId:f.id,date,nights:state.nights,guests:state.guests,api,priceVersion:f.priceVersion});
}
function renderRegionPicker(){
 const ids=selectedRegionIds(state.region),regions=session.catalog?.regions||[];
 const names=ids.map(id=>regions.find(r=>r.id===id)?.name||id);
 const label=!ids.length?'전국 모든 지역':names.length===1?names[0]:`${names[0]} 외 ${names.length-1}개 지역`;
 $('region').value=state.region;$('regionSummary').innerHTML=names.length>1?`${esc(names[0])} <span class="region-count">외 ${names.length-1}개 지역</span>`:esc(label);$('regionToggle').title=names.join(' · ')||label;
 $('regionToggle').setAttribute('aria-label',`여행 지역: ${names.join(', ')||label}, 여러 지역 선택`);
 document.querySelectorAll('[data-result-region]').forEach(input=>input.checked=input.value==='all'?!ids.length:ids.includes(input.value));
}
function closeRegionPicker(focus=false){$('regionPanel').hidden=true;$('regionToggle').setAttribute('aria-expanded','false');if(focus)$('regionToggle').focus({preventScroll:true});}
$('regionToggle').addEventListener('click',()=>{const open=$('regionPanel').hidden;$('regionPanel').hidden=!open;$('regionToggle').setAttribute('aria-expanded',String(open));if(open)$('regionOptions').querySelector('input')?.focus({preventScroll:true});});
$('regionDone').addEventListener('click',()=>closeRegionPicker(true));
$('regionPicker').addEventListener('keydown',e=>{if(e.key==='Escape'){e.preventDefault();closeRegionPicker(true);}});
$('regionPicker').addEventListener('focusout',e=>{if(e.relatedTarget&&!$('regionPicker').contains(e.relatedTarget))closeRegionPicker();});
document.addEventListener('click',e=>{if(!$('regionPicker').contains(e.target))closeRegionPicker();});
$('regionOptions').addEventListener('change',e=>{const input=e.target.closest('[data-result-region]');if(!input)return;const ids=selectedRegionIds(state.region);state.region=input.value==='all'?'all':normalizeRegions(input.checked?[...ids,input.value]:ids.filter(id=>id!==input.value),session.catalog?.regions);changed();});
for(const id of ['month','region','guests','nights'])$(id).addEventListener('change',e=>{state[id]=['guests','nights'].includes(id)?Number(e.target.value):e.target.value;changed();});
$('includeWait').addEventListener('change',e=>{state.includeWait=e.target.checked;changed(true);});
$('weekend').addEventListener('change',e=>{state.weekend=e.target.checked;changed();});$('sort').addEventListener('change',e=>{resultRevision++;state.sort=e.target.value;reorderResults();});$('search').addEventListener('input',e=>{resultRevision++;state.search=e.target.value;render();});
$('reorderResults').addEventListener('click',reorderResults);
$('checkConnection').addEventListener('click',checkConnection);
$('clearDate').addEventListener('click',()=>{resultRevision++;state.day=null;render();});
for(const [id,delta] of [['prevMonth',-1],['nextMonth',1]])$(id).addEventListener('click',()=>{const months=session.catalog?.months||[];const m=months[months.findIndex(m=>m.id===state.month)+delta];if(m){state.month=m.id;changed();}});
function reset(){Object.assign(state,{region:'all',type:'all',guests:2,nights:1,weekend:false,includeWait:false,search:'',day:null,sort:'days'});$('search').value='';changed();}
$('reset').addEventListener('click',reset);$('brand').addEventListener('click',e=>{e.preventDefault();state.savedOnly=false;reset();window.scrollTo({top:0,behavior:'smooth'});});
for(const [id,only] of [['exploreNav',false],['savedNav',true]])$(id).addEventListener('click',()=>{state.savedOnly=only;state.day=null;render();});
for(const key of ['month','region','guests','nights'])$('source'+key[0].toUpperCase()+key.slice(1)).addEventListener('change',e=>{sourceDraft[key]=['guests','nights'].includes(key)?Number(e.target.value):e.target.value;renderSource();});
for(const kind of ['source','result'])$(kind+'Toggle').addEventListener('click',()=>setQueryExpanded(kind,$(kind+'Toggle').getAttribute('aria-expanded')!=='true'));
$('connectInline').addEventListener('click',()=>connect());
$('sourceReset').addEventListener('click',()=>{sourceDraft={...sourceDraft,region:'all',type:'all',guests:2,nights:1};renderSource();});
$('copyResult').addEventListener('click',useResultConditions);
$('sourceForm').addEventListener('submit',e=>{e.preventDefault();if(!$('sync').disabled)run('start',undefined,sourceDraft);});
$('connect').addEventListener('click',()=>connect());$('syncAll').addEventListener('click',()=>{$('sourceOptions').open=false;run('all');});$('resume').addEventListener('click',()=>run('resume'));$('retry').addEventListener('click',()=>run('retry'));$('pause').addEventListener('click',()=>{stopAction='pause';renderConnection();});
$('changeAccount').addEventListener('click',()=>openAccount());$('forgetAccount').addEventListener('click',()=>openAccount('forget'));
for(const id of ['closeAccount','cancelAccount','cancelForgetAccount'])$(id).addEventListener('click',closeAccount);
$('accountDialog').addEventListener('cancel',e=>{e.preventDefault();closeAccount();});
$('accountDialog').addEventListener('close',()=>{$('accountId').value='';$('accountPassword').value='';if(accountReturnFocus?.isConnected)accountReturnFocus.focus({preventScroll:true});});
$('accountForm').addEventListener('submit',e=>{e.preventDefault();const id=$('accountId').value.trim(),password=$('accountPassword').value;if(!id||!password){accountError('ID와 비밀번호를 모두 입력해주세요.');(!id?$('accountId'):$('accountPassword')).focus();return;}connect({id,password});});
$('forgetAccountForm').addEventListener('submit',e=>{e.preventDefault();forgetAccount();});
$('cancel').addEventListener('click',async()=>{try{job=(await api('/api/job/cancel',{})).job;renderConnection();}catch(e){showError(e.message);}});
$('disconnect').addEventListener('click',async()=>{if(busy||running)return;busy=true;renderConnection();try{session={...session,...await api('/api/session/disconnect',{})};await refresh();notify('연결을 해제했어요. 저장된 계정과 조회 결과는 유지됩니다.');}catch(e){showError(e.message);}finally{busy=false;renderConnection();}});
$('introArt').innerHTML=scene(0)+'<span class="art-caption">SLOW DAYS, GREEN STAYS</span>';
for(const id of ['detail','about']){$(id).addEventListener('click',e=>{if(e.target===$(id)){const r=$(id).getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)$(id).close();}});}
$('aboutBtn').addEventListener('click',()=>$('about').showModal());$('closeAbout').addEventListener('click',()=>$('about').close());$('startExploring').addEventListener('click',()=>$('about').close());
$('detail').addEventListener('close',()=>{stopPrices();detailId=null;detailData=null;if(returnFocus?.isConnected)returnFocus.focus({preventScroll:true});else { const trigger=$('cards').querySelector(`[data-open="${CSS.escape(returnFocus?.dataset?.open||'')}"]`);if(trigger)trigger.focus({preventScroll:true});else $('savedNav').focus({preventScroll:true}); }});
document.addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;
 if(b.dataset.sourceType){sourceDraft.type=b.dataset.sourceType;renderSource();}
 else if(b.dataset.updateForest)updateForest(b.dataset.updateForest);
 else if(b.hasAttribute('data-show-job')){$('jobPanel').open=true;$('jobPanel').scrollIntoView({block:'center',behavior:'smooth'});$('jobPanel').querySelector('summary').focus({preventScroll:true});}
 else if(b.hasAttribute('data-show-connection')){$('sourceOptions').open=false;$('connect').focus();}
 else if(b.dataset.type){state.type=b.dataset.type;changed();}
 else if(b.dataset.save){const id=b.dataset.save,inDetail=!!b.closest('dialog');toggleSaved(id);(inDetail?$('detail'):$('cards')).querySelector(`[data-save="${CSS.escape(id)}"]`)?.focus({preventScroll:true});}
 else if(b.dataset.open)loadDetail(b.dataset.open,true,Number(b.dataset.date)||null,b);
 else if(b.dataset.day){resultRevision++;state.day=state.day===Number(b.dataset.day)?null:Number(b.dataset.day);render();$('calendar').querySelector(`[data-day="${b.dataset.day}"]`)?.focus({preventScroll:true});}
 else if(b.dataset.detailday){detailDay=Number(b.dataset.detailday);renderDetail();$('detail').querySelector(`[data-detailday="${detailDay}"]`)?.focus({preventScroll:true});}
 else if(b.hasAttribute('data-close'))$('detail').close();
 else if(b.hasAttribute('data-detailretry'))loadDetail(detailId,false);
 else if(b.hasAttribute('data-refresh-forest')){const id=detailId;$('detail').close();updateForest(id);}
 else if(b.dataset.recover){if(b.dataset.recover==='explore'){state.savedOnly=false;render();}else if(b.dataset.recover==='date'){state.day=null;render();}else if(b.dataset.recover==='connect')connect();else{useResultConditions();if(!session.connected){$('sourceOptions').open=false;$('connect').focus();}}}
});
render();
try{session=await api('/api/session');csrf=session.csrfToken;job=session.job;setCatalog();await refresh();}catch(e){showError(e.message);}renderConnection();
