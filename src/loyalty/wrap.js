import { jsonResponse } from '../lib/http.js';
import { TIERS, NCTR_PER_DOLLAR } from '../config.js';
import { describeSettlement } from './settlement.js';
import { commitLiquidity } from './chain.js';
import { lookupMember, creditMember } from './members.js';

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

export { handleWrap };
