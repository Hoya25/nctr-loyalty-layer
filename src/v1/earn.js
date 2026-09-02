/**
 * GET /v1/earn/{brand} — the Alliance earn ladder.
 *
 * Every rate comes from the Registry's own `get-display-rate`, which applies the
 * canonical supersedes resolution server-side. Nothing here hardcodes a rate: if
 * the atomic 10 NCTR/$1 cutover lands and retires the commitment bonus, this
 * route follows on the next request with no code change.
 *
 * Commitment QUALIFIES a tier; it never multiplies a tier. The ladder is
 * published with the commitment applied because that is the rate a committed
 * member actually earns, and `commitment.multiplier` is shown separately so the
 * two factors stay legible rather than blended into one opaque number.
 *
 * KNOWN LIMIT — brand-specific rates are not applied. `beacon_brand_rate` is
 * scoped by Beacon store_id, and get-display-rate resolves brand overrides from
 * a different source class. Reading beacon_brand_rate directly would require a
 * privileged Registry credential this Worker deliberately does not hold. So this
 * route returns the ALLIANCE-WIDE ladder and says so explicitly via
 * `brand_rate_applied: false`. It never silently presents a global rate as if it
 * were brand-specific. See DECISIONS D10.
 */

import { jsonResponse } from '../lib/http.js';
import { displayRate } from '../lib/registry.js';
import { restGet } from '../lib/supabase.js';
import { assertClean } from '../lib/disclosure.js';

const TIER_ORDER = ['bronze', 'silver', 'gold', 'platinum', 'diamond'];

async function resolveBrand(env, slug) {
  const params = new URLSearchParams();
  params.set('select', 'store_id,store_name,public_slug');
  params.set('public_slug', `eq.${slug}`);
  const rows = await restGet(
    env.BEACON_SUPABASE_URL, env.BEACON_ANON_KEY,
    `agent_safe_brand_profiles_public?${params}`
  );
  return rows[0] || null;
}

async function handleEarn(slug, env) {
  if (!env.REGISTRY_SUPABASE_URL) {
    return jsonResponse({
      error: 'earn_unavailable',
      message: 'The earn ladder is not currently available.'
    }, 503);
  }

  const brand = await resolveBrand(env, slug);
  if (!brand) return jsonResponse({ error: 'brand_not_found', slug }, 404);

  let rows;
  try {
    rows = await Promise.all(TIER_ORDER.map((t) => displayRate(env, { tier: t, lock: true })));
  } catch {
    return jsonResponse({
      error: 'earn_unavailable',
      message: 'The earn ladder is not currently available.'
    }, 503);
  }

  const body = {
    generated_at: new Date().toISOString(),
    brand: { public_slug: brand.public_slug, store_name: brand.store_name },
    base: {
      nctr_per_dollar: rows[0].base_rate,
      brand_rate_applied: false,
      note: 'Alliance-wide base rate. A brand-specific rate, where one exists, is not reflected here.'
    },
    commitment: {
      multiplier: rows[0].lock_multiplier,
      note: 'Committing NCTR qualifies you for a tier. It does not multiply a tier.'
    },
    tiers: TIER_ORDER.map((tier, i) => ({
      tier,
      multiplier: rows[i].tier_multiplier,
      nctr_per_dollar: rows[i].effective_rate
    }))
  };
  return jsonResponse(assertClean(body));
}

export { handleEarn };
