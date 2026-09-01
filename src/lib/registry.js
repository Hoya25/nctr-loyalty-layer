/**
 * EARN RATE REGISTRY resolution.
 *
 * The resolution rule is ported VERBATIM from the Registry's own canonical
 * implementation, get-active-rate/index.ts:93-97, and must not be re-derived:
 *
 *   const supersededIds = new Set(rows.map(r => r.supersedes).filter(Boolean));
 *   const active = rows.find(r =>
 *     !supersededIds.has(r.id) && (!r.expires_at || new Date(r.expires_at) > now));
 *
 * Why not `WHERE expires_at IS NULL`: two nctr_base_earn rows are live and
 * NEITHER carries expires_at. The newer (5/1) supersedes the older (1/5) by id
 * only. Filtering on expiry returns both and the answer becomes order-dependent.
 * Walking `supersedes` returns exactly one. The table is insert-only, so the
 * superseded row is never going away and this is permanent, not transitional.
 */

import { restGet } from './supabase.js';

const REGISTRY_TABLE = 'earn_rate_registry';

async function fetchRateRows(env, sourceClass, scopeId) {
  const params = new URLSearchParams();
  params.set('select', 'id,source_class,scope_id,source_label,rate_numerator,rate_denominator,multiplier_pct,effective_at,expires_at,supersedes,token_symbol');
  params.set('source_class', `eq.${sourceClass}`);
  params.set('scope_id', scopeId === null || scopeId === undefined ? 'is.null' : `eq.${scopeId}`);
  params.set('order', 'effective_at.desc');

  return restGet(env.REGISTRY_SUPABASE_URL, env.REGISTRY_ANON_KEY, `${REGISTRY_TABLE}?${params}`);
}

/** Verbatim port of get-active-rate's resolution. */
function resolveActive(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const supersededIds = new Set(rows.map((r) => r.supersedes).filter(Boolean));
  const now = new Date();
  return rows.find((r) =>
    !supersededIds.has(r.id) && (!r.expires_at || new Date(r.expires_at) > now)
  ) || null;
}

async function activeRate(env, sourceClass, scopeId = null) {
  return resolveActive(await fetchRateRows(env, sourceClass, scopeId));
}

/** A rate row carries EITHER numerator/denominator OR multiplier_pct, never both. */
function rateToNumber(row) {
  if (!row) return null;
  if (row.multiplier_pct !== null && row.multiplier_pct !== undefined) {
    return row.multiplier_pct / 100;
  }
  if (row.rate_numerator !== null && row.rate_denominator) {
    return row.rate_numerator / row.rate_denominator;
  }
  return null;
}

export { activeRate, resolveActive, fetchRateRows, rateToNumber };
