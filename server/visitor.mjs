const cookieName = '__Host-forest-gap-visitor';
const lifetime = 30 * 24 * 60 * 60;
const encode = new TextEncoder();
const hex = bytes => Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');

export async function visitorSession(request, secret, create = false, now = Date.now()) {
  const key = await crypto.subtle.importKey('raw', encode.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
  const token = request.headers.get('cookie')?.split(';').map(s => s.trim()).find(s => s.startsWith(cookieName + '='))?.slice(cookieName.length + 1);
  const match = token?.match(/^([a-f0-9]{64})\.(\d{10})\.([a-f0-9]{64})$/);
  if (match && Number(match[2]) > Math.floor(now / 1000)) {
    const signature = Uint8Array.from(match[3].match(/../g), value => parseInt(value, 16));
    if (await crypto.subtle.verify('HMAC', key, signature, encode.encode(`forest-gap:${match[1]}.${match[2]}`))) return { id: match[1] };
  }
  if (!create) return null;
  const id = hex(crypto.getRandomValues(new Uint8Array(32))), expires = Math.floor(now / 1000) + lifetime;
  const signature = hex(await crypto.subtle.sign('HMAC', key, encode.encode(`forest-gap:${id}.${expires}`)));
  return { id, cookie: `${cookieName}=${id}.${expires}.${signature}; Path=/; Max-Age=${lifetime}; Secure; HttpOnly; SameSite=Lax` };
}
