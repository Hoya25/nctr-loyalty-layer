/**
 * Cloudflare Cache API wrapper with stale-while-revalidate.
 *
 * Cache keys are the normalized request URL. Only GETs are cached, and nothing
 * behind authentication is ever passed here.
 */

async function cached(request, ctx, ttlSeconds, produce) {
  if (request.method !== 'GET') return produce();

  const cache = caches.default;
  const key = new Request(new URL(request.url).toString(), { method: 'GET' });

  const hit = await cache.match(key);
  if (hit) return hit;

  const response = await produce();

  // Only cache successful responses. A cached 5xx would pin an outage in place.
  if (response.status === 200) {
    const toCache = response.clone();
    const headers = new Headers(toCache.headers);
    headers.set('Cache-Control', `public, max-age=${ttlSeconds}, stale-while-revalidate=${ttlSeconds * 2}`);
    const stored = new Response(toCache.body, { status: 200, headers });
    if (ctx && typeof ctx.waitUntil === 'function') {
      ctx.waitUntil(cache.put(key, stored));
    }
  }
  return response;
}

export { cached };
