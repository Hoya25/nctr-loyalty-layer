import { jsonResponse } from '../lib/http.js';
import { TIERS, NCTR_PER_DOLLAR } from '../config.js';

// ============================================================
// GET /loyalty/tiers — Three-tier pricing info
// ============================================================

// ── Phase 2: canonical tier/benefit schedule ────────────────────────────────
//
// Reads the single source of truth: BH's crescendo_schedule_public view. Every
// surface derives from it; nothing holds a local copy. The TIERS constant below
// survives ONLY as a fallback for when the view is unreachable.
//
// DELIBERATE SCOPE LIMIT: this feeds the PUBLISHED response only. handleWrap()
// still computes member credits from the TIERS constant, so a network blip can
// never change what a member is paid. Unifying the two is Phase 5, and it should
// not happen until the view has proven stable. Until then, a drift guard below
// flags any disagreement rather than silently letting them diverge.
const SCHEDULE_STALE_AFTER_SECONDS = 48 * 60 * 60;

async function fetchSchedule(env) {
  const base = env.BH_SUPABASE_URL;
  const key = env.BH_ANON_KEY;
  if (!base || !key) return null;

  try {
    const res = await fetch(
      `${base}/rest/v1/crescendo_schedule_public?select=*&order=rank.asc`,
      {
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
          Accept: 'application/json'
        },
        signal: AbortSignal.timeout(4000)
      }
    );
    if (!res.ok) {
      console.error('schedule fetch failed:', res.status);
      return null;
    }
    const rows = await res.json();
    return Array.isArray(rows) && rows.length ? rows : null;
  } catch (err) {
    console.error('schedule fetch error:', err && err.message);
    return null;
  }
}

// Compares the view against the local constant. Any disagreement is surfaced,
// never silently resolved — the constant is what actually pays members.
function detectConfigDrift(rows) {
  const drift = [];
  for (const r of rows) {
    const local = TIERS[r.label];
    if (!local) { drift.push(`${r.label}: no local tier`); continue; }
    if (Number(local.multiplier) !== Number(r.earn_multiplier)) {
      drift.push(`${r.label}.multiplier local=${local.multiplier} view=${r.earn_multiplier}`);
    }
    if (Number(local.threshold) !== Number(r.nctr_required)) {
      drift.push(`${r.label}.threshold local=${local.threshold} view=${r.nctr_required}`);
    }
  }
  return drift;
}

async function handleTiers(env) {
  const rows = await fetchSchedule(env);

  let crescendoTiers;
  let meta;

  if (rows) {
    crescendoTiers = rows.map((r) => ({
      name: r.label,
      nctr_required: Number(r.nctr_required),
      multiplier: Number(r.earn_multiplier),
      benefits: Array.isArray(r.benefits) ? r.benefits : []
    }));

    const syncedAt = rows[0].last_synced_at;
    const ageSeconds = syncedAt
      ? Math.max(0, Math.floor((Date.now() - new Date(syncedAt).getTime()) / 1000))
      : null;

    meta = {
      last_synced_at: syncedAt || null,
      age_seconds: ageSeconds,
      stale: ageSeconds !== null && ageSeconds > SCHEDULE_STALE_AFTER_SECONDS,
      schema_version: rows[0].schema_version || null,
      source: 'schedule'
    };

    const drift = detectConfigDrift(rows);
    if (drift.length) {
      console.error('CONFIG DRIFT — published schedule disagrees with credit constants:', drift.join('; '));
      meta.config_drift = true;
      meta.config_drift_detail = drift;
    }
  } else {
    // View unreachable. Serve the constant and say so — a silent fallback that
    // looks identical to fresh data is how stale facts survive unnoticed.
    crescendoTiers = Object.entries(TIERS).map(([, val]) => ({
      name: val.label,
      nctr_required: val.threshold,
      multiplier: val.multiplier,
      benefits: []
    }));
    meta = {
      last_synced_at: null,
      age_seconds: null,
      stale: null,
      schema_version: 'v15',
      source: 'worker_constant',
      degraded: true
    };
  }

  return jsonResponse({
    membership: {
      name: 'Alliance Member',
      description: 'One membership for brands joining the Alliance. Integration is available through the Beacon app for Shopify, a direct API for any other platform, and an agent-native x402 path.',
      integration_paths: ['beacon', 'api', 'x402']
    },

    // The cooperative mechanic is deliberate public canon and stays. It is stated
    // qualitatively on purpose — the mechanic is the point, not a rate card.
    cooperative_model: {
      principle: 'SaaS charges you for access. SaaC makes you an owner.',
      how_it_works: 'Half of what a brand contributes to the Alliance comes back to that brand as NCTR, committed through 360LOCK. The remainder sustains the Alliance and its committed liquidity.',
      brand_position: 'Brands participate as owners in the network they sell through, not as tenants paying for access.'
    },

    // Member earning math — publishable in full.
    // nctr_per_dollar intentionally still sourced from the Worker constant: it
    // computes real member credits, so it stays single-sourced until Phase 5.
    nctr_per_dollar: NCTR_PER_DOLLAR,
    crescendo_tiers: crescendoTiers,

    member_commitment: '360LOCK — member NCTR is committed for 360 days.',
    liquidity_commitment: '24-month verifiable lockup with rolling extensions, held in a verified contract on Base.',
    note: 'Brands set their own bounty rate. Higher bounties attract more agent traffic.',
    meta: meta
  });
}

export { handleTiers, fetchSchedule };
