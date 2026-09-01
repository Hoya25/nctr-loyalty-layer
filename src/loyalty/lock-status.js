import { createPublicClient, http } from 'viem';
import { base, baseSepolia } from 'viem/chains';
import { jsonResponse } from '../lib/http.js';
import { COMMITMENT_ABI } from './contract.js';

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

export { handleLockStatus };
