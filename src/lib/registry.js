/**
 * EARN RATE REGISTRY client.
 *
 * ACCESS MODEL — read this before changing the transport.
 * The Registry's RLS denies anon and authenticated ALL access, by explicit
 * design: "All reads/writes via edge functions using service_role"
 * (20260514000003_earn_rate_registry_rls.sql). Querying the table directly with
 * an anon key returns HTTP 200 and an EMPTY ARRAY — not an error — which would
 * make a rate silently resolve to "unavailable" instead of failing loudly.
 * So this Worker does NOT hold a Registry key and does NOT read the table.
 *
 * It calls `get-display-rate`, which is deployed verify_jwt=false (public), uses
 * service_role internally, and already implements the canonical resolution. That
 * makes the supersedes rule single-sourced rather than reimplemented here — the
 * strongest possible version of "port it verbatim".
 *
 * resolveActive() below is retained as the documented, unit-tested statement of
 * that rule, kept in lockstep with get-active-rate/index.ts:93-97.
 */

const DISPLAY_RATE_FN = 'get-display-rate';

/**
 * The canonical resolution rule, mirrored from the Registry's own
 * get-active-rate. A row is current iff nothing supersedes it and it has not
 * expired. NOT `expires_at IS NULL`: two nctr_base_earn rows are live and
 * neither carries an expiry, so only the supersedes walk returns exactly one.
 */
function resolveActive(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const supersededIds = new Set(rows.map((r) => r.supersedes).filter(Boolean));
  const now = new Date();
  return rows.find((r) =>
    !supersededIds.has(r.id) && (!r.expires_at || new Date(r.expires_at) > now)
  ) || null;
}

/**
 * POST get-display-rate.
 * Body: { tier?, lock?, brand_key? } → { base_rate, brand_override,
 *         lock_multiplier, tier_multiplier, effective_rate, impact_tokens }
 */
async function displayRate(env, { tier = null, lock = false } = {}) {
  const res = await fetch(`${env.REGISTRY_SUPABASE_URL}/functions/v1/${DISPLAY_RATE_FN}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ ...(tier ? { tier } : {}), lock }),
    signal: AbortSignal.timeout(5000)
  });
  if (!res.ok) {
    console.error(`get-display-rate ${tier || 'base'} -> ${res.status}`);
    throw new Error('registry_unavailable');
  }
  return res.json();
}

export { displayRate, resolveActive, DISPLAY_RATE_FN };
