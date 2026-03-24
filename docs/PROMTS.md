# PrimeVaults V3 — Claude Code Prompt Guide

**Purpose:** Copy-paste prompts cho từng step. Chạy tuần tự.  
**Prerequisite:** Tất cả docs đã nằm trong `docs/` folder của repo.

---

## Folder setup trước khi bắt đầu

```bash
mkdir -p docs
# Copy vào docs/:
#   PV_V3_FINAL_v34.md
#   PV_V3_COVERAGE_GATE.md
#   PV_V3_MVP_PLAN.md
#   PV_V3_MATH_REFERENCE.md
#   CONVENTIONS.md
```

---

## PROMPT 0 — Session Init (paste MỖI LẦN mở Claude Code)

```
Read all files in docs/ folder. These define PrimeVaults V3 — a 3-tranche
structured yield protocol deployed on Arbitrum.

Key context:
- Strategy: sUSDai (USD.AI) — ERC-4626 deposit + ERC-7540 async redeem
- sUSDai: 0x0B2b2B2076d95dda7817e785989fE353fe955ef9 (Arbitrum)
- USDai: 0x0A1a1A107E45b7Ced86833863f482BC5f4ed82EF (Arbitrum)
- APR oracle: fully on-chain (Aave benchmark + sUSDai rate snapshots)
- See docs/PV_V3_APR_ORACLE.md for APR oracle architecture

Rules for ALL code you generate:
1. Follow docs/CONVENTIONS.md strictly — naming, formatting, NatSpec, errors
2. Reference docs/PV_V3_FINAL_v34.md for architecture decisions
3. Reference docs/PV_V3_MATH_REFERENCE.md for formulas (cite section in @dev)
4. Reference docs/PV_V3_APR_ORACLE.md for APR oracle spec
5. Follow docs/PV_V3_MVP_PLAN.md step order
6. Every external/public function has full NatSpec
7. Custom errors only — no require("string")
8. 120 char line width, horizontal priority
9. Run `npx hardhat compile` after creating each contract
10. Run tests after creating each test file
11. Network is Arbitrum — use Arbitrum contract addresses throughout
```

---

## PROMPT 1 — Project Init

```
Do Step 1-2 from docs/PV_V3_MVP_PLAN.md.

Initialize Hardhat TypeScript project. Install:
- @openzeppelin/contracts@5.1.0
- @prb/math
- @chainlink/contracts
- hardhat-gas-reporter
- solidity-coverage
- viem

Create the folder structure exactly as shown in Step 2.
Set solidity 0.8.24, optimizer enabled runs 200.
Do not write any contracts yet.
```

**Verify:** `npx hardhat compile` runs without error (empty project).

---

## PROMPT 2 — All Interfaces

```
Do Step 3 from docs/PV_V3_MVP_PLAN.md. Create ALL 10 interface files
in contracts/interfaces/.

Files: IStrategy.sol, ICooldownHandler.sol, ICooldownRequestImpl.sol,
IAprFeed.sol, IRatioController.sol, IPrimeCDO.sol, IAccounting.sol,
IAaveWETHAdapter.sol, ISwapFacility.sol, IWETHPriceOracle.sol.

Use exact signatures from the MVP plan. Add NatSpec on every function.
Put shared enums (TrancheId, WithdrawType, CooldownStatus) and structs
(WithdrawResult, CDOWithdrawResult, CooldownRequest) in the interface
where they logically belong.

Compile after creating all files.
```

**Verify:** `npx hardhat compile` — all interfaces compile.

---

## PROMPT 3 — Math Library

```
Do Step 8 from docs/PV_V3_MVP_PLAN.md.
Create contracts/libraries/FixedPointMath.sol.

Use @prb/math for the power function. Wrap it in our library:
- fpow(uint256 base, uint256 exp) → uint256 (both 1e18)
- fpMul(uint256 a, uint256 b) → uint256 (a * b / 1e18)
- fpDiv(uint256 a, uint256 b) → uint256 (a * 1e18 / b)

This is used for RP1/RP2 curves: RP = x + y * r^k.
See docs/PV_V3_MATH_REFERENCE.md sections E2, E3.

Then write test/unit/FixedPointMath.test.ts:
- fpow(0.5e18, 0.3e18) ≈ 0.8123 (within 0.1%)
- fpow(2.0e18, 0.5e18) ≈ 1.4142 (within 0.1%)
- fpow(10.0e18, 0.5e18) ≈ 3.1623 (within 0.1%)
- fpMul/fpDiv precision checks
- fpow(0, any) = 0
- fpow(any, 0) = 1e18

Run tests.
```

**Verify:** `npx hardhat test test/unit/FixedPointMath.test.ts` — all pass.

---

## PROMPT 4 — RiskParams

```
Do Step 4 from docs/PV_V3_MVP_PLAN.md.
Create contracts/governance/RiskParams.sol.

Stores PremiumCurve (x, y, k) for Senior and Junior, plus alpha
and reserveBps. Inherits Ownable2Step.

Validation constraints from docs/PV_V3_MATH_REFERENCE.md section E:
  x1 <= 0.30e18, x1+y1 <= 0.80e18
  x2+y2 <= 0.50e18
  alpha in [0.40e18, 0.80e18]
  reserveBps <= 2000

Then write test/unit/RiskParams.test.ts:
- Deploy with defaults, verify all values
- Set valid params → succeeds
- Set invalid params → reverts with correct error
- Non-owner set → reverts

Run tests.
```

**Verify:** compile + tests pass.

---

## PROMPT 5 — APR Oracle (PULL only, trustless, 2 contracts)

```
Do Step 5 from docs/PV_V3_APR_ORACLE.md.

KEY DESIGN: PULL only, NO PUSH mode.
  - No one can push arbitrary APR data (trustless)
  - Keeper triggers update, cannot influence output
  - APR comes 100% from on-chain contracts (Aave + sUSDai)
  - No ESourcePref, no PUSH overload

Provider has TWO entry points:
  getAprPair()     — state-changing: shift snapshots + compute (for updateRoundData)
  getAprPairView() — pure view: read existing snapshots (for latestRoundData fallback)

First create contracts/interfaces/IAprPairFeed.sol:
  IStrategyAprPairProvider:
    - getAprPair() → (int64, int64, uint64) — state-changing
    - getAprPairView() → (int64, int64, uint64) — pure view
  IAprPairFeed: TRound struct, latestRoundData(), getRoundData(), updateRoundData()

Then create 2 contracts:

1. contracts/oracles/providers/SUSDaiAprPairProvider.sol
   - getAprPair(): shifts snapshots + computes APRs (called by Feed PULL)
   - getAprPairView(): reads existing snapshots, NO shift (called by Feed fallback)
   - _computeBenchmarkApr(): Aave weighted avg, benchmarkTokens[], aToken from getReserveData
   - _computeStrategyApr(): annualized growth, supports negative, clamped [-50%, +200%]
   - Benchmark capped at 40% (BENCHMARK_MAX)
   - Constructor seeds first sUSDai snapshot
   - No hardcoded aToken addresses

2. contracts/oracles/AprPairFeed.sol
   - PULL ONLY — no PUSH overload, no ESourcePref
   - updateRoundData(): KEEPER_ROLE, calls provider.getAprPair() (shifts snapshots)
   - latestRoundData(): cache if fresh (< staleAfter), else getAprPairView() fallback
   - 20-round circular buffer with oldestRoundId tracking
   - Bounds [-50%, +200%], out-of-order + stale timestamp checks
   - getRoundData(roundId): historical access, revert if outside [oldest, current]
   - setProvider(): compat check via getAprPairView()

For testing create:
  test/helpers/mocks/MockERC4626.sol — sUSDai with configurable rate
  test/helpers/mocks/MockAavePool.sol — returns ReserveData with aTokenAddress

Write tests:
  test/unit/SUSDaiAprPairProvider.test.ts
    - getAprPair: shifts snapshots, returns APRs
    - getAprPairView: does NOT shift snapshots, returns same APRs
    - First call (1 snapshot): aprBase = 0
    - Second call: both APRs correct (int64×12dec)
    - Rate decrease: aprBase negative
    - Extreme rate jump: aprBase clamped at 200%
    - Aave weighted avg: different supplies weighted correctly
    - Benchmark > 40%: capped at BENCHMARK_MAX
    - aTokenAddress read from getReserveData (not hardcoded)

  test/unit/AprPairFeed.test.ts
    - updateRoundData: calls getAprPair, stores round
    - latestRoundData: returns cache if fresh
    - latestRoundData: calls getAprPairView if stale (NOT getAprPair)
    - latestRoundData: calls getAprPairView if no data yet
    - Bounds: revert if APR outside [-50%, +200%]
    - Out-of-order timestamp: revert
    - Stale provider timestamp: revert
    - getRoundData: returns historical round by ID
    - getRoundData: revert if roundId outside [oldest, current]
    - oldestRoundId: tracks correctly as buffer wraps
    - setProvider: calls getAprPairView for compat check
    - Roles: only KEEPER_ROLE can call updateRoundData
    - No PUSH function exists (verify no updateRoundData with args)

Compile + run tests.
```

**Verify:** compile + both test files pass.

---

## PROMPT 6 — Accounting (Part 1: State + Views)

```
Do Step 7 from docs/PV_V3_MVP_PLAN.md — PART 1 ONLY.

Create contracts/core/Accounting.sol with:
- All state variables (seniorTVL, mezzTVL, juniorBaseTVL, juniorWethTVL,
  reserveTVL, lastUpdateTimestamp, srtTargetIndex, reserveBps)
- Constructor (aprFeed, riskParams addresses)
- setCDO(address) — one-time setter
- onlyCDO modifier
- ALL view functions: getTrancheTVL, getJuniorTVL, getJuniorBaseTVL,
  getJuniorWethTVL, getAllTVLs
- recordDeposit, recordWithdraw, recordFee, setJuniorWethTVL

Do NOT implement updateTVL or _computeSeniorAPR yet.
Those come in next prompt.

Write test/unit/Accounting.views.test.ts:
- recordDeposit increases correct TVL
- recordWithdraw decreases correct TVL
- getTrancheTVL(JUNIOR) returns base + weth
- Non-CDO caller → revert

Run tests.
```

**Verify:** compile + tests pass.

---

## PROMPT 7 — Accounting (Part 2: Senior APR + Gain Splitting)

```
Continue contracts/core/Accounting.sol. Add:

1. _computeSeniorAPR() internal view
   Formula from docs/PV_V3_MATH_REFERENCE.md section E5:
     ratio_sr = seniorTVL / (seniorTVL + juniorTVL)
     RP1 = x1 + y1 * ratio_sr^k1
     coverage = poolTVL / juniorTVL
     RP2 = x2 + y2 * coverage^k2
     APR_sr = MAX(aprTarget, aprBase * (1 - RP1 - alpha*RP2))
   Use FixedPointMath.fpow for the power functions.
   Check RP1 + alpha*RP2 < 1e18 before computing.

2. updateTVL(uint256 currentStrategyTVL, uint256 currentWethValueUSD)
   Algorithm from docs/PV_V3_MATH_REFERENCE.md sections C1-C4:
     strategyGain → reserveCut → netGain → seniorGainTarget
     Case A/B/C → loss calls _handleLoss

3. _handleLoss(uint256 loss) internal
   4-layer waterfall from docs/PV_V3_MATH_REFERENCE.md section D4.
   Layer 0: emit WETHCoverageNeeded(min(loss, juniorWethTVL))
   Layer 1-3: juniorBase → mezz → senior

Add to test/unit/Accounting.test.ts:
- updateTVL positive gain Case A: senior gets target, junior gets rest
- updateTVL positive gain Case B: senior gets all
- updateTVL negative gain: waterfall layers 0→1→2→3
- _computeSeniorAPR: verify with numbers from docs section 14 example 1
- Edge: juniorTVL = 0 → no division by zero

Run tests.
```

**Verify:** compile + tests pass. Check Senior APR matches example in docs.

---

## PROMPT 8 — WETHPriceOracle

```
Do Step 9 from docs/PV_V3_MVP_PLAN.md.
Create contracts/junior/WETHPriceOracle.sol.

30-minute TWAP using Chainlink AggregatorV3Interface.
10-point circular buffer. MAX_STALENESS = 1 hour.

For testing, create test/helpers/mocks/MockChainlinkFeed.sol that
lets us set price and timestamp.

Write test/unit/WETHPriceOracle.test.ts:
- getWETHPrice returns TWAP after multiple price recordings
- Reverts if feed stale > 1 hour
- getSpotPrice returns latest Chainlink price in 1e18

Run tests.
```

---

## PROMPT 9 — AaveWETHAdapter

```
Do Step 10 from docs/PV_V3_MVP_PLAN.md.
Create contracts/junior/AaveWETHAdapter.sol.

For testing, create test/helpers/mocks/MockAavePool.sol that simulates
supply/withdraw of WETH → aWETH. Mock aWETH as a simple ERC20 that
increases balance by 0.01% per call to simulate yield.

Write test/unit/AaveWETHAdapter.test.ts:
- supply: WETH in, aWETH balance increases
- withdraw: aWETH decreases, WETH out to recipient
- withdrawAll: returns full balance
- totalAssets: returns aWETH balance
- totalAssetsUSD: balance × oracle price
- onlyCDO access control

Run tests.
```

---

## PROMPT 10 — SwapFacility

```
Do Step 11 from docs/PV_V3_MVP_PLAN.md.
Create contracts/junior/SwapFacility.sol.

For testing, create test/helpers/mocks/MockSwapRouter.sol that
swaps at a configurable rate (e.g. 1 WETH = 3000 USDC with
configurable slippage).

Write test/unit/SwapFacility.test.ts:
- swapWETHFor: correct output amount
- swapWETHFor: reverts if output < minOut (slippage protection)
- swapForWETH: reverse swap works
- getMinOutput: computes correctly with normal and emergency slippage
- onlyCDO access control

Run tests.
```

---

## PROMPT 11 — BaseStrategy + SUSDaiStrategy

```
Do Steps 17-18 from docs/PV_V3_MVP_PLAN.md.
Create contracts/strategies/BaseStrategy.sol and
contracts/strategies/implementations/SUSDaiStrategy.sol.

SUSDaiStrategy specifics (from docs/PV_V3_APR_ORACLE.md section 9):
- sUSDai: ERC-4626 deposit (synchronous) + ERC-7540 redeem (async ~7 days)
- deposit(USDai) → sUSDai.deposit(amount, this) → get shares
- withdraw sUSDai → instant transfer
- withdraw USDai → sUSDai.requestRedeem() → 7 day cooldown → redeem()

For testing, create test/helpers/mocks/MockERC4626.sol that simulates
sUSDai vault — deposit USDai get shares, convertToAssets increases over
time. Add requestRedeem/redeem mock for ERC-7540 async flow.

Write test/unit/SUSDaiStrategy.test.ts:
- deposit USDai → mints sUSDai shares internally
- depositToken sUSDai → direct transfer
- withdraw sUSDai → instant (WithdrawType.INSTANT)
- withdraw USDai → returns UNSTAKE type (ERC-7540 async cooldown)
- totalAssets → reflects sUSDai exchange rate
- emergencyWithdraw → returns all to CDO
- supportedTokens → [USDai, sUSDai]
- onlyCDO + pause checks

Run tests.
```

---

## PROMPT 12 — ERC20Cooldown

```
Do Step 12 from docs/PV_V3_MVP_PLAN.md.
Create contracts/cooldown/ERC20Cooldown.sol.

Implement full ICooldownHandler interface.
See docs/PV_V3_FINAL_v34.md section 25 for spec.

Write test/unit/ERC20Cooldown.test.ts:
- request: creates PENDING, locks tokens
- claim after unlockTime: transfers to beneficiary
- claim before unlockTime: reverts
- claim twice: reverts (already CLAIMED)
- expired request: reverts if past expiryTime
- getPendingRequests: returns correct IDs
- timeRemaining: decreases correctly
- onlyAuthorized for request

Run tests.
```

---

## PROMPT 13 — UnstakeCooldown + SUSDaiCooldownRequestImpl

```
Do Steps 13 + 16 from docs/PV_V3_MVP_PLAN.md.
Create contracts/cooldown/UnstakeCooldown.sol and
contracts/strategies/implementations/cooldown/SUSDaiCooldownRequestImpl.sol.

SUSDaiCooldownRequestImpl wraps sUSDai's ERC-7540 async redeem:
  initiateCooldown() → sUSDai.requestRedeem(shares, receiver, this)
  finalizeCooldown() → sUSDai.redeem(shares, receiver, this)
  isCooldownComplete() → check if redeem is claimable

For testing, create test/helpers/mocks/MockSUSDai.sol that
simulates ERC-7540 requestRedeem/redeem with configurable cooldown.

Write test/unit/UnstakeCooldown.test.ts:
- request: calls impl.initiateCooldown, stores request
- claim: calls impl.finalizeCooldown, transfers USDai
- isClaimable: delegates to impl.isCooldownComplete
- setImplementation: registers token → impl mapping
- onlyAuthorized

Run tests.
```

---

## PROMPT 14 — SharesCooldown

```
Do Step 14 from docs/PV_V3_MVP_PLAN.md.
Create contracts/cooldown/SharesCooldown.sol.

Key difference from ERC20Cooldown: locks vault SHARES (not assets).
At claim time, shares return to caller (vault burns at current rate).
See docs/PV_V3_FINAL_v34.md section 27.

Write test/unit/SharesCooldown.test.ts:
- request: escrows shares from caller
- claim after unlock: returns shares to caller
- claim before unlock: reverts
- Shares NOT burned during cooldown (just escrowed)

Run tests.
```

---

## PROMPT 15 — RedemptionPolicy

```
Do Step 15 from docs/PV_V3_MVP_PLAN.md.
Create contracts/cooldown/RedemptionPolicy.sol.

Coverage-based mechanism selection. See docs/PV_V3_FINAL_v34.md section 28.

Write test/unit/RedemptionPolicy.test.ts:
- Coverage > 2.0x → NONE, 0 fee
- Coverage 1.5-2.0x → ASSETS_LOCK, 10 bps
- Coverage < 1.5x → SHARES_LOCK, 50 bps
- setRanges: validates non-overlapping, ascending
- getCurrentCoverage: reads from accounting

Run tests.
```

---

## PROMPT 16 — PrimeCDO (Part 1: Setup + Deposits)

```
Do Step 19a-19c from docs/PV_V3_MVP_PLAN.md.

Create contracts/core/PrimeCDO.sol with ONLY:
- All state variables + constructor
- Internal helpers: _getTargetRatio, _getTolerance, _getCoverage,
  _checkJuniorShortfall
- deposit() for Senior/Mezz — includes coverage gate
- depositJunior() — includes ratio validation + coverage gate

DO NOT implement withdraw, claims, rebalance, or loss coverage yet.

Reference docs/PV_V3_COVERAGE_GATE.md for coverage gate logic.
Reference docs/PV_V3_FINAL_v34.md section 11 for ratio hook.

Write test/unit/PrimeCDO.deposit.test.ts:
- Senior deposit at healthy coverage → succeeds
- Senior deposit below 105% coverage → reverts
- Junior deposit always allowed
- Junior deposit wrong ratio → reverts
- Junior deposit correct ratio → succeeds
- Shortfall paused → all deposits revert

Run tests.
```

---

## PROMPT 17 — PrimeCDO (Part 2: Withdrawals)

```
Continue contracts/core/PrimeCDO.sol. Add:
- requestWithdraw() for all tranches
- withdrawJunior() — proportional WETH + base cooldown
- claimWithdraw()
- claimSharesWithdraw()
- instantWithdraw()

Include:
- Coverage gate: Jr withdraw blocked below 105%
- Shortfall check on every action
- RedemptionPolicy query for cooldown type + fee
- Fee → recordFee (to reserve)

Reference docs/PV_V3_FINAL_v34.md sections 39-42 for flows.

Write test/unit/PrimeCDO.withdraw.test.ts:
- Instant withdrawal at high coverage
- AssetsLock withdrawal at medium coverage
- SharesLock withdrawal at low coverage
- Junior withdrawal returns proportional WETH
- Junior withdraw blocked below 105%
- Fee calculation correct
- Claim after cooldown succeeds

Run tests.
```

---

## PROMPT 18 — PrimeCDO (Part 3: Loss + Rebalance + Admin)

```
Continue contracts/core/PrimeCDO.sol. Add:
- executeWETHCoverage(uint256 lossUSD)
- rebalanceSellWETH() — permissionless
- rebalanceBuyWETH(uint256 maxRecall) — onlyOwner
- All admin setters (ratio, coverage gates, shortfall, unpause)

Reference docs/PV_V3_FINAL_v34.md section 12 for asymmetric rebalance.
Reference docs/PV_V3_FINAL_v34.md section 43 for WETH coverage flow.

Write test/unit/PrimeCDO.rebalance.test.ts:
- rebalanceSellWETH: ratio > 22% → sells excess → ratio back to 20%
- rebalanceSellWETH: ratio within bounds → reverts
- rebalanceSellWETH: anyone can call (permissionless)
- rebalanceBuyWETH: governance only
- rebalanceBuyWETH: respects maxRecall cap

Write test/unit/PrimeCDO.loss.test.ts:
- executeWETHCoverage: sells WETH → injects into strategy
- Loss waterfall: WETH → Jr base → Mz → Sr
- Shortfall auto-pause triggers at 90% Jr price

Run tests.
```

---

## PROMPT 19 — TrancheVault

```
Do Step 20 from docs/PV_V3_MVP_PLAN.md.
Create contracts/core/TrancheVault.sol.

Generic ERC-4626 vault. Same bytecode deployed 3x per market.
Junior mode detected via i_trancheId == JUNIOR.

Write test/unit/TrancheVault.test.ts:
- totalAssets reads from Accounting
- deposit → mint correct shares (sharePrice invariant)
- depositJunior → validates trancheId == JUNIOR
- requestWithdraw → routes through CDO
- claimWithdraw → claims from cooldown handler
- Share price increases after yield accrual
- Withdraw → share price stable for remaining holders

Run tests.
```

---

## PROMPT 20 — PrimeLens

```
Do Step 21 from docs/PV_V3_MVP_PLAN.md.
Create contracts/periphery/PrimeLens.sol.

Read-only aggregator. No state changes. Constructor takes all addresses.

Functions: getTrancheInfo, getAllTranches, getJuniorPosition,
getProtocolHealth, getUserPendingWithdraws, previewWithdrawCondition,
getClaimableWithdraws, getWETHRebalanceStatus.

Write test/unit/PrimeLens.test.ts — verify it correctly reads
from all underlying contracts.

Run tests.
```

---

## PROMPT 21 — Integration Test: Full Flow

```
Do Step 29 from docs/PV_V3_MVP_PLAN.md.
Create test/integration/FullFlow.test.ts.

Fork Arbitrum mainnet at latest block. Use real:
- sUSDai: 0x0B2b2B2076d95dda7817e785989fE353fe955ef9
- USDai: 0x0A1a1A107E45b7Ced86833863f482BC5f4ed82EF
- Aave v3 Pool: 0x794a61358D6845594F94dc1DB02A252b5b4814aD
- WETH: 0x82aF49447D8a07e3bd95BD0d56f35241523fBab1
- Chainlink ETH/USD: 0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612
- Uniswap V3 Router: 0xE592427A0AEce92De3Edee1F18E0157C05861564

Deploy full stack on fork. Use hardhat_impersonateAccount to get
USDai + WETH for test users (find whale addresses on Arbiscan).

Test sequence:
1. Deploy all contracts (including APR oracle with manual override for first 24h)
2. User A: $10K Senior deposit
3. User B: $5K Mezz deposit
4. User C: $8K USDai + 0.67 WETH Junior deposit
5. Keeper: snapshot sUSDai rate + updateRoundData
6. Advance time 7 days (hardhat_mine)
7. Keeper: second snapshot + updateRoundData
8. Verify share prices increased for all tranches
9. User A: withdraw Senior (instant at high coverage)
10. User C: withdraw Junior (gets USDai + WETH)
11. Verify all TVLs balance correctly

Run tests.
```

---

## PROMPT 22 — Integration Test: Loss Scenario

```
Do Step 30 from docs/PV_V3_MVP_PLAN.md.
Create test/integration/LossScenario.test.ts.

Same Arbitrum fork setup as FullFlow.

Test sequence:
1. Deploy + deposits into all tranches
2. Simulate sUSDai loss by using a wrapper strategy that can
   report lower totalAssets (mock sUSDai rate decrease)
3. Trigger updateTVL → loss detected
4. Verify: WETH sold first (Layer 0)
5. Verify: Junior base absorbed remainder (Layer 1)
6. Verify: Senior + Mezz TVLs unchanged
7. If loss > 10%: verify shortfall auto-pause triggered
8. Governance unpause
9. Verify protocol resumes

Run tests.
```

---

## PROMPT 23 — Deploy Scripts

```
Do Steps 31-32 from docs/PV_V3_MVP_PLAN.md.
Create deploy scripts using Hardhat + Viem.

deploy/01_deploy_shared.ts:
  RiskParams, WETHPriceOracle, SwapFacility,
  ERC20Cooldown, UnstakeCooldown, SharesCooldown

deploy/02_deploy_usdai_market.ts:
  AaveAprProvider, SUSDaiAprProvider, AprPairFeed,
  Accounting, SUSDaiStrategy, SUSDaiCooldownRequestImpl,
  AaveWETHAdapter, RedemptionPolicy, PrimeCDO, TrancheVault × 3

deploy/03_configure.ts:
  Register vaults in CDO, authorize cooldown contracts,
  set cooldown durations, configure redemption ranges,
  set coverage gate params, set WETH ratio params,
  set manual APR override (first 24h),
  set keeper in SUSDaiAprProvider

scripts/verify-deployment.ts:
  Read all params, verify correct values, test $1 deposit/withdraw

Use Viem for deployment (publicClient + walletClient).
Target network: Arbitrum.
Print all deployed addresses at the end.

Run deploy on local hardhat node (Arbitrum fork) to verify.
```

---

## Checkpoint prompts (giữa các steps)

Khi cần fix lỗi compile:

```
Run `npx hardhat compile`. Fix all errors. Show me the fixes.
```

Khi cần fix test failures:

```
Run `npx hardhat test test/unit/Accounting.test.ts`.
Fix failing tests. Show me what was wrong and how you fixed it.
```

Khi cần review trước khi tiếp:

```
Show me the current state of contracts/core/Accounting.sol.
I want to review before we continue to PrimeCDO.
```

Khi Claude Code quên conventions:

```
Re-read docs/CONVENTIONS.md. The last file you generated doesn't follow:
- [specific issue, e.g. "missing NatSpec on deposit()"]
- [specific issue, e.g. "using require string instead of custom error"]
Fix the file.
```

---

## Summary: 23 prompts, tuần tự

```
#0   Session init (mỗi lần mở Claude Code — Arbitrum + sUSDai context)
#1   Project init
#2   All interfaces
#3   FixedPointMath + tests
#4   RiskParams + tests
#5   APR Oracle: SUSDaiAprPairProvider + AprPairFeed (PULL only, trustless)
#6   Accounting Part 1: state + views + tests
#7   Accounting Part 2: APR + gain splitting + tests
#8   WETHPriceOracle + mock + tests
#9   AaveWETHAdapter + mock + tests
#10  SwapFacility + mock + tests
#11  BaseStrategy + SUSDaiStrategy + mock + tests
#12  ERC20Cooldown + tests
#13  UnstakeCooldown + SUSDaiCooldownRequestImpl + mock + tests
#14  SharesCooldown + tests
#15  RedemptionPolicy + tests
#16  PrimeCDO Part 1: deposits + coverage gates + tests
#17  PrimeCDO Part 2: withdrawals + tests
#18  PrimeCDO Part 3: loss + rebalance + admin + tests
#19  TrancheVault + tests
#20  PrimeLens + tests
#21  Integration: full flow (Arbitrum fork)
#22  Integration: loss scenario (Arbitrum fork)
#23  Deploy scripts + verify (Arbitrum)
```

Docs needed in `docs/` folder:

```
docs/
├── PV_V3_FINAL_v34.md         ← architecture
├── PV_V3_COVERAGE_GATE.md     ← coverage gates
├── PV_V3_MVP_PLAN.md          ← step-by-step plan
├── PV_V3_MATH_REFERENCE.md    ← all formulas
├── PV_V3_APR_ORACLE.md        ← APR oracle spec (sUSDai + Aave)
└── CONVENTIONS.md              ← coding style
```

Sau mỗi prompt: **compile → test → review → next prompt**.
Không skip. Không batch nhiều steps vào 1 prompt.
