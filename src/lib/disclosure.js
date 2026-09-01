/**
 * DISCLOSURE GATE — the single public-projection boundary for /v1/* and /mcp.
 *
 * Two independent mechanisms, both fail-closed:
 *
 *   1. project()      — field allowlist. A field not named here NEVER reaches a
 *                       response, even if an upstream row grows a new column.
 *                       Adding an upstream column is therefore a no-op here,
 *                       which is the point: new data is private until a human
 *                       lists it.
 *
 *   2. assertClean()  — vocabulary scan of the fully serialized payload. Catches
 *                       banned terms that arrive inside VALUES rather than keys
 *                       (a merchant's own free-text description, an upstream
 *                       error string, a label someone edits later). The allowlist
 *                       cannot see those; this does.
 *
 * Canon references: NCTR is standing / status / multiplier / a key that unlocks
 * rewards. Never price, USD value, invest, returns, yield, APY, or revenue and
 * profit share. Never "cashback" — earn, rewards, bounties. The affiliate
 * network's vendor name is never public in any field, URL, path, or value.
 */

// ── Field allowlists ────────────────────────────────────────────────────────
// Mirrors Beacon's locked decision D13: bounty_rate_committed (brand-side commit
// rate) is PRIVATE and absent below; bounty_earn_displayed (member-side display
// rate) is PUBLIC. Do not add bounty_rate_committed to this list.

const BRAND_PUBLIC_FIELDS = [
  'store_id', 'public_slug', 'store_name', 'store_logo_url', 'mission_statement',
  'impact_engine', 'ownership_attributes', 'origin_attributes', 'sourcing_attributes',
  'certifications', 'lifestyle_fit', 'agent_readiness_score', 'agent_ready_badge',
  'bounty_earn_displayed', 'last_recomputed_at', 'updated_at'
];

const OFFER_PUBLIC_FIELDS = [
  'shopify_product_id', 'handle', 'title', 'description_md', 'price_cents',
  'currency', 'availability', 'product_url', 'image_url', 'nctr_bounty_rate',
  'attributes_inherited', 'last_synced_at'
];

const DEMAND_PUBLIC_FIELDS = [
  'title', 'category', 'brand_name', 'wish_count', 'member_count'
];

// ── F7: source_class is an INTERNAL enum and never leaves the Worker ─────────
// One live enum label carries the affiliate vendor's name. Raw enum values are
// mapped to a neutral public vocabulary; anything unmapped resolves to 'other'
// rather than passing through.
const SOURCE_CLASS_PUBLIC = {
  nctr_base_earn:            'base',
  beacon_brand_rate:         'brand',
  beacon_campaign_rate:      'campaign',
  crescendo_earn_multiplier: 'tier_multiplier',
  commitment_bonus:          'commitment',
  engine_token_rate:         'engine_token',
  acp_bounty_rate:           'bounty',
  impact_token_offer:        'impact_offer',
  loyalize_affiliate_rate:   'affiliate_provider',
  external_affiliate_rate:   'affiliate_provider'
};

function publicSourceClass(raw) {
  return SOURCE_CLASS_PUBLIC[raw] || 'other';
}

// ── Vocabulary blocklist ────────────────────────────────────────────────────
// DELIBERATE, CONTAINED EXCEPTION: the vendor names appear as literals here
// because a denylist must name what it denies. This is the ONLY place in the
// Worker they appear, and this module is never serialized into a response.
// Do not reference them anywhere else — use `affiliate_provider`.
const BLOCKED_VENDOR_TERMS = ['loyalize', 'sovrn'];

// Finance vocabulary that must never appear in member-facing output.
// Word-boundary matched so ordinary words are not caught by substring accident
// ("yield" must not fire on "yielded" in a merchant blurb? it should — but
// "price" must not fire on "priceless"; boundaries keep this predictable).
const BLOCKED_FINANCE_TERMS = [
  'cashback', 'cash back',
  'yield', 'yields', 'apy', 'apr',
  'roi', 'returns on', 'rate of return',
  'invest', 'investment', 'investor', 'investing',
  'revenue share', 'profit share', 'revenue split', 'treasury split',
  'dividend', 'equity stake', 'securities'
];

// Revenue/treasury mechanics. §6 standing constraint: no public surface explains
// how the rewards pool is funded.
const BLOCKED_MECHANICS_TERMS = [
  'treasury destination', 'funding source', 'defi', 'aerodrome',
  'liquidity pool', 'lp token', 'saac fee', 'fee rate', 'commitment rate'
];

const ALL_BLOCKED = [
  ...BLOCKED_VENDOR_TERMS,
  ...BLOCKED_FINANCE_TERMS,
  ...BLOCKED_MECHANICS_TERMS
];

// Vendor terms are matched as bare SUBSTRINGS, not on word boundaries.
// `\bloyalize\b` does not match inside `loyalize_affiliate_rate`, because `_`
// is a word character — so a snake_case identifier, a URL path segment, or a
// function name would carry the vendor name straight through a boundary-matched
// gate. The vendor name must never appear in ANY form, so no boundary applies.
// Finance and mechanics terms keep word boundaries, so ordinary copy such as
// "priceless" or "a returns policy" does not trip the gate.
const SUBSTRING_TERMS = new Set(BLOCKED_VENDOR_TERMS);

/**
 * Fail-closed field projection. Returns a new object containing ONLY allowlisted
 * keys that are actually present. Never mutates its input.
 */
function project(row, allowlist) {
  if (row === null || typeof row !== 'object') return {};
  const out = {};
  for (const key of allowlist) {
    if (Object.prototype.hasOwnProperty.call(row, key)) out[key] = row[key];
  }
  return out;
}

function projectAll(rows, allowlist) {
  return Array.isArray(rows) ? rows.map((r) => project(r, allowlist)) : [];
}

/**
 * Scans a serialized payload for banned vocabulary.
 * Returns { clean: boolean, hits: string[] }. Case-insensitive, word-boundary
 * matched. Checks keys and values alike, because both are visible to a caller.
 */
function scan(payload) {
  const text = (typeof payload === 'string' ? payload : JSON.stringify(payload) || '').toLowerCase();
  const hits = [];
  for (const term of ALL_BLOCKED) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Vendor names: bare substring, no boundaries (see SUBSTRING_TERMS above).
    // Multiword terms: \b is unreliable next to spaces, so no boundaries.
    // Everything else: word-boundary matched to avoid false positives.
    const pattern = (SUBSTRING_TERMS.has(term) || term.includes(' '))
      ? new RegExp(escaped, 'i')
      : new RegExp(`\\b${escaped}\\b`, 'i');
    if (pattern.test(text)) hits.push(term);
  }
  return { clean: hits.length === 0, hits };
}

/**
 * Runtime enforcement. Throws DisclosureViolation rather than returning a payload
 * that breaches canon. The router converts this into a generic 500 — a failed
 * request is strictly better than a leaked field.
 */
class DisclosureViolation extends Error {
  constructor(hits) {
    super(`disclosure gate blocked response: ${hits.join(', ')}`);
    this.name = 'DisclosureViolation';
    this.hits = hits;
  }
}

function assertClean(payload) {
  const { clean, hits } = scan(payload);
  if (!clean) throw new DisclosureViolation(hits);
  return payload;
}

export {
  BRAND_PUBLIC_FIELDS, OFFER_PUBLIC_FIELDS, DEMAND_PUBLIC_FIELDS,
  SOURCE_CLASS_PUBLIC, publicSourceClass,
  ALL_BLOCKED, SUBSTRING_TERMS, BLOCKED_VENDOR_TERMS, BLOCKED_FINANCE_TERMS, BLOCKED_MECHANICS_TERMS,
  project, projectAll, scan, assertClean, DisclosureViolation
};
