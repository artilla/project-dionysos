import test from 'node:test';
import assert from 'node:assert/strict';
import {visitorSession} from '../server/visitor.mjs';

test('visitor session uses a signed secure HttpOnly cookie and rejects tampering, expiry and another signing key',async()=>{
 const secret='test-cookie-secret-'.repeat(4), now=Date.now();
 const request=cookie=>new Request('https://example.test/api/session',{headers:cookie?{Cookie:cookie}:{}});
 assert.equal(await visitorSession(request(),secret,false,now),null);
 const created=await visitorSession(request(),secret,true,now);assert.match(created.cookie,/^__Host-/);assert.match(created.cookie,/Secure; HttpOnly; SameSite=Lax/);
 const cookie=created.cookie.split(';')[0];assert.equal((await visitorSession(request(cookie),secret,false,now)).id,created.id);
 assert.equal(await visitorSession(request(cookie.replace('=', '=a')),secret,false,now),null);
 assert.equal(await visitorSession(request(cookie),'different-secret-'.repeat(4),false,now),null);
 assert.equal(await visitorSession(request(cookie),secret,false,now+31*86400000),null);
 const fresh=await visitorSession(request(cookie),secret,true,now+31*86400000);assert.notEqual(fresh.id,created.id);
});
