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

  const produced = await produce();

  // Only cache successful responses. A cached 5xx would pin an outage in place.
  if (produced.status !== 200) return produced;

  // The directive goes on the RESPONSE THE CALLER GETS as well as the stored
  // copy. Setting it only on the stored copy tells Cloudflare how long to hold
  // the entry but leaves the caller with no cache guidance at all, so an agent
  // polling this route has no way to know it may reuse the answer.
  const directive = `public, max-age=${ttlSeconds}, stale-while-revalidate=${ttlSeconds * 2}`;
  const headers = new Headers(produced.headers);
  headers.set('Cache-Control', directive);

  const body = await produced.arrayBuffer();
  const response = new Response(body, { status: 200, headers });

  if (ctx && typeof ctx.waitUntil === 'function') {
    ctx.waitUntil(cache.put(key, response.clone()));
  } else {
    await cache.put(key, response.clone());
  }
  return response;
}

export { cached };
