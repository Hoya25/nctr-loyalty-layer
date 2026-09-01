/**
 * GET /v1/earn/{brand} — the earn ladder for a brand, derived from the Registry.
 *
 * Derivation (per the commitment_bonus row's own canonical note):
 *   effective NCTR per $1 = base x commitment x tier multiplier
 * where base is the brand's beacon_brand_rate when one exists, else the global
 * nctr_base_earn. Commitment QUALIFIES a tier; it never multiplies a tier.
 *
 * Every rate is resolved through registry.activeRate(), which walks `supersedes`
 * exactly as the Registry's own get-active-rate does. Nothing here hardcodes a
 * rate: if the 10 NCTR/$1 atomic cutover lands and retires the commitment bonus,
 * this route follows automatically because it reads whatever the Registry says
 * at request time.
 *
 * F7: raw source_class values never leave the Worker. They are mapped through
 * publicSourceClass() to a neutral vocabulary.
 */

import { jsonResponse } from '../lib/http.js';
import { activeRate, rateToNumber } from '../lib/registry.js';
import { restGet } from '../lib/supabase.js';
import { publicSourceClass, assertClean } from '../lib/disclosure.js';

const TIER_ORDER = ['bronze', 'silver', 'gold', 'platinum', 'diamond'];

async function resolveStoreId(env, slug) {
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
  // Degrade honestly rather than throwing when the Registry binding is absent.
  // A 503 that says the ladder is unavailable is a true statement; a 500 from a
  // failed fetch is not, and a hardcoded fallback rate would be worse than both.
  if (!env.REGISTRY_SUPABASE_URL || !env.REGISTRY_ANON_KEY) {
    return jsonResponse({
      error: 'earn_unavailable',
      message: 'The earn ladder is not currently available.'
    }, 503);
  }

  const brand = await resolveStoreId(env, slug);
  if (!brand) return jsonResponse({ error: 'brand_not_found', slug }, 404);

  // Brand-scoped rate wins over the global base when one exists.
  const [brandRow, baseRow, commitmentRow] = await Promise.all([
    activeRate(env, 'beacon_brand_rate', brand.store_id),
    activeRate(env, 'nctr_base_earn', null),
    activeRate(env, 'commitment_bonus', null)
  ]);

  const sourceRow = brandRow || baseRow;
  const baseRate = rateToNumber(sourceRow);

  if (baseRate === null) {
    return jsonResponse({ error: 'rate_unavailable', slug }, 503);
  }

  const commitmentMultiplier = rateToNumber(commitmentRow) ?? 1;

  const tiers = [];
  for (const tier of TIER_ORDER) {
    const row = await activeRate(env, 'crescendo_earn_multiplier', tier);
    const mult = rateToNumber(row);
    if (mult === null) continue;
    tiers.push({
      tier,
      multiplier: mult,
      // Standing math only. No USD, no price, no value.
      nctr_per_dollar: Number((baseRate * commitmentMultiplier * mult).toFixed(4))
    });
  }

  const body = {
    generated_at: new Date().toISOString(),
    brand: { public_slug: brand.public_slug, store_name: brand.store_name },
    base: {
      nctr_per_dollar: baseRate,
      source: publicSourceClass(sourceRow.source_class),
      scoped_to_brand: Boolean(brandRow)
    },
    commitment: {
      multiplier: commitmentMultiplier,
      note: 'Committing NCTR qualifies you for a tier. It does not multiply a tier.'
    },
    tiers
  };
  return jsonResponse(assertClean(body));
}

export { handleEarn };
