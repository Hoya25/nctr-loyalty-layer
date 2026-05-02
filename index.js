/**
 * NCTR Loyalty Layer — Cloudflare Worker
 * api.nctr.live
 *
 * Handles two commerce tracks:
 *   Track 1 (traditional): 90LOCK, database credit, no on-chain action
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

const TIERS = {
  Bronze:   { multiplier: 1.0,  label: 'Bronze' },
  Silver:   { multiplier: 1.25, label: 'Silver' },
  Gold:     { multiplier: 1.5,  label: 'Gold' },
  Platinum: { multiplier: 1.8,  label: 'Platinum' },
  Diamond:  { multiplier: 2.5,  label: 'Diamond' }
};

// NCTR earned per dollar of purchase (base rate before tier multiplier)
const NCTR_PER_DOLLAR = 2.5;

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
        return handleTiers();
      }

      if (path === '/loyalty/stats') {
        return await handleStats(env);
      }

      if (path === '/loyalty/lock-status') {
        return await handleLockStatus(env);
      }

      if (path === '/loyalty/verify') {
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
    lock_type: effectiveLockType,
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
      lock_type: effectiveLockType,
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

      onChainStats = {
        total_usdc_committed: Number(totalUsdcCommitted),
        total_lp_tokens_held: Number(totalLpTokensHeld),
        pool_depth_usdc: Number(currentPoolDepth),
        commitment_rate_bps: Number(commitmentRate),
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

      lockInfo = {
        expiry: Number(lockExpiry),
        expiry_date: new Date(Number(lockExpiry) * 1000).toISOString(),
        remaining_seconds: Number(lockRemaining),
        remaining_days: Math.floor(Number(lockRemaining) / 86400),
        active: isLocked,
        extensions: Number(extCount),
        withdrawal_address: withdrawAddr
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
      track_1: 'Traditional commerce — 90LOCK, database credit',
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

function handleTiers() {
  return jsonResponse({
    tiers: [
      {
        name: 'Tier 1 — Beacon / Shopify',
        source: 'beacon',
        monthly_fee: '$99',
        per_tx_fee: '1%',
        description: 'Full Shopify integration with webhooks, reserve system, and bounty dashboard'
      },
      {
        name: 'Tier 2 — API Integration',
        source: 'api',
        monthly_fee: '$29',
        per_tx_fee: '1.5%',
        description: 'Direct API integration — works with any platform'
      },
      {
        name: 'Tier 3 — Agent-Native x402',
        source: 'x402',
        monthly_fee: '$0',
        per_tx_fee: '2%',
        description: 'Zero-friction agent-native transactions with verifiable on-chain liquidity proof'
      }
    ],
    fee_split: {
      monthly: '50% brand 360LOCK / 50% treasury',
      per_tx: '50% 24-month locked liquidity / 50% treasury'
    },
    nctr_per_dollar: NCTR_PER_DOLLAR,
    crescendo_tiers: Object.entries(TIERS).map(([key, val]) => ({
      name: val.label,
      multiplier: val.multiplier
    })),
    lock_model: '24-month verifiable lockup with rolling extensions',
    note: 'Merchants set their own bounty rate. Higher bounties attract more agent traffic.'
  });
}

// ============================================================
// GET /loyalty/verify — Verify a commitment on-chain
// ============================================================

async function handleVerify(txHash, env) {
  if (!txHash) {
    return jsonResponse({
      error: 'Missing tx parameter. Usage: /loyalty/verify?tx=0x...'
    }, 400);
  }

  const contractAddress = env.COMMITMENT_CONTRACT_ADDRESS;
  const rpcUrl = env.BASE_RPC_URL || 'https://mainnet.base.org';

  if (!contractAddress) {
    return jsonResponse({
      error: 'Commitment contract not deployed yet'
    }, 503);
  }

  try {
    const chain = rpcUrl.includes('sepolia') ? baseSepolia : base;
    const publicClient = createPublicClient({
      chain,
      transport: http(rpcUrl)
    });

    const txHashBytes32 = txHash.startsWith('0x') ? txHash : `0x${txHash}`;

    // Check if commitment exists
    const verified = await publicClient.readContract({
      address: contractAddress,
      abi: COMMITMENT_ABI,
      functionName: 'verifyCommitment',
      args: [txHashBytes32]
    });

    let record = null;
    if (verified) {
      const [usdcAmount, lpTokensReceived, timestamp, exists] = await publicClient.readContract({
        address: contractAddress,
        abi: COMMITMENT_ABI,
        functionName: 'getCommitmentRecord',
        args: [txHashBytes32]
      });

      record = {
        usdc_committed: Number(usdcAmount),
        lp_tokens_received: Number(lpTokensReceived),
        timestamp: Number(timestamp),
        committed_at: new Date(Number(timestamp) * 1000).toISOString()
      };
    }

    return jsonResponse({
      tx_hash: txHash,
      verified: verified,
      record: record,
      contract: contractAddress,
      explorer: `https://basescan.org/address/${contractAddress}`
    });
  } catch (err) {
    return jsonResponse({
      error: 'Verification failed',
      message: err.message
    }, 500);
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

    const [lockExpiry, lockRemaining, isLocked, extCount, withdrawAddr] = lockData;

    const stats = await publicClient.readContract({
      address: contractAddress,
      abi: COMMITMENT_ABI,
      functionName: 'getCommitmentStats'
    });

    const [totalUsdcCommitted, totalLpTokensHeld] = stats;

    return jsonResponse({
      contract: contractAddress,
      lock_expiry: Number(lockExpiry),
      lock_expiry_date: new Date(Number(lockExpiry) * 1000).toISOString(),
      lock_remaining_seconds: Number(lockRemaining),
      lock_remaining_days: Math.floor(Number(lockRemaining) / 86400),
      lock_active: isLocked,
      extension_count: Number(extCount),
      withdrawal_address: withdrawAddr,
      lp_tokens_held: Number(totalLpTokensHeld),
      total_usdc_committed: Number(totalUsdcCommitted),
      verifiable_at: `https://basescan.org/address/${contractAddress}`,
      note: 'All lock data verifiable on-chain via getLockStatus() and getLockExtensionHistory()'
    });
  } catch (err) {
    return jsonResponse({ error: 'Failed to read lock status', message: err.message }, 500);
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
// UTILITY
// ============================================================

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: CORS_HEADERS
  });
}
