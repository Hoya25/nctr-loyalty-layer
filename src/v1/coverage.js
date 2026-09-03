/**
 * TWO-SUPPLY COVERAGE — is a brand in the Alliance network?
 *
 * NCTR has two independent supply systems and a brand is in-network if it is in
 * EITHER. A coverage answer that consults only one is not a partial answer, it
 * is a wrong one, so this module always reports which systems it actually
 * reached and refuses to say "no" unless both answered.
 *
 *   1. direct_merchants — Beacon. Direct merchant relationships.
 *   2. discovery_layer  — NCTR's own discovery layer, ~6,300 active brands
 *                         reached via proprietary integrations.
 *
 * ── DISCLOSURE, and why this module selects columns explicitly ──────────────
 * The discovery layer's `brands` table carries fields that must NEVER reach a
 * public response: a vendor-named id column, and a tracked `affiliate_url`
 * whose host carries the provider's name. Both were confirmed present in live
 * responses from the upstream helper function.
 *
 * So this module SELECTS ONLY `name, category`. It does not select-star and
 * project afterwards, because a projection bug would leak; a narrow select
 * cannot. The disclosure gate still runs on the way out as a second net.
 * Never widen this select.
 *
 * ── Why not the upstream brand-lookup helper ────────────────────────────────
 * That function's search mode is fuzzy: a live probe for "patagonia" returned
 * Backcountry, Campmor and CardCash — none of them name matches. Treating a
 * non-empty result as a coverage hit would answer "in network" for brands that
 * are not. It also returns the two forbidden fields and rate-limits to 10
 * req/min per IP. Exact matching against the table is both safer and correct.
 */

import { restGet } from '../lib/supabase.js';
import { withoutExcluded } from '../lib/exclusions.js';

// The ONLY columns this module ever reads from the discovery layer.
const DISCOVERY_COLUMNS = 'name,category';
const SIMILAR_LIMIT = 5;

/**
 * PostgREST reserves , . ( ) * : and treats them as filter syntax. A brand name
 * is caller-supplied, so strip them rather than escape them — no legitimate
 * lookup needs them, and a malformed filter would either error or, worse,
 * silently match differently than intended.
 */
function sanitize(term) {
  return String(term || '').replace(/[,.()*:%\\]/g, ' ').trim().slice(0, 80);
}

async function lookupDiscovery(env, term) {
  const clean = sanitize(term);
  if (clean.length < 2) return { exact: null, similar: [] };

  const exactParams = new URLSearchParams();
  exactParams.set('select', DISCOVERY_COLUMNS);
  exactParams.set('is_active', 'eq.true');
  exactParams.set('name', `ilike.${clean}`);
  exactParams.set('limit', '1');

  const exactRows = await restGet(
    env.AFFILIATE_SUPABASE_URL, env.AFFILIATE_ANON_KEY, `brands?${exactParams}`
  );
  if (exactRows.length) return { exact: exactRows[0], similar: [] };

  // No exact match. Offer near names WITHOUT claiming coverage for them.
  const nearParams = new URLSearchParams();
  nearParams.set('select', DISCOVERY_COLUMNS);
  nearParams.set('is_active', 'eq.true');
  nearParams.set('name', `ilike.*${clean}*`);
  nearParams.set('order', 'name.asc');
  nearParams.set('limit', String(SIMILAR_LIMIT));

  const nearRows = await restGet(
    env.AFFILIATE_SUPABASE_URL, env.AFFILIATE_ANON_KEY, `brands?${nearParams}`
  );
  return { exact: null, similar: nearRows.map((r) => r.name) };
}

async function lookupDirect(env, term) {
  const clean = sanitize(term);
  if (clean.length < 2) return null;

  const params = new URLSearchParams();
  params.set('select', 'public_slug,store_name');
  params.set('or', `(public_slug.eq.${clean},store_name.ilike.*${clean}*)`);

  const rows = withoutExcluded(await restGet(
    env.BEACON_SUPABASE_URL, env.BEACON_ANON_KEY,
    `agent_safe_brand_profiles_public?${params}`
  ));
  return rows[0] || null;
}

/**
 * Returns a coverage verdict. `in_network` is null — never false — when a system
 * could not be reached, because absence from one of two systems proves nothing.
 */
async function checkCoverage(brandQuery, env) {
  const checked = [];
  const failed = [];

  const [directResult, discoveryResult] = await Promise.allSettled([
    lookupDirect(env, brandQuery),
    env.AFFILIATE_SUPABASE_URL && env.AFFILIATE_ANON_KEY
      ? lookupDiscovery(env, brandQuery)
      : Promise.reject(new Error('not_configured'))
  ]);

  let match = null;

  if (directResult.status === 'fulfilled') {
    checked.push('direct_merchants');
    if (directResult.value) {
      match = {
        system: 'direct_merchants',
        name: directResult.value.store_name,
        public_slug: directResult.value.public_slug
      };
    }
  } else {
    failed.push('direct_merchants');
    console.error('coverage direct lookup failed:', directResult.reason?.message);
  }

  let similar = [];
  if (discoveryResult.status === 'fulfilled') {
    checked.push('discovery_layer');
    if (!match && discoveryResult.value.exact) {
      match = {
        system: 'discovery_layer',
        name: discoveryResult.value.exact.name,
        category: discoveryResult.value.exact.category
      };
    }
    if (!match) similar = discoveryResult.value.similar;
  } else {
    failed.push('discovery_layer');
    if (discoveryResult.reason?.message !== 'not_configured') {
      console.error('coverage discovery lookup failed:', discoveryResult.reason?.message);
    }
  }

  const complete = failed.length === 0;

  return {
    brand: brandQuery,
    // true when found; false ONLY when both systems answered; null otherwise.
    in_network: match ? true : (complete ? false : null),
    systems_checked: checked,
    coverage_complete: complete,
    ...(match ? { match } : {}),
    ...(similar.length ? { similar_brands: similar } : {}),
    ...(!match && !complete
      ? { note: 'Not found in the systems reached. Coverage is incomplete, so this is not a confirmation the brand is absent from the Alliance.' }
      : {})
  };
}

export { checkCoverage, sanitize, DISCOVERY_COLUMNS };
