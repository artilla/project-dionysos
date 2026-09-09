import { createServer } from 'node:http';
import { mkdirSync, existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './store.mjs';
import { sqlite } from './sqlite.mjs';
import { createApp } from './app.mjs';
import { SharedStore } from './shared.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const local = resolve(root, '.local'); mkdirSync(local, { recursive: true, mode: 0o700 });
const secretPath = resolve(local, 'session.key');
if (!existsSync(secretPath)) writeFileSync(secretPath, crypto.randomUUID() + crypto.randomUUID(), { mode: 0o600 });
const db = sqlite(resolve(local, 'forest-gap.sqlite'));
const store = new Store(db, readFileSync(secretPath, 'utf8')); await store.init();
await new SharedStore(db).init();
chmodSync(resolve(local, 'forest-gap.sqlite'), 0o600);
const api = createApp({ store, env: process.env });
const port = Number(process.env.PORT || 5178);
const staticRoot = resolve(root, process.env.SERVE_BUILD === '1' ? 'dist/client' : 'web');
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };
const server = createServer(async (req, res) => {
  const expectedHost = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  if (!expectedHost.has(req.headers.host)) { res.writeHead(403); res.end('Forbidden host'); return; }
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname.startsWith('/api/')) {
      const chunks = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > 8192) { res.writeHead(413); res.end(); return; } chunks.push(chunk); }
      const request = new Request(url, { method: req.method, headers: req.headers, ...(req.method !== 'GET' && req.method !== 'HEAD' ? { body: Buffer.concat(chunks) } : {}) });
      const result = await api(request); res.writeHead(result.status, Object.fromEntries(result.headers)); res.end(Buffer.from(await result.arrayBuffer())); return;
    }
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405); res.end(); return; }
    const path = decodeURIComponent(url.pathname);
    // Serve only the app directory and these two reviewed documents.
    const doc = ['/docs/architecture.html', '/docs/implementation-plan.html'].includes(path);
    const target = doc ? resolve(root, `.${path}`) : resolve(staticRoot, `.${path === '/' ? '/index.html' : path}`);
    if ((!doc && !target.startsWith(staticRoot + '/')) || path.split('/').some(segment => segment.startsWith('.'))) { res.writeHead(404); res.end('Not found'); return; }
    const body = await readFile(target);
    res.writeHead(200, { 'Content-Type': mime[extname(target)] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'" });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('요청한 파일을 찾을 수 없습니다.'); }
});
server.listen(port, '127.0.0.1', () => console.log(`숲틈 실데이터 서비스 · http://127.0.0.1:${port}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => { db.close(); process.exit(0); }));
