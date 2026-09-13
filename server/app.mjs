import { Foresttrip, SourceError } from './foresttrip.mjs';
import { kstToday, monthDates, nextMonth, normalizeDay, normalizeUnit, summarizeForest } from './domain.mjs';
import { SharedStore, safeSource, cacheKey } from './shared.mjs';
import { FacilityCache } from './facility-cache.mjs';
import { forestLocation } from './forest-location.mjs';
import { NaverBlogSource } from './naver-blogs.mjs';

const typeCode = { stay: '01', camp: '02' };
const now = () => new Date().toISOString();
const snapshotKey = task => `snapshot:${task.month}:${task.forestId}:${task.type}`;
const pendingKey = (job, task) => `pending:${job.id}:${snapshotKey(task)}`;
const targeted = job => !!job.onlyForestIds?.length;
const response = (data, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
const invalid = message => { throw new SourceError('INVALID_INPUT', message, 400); };
const safeError = error => error instanceof SourceError ? { code: error.code, message: error.message } : { code: 'INTERNAL', message: '처리 중 문제가 생겼습니다. 저장된 결과는 유지됩니다. 다시 시도해주세요.' };
const collectionMonths = job => job.months || [job.month, ...(job.nights > 1 ? [nextMonth(job.month)] : [])];
const rememberRequest = (job, id, action, signature) => { if (id) job.requests = [...(job.requests || []).filter(r => r.id !== id).slice(-63), { id, action, signature }]; };
const isReplay = (job, id, action, signature) => {
  const previous = id && job?.requests?.find(r => r.id === id);
  if (previous && (previous.action !== action || previous.signature !== signature)) invalid('요청 식별자가 다른 작업에 사용됐습니다. 다시 시도해주세요.');
  return !!previous;
};
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
export function createApp({ store, sourceFactory = state => new Foresttrip(state), storageLocation = 'local', shared = new SharedStore(store.db), assetStore, waitUntil, facilityCache = new FacilityCache({ db: store.db, assetStore, waitUntil }), naverBlogs = new NaverBlogSource() }) {
  const catalogForRead = async () => await shared.catalog() || await store.get('catalog');
  const forestForRead = async id => await shared.forest(id) || await store.get(`forest:${id}`);
  // Anonymous shared access remains pending a product decision. A retained
  // personal catalog proves a past successful connection, even after disconnect.
  const canReadShared = async () => !!await store.get('catalog');
  async function sourceValue(job, work, kind, input, load) {
    const key = await cacheKey({ kind, input });
    const cached = !targeted(job) && !job.forceSource ? await shared.cached('source', key) : null;
    if (cached) {
      work.sourceObservedAt = cached.observedAt;
      return cached.value;
    }
    const value = safeSource(kind, await load()), observedAt = now();
    work.sourceObservedAt = observedAt;
    work.sources ||= [];
    work.sources.push({ kind: 'source', key, forestId: work.forestId, value, observedAt, createdAt: Date.parse(observedAt), expiresAt: Date.parse(observedAt) + 10000 });
    return value;
  }
  // Targeted refreshes publish with compare-and-set on the forest generation.
  // Ordinary collections publish without a generation check: they never conflict
  // with each other, and a scope that is already newer in the shared store is
  // simply skipped (see SharedStore.publish).
  async function publish(job, options) {
    const cas = targeted(job);
    const ids = cas ? [...new Set([...(options.forests || []).map(f => f.id), ...(options.snapshots || []).map(s => s.forestId)])] : [];
    const expected = Object.fromEntries(ids.map(id => [id, job.generations?.[id] || 0]));
    const publicationId = crypto.randomUUID();
    job.published ||= {};
    for (const s of options.snapshots || []) job.published[snapshotKey(s)] = publicationId;
    const result = await shared.publish({ ...options, expected, publicationId });
    if (!result.accepted) throw new SourceError('SOURCE_CONFLICT', '다른 조회가 먼저 갱신한 범위를 다시 확인합니다.');
    if (cas) job.generations = { ...job.generations, ...result.generations };
    return result;
  }
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
    if (!targeted(job)) {
      const forest = await forestForRead(task.forestId);
      const result = await publish(job, { snapshots: [{ ...snapshot, regionId: forest.regionId }], sources: task.sources || [] });
      task.sources = [];
      // The shared store already holds a newer observation of this scope; stop
      // spending source requests on it and leave the newer data in place.
      if (result.skipped.includes(snapshotKey(task))) { task.status = 'complete'; task.superseded = true; delete job.published[snapshotKey(task)]; }
    }
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
    const snapshots = [];
    for (const task of job.tasks.filter(t => t.kind === 'scope')) {
      const snapshot = await store.get(pendingKey(job, task));
      if (snapshot?.status !== 'complete') throw new SourceError('INTERNAL', '완료된 조회 결과를 읽지 못했습니다. 다시 시도해주세요.');
      const forest = job.stagedForests?.[task.forestId] || await forestForRead(task.forestId);
      snapshots.push({ ...snapshot, regionId: forest.regionId });
    }
    const result = await publish(job, { forests: Object.values(job.stagedForests || {}), snapshots,
      sources: [...job.regions, ...job.tasks].flatMap(t => t.sources || []), invalidatePrices: job.onlyForestIds,
      personal: [[store.key('job'), job]] });
    job.publicationId = result.publicationId;
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
  async function advance(job, requestId, requestSignature) {
    const { auth, source } = await sourceSession();
    let work = job.regions.find(r => r.status === 'pending');
    try {
      job.error = null; job.waitUntil = null;
      if (work) {
        // Targeted refreshes capture generations BEFORE the upstream request,
        // including newly discovered forests (absent means generation zero).
        if (targeted(job) && !job.generations) job.generations = Object.fromEntries((await shared.statement("SELECT substr(scope_key,8) AS id,version FROM shared_versions WHERE scope_key >= 'forest:' AND scope_key < 'forest;' ").all()).results.map(r => [r.id, r.version]));
        const forests = [...new Map((await sourceValue(job, work, 'forests', work.region, () => source.forests(work.region))).map(f => [f.id, f])).values()];
        const published = [];
        for (const forest of forests) {
          const old = await forestForRead(forest.id);
          if (job.onlyForestIds?.includes(forest.id)) {
            job.stagedForests ||= {};
            job.stagedForests[forest.id] = { ...old, ...forest };
          } else if (!targeted(job)) published.push({ ...old, ...forest });
          if (job.onlyForestIds && !job.onlyForestIds.includes(forest.id)) continue;
          if (!job.forestIds.includes(forest.id)) {
            job.forestIds.push(forest.id);
            job.tasks.push({ kind: 'policy', forestId: forest.id, name: forest.name, stage: 'policy', status: 'pending' });
          }
        }
        if (!targeted(job)) {
          await publish(job, { forests: published, sources: work.sources || [], knownRegion: work.region.id });
          work.sources = [];
        }
        work.status = 'complete';
      } else {
        work = job.tasks.find(t => t.status === 'pending');
        if (work?.kind === 'policy') {
          const policy = await sourceValue(job, work, 'policy', work.forestId, () => source.policy(work.forestId));
          const types = [...new Set(policy.types.map(t => Object.keys(typeCode).find(k => typeCode[k] === t.upperGoodsClsscCd)).filter(Boolean))];
          const forest = job.stagedForests?.[work.forestId] || await forestForRead(work.forestId);
          if (targeted(job)) {
            job.stagedForests ||= {};
            job.stagedForests[forest.id] = { ...forest, types };
          } else { await publish(job, { forests: [{ ...forest, types }], sources: work.sources || [] }); work.sources = []; }
          const scopes = [];
          for (const month of collectionMonths(job)) {
            for (const type of types.filter(t => job.type === 'all' || t === job.type)) scopes.push({ kind: 'scope', forestId: forest.id, name: forest.name, month, type, lastDay: policy.lastDay, stage: 'queue', status: 'pending', cursor: 0 });
          }
          job.tasks.splice(job.tasks.indexOf(work) + 1, 0, ...scopes);
          work.status = 'complete';
        } else if (work) {
          const scope = { insttId: work.forestId, upperGoodsClsscCd: typeCode[work.type], srchDate: work.month, lastDay: work.lastDay, inqurSctin: '01' };
          if (work.stage === 'queue') {
            const goodsKey = await cacheKey({ kind: 'goods', input: scope });
            const cachedGoods = !targeted(job) && !job.forceSource ? await shared.cached('source', goodsKey) : null;
            const queue = cachedGoods ? { granted: true, cached: true } : await source.queue(auth.queue);
            if (!queue.cached) auth.queue = queue;
            if (queue.granted) {
              const goods = cachedGoods ? cachedGoods.value : await sourceValue(job, work, 'goods', scope, () => source.goods(scope, queue));
              work.units = goods.rsrvtGoodsList.map(r => normalizeUnit(r, work.type));
              if (new Set(work.units.map(u => u.id)).size !== work.units.length) throw new SourceError('SOURCE_CHANGED', '시설 목록에 중복 항목이 있어 조회를 멈췄습니다.');
              work.holidays = (goods.hldtInfoList || []).map(h => ({ dt: String(h.dt), dtCd: h.dtCd }));
              work.stage = 'completeQueue';
              // Targeted updates stay private until every scope has completed.
              await store.set(pendingKey(job, work), { forestId: work.forestId, month: work.month, type: work.type, jobId: job.id, units: work.units, days: {}, checkedUnits: 0, status: 'partial', observedAt: cachedGoods?.observedAt || work.sourceObservedAt });
              if (!queue.cached) await source.completeQueue(queue); auth.queue = null; work.stage = 'days';
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
              const rows = await sourceValue(job, work, 'days', { ...scope, ids: [...ids].sort() }, () => source.days(scope, ids));
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
              if (!snapshot.observedAt || work.sourceObservedAt < snapshot.observedAt) snapshot.observedAt = work.sourceObservedAt;
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
      if (safe.code === 'SOURCE_CONFLICT' && (job.conflictRetries || 0) < 3) {
        job.conflictRetries = (job.conflictRetries || 0) + 1;
        for (const row of job.tasks.filter(t => t.kind === 'scope')) await store.remove(pendingKey(job, row));
        job.regions.forEach(r => { r.status = 'pending'; r.sources = []; });
        job.tasks = []; job.forestIds = []; job.stagedForests = {}; job.generations = null;
        job.published = {}; job.status = 'running'; job.finishedAt = null; job.forceSource = true; auth.queue = null;
      } else if (safe.code === 'AUTH_REQUIRED') { job.status = 'auth_required'; auth.connectedAt = null; auth.queue = null; }
      else if (safe.code === 'ACCESS_LIMIT') { job.status = 'blocked'; }
      else { if (work) { work.status = 'failed'; work.error = safe; } }
    } finally {
      job.updatedAt = now();
      await store.setSecret('auth', { ...source.export(), ...(auth.connectedAt === null ? { connectedAt: null } : {}), queue: auth.queue || null });
      rememberRequest(job, requestId, 'step', requestSignature);
      await store.set('job', job);
    }
    return publicJob(job);
  }
  async function availability(query, forestId) {
    const prefixes = ['forest:', `snapshot:${query.month}:`, ...(query.nights > 1 ? [`snapshot:${nextMonth(query.month)}:`] : [])];
    const rows = (await store.db.prepare(`SELECT key,value FROM kv WHERE key = ? OR ${prefixes.map(() => '(key >= ? AND key < ?)').join(' OR ')} ORDER BY key`).bind(store.key('job'),...prefixes.flatMap(prefix=>store.prefixRange(prefix))).all()).results;
    const legacyForests = rows.filter(r => r.key.startsWith(store.key('forest:'))).map(r => JSON.parse(r.value)).filter(f => (query.region === 'all' || f.regionId === query.region) && (!forestId || f.id === forestId));
    const legacySnapshots = rows.filter(r => r.key.startsWith(store.key('snapshot:'))).map(r => JSON.parse(r.value));
    const jobRow = rows.find(r => r.key === store.key('job')), job = jobRow ? JSON.parse(jobRow.value) : null;
    const allowed = await canReadShared();
    const months = [query.month, ...(query.nights > 1 ? [nextMonth(query.month)] : [])];
    const wantedFor = f => months.flatMap(month => (f.types || []).filter(t => query.type === 'all' || t === query.type).map(type => snapshotKey({ month, forestId: f.id, type })));
    // Retained personal rows only matter where the shared payload does not cover
    // them; a cached shared result that covers every wanted legacy key is reused.
    const covers = payload => legacyForests.every(f => payload.forests.some(p => p.id === f.id))
      && legacySnapshots.every(s => { const f = payload.forests.find(p => p.id === s.forestId); return !f || !wantedFor(f).includes(snapshotKey(s)) || !!f.scopePublications?.[snapshotKey(s)]; });
    const read = allowed ? await shared.read(query, forestId, { accept: legacyForests.length || legacySnapshots.length ? covers : null }) :
      { catalog: await catalogForRead(), knownRegions: [], forests: [], snapshots: [], versions: [], dependencies: '', cacheHit: false, createdAt: Date.now() };
    let payload = read.payload, fallbackKeys = [];
    if (!payload) {
      if (!read.catalog) { read.catalog = await store.get('catalog'); read.personalCatalog = !!read.catalog; }
      const forestMap = new Map(read.forests.map(f => [f.id, f]));
      const legacyIds = legacyForests.filter(f => !forestMap.has(f.id)).map(f => f.id);
      for (const f of legacyForests) if (!forestMap.has(f.id)) forestMap.set(f.id, f);
      const snapshots = new Map(read.snapshots.map(s => [snapshotKey(s), s])), fallback = new Set();
      for (const s of legacySnapshots) if (forestMap.has(s.forestId) && (query.type === 'all' || s.type === query.type) && !snapshots.has(snapshotKey(s))) {
        snapshots.set(snapshotKey(s), { ...s, publicationId: s.jobId }); fallback.add(snapshotKey(s));
      }
      const regionIds = [...new Set(query.region === 'all' ? read.catalog?.regions?.map(r => r.id) || [] : [query.region])];
      const knownRegions = [...read.knownRegions, ...(legacyIds.length ? await store.get('knownRegions') || [] : [])];
      const dataCoverage = { sharedScopes: read.snapshots.length, fallbackScopes: 0, missingScopes: 0, emptyScopes: 0, legacyForests: legacyIds.length };
      let complete = 0, pending = 0;
      const forests = [...forestMap.values()].map(f => {
        const wanted = wantedFor(f);
        const relevant = wanted.map(key => snapshots.get(key)).filter(Boolean);
        // Only legacy scopes the result actually uses count as fallback.
        for (const key of wanted) if (fallback.has(key) && snapshots.has(key)) fallbackKeys.push(key);
        dataCoverage.missingScopes += wanted.length - relevant.length;
        dataCoverage.emptyScopes += relevant.filter(s => s.status === 'complete' && !s.units.length).length;
        const isComplete = !!f.types && wanted.every(key => snapshots.get(key)?.status === 'complete');
        isComplete ? complete++ : pending++;
        return { ...summarizeForest(f, relevant, query, !!forestId), coverage: isComplete ? 'complete' : 'partial',
          scopePublications: Object.fromEntries(relevant.map(s => [snapshotKey(s), s.publicationId])) };
      });
      dataCoverage.fallbackScopes = fallbackKeys.length;
      const coverage = { discovered: forests.length, complete, pending, missingRegions: regionIds.filter(r => !knownRegions.includes(r)).length, regionTotal: regionIds.length };
      // connect-required: shared reading is withheld because this browser never
      // connected; it is neither "not collected yet" nor a confirmed empty result.
      dataCoverage.state = !allowed ? 'connect-required' : fallbackKeys.length || legacyIds.length ? 'personal-fallback' : !read.catalog || !regionIds.length ? 'unavailable' : coverage.missingRegions || dataCoverage.missingScopes || pending ? 'incomplete' : !forests.length || dataCoverage.emptyScopes === dataCoverage.sharedScopes ? 'empty' : 'shared';
      const times = forests.map(f => f.observedAt).filter(Boolean).sort();
      payload = { query, forests, coverage, dataCoverage, dataVersion: read.dependencies, sourceObservedAt: times[0] || null };
      if (allowed && !fallbackKeys.length && !legacyIds.length && !read.personalCatalog) await shared.cache({ kind: 'search', key: read.key, dependencies: read.dependencies, value: payload, createdAt: read.createdAt, expiresAt: read.createdAt + 10000 }).catch(() => {});
    }
    const personal = { job: publicJob(job), fallbackKeys, forests: {} };
    for (const f of payload.forests) {
      // A superseded scope was refreshed by someone else while this job ran; the shared data is newer, not stale.
      const active = job ? job.tasks.filter(t => t.kind === 'scope' && !t.superseded && t.forestId === f.id && collectionMonths(query).includes(t.month) && (query.type === 'all' || t.type === query.type)) : [];
      personal.forests[f.id] = { failed: active.some(t => t.status === 'failed'), inProgress: active.some(t => t.status === 'pending'),
        staleByJob: active.some(t => f.scopePublications[snapshotKey(t)] && f.scopePublications[snapshotKey(t)] !== (job.published?.[snapshotKey(t)] || job.id)) };
    }
    const fetchedAt = now();
    return { ...payload, forests: payload.forests.map(f => ({ ...f, stale: !!f.observedAt && Date.now() - Date.parse(f.observedAt) > 900000,
      priceVersion: read.versions.find(r => r.scope_key === `price:${f.id}`)?.version || 0 })), personal,
      cacheHit: read.cacheHit, cacheAge: Date.now() - read.createdAt, servedAt: fetchedAt, fetchedAt };
  }
  return async function handle(request) {
    const url = new URL(request.url), path = url.pathname;
    try {
      const requestId = request.headers.get('x-request-id');
      if (requestId && !/^[A-Za-z0-9-]{16,64}$/.test(requestId)) invalid('요청 식별자를 확인해주세요.');
      const requestSignature = requestId ? await cacheKey({ path, body: await request.clone().text() }) : null;
      if (request.headers.get('sec-fetch-site') === 'cross-site') return response({ error: { code: 'FORBIDDEN', message: '같은 페이지에서 다시 시도해주세요.' } }, 403);
      let csrf = await store.get('appCsrf');
      if (!csrf) { csrf = crypto.randomUUID(); await store.set('appCsrf', csrf); }
      if (!['GET', 'HEAD'].includes(request.method) && (request.headers.get('origin') !== url.origin || request.headers.get('x-csrf-token') !== csrf)) return response({ error: { code: 'FORBIDDEN', message: '페이지를 새로고침한 후 다시 시도해주세요.' } }, 403);
      const locationMatch = path.match(/^\/api\/forests\/([A-Za-z0-9_-]{1,100})\/location$/);
      if (locationMatch && request.method === 'GET') {
        if (!await canReadShared()) throw new SourceError('LOCATION_ACCESS_REQUIRED', '휴양림 목록을 먼저 조회해주세요.', 403);
        if (!await forestForRead(locationMatch[1])) throw new SourceError('NOT_FOUND', '휴양림을 찾지 못했습니다.', 404);
        return response(await forestLocation({ id: locationMatch[1], shared }));
      }
      const naverSearch = path.match(/^\/api\/forests\/([A-Za-z0-9_-]{1,100})\/naver-blogs$/);
      if (naverSearch && request.method === 'GET') {
        if (!await canReadShared()) throw new SourceError('NAVER_ACCESS_REQUIRED', '휴양림 목록을 조회한 뒤 후기 검색을 열어주세요.', 403);
        const forest = await forestForRead(naverSearch[1]);
        if (!forest?.name) throw new SourceError('FOREST_NOT_FOUND', '조회된 휴양림 목록에서 다시 선택해주세요.', 404);
        const context = { forest: { id: naverSearch[1], name: forest.name }, query: `${forest.name} 후기` };
        const sort = url.searchParams.get('sort') || 'sim', rawStart = url.searchParams.get('start') || '1';
        if (!['sim', 'date'].includes(sort) || !/^[1-9]\d{0,2}$/.test(rawStart) || (Number(rawStart) - 1) % 10 || Number(rawStart) > 991) invalid('검색 정렬과 페이지를 다시 선택해주세요.');
        try {
          // Search results are returned to this request only: no shared
          // cache, database writes, analytics, enrichment or rank changes.
          return response({ ...context, sort, ...await naverBlogs.search({ query: context.query, sort, start: Number(rawStart) }) });
        } catch (error) {
          if (!(error instanceof SourceError)) error = new SourceError('NAVER_UNAVAILABLE', '네이버 검색에 연결하지 못했습니다. 잠시 후 다시 시도해주세요.', 502);
          return response({ ...context, error: safeError(error) }, error.status);
        }
      }
      const facilityAsset = path.match(/^\/api\/facility-assets\/([a-f0-9]{64})$/);
      if (facilityAsset && ['GET', 'HEAD'].includes(request.method)) {
        if (!await canReadShared()) throw new SourceError('FACILITY_ACCESS_REQUIRED', '휴양림을 먼저 조회한 뒤 시설 정보를 열어주세요.', 403);
        const asset = await facilityCache.asset(facilityAsset[1]);
        if (!asset) throw new SourceError('ASSET_NOT_FOUND', '저장된 이미지를 찾을 수 없습니다. 시설 정보를 다시 확인해주세요.', 404);
        const headers = { 'Content-Type': asset.contentType, 'Cache-Control': 'private, no-cache', 'ETag': asset.etag, 'X-Content-Type-Options': 'nosniff' };
        if (request.headers.get('if-none-match') === asset.etag) return new Response(null, { status: 304, headers });
        return new Response(request.method === 'HEAD' ? null : asset.bytes, { headers });
      }
      const facility = path.match(/^\/api\/forests\/([A-Za-z0-9_-]{1,80})\/units\/([A-Za-z0-9_-]{1,120})$/);
      if (facility && request.method === 'GET') {
        if (!await canReadShared()) throw new SourceError('FACILITY_ACCESS_REQUIRED', '휴양림을 먼저 조회한 뒤 시설 정보를 열어주세요.', 403);
        const query = { forestId: facility[1], unitId: facility[2], type: url.searchParams.get('type') };
        if (!['stay', 'camp'].includes(query.type)) invalid('시설 종류를 확인해주세요.');
        // Only units already collected by the app can trigger a source request.
        const known = await store.db.prepare("SELECT 1 AS found FROM shared_snapshots s, json_each(s.data,'$.units') u WHERE s.forest_id=? AND s.type=? AND json_extract(u.value,'$.id')=? LIMIT 1").bind(query.forestId, query.type, query.unitId).first();
        const legacy = !known && (await store.list('snapshot:')).some(s => s.forestId === query.forestId && s.type === query.type && s.units?.some(u => u.id === query.unitId));
        if (!known && !legacy) throw new SourceError('FACILITY_NOT_FOUND', '조회된 시설 목록에서 시설을 다시 선택해주세요.', 404);
        return response(await facilityCache.get(query));
      }
      if (path === '/api/session' && request.method === 'GET') {
        const auth = await store.getSecret('auth');
        return response({ connected: !!auth?.connectedAt, connectedAt: auth?.connectedAt || null, ...accountInfo(await savedCredentials()), storageLocation, csrfToken: csrf, catalog: await catalogForRead(), job: publicJob(await store.get('job')) });
      }
      if (path === '/api/session/connect' && request.method === 'POST') return await withLock(async () => {
        const { explicit, credentials } = await connectionInput(request);
        if (!credentials) throw new SourceError('CREDENTIALS_REQUIRED', '처음 연결할 때 숲나들e 아이디와 비밀번호를 입력해주세요.', 400);
        // A new account must authenticate independently of an existing login cookie.
        const source = sourceFactory(explicit ? null : await store.getSecret('auth'));
        const catalog = await source.login(credentials.id, credentials.password);
        const entries = [['auth', await store.sealSecret(source.export())], ['credentials', await store.sealSecret(credentials)], ['catalog', catalog]];
        // Store the validated account, session and catalog as one successful generation.
        await store.db.batch([store.db.prepare(`INSERT INTO kv(key,value) VALUES ${entries.map(() => '(?,?)').join(',')} ON CONFLICT(key) DO UPDATE SET value=excluded.value`)
          .bind(...entries.flatMap(([key, value]) => [store.key(key), JSON.stringify(value)])), ...shared.catalogStatements(catalog)]);
        return response({ connected: true, connectedAt: source.connectedAt, ...accountInfo(credentials), catalog });
      });
      if (path === '/api/session/disconnect' && request.method === 'POST') return await withLock(() => clearConnection());
      if (path === '/api/session/forget' && request.method === 'POST') return await withLock(() => clearConnection(true));
      if (path === '/api/availability' && request.method === 'GET') return response(await availability(queryFrom(Object.fromEntries(url.searchParams), await catalogForRead())));
      const detail = path.match(/^\/api\/forests\/([A-Za-z0-9_-]+)$/);
      if (detail && request.method === 'GET') return response(await availability(queryFrom(Object.fromEntries(url.searchParams), await catalogForRead()), detail[1]));
      const price = path.match(/^\/api\/forests\/([A-Za-z0-9_-]+)\/price$/);
      if (price && request.method === 'POST') {
        const input = await request.json();
        const query = { forestId: price[1], unitId: input.unitId, type: input.type, date: input.date, nights: input.nights };
        if (typeof query.unitId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(query.unitId) || !['stay', 'camp'].includes(query.type) || typeof query.date !== 'string' || !/^20\d{2}(0[1-9]|1[0-2])\d{2}$/.test(query.date) || ![1, 2, 3].includes(query.nights) || !monthDates(query.date.slice(0, 6)).includes(query.date) || query.date < kstToday()) invalid('요금을 확인할 시설과 날짜를 다시 선택해주세요.');
        const sharedSnapshot = await canReadShared() ? await shared.snapshot(`snapshot:${query.date.slice(0, 6)}:${query.forestId}:${query.type}`) : null;
        const snapshot = sharedSnapshot || await store.get(`snapshot:${query.date.slice(0, 6)}:${query.forestId}:${query.type}`);
        if (!snapshot?.units.some(u => u.id === query.unitId)) invalid('조회된 시설을 선택해주세요.');
        const key = `price:${query.forestId}:${query.type}:${query.unitId}:${query.date}:${query.nights}`;
        const version = await shared.priceVersion(query.forestId);
        const cached = sharedSnapshot ? await shared.cached('price', key, String(version)) : null;
        if (cached) return response({ quote: cached.value, priceVersion: version });
        const legacyQuote = !sharedSnapshot ? await store.get(key) : null;
        if (legacyQuote && (legacyQuote.priceVersion || 0) === version && Date.now() - Date.parse(legacyQuote.observedAt) < 900000) return response({ quote: legacyQuote, priceVersion: version });
        return await withLock(async () => {
          const { source, auth } = await sourceSession();
          try {
            const quote = safeSource('price', await source.price(query));
            if (await shared.priceVersion(query.forestId) !== version) throw new SourceError('BUSY', '현황이 갱신됐어요. 새 요금을 다시 확인합니다.', 409);
            if (sharedSnapshot) await shared.cache({ kind: 'price', key, forestId: query.forestId, dependencies: String(version), value: quote, observedAt: quote.observedAt, createdAt: Date.now(), expiresAt: Date.parse(quote.observedAt) + 900000 }).catch(() => {});
            else await store.set(key, { ...quote, priceVersion: version });
            return response({ quote, priceVersion: version });
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
        if (isReplay(existing, requestId, 'sync', requestSignature)) return response({ job: publicJob(existing) }, 202);
        if (existing?.status === 'running') return response({ job: publicJob(existing) }, 202);
        let onlyForestIds = null;
        if (input.forestId) {
          const forest = await forestForRead(input.forestId);
          if (!forest) invalid('먼저 지역의 휴양림 목록을 조회해주세요.');
          onlyForestIds = [forest.id]; query.region = forest.regionId;
        }
        const auth = await store.getSecret('auth'); auth.queue = null; await store.setSecret('auth', auth);
        const selectedMonths = listedMonths || [query.month];
        const months = [...new Set(selectedMonths.flatMap(month => [month, ...(query.nights > 1 ? [nextMonth(month)] : [])]))].sort();
        const regions = [...new Map(catalog.regions.filter(r => query.region === 'all' || r.id === query.region).map(region => [region.id, region])).values()];
        const job = { id: crypto.randomUUID(), ...query, scope: all ? 'all' : 'selection', listedMonths: selectedMonths, months, onlyForestIds, generations: onlyForestIds ? await shared.generations(onlyForestIds) : null, status: 'running', startedAt: now(), updatedAt: now(), regions: regions.map(region => ({ region, status: 'pending' })), tasks: [], forestIds: [] };
        rememberRequest(job, requestId, 'sync', requestSignature);
        await store.set('job', job); return response({ job: publicJob(job) }, 202);
      });
      const jobAction = path.match(/^\/api\/job\/(step|pause|resume|retry|cancel)$/);
      if (jobAction && request.method === 'POST') return await withLock(async () => {
        const job = await store.get('job'); if (!job) invalid('진행 중인 조회가 없습니다.');
        const action = jobAction[1];
        if (isReplay(job, requestId, action, requestSignature)) return response({ job: publicJob(job) });
        if (action === 'step') {
          if (job.status !== 'running') return response({ job: publicJob(job) });
          if (job.waitUntil && job.waitUntil > Date.now()) return response({ job: publicJob(job) });
          const result = await advance(job, requestId, requestSignature);
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
          // A manual resume or retry gets a fresh conflict budget; the generation
          // baseline is kept so a retained scope still cannot overwrite a newer refresh.
          job.status = 'running'; job.error = null; job.waitUntil = null; job.conflictRetries = 0;
        }
        rememberRequest(job, requestId, action, requestSignature);
        job.updatedAt = now(); await store.set('job', job); return response({ job: publicJob(job) });
      });
      return response({ error: { code: 'NOT_FOUND', message: '요청한 기능을 찾을 수 없습니다.' } }, 404);
    } catch (error) {
      // Keep request data, credentials and upstream response text out of logs.
      if (!(error instanceof SourceError)) console.error('API failure', { path, name: error.name, frames: error.stack?.split('\n').slice(1, 4) });
      return response({ error: safeError(error) }, error.status || 500);
    }
  };
}
