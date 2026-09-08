import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDay, availableFor, waitingFor, summarizeForest, addDays, monthDates, nextMonth } from '../server/domain.mjs';
import { parseQueue, SourceError } from '../server/foresttrip.mjs';
const config={today:'20260908',lastDay:'20261013',holidays:[]};
const row={useDt:'20260909',rsrvtAvail:'Y',rsrvtCnt:0};
test('Y alone does not mean available; missing counters remain unknown',()=>{
 assert.equal(normalizeDay(row,config).state,'available');
 for(const count of [null,undefined,'','not-a-number',-1])assert.equal(normalizeDay({...row,rsrvtCnt:count},config).state,'unknown');
 assert.equal(normalizeDay({...row,rsrvtCnt:1},config).state,'full');
 assert.equal(normalizeDay({...row,rsrvtCnt:1,wtngPssblYn:'Y',wtngCnt:0,goodsMxmmWtngCnt:3},config).state,'wait');
});
test('holidays, priority, lottery and policy date boundaries are not general inventory',()=>{
 assert.equal(normalizeDay(row,{...config,holidays:[{dt:row.useDt,dtCd:'01'}]}).state,'closed');
 for(const [raw,expected]of [['PRIOR','priority'],['DRLTS','lottery'],['PRNSL_DAY','closed'],['UNKNOWN','unknown']])assert.equal(normalizeDay({...row,rsrvtAvail:raw},config).state,expected);
 assert.equal(normalizeDay({...row,useDt:'20260907'},config).state,'past');
 assert.equal(normalizeDay({...row,useDt:'20261014'},config).state,'unopened');
});
test('date arithmetic crosses month, year and leap day without timezone drift',()=>{
 assert.equal(addDays('20261231',1),'20270101');assert.equal(addDays('20240228',1),'20240229');assert.equal(nextMonth('202612'),'202701');assert.equal(monthDates('202402').length,29);
});
test('all nights must be available in one unit; checkout inventory is not required',()=>{
 const u={capacity:4,maxNights:3},q={today:'20260908',guests:2,nights:2,weekend:false};
 assert.equal(availableFor(u,'20260930',q,{'20260930':{state:'available'},'20261001':{state:'available'}}),true);
 assert.equal(availableFor(u,'20260930',q,{'20260930':{state:'available'}}),false);
 assert.equal(availableFor(u,'20260930',q,{'20260930':{state:'available'},'20261001':{state:'full'}}),false);
 assert.equal(availableFor({...u,capacity:null},'20260930',q,{}),false);
 assert.equal(availableFor({...u,maxNights:null},'20260930',q,{'20260930':{state:'available'},'20261001':{state:'available'}}),false);
 assert.equal(availableFor({...u,maxNights:0},'20260930',q,{'20260930':{state:'available'},'20261001':{state:'available'}}),false);
 assert.equal(availableFor({...u,maxNights:null},'20260930',q,{'20260930':{state:'available',maxNights:3},'20261001':{state:'available'}}),true);
});
test('capacity, night limit and Friday/Saturday check-in apply',()=>{
 const u={capacity:2,maxNights:1},q={today:'20260908',guests:2,nights:1,weekend:true};const days={'20260910':{state:'available'},'20260911':{state:'available'},'20260912':{state:'available'}};
 assert.equal(availableFor(u,'20260910',q,days),false);assert.equal(availableFor(u,'20260911',q,days),true);assert.equal(availableFor(u,'20260912',q,days),true);
 assert.equal(availableFor(u,'20260911',{...q,guests:3},days),false);assert.equal(availableFor(u,'20260911',{...q,nights:2},days),false);
});
test('all types union by source unit, date count is distinct and rooms cannot be stitched',()=>{
 const f={id:'a'},q={month:'202609',type:'all',guests:2,nights:2,today:'20260908',weekend:false};
 const snapshot={forestId:'a',month:'202609',type:'stay',observedAt:'2026-09-08T00:00:00Z',units:[{id:'a',type:'stay',capacity:2,maxNights:3},{id:'b',type:'stay',capacity:2,maxNights:3}],days:{a:{'20260911':{state:'available'}},b:{'20260912':{state:'available'}}}};
 assert.deepEqual(summarizeForest(f,[snapshot],q).dates,{});
 const camping={...snapshot,type:'camp',units:[{id:'c',type:'camp',capacity:2,maxNights:3}],days:{c:{'20260911':{state:'available'},'20260912':{state:'available'}}}};
 assert.equal(summarizeForest(f,[snapshot,camping],q).dates['20260911'],1);
 assert.deepEqual(summarizeForest(f,[snapshot,camping],{...q,type:'stay'}).dates,{});
});
test('queue accepts only server result grants; waiting and blocking remain distinct',()=>{
 const grant=parseQueue("NetFunnel.gRtype=5101;NetFunnel.gControl.result='5002:200:key=fixture&ttl=0';",['5101','5002']);assert.equal(grant.granted,true);
 const wait=parseQueue("result='5002:201:key=fixture&ttl=10';",['5002']);assert.equal(wait.granted,false);assert.ok(wait.waitUntil>Date.now());
 for(const text of ["result='5002:301:key=fixture';","result='5002:201:key=fixture';","result='5002:200:ttl=0';","alert('unexpected')"])assert.throws(()=>parseQueue(text,['5002']),SourceError);
});
test('waiting needs a confirmed remaining slot and never includes a full or unknown waitlist',()=>{
 const waiting={...row,rsrvtCnt:1,wtngPssblYn:'Y',wtngCnt:1,goodsMxmmWtngCnt:3};
 assert.equal(normalizeDay(waiting,config).state,'wait');
 for(const patch of [{wtngPssblYn:'N'},{wtngCnt:3},{wtngCnt:-1},{wtngCnt:0.5},{wtngCnt:null},{goodsMxmmWtngCnt:0},{goodsMxmmWtngCnt:null}])assert.equal(normalizeDay({...waiting,...patch},config).state,'full');
});
test('waiting is opt-in and one-night only, honoring capacity, past dates and weekend filters',()=>{
 const u={capacity:4,maxNights:3},date='20260911',days={[date]:{state:'wait',capacity:4},'20260912':{state:'available'}},q={today:'20260908',includeWait:true,guests:2,nights:1,weekend:true};
 assert.equal(waitingFor(u,date,q,days),true);assert.equal(availableFor(u,date,q,days),false);
 for(const patch of [{includeWait:false},{nights:2},{guests:6},{today:'20260912'}])assert.equal(waitingFor(u,date,{...q,...patch},days),false);
 assert.equal(waitingFor(u,'20260910',q,{'20260910':{state:'wait'}}),false);
 assert.equal(waitingFor(u,date,q,{[date]:{state:'wait',capacity:1}}),false);
 for(const state of ['full','priority','lottery','unknown','closed'])assert.equal(waitingFor(u,date,q,{[date]:{state}}),false);
});
test('waiting-only dates enter results without turning wait into available or duplicating units',()=>{
 const f={id:'f'},q={month:'202609',type:'all',guests:2,nights:1,today:'20260908',weekend:false,includeWait:true};
 const stay={forestId:'f',month:'202609',type:'stay',observedAt:'2026-09-08T00:00:00Z',units:[{id:'a',type:'stay',capacity:4,maxNights:3},{id:'b',type:'stay',capacity:4,maxNights:3}],days:{a:{'20260909':{state:'available'},'20260910':{state:'wait'}},b:{'20260909':{state:'wait'},'20260910':{state:'wait'}}}};
 const camp={...stay,type:'camp',units:[{id:'a',type:'camp',capacity:4,maxNights:3}],days:{a:{'20260910':{state:'wait'}}}};
 const result=summarizeForest(f,[stay,camp,stay],q);
 assert.deepEqual(result.dates,{'20260909':2,'20260910':3});assert.deepEqual(result.dateCounts['20260909'],{available:1,wait:1});assert.deepEqual(result.dateCounts['20260910'],{available:0,wait:3});
 const detail=summarizeForest(f,[stay,camp],q,true);assert.deepEqual(detail.dates['20260909'].map(u=>u.bookingState),['available','wait']);assert.ok(detail.dates['20260910'].every(u=>u.bookingState==='wait'));
 assert.deepEqual(summarizeForest(f,[stay,camp],{...q,includeWait:false}).dates,{'20260909':1});
 assert.deepEqual(summarizeForest(f,[stay,camp],{...q,type:'camp'}).dates,{'20260910':1});
 assert.deepEqual(summarizeForest(f,[stay,camp],{...q,nights:2}).dates,{});
});
