import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalFacilityAssets } from '../server/facility-assets-local.mjs';
import { R2FacilityAssets } from '../server/facility-assets.mjs';

test('local image bytes survive adapter recreation and reject paths outside the cache', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'forest-facility-assets-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const id = 'a'.repeat(64), bytes = new Uint8Array([0, 255, 12, 128]);
  const assets = new LocalFacilityAssets(directory);
  assert.equal(await assets.get(id), null);
  await Promise.all([assets.put(id, bytes), assets.put(id, bytes)]);
  const recreated = new LocalFacilityAssets(directory);
  assert.deepEqual(await recreated.get(id), bytes);
  for (const bad of ['../session.key', '/tmp/file', 'a'.repeat(63), 'z'.repeat(64)]) {
    await assert.rejects(assets.get(bad), /Invalid facility asset ID/);
    await assert.rejects(assets.put(bad, bytes), /Invalid facility asset ID/);
  }
  await recreated.delete(id); assert.equal(await assets.get(id), null);
});

test('hosted images use the configured bucket and retain binary content and type', async () => {
  const objects = new Map(), types = new Map();
  const bucket = {
    async put(key, bytes, options) { objects.set(key, bytes.slice()); types.set(key, options.httpMetadata.contentType); },
    async get(key) { const bytes = objects.get(key); return bytes ? { arrayBuffer: async () => bytes.buffer } : null; },
    async delete(key) { objects.delete(key); }
  };
  const id = 'b'.repeat(64), bytes = new Uint8Array([255, 216, 255, 0]);
  await new R2FacilityAssets(bucket).put(id, bytes, 'image/jpeg');
  assert.equal(types.get(`facility-images/${id}`), 'image/jpeg');
  assert.deepEqual(await new R2FacilityAssets(bucket).get(id), bytes);
  await new R2FacilityAssets(bucket).delete(id);
  assert.equal(await new R2FacilityAssets(bucket).get(id), null);
  await assert.rejects(new R2FacilityAssets().get(id), error => error.code === 'CONFIG_REQUIRED');
});
