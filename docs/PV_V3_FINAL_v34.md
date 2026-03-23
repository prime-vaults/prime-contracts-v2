# PrimeVaults V3 — Complete Technical Documentation

**Version:** 3.4.0  
**Network:** Ethereum Mainnet  
**Design reference:** Strata Protocol (contracts-tranches)  
**Last updated:** March 2026

---

## Table of Contents

**Part I — System Overview**
1. [Protocol Summary](#1-protocol-summary)
2. [Market Model: 1 CDO = 1 Strategy](#2-market-model-1-cdo--1-strategy)
3. [Architecture Map](#3-architecture-map)
4. [Module Dependency Graph](#4-module-dependency-graph)

**Part II — Mathematical Model**
5. [Variable Definitions](#5-variable-definitions)
6. [APR Calculation Pipeline](#6-apr-calculation-pipeline)
7. [Junior Yield Aggregation (3 Streams)](#7-junior-yield-aggregation-3-streams)
8. [Gain Splitting Algorithm](#8-gain-splitting-algorithm)
9. [Loss Waterfall (4-Layer with WETH)](#9-loss-waterfall-4-layer-with-weth)
10. [Risk Premium Curves (RP1, RP2)](#10-risk-premium-curves-rp1-rp2)
11. [WETH Ratio — Fixed 8:2 with Upgrade Hook](#11-weth-ratio--fixed-82-with-upgrade-hook)
12. [Asymmetric Rebalance](#12-asymmetric-rebalance)
13. [Self-Balancing Mechanism](#13-self-balancing-mechanism)
14. [Numerical Examples](#14-numerical-examples)

**Part III — Core Contracts**
15. [IStrategy Interface](#15-istrategy-interface)
16. [BaseStrategy](#16-basestrategy)
17. [Accounting (Dual-Asset)](#17-accounting-dual-asset)
18. [PrimeCDO (1:1 with Strategy)](#18-primecdo-11-with-strategy)
19. [TrancheVault (Generic + Junior Mode)](#19-tranchevault-generic--junior-mode)

**Part IV — Junior WETH Buffer System**
20. [AaveWETHAdapter](#20-aavewethadapter)
21. [SwapFacility](#21-swapfacility)
22. [WETHPriceOracle](#22-wethpriceoracle)

**Part V — Cooldown Withdrawal System**
23. [Cooldown Design Overview](#23-cooldown-design-overview)
24. [ICooldownHandler Interface](#24-icooldownhandler-interface)
25. [ERC20Cooldown (AssetsLock)](#25-erc20cooldown-assetslock)
26. [UnstakeCooldown & ICooldownRequestImpl](#26-unstakecooldown--icooldownrequestimpl)
27. [SharesCooldown (SharesLock)](#27-sharescooldown-shareslock)
28. [RedemptionPolicy (Coverage-Aware)](#28-redemptionpolicy-coverage-aware)

**Part VI — Oracle & Governance**
29. [IAprFeed & AprPairFeed](#29-iaprfeed--aprpairfeed)
30. [RiskParams](#30-riskparams)
31. [PrimeGovernor & Access Control](#31-primegovernor--access-control)

**Part VII — Strategy Implementations & Benchmark**
32. [SUSDeStrategy (Ethena) — Full Benchmark](#32-susdestrategy-ethena--full-benchmark)
33. [SUSDaiStrategy (USD.AI) — Full Benchmark](#33-susdaistrategy-usdai--full-benchmark)
34. [Strategy Comparison Matrix](#34-strategy-comparison-matrix)
35. [Launching a New Market — Cookbook](#35-launching-a-new-market--cookbook)

**Part VIII — Data Flow Diagrams**
36. [Deposit Flow — Senior/Mezz](#36-deposit-flow--seniormezz)
37. [Deposit Flow — Junior (Dual-Asset)](#37-deposit-flow--junior-dual-asset)
38. [Yield Accrual Flow](#38-yield-accrual-flow)
39. [Withdrawal — Instant](#39-withdrawal--instant)
40. [Withdrawal — AssetsLock / UnstakeCooldown](#40-withdrawal--assetslock--unstakecooldown)
41. [Withdrawal — SharesLock](#41-withdrawal--shareslock)
42. [Withdrawal — Junior (Base + WETH)](#42-withdrawal--junior-base--weth)
43. [Loss Coverage — WETH Swap Flow](#43-loss-coverage--weth-swap-flow)
44. [Rebalance — Asymmetric (Sell Only)](#44-rebalance--asymmetric-sell-only)

**Part IX — Risk & Security**
45. [Risk Model & Coverage Thresholds](#45-risk-model--coverage-thresholds)
46. [Security Considerations](#46-security-considerations)
47. [Deployment Order](#47-deployment-order)

**Part X — Audit Notes & Future Upgrade Path**
48. [Audit Checklist & Known Design Decisions](#48-audit-checklist--known-design-decisions)
49. [Upgrade Path: Fixed 8:2 → Dynamic Ratio](#49-upgrade-path-fixed-82--dynamic-ratio)

---

# Part I — System Overview

---

## 1. Protocol Summary

PrimeVaults V3 is a **3-tranche structured yield protocol**. Each yield source (sUSDe, sUSDai, etc.) is deployed as a separate **market** — a fully independent set of contracts.

```
Market "Ethena":
  Senior depositors   ──┐
  Mezz depositors     ──┼──► PrimeCDO ──► SUSDeStrategy ──► sUSDe
  Junior depositors   ──┤       │
                        └───────┴──► AaveWETHAdapter ──► Aave v3 (WETH buffer)

Market "USD.AI" (separate deployment):
  Senior depositors   ──┐
  Mezz depositors     ──┼──► PrimeCDO ──► SUSDaiStrategy ──► sUSDai
  Junior depositors   ──┤       │
                        └───────┴──► AaveWETHAdapter ──► Aave v3 (WETH buffer)
```

### Three tranches per market

| Tranche | Token | Risk | Yield | Loss Order |
|---------|-------|------|-------|------------|
| **Senior** | pvSENIOR | Lowest | Benchmark floor guaranteed | Last (4th) |
| **Mezzanine** | pvMEZZ | Medium | Leveraged residual | Third (3rd) |
| **Junior** | pvJUNIOR | Highest | 3 streams + premiums | First (1st+2nd) |

Junior holds **dual-asset: 80% base + 20% WETH** (fixed 8:2 ratio).

---

## 2. Market Model: 1 CDO = 1 Strategy

### Design: follow Strata

Each yield source is a fully isolated **market**. One market = one complete set of contracts. Markets share NO state, NO capital, NO risk.

```
Market = {
  PrimeCDO          (orchestrator)
  Accounting         (TVL math)
  Strategy           (yield source — exactly 1)
  TrancheVault × 3   (pvSENIOR, pvMEZZ, pvJUNIOR)
  AaveWETHAdapter    (Junior WETH buffer)
  AprPairFeed        (APR oracle for this strategy)
  CooldownRequestImpl (strategy-specific unstake logic)
}

Shared across ALL markets (deploy once):
  RiskParams         (premium curves — may differ per market)
  ERC20Cooldown      (generic, reusable)
  UnstakeCooldown    (generic, reusable)
  SharesCooldown     (generic, reusable)
  RedemptionPolicy   (configurable per market)
  SwapFacility       (generic, reusable)
  WETHPriceOracle    (one ETH price, shared)
  PrimeGovernor      (governance)
```

### Why 1:1 (not multi-strategy per CDO)

```
✓ Risk isolation      — sUSDe exploit does NOT affect sUSDai market
✓ Simplicity          — CDO calls strategy directly, no allocation routing
✓ Less code           — no StrategyRegistry, no proportional recall, no cross-strategy rebalance
✓ Smaller audit scope — fewer moving parts per market
✓ Proven model        — Strata runs 2 live markets (USDe + NUSD) this way
✓ Clean scaling       — new strategy = new market, zero changes to existing

✗ Liquidity split     — each market has its own TVL (trade-off accepted)
✗ More deploy cost    — per-market contracts (acceptable, one-time)
✗ More tokens         — pvSENIOR_ethena, pvSENIOR_usdai, etc.
```

> **AUDIT NOTE:** There is NO StrategyRegistry contract. PrimeCDO holds a single `i_strategy` address. All capital flows to and from this one strategy. This eliminates an entire class of allocation/proportionality bugs.

### Token naming convention

```
Market Ethena:   pvSENIOR-e, pvMEZZ-e, pvJUNIOR-e
Market USD.AI:   pvSENIOR-u, pvMEZZ-u, pvJUNIOR-u
Market [X]:      pvSENIOR-x, pvMEZZ-x, pvJUNIOR-x
```

---

## 3. Architecture Map

### Per-market contracts

```
contracts/
│
├── interfaces/
│   ├── IStrategy.sol              Strategy interface (withdraw → WithdrawResult)
│   ├── ICooldownHandler.sol       Common cooldown interface
│   ├── ICooldownRequestImpl.sol   Strategy-specific unstake logic
│   ├── IAprFeed.sol               Pluggable APR oracle
│   ├── IRatioController.sol       For future dynamic ratio upgrade
│   └── IPrimeCDO.sol              CDO ↔ vault communication
│
├── strategies/
│   ├── BaseStrategy.sol           Abstract base with cooldown routing
│   └── implementations/
│       ├── SUSDeStrategy.sol      Ethena sUSDe
│       ├── SUSDaiStrategy.sol     USD.AI sUSDai
│       └── cooldown/
│           ├── SUSDeCooldownRequestImpl.sol
│           └── SUSDaiCooldownRequestImpl.sol
│
├── core/
│   ├── Accounting.sol             Dual-asset TVL math + gain splitting
│   ├── PrimeCDO.sol               Orchestrator (1:1 with strategy)
│   └── TrancheVault.sol           Generic ERC-4626 + junior mode
│
├── junior/
│   └── AaveWETHAdapter.sol        Supply/withdraw WETH to Aave v3
│
├── oracles/
│   ├── AprPairFeed.sol            APR target + base feed (per market)
│   └── providers/
│       └── AaveAprProvider.sol    Aave benchmark rate
```

### Shared contracts (deploy once)

```
├── cooldown/
│   ├── ERC20Cooldown.sol          Lock ERC-20 tokens
│   ├── UnstakeCooldown.sol        External protocol unstaking
│   ├── SharesCooldown.sol         Lock vault shares
│   └── RedemptionPolicy.sol       Coverage-based mechanism selection
│
├── junior/
│   ├── SwapFacility.sol           WETH ↔ baseAsset swap (Uniswap V3)
│   └── WETHPriceOracle.sol        Chainlink 30-min TWAP
│
└── governance/
    ├── RiskParams.sol             Premium curve params
    └── PrimeGovernor.sol          Timelock + multisig
```

---

## 4. Module Dependency Graph

### Per-market (example: Ethena market)

```
SUSDeStrategy
      │
      └──► PrimeCDO ◄── Accounting ◄── RiskParams
              │   │          │              ◄── AprPairFeed ◄── AaveAprProvider
              │   │          │
              │   ├── AaveWETHAdapter ◄── WETHPriceOracle (shared)
              │   ├── SwapFacility (shared)
              │   ├── ERC20Cooldown (shared)
              │   ├── SharesCooldown (shared)
              │   └── UnstakeCooldown (shared) ◄── SUSDeCooldownRequestImpl
              │
              ├── TrancheVault(pvSENIOR-e)
              ├── TrancheVault(pvMEZZ-e)
              └── TrancheVault(pvJUNIOR-e)
```

---

# Part II — Mathematical Model

---

## 5. Variable Definitions

All values: 18-decimal fixed-point.

```
TVL_sr            Senior TVL
TVL_mz            Mezzanine TVL
TVL_jr_base       Junior base strategy TVL
TVL_jr_weth       Junior WETH buffer USD value = aWETH_balance × WETH_price
TVL_jr            = TVL_jr_base + TVL_jr_weth
TVL_reserve       Protocol reserve
TVL_pool          = TVL_sr + TVL_mz + TVL_jr

ratio_sr          = TVL_sr / (TVL_sr + TVL_jr)
coverage          = TVL_pool / TVL_jr
ratio_weth        = TVL_jr_weth / TVL_jr
RATIO_TARGET      = 0.20e18  (fixed 20%)
RATIO_TOLERANCE   = 0.02e18  (fixed ±2%)

APR_target        Senior's target APR (from AprPairFeed)
APR_base          Strategy collateral APR (from AprPairFeed)
APR_benchmark     Aave USDC/USDT weighted average
APR_aave_weth     Aave v3 WETH supply rate
WETH_price        30-min TWAP from WETHPriceOracle

x1,y1,k1          RP1 curve params
x2,y2,k2          RP2 curve params
alpha              Senior's RP2 cost share (60%)
beta               = 1 - alpha (40%)
reserveBps         Reserve cut from gains
```

---

## 6. APR Calculation Pipeline

### Step 1 — Benchmark Rate (Senior floor)

```
APR_benchmark = (Supply_USDC × APY_USDC + Supply_USDT × APY_USDT) / (Supply_USDC + Supply_USDT)
```

### Step 2 — RP1: Senior pays Mezzanine

```
RP1 = x1 + y1 × (ratio_sr ^ k1)
```

Defaults: x1=10%, y1=12.5%, k1=0.3

### Step 3 — RP2: Pool pays Junior

```
RP2 = x2 + y2 × (coverage ^ k2)
```

Defaults: x2=5%, y2=10%, k2=0.5

### Step 4 — Alpha Split

```
Senior pays:  alpha × RP2 (60%)
Mezz pays:    beta × RP2  (40%)
```

### Step 5 — Senior APR

```
APR_sr = MAX(APR_target, APR_base × (1 - RP1 - alpha × RP2))
```

> **AUDIT NOTE:** Constraint `RP1 + alpha × RP2 < 1e18` checked dynamically in Accounting.

### Step 6 — Mezzanine APR

```
APR_mz_gross = (APR_base - APR_sr) × (TVL_sr / TVL_mz) + APR_base
rp2_mz_cost  = beta × RP2 × APR_base × (TVL_sr / TVL_mz)
APR_mz       = MAX(0, APR_mz_gross - rp2_mz_cost)
```

---

## 7. Junior Yield Aggregation (3 Streams)

```
Stream 1: yield_base = TVL_jr_base × APR_base
Stream 2: yield_weth = TVL_jr_weth × APR_aave_weth
Stream 3: yield_rp2  = (alpha × RP2 × APR_sr × TVL_sr) + (beta × RP2 × APR_mz_gross × TVL_mz)

APR_jr = (yield_base + yield_weth + yield_rp2) / TVL_jr
```

> **AUDIT NOTE:** Fixed 8:2 capital efficiency cost: 20% in WETH earns ~2.5% instead of ~15%. Cost ≈ 0.5% total Junior APY. This is the intentional price of loss protection.

---

## 8. Gain Splitting Algorithm

```
STEP 1: strategyGain = currentStrategyTVL - prevStrategyTVL
STEP 2: reserveCut = MAX(0, strategyGain) × reserveBps / 10_000
STEP 3: netGain = strategyGain - reserveCut
STEP 4: seniorGainTarget = TVL_sr × APR_sr × deltaT / (365 days)
STEP 5:
  CASE A (netGain ≥ target): Senior gets target, Junior base gets rest
  CASE B (0 ≤ netGain < target): Senior gets all, Junior subsidizes
  CASE C (netGain < 0): Loss waterfall (section 9)
STEP 6: TVL_jr_weth = AaveWETHAdapter.totalAssetsUSD()
STEP 7: Update srtTargetIndex + timestamp
```

> **AUDIT NOTE:** WETH value update (Step 6) is separate from strategy gain splitting. WETH changes do NOT enter gain splitting. Intentional.

---

## 9. Loss Waterfall (4-Layer with WETH)

```
loss = |netGain|

LAYER 0: WETH buffer sells first
  Execute: Aave withdraw → Uniswap swap → inject into strategy
  TVL_jr_weth -= coverage amount

LAYER 1: Junior base absorbs
  TVL_jr_base -= MIN(remaining, TVL_jr_base)

LAYER 2: Mezzanine absorbs
  TVL_mz -= MIN(remaining, TVL_mz)

LAYER 3: Senior absorbs (last resort)
  TVL_sr -= MIN(remaining, TVL_sr)
```

> **AUDIT NOTE:** Layer 0 is 3 external calls (Aave, Uniswap, Strategy), atomic. Swap slippage → Junior base absorbs (Layer 1).

---

## 10. Risk Premium Curves

```
RP(r) = x + y × r^k
```

### Constraints (RiskParams)

```
x1 ≤ 30%, x1+y1 ≤ 80%, x2+y2 ≤ 50%, alpha ∈ [40%,80%]
Runtime check: RP1 + alpha × RP2 < 100%
```

---

## 11. WETH Ratio — Fixed 8:2 with Upgrade Hook

### Launch: Fixed

```
RATIO_TARGET    = 0.20e18   (20%)
RATIO_TOLERANCE = 0.02e18   (±2%)
Range: [18%, 22%]
```

### Pre-wired hook in PrimeCDO

```solidity
address public s_ratioController;   // address(0) at launch

function _getTargetRatio() internal view returns (uint256) {
    if (s_ratioController == address(0)) {
        return s_ratioTarget;         // fixed 20%
    }
    return IRatioController(s_ratioController).getTargetRatio();
}

function _getTolerance(uint256 target) internal view returns (uint256) {
    if (s_ratioController == address(0)) {
        return s_ratioTolerance;      // fixed 2%
    }
    return target * s_ratioTolerancePct / 1e18;
}

/// @dev Governance-only, timelock 48h. Set address(0) to revert to fixed.
function setRatioController(address controller) external onlyGovernance;
```

> **AUDIT NOTE:** 5 extra lines vs hardcode. 1 storage slot. ~200 gas per deposit. Enables zero-downtime upgrade to dynamic ratio. See [Section 49](#49-upgrade-path-fixed-82--dynamic-ratio).

---

## 12. Asymmetric Rebalance

### ETH rises → ratio too high → AUTO sell WETH

```solidity
/// @dev Permissionless. Anyone can call. Cannot extract value.
function rebalanceSellWETH() external {
    require(currentRatio > target + tolerance);
    // Withdraw WETH from Aave → swap to underlying → inject into strategy
}
```

### ETH drops → ratio too low → GOVERNANCE buy WETH

```solidity
/// @dev Governance-only. Timelock 24h. Has maxBaseToRecall cap.
function rebalanceBuyWETH(uint256 maxBaseToRecall) external onlyGovernance {
    require(currentRatio < target - tolerance);
    // Recall base from strategy → swap to WETH → supply Aave
}
```

### Why asymmetric

```
Selling WETH (ETH rose):   Low risk. Selling gains. Auto OK.
Buying WETH (ETH dropped): High risk. Buying falling asset. Governance decides.
Natural rebuild:           New deposits bring 20% WETH → buffer rebuilds passively.
```

> **AUDIT NOTE:** `rebalanceSellWETH()` — permissionless, verify no sandwich extraction. `rebalanceBuyWETH()` — governance + maxRecall cap, verify cannot drain strategy.

---

## 13. Self-Balancing Mechanism

```
LOOP 1: TVL_jr ↑ → coverage ↓ → RP2 ↓ → APY_jr ↓ → equilibrium
LOOP 2: TVL_sr ↑ → ratio_sr ↑ → RP1 ↑ → APY_sr ↓ → equilibrium
LOOP 3: ETH drops → new deposits bring 20% WETH → buffer rebuilds passively
LOOP 4: coverage ↓ → longer cooldown + fee → discourages exits → stabilizes
```

---

## 14. Numerical Examples

### Example 1: Ethena market (APR_base = 15%)

```
TVL_sr=$7M, TVL_mz=$2M, TVL_jr_base=$780K, TVL_jr_weth=$220K
coverage=10x, RP1=22.0%, RP2=36.6%

Senior:  MAX(4%, 15% × (1-22%-21.96%)) = MAX(4%, 8.4%) = 8.4%
Mezz:    ~30.4%
Junior:  Stream1($117K) + Stream2($5.5K) + Stream3($164.4K) / $1M = 28.69%
```

### Example 2: USD.AI market (APR_base = 11%)

```
Same TVL distribution.
Senior: MAX(4%, 11% × 56.04%) = MAX(4%, 6.16%) = 6.16%
Mezz:   ~22.1%
Junior: Stream1($85.8K) + Stream2($5.5K) + Stream3($162.5K) / $1M = 25.38%
```

### Example 3: Loss with WETH buffer

```
Loss $500K. WETH buffer $220K.
Layer 0: sell 73.3 WETH → $218K USDe (1% slippage) → inject.
Layer 1: Jr base absorbs $282K.
pvJUNIOR drops from $1M to $498K. Senior/Mezz unaffected.
```

---

# Part III — Core Contracts

---

## 15. IStrategy Interface

```solidity
struct WithdrawResult {
    WithdrawType wType;       // INSTANT, ASSETS_LOCK, UNSTAKE
    uint256 amountOut;
    uint256 cooldownId;       // 0 for INSTANT
    address cooldownHandler;  // address(0) for INSTANT
    uint256 unlockTime;       // 0 for INSTANT
}

enum WithdrawType { INSTANT, ASSETS_LOCK, UNSTAKE }

interface IStrategy {
    function deposit(uint256 amount) external returns (uint256 shares);
    function depositToken(address token, uint256 amount) external returns (uint256 shares);
    function withdraw(uint256 amount, address outputToken, address beneficiary)
        external returns (WithdrawResult memory);
    function emergencyWithdraw() external returns (uint256 amountOut);

    function totalAssets() external view returns (uint256);
    function baseAsset() external view returns (address);
    function supportedTokens() external view returns (address[] memory);
    function predictWithdrawType(address outputToken) external view returns (WithdrawType);
    function getCooldownHandlers() external view returns (address[] memory);
    function name() external view returns (string memory);
    function isActive() external view returns (bool);
}
```

---

## 16. BaseStrategy

```solidity
abstract contract BaseStrategy is Ownable2Step, Pausable, IStrategy {
    address public immutable i_primeCDO;
    address public immutable i_baseAsset;
    address public s_erc20Cooldown;
    address public s_unstakeCooldown;

    modifier onlyCDO();

    // Cooldown helpers
    function _lockInERC20Cooldown(...) internal returns (WithdrawResult memory);
    function _lockInUnstakeCooldown(...) internal returns (WithdrawResult memory);

    // Abstract hooks for concrete strategies
    function _deposit(uint256) internal virtual returns (uint256);
    function _depositToken(address, uint256) internal virtual returns (uint256);
    function _withdraw(uint256, address, address) internal virtual returns (WithdrawResult memory);
    function _isSupported(address) internal view virtual returns (bool);
}
```

---

## 17. Accounting (Dual-Asset)

```solidity
contract Accounting {
    uint256 public s_seniorTVL;
    uint256 public s_mezzTVL;
    uint256 public s_juniorBaseTVL;
    uint256 public s_juniorWethTVL;
    uint256 public s_reserveTVL;
    uint256 public s_lastUpdateTimestamp;
    uint256 public s_srtTargetIndex;

    function updateTVL(uint256 currentStrategyTVL, uint256 currentWethValueUSD) external onlyCDO;
    function recordDeposit(TrancheId id, uint256 amount) external onlyCDO;
    function recordWithdraw(TrancheId id, uint256 amount) external onlyCDO;
    function recordFee(TrancheId id, uint256 feeAmount) external onlyCDO;
    function setJuniorWethTVL(uint256 wethValueUSD) external onlyCDO;

    function getTrancheTVL(TrancheId id) external view returns (uint256);
    function getJuniorTVL() external view returns (uint256);         // base + weth
    function getAllTVLs() external view returns (uint256, uint256, uint256);
}
```

---

## 18. PrimeCDO (1:1 with Strategy)

### Key change from v3.3.0: NO StrategyRegistry

```solidity
contract PrimeCDO {
    // ─── Core components (per market) ─────────────────────────────────
    address public immutable i_accounting;
    address public immutable i_strategy;           // ← DIRECT 1:1, no registry
    address public immutable i_redemptionPolicy;
    address public immutable i_sharesCooldown;
    address public s_erc20Cooldown;

    // ─── Junior WETH ──────────────────────────────────────────────────
    address public immutable i_aaveWETHAdapter;
    address public immutable i_swapFacility;
    address public immutable i_weth;
    address public immutable i_wethOracle;

    // ─── Ratio (fixed, with upgrade hook) ─────────────────────────────
    uint256 public s_ratioTarget;       // 0.20e18
    uint256 public s_ratioTolerance;    // 0.02e18
    address public s_ratioController;   // address(0) at launch

    // ─── Tranches ─────────────────────────────────────────────────────
    mapping(TrancheId => address) public s_tranches;
```

### Deposit — Senior/Mezz

```solidity
function deposit(
    TrancheId tranche, address token, uint256 amount
) external onlyTranche(tranche) returns (uint256 baseAmount) {
    // 1. Update accounting
    uint256 wethUSD = IAaveWETHAdapter(i_aaveWETHAdapter).totalAssetsUSD();
    IAccounting(i_accounting).updateTVL(IStrategy(i_strategy).totalAssets(), wethUSD);

    // 2. Route tokens DIRECTLY to strategy (no registry)
    IERC20(token).approve(i_strategy, amount);
    uint256 shares = IStrategy(i_strategy).depositToken(token, amount);

    // 3. Record
    baseAmount = /* convert shares to base value */;
    IAccounting(i_accounting).recordDeposit(tranche, baseAmount);
}
```

### Deposit — Junior (dual-asset)

```solidity
function depositJunior(
    address baseToken, uint256 baseAmount, uint256 wethAmount, address depositor
) external onlyTranche(TrancheId.JUNIOR) returns (uint256 totalBaseValue) {
    // 1. Update accounting
    // 2. Validate ratio: wethValueUSD / totalValueUSD ∈ [18%, 22%]
    // 3. Route base DIRECTLY to strategy
    // 4. Route WETH to AaveWETHAdapter
    // 5. Record in accounting
}
```

### Withdraw — all tranches (coverage-aware)

```solidity
function requestWithdraw(
    TrancheId tranche, uint256 baseAmount, address outputToken,
    address beneficiary, uint256 vaultShares
) external onlyTranche(tranche) returns (CDOWithdrawResult memory) {
    // 1. Update accounting
    // 2. Query RedemptionPolicy
    // 3. Apply fee if any
    // 4. Route: NONE / ASSETS_LOCK / SHARES_LOCK / UNSTAKE
    //    For base asset: call i_strategy.withdraw() DIRECTLY
}
```

### Withdraw — Junior (base + WETH)

```solidity
function withdrawJunior(
    uint256 baseAmount, address outputToken, address beneficiary,
    uint256 vaultShares, uint256 totalJuniorShares
) external onlyTranche(TrancheId.JUNIOR) returns (CDOWithdrawResult memory) {
    // 1. Proportional WETH: userWETH = totalWETH × shares / totalSupply
    // 2. Withdraw WETH from Aave → beneficiary (always instant)
    // 3. Process base portion via cooldown flow
}
```

### Loss coverage

```solidity
function executeWETHCoverage(uint256 lossUSD) external {
    // 1. Withdraw WETH from Aave
    // 2. Swap WETH → underlying via SwapFacility
    // 3. Inject into strategy DIRECTLY: IStrategy(i_strategy).deposit(received)
}
```

### Rebalance

```solidity
function rebalanceSellWETH() external;                                  // permissionless
function rebalanceBuyWETH(uint256 maxBaseToRecall) external onlyGovernance;
```

> **AUDIT NOTE — Simplified vs v3.3.0:**
> - Removed: StrategyRegistry, allocationBps, deployCapital(), recallCapital(), proportional recall, cross-strategy rebalance, injectCapital()
> - All strategy calls go directly: `IStrategy(i_strategy).deposit/withdraw/totalAssets`
> - This eliminates: allocation bugs, proportionality rounding errors, cross-strategy reentrancy

---

## 19. TrancheVault (Generic + Junior Mode)

Same bytecode deployed 3× per market.

```solidity
contract TrancheVault is ERC4626, Pausable {
    IPrimeCDO public immutable i_cdo;
    TrancheId public immutable i_trancheId;

    function totalAssets() public view override returns (uint256) {
        return i_cdo.accounting().getTrancheTVL(i_trancheId);
    }

    // Senior/Mezz: depositToken(token, amount, receiver)
    // Junior: depositJunior(baseToken, baseAmount, wethAmount, receiver)
    // All: requestWithdraw(shares, outputToken, receiver, owner)
    // All: claimWithdraw(requestIndex)
}
```

---

# Part IV — Junior WETH Buffer System

---

## 20. AaveWETHAdapter

```solidity
contract AaveWETHAdapter {
    function supply(uint256 wethAmount) external onlyCDO returns (uint256);
    function withdraw(uint256 wethAmount, address to) external onlyCDO returns (uint256);
    function withdrawAll(address to) external onlyCDO returns (uint256);
    function totalAssets() external view returns (uint256);      // aWETH balance
    function totalAssetsUSD() external view returns (uint256);   // balance × TWAP
    function currentAPR() external view returns (uint256);
}
```

> **AUDIT NOTE:** `totalAssetsUSD()` uses TWAP, not spot. 30-min lag during crash is intentional — prevents oracle manipulation of Junior totalAssets.

---

## 21. SwapFacility

```solidity
contract SwapFacility {
    uint256 public s_maxSlippage;          // 1%
    uint256 public s_emergencySlippage;    // 10%

    function swapWETHFor(address outputToken, uint256 wethAmount, uint256 minOut)
        external onlyCDO returns (uint256);
    function swapForWETH(address inputToken, uint256 amount, uint256 minWethOut)
        external onlyCDO returns (uint256);
}
```

Shared across all markets (ETH price is the same everywhere).

---

## 22. WETHPriceOracle

30-min Chainlink TWAP. Reverts if stale >1h. Shared across all markets.

---

# Part V — Cooldown Withdrawal System

---

## 23. Cooldown Design Overview

| # | Mechanism | When | Share Timing |
|---|-----------|------|-------------|
| 1 | **NONE** | Coverage > 2.0x | Burn at request |
| 2 | **ASSETS_LOCK** | Coverage 1.5-2.0x | Burn at request |
| 3 | **UNSTAKE** | Token needs external cooldown | Burn at request |
| 4 | **SHARES_LOCK** | Coverage < 1.5x | Burn at claim |
| 5 | **FEE** | Combinable with any | At request |

> **AUDIT NOTE — Junior WETH:** WETH portion of Junior withdrawal is ALWAYS instant regardless of cooldown type. Only base portion goes through cooldown. Verify this doesn't create arbitrage.

---

## 24–28. Cooldown Contracts

ICooldownHandler, ERC20Cooldown, UnstakeCooldown, SharesCooldown, RedemptionPolicy — all shared across markets. Unchanged from v3.3.0. Each market configures its own RedemptionPolicy ranges.

---

# Part VI — Oracle & Governance

---

## 29. IAprFeed & AprPairFeed

**Deployed per market.** Each market has its own AprPairFeed with its own provider.

```
Ethena market:  AprPairFeed → AaveAprProvider (benchmark) + Ethena sUSDe rate (base)
USD.AI market:  AprPairFeed → AaveAprProvider (benchmark) + USD.AI sUSDai rate (base)
```

---

## 30. RiskParams

Can differ per market. Governance may set different premium curves for different strategies.

```
Ethena market:  x1=10%, y1=12.5%, k1=0.3, x2=5%, y2=10%, k2=0.5, alpha=60%
USD.AI market:  x1=8%, y1=15%, k1=0.25, x2=6%, y2=12%, k2=0.4, alpha=55%
                (may be more conservative due to newer protocol)
```

---

## 31. PrimeGovernor & Access Control

```
Per market:
  PrimeCDO               ← onlyTranche
    rebalanceSellWETH()   ← permissionless
    rebalanceBuyWETH()    ← onlyGovernance (24h)
    setRatioController()  ← onlyGovernance (48h)
  Strategy               ← onlyCDO
  Accounting             ← onlyCDO
  AaveWETHAdapter        ← onlyCDO

Shared:
  Cooldown contracts     ← onlyAuthorized (CDOs + strategies from all markets)
  RedemptionPolicy       ← onlyOwner (governance + timelock)
  RiskParams             ← onlyGovernance
```

---

# Part VII — Strategy Implementations & Benchmark

---

## 32. SUSDeStrategy (Ethena) — Full Benchmark

### Overview

```
Protocol:       Ethena
Base asset:     USDe (synthetic dollar, delta-neutral)
Yield token:    sUSDe (staked USDe, ERC-4626)
Supported:      [USDe, sUSDe]
Withdraw sUSDe: INSTANT
Withdraw USDe:  UNSTAKE (~7 days, Ethena cooldown)
```

### Yield source

1. **Funding rate** — perp futures funding (positive in bull, negative in bear)
2. **Staking yield** — stETH/ETH staking (~3-4% base)
3. **Basis spread** — spot vs futures price difference

### Historical APY benchmark

```
Bull market:     15-25%
Neutral:         8-12%
Bear:            2-5%
Extreme stress:  0% or negative
Average (2024-2025): ~12-15%
```

### Risk profile

| Risk | Severity | Description |
|------|----------|-------------|
| Funding negative | Medium | Yield drops. Senior hits floor, Junior subsidizes. |
| USDe de-peg | High | sUSDe exchange rate drops. Loss waterfall triggers. |
| Smart contract exploit | High | Total loss possible. Full waterfall. |
| Custody risk | Medium | Centralized custodians hold collateral. |
| Cooldown change | Low | Ethena can change cooldown duration. |

### PrimeVaults APY impact

| sUSDe APY | Senior | Mezz | Junior |
|-----------|--------|------|--------|
| 15% (bull) | 8.4% | 30.4% | 28.7% |
| 8% (neutral) | 5.2% | 16.8% | 19.3% |
| 3% (stress) | 4.0% (floor) | 2.1% | 8.5% |

> **AUDIT NOTE:** PrimeVaults has NO control over Ethena's sUSDe. If Ethena pauses withdrawals, UnstakeCooldown is stuck. Mitigation: emergency path returns sUSDe directly (instant).

---

## 33. SUSDaiStrategy (USD.AI) — Full Benchmark

### Overview

```
Protocol:        USD.AI
Base asset:      USDai (synthetic dollar, AI lending)
Yield token:     sUSDai (staked USDai, ERC-4626)
Supported:       [USDai, sUSDai]
Withdraw sUSDai: INSTANT
Withdraw USDai:  UNSTAKE (~7 days, USD.AI cooldown)
```

### Yield source

1. **Lending interest** — AI companies borrow USDai for GPU purchases (10-15% APR)
2. **Utilization premium** — higher utilization → higher rates
3. **Protocol spread** — USD.AI takes cut, remainder to sUSDai holders

### Projected APY benchmark

```
High demand:     12-18%
Normal:          8-12%
Low demand:      5-8%
Extreme:         3-5% (defaults absorb yield)
Average (projected): ~10-13%
```

### Risk profile

| Risk | Severity | Description |
|------|----------|-------------|
| AI demand drop | Medium | Yield drops. Senior floor kicks in. |
| Borrower default | High | USDai TVL loss. Loss waterfall triggers. |
| USDai de-peg | High | sUSDai exchange rate drops. |
| Smart contract exploit | High | Newer protocol, less battle-tested. |
| Concentration risk | Medium | Few large borrowers = correlated default. |
| Regulatory risk | Medium | AI lending may face regulation. |

### PrimeVaults APY impact

| sUSDai APY | Senior | Mezz | Junior |
|------------|--------|------|--------|
| 13% (high) | 7.3% | 26.2% | 26.8% |
| 8% (normal) | 5.2% | 14.8% | 19.3% |
| 5% (stress) | 4.0% (floor) | 4.2% | 12.1% |

> **AUDIT NOTE:** USD.AI is newer than Ethena. Recommend lower initial TVL cap for this market. Increase gradually.

---

## 34. Strategy Comparison Matrix

| | SUSDeStrategy | SUSDaiStrategy |
|---|---|---|
| **Avg APY** | 12-15% | 10-13% |
| **Yield source** | Funding rates + ETH staking | AI infrastructure lending |
| **Crypto correlation** | High | Low (secular AI trend) |
| **Maturity** | Established (2024) | Newer |
| **TVL** | $5B+ | Smaller |
| **Cooldown** | ~7 days | ~7 days |
| **De-peg risk** | Medium | Medium |
| **Audit depth** | Multiple audits | Fewer audits |
| **Regulatory** | Lower | Higher |
| **Diversification value** | — | High (uncorrelated with Ethena) |

### Launch recommendation

```
Phase 1 (launch):    Deploy Ethena market only. Proven yield, deep liquidity.
Phase 2 (mature):    Deploy USD.AI market separately. Independent risk.
User benefit:        Can deposit in both markets. Different risk/yield profiles.
Diversification:     Ethena yield (crypto-correlated) + USD.AI yield (AI-secular)
```

---

## 35. Launching a New Market — Cookbook

Replacing "Adding a New Strategy" since there is no StrategyRegistry.

### Step 1: Develop strategy contract

```solidity
contract NewStrategy is BaseStrategy {
    // Implement: _deposit, _withdraw, _depositToken, _isSupported, totalAssets, etc.
}
```

### Step 2: Deploy per-market contracts

```
1. AprPairFeed (with strategy-specific provider)
2. RiskParams (may use different curves)
3. Accounting (new instance)
4. NewStrategy
5. CooldownRequestImpl (strategy-specific)
6. AaveWETHAdapter (new instance, same Aave pool)
7. PrimeCDO (new instance, pointing to new Strategy + Accounting)
8. TrancheVault × 3 (pvSENIOR-x, pvMEZZ-x, pvJUNIOR-x)
```

### Step 3: Configure

```
- Register vaults in PrimeCDO
- Register CooldownImpl in shared UnstakeCooldown
- Configure RedemptionPolicy for new market
- Authorize new CDO in shared cooldown contracts
- Set WETH ratio params
```

### Step 4: Done

```
Existing markets: ZERO changes. ZERO risk. ZERO downtime.
New market: fully independent. Own TVL, own risk, own tokens.
Shared infra: cooldown contracts, SwapFacility, WETHPriceOracle, governance.
```

> **AUDIT NOTE:** When launching a new market, verify the new CDO is properly authorized in shared cooldown contracts. Also verify the shared contracts can handle concurrent requests from multiple markets (request IDs must be globally unique).

---

# Part VIII — Data Flow Diagrams

---

## 36. Deposit — Senior/Mezz

```
User
  │  vault.depositToken(USDe, 1000e18, receiver)
  ▼
TrancheVault (pvSENIOR-e)
  │  pull USDe → approve CDO → cdo.deposit(SENIOR, USDe, 1000e18)
  ▼
PrimeCDO
  │  accounting.updateTVL(strategy.totalAssets(), wethAdapter.totalAssetsUSD())
  │  strategy.depositToken(USDe, 1000e18)  ← DIRECT, no registry
  │  accounting.recordDeposit(SENIOR, baseEquiv)
  ▼
TrancheVault
  │  mint(receiver, shares)
```

---

## 37. Deposit — Junior (Dual-Asset)

```
User
  │  vault.depositJunior(USDe, 8000e18, 0.67 WETH, receiver)
  ▼
PrimeCDO
  │  Validate: $8000 base + $2000 WETH ($3000/ETH) = $10,000
  │  ratio = 20% → within [18%, 22%] ✓
  │  strategy.depositToken(USDe, 8000e18)  ← DIRECT
  │  aaveWETHAdapter.supply(0.67 WETH)
  ▼
TrancheVault
  │  mint(receiver, shares for $10,000)
```

---

## 38. Yield Accrual

```
No transaction needed.
sUSDe exchange rate ↑ per block → strategy.totalAssets() ↑
aWETH balance ↑ per block + ETH price change → WETH value changes

On next action: accounting.updateTVL() captures both.
Senior/Mezz/Junior share prices update accordingly.
```

---

## 39–41. Withdrawal Flows

Same as v3.3.0. Instant / AssetsLock / SharesLock depending on coverage.

---

## 42. Withdrawal — Junior

```
User owns 10% pvJUNIOR-e, withdraws.

1. WETH: 10% × totalWETH = 5 WETH → instant Aave withdraw → user
2. Base: $X USDe → cooldown flow (depends on coverage)
```

---

## 43. Loss Coverage — WETH Swap

```
Loss $500K → Layer 0: sell WETH → swap → inject DIRECTLY into strategy
(no registry routing, CDO calls strategy.deposit directly)
```

---

## 44. Rebalance

```
ETH rises: rebalanceSellWETH() → permissionless → sell WETH → inject strategy
ETH drops: wait for natural rebuild via deposits OR governance vote → buy WETH
```

---

# Part IX — Risk & Security

---

## 45. Risk Model

```
coverage = TVL_pool / TVL_jr

> 2.0x:    Healthy
1.5-2.0x:  Monitor (AssetsLock + fee)
1.2-1.5x:  Warning (SharesLock + fee)
1.05-1.2x: Alert (pause Jr redemptions)
< 1.05x:   Critical (pause market)

Each market has independent coverage. Ethena market stress does NOT affect USD.AI market.
```

---

## 46. Security Considerations

```
✓ No StrategyRegistry → eliminates allocation/proportionality bug class
✓ 1:1 CDO-Strategy → simpler call graph, fewer reentrancy paths
✓ Market isolation → exploit in one market cannot drain another
✓ Shared cooldown contracts → globally unique request IDs, concurrent-safe
✓ Asymmetric rebalance → permissionless sell, governance-only buy
✓ Atomic loss coverage → 3 external calls, all-or-nothing
✓ Fixed 8:2 ratio → no sigmoid math attack surface at launch
```

---

## 47. Deployment Order

### Shared (once)

```
 1.  PrimeGovernor (timelock + multisig)
 2.  WETHPriceOracle
 3.  SwapFacility
 4.  ERC20Cooldown
 5.  UnstakeCooldown
 6.  SharesCooldown
```

### Per market (example: Ethena)

```
 7.  RiskParams (may use market-specific curves)
 8.  AprPairFeed + AaveAprProvider (Ethena-specific)
 9.  Accounting
10.  SUSDeStrategy
11.  SUSDeCooldownRequestImpl → register in UnstakeCooldown
12.  AaveWETHAdapter
13.  RedemptionPolicy (configure ranges for this market)
14.  PrimeCDO (needs: Accounting, SUSDeStrategy, AaveWETHAdapter,
             SwapFacility, WETHPriceOracle, ERC20Cooldown,
             SharesCooldown, RedemptionPolicy)
     → Set s_ratioTarget = 0.20e18
     → Set s_ratioTolerance = 0.02e18
     → Set s_ratioController = address(0)
15.  TrancheVault × 3 (pvSENIOR-e, pvMEZZ-e, pvJUNIOR-e)
16.  Register vaults in PrimeCDO
17.  Authorize CDO + strategy in shared cooldown contracts
18.  Set cooldown durations
```

---

# Part X — Audit Notes & Future Upgrade Path

---

## 48. Audit Checklist & Known Design Decisions

### Intentional design decisions

| # | Decision | Rationale |
|---|----------|-----------|
| AD-1 | 1 CDO = 1 Strategy (no registry) | Risk isolation, simplicity, Strata-proven model |
| AD-2 | Fixed 8:2 WETH ratio | Simple, auditable. Upgrade hook pre-wired. |
| AD-3 | Asymmetric rebalance | Sell=auto (low risk), Buy=governance (timing risk) |
| AD-4 | WETH yield not in gain splitting | Buffer serves protection, not distribution |
| AD-5 | Junior WETH always instant on withdraw | Separate from strategy pool |
| AD-6 | Loss slippage → Junior base | Junior accepted this risk |
| AD-7 | Markets fully isolated | No shared capital, no cross-market contagion |
| AD-8 | Shared cooldown contracts | Request IDs globally unique across markets |
| AD-9 | Per-market RiskParams | Different strategies may need different curves |
| AD-10 | Reserve cut only on positive gain | Never at depositor expense during loss |

### Critical invariants

```
INV-1: TVL_sr + TVL_mz + TVL_jr_base + TVL_reserve == Strategy.totalAssets()
INV-2: sharePrice stable through deposit/withdraw (excluding fees + rounding)
INV-3: Loss order: WETH → Jr base → Mezz → Senior (no skip, no reorder)
INV-4: rebalanceSellWETH() cannot reduce total Junior TVL (minus slippage)
INV-5: Checks-effects-interactions on all external calls
INV-6: Cooldown request IDs globally unique across all markets
INV-7: SharesLock does NOT reduce TVL at request time
```

### Extra scrutiny areas

```
S-1: PrimeCDO.executeWETHCoverage() — 3 external calls, atomic
S-2: SharesLock + Junior instant WETH withdrawal — arbitrage?
S-3: rebalanceSellWETH() sandwich via Uniswap
S-4: Multiple markets sharing ERC20Cooldown — concurrent ID collision?
S-5: Edge: Junior TVL = 0 → coverage division by zero?
S-6: Edge: WETH price = 0 from oracle → ratio division by zero?
S-7: Edge: Strategy.totalAssets() returns 0 unexpectedly
```

---

## 49. Upgrade Path: Fixed 8:2 → Dynamic Ratio

### When to upgrade

```
Consider when: TVL Junior > $50M (optimization matters)
Do NOT when:   TVL < $10M, or recent incident
```

### Procedure

```
1. Develop RatioController (implements IRatioController)
2. Audit (standalone, small scope)
3. Deploy
4. Governance: PrimeCDO.setRatioController(address) — 48h timelock
5. Execute
6. Verify: _getTargetRatio() now dynamic
```

### Rollback

```
Governance: PrimeCDO.setRatioController(address(0))
→ Instant revert to fixed 8:2. Zero downtime.
```

### What changes / doesn't change

```
Changes:     _getTargetRatio() output, _getTolerance() output
No change:   PrimeCDO address, vaults, accounting, strategy, cooldown, user positions
No downtime: seamless switch
No migration: zero
```

---

*PrimeVaults V3 — Complete Technical Documentation v3.4.0*  
*1 CDO = 1 Strategy • Fixed 8:2 • Asymmetric Rebalance • Strata-inspired*  
*March 2026*
