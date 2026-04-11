# Worker v2.1 Deployment Instructions
## 24-Month Verifiable Lockup Edition

## What Changed from v2.0
1. **New endpoint: `/loyalty/lock-status`** — Dedicated lock expiry and extension data
2. **`getLockStatus()` ABI** added — reads lock expiry, remaining time, extension count, withdrawal address
3. **Lock fields in responses** — `/loyalty/wrap` Track 2, `/loyalty/stats`, and new `/loyalty/lock-status` all surface lock data
4. **24-month language** — "permanent" replaced with "24-month verifiable lockup with rolling extensions"
5. **`lock_model` field** in `/loyalty/tiers` response
6. **Version bumped to 2.1.0**

## What Changed from v1 (carried from v2.0)
1. **viem** replaces all manual ABI encoding and RPC calls
2. **Real transaction signing** — no more simulation stub
3. **Merchant lock_type override** — x402 defaults to `none`, merchants can set `90LOCK` or `360LOCK`
4. **Better /loyalty/verify** — returns full commitment record, not just boolean
5. **Better /loyalty/tiers** — includes monthly fees and fee split info
6. **Chain auto-detection** — reads RPC URL to pick Base vs Sepolia

## Step-by-Step Deployment

### 1. Add viem to the Worker project

```bash
cd ~/Desktop/nctr-loyalty-worker
npm install viem
```

### 2. Replace the Worker code

```bash
# Back up current code
cp src/index.js src/index.js.bak

# Replace with new code (copy the v2.1 index.js into place)
cp /path/to/new/index.js src/index.js
```

### 3. Add new secrets

```bash
cd ~/Desktop/nctr-loyalty-worker

# Contract address (after deploying v2 contract to Sepolia/mainnet)
npx wrangler secret put COMMITMENT_CONTRACT_ADDRESS
# Paste: the deployed contract address (7-param constructor version)

# Worker wallet private key (for signing commitment txns)
npx wrangler secret put WORKER_PRIVATE_KEY
# Paste: 0x... private key (this wallet needs USDC for commitments)

# Base RPC URL
npx wrangler secret put BASE_RPC_URL
# Paste: https://sepolia.base.org (for testing)
# Later: https://mainnet.base.org (for production)
```

### 4. Deploy

```bash
cd ~/Desktop/nctr-loyalty-worker && npx wrangler deploy
```

### 5. Verify health + basic endpoints

```bash
# Health check (expect version: 2.1.0)
curl https://api.nctr.live/health

# Check tiers (expect lock_model field)
curl https://api.nctr.live/loyalty/tiers

# Check stats (expect lock object after contract deployed)
curl https://api.nctr.live/loyalty/stats

# Check lock status (new in v2.1)
curl https://api.nctr.live/loyalty/lock-status
# Expected: lock_active: true, remaining_days: ~730
```

### 6. Test /loyalty/wrap (Track 1 — no on-chain)

```bash
curl -X POST https://api.nctr.live/loyalty/wrap \
  -H "Content-Type: application/json" \
  -d '{
    "member_email": "bellanderson@gmail.com",
    "purchase_amount_usd": 50,
    "source": "beacon",
    "merchant_id": "nctr-merch"
  }'
```

### 7. Test /loyalty/wrap (Track 2 — with on-chain commitment + lock proof)

```bash
curl -X POST https://api.nctr.live/loyalty/wrap \
  -H "Content-Type: application/json" \
  -d '{
    "member_email": "bellanderson@gmail.com",
    "purchase_amount_usd": 100,
    "source": "x402",
    "merchant_id": "test-merchant",
    "tx_hash": "0xabc123..."
  }'
# Expected: liquidity_proof includes lock_expiry, lock_active, lock_extensions
```

## Pre-requisites for On-Chain Commitment

Before Track 2 works end-to-end:

1. **Deploy NCTRLiquidityCommitment.sol v2** (7-param constructor via Foundry script)
   - Constructor: `(router, nctrToken, usdcToken, pool, initialRate, caller, withdrawTo)`
   - The 7th param `_withdrawTo` is the designated LP withdrawal address after lock expiry
   - Add to .env: `WITHDRAWAL_ADDRESS=0x921D9D535DE02618BaB75B309e46207C735c17BC`

2. **Set COMMITMENT_CONTRACT_ADDRESS** secret to deployed address

3. **Fund contract with NCTR** via `fundNctrReserves()` from ops wallet

4. **Approve USDC** from Worker wallet to contract:
   ```bash
   # Sepolia USDC
   cast send 0x036CbD53842c5426634e7929541eC2318f3dCF7e \
     "approve(address,uint256)" \
     $CONTRACT_ADDRESS \
     115792089237316195423570985008687907853269984665640564039457584007913129639935 \
     --private-key $WORKER_PRIVATE_KEY \
     --rpc-url https://sepolia.base.org

   # Mainnet USDC (when ready)
   cast send 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 \
     "approve(address,uint256)" \
     $CONTRACT_ADDRESS \
     115792089237316195423570985008687907853269984665640564039457584007913129639935 \
     --private-key $WORKER_PRIVATE_KEY \
     --rpc-url https://mainnet.base.org
   ```

5. **Fund Worker wallet** with small amount of ETH (for gas) and USDC (for commitments)

## Contract Verification (Basescan)

After deploying, verify with the 7-param constructor encoding:

```bash
forge verify-contract $CONTRACT_ADDRESS \
  src/NCTRLiquidityCommitment.sol:NCTRLiquidityCommitment \
  --constructor-args $(cast abi-encode \
    "constructor(address,address,address,address,uint256,address,address)" \
    0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43 \
    0x973104fAa7F2B11787557e85953ECA6B4e262328 \
    0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 \
    0x3bb64b23b0a1a5e510f67b0cc1ab0c2f6dc84dd8 \
    500 \
    $CALLER_ADDRESS \
    0x921D9D535DE02618BaB75B309e46207C735c17BC) \
  --etherscan-api-key $BASESCAN_API_KEY \
  --chain base
```

## API Endpoints Summary (v2.1)

| Endpoint | Method | Description |
|---|---|---|
| `/health` | GET | Health check (version 2.1.0) |
| `/loyalty/tiers` | GET | Three-tier pricing with lock_model |
| `/loyalty/stats` | GET | On-chain stats + lock info |
| `/loyalty/lock-status` | GET | Dedicated lock expiry endpoint |
| `/loyalty/verify?tx=0x...` | GET | Verify a commitment on-chain |
| `/loyalty/wrap` | POST | Issue NCTR + optional liquidity commitment |
