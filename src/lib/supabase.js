/**
 * Minimal PostgREST client. Deliberately not the supabase-js SDK: the Worker
 * needs three GETs, and the SDK would add bundle weight and a second way to
 * build URLs.
 */

async function restGet(baseUrl, anonKey, path, { signal } = {}) {
  const res = await fetch(`${baseUrl}/rest/v1/${path}`, {
    headers: {
      apikey: anonKey,
      Authorization: `Bearer ${anonKey}`,
      Accept: 'application/json'
    },
    signal
  });
  if (!res.ok) {
    // Upstream error bodies can carry table names, column names and vendor
    // strings. They are logged, never returned to the caller.
    const detail = await res.text().catch(() => '');
    console.error(`supabase ${path} -> ${res.status}: ${detail.slice(0, 400)}`);
    throw new UpstreamError(res.status, path);
  }
  return res.json();
}

class UpstreamError extends Error {
  constructor(status, path) {
    super(`upstream ${status}`);
    this.name = 'UpstreamError';
    this.status = status;
    this.path = path;
  }
}

export { restGet, UpstreamError };
