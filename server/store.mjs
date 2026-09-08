const encode = new TextEncoder(), decode = new TextDecoder();
const bytesToBase64 = bytes => btoa(String.fromCharCode(...bytes));
const base64ToBytes = value => Uint8Array.from(atob(value), c => c.charCodeAt(0));
export class Store {
  constructor(db, secret, namespace = '') { if (!/^[a-zA-Z0-9-]*$/.test(namespace)) throw new Error('Invalid storage namespace'); this.db = db; this.secret = secret; this.namespace = namespace; }
  key(key) { return this.namespace ? `${this.namespace}:${key}` : key; }
  async init() {
    await this.db.exec('CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);');
    await this.db.exec('CREATE TABLE IF NOT EXISTS leases (key TEXT PRIMARY KEY, owner TEXT NOT NULL, expires INTEGER NOT NULL);');
  }
  async get(key) { const row = await this.db.prepare('SELECT value FROM kv WHERE key = ?').bind(this.key(key)).first(); return row ? JSON.parse(row.value) : null; }
  async set(key, value) { await this.db.prepare('INSERT INTO kv(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').bind(this.key(key), JSON.stringify(value)).run(); }
  async remove(key) { await this.db.prepare('DELETE FROM kv WHERE key=?').bind(this.key(key)).run(); }
  async list(prefix) { const rows = await this.db.prepare('SELECT value FROM kv WHERE key LIKE ? ORDER BY key').bind(`${this.key(prefix)}%`).all(); return rows.results.map(r => JSON.parse(r.value)); }
  async lock(key, owner) {
    const result = await this.db.prepare('INSERT INTO leases(key,owner,expires) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET owner=excluded.owner, expires=excluded.expires WHERE leases.expires < ?').bind(this.key(key), owner, Date.now() + 180000, Date.now()).run();
    return result.meta.changes > 0;
  }
  async unlock(key, owner) { await this.db.prepare('DELETE FROM leases WHERE key=? AND owner=?').bind(this.key(key), owner).run(); }
  async cryptoKey() {
    if (!this.secret || this.secret.length < 32) throw new Error('Session encryption key missing');
    return crypto.subtle.importKey('raw', await crypto.subtle.digest('SHA-256', encode.encode(this.namespace ? `${this.secret}:${this.namespace}` : this.secret)), 'AES-GCM', false, ['encrypt', 'decrypt']);
  }
  async sealSecret(value) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await this.cryptoKey(), encode.encode(JSON.stringify(value)));
    return { iv: bytesToBase64(iv), ciphertext: bytesToBase64(new Uint8Array(ciphertext)) };
  }
  async setSecret(key, value) { await this.set(key, await this.sealSecret(value)); }
  async getSecret(key) {
    const record = await this.get(key); if (!record) return null;
    try { return JSON.parse(decode.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: base64ToBytes(record.iv) }, await this.cryptoKey(), base64ToBytes(record.ciphertext)))); }
    catch { await this.remove(key); return null; }
  }
}
