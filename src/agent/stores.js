import { CORS_HEADERS, jsonResponse } from '../lib/http.js';

// ============================================================
// GET /agent/stores/:slug/profile — Public agent brand profile
// ============================================================

async function handleAgentProfile(slug, env) {
  if (!env.BEACON_SUPABASE_URL || !env.BEACON_ANON_KEY) {
    return jsonResponse({ error: 'Beacon not configured' }, 503);
  }

  try {
    const headers = {
      apikey: env.BEACON_ANON_KEY,
      Authorization: `Bearer ${env.BEACON_ANON_KEY}`
    };
    const encodedSlug = encodeURIComponent(slug);
    const upstream = await fetch(
      `${env.BEACON_SUPABASE_URL}/rest/v1/agent_safe_brand_profiles_public?public_slug=eq.${encodedSlug}&select=*`,
      { headers }
    );

    if (!upstream.ok) {
      console.error('Beacon profile upstream error:', upstream.status, await upstream.text());
      return jsonResponse({ error: 'upstream error' }, 502);
    }

    const rows = await upstream.json();
    if (!Array.isArray(rows) || rows.length === 0) {
      return jsonResponse({ error: 'store not found' }, 404);
    }

    const row = rows[0];
    const profile = {
      slug: row.public_slug,
      name: row.store_name,
      logo_url: row.store_logo_url || null,
      mission: row.mission_statement,
      agent_readiness_score: row.agent_readiness_score,
      agent_ready_badge: row.agent_ready_badge,
      bounty_earn_displayed: row.bounty_earn_displayed,
      ownership: row.ownership_attributes,
      origin: row.origin_attributes,
      sourcing: row.sourcing_attributes,
      certifications: row.certifications,
      lifestyle_fit: row.lifestyle_fit,
      impact_engine: row.impact_engine || null,
      last_updated: row.last_recomputed_at
    };

    return new Response(JSON.stringify(profile, null, 2), {
      status: 200,
      headers: { ...CORS_HEADERS, 'Cache-Control': 'public, max-age=60' }
    });
  } catch (err) {
    console.error('handleAgentProfile error:', err);
    return jsonResponse({ error: 'internal' }, 502);
  }
}

// ============================================================
// GET /agent/stores/:slug/offers — Public agent offer feed
// ============================================================

async function handleAgentOffers(slug, env) {
  if (!env.BEACON_SUPABASE_URL || !env.BEACON_ANON_KEY) {
    return jsonResponse({ error: 'Beacon not configured' }, 503);
  }

  try {
    const headers = {
      apikey: env.BEACON_ANON_KEY,
      Authorization: `Bearer ${env.BEACON_ANON_KEY}`
    };
    const encodedSlug = encodeURIComponent(slug);

    const lookup = await fetch(
      `${env.BEACON_SUPABASE_URL}/rest/v1/agent_safe_brand_profiles_public?public_slug=eq.${encodedSlug}&select=store_id`,
      { headers }
    );

    if (!lookup.ok) {
      console.error('Beacon offers lookup error:', lookup.status, await lookup.text());
      return jsonResponse({ error: 'upstream error' }, 502);
    }

    const lookupRows = await lookup.json();
    if (!Array.isArray(lookupRows) || lookupRows.length === 0) {
      return jsonResponse({ error: 'store not found' }, 404);
    }

    const storeId = lookupRows[0].store_id;
    const encodedStoreId = encodeURIComponent(storeId);
    const offersResp = await fetch(
      `${env.BEACON_SUPABASE_URL}/rest/v1/agent_offer_feeds?store_id=eq.${encodedStoreId}&select=*`,
      { headers }
    );

    if (!offersResp.ok) {
      console.error('Beacon offers fetch error:', offersResp.status, await offersResp.text());
      return jsonResponse({ error: 'upstream error' }, 502);
    }

    const offers = await offersResp.json();
    const body = { slug, offers: Array.isArray(offers) ? offers : [] };

    return new Response(JSON.stringify(body, null, 2), {
      status: 200,
      headers: { ...CORS_HEADERS, 'Cache-Control': 'public, max-age=60' }
    });
  } catch (err) {
    console.error('handleAgentOffers error:', err);
    return jsonResponse({ error: 'internal' }, 502);
  }
}

export { handleAgentProfile, handleAgentOffers };
