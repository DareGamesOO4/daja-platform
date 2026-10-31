// Shared implementation: keep dajashopweb/src/edge/apiProxy.js identical.
const ORIGIN = 'https://daja-platform-api.onrender.com';
const WEB_ORIGIN = 'https://dajashop.rs';

function failure(status, code, message) {
  return Response.json({ error: { code, message, details: {} } }, {
    status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }
  });
}

export async function proxyApi(request, env, browser = false) {
  const url = new URL(request.url);
  if (!/^\/(?:api\/v1(?:\/|$)|socket\.io(?:\/|$)|health\/(?:live|ready)$)/.test(url.pathname)) return failure(404, 'NOT_FOUND', 'Not found');
  if (url.href.length > 8192) return failure(414, 'URI_TOO_LONG', 'Request URI too long');
  if (typeof env.EDGE_SHARED_SECRET !== 'string' || env.EDGE_SHARED_SECRET.length < 32) return failure(503, 'EDGE_UNAVAILABLE', 'Service temporarily unavailable');
  const upgrade = request.headers.get('Upgrade')?.toLowerCase() === 'websocket';
  const safe = ['GET', 'HEAD', 'OPTIONS'].includes(request.method);
  if (browser && !safe && request.headers.get('Origin') !== WEB_ORIGIN) return failure(403, 'CSRF_REQUIRED', 'Invalid browser request');
  if (browser && upgrade && request.headers.get('Origin') !== WEB_ORIGIN) return failure(403, 'ORIGIN_DENIED', 'Invalid browser origin');
  const headers = new Headers(request.headers);
  for (const name of [...headers.keys()]) {
    const lower = name.toLowerCase();
    if (lower.startsWith('x-daja-edge') || lower.startsWith('x-forwarded-')
      || ['host', 'forwarded', 'x-real-ip', 'x-daja-client', 'x-daja-client-ip'].includes(lower)) headers.delete(name);
  }
  headers.set('X-Daja-Edge-Key', env.EDGE_SHARED_SECRET);
  headers.set('X-Daja-Client', browser ? 'browser' : 'native');
  const clientIp = request.headers.get('CF-Connecting-IP');
  if (clientIp) headers.set('X-Daja-Client-IP', clientIp);
  if (browser) {
    headers.delete('Authorization');
    const cookies = (headers.get('Cookie') || '').split(';').map(part => part.trim())
      .filter(part => /^__Host-daja_(?:customer|refresh|staff|csrf|oauth)=/.test(part));
    if (cookies.length) headers.set('Cookie', cookies.join('; ')); else headers.delete('Cookie');
  } else {
    headers.delete('Cookie');
    headers.delete('X-Daja-Session-Kind');
    headers.delete('X-Daja-CSRF');
  }
  // Origin and path are fixed. User input can never turn this into an open proxy.
  const target = new URL(ORIGIN);
  target.pathname = url.pathname;
  target.search = url.search;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120_000);
  try {
    const upstream = await fetch(target, {
      method: request.method, headers,
      body: safe ? undefined : request.body,
      redirect: 'manual', signal: controller.signal,
      ...(!upgrade ? { cache: 'no-store' } : {})
    });
    // Returning the upstream 101 preserves its WebSocket object and streaming.
    if (upstream.status === 101) return upstream;
    const result = new Response(upstream.body, upstream);
    result.headers.set('Cache-Control', 'no-store');
    result.headers.set('X-Daja-Gateway', 'v1');
    result.headers.delete('X-Daja-Edge-Key');
    if (!browser) result.headers.delete('Set-Cookie');
    return result;
  } catch {
    return failure(503, 'UPSTREAM_UNAVAILABLE', 'Service temporarily unavailable');
  } finally { clearTimeout(timer); }
}

export default { fetch: (request, env) => proxyApi(request, env, false) };
