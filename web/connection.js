const delays = [1000, 2000, 4000];
const offlineMessage = '서버 연결이 끊겼어요. 자동으로 다시 연결하지 못했습니다. 저장된 결과는 유지됩니다. 잠시 후 다시 시도해주세요.';
const errorWith = (code, message) => Object.assign(new Error(message), { code });
const offline = () => errorWith('NETWORK_OFFLINE', offlineMessage);
const transportError = error => error?.name === 'TypeError';
const changedJob = () => errorWith('JOB_CHANGED', '다른 조회가 진행되거나 조회 상태가 바뀌었어요. 진행 상태를 확인한 후 다시 시도해주세요.');

function matchesSelection(job, body, catalog) {
  if (body.scope === 'all') return job.scope === 'all' && !job.onlyForestIds?.length;
  if ((job.scope || 'selection') !== 'selection' || job.month !== (body.month || catalog?.months?.[0]?.id)
    || job.type !== (body.type || 'all') || job.nights !== Number(body.nights || 1)) return false;
  if (body.forestId) return job.onlyForestIds?.length === 1 && job.onlyForestIds[0] === body.forestId;
  return !job.onlyForestIds?.length && job.region === (body.region || 'all');
}

export function createApiClient({ fetcher = fetch, getCsrf = () => '', getJob = () => null, getSession = () => null, onSession = () => {}, onRecovery = () => {}, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  const recovering = new Map();
  let lastNotice = '', recoveryFailed = false;
  function notice(status, attempt = 0) {
    const key = `${status}:${attempt}`;
    if (lastNotice === key) return;
    lastNotice = key;
    const message = status === 'retrying' ? `서버 연결을 다시 시도하고 있어요. (${attempt}/3)`
      : status === 'recovered' ? '서버에 다시 연결됐어요.' : offlineMessage;
    onRecovery({ status, attempt, message });
  }
  function settled(token, failed) {
    if (!recovering.delete(token)) return;
    recoveryFailed ||= failed;
    if (!recovering.size) notice(recoveryFailed ? 'failed' : 'recovered');
  }
  async function request(path, body, requestId) {
    let response;
    try {
      response = await fetcher(path, { method: body === undefined ? 'GET' : 'POST',
        headers: body === undefined ? {} : { 'Content-Type': 'application/json', 'X-CSRF-TOKEN': getCsrf(), ...(requestId ? { 'X-Request-ID': requestId } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    } catch (error) { throw transportError(error) ? offline() : error; }
    let json;
    try { json = await response.json(); }
    catch (error) {
      if (transportError(error)) throw offline();
      throw errorWith('INVALID_RESPONSE', '서버 응답을 읽지 못했어요. 잠시 후 다시 시도해주세요.');
    }
    if (!response.ok) throw errorWith(json.error?.code, json.error?.message || '조회에 실패했습니다. 다시 시도해주세요.');
    return json;
  }
  function reconcile(path, body, baseline, snapshot, previousSession) {
    const latest = snapshot.job;
    if (path === '/api/sync') {
      if (latest?.id !== baseline?.id) {
        if (!latest || !matchesSelection(latest, body, snapshot.catalog)) throw changedJob();
        return { job: latest };
      }
      // The server may have returned the running job instead of starting a new one.
      if (latest && (latest.status === 'running' || JSON.stringify(latest) !== JSON.stringify(baseline))) return { job: latest };
      return null;
    }
    if (/^\/api\/job\/(step|resume|retry|pause|cancel)$/.test(path)) {
      if (!latest || !baseline || latest.id !== baseline.id) throw changedJob();
      return JSON.stringify(latest) !== JSON.stringify(baseline) ? { job: latest } : null;
    }
    if (path === '/api/session/connect') {
      if (snapshot.connected && (!previousSession?.connected || (snapshot.connectedAt && snapshot.connectedAt !== previousSession.connectedAt))) return snapshot;
      // A lost login response is checked again, without resending credentials.
      throw offline();
    }
    if (path === '/api/session/forget') {
      if (snapshot.configured === false && snapshot.connected === false) return snapshot;
      // Never replay deletion: another account may have been saved in the meantime.
      throw errorWith('RESPONSE_UNCERTAIN', '계정 삭제 결과를 확인하지 못했어요. 현재 연결 상태를 확인한 후 다시 시도해주세요.');
    }
    if (path === '/api/session/disconnect') return snapshot.connected ? null : { connected: false };
    if (/^\/api\/forests\/[A-Za-z0-9_-]+\/price$/.test(path)) return null;
    throw errorWith('RESPONSE_UNCERTAIN', '요청의 처리 결과를 확인하지 못했어요. 현재 상태를 확인한 후 다시 시도해주세요.');
  }
  return async function api(path, input) {
    const body = input === undefined ? undefined : JSON.parse(JSON.stringify(input));
    const requestId = body !== undefined && /^\/api\/(sync|job\/(step|resume|retry|pause|cancel))$/.test(path) ? crypto.randomUUID() : undefined;
    const baseline = JSON.parse(JSON.stringify(getJob() || null));
    const session = getSession();
    const previousSession = session ? { connected: session.connected, connectedAt: session.connectedAt } : null;
    const token = Symbol();
    let needsRecovery = false;
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          if (needsRecovery) {
            recovering.set(token, attempt);
            notice('retrying', Math.max(...recovering.values()));
            await sleep(delays[attempt - 1]);
            if (body !== undefined) {
              const snapshot = await request('/api/session');
              onSession(snapshot);
              const recovered = reconcile(path, body, baseline, snapshot, previousSession);
              if (recovered) { settled(token, false); return recovered; }
            }
          }
          const result = await request(path, body, requestId);
          settled(token, false);
          return result;
        } catch (error) {
          if (error.code !== 'NETWORK_OFFLINE') { settled(token, false); throw error; }
          if (attempt >= delays.length) { settled(token, true); throw error; }
          if (!needsRecovery && !recovering.size) { recoveryFailed = false; lastNotice = ''; }
          needsRecovery = true;
        }
      }
    } finally { settled(token, false); }
  };
}
