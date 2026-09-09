-- Shared cache tables only; existing personal kv data is retained.
CREATE TABLE IF NOT EXISTS shared_forests (id TEXT PRIMARY KEY, region_id TEXT NOT NULL, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS shared_forests_region ON shared_forests(region_id);
CREATE TABLE IF NOT EXISTS shared_snapshots (scope_key TEXT PRIMARY KEY, forest_id TEXT NOT NULL, region_id TEXT NOT NULL, month TEXT NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL, generation INTEGER NOT NULL, publication_id TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS shared_snapshots_scope ON shared_snapshots(month, region_id, type);
CREATE TABLE IF NOT EXISTS shared_versions (scope_key TEXT PRIMARY KEY, version INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS shared_catalog (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS shared_regions (id TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS shared_publications (id TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS shared_scope_bundles (scope_key TEXT NOT NULL, part TEXT NOT NULL, month TEXT NOT NULL, region_id TEXT NOT NULL, type TEXT NOT NULL, version INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(scope_key,part));
CREATE INDEX IF NOT EXISTS shared_bundles_scope ON shared_scope_bundles(month, region_id, type);
CREATE TABLE IF NOT EXISTS shared_cache (kind TEXT NOT NULL, cache_key TEXT NOT NULL, forest_id TEXT, dependencies TEXT NOT NULL, data TEXT NOT NULL, observed_at TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY(kind,cache_key));
CREATE INDEX IF NOT EXISTS shared_cache_expiry ON shared_cache(expires_at);
CREATE INDEX IF NOT EXISTS shared_cache_forest ON shared_cache(forest_id,kind);
