/**
 * NCTR Loyalty Layer — Cloudflare Worker
 * api.nctr.live
 *
 * Handles two commerce tracks:
 *   Track 1 (traditional): 90-day settlement hold, database credit, no on-chain action
 *   Track 2 (x402): on-chain delivery + liquidity commitment proof
 *
 * Endpoints:
 *   POST /loyalty/wrap                — Issue NCTR participation rewards
 *   GET  /loyalty/stats               — Public liquidity statistics
 *   GET  /loyalty/tiers               — Three-tier pricing info
 *   GET  /loyalty/verify              — Verify a commitment on-chain
 *   GET  /loyalty/lock-status         — Lock expiry and extension history
 *   GET  /agent/stores/:slug/profile  — Public agent-facing brand profile
 *   GET  /agent/stores/:slug/offers   — Public agent-facing offer feed
 *   POST /agent/sessions/create       — Agent declares intent, gets session_token
 *   GET  /agent/sessions/:token       — Look up an existing agent session
 *   GET  /health                      — Health check
 *
 * Environment Secrets:
 *   BH_SUPABASE_URL           — BountyHunter Supabase URL
 *   BH_ANON_KEY               — BountyHunter anon key
 *   SYNC_SECRET               — Shared auth secret for admin-api
 *   COMMITMENT_CONTRACT_ADDRESS — NCTRLiquidityCommitment contract
 *   WORKER_PRIVATE_KEY         — Wallet key for signing on-chain txns
 *   BASE_RPC_URL               — Base RPC endpoint
 *   BEACON_SUPABASE_URL        — Beacon Supabase URL (agent endpoints)
 *   BEACON_ANON_KEY            — Beacon anon key (agent endpoints)
 *
 * @custom:compliance
 *   Never "yield", "returns", "investment", "APY"
 *   Liquidity commitment is "backing" not "staking"
 *   NCTR is "earned through participation"
 */

import { createWalletClient, createPublicClient, http, encodeFunctionData, parseAbi } from 'viem';
import { base, baseSepolia } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';

// ============================================================
// CONTRACT ABI (minimal for our calls)
// ============================================================

// ── /loyalty/verify kill switch ────────────────────────────────────────────
// OFFLINE until the commitment records are re-seeded under genuine transaction
// hashes. The nine records currently in the contract are keyed 0x..01–0x..09
// (counters passed to commitFromTransaction at seeding time, not tx hashes),
// so a correct verifier returns false for every record that exists. An endpoint
// that answers false to everything is worse than one that is not published.
// Flip to true once re-seeding lands — the handler below is already correct.
const VERIFY_ENDPOINT_ENABLED = false;

// A transaction hash is exactly 32 bytes. Anything else is rejected before
// it reaches viem or the contract.
const TX_HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;

const COMMITMENT_ABI = parseAbi([
  'function commitFromTransaction(uint256 usdcAmount, bytes32 txHash) external',
  'function getCommitmentStats() external view returns (uint256 totalUsdcCommitted, uint256 totalLpTokensHeld, uint256 currentPoolDepth, uint256 commitmentRate, uint256 transactionCount, uint256 lastCommitmentTimestamp)',
  'function getLockStatus() external view returns (uint256 lockExpiry, uint256 lockRemaining, bool isLocked, uint256 extensionCount, address withdrawalAddress)',
  'function verifyCommitment(bytes32 txHash) external view returns (bool)',
  'function getCommitmentRecord(bytes32 txHash) external view returns (uint256 usdcAmount, uint256 lpTokensReceived, uint256 timestamp, bool exists)'
]);

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

// ============================================================
// CORS HEADERS
// ============================================================

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-sync-secret',
  'Content-Type': 'application/json'
};

// ============================================================
// MAIN HANDLER
// ============================================================

export default {
  async fetch(request, env) {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // Route handling
      if (path === '/health') {
        return jsonResponse({
          status: 'healthy',
          service: 'nctr-loyalty-layer',
          version: '2.1.0',
          tracks: { track_1: 'traditional', track_2: 'x402_onchain' },
          timestamp: new Date().toISOString()
        });
      }

      if (path === '/loyalty/tiers') {
        return await handleTiers(env);
      }

      if (path === '/loyalty/stats') {
        return await handleStats(env);
      }

      if (path === '/loyalty/lock-status') {
        return await handleLockStatus(env);
      }

      if (path === '/loyalty/verify') {
        if (!VERIFY_ENDPOINT_ENABLED) {
          return jsonResponse({
            error: 'endpoint_unavailable',
            message: 'Commitment verification is temporarily unavailable. The liquidity commitment contract remains live and independently readable on BaseScan.',
            contract: env.COMMITMENT_CONTRACT_ADDRESS || null,
            verifiable_at: env.COMMITMENT_CONTRACT_ADDRESS
              ? `https://basescan.org/address/${env.COMMITMENT_CONTRACT_ADDRESS}`
              : null
          }, 503);
        }
        const txHash = url.searchParams.get('tx');
        return await handleVerify(txHash, env);
      }

      if (path === '/loyalty/wrap' && request.method === 'POST') {
        return await handleWrap(request, env);
      }

      // Agent endpoints (Beacon brand profiles)
      const agentMatch = path.match(/^\/agent\/stores\/([^/]+)\/(profile|offers)$/);
      if (agentMatch) {
        const slug = decodeURIComponent(agentMatch[1]);
        if (agentMatch[2] === 'profile') {
          return await handleAgentProfile(slug, env);
        }
        return await handleAgentOffers(slug, env);
      }

      // Agent session endpoints
      const sessionMatch = path.match(/^\/agent\/sessions\/(create|[a-zA-Z0-9_]+)$/);
      if (sessionMatch) {
        const param = sessionMatch[1];
        if (param === 'create' && request.method === 'POST') {
          return await handleAgentSessionCreate(request, env);
        }
        if (request.method === 'GET') {
          return await handleAgentSessionLookup(param, env);
        }
        return jsonResponse({ error: 'method not allowed' }, 405);
      }

      return jsonResponse({ error: 'Not found' }, 404);

    } catch (err) {
      console.error('Worker error:', err);
      return jsonResponse({
        error: 'Internal error',
        message: err.message
      }, 500);
    }
  }
};

// ============================================================
// POST /loyalty/wrap — Core transaction handler
// ============================================================

async function handleWrap(request, env) {
  const body = await request.json();
  const {
    member_email,
    purchase_amount_usd,
    source = 'beacon',
    merchant_id = null,
    tx_hash = null,
    lock_type = null       // merchant override for lock type
  } = body;

  // Validate required fields
  if (!member_email || !purchase_amount_usd) {
    return jsonResponse({
      error: 'Missing required fields: member_email, purchase_amount_usd'
    }, 400);
  }

  const amount = parseFloat(purchase_amount_usd);
  if (isNaN(amount) || amount <= 0) {
    return jsonResponse({ error: 'Invalid purchase_amount_usd' }, 400);
  }

  // ── Step 1: Look up member via BH admin-api ──
  const member = await lookupMember(member_email, env);
  if (!member) {
    return jsonResponse({
      error: 'Member not found',
      email: member_email,
      signup_url: 'https://bountyhunter.nctr.live'
    }, 404);
  }

  // ── Step 2: Calculate NCTR earned ──
  const tierInfo = TIERS[member.tier] || TIERS.Bronze;
  const nctrEarned = Math.round(amount * NCTR_PER_DOLLAR * tierInfo.multiplier * 100) / 100;

  // Determine lock type based on source + merchant override
  const isX402 = source === 'x402';
  let effectiveLockType;
  if (lock_type) {
    // Merchant override — honor their return policy preference
    effectiveLockType = lock_type;
  } else if (isX402) {
    // x402 default: no lock (instant settlement, no chargeback risk)
    effectiveLockType = 'none';
  } else {
    // Traditional default: 90LOCK (chargeback protection)
    effectiveLockType = '90LOCK';
  }

  // ── Step 3: Credit NCTR to member via BH admin-api ──
  const creditResult = await creditMember(
    member.user_id,
    nctrEarned,
    effectiveLockType,
    source,
    merchant_id,
    env
  );

  if (!creditResult.success) {
    return jsonResponse({
      error: 'Failed to credit NCTR',
      details: creditResult.error
    }, 500);
  }

  // ── Step 4: On-chain liquidity commitment (Track 2 only) ──
  let liquidityProof = null;

  if (tx_hash && isX402) {
    try {
      liquidityProof = await commitLiquidity(
        amount,
        source,
        tx_hash,
        env
      );
    } catch (err) {
      // Log but don't fail the transaction — commitment is additive
      console.error('Liquidity commitment failed:', err.message);
      liquidityProof = {
        status: 'commitment_pending',
        error: err.message,
        note: 'NCTR credited successfully. Liquidity commitment will retry.'
      };
    }
  }

  // ── Step 5: Build response ──
  const response = {
    success: true,
    nctr_earned: nctrEarned,
    settlement: describeSettlement(effectiveLockType),
    tier: tierInfo.label,
    multiplier: tierInfo.multiplier,
    member_balance: creditResult.new_balance,
    track: isX402 ? 2 : 1,
    receipt: {
      member_email,
      purchase_amount_usd: amount,
      source,
      merchant_id,
      nctr_earned: nctrEarned,
      settlement: describeSettlement(effectiveLockType),
      timestamp: new Date().toISOString()
    }
  };

  // Include liquidity proof for Track 2
  if (liquidityProof) {
    response.liquidity_proof = liquidityProof;
  }

  return jsonResponse(response);
}

// ============================================================
// LIQUIDITY COMMITMENT — on-chain via NCTRLiquidityCommitment
// ============================================================

async function commitLiquidity(purchaseAmountUsd, source, txHash, env) {
  const contractAddress = env.COMMITMENT_CONTRACT_ADDRESS;
  const privateKey = env.WORKER_PRIVATE_KEY;
  const rpcUrl = env.BASE_RPC_URL || 'https://mainnet.base.org';

  if (!contractAddress || !privateKey) {
    throw new Error('Commitment contract not configured');
  }

  // Calculate commitment amount:
  // purchase_amount × SaaC_fee_rate × 50% liquidity split
  const feeRate = SAAC_FEE_RATES[source] || SAAC_FEE_RATES.beacon;
  const commitmentUsd = purchaseAmountUsd * feeRate * LIQUIDITY_SPLIT;

  // Convert to USDC units (6 decimals)
  const commitmentUsdc = Math.floor(commitmentUsd * 1_000_000);

  if (commitmentUsdc === 0) {
    return {
      status: 'skipped',
      reason: 'Commitment amount too small',
      commitment_usd: commitmentUsd
    };
  }

  // Normalize tx_hash to bytes32
  const txHashBytes32 = txHash.startsWith('0x') ? txHash : `0x${txHash}`;

  // ── Create viem clients ──
  const account = privateKeyToAccount(privateKey);

  // Detect chain from RPC URL
  const chain = rpcUrl.includes('sepolia') ? baseSepolia : base;

  const walletClient = createWalletClient({
    account,
    chain,
    transport: http(rpcUrl)
  });

  const publicClient = createPublicClient({
    chain,
    transport: http(rpcUrl)
  });

  // ── Send commitFromTransaction tx ──
  const hash = await walletClient.writeContract({
    address: contractAddress,
    abi: COMMITMENT_ABI,
    functionName: 'commitFromTransaction',
    args: [BigInt(commitmentUsdc), txHashBytes32]
  });

  // Wait for confirmation (1 block)
  const receipt = await publicClient.waitForTransactionReceipt({ hash });

  // ── Read updated stats ──
  const stats = await publicClient.readContract({
    address: contractAddress,
    abi: COMMITMENT_ABI,
    functionName: 'getCommitmentStats'
  });

  const [totalUsdcCommitted, totalLpTokensHeld, currentPoolDepth, commitmentRate, transactionCount, lastCommitmentTimestamp] = stats;

  // ── Read lock status ──
  const lockStatus = await publicClient.readContract({
    address: contractAddress,
    abi: COMMITMENT_ABI,
    functionName: 'getLockStatus'
  });

  const [lockExpiry, lockRemaining, isLocked, extCount, withdrawAddr] = lockStatus;

  return {
    status: 'committed',
    commitment_contract: contractAddress,
    commitment_usd: commitmentUsd,
    commitment_usdc: commitmentUsdc,
    commitment_tx_hash: hash,
    block_number: Number(receipt.blockNumber),
    total_usdc_committed: Number(totalUsdcCommitted),
    total_lp_tokens: Number(totalLpTokensHeld),
    pool_depth_usdc: Number(currentPoolDepth),
    commitment_rate: (Number(commitmentRate) / 10000).toString(),
    tx_count: Number(transactionCount),
    // Lock status (new in v2)
    lock_expiry: Number(lockExpiry),
    lock_expiry_date: new Date(Number(lockExpiry) * 1000).toISOString(),
    lock_remaining_seconds: Number(lockRemaining),
    lock_active: isLocked,
    lock_extensions: Number(extCount),
    verifiable_at: `https://basescan.org/address/${contractAddress}`
  };
}

// ============================================================
// BH ADMIN-API HELPERS
// ============================================================

async function lookupMember(email, env) {
  const response = await fetch(
    `${env.BH_SUPABASE_URL}/functions/v1/admin-api`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${env.BH_ANON_KEY}`,
        'x-sync-secret': env.SYNC_SECRET
      },
      body: JSON.stringify({
        action: 'lookup_member_by_email',
        email: email
      })
    }
  );

  if (!response.ok) {
    console.error('Member lookup failed:', response.status);
    return null;
  }

  const data = await response.json();
  return data.member || null;
}

async function creditMember(userId, nctrAmount, lockType, source, merchantId, env) {
  const response = await fetch(
    `${env.BH_SUPABASE_URL}/functions/v1/admin-api`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${env.BH_ANON_KEY}`,
        'x-sync-secret': env.SYNC_SECRET
      },
      body: JSON.stringify({
        action: 'credit_member',
        user_id: userId,
        nctr_amount: nctrAmount,
        lock_type: lockType,
        source: source,
        merchant_id: merchantId,
        note: `Loyalty wrap: ${nctrAmount} NCTR via ${source}`
      })
    }
  );

  if (!response.ok) {
    const errText = await response.text();
    return { success: false, error: errText };
  }

  const data = await response.json();
  return {
    success: true,
    new_balance: data.new_balance || 0
  };
}

// ============================================================
// GET /loyalty/stats — Public liquidity statistics
// ============================================================

async function handleStats(env) {
  const contractAddress = env.COMMITMENT_CONTRACT_ADDRESS;
  const rpcUrl = env.BASE_RPC_URL || 'https://mainnet.base.org';

  let onChainStats = null;
  let lockInfo = null;

  if (contractAddress) {
    try {
      const chain = rpcUrl.includes('sepolia') ? baseSepolia : base;
      const publicClient = createPublicClient({
        chain,
        transport: http(rpcUrl)
      });

      const stats = await publicClient.readContract({
        address: contractAddress,
        abi: COMMITMENT_ABI,
        functionName: 'getCommitmentStats'
      });

      const [totalUsdcCommitted, totalLpTokensHeld, currentPoolDepth, commitmentRate, transactionCount, lastCommitmentTimestamp] = stats;

      // total_usdc_committed / total_lp_tokens_held / pool_depth_usdc are
      // deliberately NOT surfaced. They are raw base-unit integers — USDC
      // carries 6 decimals, so the contract's 260000 is 0.26 USDC, and
      // publishing it unscaled overstated committed liquidity by 1e6.
      // Rescaling is not the fix: committed liquidity amounts stay out of
      // public responses entirely. What is publishable is that commitments
      // exist, when the last one landed, and how long the lock runs.
      // commitment_rate_bps is also withheld: a routing rate is a mechanism
      // detail, and disclosure canon keeps rates and splits out of public copy.
      onChainStats = {
        transaction_count: Number(transactionCount),
        last_commitment: Number(lastCommitmentTimestamp)
      };

      // Read lock status
      const lockData = await publicClient.readContract({
        address: contractAddress,
        abi: COMMITMENT_ABI,
        functionName: 'getLockStatus'
      });

      const [lockExpiry, lockRemaining, isLocked, extCount, withdrawAddr] = lockData;

      // withdrawal_address is withheld: it is the ops wallet, and publishing it
      // in machine-readable form hands an analyst a starting point rather than
      // leaving it to be found. The lock itself is the publishable asset.
      lockInfo = {
        expiry: Number(lockExpiry),
        expiry_date: new Date(Number(lockExpiry) * 1000).toISOString(),
        remaining_seconds: Number(lockRemaining),
        remaining_days: Math.floor(Number(lockRemaining) / 86400),
        active: isLocked,
        extensions: Number(extCount)
      };
    } catch (err) {
      console.error('Failed to read on-chain data:', err.message);
    }
  }

  return jsonResponse({
    service: 'NCTR Loyalty Layer',
    description: 'Verifiable liquidity backing for the NCTR participation economy',
    commitment_contract: contractAddress || 'not_deployed',
    on_chain: onChainStats,
    lock: lockInfo,
    tracks: {
      track_1: 'Traditional commerce — 90-day settlement hold, database credit',
      track_2: 'x402 agent-native — on-chain delivery, liquidity proof'
    },
    verifiable_at: contractAddress
      ? `https://basescan.org/address/${contractAddress}`
      : null
  });
}

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

// ============================================================
// GET /loyalty/verify — Verify a commitment on-chain
// ============================================================

async function handleVerify(txHash, env) {
  if (!txHash) {
    return jsonResponse({
      error: 'missing_tx_parameter',
      message: 'Usage: /loyalty/verify?tx=0x… (32-byte transaction hash)'
    }, 400);
  }

  const hash = txHash.startsWith('0x') ? txHash : `0x${txHash}`;

  // Reject malformed input outright. Previously anything non-bytes32 fell
  // through to viem and surfaced as a 500 with the library version attached.
  if (!TX_HASH_PATTERN.test(hash)) {
    return jsonResponse({
      error: 'invalid_tx_hash',
      message: 'tx must be a 32-byte hex transaction hash: 0x followed by 64 hex characters.'
    }, 400);
  }

  const contractAddress = env.COMMITMENT_CONTRACT_ADDRESS;
  const rpcUrl = env.BASE_RPC_URL || 'https://mainnet.base.org';

  if (!contractAddress) {
    return jsonResponse({
      error: 'contract_not_deployed',
      message: 'Commitment contract not deployed yet'
    }, 503);
  }

  const explorer = {
    transaction: `https://basescan.org/tx/${hash}`,
    contract: `https://basescan.org/address/${contractAddress}`
  };

  try {
    const chain = rpcUrl.includes('sepolia') ? baseSepolia : base;
    const publicClient = createPublicClient({
      chain,
      transport: http(rpcUrl)
    });

    // ── Gate 1: the hash must be a real transaction on this chain ──
    //
    // commitFromTransaction() stores whatever bytes32 key it is handed. It does
    // not and cannot check that the key is a genuine transaction hash. So a hit
    // in the contract mapping is NOT on its own proof of anything — the existing
    // records are keyed 0x..01 through 0x..09, which are counters, not hashes.
    // Confirming the transaction actually exists on Base is what makes a
    // positive answer mean something. Without this gate the endpoint affirms
    // any small integer a skeptic types.
    let chainTx = null;
    try {
      chainTx = await publicClient.getTransaction({ hash });
    } catch (_) {
      chainTx = null; // viem throws TransactionNotFoundError rather than returning null
    }

    if (!chainTx) {
      return jsonResponse({
        tx_hash: hash,
        verified: false,
        reason: 'not_a_transaction_on_base',
        record: null,
        contract: contractAddress,
        explorer
      });
    }

    // ── Gate 2: a commitment must be recorded under that same hash ──
    const committed = await publicClient.readContract({
      address: contractAddress,
      abi: COMMITMENT_ABI,
      functionName: 'verifyCommitment',
      args: [hash]
    });

    if (!committed) {
      return jsonResponse({
        tx_hash: hash,
        verified: false,
        reason: 'no_commitment_recorded',
        record: null,
        contract: contractAddress,
        explorer
      });
    }

    const [, , timestamp, exists] = await publicClient.readContract({
      address: contractAddress,
      abi: COMMITMENT_ABI,
      functionName: 'getCommitmentRecord',
      args: [hash]
    });

    // Committed amounts are deliberately omitted — liquidity figures stay out
    // of public responses. Timing and on-chain location are the proof.
    return jsonResponse({
      tx_hash: hash,
      verified: Boolean(exists),
      reason: exists ? null : 'no_commitment_recorded',
      record: exists
        ? {
            timestamp: Number(timestamp),
            committed_at: new Date(Number(timestamp) * 1000).toISOString(),
            block_number: chainTx.blockNumber !== null && chainTx.blockNumber !== undefined
              ? Number(chainTx.blockNumber)
              : null
          }
        : null,
      contract: contractAddress,
      explorer
    });
  } catch (err) {
    console.error('verify failed:', err && err.message);
    // Generic message on purpose: do not echo library internals to callers.
    return jsonResponse({
      error: 'verification_unavailable',
      message: 'Could not reach the chain to verify this transaction. Try again shortly.'
    }, 502);
  }
}

// ============================================================
// GET /loyalty/lock-status — Dedicated lock endpoint
// ============================================================

async function handleLockStatus(env) {
  const contractAddress = env.COMMITMENT_CONTRACT_ADDRESS;
  const rpcUrl = env.BASE_RPC_URL || 'https://mainnet.base.org';

  if (!contractAddress) {
    return jsonResponse({ error: 'Commitment contract not deployed yet' }, 503);
  }

  try {
    const chain = rpcUrl.includes('sepolia') ? baseSepolia : base;
    const publicClient = createPublicClient({
      chain,
      transport: http(rpcUrl)
    });

    const lockData = await publicClient.readContract({
      address: contractAddress,
      abi: COMMITMENT_ABI,
      functionName: 'getLockStatus'
    });

    // withdrawAddr is intentionally destructured-and-dropped: see note below.
    const [lockExpiry, lockRemaining, isLocked, extCount] = lockData;

    // getCommitmentStats() is no longer read here — the only fields it supplied
    // to this response were the withheld liquidity amounts, so the extra RPC
    // round-trip is dead weight.

    // Committed amounts, LP holdings, and the withdrawal address are all
    // withheld here for the same reasons as /loyalty/stats: the amounts are raw
    // base-unit integers that overstate committed liquidity by 1e6 when
    // published unscaled, canon keeps liquidity figures out of public copy
    // entirely, and the withdrawal address is the ops wallet.
    //
    // The lock is the asset worth publishing: it is real, it is long, its
    // duration is a constant in verified source, and rate changes are timelocked.

    return jsonResponse({
      contract: contractAddress,
      lock_expiry: Number(lockExpiry),
      lock_expiry_date: new Date(Number(lockExpiry) * 1000).toISOString(),
      lock_remaining_seconds: Number(lockRemaining),
      lock_remaining_days: Math.floor(Number(lockRemaining) / 86400),
      lock_active: isLocked,
      extension_count: Number(extCount),
      verifiable_at: `https://basescan.org/address/${contractAddress}`,
      note: 'All lock data verifiable on-chain via getLockStatus() and getLockExtensionHistory()'
    });
  } catch (err) {
    console.error('lock-status failed:', err && err.message);
    return jsonResponse({
      error: 'lock_status_unavailable',
      message: 'Could not reach the chain to read lock status. Try again shortly.'
    }, 502);
  }
}

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

// ============================================================
// POST /agent/sessions/create — Proxy to Beacon edge function
// ============================================================

async function handleAgentSessionCreate(request, env) {
  if (!env.BEACON_SUPABASE_URL || !env.BEACON_ANON_KEY) {
    return jsonResponse({ error: 'Beacon not configured' }, 503);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'invalid JSON body' }, 400);
  }

  const slug = typeof body?.slug === 'string' ? body.slug.trim() : '';
  const agentId = typeof body?.agent_id === 'string' ? body.agent_id.trim() : '';
  const agentModel = typeof body?.agent_model === 'string' ? body.agent_model.trim() : '';
  const referrerUrl = typeof body?.referrer_url === 'string' ? body.referrer_url.trim() : '';
  const productHandle = typeof body?.product_handle === 'string' ? body.product_handle.trim() : '';

  if (!slug) return jsonResponse({ error: 'slug required' }, 400);
  if (!agentId) return jsonResponse({ error: 'agent_id required' }, 400);
  if (agentId.length > 100) return jsonResponse({ error: 'agent_id too long' }, 400);
  if (agentModel && agentModel.length > 100) return jsonResponse({ error: 'agent_model too long' }, 400);
  if (referrerUrl) {
    if (referrerUrl.length > 2048 || !isValidUrl(referrerUrl)) {
      return jsonResponse({ error: 'invalid referrer_url' }, 400);
    }
  }
  if (productHandle && productHandle.length > 200) {
    return jsonResponse({ error: 'product_handle too long' }, 400);
  }

  const forwardBody = { slug, agent_id: agentId };
  if (agentModel) forwardBody.agent_model = agentModel;
  if (referrerUrl) forwardBody.referrer_url = referrerUrl;
  if (productHandle) forwardBody.product_handle = productHandle;

  let upstream;
  try {
    upstream = await fetch(
      `${env.BEACON_SUPABASE_URL}/functions/v1/agent-session-create`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.BEACON_ANON_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(forwardBody)
      }
    );
  } catch (err) {
    console.error('handleAgentSessionCreate fetch error:', err);
    return jsonResponse({ error: 'upstream error' }, 502);
  }

  const upstreamBody = await upstream.text();
  return new Response(upstreamBody, {
    status: upstream.status,
    headers: CORS_HEADERS
  });
}

// ============================================================
// GET /agent/sessions/:session_token — Proxy to Beacon edge function
// ============================================================

async function handleAgentSessionLookup(sessionToken, env) {
  if (!env.BEACON_SUPABASE_URL || !env.BEACON_ANON_KEY) {
    return jsonResponse({ error: 'Beacon not configured' }, 503);
  }

  if (typeof sessionToken !== 'string' || sessionToken.length !== 32 || !sessionToken.startsWith('nctr_sess_')) {
    return jsonResponse({ error: 'invalid session_token format' }, 400);
  }

  let upstream;
  try {
    upstream = await fetch(
      `${env.BEACON_SUPABASE_URL}/functions/v1/agent-session-lookup?token=${encodeURIComponent(sessionToken)}`,
      {
        headers: {
          Authorization: `Bearer ${env.BEACON_ANON_KEY}`
        }
      }
    );
  } catch (err) {
    console.error('handleAgentSessionLookup fetch error:', err);
    return jsonResponse({ error: 'upstream error' }, 502);
  }

  const upstreamBody = await upstream.text();
  return new Response(upstreamBody, {
    status: upstream.status,
    headers: { ...CORS_HEADERS, 'Cache-Control': 'private, max-age=10' }
  });
}

// ============================================================
// UTILITY
// ============================================================

// Describes a lock_type for member-facing output.
//
// The WIRE VALUE sent to BH is unchanged — BH's schema expects '90LOCK'/'360LOCK'
// and that contract is not ours to break. What changes is how it is DESCRIBED to
// the caller. A 90-day hold is a refund-window mechanism sized to the chargeback
// period; calling it "90LOCK" made it read as a sibling of 360LOCK, competing
// with the commitment tier that actually determines Crescendo status. It is not
// a tier and it does not affect status.
function describeSettlement(lockType) {
  const key = String(lockType || '').toLowerCase();

  if (key === 'none') {
    return {
      type: 'immediate',
      hold_days: 0,
      affects_status: false,
      description: 'Settles immediately. Agent-native transactions carry no refund window.'
    };
  }

  if (key === '360lock') {
    return {
      type: 'commitment',
      hold_days: 360,
      affects_status: true,
      description: '360LOCK — a Crescendo commitment. Committed NCTR counts toward Crescendo status.'
    };
  }

  return {
    type: 'settlement_hold',
    hold_days: 90,
    affects_status: false,
    description: 'Settlement hold. Earned NCTR settles after a 90-day window matching the card refund period. This is a settlement hold, not a Crescendo commitment, and it does not affect status.'
  };
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: CORS_HEADERS
  });
}

function isValidUrl(s) {
  try {
    new URL(s);
    return true;
  } catch {
    return false;
  }
}
