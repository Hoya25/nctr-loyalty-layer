import { parseAbi } from 'viem';

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

export { VERIFY_ENDPOINT_ENABLED, TX_HASH_PATTERN, COMMITMENT_ABI };
