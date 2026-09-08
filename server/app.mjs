import { Foresttrip, SourceError } from './foresttrip.mjs';
import { kstToday, monthDates, nextMonth, normalizeDay, normalizeUnit, summarizeForest } from './domain.mjs';

const typeCode = { stay: '01', camp: '02' };
const now = () => new Date().toISOString();
const snapshotKey = task => `snapshot:${task.month}:${task.forestId}:${task.type}`;
const pendingKey = (job, task) => `pending:${job.id}:${snapshotKey(task)}`;
const targeted = job => !!job.onlyForestIds?.length;
const response = (data, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
const invalid = message => { throw new SourceError('INVALID_INPUT', message, 400); };
const safeError = error => error instanceof SourceError ? { code: error.code, message: error.message } : { code: 'INTERNAL', message: '처리 중 문제가 생겼습니다. 저장된 결과는 유지됩니다. 다시 시도해주세요.' };
const collectionMonths = job => job.months || [job.month, ...(job.nights > 1 ? [nextMonth(job.month)] : [])];
export function publicJob(job) {
  if (!job) return null;
  const scopes = job.tasks.filter(t => t.kind === 'scope');
  const completed = scopes.filter(t => t.status === 'complete').length;
  const failed = [...job.regions, ...job.tasks].filter(t => t.status === 'failed');
  const remaining = [...job.regions, ...job.tasks].filter(t => t.status === 'pending').length;
  const pendingRegion = job.regions.find(r => r.status === 'pending');
  const current = pendingRegion ? { name: pendingRegion.region.name, stage: 'region' } : job.tasks.find(t => t.status === 'pending');
  const completedForests = job.forestIds.filter(id => job.tasks.some(t => t.forestId === id && t.kind === 'policy' && t.status === 'complete') && job.tasks.filter(t => t.forestId === id).every(t => t.status === 'complete')).length;
  return { id: job.id, status: job.status, scope: job.scope || 'selection', onlyForestIds: job.onlyForestIds || null, months: collectionMonths(job), listedMonths: job.listedMonths || [job.month], month: job.month, region: job.region, type: job.type, nights: job.nights,
    startedAt: job.startedAt, updatedAt: job.updatedAt, finishedAt: job.finishedAt || null,
    regionsTotal: job.regions.length, regionsDone: job.regions.filter(r => r.status === 'complete').length,
    totalForests: job.forestIds.length, completedForests, completedScopes: completed, totalScopes: scopes.length,
    checkedUnits: scopes.reduce((n, t) => n + (t.cursor || 0), 0), expectedUnits: scopes.reduce((n, t) => n + (t.units?.length || 0), 0),
    remaining, failures: failed.map(t => ({ name: t.name || t.region?.name || '조회 범위', month: t.month, type: t.type, ...(t.error || {}) })),
    current: current ? { name: current.name, stage: current.stage, month: current.month, type: current.type, checked: current.cursor || 0, total: current.units?.length || 0 } : null,
    waitUntil: job.waitUntil || null, error: job.error || null };
}
function queryFrom(input, catalog) {
  const query = { month: input.month || catalog?.months?.[0]?.id || kstToday().slice(0, 6), region: input.region || 'all', type: input.type || 'all', guests: Number(input.guests || 2), nights: Number(input.nights || 1), weekend: input.weekend === true || input.weekend === 'true', includeWait: input.includeWait === true || input.includeWait === 'true', today: kstToday() };
  if (!/^20\d{2}(0[1-9]|1[012])$/.test(query.month) || !['all', 'stay', 'camp'].includes(query.type) || !Number.isInteger(query.guests) || query.guests < 1 || query.guests > 100 || ![1, 2, 3].includes(query.nights)) invalid('여행 조건을 다시 확인해주세요.');
  if (query.region !== 'all' && !catalog?.regions?.some(r => r.id === query.region)) invalid('조회할 지역을 다시 선택해주세요.');
  return query;
}
const accountInfo = credentials => ({ configured: !!credentials, accountLabel: credentials ? `${Array.from(credentials.id).slice(0, Math.min(2, credentials.id.length - 1)).join('')}••••` : null });
export function createApp({ store, sourceFactory = state => new Foresttrip(state), storageLocation = 'local' }) {
  async function savedCredentials() {
    const credentials = await store.getSecret('credentials');
    return typeof credentials?.id === 'string' && credentials.id.length && typeof credentials.password === 'string' && credentials.password.length ? credentials : null;
  }
  async function connectionInput(request) {
    let input;
    try { const body = await request.text(); input = body.trim() ? JSON.parse(body) : {}; }
    catch { invalid('아이디와 비밀번호를 다시 입력해주세요.'); }
    if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('아이디와 비밀번호를 다시 입력해주세요.');
    const explicit = Object.hasOwn(input, 'id') || Object.hasOwn(input, 'password');
    if (!explicit) return { explicit, credentials: await savedCredentials() };
    if (typeof input.id !== 'string' || !input.id.trim() || input.id.length > 128 || typeof input.password !== 'string' || !input.password.length || input.password.length > 1024) invalid('아이디와 비밀번호를 다시 입력해주세요.');
    return { explicit, credentials: { id: input.id.trim(), password: input.password } };
  }
  async function clearConnection(forget = false) {
    await store.db.prepare('DELETE FROM kv WHERE key IN (?,?)').bind(store.key('auth'), store.key(forget ? 'credentials' : 'auth')).run();
    const job = await store.get('job');
    if (job?.status === 'running') { job.status = 'paused'; job.updatedAt = now(); await store.set('job', job); }
    return response({ connected: false, connectedAt: null, ...accountInfo(await savedCredentials()) });
  }
  async function saveSnapshot(job, task, snapshot) {
    await store.set(pendingKey(job, task), snapshot);
    if (!targeted(job)) await store.set(snapshotKey(task), snapshot);
  }
  async function completeScope(job, task) {
    const snapshot = await store.get(pendingKey(job, task));
    if (!snapshot) throw new SourceError('INTERNAL', '임시 조회 결과를 읽지 못했습니다. 이 범위를 다시 조회해주세요.');
    snapshot.status = 'complete';
    snapshot.observedAt ||= now();
    snapshot.updatedAt = now();
    await saveSnapshot(job, task, snapshot);
    task.status = 'complete';
  }
  async function publishTargeted(job) {
    const entries = [];
    for (const task of job.tasks.filter(t => t.kind === 'scope')) {
      const snapshot = await store.get(pendingKey(job, task));
      if (snapshot?.status !== 'complete') throw new SourceError('INTERNAL', '완료된 조회 결과를 읽지 못했습니다. 다시 시도해주세요.');
      entries.push([snapshotKey(task), snapshot]);
    }
    for (const forest of Object.values(job.stagedForests || {})) entries.push([`forest:${forest.id}`, forest]);
    entries.push(['job', job]);
    // One SQL statement commits every month/type together on both SQLite and D1.
    await store.db.prepare(`INSERT INTO kv(key,value) VALUES ${entries.map(() => '(?,?)').join(',')} ON CONFLICT(key) DO UPDATE SET value=excluded.value`)
      .bind(...entries.flatMap(([key, value]) => [store.key(key), JSON.stringify(value)])).run();
  }
  async function withLock(action) {
    const owner = crypto.randomUUID();
    if (!await store.lock('source', owner)) throw new SourceError('BUSY', '다른 조회를 처리 중입니다. 잠시 후 이어서 진행합니다.', 409);
    try { return await action(); } finally { await store.unlock('source', owner); }
  }
  async function sourceSession() {
    const auth = await store.getSecret('auth');
    if (!auth?.connectedAt) throw new SourceError('AUTH_REQUIRED', '숲나들e를 먼저 연결해주세요.', 401);
    return { auth, source: sourceFactory(auth) };
  }
  async function advance(job) {
    const { auth, source } = await sourceSession();
    let work = job.regions.find(r => r.status === 'pending');
    try {
      job.error = null; job.waitUntil = null;
      if (work) {
        const forests = await source.forests(work.region);
        for (const forest of forests) {
          const old = await store.get(`forest:${forest.id}`);
          if (job.onlyForestIds?.includes(forest.id)) {
            job.stagedForests ||= {};
            job.stagedForests[forest.id] = { ...old, ...forest };
          } else await store.set(`forest:${forest.id}`, { ...old, ...forest });
          if (job.onlyForestIds && !job.onlyForestIds.includes(forest.id)) continue;
          if (!job.forestIds.includes(forest.id)) {
            job.forestIds.push(forest.id);
            job.tasks.push({ kind: 'policy', forestId: forest.id, name: forest.name, stage: 'policy', status: 'pending' });
          }
        }
        work.status = 'complete';
      } else {
        work = job.tasks.find(t => t.status === 'pending');
        if (work?.kind === 'policy') {
          const policy = await source.policy(work.forestId);
          const types = [...new Set(policy.types.map(t => Object.keys(typeCode).find(k => typeCode[k] === t.upperGoodsClsscCd)).filter(Boolean))];
          const forest = job.stagedForests?.[work.forestId] || await store.get(`forest:${work.forestId}`);
          if (targeted(job)) {
            job.stagedForests ||= {};
            job.stagedForests[forest.id] = { ...forest, types };
          } else await store.set(`forest:${work.forestId}`, { ...forest, types });
          const scopes = [];
          for (const month of collectionMonths(job)) {
            for (const type of types.filter(t => job.type === 'all' || t === job.type)) scopes.push({ kind: 'scope', forestId: forest.id, name: forest.name, month, type, lastDay: policy.lastDay, stage: 'queue', status: 'pending', cursor: 0 });
          }
          job.tasks.splice(job.tasks.indexOf(work) + 1, 0, ...scopes);
          work.status = 'complete';
        } else if (work) {
          const scope = { insttId: work.forestId, upperGoodsClsscCd: typeCode[work.type], srchDate: work.month, lastDay: work.lastDay, inqurSctin: '01' };
          if (work.stage === 'queue') {
            const queue = await source.queue(auth.queue);
            auth.queue = queue;
            if (queue.granted) {
              const goods = await source.goods(scope, queue);
              work.units = goods.rsrvtGoodsList.map(r => normalizeUnit(r, work.type));
              if (new Set(work.units.map(u => u.id)).size !== work.units.length) throw new SourceError('SOURCE_CHANGED', '시설 목록에 중복 항목이 있어 조회를 멈췄습니다.');
              work.holidays = (goods.hldtInfoList || []).map(h => ({ dt: String(h.dt), dtCd: h.dtCd }));
              work.stage = 'completeQueue';
              // Targeted updates stay private until every scope has completed.
              await store.set(pendingKey(job, work), { forestId: work.forestId, month: work.month, type: work.type, jobId: job.id, units: work.units, days: {}, checkedUnits: 0, status: 'partial', observedAt: null });
              await source.completeQueue(queue); auth.queue = null; work.stage = 'days';
              if (!work.units.length) await completeScope(job, work);
            } else job.waitUntil = queue.waitUntil;
          } else if (work.stage === 'completeQueue') {
            if (auth.queue) await source.completeQueue(auth.queue);
            auth.queue = null; work.stage = 'days';
            if (!work.units.length) await completeScope(job, work);
          } else if (work.stage === 'days') {
            const ids = work.units.slice(work.cursor, work.cursor + 5).map(u => u.id);
            if (!ids.length) await completeScope(job, work);
            else {
              const rows = await source.days(scope, ids);
              const snapshot = await store.get(pendingKey(job, work));
              if (!snapshot) throw new SourceError('INTERNAL', '임시 조회 결과를 읽지 못했습니다. 이 범위를 다시 조회해주세요.');
              const requiredDates = monthDates(work.month);
              for (const id of ids) {
                const unitRows = rows.filter(r => String(r.goodsId) === id);
                const days = {};
                for (const row of unitRows) {
                  const day = normalizeDay(row, { lastDay: work.lastDay, holidays: work.holidays });
                  if (day && day.date.startsWith(work.month)) {
                    if (days[day.date]) throw new SourceError('SOURCE_CHANGED', '시설의 날짜 상태가 중복되어 확인을 멈췄습니다.');
                    const { date, ...inventory } = day;
                    days[date] = inventory;
                  }
                }
                if (requiredDates.some(date => !days[date])) throw new SourceError('INCOMPLETE_DATA', '일부 날짜가 누락되었습니다. 이 범위는 확인 필요입니다.');
                snapshot.days[id] = days;
                const unit = snapshot.units.find(u => u.id === id);
                const limits = Object.values(days).map(d => d.maxNights).filter(n => n !== null && n > 0);
                if (unit && limits.length) unit.maxNights = Math.min(...limits);
              }
              work.cursor += ids.length; snapshot.checkedUnits = work.cursor;
              if (!snapshot.observedAt) snapshot.observedAt = now();
              snapshot.updatedAt = now();
              if (work.cursor === work.units.length) { work.status = 'complete'; snapshot.status = 'complete'; }
              await saveSnapshot(job, work, snapshot);
            }
          }
        }
      }
      if (![...job.regions, ...job.tasks].some(t => t.status === 'pending')) {
        job.status = [...job.regions, ...job.tasks].some(t => t.status === 'failed') ? 'partial' : 'complete';
        job.finishedAt = now();
        if (targeted(job) && job.status === 'complete') {
          job.updatedAt = job.finishedAt;
          try { await publishTargeted(job); }
          catch (error) { job.status = 'partial'; throw error; }
        }
        if (!targeted(job) || job.status === 'complete') {
          for (const task of job.tasks.filter(t => t.kind === 'scope' && t.status === 'complete')) {
            if (targeted(job)) await store.remove(pendingKey(job, task)).catch(() => {}); // Cleanup cannot undo a committed update.
            else await store.remove(pendingKey(job, task));
          }
        }
      }
    } catch (error) {
      const safe = safeError(error); job.error = safe;
      if (safe.code === 'AUTH_REQUIRED') { job.status = 'auth_required'; auth.connectedAt = null; auth.queue = null; }
      else if (safe.code === 'ACCESS_LIMIT') { job.status = 'blocked'; }
      else { if (work) { work.status = 'failed'; work.error = safe; } }
    } finally {
      job.updatedAt = now();
      await store.setSecret('auth', { ...source.export(), ...(auth.connectedAt === null ? { connectedAt: null } : {}), queue: auth.queue || null });
      await store.set('job', job);
    }
    return publicJob(job);
  }
  async function availability(query, forestId) {
    const catalog = await store.get('catalog');
    const prefixes = ['forest:%', `snapshot:${query.month}:%`, ...(query.nights > 1 ? [`snapshot:${nextMonth(query.month)}:%`] : [])];
    // Read the same committed generation even when a multi-month update finishes mid-request.
    const rows = (await store.db.prepare(`SELECT key,value FROM kv WHERE key = ? OR ${prefixes.map(() => 'key LIKE ?').join(' OR ')} ORDER BY key`).bind(store.key('job'),...prefixes.map(prefix=>store.key(prefix))).all()).results;
    const forests = rows.filter(r => r.key.startsWith(store.key('forest:'))).map(r => JSON.parse(r.value)).filter(f => (query.region === 'all' || f.regionId === query.region) && (!forestId || f.id === forestId));
    const snapshots = rows.filter(r => r.key.startsWith(store.key('snapshot:'))).map(r => JSON.parse(r.value));
    const jobRow = rows.find(r => r.key === store.key('job')), job = jobRow ? JSON.parse(jobRow.value) : null;
    const regionIds = query.region === 'all' ? catalog?.regions?.map(r => r.id) || [] : [query.region];
    const knownRegions = await store.get('knownRegions') || [];
    const missingRegions = regionIds.filter(r => !knownRegions.includes(r));
    let complete = 0, pending = 0;
    const results = forests.map(f => {
      const neededTypes = f.types?.filter(t => query.type === 'all' || t === query.type);
      const wanted = [query.month, ...(query.nights > 1 ? [nextMonth(query.month)] : [])].flatMap(month => (neededTypes || []).map(type => `${month}:${f.id}:${type}`));
      const relevant = snapshots.filter(s => s.forestId === f.id && wanted.includes(`${s.month}:${s.forestId}:${s.type}`));
      const isComplete = !!neededTypes && wanted.every(key => relevant.some(s => `${s.month}:${s.forestId}:${s.type}` === key && s.status === 'complete'));
      isComplete ? complete++ : pending++;
      const result = summarizeForest(f, relevant, query, !!forestId);
      const activeTasks = job && collectionMonths(job).includes(query.month) ? job.tasks.filter(t => t.forestId === f.id && t.kind === 'scope' && wanted.includes(`${t.month}:${t.forestId}:${t.type}`)) : [];
      const stale = relevant.some(s => (Date.now() - Date.parse(s.observedAt || 0) > 15 * 60 * 1000) || (activeTasks.length > 0 && s.jobId !== job.id));
      return { ...result, coverage: isComplete ? 'complete' : 'partial', stale, failed: activeTasks.some(t => t.status === 'failed') };
    });
    return { query, forests: results, coverage: { discovered: forests.length, complete, pending, missingRegions: missingRegions.length, regionTotal: regionIds.length }, job: publicJob(job), queryVersion: job?.updatedAt || null, fetchedAt: now() };
  }
  return async function handle(request) {
    const url = new URL(request.url), path = url.pathname;
    try {
      if (request.headers.get('sec-fetch-site') === 'cross-site') return response({ error: { code: 'FORBIDDEN', message: '같은 페이지에서 다시 시도해주세요.' } }, 403);
      let csrf = await store.get('appCsrf');
      if (!csrf) { csrf = crypto.randomUUID(); await store.set('appCsrf', csrf); }
      if (request.method !== 'GET' && (request.headers.get('origin') !== url.origin || request.headers.get('x-csrf-token') !== csrf)) return response({ error: { code: 'FORBIDDEN', message: '페이지를 새로고침한 후 다시 시도해주세요.' } }, 403);
      if (path === '/api/session' && request.method === 'GET') {
        const auth = await store.getSecret('auth');
        return response({ connected: !!auth?.connectedAt, connectedAt: auth?.connectedAt || null, ...accountInfo(await savedCredentials()), storageLocation, csrfToken: csrf, catalog: await store.get('catalog'), job: publicJob(await store.get('job')) });
      }
      if (path === '/api/session/connect' && request.method === 'POST') return await withLock(async () => {
        const { explicit, credentials } = await connectionInput(request);
        if (!credentials) throw new SourceError('CREDENTIALS_REQUIRED', '처음 연결할 때 숲나들e 아이디와 비밀번호를 입력해주세요.', 400);
        // A new account must authenticate independently of an existing login cookie.
        const source = sourceFactory(explicit ? null : await store.getSecret('auth'));
        const catalog = await source.login(credentials.id, credentials.password);
        const entries = [['auth', await store.sealSecret(source.export())], ['credentials', await store.sealSecret(credentials)], ['catalog', catalog]];
        // Store the validated account, session and catalog as one successful generation.
        await store.db.prepare(`INSERT INTO kv(key,value) VALUES ${entries.map(() => '(?,?)').join(',')} ON CONFLICT(key) DO UPDATE SET value=excluded.value`)
          .bind(...entries.flatMap(([key, value]) => [store.key(key), JSON.stringify(value)])).run();
        return response({ connected: true, connectedAt: source.connectedAt, ...accountInfo(credentials), catalog });
      });
      if (path === '/api/session/disconnect' && request.method === 'POST') return await withLock(() => clearConnection());
      if (path === '/api/session/forget' && request.method === 'POST') return await withLock(() => clearConnection(true));
      if (path === '/api/availability' && request.method === 'GET') return response(await availability(queryFrom(Object.fromEntries(url.searchParams), await store.get('catalog'))));
      const detail = path.match(/^\/api\/forests\/([A-Za-z0-9_-]+)$/);
      if (detail && request.method === 'GET') return response(await availability(queryFrom(Object.fromEntries(url.searchParams), await store.get('catalog')), detail[1]));
      const price = path.match(/^\/api\/forests\/([A-Za-z0-9_-]+)\/price$/);
      if (price && request.method === 'POST') {
        const input = await request.json();
        const query = { forestId: price[1], unitId: input.unitId, type: input.type, date: input.date, nights: input.nights };
        if (typeof query.unitId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(query.unitId) || !['stay', 'camp'].includes(query.type) || typeof query.date !== 'string' || !/^20\d{2}(0[1-9]|1[0-2])\d{2}$/.test(query.date) || ![1, 2, 3].includes(query.nights) || !monthDates(query.date.slice(0, 6)).includes(query.date) || query.date < kstToday()) invalid('요금을 확인할 시설과 날짜를 다시 선택해주세요.');
        const snapshot = await store.get(`snapshot:${query.date.slice(0, 6)}:${query.forestId}:${query.type}`);
        if (!snapshot?.units.some(u => u.id === query.unitId)) invalid('조회된 시설을 선택해주세요.');
        const key = `price:${query.forestId}:${query.type}:${query.unitId}:${query.date}:${query.nights}`;
        const cached = await store.get(key);
        if (cached && Date.now() - Date.parse(cached.observedAt) < 15 * 60 * 1000) return response({ quote: cached });
        return await withLock(async () => {
          const { source, auth } = await sourceSession();
          try {
            const quote = await source.price(query);
            await store.set(key, quote);
            return response({ quote });
          } finally { await store.setSecret('auth', { ...source.export(), queue: auth.queue || null }); }
        });
      }
      if (path === '/api/job' && request.method === 'GET') return response({ job: publicJob(await store.get('job')) });
      if (path === '/api/sync' && request.method === 'POST') return await withLock(async () => {
        await sourceSession();
        const input = await request.json(); const catalog = await store.get('catalog');
        if (input.scope !== undefined && !['selection', 'all'].includes(input.scope)) invalid('조회 범위를 다시 선택해주세요.');
        if (input.scope === 'all' && input.forestId) invalid('전체 조회와 개별 휴양림 조회를 함께 요청할 수 없습니다.');
        const all = input.scope === 'all';
        const listedMonths = all ? [...new Set((catalog?.months || []).map(m => m.id))].sort() : null;
        if (all && (!listedMonths.length || !catalog?.regions?.length)) invalid('숲나들e를 다시 연결해 조회 가능한 월과 지역을 확인해주세요.');
        const query = queryFrom(all ? { month: listedMonths[0], region: 'all', type: 'all', nights: 3 } : input, catalog);
        if (!catalog.months.some(m => m.id === query.month)) invalid('원천에서 제공하는 월을 선택해주세요.');
        const existing = await store.get('job');
        if (existing?.status === 'running') return response({ job: publicJob(existing) }, 202);
        let onlyForestIds = null;
        if (input.forestId) {
          const forest = await store.get(`forest:${input.forestId}`);
          if (!forest) invalid('먼저 지역의 휴양림 목록을 조회해주세요.');
          onlyForestIds = [forest.id]; query.region = forest.regionId;
        }
        const auth = await store.getSecret('auth'); auth.queue = null; await store.setSecret('auth', auth);
        const selectedMonths = listedMonths || [query.month];
        const months = [...new Set(selectedMonths.flatMap(month => [month, ...(query.nights > 1 ? [nextMonth(month)] : [])]))].sort();
        const regions = [...new Map(catalog.regions.filter(r => query.region === 'all' || r.id === query.region).map(region => [region.id, region])).values()];
        const job = { id: crypto.randomUUID(), ...query, scope: all ? 'all' : 'selection', listedMonths: selectedMonths, months, onlyForestIds, status: 'running', startedAt: now(), updatedAt: now(), regions: regions.map(region => ({ region, status: 'pending' })), tasks: [], forestIds: [] };
        await store.set('job', job); return response({ job: publicJob(job) }, 202);
      });
      const jobAction = path.match(/^\/api\/job\/(step|pause|resume|retry|cancel)$/);
      if (jobAction && request.method === 'POST') return await withLock(async () => {
        const job = await store.get('job'); if (!job) invalid('진행 중인 조회가 없습니다.');
        const action = jobAction[1];
        if (action === 'step') {
          if (job.status !== 'running') return response({ job: publicJob(job) });
          if (job.waitUntil && job.waitUntil > Date.now()) return response({ job: publicJob(job) });
          const result = await advance(job);
          const known = new Set(await store.get('knownRegions') || []);
          job.regions.filter(r => r.status === 'complete').forEach(r => known.add(r.region.id)); await store.set('knownRegions', [...known]);
          return response({ job: result });
        }
        if (action === 'pause' || action === 'cancel') job.status = action === 'pause' ? 'paused' : 'cancelled';
        else {
          await sourceSession();
          if (action === 'retry') {
            for (const task of [...job.regions, ...job.tasks]) if (task.status === 'failed') { task.status = 'pending'; task.error = null; }
          }
          // A granted queue ticket is short lived; start a fresh normal entry after interruption.
          const auth = await store.getSecret('auth');
          if (auth.queue?.granted) auth.queue = null;
          await store.setSecret('auth', auth);
          job.status = 'running'; job.error = null; job.waitUntil = null;
        }
        job.updatedAt = now(); await store.set('job', job); return response({ job: publicJob(job) });
      });
      return response({ error: { code: 'NOT_FOUND', message: '요청한 기능을 찾을 수 없습니다.' } }, 404);
    } catch (error) { return response({ error: safeError(error) }, error.status || 500); }
  };
}
