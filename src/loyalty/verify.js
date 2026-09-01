import { createPublicClient, http } from 'viem';
import { base, baseSepolia } from 'viem/chains';
import { jsonResponse } from '../lib/http.js';
import { COMMITMENT_ABI, TX_HASH_PATTERN } from './contract.js';

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

export { handleVerify };
