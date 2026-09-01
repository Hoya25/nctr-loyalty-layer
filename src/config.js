// ============================================================
// TIER CONFIGURATION
// ============================================================

// Canon v15 (locked). These are NOT display-only: multiplier feeds the live
// credit calculation in handleWrap(). Bronze was 1.0 and Silver 1.25 here, both
// off-canon and under-crediting members. Corrected 2026-08-21.
const TIERS = {
  Bronze:   { multiplier: 1.1, threshold: 1000,   label: 'Bronze' },
  Silver:   { multiplier: 1.3, threshold: 5000,   label: 'Silver' },
  Gold:     { multiplier: 1.5, threshold: 15000,  label: 'Gold' },
  Platinum: { multiplier: 1.8, threshold: 40000,  label: 'Platinum' },
  Diamond:  { multiplier: 2.5, threshold: 100000, label: 'Diamond' }
};

// NCTR earned per dollar of purchase (base rate before tier multiplier)
// Canon base earn rate: 5 NCTR per $1. Was 2.5 here, which both mis-published the
// rate and under-credited every member earning through /loyalty/wrap.
const NCTR_PER_DOLLAR = 5;

// SaaC fee rates by integration tier
const SAAC_FEE_RATES = {
  'beacon':  0.01,   // Tier 1: Beacon/Shopify — 1%
  'api':     0.015,  // Tier 2: API Integration — 1.5%
  'x402':    0.02    // Tier 3: Agent-Native x402 — 2%
};

// 50% of per-transaction fee goes to liquidity commitment
const LIQUIDITY_SPLIT = 0.50;

export { TIERS, NCTR_PER_DOLLAR, SAAC_FEE_RATES, LIQUIDITY_SPLIT };
