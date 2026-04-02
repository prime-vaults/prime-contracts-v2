# PrimeVaults V3 — WETHPriceOracle Implementation Prompts

---

## Prompt 1: Core WETHPriceOracle Contract

```
Implement a WETHPriceOracle contract for PrimeVaults V3 on Arbitrum.

## Context
PrimeVaults is a 3-tranche structured yield protocol. Junior tranche holds a WETH buffer 
(20% of deposit) in Aave v3 as first-loss insurance. The protocol needs WETH/USD price for:
- TVL calculation (Jr_weth = aWETH_balance × WETH_price)
- Rebalance ratio validation
- Loss waterfall (how much WETH to sell)
- Swap minOutput protection

The protocol uses Uniswap V3 for all WETH ↔ base asset swaps on Arbitrum.

## Requirements

### Primary: Uniswap V3 TWAP Oracle
- Use the SAME Uniswap V3 pool that the protocol swaps through (WETH/USDai or WETH/USDC)
- TWAP = Time-Weighted Average Price from pool.observe()
- Support configurable TWAP intervals per use case
- Arbitrum-specific: multiple blocks/sec, sufficient granularity

### Price Functions (different TWAP intervals for different use cases)

1. `getWETHPriceForTVL()` → 30 min TWAP
   - Used by: Accounting (B4), Coverage ratios (B3), Deposit gates
   - Needs stability, not realtime accuracy

2. `getWETHPriceForSwap()` → 5 min TWAP  
   - Used by: SwapFacility for minOutput calculation (D3)
   - Needs to be close to current market for accurate slippage protection

3. `getWETHPriceForRebalance()` → 15 min TWAP
   - Used by: PrimeCDO rebalanceSellWETH/rebalanceBuyWETH (F4)
   - Balance between stability and accuracy

4. `getWETHPrice(uint32 twapInterval)` → generic with custom interval
   - Flexible for any caller

### Safety Checks (CRITICAL)

1. **Observation cardinality**: On deployment or initialization, call 
   `pool.increaseObservationCardinalityNext()` to ensure enough observation slots 
   for the longest TWAP interval (30 min on Arbitrum ≈ 100+ slots needed)

2. **Minimum liquidity**: Revert if pool.liquidity() < configurable MIN_LIQUIDITY threshold.
   TWAP from an empty pool is meaningless.

3. **Max deviation from last known price**: Store s_lastPrice. If new TWAP deviates 
   > MAX_PRICE_DEVIATION (e.g. 15%) from last known → revert. Prevents stale/manipulated prices.
   Update s_lastPrice on each successful read.

4. **Staleness**: If pool hasn't had a swap for too long, oldest observation might be 
   newer than requested twapInterval → pool.observe() will interpolate, which is fine, 
   but log a warning event if observation age < twapInterval.

5. **Zero price**: Revert if computed price = 0.

### Configuration (governance-settable)

- `tvlTwapInterval`: default 1800 (30 min)
- `swapTwapInterval`: default 300 (5 min)  
- `rebalanceTwapInterval`: default 900 (15 min)
- `maxPriceDeviation`: default 0.15e18 (15%)
- `minPoolLiquidity`: default configurable per deployment
- `pool`: immutable, set at construction

### Technical Specs

- Solidity ^0.8.24
- Use OpenZeppelin AccessControl for governance
- Use Uniswap V3 OracleLibrary for tick → price conversion
- All prices return uint256 in 18 decimals (1e18 = $1.00)
- Pool token ordering: handle both token0=WETH and token0=baseAsset cases
- Emit events: PriceUpdated(uint256 price, uint32 twapInterval), DeviationWarning(uint256 oldPrice, uint256 newPrice)

### Interface

```solidity
interface IWETHPriceOracle {
    function getWETHPrice(uint32 twapInterval) external view returns (uint256 price);
    function getWETHPriceForTVL() external view returns (uint256 price);
    function getWETHPriceForSwap() external view returns (uint256 price);
    function getWETHPriceForRebalance() external view returns (uint256 price);
    function getLastPrice() external view returns (uint256 price);
    function setTwapIntervals(uint32 tvl, uint32 swap, uint32 rebalance) external;
    function setMaxPriceDeviation(uint256 maxDeviation) external;
    function setMinPoolLiquidity(uint128 minLiquidity) external;
    function ensureObservationCardinality(uint16 minCardinality) external;
}
```

### File location
contracts/junior/WETHPriceOracle.sol

### Dependencies
- @uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol
- @uniswap/v3-periphery/contracts/libraries/OracleLibrary.sol
- @openzeppelin/contracts/access/AccessControl.sol

### Testing considerations
- Mock pool with configurable tickCumulatives for TWAP calculation
- Test token ordering (WETH as token0 vs token1)
- Test deviation check trigger
- Test zero liquidity revert
- Test observation cardinality insufficient scenario
```

---

## Prompt 2: SwapFacility Integration with TWAP

```
Update the SwapFacility contract to use WETHPriceOracle TWAP for minOutput calculation 
instead of Chainlink.

## Context
SwapFacility wraps Uniswap V3 swaps with price protection. Previously used Chainlink 
for minOutput. Now switching to Uniswap V3 TWAP from the SAME pool being swapped through.

## Current SwapFacility interface (keep unchanged)

```solidity
function swapWETHToBase(uint256 wethAmount, uint256 maxSlippage) 
    external returns (uint256 baseOut);
function swapBaseToWETH(uint256 baseAmount, uint256 maxSlippage) 
    external returns (uint256 wethOut);
```

## Changes needed

### 1. Replace Chainlink with WETHPriceOracle
```solidity
// OLD
IChainlinkAggregator public immutable chainlinkFeed;
uint256 price = chainlinkFeed.latestAnswer();

// NEW  
IWETHPriceOracle public immutable priceOracle;
uint256 price = priceOracle.getWETHPriceForSwap(); // 5 min TWAP
```

### 2. minOutput calculation

```
// WETH → Base swap
expectedOutput = wethAmount × twapPrice / 1e18
minOutput = expectedOutput × (1e18 - maxSlippage) / 1e18

// Base → WETH swap
expectedOutput = baseAmount × 1e18 / twapPrice
minOutput = expectedOutput × (1e18 - maxSlippage) / 1e18
```

### 3. Post-swap sanity check
After swap executes, verify:
- actualOutput >= minOutput (Uniswap already enforces, but double-check)
- actualOutput is within reasonable range of expectedOutput
  (e.g. actualOutput > expectedOutput × 0.90)

### 4. maxSlippage values (used by callers)
- Normal operations (rebalance): maxSlippage = 1% (0.01e18)
- Emergency (loss waterfall): maxSlippage = 10% (0.10e18)
- These are passed IN by PrimeCDO, not hardcoded in SwapFacility

## Why TWAP from same pool is better than Chainlink for swap protection

1. Price source = execution venue → no mismatch
2. 5-min TWAP close enough to spot for accurate slippage calc
3. If TWAP is manipulated, the swap itself would fail (pool price ≠ TWAP)
   → self-correcting
4. No external dependency (Chainlink node downtime, stale price)

## File location
contracts/junior/SwapFacility.sol

## Testing
- Test swap with TWAP price matching spot → minOutput reasonable
- Test swap when TWAP diverges from spot → slippage protection triggers
- Test maxSlippage = 0 → very tight protection
- Test emergency slippage (10%) → allows larger deviation
```

---

## Prompt 3: Integration into PrimeCDO and Accounting

```
Update PrimeCDO and Accounting contracts to use WETHPriceOracle for all WETH price needs.

## Context
Multiple contracts need WETH price. Currently each might have its own approach.
Standardize: all go through WETHPriceOracle with appropriate TWAP interval.

## Changes in Accounting.sol

### B4: WETH Value for TVL
```solidity
// In updateTVL() or getJuniorWethTVL()
function _getJuniorWethTVL() internal view returns (uint256) {
    uint256 aWethBalance = IERC20(aWETH).balanceOf(address(aaveAdapter));
    uint256 wethPrice = priceOracle.getWETHPriceForTVL(); // 30 min TWAP
    return aWethBalance * wethPrice / 1e18;
}
```

### E0: APY_base dilution
```solidity
// APY_base = APY_strategy × Strategy_TVL / Pool_TVL
// Pool_TVL includes Jr_weth which uses 30-min TWAP price
// This is already correct if _getJuniorWethTVL() uses TWAP
```

### Coverage ratios (B3)
```solidity
// cs and cm use Pool_TVL which includes Jr_weth
// Same 30-min TWAP price → consistent
```

## Changes in PrimeCDO.sol

### Deposit ratio validation (F3)
```solidity
function depositJunior(uint256 baseAmount, uint256 wethAmount) external {
    // Validate 80/20 ratio
    uint256 wethPrice = priceOracle.getWETHPriceForRebalance(); // 15 min TWAP
    uint256 wethValueUSD = wethAmount * wethPrice / 1e18;
    uint256 totalValue = baseAmount + wethValueUSD;
    uint256 wethRatio = wethValueUSD * 1e18 / totalValue;
    
    uint256 target = getTargetRatio(); // 20% = 0.2e18
    require(
        _abs(int256(wethRatio) - int256(target)) <= RATIO_TOLERANCE,
        "WETH ratio out of tolerance"
    );
    // ... rest of deposit logic
}
```

### Rebalance (F4)
```solidity
function rebalanceSellWETH() external {
    uint256 wethPrice = priceOracle.getWETHPriceForRebalance(); // 15 min TWAP
    uint256 currentWethUSD = aaveAdapter.totalAssetsUSD(wethPrice);
    uint256 jrTVL = accounting.getJuniorTVL();
    uint256 targetWethUSD = jrTVL * getTargetRatio() / 1e18;
    
    require(currentWethUSD > targetWethUSD, "No excess WETH");
    uint256 excessUSD = currentWethUSD - targetWethUSD;
    uint256 wethToSell = excessUSD * 1e18 / wethPrice;
    
    // Swap with 1% slippage
    swapFacility.swapWETHToBase(wethToSell, 0.01e18);
}
```

### Loss waterfall (D2-D3)
```solidity
function executeWETHCoverage(uint256 lossAmount) internal returns (uint256 covered) {
    uint256 wethPrice = priceOracle.getWETHPriceForRebalance(); // 15 min TWAP
    uint256 wethTVL = aaveAdapter.totalAssetsUSD(wethPrice);
    
    uint256 wethCoverageUSD = Math.min(lossAmount, wethTVL);
    uint256 wethToSell = wethCoverageUSD * 1e18 / wethPrice;
    uint256 actualWethToSell = Math.min(wethToSell, aaveAdapter.totalAssets());
    
    // Emergency swap with 10% slippage
    covered = swapFacility.swapWETHToBase(actualWethToSell, 0.10e18);
}
```

## Changes in AaveWETHAdapter.sol

### totalAssetsUSD() now takes price parameter
```solidity
// OLD: adapter fetches price internally
function totalAssetsUSD() external view returns (uint256);

// NEW: caller passes price (from oracle with appropriate interval)
function totalAssetsUSD(uint256 wethPrice) external view returns (uint256) {
    return totalAssets() * wethPrice / 1e18;
}

// totalAssets() still returns raw WETH amount (no USD conversion)
function totalAssets() external view returns (uint256) {
    return IERC20(aWETH).balanceOf(address(this));
}
```

## TWAP interval summary (for code review)

| Caller | Function | Interval | Rationale |
|--------|----------|----------|-----------|
| Accounting._getJuniorWethTVL() | getWETHPriceForTVL() | 30 min | Stability for TVL/coverage |
| PrimeCDO.depositJunior() | getWETHPriceForRebalance() | 15 min | Near-realtime for UX |
| PrimeCDO.rebalanceSellWETH() | getWETHPriceForRebalance() | 15 min | Balance accuracy/stability |
| PrimeCDO.rebalanceBuyWETH() | getWETHPriceForRebalance() | 15 min | Same |
| PrimeCDO.executeWETHCoverage() | getWETHPriceForRebalance() | 15 min | Accuracy for loss calc |
| SwapFacility.swapWETHToBase() | getWETHPriceForSwap() | 5 min | Close to spot for slippage |

## File locations
- contracts/core/Accounting.sol
- contracts/core/PrimeCDO.sol
- contracts/junior/AaveWETHAdapter.sol
- contracts/junior/SwapFacility.sol
- contracts/junior/WETHPriceOracle.sol
```

---

## Prompt 4: WETHPriceOracle Unit Tests

```
Write comprehensive unit tests for WETHPriceOracle.

## Tech stack
- Hardhat + TypeScript
- ethers v6 + Viem
- Chai assertions

## Mock setup needed

### MockUniswapV3Pool
Must implement:
- `observe(uint32[] secondsAgos)` → returns (int56[] tickCumulatives, uint160[] secondsPerLiquidityCumulativeX128)
- `slot0()` → returns (sqrtPriceX96, tick, ...)
- `liquidity()` → returns uint128
- `increaseObservationCardinalityNext(uint16)` 
- Configurable: set tickCumulatives to control TWAP output

Helper to set TWAP price:
```
// To make TWAP return a specific price:
// 1. Convert desired price to tick: tick = log(price) / log(1.0001)
// 2. Set tickCumulative[0] = tick × twapInterval (for secondsAgo = twapInterval)
// 3. Set tickCumulative[1] = 0 (for secondsAgo = 0, current)
// avgTick = (0 - tick×interval) / (-interval) = tick
```

### Test categories

#### 1. Basic price retrieval
- getWETHPrice(1800) returns correct price for 30-min TWAP
- getWETHPrice(300) returns correct price for 5-min TWAP
- getWETHPriceForTVL() uses tvlTwapInterval
- getWETHPriceForSwap() uses swapTwapInterval
- getWETHPriceForRebalance() uses rebalanceTwapInterval

#### 2. Token ordering
- Test when WETH = token0, baseAsset = token1
- Test when WETH = token1, baseAsset = token0
- Price should be same regardless of ordering

#### 3. Price range
- ETH = $100 (bear market extreme)
- ETH = $2,500 (normal)
- ETH = $10,000 (bull market)
- ETH = $50,000 (extreme)
- All should return valid 18-decimal prices

#### 4. Safety: deviation check
- Normal: price within 15% of last known → success
- Abnormal: price 20% higher than last known → revert "Price deviation too high"
- Abnormal: price 50% lower → revert
- Edge: first call (no lastPrice) → should succeed and set lastPrice
- Edge: price changes 14.9% → success (just under threshold)

#### 5. Safety: liquidity check
- Pool with sufficient liquidity → success
- Pool with zero liquidity → revert "Insufficient liquidity"
- Pool with liquidity just above minimum → success
- Pool with liquidity just below minimum → revert

#### 6. Safety: zero price
- Mock returns tick that computes to 0 price → revert "Zero price"

#### 7. TWAP interval edge cases
- twapInterval = 0 → should return spot price (or revert, design choice)
- twapInterval = 1 → 1 second TWAP
- twapInterval = 86400 → 24 hour TWAP (may need cardinality)

#### 8. Observation cardinality
- Call ensureObservationCardinality(100) → pool.increaseObservationCardinalityNext(100) called
- Verify cardinality is sufficient for configured intervals

#### 9. Governance
- setTwapIntervals: only admin can call
- setMaxPriceDeviation: only admin, bounded (e.g. 5%-50%)
- setMinPoolLiquidity: only admin
- Non-admin calls → revert

#### 10. Events
- PriceUpdated emitted on successful getWETHPrice
- DeviationWarning emitted when deviation > warningThreshold but < maxDeviation

## File location
test/unit/WETHPriceOracle.test.ts
```

---

## Prompt 5: Dual Oracle Upgrade (Production Hardening)

```
Add optional Chainlink cross-check to WETHPriceOracle for production deployment.

## Context
For mainnet production, we want an additional safety layer: cross-check Uniswap TWAP 
against Chainlink ETH/USD feed. If they diverge significantly, something is wrong 
(manipulation, oracle failure, extreme volatility).

## Requirements

### New configuration
- `chainlinkFeed`: address of Chainlink ETH/USD on Arbitrum (0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612)
- `chainlinkEnabled`: bool, default false (can enable later without redeploy)
- `oracleDeviationThreshold`: max allowed deviation between TWAP and Chainlink, default 5% (0.05e18)
- `chainlinkStalenessThreshold`: max seconds since last Chainlink update, default 3600 (1 hour)

### Logic when chainlinkEnabled = true

```
function getWETHPrice(uint32 twapInterval) returns (uint256) {
    uint256 twapPrice = _getUniswapTWAP(twapInterval);
    
    if (chainlinkEnabled) {
        uint256 chainlinkPrice = _getChainlinkPrice();
        uint256 deviation = _computeDeviation(twapPrice, chainlinkPrice);
        
        if (deviation > oracleDeviationThreshold) {
            emit OracleDeviationAlert(twapPrice, chainlinkPrice, deviation);
            revert("Oracle deviation exceeds threshold");
        }
    }
    
    // Primary: always return TWAP (trustless, same execution venue)
    return twapPrice;
}
```

### Chainlink helper

```
function _getChainlinkPrice() internal view returns (uint256) {
    (, int256 answer, , uint256 updatedAt, ) = chainlinkFeed.latestRoundData();
    
    require(answer > 0, "Chainlink negative price");
    require(block.timestamp - updatedAt <= chainlinkStalenessThreshold, "Chainlink stale");
    
    // Chainlink ETH/USD returns 8 decimals → convert to 18
    return uint256(answer) * 1e10;
}
```

### Key design: TWAP is ALWAYS primary
- Chainlink is ONLY a sanity check
- If Chainlink is stale/down but TWAP is fine → still works (chainlinkEnabled can be toggled off)
- If both disagree → revert (conservative, protect protocol)
- Never return Chainlink price as the actual price (avoid execution/oracle mismatch)

### Governance functions
- `setChainlinkEnabled(bool)`: toggle cross-check
- `setChainlinkFeed(address)`: update feed address
- `setOracleDeviationThreshold(uint256)`: bounded [1%, 20%]
- `setChainlinkStalenessThreshold(uint256)`: bounded [300, 7200] seconds

### Events
- OracleDeviationAlert(uint256 twapPrice, uint256 chainlinkPrice, uint256 deviation)
- ChainlinkToggled(bool enabled)

## Testing
- Both oracles agree (within 5%) → success, return TWAP
- TWAP 6% higher than Chainlink → revert (deviation)
- Chainlink stale (>1h) but chainlinkEnabled=true → revert (stale)
- Chainlink stale but chainlinkEnabled=false → success (bypass)
- Chainlink returns negative → revert
- Toggle chainlinkEnabled on/off → behavior changes correctly

## File location
contracts/junior/WETHPriceOracle.sol (extend existing)
test/unit/WETHPriceOracle.test.ts (add test cases)
```

---

## Prompt 6: Observation Cardinality Manager

```
Implement a helper contract/script to manage Uniswap V3 pool observation cardinality 
for WETHPriceOracle on Arbitrum.

## Problem
Uniswap V3 pools start with observationCardinality = 1 (only stores 1 observation).
TWAP calculation needs multiple observations over time. On Arbitrum with ~4 blocks/sec,
a 30-min TWAP needs the pool to have stored observations spanning 30 minutes.

If cardinality is too low, pool.observe() will revert or give inaccurate results.

## Solution

### Calculate required cardinality
```
// Arbitrum: ~4 blocks/sec (variable)
// 30 min = 1800 seconds
// Conservative: assume 1 observation per second (Arbitrum can do more)
// Required: 1800 observations for 30-min TWAP
// Buffer: 2x → 3600
// But Uniswap writes 1 observation per SWAP, not per block
// In practice: 100-500 slots sufficient for active pools
// Our target: 500 (covers 30-min even with moderate swap frequency)
```

### Deployment script
```typescript
// In deploy scripts, after WETHPriceOracle is deployed:

async function ensureOracleCardinality(poolAddress: string, targetCardinality: number) {
    const pool = IUniswapV3Pool.attach(poolAddress);
    
    const slot0 = await pool.slot0();
    const currentCardinality = slot0.observationCardinality;
    const currentCardinalityNext = slot0.observationCardinalityNext;
    
    if (currentCardinalityNext < targetCardinality) {
        console.log(`Increasing cardinality: ${currentCardinalityNext} → ${targetCardinality}`);
        const tx = await pool.increaseObservationCardinalityNext(targetCardinality);
        await tx.wait();
        console.log(`Cardinality increased. Gas used: ${tx.gasUsed}`);
    } else {
        console.log(`Cardinality already sufficient: ${currentCardinalityNext}`);
    }
}

// Call in deployment
await ensureOracleCardinality(WETH_USDAI_POOL, 500);
```

### Monitor contract (optional)
```solidity
contract OracleCardinalityMonitor {
    function checkCardinality(IUniswapV3Pool pool, uint32 requiredTwapInterval) 
        external view returns (bool sufficient, uint16 current, uint16 recommended) 
    {
        (, , uint16 observationIndex, uint16 observationCardinality, , , ) = pool.slot0();
        current = observationCardinality;
        recommended = uint16(requiredTwapInterval / 10); // rough: 1 obs per 10 sec
        if (recommended < 100) recommended = 100; // minimum 100
        sufficient = current >= recommended;
    }
}
```

## File locations
- deploy/01_deploy_shared.ts (add cardinality check)
- contracts/periphery/OracleCardinalityMonitor.sol (optional)
```

---

## Summary: Implementation Order

```
Phase 1 (MVP):
  1. WETHPriceOracle.sol (Prompt 1) — core TWAP oracle
  2. SwapFacility.sol update (Prompt 2) — use TWAP for swap protection
  3. Accounting + PrimeCDO integration (Prompt 3) — wire everything
  4. Unit tests (Prompt 4)
  5. Deployment: ensure cardinality (Prompt 6)

Phase 2 (Production hardening):
  6. Dual oracle Chainlink cross-check (Prompt 5)
  7. Integration tests on Arbitrum fork
  8. Monitoring/alerting for oracle deviation events
```
