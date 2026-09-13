-- Public facility snapshots and image metadata. Bytes live in the asset store.
CREATE TABLE IF NOT EXISTS facility_cache (cache_key TEXT PRIMARY KEY, forest_id TEXT NOT NULL, unit_id TEXT NOT NULL, type TEXT NOT NULL, data TEXT, checked_at INTEGER, refresh_after INTEGER, retain_until INTEGER, lease_owner TEXT, lease_until INTEGER NOT NULL DEFAULT 0, retry_after INTEGER NOT NULL DEFAULT 0, error TEXT);
CREATE INDEX IF NOT EXISTS facility_cache_expiry ON facility_cache(retain_until);
CREATE TABLE IF NOT EXISTS facility_assets (id TEXT PRIMARY KEY, content_type TEXT NOT NULL, byte_length INTEGER NOT NULL, hold_until INTEGER NOT NULL, deleting INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS facility_asset_sources (source_url TEXT PRIMARY KEY, asset_id TEXT NOT NULL, etag TEXT, last_modified TEXT);
CREATE INDEX IF NOT EXISTS facility_asset_sources_asset ON facility_asset_sources(asset_id);
CREATE TABLE IF NOT EXISTS facility_asset_refs (cache_key TEXT NOT NULL, asset_id TEXT NOT NULL, PRIMARY KEY(cache_key,asset_id));
CREATE INDEX IF NOT EXISTS facility_asset_refs_asset ON facility_asset_refs(asset_id,cache_key);
