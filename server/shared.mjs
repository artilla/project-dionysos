import { nextMonth } from './domain.mjs';

export const sharedSchema = [
  'CREATE TABLE IF NOT EXISTS shared_forests (id TEXT PRIMARY KEY, region_id TEXT NOT NULL, data TEXT NOT NULL)',
  'CREATE INDEX IF NOT EXISTS shared_forests_region ON shared_forests(region_id)',
  'CREATE TABLE IF NOT EXISTS shared_snapshots (scope_key TEXT PRIMARY KEY, forest_id TEXT NOT NULL, region_id TEXT NOT NULL, month TEXT NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL, generation INTEGER NOT NULL, publication_id TEXT NOT NULL)',
  'CREATE INDEX IF NOT EXISTS shared_snapshots_scope ON shared_snapshots(month, region_id, type)',
  'CREATE TABLE IF NOT EXISTS shared_versions (scope_key TEXT PRIMARY KEY, version INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS shared_catalog (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS shared_regions (id TEXT PRIMARY KEY)',
  'CREATE TABLE IF NOT EXISTS shared_publications (id TEXT PRIMARY KEY)',
  'CREATE TABLE IF NOT EXISTS shared_scope_bundles (scope_key TEXT NOT NULL, part TEXT NOT NULL, month TEXT NOT NULL, region_id TEXT NOT NULL, type TEXT NOT NULL, version INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(scope_key,part))',
  'CREATE INDEX IF NOT EXISTS shared_bundles_scope ON shared_scope_bundles(month, region_id, type)',
  'CREATE TABLE IF NOT EXISTS shared_cache (kind TEXT NOT NULL, cache_key TEXT NOT NULL, forest_id TEXT, dependencies TEXT NOT NULL, data TEXT NOT NULL, observed_at TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY(kind,cache_key))',
  'CREATE INDEX IF NOT EXISTS shared_cache_expiry ON shared_cache(expires_at)',
  'CREATE INDEX IF NOT EXISTS shared_cache_forest ON shared_cache(forest_id,kind)',
];
export const snapshotKey = s => `snapshot:${s.month}:${s.forestId}:${s.type}`;
const forestKey = id => `forest:${id}`;
const rangeKey = s => `range:${s.month}:${s.regionId}:${s.type}`;
const pick = (value, keys) => Object.fromEntries(keys.filter(key => value?.[key] !== undefined).map(key => [key, value[key]]));
export const safeForest = f => pick(f, ['id', 'name', 'regionId', 'region', 'city', 'operator', 'types']);
const safeUnit = u => pick(u, ['id', 'name', 'type', 'capacity', 'maxNights', 'category']);
export function safeSnapshot(s) {
  return { ...pick(s, ['forestId', 'month', 'type', 'checkedUnits', 'status', 'observedAt', 'updatedAt']),
    units: s.units.map(safeUnit), days: Object.fromEntries(Object.entries(s.days).map(([id, days]) => [id,
      Object.fromEntries(Object.entries(days).map(([date, day]) => [date, pick(day, ['state', 'capacity', 'maxNights'])]))])) };
}
export function safeSource(kind, data) {
  if (kind === 'forests') return data.map(safeForest);
  if (kind === 'policy') return { lastDay: data.lastDay, types: data.types.map(t => pick(t, ['upperGoodsClsscCd'])) };
  if (kind === 'goods') return { rsrvtGoodsList: data.rsrvtGoodsList.map(u => pick(u, ['goodsId', 'goodsNm', 'mxmmAccptCnt', 'mxmmStngDayCnt', 'goodsClsscNm'])),
    hldtInfoList: (data.hldtInfoList || []).map(h => pick(h, ['dt', 'dtCd'])) };
  if (kind === 'days') return data.map(d => pick(d, ['goodsId', 'useDt', 'rsrvtAvail', 'rsrvtCnt', 'wtngCnt', 'goodsMxmmWtngCnt', 'wtngPssblYn', 'mxmmAccptCnt', 'mxmmStngDayCnt']));
  if (kind === 'price') return { ...pick(data, ['forestId', 'unitId', 'type', 'date', 'checkout', 'nights', 'currency', 'baseTotal', 'baseGuests', 'extraGuestFeeApplies', 'extraPerGuestTotal', 'observedAt']),
    ...(data.daily ? { daily: data.daily.map(d => pick(d, ['date', 'amount', 'season', 'dayType', 'extraPerGuest'])) } : {}) };
  throw new TypeError('Unsupported source cache');
}
const canonical = value => JSON.stringify(value);
export async function cacheKey(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(value)));
  return Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, '0')).join('');
}
export class SharedStore {
  constructor(db) { this.db = db; }
  statement(sql, ...args) { return this.db.prepare(sql).bind(...args); }
  // Explicit local/test setup. Hosted schema changes are delivered as a migration.
  async init() { for (const sql of sharedSchema) await this.db.exec(sql); }
  async catalog() { const row = await this.statement('SELECT data FROM shared_catalog WHERE id=1').first(); return row ? JSON.parse(row.data) : null; }
  catalogStatements(catalog) {
    const safe = { today: catalog.today, months: catalog.months.map(m => pick(m, ['id', 'name'])), regions: catalog.regions.map(r => pick(r, ['id', 'name'])) };
    return [this.statement("INSERT INTO shared_versions VALUES ('catalog',1) ON CONFLICT(scope_key) DO UPDATE SET version=version+1 WHERE NOT EXISTS (SELECT 1 FROM shared_catalog WHERE id=1 AND data=?)", canonical(safe)),
      this.statement('INSERT INTO shared_catalog VALUES (1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data', canonical(safe))];
  }
  async forest(id) { const row = await this.statement('SELECT data FROM shared_forests WHERE id=?', id).first(); return row ? JSON.parse(row.data) : null; }
  async snapshot(key) {
    const row = await this.statement('SELECT data,generation,publication_id FROM shared_snapshots WHERE scope_key=?', key).first();
    return row ? { ...JSON.parse(row.data), generation: row.generation, publicationId: row.publication_id } : null;
  }
  async generations(ids) {
    const rows = (await this.statement("SELECT scope_key,version FROM shared_versions WHERE scope_key IN (SELECT 'forest:' || value FROM json_each(?))", canonical(ids)).all()).results;
    return Object.fromEntries(ids.map(id => [id, rows.find(r => r.scope_key === forestKey(id))?.version || 0]));
  }
  async cached(kind, key, dependencies = '') {
    const row = await this.statement('SELECT * FROM shared_cache WHERE kind=? AND cache_key=? AND dependencies=? AND expires_at>?', kind, key, dependencies, Date.now()).first();
    return row ? { value: JSON.parse(row.data), observedAt: row.observed_at, createdAt: row.created_at } : null;
  }
  cacheStatement(entry, guard) {
    const sql = 'INSERT INTO shared_cache(kind,cache_key,forest_id,dependencies,data,observed_at,created_at,expires_at) SELECT ?,?,?,?,?,?,?,?' +
      (guard ? ' WHERE EXISTS (SELECT 1 FROM shared_publications WHERE id=?)' : ' WHERE 1') +
      ' ON CONFLICT(kind,cache_key) DO UPDATE SET forest_id=excluded.forest_id,dependencies=excluded.dependencies,data=excluded.data,observed_at=excluded.observed_at,created_at=excluded.created_at,expires_at=excluded.expires_at';
    return this.statement(sql, entry.kind, entry.key, entry.forestId || null, entry.dependencies || '', canonical(entry.value), entry.observedAt || null, entry.createdAt, entry.expiresAt, ...(guard ? [guard] : []));
  }
  async cache(entry) {
    // Only expendable cache entries are removed; published snapshots have no TTL.
    await this.db.batch([this.cacheStatement(entry), this.statement('DELETE FROM shared_cache WHERE rowid IN (SELECT rowid FROM shared_cache WHERE expires_at<=? ORDER BY expires_at LIMIT 32)', Date.now())]);
  }
  // Two publication modes share one atomic batch:
  //  - targeted refresh (expected non-empty): compare-and-set on the forest
  //    generation; every month/type is published together or not at all.
  //  - ordinary collection (expected empty): never conflicts with another job.
  //    Each snapshot is written only when it is not older than the stored one
  //    (a complete scope may still replace a partial one), so a slow ordinary
  //    job can never overwrite a newer targeted refresh. Skipped keys are reported.
  async publish({ forests = [], snapshots = [], expected = {}, sources = [], knownRegion = null, invalidatePrices = [], personal = [], publicationId = crypto.randomUUID() }) {
    const token = publicationId, entries = Object.entries(expected), cas = entries.length > 0;
    // A zero-row CAS is not a transaction error. EVERY write below is gated on
    // this transaction-local token, which exists only if ALL generations match.
    const guard = 'EXISTS (SELECT 1 FROM shared_publications WHERE id=?)';
    const batch = [this.statement("INSERT INTO shared_publications(id) SELECT ? WHERE NOT EXISTS (SELECT 1 FROM json_each(?) e WHERE COALESCE((SELECT version FROM shared_versions WHERE scope_key='forest:' || e.key),0) != e.value)", token, canonical(expected))];
    // Version rows are bumped BEFORE the data they describe, under the same condition.
    const bump = (key, condition = '', ...args) => this.statement(`INSERT INTO shared_versions SELECT ?,1 WHERE ${guard}${condition ? ' AND ' + condition : ''} ON CONFLICT(scope_key) DO UPDATE SET version=version+1`, key, token, ...args);
    // Forest records invalidate the lists of their region only, and only when they change.
    const changed = 'NOT EXISTS (SELECT 1 FROM shared_forests f WHERE f.id=? AND f.region_id=? AND f.data=?)';
    for (const forest of forests) {
      const data = canonical(safeForest(forest));
      batch.push(bump(`forests:${forest.regionId}`, changed, forest.id, forest.regionId, data));
      batch.push(this.statement(`INSERT INTO shared_forests SELECT ?,?,? WHERE ${guard} AND ${changed} ON CONFLICT(id) DO UPDATE SET region_id=excluded.region_id,data=excluded.data`, forest.id, forest.regionId, data, token, forest.id, forest.regionId, data));
    }
    if (knownRegion !== null) {
      const unknown = 'NOT EXISTS (SELECT 1 FROM shared_regions WHERE id=?)';
      batch.push(bump(`forests:${knownRegion}`, unknown, knownRegion));
      batch.push(this.statement(`INSERT INTO shared_regions SELECT ? WHERE ${guard} AND ${unknown} ON CONFLICT(id) DO NOTHING`, knownRegion, token, knownRegion));
    }
    const ranges = new Map(), snapshotRows = [];
    for (const snapshot of snapshots) {
      const key = snapshotKey(snapshot), range = rangeKey(snapshot);
      // Ordinary writes lose to a newer stored observation unless they complete a partial scope.
      const allow = cas ? '' : "NOT EXISTS (SELECT 1 FROM shared_snapshots s WHERE s.scope_key=? AND json_extract(s.data,'$.observedAt') > ? AND NOT (?='complete' AND json_extract(s.data,'$.status')='partial'))";
      const allowArgs = cas ? [] : [key, snapshot.observedAt || '', snapshot.status];
      batch.push(bump(key, allow, ...allowArgs)); batch.push(bump(range, allow, ...allowArgs));
      snapshotRows.push({ key, index: batch.length });
      batch.push(this.statement(`INSERT INTO shared_snapshots SELECT ?,?,?,?,?,?,COALESCE((SELECT version FROM shared_versions WHERE scope_key=?),0),? WHERE ${guard}${allow ? ' AND ' + allow : ''} ON CONFLICT(scope_key) DO UPDATE SET region_id=excluded.region_id,data=excluded.data,generation=excluded.generation,publication_id=excluded.publication_id`,
        key, snapshot.forestId, snapshot.regionId, snapshot.month, snapshot.type, canonical(safeSnapshot(snapshot)), key, token, token, ...allowArgs));
      ranges.set(range, { snapshot, allow, allowArgs });
    }
    for (const id of invalidatePrices) {
      batch.push(bump(`price:${id}`));
      batch.push(this.statement(`DELETE FROM shared_cache WHERE forest_id=? AND kind IN ('price','source') AND ${guard}`, id, token));
    }
    for (const [id] of entries) batch.push(bump(forestKey(id)));
    // Materialize query-independent snapshot bundles on publication. D1 still
    // reads/parses these JSON values; no cross-request isolate memory is assumed.
    // After the upsert the stored row is the new one, so the same condition now
    // reads "this write was not skipped".
    for (const [key, { snapshot: s, allow, allowArgs }] of ranges) {
      const condition = guard + (allow ? ' AND ' + allow : '');
      batch.push(this.statement(`DELETE FROM shared_scope_bundles WHERE scope_key=? AND ${condition}`, key, token, ...allowArgs));
      // Small snapshots share bounded pages; a large snapshot keeps its own row.
      // A region can grow without turning the bundle into a giant D1 value.
      batch.push(this.statement(`WITH sized AS (SELECT *,length(CAST(data AS BLOB))+200 AS bytes FROM shared_snapshots WHERE month=? AND region_id=? AND type=?),
        chunks AS (SELECT *,CASE WHEN bytes>262144 THEN 'forest:' || forest_id ELSE 'page:' || (SUM(CASE WHEN bytes<=262144 THEN bytes ELSE 0 END) OVER (ORDER BY forest_id ROWS UNBOUNDED PRECEDING)/262144) END AS part FROM sized)
        INSERT INTO shared_scope_bundles SELECT ?,part,?,?,?,(SELECT version FROM shared_versions WHERE scope_key=?),json_group_array(json_patch(json(data),json_object('generation',generation,'publicationId',publication_id))) FROM chunks WHERE ${condition} GROUP BY part`,
        s.month, s.regionId, s.type, key, s.month, s.regionId, s.type, key, token, ...allowArgs));
    }
    for (const entry of sources) batch.push(this.cacheStatement(entry, token));
    for (const [key, value] of personal) batch.push(this.statement(`INSERT INTO kv SELECT ?,? WHERE ${guard} ON CONFLICT(key) DO UPDATE SET value=excluded.value`, key, canonical(value), token));
    batch.push(this.statement('DELETE FROM shared_publications WHERE id=?', token));
    const results = await this.db.batch(batch);
    const accepted = results[0].meta.changes === 1;
    return { accepted, publicationId: token, generations: Object.fromEntries(entries.map(([id, v]) => [id, v + 1])),
      skipped: accepted ? snapshotRows.filter(r => results[r.index].meta.changes === 0).map(r => r.key) : [] };
  }
  async priceVersion(id) { return (await this.statement('SELECT version FROM shared_versions WHERE scope_key=?', `price:${id}`).first())?.version || 0; }
  // Cache validity: lists depend on the catalog, the forest records of the queried
  // regions and the month/type ranges; a detail depends on the catalog, its own
  // region's forest records and its own month/type snapshots. `accept` lets the
  // caller reject a hit that does not cover data it must merge from elsewhere.
  async read(query, forestId, { bypass = false, accept = null } = {}) {
    const months = [query.month, ...(query.nights > 1 ? [nextMonth(query.month)] : [])], types = query.type === 'all' ? ['stay', 'camp'] : [query.type];
    const key = await cacheKey({ schema: 1, query, forestId: forestId || null });
    const filter = "month IN (SELECT value FROM json_each(?)) AND type IN (SELECT value FROM json_each(?)) AND (?='all' OR region_id=?)";
    const args = [canonical(months), canonical(types), query.region, query.region], id = forestId || null;
    const metadata = () => [this.statement('SELECT data FROM shared_catalog WHERE id=1'), this.statement('SELECT id FROM shared_regions'),
      this.statement("SELECT scope_key,version FROM shared_versions WHERE scope_key='catalog'"
        + " OR (? IS NOT NULL AND scope_key IN (SELECT 'snapshot:' || month || ':' || forest_id || ':' || type FROM shared_snapshots WHERE " + filter + " AND forest_id=?))"
        + " OR (? IS NULL AND scope_key IN (SELECT scope_key FROM shared_scope_bundles WHERE " + filter + "))"
        + " OR scope_key IN (SELECT 'forests:' || region_id FROM shared_forests WHERE (?='all' OR region_id=?) AND (? IS NULL OR id=?))"
        + " OR (? IS NULL AND scope_key IN (SELECT 'forests:' || id FROM shared_regions WHERE ?='all' OR id=?))"
        + " OR scope_key IN (SELECT 'price:' || id FROM shared_forests WHERE (?='all' OR region_id=?) AND (? IS NULL OR id=?)) ORDER BY scope_key",
        id, ...args, id, id, ...args, query.region, query.region, id, id, id, query.region, query.region, query.region, query.region, id, id)];
    const signature = rows => canonical(rows.filter(r => r.scope_key === 'catalog' || r.scope_key.startsWith('forests:') || r.scope_key.startsWith(forestId ? 'snapshot:' : 'range:')));
    const first = await this.db.batch([...metadata(), this.statement("SELECT * FROM shared_cache WHERE kind='search' AND cache_key=? AND expires_at>?", key, Date.now())]);
    const dependencies = signature(first[2].results), hit = first[3].results[0];
    if (!bypass && hit?.dependencies === dependencies) {
      const payload = JSON.parse(hit.data);
      if (!accept || accept(payload)) return { payload, cacheHit: true, createdAt: hit.created_at, versions: first[2].results };
    }
    // Read metadata and every month/type bundle in ONE batch snapshot, including
    // a targeted multi-month commit which may have happened since the cache read.
    const read = await this.db.batch([...metadata(),
      this.statement(`SELECT data FROM shared_forests WHERE (?='all' OR region_id=?) AND (? IS NULL OR id=?) ORDER BY id`, query.region, query.region, forestId || null, forestId || null),
      this.statement(`SELECT data FROM shared_scope_bundles WHERE ${filter} ORDER BY scope_key,part`, ...args)]);
    return { key, dependencies: signature(read[2].results), versions: read[2].results, catalog: read[0].results[0] ? JSON.parse(read[0].results[0].data) : null,
      knownRegions: read[1].results.map(r => r.id), forests: read[3].results.map(r => JSON.parse(r.data)),
      snapshots: read[4].results.flatMap(r => JSON.parse(r.data)).filter(s => !forestId || s.forestId === forestId), cacheHit: false, createdAt: Date.now() };
  }
}
