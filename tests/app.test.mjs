import test from 'node:test';import assert from 'node:assert/strict';
import{Store}from'../server/store.mjs';import{sqlite}from'../server/sqlite.mjs';import{createApp}from'../server/app.mjs';import{SourceError}from'../server/foresttrip.mjs';import{monthDates,kstToday,addDays,nextMonth}from'../server/domain.mjs';
class FixtureSource{
 static failCamp=false;static calls=[];static priceCalls=[];static failPrice=false;
 constructor(auth){this.connectedAt=auth?.connectedAt;}
 export(){return{connectedAt:this.connectedAt,cookies:{fixture:'private-cookie'}};}
 async login(){this.connectedAt=new Date().toISOString();return{today:kstToday(),months:[{id:kstToday().slice(0,6),name:'이번 달'}],regions:[{id:'1',name:'경기'}]};}
 async forests(){return[{id:'0101',name:'검증용 휴양림',region:'경기',regionId:'1'}];}
 async policy(){return{types:[{upperGoodsClsscCd:'01'},{upperGoodsClsscCd:'02'}],lastDay:'20991231'};}
 async queue(){return{key:'fixture',raw:'fixture',granted:true,waitUntil:0};}
 async completeQueue(){}
 async goods(scope){const count=scope.upperGoodsClsscCd==='01'?6:1;return{netfunnelRslt:'Y',rsrvtGoodsList:Array.from({length:count},(_,i)=>({goodsId:'g'+i,goodsNm:'시설'+i,mxmmAccptCnt:4,mxmmStngDayCnt:3})),hldtInfoList:[]};}
 async price(query){FixtureSource.priceCalls.push(query);if(FixtureSource.failPrice)throw new SourceError('PRICE_UNAVAILABLE','요금 확인 불가');return{...query,baseTotal:120000*query.nights,observedAt:new Date().toISOString()};}
 async days(scope,ids){FixtureSource.calls.push(ids.length);if(FixtureSource.failCamp&&scope.upperGoodsClsscCd==='02')throw new SourceError('NETWORK','fixture failure');return ids.flatMap(goodsId=>monthDates(scope.srchDate).map(useDt=>({goodsId,useDt,rsrvtAvail:'Y',rsrvtCnt:0})));}
}
async function setup(t,Source=FixtureSource,{connect=true,env}={}){FixtureSource.failCamp=false;FixtureSource.calls=[];FixtureSource.priceCalls=[];FixtureSource.failPrice=false;const db=sqlite(':memory:');t.after(()=>db.close());const store=new Store(db,'a'.repeat(64));await store.init();let handle=createApp({store,env,sourceFactory:a=>new Source(a)});let token;
 const call=async(path,body,headers={})=>{const result=await handle(new Request('http://localhost:5178'+path,{method:body===undefined?'GET':'POST',headers:{Origin:'http://localhost:5178','Content-Type':'application/json',...(token?{'X-CSRF-TOKEN':token}:{}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})}));return{status:result.status,data:await result.json()};};
 token=(await call('/api/session')).data.csrfToken;if(connect)assert.equal((await call('/api/session/connect',{id:'private-id',password:'private-password'})).status,200);return{store,call,reload:()=>{handle=createApp({store,env,sourceFactory:a=>new Source(a)});}};
}
async function finish(call){for(let i=0;i<60;i++){const r=await call('/api/job/step',{});assert.equal(r.status,200);if(r.data.job.status!=='running')return r.data.job;}throw new Error('job did not finish');}
test('encrypted session persists and never appears in public API',async t=>{const{store,call}=await setup(t);const raw=await store.get('auth');assert.ok(raw.ciphertext);assert.ok(!JSON.stringify(raw).includes('private-cookie'));assert.equal((await store.getSecret('auth')).cookies.fixture,'private-cookie');const r=await call('/api/session');assert.ok(!JSON.stringify(r).includes('private-cookie'));assert.ok(!JSON.stringify(r).includes('private-password'));});
test('first connection requires credentials and stores successful credentials only as ciphertext',async t=>{
 const logins=[];class AccountSource extends FixtureSource{async login(id,password){logins.push({id,password});return super.login();}}
 const{store,call}=await setup(t,AccountSource,{connect:false});
 const before=(await call('/api/session')).data;assert.equal(before.configured,false);assert.equal(before.accountLabel,null);
 assert.equal((await call('/api/session/connect',{})).data.error.code,'CREDENTIALS_REQUIRED');
 for(const input of [null,[],{id:'only-id'},{password:'only-password'},{id:' ',password:'pw'},{id:22,password:'pw'},{id:'id',password:''},{id:'id',password:22},{id:'a'.repeat(129),password:'pw'},{id:'id',password:'a'.repeat(1025)}])assert.equal((await call('/api/session/connect',input)).status,400);
 assert.equal(logins.length,0);assert.equal(await store.get('credentials'),null);
 const credentials={id:'private-id',password:' private-password '};
 const result=await call('/api/session/connect',{...credentials,id:' private-id '});assert.equal(result.status,200);assert.deepEqual(logins,[credentials]);
 assert.equal(result.data.configured,true);assert.equal(result.data.accountLabel,'pr••••');
 assert.deepEqual(await store.getSecret('credentials'),credentials);
 const raw=await store.get('credentials');assert.ok(raw.iv);assert.ok(raw.ciphertext);assert.ok(!JSON.stringify(raw).includes(credentials.id));assert.ok(!JSON.stringify(raw).includes(credentials.password));
 for(const payload of [result.data,(await call('/api/session')).data]){assert.ok(!JSON.stringify(payload).includes(credentials.id));assert.ok(!JSON.stringify(payload).includes(credentials.password));}
});
test('a failed first login saves no credentials, session or catalog',async t=>{
 class RejectedSource extends FixtureSource{async login(){throw new SourceError('AUTH_REQUIRED','계정 확인 실패',401);}}
 const{store,call}=await setup(t,RejectedSource,{connect:false});
 assert.equal((await call('/api/session/connect',{id:'private-id',password:'wrong-password'})).status,401);
 for(const key of ['credentials','auth','catalog'])assert.equal(await store.get(key),null);
 assert.equal((await call('/api/session')).data.configured,false);
});
test('legacy environment credentials are not read or silently migrated',async t=>{
 const{store,call}=await setup(t,FixtureSource,{connect:false,env:{ID:'legacy-private-id',PASSWORD:'legacy-private-password'}});
 assert.equal((await call('/api/session')).data.configured,false);
 assert.equal((await call('/api/session/connect',{})).data.error.code,'CREDENTIALS_REQUIRED');
 assert.equal(await store.get('credentials'),null);assert.equal(await store.get('auth'),null);
});
test('account replacement validates a fresh session and failed replacement keeps the previous account',async t=>{
 const states=[],logins=[];class AccountSource extends FixtureSource{
  constructor(auth){super(auth);states.push(auth);}
  async login(id,password){logins.push({id,password});if(password==='wrong-password'&&!this.connectedAt)throw new SourceError('AUTH_REQUIRED','계정 확인 실패',401);return super.login();}
 }
 const{store,call}=await setup(t,AccountSource),previous=await Promise.all(['credentials','auth','catalog'].map(key=>store.get(key)));
 assert.equal(states[0],null);
 assert.equal((await call('/api/session/connect',{id:'changed-account',password:'wrong-password'})).status,401);assert.equal(states[1],null);
 assert.deepEqual(await Promise.all(['credentials','auth','catalog'].map(key=>store.get(key))),previous);
 const session=(await call('/api/session')).data;assert.equal(session.connected,true);assert.equal(session.configured,true);assert.equal(session.accountLabel,'pr••••');
 const replacement=await call('/api/session/connect',{id:'changed-account',password:'changed-password'});assert.equal(replacement.status,200);assert.equal(states[2],null);assert.equal(replacement.data.accountLabel,'ch••••');
 assert.deepEqual(await store.getSecret('credentials'),{id:'changed-account',password:'changed-password'});
 assert.equal(logins.length,3);
});
test('a storage failure during account replacement preserves the full previous login generation',async t=>{
 const{store,call}=await setup(t),keys=['credentials','auth','catalog'];
 const previous=await Promise.all(keys.map(key=>store.get(key)));
 await store.db.exec("CREATE TEMP TRIGGER reject_catalog BEFORE INSERT ON kv WHEN NEW.key='catalog' BEGIN SELECT RAISE(ABORT,'fixture write failure'); END;");
 const failed=await call('/api/session/connect',{id:'changed-account',password:'changed-password'});
 assert.equal(failed.status,500);assert.equal(failed.data.error.code,'INTERNAL');
 assert.deepEqual(await Promise.all(keys.map(key=>store.get(key))),previous);
 assert.equal((await call('/api/session')).data.accountLabel,'pr••••');
});
test('disconnect retains the encrypted account for reconnect after application recreation',async t=>{
 const logins=[];class AccountSource extends FixtureSource{async login(id,password){logins.push({id,password});return super.login();}}
 const{store,call,reload}=await setup(t,AccountSource);
 const credentials=await store.get('credentials');const disconnected=await call('/api/session/disconnect',{});
 assert.equal(disconnected.data.connected,false);assert.equal(disconnected.data.configured,true);assert.equal(disconnected.data.accountLabel,'pr••••');assert.equal(await store.get('auth'),null);assert.deepEqual(await store.get('credentials'),credentials);
 reload();assert.equal((await call('/api/session')).data.configured,true);
 const reconnected=await call('/api/session/connect',{});assert.equal(reconnected.status,200);assert.equal(reconnected.data.connected,true);
 assert.deepEqual(logins,[{id:'private-id',password:'private-password'},{id:'private-id',password:'private-password'}]);
});
test('forget requires same-origin CSRF, removes account and session, pauses work and keeps cached results',async t=>{
 const{store,call}=await setup(t),month=kstToday().slice(0,6);
 await call('/api/sync',{month,type:'stay'});await finish(call);const snapshots=await store.list('snapshot:'),catalog=await store.get('catalog');
 await call('/api/sync',{month,type:'stay'});
 assert.equal((await call('/api/session/forget',{}, {Origin:'https://other.test'})).status,403);
 assert.equal((await call('/api/session/forget',{}, {'X-CSRF-TOKEN':'wrong'})).status,403);assert.ok(await store.get('credentials'));
 const forgotten=await call('/api/session/forget',{});assert.equal(forgotten.status,200);assert.deepEqual(forgotten.data,{connected:false,connectedAt:null,configured:false,accountLabel:null});
 assert.equal(await store.get('credentials'),null);assert.equal(await store.get('auth'),null);assert.equal((await store.get('job')).status,'paused');
 assert.deepEqual(await store.list('snapshot:'),snapshots);assert.deepEqual(await store.get('catalog'),catalog);
 assert.equal((await call('/api/availability?month='+month+'&type=stay')).data.forests.length,1);
 assert.equal((await call('/api/session/connect',{})).data.error.code,'CREDENTIALS_REQUIRED');
 assert.equal((await call('/api/session/forget',{})).status,200);
});
test('cross-origin mutation and invalid queries are rejected',async t=>{const{call}=await setup(t);assert.equal((await call('/api/sync',{}, {Origin:'https://other.test'})).status,403);assert.equal((await call('/api/sync',{month:'202699'})).status,400);assert.equal((await call('/api/sync',{nights:100})).status,400);});
test('one job collects both types, five-unit batches, persists and resumes',async t=>{const{call,reload}=await setup(t);const month=kstToday().slice(0,6);const start=await call('/api/sync',{month,type:'all',nights:2});const duplicate=await call('/api/sync',{month,type:'all',nights:2});assert.equal(start.data.job.id,duplicate.data.job.id);await call('/api/job/step',{});await call('/api/job/pause',{});reload();assert.equal((await call('/api/job')).data.job.status,'paused');await call('/api/job/resume',{});const job=await finish(call);assert.equal(job.status,'complete');assert.equal(job.completedScopes,4);assert.equal(job.checkedUnits,14);assert.ok(FixtureSource.calls.every(n=>n<=5));const data=(await call('/api/availability?month='+month+'&type=all&nights=2')).data;assert.equal(data.forests.length,1);assert.ok(Object.keys(data.forests[0].dates).length);assert.equal(data.coverage.complete,1);});
test('failed scope preserves successful results and retry targets remaining work',async t=>{const{call}=await setup(t);FixtureSource.failCamp=true;const month=kstToday().slice(0,6);await call('/api/sync',{month,type:'all'});const job=await finish(call);assert.equal(job.status,'partial');assert.equal(job.failures.length,1);const before=(await call('/api/availability?month='+month)).data;assert.ok(Object.keys(before.forests[0].dates).length);assert.equal(before.forests[0].coverage,'partial');const calls=FixtureSource.calls.length;FixtureSource.failCamp=false;await call('/api/job/retry',{});const complete=await finish(call);assert.equal(complete.status,'complete');assert.equal(FixtureSource.calls.length,calls+1);});
test('cancel and disconnect keep snapshots; public DTO has no auth data',async t=>{const{call}=await setup(t);const month=kstToday().slice(0,6);await call('/api/sync',{month,type:'stay'});await finish(call);const before=(await call('/api/availability?month='+month+'&type=stay')).data;await call('/api/session/disconnect',{});const after=(await call('/api/availability?month='+month+'&type=stay')).data;assert.deepEqual(after.forests,before.forests);assert.equal((await call('/api/sync',{month})).status,401);assert.ok(!JSON.stringify(after).includes('private-cookie'));});
test('storage lease rejects simultaneous source access and releases with matching owner',async t=>{const{store}=await setup(t);assert.equal(await store.lock('test','one'),true);assert.equal(await store.lock('test','two'),false);await store.unlock('test','wrong');assert.equal(await store.lock('test','two'),false);await store.unlock('test','one');assert.equal(await store.lock('test','two'),true);});
test('hosted entry serves public assets without requiring an owner login',async()=>{const{default:worker}=await import('../server/worker.mjs');const env={ASSETS:{fetch:async()=>new Response('public page')}};const response=await worker.fetch(new Request('https://example.test/'),env);assert.equal(response.status,200);assert.equal(await response.text(),'public page');assert.equal((await worker.fetch(new Request('https://example.test/api/session'),env)).status,503);});

test('prices are scoped to known facilities, cached by date and nights, and preserve source queue',async t=>{
 const{call,store,reload}=await setup(t);const date=kstToday(),month=date.slice(0,6),path='/api/forests/0101/price',body={unitId:'g0',type:'stay',date,nights:1};
 await call('/api/sync',{month,type:'stay',nights:2});await finish(call);
 const auth=await store.getSecret('auth');auth.queue={key:'private-queue'};await store.setSecret('auth',auth);
 assert.equal((await call(path,body)).data.quote.baseTotal,120000);reload();assert.equal((await call(path,body)).status,200);assert.equal(FixtureSource.priceCalls.length,1);
 assert.equal((await store.getSecret('auth')).queue.key,'private-queue');
 assert.equal((await call(path,{...body,nights:2})).data.quote.baseTotal,240000);
 assert.equal((await call(path,{...body,date:addDays(date,1)})).status,200);assert.equal(FixtureSource.priceCalls.length,3);
 for(const patch of [{unitId:'unknown'},{type:'all'},{date:'20269912'},{date:'20260230'},{nights:4},{date:addDays(date,-1)}])assert.equal((await call(path,{...body,...patch})).status,400);
 assert.equal((await call('/api/forests/other/price',body)).status,400);
 const key=`price:0101:stay:g0:${date}:1`,cached=await store.get(key);cached.observedAt=new Date(Date.now()-16*60*1000).toISOString();await store.set(key,cached);FixtureSource.failPrice=true;
 assert.equal((await call(path,body)).status,502);assert.equal((await call('/api/availability?month='+month)).status,200);
 assert.equal((await call(path,body,{Origin:'https://other.test'})).status,403);
});
test('includeWait query changes stored result counts and detail states without a new source collection',async t=>{
 const {call,store}=await setup(t),date=kstToday(),month=date.slice(0,6);
 await call('/api/sync',{month,type:'stay'});await finish(call);
 const key=`snapshot:${month}:0101:stay`,snapshot=await store.get(key);
 for(const unit of snapshot.units)snapshot.days[unit.id][date]={state:'full'};
 snapshot.days.g0[date]={state:'wait'};snapshot.days.g1[date]={state:'available'};await store.set(key,snapshot);
 const sourceCalls=FixtureSource.calls.length,path=`/api/forests/0101?month=${month}&type=stay&nights=1`;
 const before=(await call(path)).data.forests[0];assert.equal(before.dates[date].length,1);
 const after=(await call(path+'&includeWait=true')).data;assert.equal(after.query.includeWait,true);assert.equal(after.forests[0].dates[date].length,2);assert.deepEqual(after.forests[0].dateCounts[date],{available:1,wait:1});
 assert.deepEqual(after.forests[0].dates[date].map(u=>u.bookingState),['available','wait']);
 assert.equal((await call(path+'&includeWait=false')).data.forests[0].dates[date].length,1);
 assert.equal(FixtureSource.calls.length,sourceCalls);
});

test('all options collect every catalog month, region and facility type once, then filter locally',async t=>{
 const month=kstToday().slice(0,6),second=nextMonth(month),boundary=nextMonth(second),calls=[];
 class AllSource extends FixtureSource{
  async login(){const catalog=await super.login();return{...catalog,months:[{id:second,name:'다음 달'},...catalog.months,{id:second,name:'중복 월'}],regions:[{id:'1',name:'경기'},{id:'2',name:'강원'},{id:'1',name:'경기'}]};}
  async forests(region){calls.push(['region',region.id]);const forest={id:region.id==='1'?'0101':'0201',name:region.name+' 숲',regionId:region.id,region:region.name};return[forest,forest];}
  async policy(id){calls.push(['policy',id]);return{types:id==='0101'?[{upperGoodsClsscCd:'01'},{upperGoodsClsscCd:'02'},{upperGoodsClsscCd:'01'}]:[{upperGoodsClsscCd:'02'}],lastDay:'20991231'};}
  async goods(scope){calls.push(['goods',scope.insttId,scope.srchDate,scope.upperGoodsClsscCd]);return super.goods(scope);}
 }
 const {call,reload}=await setup(t,AllSource);
 const start=(await call('/api/sync',{scope:'all',month:second,region:'1',type:'stay',nights:1,guests:12})).data.job;
 assert.equal(start.scope,'all');assert.deepEqual(start.listedMonths,[month,second]);assert.deepEqual(start.months,[month,second,boundary]);assert.equal(start.regionsTotal,2);assert.equal(start.type,'all');
 await call('/api/job/step',{});await call('/api/job/pause',{});reload();assert.equal((await call('/api/job')).data.job.id,start.id);await call('/api/job/resume',{});
 const result=await finish(call);assert.equal(result.status,'complete');assert.equal(result.completedForests,2);assert.equal(result.completedScopes,9);
 assert.equal(calls.filter(c=>c[0]==='region').length,2);assert.equal(calls.filter(c=>c[0]==='policy').length,2);
 const goods=calls.filter(c=>c[0]==='goods');assert.equal(goods.length,9);assert.equal(new Set(goods.map(c=>c.join(':'))).size,9);
 const previous=FixtureSource.calls.length;
 for(const m of [month,second])for(const type of ['all','stay','camp'])for(const nights of [1,2,3])for(const guests of [1,2,3,4,6,8,12]){
  const response=(await call(`/api/availability?month=${m}&type=${type}&nights=${nights}&guests=${guests}&includeWait=true`)).data;
  assert.equal(response.coverage.complete,2);assert.equal(response.coverage.pending,0);assert.equal(response.coverage.missingRegions,0);
  if(guests>4)assert.ok(response.forests.every(f=>!Object.keys(f.dates).length));
 }
 const edge=(await call(`/api/forests/0101?month=${second}&type=stay&nights=3&guests=4`)).data.forests[0];
 assert.equal(edge.dates[monthDates(second).at(-1)].length,6);assert.equal(FixtureSource.calls.length,previous);
 assert.equal((await call('/api/sync',{scope:'all',forestId:'0101'})).status,400);
 assert.equal((await call('/api/sync',{scope:'unknown'})).status,400);
});

test('all options failures in later months remain visible and retry only failed scopes',async t=>{
 const month=kstToday().slice(0,6),second=nextMonth(month);let fail=false;const queried=[];
 class MultiMonthSource extends FixtureSource{
  async login(){const catalog=await super.login();return{...catalog,months:[...catalog.months,{id:second,name:'다음 달'}]};}
  async days(scope,ids){queried.push(`${scope.srchDate}:${scope.upperGoodsClsscCd}`);if(fail&&scope.srchDate===second&&scope.upperGoodsClsscCd==='02')throw new SourceError('NETWORK','later month failure');return super.days(scope,ids);}
 }
 const {call,reload}=await setup(t,MultiMonthSource);
 await call('/api/sync',{month:second,type:'camp'});await finish(call);fail=true;
 await call('/api/sync',{scope:'all'});const partial=await finish(call);
 assert.equal(partial.status,'partial');assert.equal(partial.failures.length,1);assert.equal(partial.failures[0].month,second);
 const cached=(await call(`/api/availability?month=${second}&type=camp`)).data.forests[0];assert.equal(cached.failed,true);assert.equal(cached.stale,true);assert.ok(Object.keys(cached.dates).length);
 const before=queried.length;fail=false;reload();await call('/api/job/retry',{});const done=await finish(call);
 assert.equal(done.status,'complete');assert.equal(done.completedForests,1);assert.deepEqual(queried.slice(before),[`${second}:02`]);
 const after=(await call(`/api/availability?month=${second}&type=camp`)).data.forests[0];assert.equal(after.failed,false);assert.equal(after.stale,false);
});

test('targeted refresh keeps published results through batches and resume, then publishes every month and type together',async t=>{
 const month=kstToday().slice(0,6);let updated=false;
 class ChangedSource extends FixtureSource{
  async forests(){return(await super.forests()).map(f=>({...f,name:updated?'새 휴양림 이름':f.name}));}
  async days(scope,ids){return(await super.days(scope,ids)).map(r=>({...r,rsrvtCnt:updated?1:0}));}
 }
 const {call,store,reload}=await setup(t,ChangedSource),path=`/api/availability?month=${month}&type=all&nights=2`;
 await call('/api/sync',{month,type:'all',nights:2});await finish(call);
 const before=(await call(path)).data.forests[0],oldSnapshots=await store.list('snapshot:');
 updated=true;const started=(await call('/api/sync',{month,type:'all',nights:2,forestId:'0101'})).data.job;
 assert.deepEqual(started.onlyForestIds,['0101']);
 for(let i=0;i<4;i++)await call('/api/job/step',{});
 let current=(await call(path)).data.forests[0];
 assert.deepEqual(current.dates,before.dates);assert.equal(current.name,before.name);assert.equal(current.coverage,'complete');
 assert.deepEqual(await store.list('snapshot:'),oldSnapshots);
 await call('/api/job/pause',{});reload();assert.equal((await call('/api/job')).data.job.status,'paused');
 assert.deepEqual((await call(path)).data.forests[0].dates,before.dates);
 await call('/api/job/resume',{});
 for(let i=0;i<30;i++){
  const job=(await call('/api/job/step',{})).data.job;
  current=(await call(path)).data.forests[0];
  const generations=new Set((await store.list('snapshot:')).map(s=>s.jobId));
  assert.equal(generations.size,1,'a reader never sees partially replaced month/type scopes');
  if(job.status==='complete'){
   assert.equal(current.name,'새 휴양림 이름');assert.deepEqual(current.dates,{});assert.equal(current.coverage,'complete');
   assert.deepEqual([...generations],[started.id]);assert.deepEqual(await store.list(`pending:${started.id}:`),[]);return;
  }
  assert.deepEqual(current.dates,before.dates);assert.equal(current.name,before.name);
 }
 assert.fail('targeted update did not complete');
});

test('targeted failed scope keeps every published scope and retained successes are committed when retry succeeds',async t=>{
 const month=kstToday().slice(0,6);let updated=false;
 class ChangedSource extends FixtureSource{async days(scope,ids){return(await super.days(scope,ids)).map(r=>({...r,rsrvtCnt:updated?1:0}));}}
 const {call,store,reload}=await setup(t,ChangedSource),path=`/api/availability?month=${month}&type=all`;
 await call('/api/sync',{month,type:'all'});await finish(call);
 const before=(await call(path)).data.forests[0],oldSnapshots=await store.list('snapshot:');
 updated=true;FixtureSource.failCamp=true;
 const started=(await call('/api/sync',{month,type:'all',forestId:'0101'})).data.job,partial=await finish(call);
 assert.equal(partial.status,'partial');assert.equal(partial.completedScopes,1);
 assert.deepEqual(await store.list('snapshot:'),oldSnapshots);
 assert.equal((await store.list(`pending:${started.id}:`)).length,2);
 const cached=(await call(path)).data.forests[0];assert.deepEqual(cached.dates,before.dates);assert.equal(cached.coverage,'complete');assert.equal(cached.failed,true);
 const checked=FixtureSource.calls.length;FixtureSource.failCamp=false;reload();
 await call('/api/job/retry',{});assert.equal((await finish(call)).status,'complete');
 assert.equal(FixtureSource.calls.length,checked+1,'successful stay batches are reused');
 assert.deepEqual((await call(path)).data.forests[0].dates,{});
 assert.ok((await store.list('snapshot:')).every(s=>s.jobId===started.id));
 assert.deepEqual(await store.list(`pending:${started.id}:`),[]);
});

test('targeted refresh stages empty and previously unknown scopes until the whole update completes',async t=>{
 const month=kstToday().slice(0,6);let empty=false,interruptQueue=false;
 class EmptySource extends FixtureSource{
  async goods(scope){return empty&&scope.upperGoodsClsscCd==='01'?{rsrvtGoodsList:[],hldtInfoList:[]}:super.goods(scope);}
  async completeQueue(){if(interruptQueue){interruptQueue=false;throw new SourceError('NETWORK','queue response lost');}}
 }
 const {call,store}=await setup(t,EmptySource),path=`/api/availability?month=${month}&type=all`;
 await call('/api/sync',{month,type:'stay'});await finish(call);
 const before=(await call(path)).data.forests[0];
 empty=true;interruptQueue=true;
 const started=(await call('/api/sync',{month,type:'all',forestId:'0101'})).data.job;
 const partial=await finish(call);assert.equal(partial.status,'partial');assert.equal(partial.completedScopes,1);
 assert.deepEqual((await call(path)).data.forests[0].dates,before.dates);
 assert.equal(await store.get(`snapshot:${month}:0101:camp`),null,'new camp data stays private while the empty stay scope has failed');
 await call('/api/job/retry',{});assert.equal((await finish(call)).status,'complete');
 const snapshots=await store.list(`snapshot:${month}:`);
 assert.equal(snapshots.length,2);assert.ok(snapshots.every(s=>s.jobId===started.id&&s.status==='complete'));
 assert.deepEqual(snapshots.find(s=>s.type==='stay').units,[]);
 assert.equal((await call(path)).data.forests[0].unitCount,1);
});

test('selection-wide collection still publishes successful batches before completion',async t=>{
 const {call,store}=await setup(t),month=kstToday().slice(0,6);
 await call('/api/sync',{month,type:'all'});
 for(let i=0;i<4;i++)await call('/api/job/step',{});
 const snapshot=await store.get(`snapshot:${month}:0101:stay`);
 assert.equal(snapshot.status,'partial');assert.equal(snapshot.checkedUnits,5);
 const data=(await call(`/api/availability?month=${month}`)).data;
 assert.equal(data.job.status,'running');assert.ok(Object.keys(data.forests[0].dates).length);
});

test('public visitors isolate credentials, CSRF, jobs, results and account deletion',async t=>{
 const {createWorker}=await import('../server/worker.mjs');
 const db=sqlite(':memory:');t.after(()=>db.close());
 const env={DB:db,SESSION_SECRET:'public-test-secret-'.repeat(4),ASSETS:{fetch:async()=>new Response('public')}};
 const worker=createWorker(options=>createApp({...options,sourceFactory:auth=>new FixtureSource(auth)}));
 async function visitor(){
  let cookie='',csrf='';
  const call=async(path,body,headers={})=>{const response=await worker.fetch(new Request('https://example.test'+path,{method:body===undefined?'GET':'POST',headers:{Origin:'https://example.test',Cookie:cookie,'X-CSRF-TOKEN':csrf,...headers},...(body===undefined?{}:{body:JSON.stringify(body)})}),env);const setCookie=response.headers.get('set-cookie');if(setCookie)cookie=setCookie.split(';')[0];const data=await response.json();if(data.csrfToken)csrf=data.csrfToken;return {status:response.status,data};};
  const first=await call('/api/session');assert.equal(first.data.storageLocation,'hosted');
  return {call,getCookie:()=>cookie,getCsrf:()=>csrf};
 }
 const a=await visitor(),b=await visitor();assert.notEqual(a.getCookie(),b.getCookie());assert.notEqual(a.getCsrf(),b.getCsrf());
 await a.call('/api/session/connect',{id:'visitor-a',password:'a-secret'});await b.call('/api/session/connect',{id:'visitor-b',password:'b-secret'});
 assert.equal((await a.call('/api/session/connect',{}, {'X-CSRF-TOKEN':b.getCsrf()})).status,403);
 const month=kstToday().slice(0,6);await a.call('/api/sync',{month,type:'stay'});assert.equal((await finish(a.call)).status,'complete');
 assert.equal((await a.call('/api/availability?month='+month)).data.forests.length,1);
 assert.equal((await b.call('/api/availability?month='+month)).data.forests.length,0);assert.equal((await b.call('/api/session')).data.job,null);
 await a.call('/api/sync',{month,type:'stay',forestId:'0101'});assert.equal((await finish(a.call)).status,'complete');
 assert.equal((await a.call('/api/availability?month='+month)).data.forests.length,1);assert.equal((await b.call('/api/availability?month='+month)).data.forests.length,0);
 await a.call('/api/session/forget',{});assert.equal((await a.call('/api/session')).data.configured,false);assert.equal((await b.call('/api/session')).data.configured,true);assert.equal((await b.call('/api/session/connect',{})).status,200);
 const raw=await db.prepare('SELECT value FROM kv WHERE key LIKE ?').bind('%:credentials').all();assert.equal(raw.results.length,1);assert.ok(!raw.results[0].value.includes('b-secret'));
 const forged=a.getCookie().replace(/.$/,'z');assert.equal((await a.call('/api/availability',{},{Cookie:forged})).status,401);
 assert.equal((await a.call('/api/session',undefined,{'sec-fetch-site':'cross-site'})).status,403);
});
