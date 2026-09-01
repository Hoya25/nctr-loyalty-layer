import { createWalletClient, createPublicClient, http, encodeFunctionData } from 'viem';
import { base, baseSepolia } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { SAAC_FEE_RATES, LIQUIDITY_SPLIT } from '../config.js';
import { COMMITMENT_ABI } from './contract.js';

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

export { commitLiquidity };
