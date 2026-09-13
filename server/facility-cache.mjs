import { FacilitySource } from './facility-source.mjs';

export const facilitySchema = [
  'CREATE TABLE IF NOT EXISTS facility_cache (cache_key TEXT PRIMARY KEY, forest_id TEXT NOT NULL, unit_id TEXT NOT NULL, type TEXT NOT NULL, data TEXT, checked_at INTEGER, refresh_after INTEGER, retain_until INTEGER, lease_owner TEXT, lease_until INTEGER NOT NULL DEFAULT 0, retry_after INTEGER NOT NULL DEFAULT 0, error TEXT)',
  'CREATE INDEX IF NOT EXISTS facility_cache_expiry ON facility_cache(retain_until)',
  'CREATE TABLE IF NOT EXISTS facility_assets (id TEXT PRIMARY KEY, content_type TEXT NOT NULL, byte_length INTEGER NOT NULL, hold_until INTEGER NOT NULL, deleting INTEGER NOT NULL DEFAULT 0)',
  'CREATE TABLE IF NOT EXISTS facility_asset_sources (source_url TEXT PRIMARY KEY, asset_id TEXT NOT NULL, etag TEXT, last_modified TEXT)',
  'CREATE INDEX IF NOT EXISTS facility_asset_sources_asset ON facility_asset_sources(asset_id)',
  'CREATE TABLE IF NOT EXISTS facility_asset_refs (cache_key TEXT NOT NULL, asset_id TEXT NOT NULL, PRIMARY KEY(cache_key,asset_id))',
  'CREATE INDEX IF NOT EXISTS facility_asset_refs_asset ON facility_asset_refs(asset_id,cache_key)',
];

const MAX_IMAGES = 32, MAX_IMAGE_BYTES = 8 * 1024 * 1024, MAX_TOTAL_BYTES = 24 * 1024 * 1024;
const DEFAULT_TIMEOUT = 20000, RETRY_MS = 5 * 60 * 1000;
const iso = value => value == null ? null : new Date(value).toISOString();
const coded = (code, message) => Object.assign(new Error(message), { code });
const text = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const checkActive = signal => { if (signal.aborted) throw coded('FACILITY_TIMEOUT', 'Facility fetch timed out'); };

// Calendar months, clamped to the target month's last day (Jan 31 -> Feb 28).
// KST is used explicitly so local and Worker runtimes produce the same dates.
export function facilityAddMonths(timestamp, months) {
  const offset = 9 * 60 * 60 * 1000;
  const date = new Date(timestamp + offset), day = date.getUTCDate();
  date.setUTCDate(1); date.setUTCMonth(date.getUTCMonth() + months);
  const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, last));
  return date.getTime() - offset;
}

async function digest(bytes) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
}
function validateQuery(query) {
  const { forestId, unitId, type } = query || {};
  if (![forestId, unitId].every(value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value)) || !['stay', 'camp'].includes(type)) {
    throw coded('INVALID_FACILITY', '시설 정보를 확인할 수 없습니다.');
  }
  return { forestId, unitId, type };
}
function publicError(error) {
  const limited = error?.status === 429 || error?.statusCode === 429 || /RATE_LIMIT|TOO_MANY|SOURCE_BUSY/.test(error?.code || '');
  if (limited) return { code: 'SOURCE_RATE_LIMITED', message: '원본 사이트 요청이 많아 잠시 후 다시 확인합니다.' };
  if (error?.code === 'FACILITY_TIMEOUT') return { code: 'FACILITY_TIMEOUT', message: '시설 정보를 확인하는 데 시간이 걸리고 있습니다.' };
  return { code: 'FACILITY_REFRESH_FAILED', message: '원본 시설 정보를 확인하지 못했습니다. 잠시 후 다시 시도합니다.' };
}

export class FacilityCache {
  constructor({ db, source = new FacilitySource(), assetStore, clock = Date.now, waitUntil, sourceTimeoutMs = DEFAULT_TIMEOUT } = {}) {
    if (!db) throw new TypeError('Facility cache database required');
    this.db = db; this.source = source; this.assetStore = assetStore; this.clock = clock; this.waitUntil = waitUntil;
    this.sourceTimeoutMs = Math.max(1, Math.min(DEFAULT_TIMEOUT, sourceTimeoutMs));
    this.leaseMs = this.sourceTimeoutMs + 15000;
  }
  statement(sql, ...args) { return this.db.prepare(sql).bind(...args); }
  // Explicit local/test setup only. Production uses 0002_facility_cache.sql.
  async init() { for (const sql of facilitySchema) await this.db.exec(sql); }
  key(query) { return JSON.stringify([query.forestId, query.unitId, query.type]); }
  read(key) { return this.statement('SELECT * FROM facility_cache WHERE cache_key=?', key).first(); }

  result(row, now = this.clock()) {
    const usable = Boolean(row?.data && row.retain_until > now);
    const refreshing = Boolean(row?.lease_owner && row.lease_until > now);
    return {
      detail: usable ? JSON.parse(row.data) : null,
      checkedAt: usable ? iso(row.checked_at) : null,
      refreshAfter: usable ? iso(row.refresh_after) : null,
      retainUntil: usable ? iso(row.retain_until) : null,
      stale: usable ? row.refresh_after <= now : false,
      refreshing,
      error: !refreshing && row?.error ? JSON.parse(row.error) : null,
      retryAfter: row?.retry_after > now ? iso(row.retry_after) : refreshing && !usable ? iso(now + 1000) : null,
    };
  }

  async get(input) {
    const query = validateQuery(input), key = this.key(query);
    if (!this.assetStore) return { ...this.result(null), error: { code: 'CONFIG_REQUIRED', message: '시설 이미지 저장소 설정이 필요합니다.' } };
    let row = await this.read(key), now = this.clock();
    if (row?.data && row.retain_until <= now) {
      await this.pruneExpired(); row = await this.read(key); now = this.clock();
    }
    if (row?.data && row.refresh_after > now && row.retain_until > now) return this.result(row, now);
    if (row?.retry_after > now) return this.result(row, now);

    const owner = crypto.randomUUID();
    const acquired = await this.statement(`INSERT INTO facility_cache(cache_key,forest_id,unit_id,type,lease_owner,lease_until)
      VALUES(?,?,?,?,?,?) ON CONFLICT(cache_key) DO UPDATE SET lease_owner=excluded.lease_owner,lease_until=excluded.lease_until
      WHERE facility_cache.lease_until<=? AND facility_cache.retry_after<=?
      AND (facility_cache.data IS NULL OR facility_cache.refresh_after<=? OR facility_cache.retain_until<=?)`,
      key, query.forestId, query.unitId, query.type, owner, now + this.leaseMs, now, now, now, now).run();
    row = await this.read(key);
    if (acquired.meta.changes > 0) {
      const pending = this.refresh(query, key, owner);
      if (row.data && row.retain_until > this.clock()) {
        // The promise has an attached rejection handler even without waitUntil.
        const background = pending.catch(() => {});
        if (this.waitUntil) this.waitUntil(background);
        return this.result(row);
      }
      await pending;
      return this.result(await this.read(key));
    }
    if (row?.data && row.retain_until > this.clock()) return this.result(row);
    // Another Worker owns the cold fetch. The UI can poll using retryAfter.
    return this.result(row);
  }

  async prepareSnapshot(query, key, owner, signal) {
    const raw = await this.source.detail(query);
    checkActive(signal);
    if (!raw || !text(raw.title, 300) || !Array.isArray(raw.images) || raw.images.length > MAX_IMAGES) {
      throw coded('INVALID_FACILITY_SOURCE', 'Invalid facility source');
    }
    const detail = {
      ...query, title: text(raw.title, 300), sourceUrl: text(raw.sourceUrl, 2048),
      facts: (Array.isArray(raw.facts) ? raw.facts : []).slice(0, 80).map(fact => ({ label: text(fact.label, 200), value: text(fact.value, 2000) })).filter(fact => fact.label && fact.value),
      guide: (Array.isArray(raw.guide) ? raw.guide : []).slice(0, 80).map(value => text(value, 4000)).filter(Boolean),
      images: [],
    };
    const assets = new Map(), sources = new Map();
    let totalBytes = 0;
    for (const image of raw.images) {
      checkActive(signal);
      const sourceUrl = text(image.sourceUrl, 2048);
      if (!sourceUrl || !['photo', 'map', 'floorplan'].includes(image.kind)) throw coded('INVALID_FACILITY_SOURCE', 'Invalid facility image');
      let record = sources.get(sourceUrl);
      if (!record) {
        const prior = await this.statement(`SELECT s.*,a.content_type,a.byte_length FROM facility_asset_sources s
          JOIN facility_assets a ON a.id=s.asset_id WHERE s.source_url=? AND a.deleting=0`, sourceUrl).first();
        checkActive(signal);
        const storedBytes = prior ? await this.assetStore.get(prior.asset_id) : null;
        checkActive(signal);
        // A missing object must be downloaded unconditionally; keeping its old
        // validator would produce an endless sequence of unusable 304 responses.
        const previous = storedBytes?.byteLength === prior?.byte_length ? prior : null;
        const response = await this.source.image(sourceUrl, previous ? { etag: previous.etag || undefined, lastModified: previous.last_modified || undefined } : {});
        checkActive(signal);
        if (response?.notModified) {
          if (!previous) throw coded('MISSING_FACILITY_IMAGE', 'Image returned 304 without cached bytes');
          record = { sourceUrl, id: previous.asset_id, etag: previous.etag, lastModified: previous.last_modified, byteLength: previous.byte_length };
          if (!assets.has(record.id)) assets.set(record.id, { id: record.id, bytes: storedBytes, contentType: previous.content_type, byteLength: previous.byte_length });
        } else {
          const bytes = response?.bytes, contentType = String(response?.contentType || '').split(';')[0].trim().toLowerCase();
          if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > MAX_IMAGE_BYTES || !/^image\/(png|jpeg|webp|gif|avif)$/.test(contentType)) {
            throw coded('INVALID_FACILITY_IMAGE', 'Unsupported or oversized facility image');
          }
          const id = await digest(bytes);
          checkActive(signal);
          record = { sourceUrl, id, etag: text(response.etag, 512) || null, lastModified: text(response.lastModified, 128) || null, byteLength: bytes.length };
          assets.set(id, { id, bytes, contentType, byteLength: bytes.length });
        }
        totalBytes += record.byteLength;
        if (totalBytes > MAX_TOTAL_BYTES) throw coded('FACILITY_TOO_LARGE', 'Facility images exceed storage limit');
        sources.set(sourceUrl, record);
      }
      detail.images.push({ kind: image.kind, label: text(image.label, 200), sourceUrl, url: `/api/facility-assets/${record.id}` });
    }
    if (new TextEncoder().encode(JSON.stringify(detail)).byteLength > 256 * 1024) throw coded('FACILITY_TOO_LARGE', 'Facility text exceeds storage limit');
    for (const asset of assets.values()) {
      checkActive(signal); await this.storeAsset(asset, key, owner, signal); checkActive(signal);
    }
    return { detail, assets, sources };
  }

  async storeAsset({ id, bytes, byteLength, contentType }, key, owner, signal) {
    checkActive(signal);
    const now = this.clock();
    // A short staging hold protects newly written objects from cleanup before
    // their complete snapshot publishes. Failed writes become reclaimable later.
    const held = await this.statement(`INSERT INTO facility_assets SELECT ?,?,?,?,0 WHERE EXISTS
      (SELECT 1 FROM facility_cache WHERE cache_key=? AND lease_owner=? AND lease_until>?)
      ON CONFLICT(id) DO UPDATE SET hold_until=MAX(facility_assets.hold_until,excluded.hold_until) WHERE facility_assets.deleting=0`,
      id, contentType, byteLength, now + this.leaseMs * 2, key, owner, now).run();
    checkActive(signal);
    if (!held.meta.changes) throw coded('FACILITY_LEASE_LOST', 'Facility image lease lost');
    const existing = await this.assetStore.get(id);
    checkActive(signal);
    if (existing?.byteLength === byteLength) return;
    if (!bytes) throw coded('MISSING_FACILITY_IMAGE', 'Image returned 304 without stored bytes');
    await this.assetStore.put(id, bytes, contentType);
    checkActive(signal);
  }

  async refresh(query, key, owner) {
    let timer; const controller = new AbortController();
    try {
      // The source may ignore cancellation. A timed-out result cannot publish
      // later. Any staged objects stay unreferenced and are cleaned up separately.
      const snapshot = await Promise.race([
        this.prepareSnapshot(query, key, owner, controller.signal),
        new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(coded('FACILITY_TIMEOUT', 'Facility fetch timed out')); }, this.sourceTimeoutMs); }),
      ]);
      clearTimeout(timer);
      await this.publish(key, owner, snapshot);
      await this.pruneExpired().catch(() => {});
    } catch (error) {
      clearTimeout(timer);
      const failure = publicError(error), now = this.clock();
      const cooldown = failure.code === 'SOURCE_RATE_LIMITED' ? 60 * 60 * 1000 : RETRY_MS;
      await this.statement(`UPDATE facility_cache SET error=?,retry_after=?,lease_owner=NULL,lease_until=0
        WHERE cache_key=? AND lease_owner=? AND lease_until>?`, JSON.stringify(failure), now + cooldown, key, owner, now).run();
    } finally {
      controller.abort();
      await this.statement('UPDATE facility_cache SET lease_owner=NULL,lease_until=0 WHERE cache_key=? AND lease_owner=?', key, owner).run();
    }
  }

  async publish(key, owner, { detail, sources }) {
    const now = this.clock();
    const guard = 'EXISTS (SELECT 1 FROM facility_cache WHERE cache_key=? AND lease_owner=? AND lease_until>?)';
    const bound = () => [key, owner, now];
    const batch = [];
    for (const source of sources.values()) {
      batch.push(this.statement(`INSERT INTO facility_asset_sources SELECT ?,?,?,? WHERE ${guard}
        ON CONFLICT(source_url) DO UPDATE SET asset_id=excluded.asset_id,etag=excluded.etag,last_modified=excluded.last_modified`, source.sourceUrl, source.id, source.etag, source.lastModified, ...bound()));
    }
    batch.push(this.statement(`DELETE FROM facility_asset_refs WHERE cache_key=? AND ${guard}`, key, ...bound()));
    for (const id of new Set([...sources.values()].map(source => source.id))) {
      batch.push(this.statement(`INSERT INTO facility_asset_refs SELECT ?,? WHERE ${guard}`, key, id, ...bound()));
    }
    // All image bytes and references are ready before replacing the visible snapshot.
    // db.batch is transactional in SQLite and D1; failed writes retain the old snapshot.
    batch.push(this.statement(`UPDATE facility_cache SET data=?,checked_at=?,refresh_after=?,retain_until=?,retry_after=0,error=NULL
      WHERE cache_key=? AND lease_owner=? AND lease_until>?`, JSON.stringify(detail), now, facilityAddMonths(now, 1), facilityAddMonths(now, 6), key, owner, now));
    await this.db.batch(batch);
  }

  async asset(id) {
    if (!this.assetStore || typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) return null;
    const read = () => this.statement(`SELECT a.content_type,a.byte_length FROM facility_assets a WHERE a.id=? AND a.deleting=0 AND EXISTS
      (SELECT 1 FROM facility_asset_refs r JOIN facility_cache f ON f.cache_key=r.cache_key
      WHERE r.asset_id=a.id AND f.data IS NOT NULL AND f.retain_until>?)`, id, this.clock()).first();
    const row = await read(); if (!row) return null;
    const bytes = await this.assetStore.get(id);
    // Recheck after the object read: expiry or snapshot replacement may have
    // happened while the filesystem/R2 read was in flight.
    if (!(bytes instanceof Uint8Array) || bytes.byteLength !== row.byte_length || !await read()) return null;
    return { bytes, contentType: row.content_type, etag: `"${id}"` };
  }

  // Lazy expiry on access; hosts may also call this from a scheduled cleanup.
  // Retention checks on get/asset apply even before physical cleanup runs.
  async pruneExpired() {
    const now = this.clock();
    await this.db.batch([
      this.statement('DELETE FROM facility_asset_refs WHERE cache_key IN (SELECT cache_key FROM facility_cache WHERE retain_until<=?)', now),
      this.statement('UPDATE facility_cache SET data=NULL,checked_at=NULL,refresh_after=NULL,retain_until=NULL WHERE retain_until<=?', now),
    ]);
    if (!this.assetStore) return;
    const candidates = (await this.statement(`SELECT id FROM facility_assets WHERE hold_until<=?
      AND NOT EXISTS (SELECT 1 FROM facility_asset_refs r WHERE r.asset_id=facility_assets.id) LIMIT 32`, now).all()).results;
    for (const { id } of candidates) {
      // A deletion claim can be retried after a crashed cleanup invocation.
      const claim = await this.statement(`UPDATE facility_assets SET deleting=1,hold_until=? WHERE id=? AND hold_until<=?
        AND NOT EXISTS (SELECT 1 FROM facility_asset_refs r WHERE r.asset_id=facility_assets.id)`, now + 60000, id, now).run();
      if (!claim.meta.changes) continue;
      try {
        await this.assetStore.delete(id);
        await this.db.batch([
          this.statement('DELETE FROM facility_asset_sources WHERE asset_id=? AND EXISTS (SELECT 1 FROM facility_assets WHERE id=? AND deleting=1)', id, id),
          this.statement('DELETE FROM facility_assets WHERE id=? AND deleting=1', id),
        ]);
      } catch {
        await this.statement('UPDATE facility_assets SET deleting=0 WHERE id=?', id).run();
      }
    }
  }
}
