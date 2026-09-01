import { createPublicClient, http } from 'viem';
import { base, baseSepolia } from 'viem/chains';
import { jsonResponse } from '../lib/http.js';
import { COMMITMENT_ABI } from './contract.js';

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

export { handleStats };
