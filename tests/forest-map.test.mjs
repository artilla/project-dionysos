import test from 'node:test';
import assert from 'node:assert/strict';
import { matchLocations, groupLocations } from '../web/forest-map.js';
import { sqlite } from '../server/sqlite.mjs';
import { Store } from '../server/store.mjs';
import { SharedStore } from '../server/shared.mjs';
import { createApp } from '../server/app.mjs';

test('map joins by official forest ID and never substitutes another forest or invalid coordinates', () => {
 const forests = [{id:'a',name:'같은 이름'},{id:'b',name:'같은 이름'},{id:'c',name:'미확인'}];
 const result = matchLocations(forests, [{id:'a',lat:37,lng:127},{id:'b',lat:0,lng:0},{id:'other',lat:36,lng:128}]);
 assert.deepEqual(result.located.map(f=>f.id), ['a']); assert.deepEqual(result.missing.map(f=>f.id), ['b','c']);
 assert.equal(result.located[0].name, '같은 이름'); assert.equal(forests[0].location, undefined);
});
test('nearby locations group at low zoom and separate when zoomed without losing any IDs', () => {
 const forests = [{id:'a',location:{lat:37,lng:127}},{id:'b',location:{lat:37.1,lng:127.1}},{id:'c',location:{lat:35,lng:129}}];
 const groups = scale => groupLocations(forests, p=>({x:(p.lng-127)*scale,y:(p.lat-35)*scale}));
 assert.deepEqual(groups(10).map(g=>g.map(f=>f.id)), [['a','b','c']]);
 assert.deepEqual(groups(1000).flat().map(f=>f.id), ['a','b','c']);
 assert.equal(groups(1000).length,3);
});
test('location route preserves access gate, requires a known forest and returns shared cached location', async t => {
 const db=sqlite(':memory:');t.after(()=>db.close());const store=new Store(db,'synthetic-secret-'.repeat(4)),shared=new SharedStore(db);await store.init();await shared.init();
 const handle=createApp({store,shared});const req=id=>handle(new Request(`http://localhost/api/forests/${id}/location`));
 assert.equal((await req('forest1')).status,403);
 await store.set('catalog',{});assert.equal((await req('forest1')).status,404);
 await store.set('forest:forest1',{id:'forest1',name:'검증숲'});
 const location={id:'forest1',lat:37,lng:127,address:'합성 주소',sourceUrl:'https://www.foresttrip.go.kr/'};
 await shared.cache({kind:'location',key:'forest-directions-v1:forest1',forestId:'forest1',value:location,createdAt:Date.now(),expiresAt:Date.now()+60000});
 const result=await req('forest1');assert.equal(result.status,200);assert.equal(result.headers.get('cache-control'),'private, no-store');assert.deepEqual((await result.json()).location,location);
});
