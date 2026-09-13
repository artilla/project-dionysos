import { SourceError } from './foresttrip.mjs';

export const validAssetId = id => typeof id === 'string' && /^[a-f0-9]{64}$/.test(id);

// Bytes live in object storage; SQLite/D1 holds only their metadata and references.
export class R2FacilityAssets {
  constructor(bucket) { this.bucket = bucket; }
  key(id) {
    if (!validAssetId(id)) throw new TypeError('Invalid facility asset ID');
    if (!this.bucket) throw new SourceError('CONFIG_REQUIRED', '시설 이미지 저장소 설정이 필요합니다.', 503);
    return `facility-images/${id}`;
  }
  async put(id, bytes, contentType) {
    const key = this.key(id);
    await this.bucket.put(key, bytes, { httpMetadata: { contentType } });
  }
  async get(id) {
    const key = this.key(id);
    const object = await this.bucket.get(key);
    return object ? new Uint8Array(await object.arrayBuffer()) : null;
  }
  async delete(id) { const key = this.key(id); await this.bucket.delete(key); }
}
