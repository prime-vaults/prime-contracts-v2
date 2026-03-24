# PrimeVaults V3 — MVP Implementation Plan

**Purpose:** Step-by-step coding guide cho Claude Code  
**Stack:** Solidity 0.8.24, Hardhat, Viem, OpenZeppelin  
**Network:** Arbitrum  
**Strategy:** sUSDai (USD.AI) — ERC-4626 deposit + ERC-7540 async FIFO redeem  
**Scope:** MVP — 1 market (sUSDai), fixed 8:2 WETH ratio, coverage gates

---

## Phase Overview

```
Phase 1: Project Setup                    (Step 1-2)
Phase 2: Interfaces                       (Step 3)
Phase 3: Core — bottom up                 (Step 4-8)
Phase 4: Junior WETH Buffer               (Step 9-11)
Phase 5: Cooldown System                  (Step 12-16)
Phase 6: Strategy (sUSDai)                (Step 17-18)
Phase 7: Integration — PrimeCDO           (Step 19)
Phase 8: Vault                            (Step 20)
Phase 9: Periphery                        (Step 21)
Phase 10: Unit Tests                      (Step 22-28)
Phase 11: Integration Tests               (Step 29-30)
Phase 12: Deployment Scripts              (Step 31-32)
```

---

## IMPORTANT: Coding Conventions

Every step below MUST follow `docs/CONVENTIONS.md`. Key rules:

- **Naming:** `i_` immutable, `s_` storage, `UPPER_SNAKE` constants, `_prefix` internal functions
- **Formatting:** 120 char lines, horizontal priority, `═══` section separators
- **NatSpec:** `@notice` + `@dev` + `@param` + `@return` on every external/public function
- **Errors:** `PrimeVaults__ErrorName(params)`, no `require` strings
- **Imports:** OpenZeppelin → external libs → interfaces → internal contracts

---

## Phase 1: Project Setup

### Step 1 — Init project

```bash
mkdir primevaults-v3 && cd primevaults-v3
npx hardhat init  # TypeScript

npm install --save-dev \
  @nomicfoundation/hardhat-toolbox \
  @openzeppelin/contracts@5.1.0 \
  hardhat-gas-reporter solidity-coverage
npm install viem
```

### Step 2 — Configure hardhat

```
hardhat.config.ts:
  solidity: "0.8.24", optimizer: runs 200
  networks: hardhat (fork Arbitrum), arbitrum (deployment)
```

Folder structure:

```
contracts/
├── interfaces/
├── core/
├── junior/
├── cooldown/
├── strategies/implementations/cooldown/
├── oracles/providers/
├── governance/
└── periphery/
test/unit/ test/integration/ test/helpers/mocks/
deploy/ scripts/
```

---

## Phase 2: Interfaces

### Step 3 — All interfaces

3a. `IStrategy.sol` — WithdrawType enum, WithdrawResult struct, deposit/withdraw/totalAssets
3b. `ICooldownHandler.sol` — CooldownStatus enum, CooldownRequest struct, request/claim
3c. `ICooldownRequestImpl.sol` — initiateCooldown/finalizeCooldown/isCooldownComplete
3d. `IAprPairFeed.sol` — IStrategyAprPairProvider (getAprPair + getAprPairView), IAprPairFeed (TRound, latestRoundData, getRoundData). int64 × 12 decimals.
3e. `IStakedUSDai.sol` — sUSDai interface verified from Arbiscan ABI. Redemption struct with redemptionTimestamp. requestRedeem, redemption, claimableRedeemRequest, redeem, redemptionIds, serviceRedemptions.
3f. `IRatioController.sol` — interface only, NOT implemented in MVP
3g. `IPrimeCDO.sol` — TrancheId enum, CDOWithdrawResult struct
3h. `IAccounting.sol` — updateTVL, recordDeposit/Withdraw, getTrancheTVL
3i. `IAaveWETHAdapter.sol` — supply/withdraw/totalAssets
3j. `ISwapFacility.sol` — swapWETHFor/swapForWETH
3k. `IWETHPriceOracle.sol` — getWETHPrice()

---

## Phase 3: Core — Bottom Up

### Step 4 — `RiskParams.sol`

PremiumCurve structs, alpha, reserveBps. Ownable2Step. Validation.

### Step 5 — APR Oracle (2 contracts)

See `docs/PV_V3_APR_ORACLE.md`.

5a. `SUSDaiAprPairProvider.sol` — 1 provider = both APRs. Aave weighted avg + sUSDai snapshot growth. getAprPair (mutate) + getAprPairView (view). benchmarkTokens[], bounds, clamp.

5b. `AprPairFeed.sol` — PULL only, KEEPER_ROLE. 20-round buffer with oldestRoundId. Bounds [-50%, +200%]. Cache + provider view fallback.

### Step 7 — `Accounting.sol`

Gain splitting, loss waterfall, Senior APR computation. Reads APR from AprPairFeed.latestRoundData(). Convert int64×12dec → uint256×18dec.

### Step 8 — `FixedPointMath.sol`

fpow, fpMul, fpDiv. Use PRBMath.

---

## Phase 4: Junior WETH Buffer

### Step 9 — `WETHPriceOracle.sol`

Chainlink spot only (MVP). No TWAP buffer, no keeper, no recordPrice(). Staleness check 1 hour. Chainlink Arbitrum ETH/USD: `0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612`.

### Step 10 — `AaveWETHAdapter.sol`

Supply/withdraw WETH to Aave v3 Arbitrum. onlyCDO.

### Step 11 — `SwapFacility.sol`

Uniswap V3 Arbitrum swaps. onlyCDO. Configurable slippage.

---

## Phase 5: Cooldown System

### Step 12 — `ERC20Cooldown.sol`

Lock ERC-20 tokens for cooldown period.

### Step 13 — `UnstakeCooldown.sol`

Delegates to ICooldownRequestImpl. Mapping: yieldToken → impl.

### Step 14 — `SharesCooldown.sol`

Lock vault shares. Claim returns shares at CURRENT rate.

### Step 15 — `RedemptionPolicy.sol`

Coverage-based mechanism selection: (CooldownType, duration, feeBps) per coverage range.

### Step 16 — `SUSDaiCooldownRequestImpl.sol`

Wraps sUSDai ERC-7540 FIFO queue.

- requestRedeem → redemptionId → read redemptionTimestamp (EXACT)
- claimableRedeemRequest > 0 = ready (source of truth)
- No s_unstakeDuration, no hardcoded 7 days
- Maps cooldownId → sUSDai redemptionId

---

## Phase 6: Strategy

### Step 17 — `BaseStrategy.sol`

Abstract base. onlyCDO, Pausable. Routing to cooldown contracts.

### Step 18 — `SUSDaiStrategy.sol`

- deposit: USDai → sUSDai.deposit()
- withdraw sUSDai: INSTANT
- withdraw USDai: UNSTAKE via CooldownRequestImpl (ERC-7540 FIFO)
- totalAssets: convertToAssets(s_totalShares - s_pendingRedeemShares)
- unlockTime from sUSDai.redemption(id).redemptionTimestamp

---

## Phase 7-8: PrimeCDO + TrancheVault

### Step 19 — `PrimeCDO.sol`

Orchestrator. Build incrementally: helpers → deposits → withdrawals → loss → rebalance → admin.

### Step 20 — `TrancheVault.sol`

1 bytecode, deploy 3x. ERC-4626. totalAssets from Accounting via TrancheId.

---

## Phase 9: Periphery

### Step 21 — `PrimeLens.sol`

Read-only aggregator for frontend.

---

## Phase 10-11: Tests

### Steps 22-28 — Unit tests

All mocks use Arbitrum interfaces. MockStakedUSDai simulates FIFO queue.

### Steps 29-30 — Integration tests (Arbitrum fork)

Fork Arbitrum mainnet. Impersonate sUSDai admin for serviceRedemptions().

---

## Phase 12: Deployment

### Steps 31-32 — Deploy + verify

Target: Arbitrum. Grant KEEPER_ROLE. No manual APR override needed (PULL-only).

---

## Arbitrum Addresses

```
sUSDai:            0x0B2b2B2076d95dda7817e785989fE353fe955ef9
USDai:             0x0A1a1A107E45b7Ced86833863f482BC5f4ed82EF
Aave v3 Pool:      0x794a61358D6845594F94dc1DB02A252b5b4814aD
USDC:              0xaf88d065e77c8cC2239327C5EDb3A432268e5831
USDT:              0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9
WETH:              0x82aF49447D8a07e3bd95BD0d56f35241523fBab1
Chainlink ETH/USD: 0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612
Uniswap V3 Router: 0xE592427A0AEce92De3Edee1F18E0157C05861564
```

---

## Key Decisions

```
[D1]  Network: Arbitrum
[D2]  1 CDO = 1 Strategy (market isolation)
[D3]  Fixed 8:2 WETH ratio with upgrade hook
[D4]  APR Oracle: PULL only, trustless
[D5]  APR Oracle: Strata-inherited (20 rounds, bounds, int64×12dec)
[D6]  APR Provider: snapshot-based (sUSDai no vesting API)
[D7]  APR Provider: getAprPair (mutate) + getAprPairView (view)
[D8]  WETHPriceOracle: Chainlink spot only (no TWAP)
[D9]  sUSDai: FIFO redemption queue, not fixed cooldown
[D10] unlockTime from sUSDai.redemption(id).redemptionTimestamp
[D11] isCooldownComplete = claimableRedeemRequest > 0
[D12] No s_unstakeDuration, no hardcoded 7 days
[D13] Asymmetric rebalance: sell permissionless, buy governance
[D14] Coverage gates: 105% thresholds
[D15] Accounting uses TrancheId, not vault addresses
```

---

_PrimeVaults V3 — MVP Implementation Plan v3.5.0_  
_Arbitrum • sUSDai • PULL-only APR • Chainlink spot • FIFO redeem_  
_March 2026_
