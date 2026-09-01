/**
 * GET /v1/demand — aggregate member demand, proxied from Bounty Hunter.
 *
 * Contract (supplied 2026-09-01):
 *   GET  {BH}/functions/v1/alliance-demand[?brand=]
 *   Hdr  x-registry-key
 *   →    { generated_at, rows: [{ title, category, brand_name,
 *                                 wish_count, member_count }] }
 *
 * The origin enforces a member_count >= 3 privacy floor and suppresses smaller
 * cohorts before this Worker sees them. Two rules follow, and they are the whole
 * reason this route is a thin proxy rather than a query layer:
 *
 *   1. Never expose an unfiltered total. A grand total alongside a filtered view
 *      lets a caller subtract to recover a suppressed cohort.
 *   2. Never re-aggregate across a ?brand= filter for the same reason.
 *
 * An empty rows array is a healthy, honest response — the demand board is simply
 * empty today. Placeholder or synthesized demand is never emitted.
 */

import { jsonResponse } from '../lib/http.js';
import { DEMAND_PUBLIC_FIELDS, projectAll, assertClean } from '../lib/disclosure.js';

async function handleDemand(url, env) {
  if (!env.REGISTRY_DEMAND_KEY) {
    return jsonResponse({
      error: 'demand_unavailable',
      message: 'The demand board is not currently reachable.'
    }, 503);
  }

  const brand = url.searchParams.get('brand');
  const upstream = new URL(`${env.BH_SUPABASE_URL}/functions/v1/alliance-demand`);
  if (brand) upstream.searchParams.set('brand', brand);

  const res = await fetch(upstream.toString(), {
    headers: { 'x-registry-key': env.REGISTRY_DEMAND_KEY, Accept: 'application/json' }
  });

  if (!res.ok) {
    console.error(`alliance-demand -> ${res.status}`);
    return jsonResponse({
      error: 'demand_unavailable',
      message: 'The demand board is not currently reachable.'
    }, 503);
  }

  const payload = await res.json();
  const rows = Array.isArray(payload?.rows) ? payload.rows : [];

  const body = {
    generated_at: payload?.generated_at || new Date().toISOString(),
    count: rows.length,
    // Aggregates only. No member identity is present upstream and none is added.
    rows: projectAll(rows, DEMAND_PUBLIC_FIELDS)
  };
  return jsonResponse(assertClean(body));
}

export { handleDemand };
