import test from 'node:test';
import assert from 'node:assert/strict';
import { createApiClient } from '../web/connection.js';

const response = (value, status = 200) => Response.json(value, { status });
const lost = () => { throw new TypeError('Failed to fetch'); };
const job = patch => ({ id: 'old', status: 'complete', month: '202609', region: '1', type: 'all', nights: 1, scope: 'selection', onlyForestIds: null, updatedAt: 'before', ...patch });
function client(fetcher, options = {}) {
  const requests = [], waits = [], notices = [], sessions = [];
  const api = createApiClient({
    fetcher: async (path, init) => { requests.push({ path, ...init }); return fetcher(path, init); },
    sleep: async delay => { waits.push(delay); }, onRecovery: value => notices.push(value),
    onSession: value => sessions.push(value), ...options
  });
  return { api, requests, waits, notices, sessions };
}

test('GET transport recovery uses bounded backoff and Korean failure guidance', async () => {
  const h = client(lost);
  await assert.rejects(h.api('/api/availability'), { code: 'NETWORK_OFFLINE', message: /저장된 결과는 유지/ });
  assert.deepEqual(h.waits, [1000, 2000, 4000]);
  assert.equal(h.requests.length, 4);
  assert.deepEqual(h.notices.map(n => n.status), ['retrying', 'retrying', 'retrying', 'failed']);
  assert.equal(h.requests.some(r => r.path.includes('/connect')), false);
});

test('GET succeeds after transport loss and reports recovery', async () => {
  let calls = 0;
  const h = client(() => ++calls < 3 ? lost() : response({ forests: [] }));
  assert.deepEqual(await h.api('/api/availability'), { forests: [] });
  assert.deepEqual(h.waits, [1000, 2000]);
  assert.equal(h.notices.at(-1).status, 'recovered');
});

test('a lost accepted sync response reconciles target forest without starting twice', async () => {
  const accepted = job({ id: 'new', status: 'complete', onlyForestIds: ['0101'] });
  const h = client(path => path === '/api/session' ? response({ connected: true, csrfToken: 'new-token', job: accepted }) : lost(), { getJob: () => job() });
  assert.deepEqual(await h.api('/api/sync', { month: '202609', region: 'all', type: 'all', nights: 1, forestId: '0101' }), { job: accepted });
  assert.equal(h.requests.filter(r => r.path === '/api/sync').length, 1);
  assert.equal(h.sessions[0].csrfToken, 'new-token');
});

test('uncertain sync refuses another forest or a replaced job', async () => {
  const h = client(path => path === '/api/session' ? response({ job: job({ id: 'other', status: 'running', onlyForestIds: ['9999'] }) }) : lost(), { getJob: () => job() });
  await assert.rejects(h.api('/api/sync', { month: '202609', type: 'all', nights: 1, forestId: '0101' }), { code: 'JOB_CHANGED' });
  assert.equal(h.requests.filter(r => r.path === '/api/sync').length, 1);
});

test('failed sync before acceptance replays only after session check and new CSRF', async () => {
  const previous = job(), accepted = job({ id: 'new', status: 'running' });
  let calls = 0, csrf = 'old-token';
  const h = client(path => path === '/api/session' ? response({ csrfToken: 'new-token', job: previous }) : ++calls === 1 ? lost() : response({ job: accepted }), {
    getJob: () => previous, getCsrf: () => csrf, onSession: snapshot => { csrf = snapshot.csrfToken; }
  });
  assert.deepEqual(await h.api('/api/sync', { month: '202609', region: '1', type: 'all', nights: 1 }), { job: accepted });
  assert.deepEqual(h.requests.map(r => r.path), ['/api/sync', '/api/session', '/api/sync']);
  assert.equal(h.requests.at(-1).headers['X-CSRF-TOKEN'], 'new-token');
  const id=h.requests[0].headers['X-Request-ID'];
  assert.match(id,/^[0-9a-f-]{36}$/);assert.equal(h.requests.at(-1).headers['X-Request-ID'],id);
  await h.api('/api/sync',{month:'202609',region:'1',type:'all',nights:1});
  assert.notEqual(h.requests.at(-1).headers['X-Request-ID'],id);
});

test('a completed step with a lost response is not repeated', async () => {
  const previous = job({ status: 'running' }), complete = job({ status: 'complete', updatedAt: 'after' });
  const h = client(path => path === '/api/session' ? response({ connected: true, job: complete }) : lost(), { getJob: () => previous });
  assert.deepEqual(await h.api('/api/job/step', {}), { job: complete });
  assert.equal(h.requests.filter(r => r.path === '/api/job/step').length, 1);
});

test('job actions reconcile committed state and stop if the job was replaced', async () => {
  for (const action of ['resume', 'retry', 'pause', 'cancel']) {
    const previous = job({ status: 'paused' }), current = job({ status: action === 'pause' ? 'paused' : action === 'cancel' ? 'cancelled' : 'running', updatedAt: 'after' });
    const h = client(path => path === '/api/session' ? response({ job: current }) : lost(), { getJob: () => previous });
    assert.deepEqual(await h.api('/api/job/' + action, {}), { job: current });
    assert.equal(h.requests.filter(r => r.method === 'POST').length, 1);
  }
  const h = client(path => path === '/api/session' ? response({ job: job({ id: 'replacement' }) }) : lost(), { getJob: () => job({ status: 'running' }) });
  await assert.rejects(h.api('/api/job/step', {}), { code: 'JOB_CHANGED' });
});

test('HTTP authentication, source network and access errors never trigger transport recovery', async () => {
  for (const [code, status] of [['AUTH_REQUIRED', 401], ['NETWORK', 502], ['ACCESS_LIMIT', 429], ['INVALID_INPUT', 400]]) {
    const h = client(() => response({ error: { code, message: '원천 오류' } }, status));
    await assert.rejects(h.api('/api/job/step', {}), { code, message: '원천 오류' });
    assert.equal(h.requests.length, 1);
    assert.deepEqual(h.waits, []);
  }
});

test('response body transport failure recovers but malformed JSON is not retried', async () => {
  let calls = 0;
  const h = client(() => ++calls === 1 ? { ok: true, json: async () => lost() } : response({ connected: true }));
  assert.equal((await h.api('/api/session')).connected, true);
  const malformed = client(() => new Response('<html>', { status: 200 }));
  await assert.rejects(malformed.api('/api/session'), { code: 'INVALID_RESPONSE' });
  assert.equal(malformed.requests.length, 1);
});

test('a lost explicit login response is checked without resending login', async () => {
  const credentials = { id: 'fixture-user', password: 'fixture-password' };
  const successful = client(path => path === '/api/session' ? response({ connected: true, csrfToken: 'token' }) : lost());
  assert.equal((await successful.api('/api/session/connect', credentials)).connected, true);
  assert.equal(successful.requests.filter(r => r.method === 'POST').length, 1);
  assert.deepEqual(JSON.parse(successful.requests[0].body), credentials);
  assert.ok(successful.requests.slice(1).every(r => r.method === 'GET' && r.body === undefined));
  const unresolved = client(path => path === '/api/session' ? response({ connected: false }) : lost());
  await assert.rejects(unresolved.api('/api/session/connect', credentials), { code: 'NETWORK_OFFLINE' });
  assert.equal(unresolved.requests.filter(r => r.method === 'POST').length, 1);
  assert.deepEqual(JSON.parse(unresolved.requests[0].body), credentials);
  assert.ok(unresolved.requests.slice(1).every(r => r.method === 'GET' && r.body === undefined));
  assert.deepEqual(unresolved.waits, [1000, 2000, 4000]);
});

test('a lost account deletion response succeeds only when credentials and session are both absent', async () => {
  const snapshot = { configured: false, connected: false, account: null, csrfToken: 'new-token', job: job({ status: 'paused' }) };
  const h = client(path => path === '/api/session' ? response(snapshot) : lost(), { getCsrf: () => 'fixture-token' });
  assert.deepEqual(await h.api('/api/session/forget', {}), snapshot);
  assert.deepEqual(h.requests.map(r => r.path), ['/api/session/forget', '/api/session']);
  assert.equal(h.requests[0].headers['X-CSRF-TOKEN'], 'fixture-token');
  assert.deepEqual(h.sessions, [snapshot]);
});

test('uncertain account deletion never repeats against a saved or connected account', async () => {
  for (const snapshot of [
    { configured: true, connected: false },
    { configured: false, connected: true },
    { configured: true, connected: true },
    { connected: false },
    { configured: false }
  ]) {
    const h = client(path => path === '/api/session' ? response(snapshot) : lost());
    await assert.rejects(h.api('/api/session/forget', {}), { code: 'RESPONSE_UNCERTAIN', message: /계정 삭제 결과/ });
    assert.deepEqual(h.requests.map(r => r.path), ['/api/session/forget', '/api/session']);
    assert.deepEqual(h.waits, [1000]);
  }
});

test('lost reconnect response requires a new connectedAt instead of accepting the old session', async () => {
  const baseline = { connected: true, connectedAt: '2026-09-08T00:00:00Z' };
  const h = client(path => path === '/api/session' ? response(baseline) : lost(), { getSession: () => baseline });
  await assert.rejects(h.api('/api/session/connect', {}), { code: 'NETWORK_OFFLINE' });
  assert.equal(h.requests.filter(r => r.method === 'POST').length, 1);
  assert.deepEqual(h.waits, [1000, 2000, 4000]);

  const renewed = { connected: true, connectedAt: '2026-09-08T00:01:00Z' };
  const changed = client(path => path === '/api/session' ? response(renewed) : lost(), { getSession: () => baseline });
  assert.deepEqual(await changed.api('/api/session/connect', {}), renewed);
  assert.equal(changed.requests.filter(r => r.method === 'POST').length, 1);
  assert.equal(changed.notices.at(-1).status, 'recovered');
});

test('concurrent GET recovery coalesces duplicate progress notices', async () => {
  const counts = new Map(), releases = [];
  const h = client(path => { const n = (counts.get(path) || 0) + 1; counts.set(path, n); return n === 1 ? lost() : response({}); }, { sleep: () => new Promise(resolve => releases.push(resolve)) });
  const first = h.api('/api/availability'), second = h.api('/api/session');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.notices.filter(n => n.status === 'retrying').length, 1);
  releases.forEach(resolve => resolve());
  await Promise.all([first, second]);
  assert.equal(h.notices.filter(n => n.status === 'recovered').length, 1);
});
