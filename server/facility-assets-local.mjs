import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { validAssetId } from './facility-assets.mjs';

export class LocalFacilityAssets {
  constructor(directory) { this.directory = resolve(directory); }
  path(id) {
    if (!validAssetId(id)) throw new TypeError('Invalid facility asset ID');
    return resolve(this.directory, id);
  }
  async put(id, bytes) {
    const target = this.path(id);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = `${target}.${crypto.randomUUID()}.tmp`;
    try {
      await writeFile(temporary, bytes, { mode: 0o600, flag: 'wx' });
      await rename(temporary, target);
    } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }
  async get(id) {
    try { return new Uint8Array(await readFile(this.path(id))); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  async delete(id) {
    try { await unlink(this.path(id)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
