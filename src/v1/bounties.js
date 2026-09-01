/**
 * GET /v1/bounties            — every in-network brand with a published bounty
 * GET /v1/bounties/{slug}     — one brand plus its offer feed
 *
 * Source: Beacon's agent_safe_brand_profiles_public view and agent_offer_feeds.
 * Both are already anon-granted and already reviewed for public exposure under
 * Beacon's locked decision D13. This route inherits that boundary rather than
 * inventing a second one: bounty_rate_committed is absent from the view, and it
 * is absent from BRAND_PUBLIC_FIELDS too, so it cannot appear even if the view
 * were widened upstream.
 */

import { restGet } from '../lib/supabase.js';
import { jsonResponse } from '../lib/http.js';
import {
  BRAND_PUBLIC_FIELDS, OFFER_PUBLIC_FIELDS, projectAll, project, assertClean
} from '../lib/disclosure.js';

const BRAND_VIEW = 'agent_safe_brand_profiles_public';
const OFFER_TABLE = 'agent_offer_feeds';

async function fetchBrands(env, { slug } = {}) {
  const params = new URLSearchParams();
  params.set('select', '*');
  if (slug) params.set('public_slug', `eq.${slug}`);
  params.set('order', 'store_name.asc');
  return restGet(env.BEACON_SUPABASE_URL, env.BEACON_ANON_KEY, `${BRAND_VIEW}?${params}`);
}

async function fetchOffers(env, storeId) {
  const params = new URLSearchParams();
  params.set('select', '*');
  params.set('store_id', `eq.${storeId}`);
  params.set('order', 'title.asc');
  return restGet(env.BEACON_SUPABASE_URL, env.BEACON_ANON_KEY, `${OFFER_TABLE}?${params}`);
}

/**
 * Keyword filtering runs in the Worker, not in PostgREST: the view is small and
 * a server-side ilike would let caller-supplied text reach the query string.
 */
function matchesKeyword(brand, keyword) {
  if (!keyword) return true;
  const k = keyword.toLowerCase();
  return ['store_name', 'mission_statement', 'impact_engine', 'lifestyle_fit']
    .some((f) => String(brand[f] ?? '').toLowerCase().includes(k));
}

async function handleBounties(url, env) {
  const keyword = url.searchParams.get('keyword');
  const brandFilter = url.searchParams.get('brand');

  const rows = await fetchBrands(env, { slug: brandFilter || undefined });
  const filtered = rows.filter((b) => matchesKeyword(b, keyword));

  const body = {
    generated_at: new Date().toISOString(),
    count: filtered.length,
    brands: projectAll(filtered, BRAND_PUBLIC_FIELDS)
  };
  return jsonResponse(assertClean(body));
}

async function handleBrandBounty(slug, env) {
  const rows = await fetchBrands(env, { slug });
  if (!rows.length) {
    return jsonResponse({ error: 'brand_not_found', slug }, 404);
  }
  const brand = rows[0];
  const offers = await fetchOffers(env, brand.store_id);

  const body = {
    generated_at: new Date().toISOString(),
    brand: project(brand, BRAND_PUBLIC_FIELDS),
    offer_count: offers.length,
    offers: projectAll(offers, OFFER_PUBLIC_FIELDS)
  };
  return jsonResponse(assertClean(body));
}

export { handleBounties, handleBrandBounty };
