import { Store } from './store.mjs';
import { createApp } from './app.mjs';
import { visitorSession } from './visitor.mjs';

export function createWorker(appFactory = createApp) {
  return {
    async fetch(request, env) {
      const url = new URL(request.url);
      if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
      const failure = (code, message, status) => Response.json({ error: { code, message } }, { status, headers: { 'Cache-Control': 'private, no-store' } });
      if (!env.DB || !env.SESSION_SECRET || env.SESSION_SECRET.length < 32) return failure('CONFIG_REQUIRED', '서버 저장소와 연결 설정이 필요합니다.', 503);
      if (request.headers.get('sec-fetch-site') === 'cross-site' || (request.headers.get('origin') && request.headers.get('origin') !== url.origin)) return failure('FORBIDDEN', '같은 페이지에서 다시 시도해주세요.', 403);
      const session = await visitorSession(request, env.SESSION_SECRET, url.pathname === '/api/session' && request.method === 'GET');
      if (!session) return failure('VISITOR_REQUIRED', '브라우저 연결이 만료됐어요. 페이지를 새로고침한 후 다시 연결해주세요.', 401);
      const store = new Store(env.DB, env.SESSION_SECRET, session.id); await store.init();
      const result = await appFactory({ store, storageLocation: 'hosted' })(request);
      const headers = new Headers(result.headers); headers.set('Cache-Control', 'private, no-store');
      if (session.cookie) headers.append('Set-Cookie', session.cookie);
      return new Response(result.body, { status: result.status, headers });
    }
  };
}
export default createWorker();
