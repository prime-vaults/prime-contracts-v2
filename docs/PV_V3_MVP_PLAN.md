# PrimeVaults V3 — MVP Implementation Plan

**Purpose:** Step-by-step coding guide cho Claude Code  
**Stack:** Solidity 0.8.24, Hardhat, Viem, OpenZeppelin  
**Scope:** MVP — 1 market (Ethena sUSDe), fixed 8:2, coverage gates

---

## Phase Overview

```
Phase 1: Project Setup                    (Step 1-2)
Phase 2: Interfaces                       (Step 3)
Phase 3: Core — bottom up                 (Step 4-8)
Phase 4: Junior WETH Buffer               (Step 9-11)
Phase 5: Cooldown System                  (Step 12-16)
Phase 6: Strategy (Ethena)                (Step 17-18)
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

Claude Code system prompt prefix (paste at start of every session):

```
You are implementing PrimeVaults V3 smart contracts.
ALWAYS follow docs/CONVENTIONS.md for naming, formatting, NatSpec, errors.
Before writing code, read the relevant section from docs/PV_V3_FINAL_v34.md.
Reference formula sections from docs/PV_V3_MATH_REFERENCE.md in @dev comments.
Follow the step-by-step plan in docs/PV_V3_MVP_PLAN.md.
```

---

## Phase 1: Project Setup

### Step 1 — Init project

```bash
mkdir primevaults-v3 && cd primevaults-v3
npx hardhat init
# Choose: TypeScript project

npm install --save-dev \
  @nomicfoundation/hardhat-toolbox \
  @openzeppelin/contracts@5.1.0 \
  hardhat-gas-reporter \
  solidity-coverage

npm install viem
```

### Step 2 — Configure hardhat

```
hardhat.config.ts:
  solidity: "0.8.24"
  optimizer: enabled, runs 200
  networks: hardhat (fork mainnet for integration tests)
  gasReporter: enabled
```

Folder structure:

```
contracts/
├── interfaces/
├── core/
├── junior/
├── cooldown/
├── strategies/
│   └── implementations/
│       └── cooldown/
├── oracles/
│   └── providers/
├── governance/
└── periphery/

test/
├── unit/
├── integration/
└── helpers/

deploy/
scripts/
```

---

## Phase 2: Interfaces

### Step 3 — All interfaces (code first, implement later)

Code theo thứ tự này. Mỗi file là 1 interface, không có logic.

**3a. `contracts/interfaces/IStrategy.sol`**

```
Enums:
  WithdrawType { INSTANT, ASSETS_LOCK, UNSTAKE }

Structs:
  WithdrawResult {
    WithdrawType wType
    uint256 amountOut
    uint256 cooldownId
    address cooldownHandler
    uint256 unlockTime
  }

Functions:
  deposit(uint256 amount) → uint256 shares
  depositToken(address token, uint256 amount) → uint256 shares
  withdraw(uint256 amount, address outputToken, address beneficiary) → WithdrawResult
  emergencyWithdraw() → uint256 amountOut
  totalAssets() → uint256
  baseAsset() → address
  supportedTokens() → address[]
  predictWithdrawType(address outputToken) → WithdrawType
  getCooldownHandlers() → address[]
  name() → string
  isActive() → bool

Events:
  Deposited(address indexed token, uint256 amount, uint256 shares)
  Withdrawn(address indexed token, uint256 amount, uint256 shares)
  EmergencyWithdrawn(uint256 amount)
```

**3b. `contracts/interfaces/ICooldownHandler.sol`**

```
Enums:
  CooldownStatus { NONE, PENDING, CLAIMABLE, CLAIMED, EXPIRED }

Structs:
  CooldownRequest {
    address beneficiary
    address token
    uint256 amount
    uint256 requestTime
    uint256 unlockTime
    uint256 expiryTime
    CooldownStatus status
  }

Functions:
  request(address beneficiary, address token, uint256 amount) → uint256 requestId
  claim(uint256 requestId) → uint256 amountOut
  isClaimable(uint256 requestId) → bool
  getRequest(uint256 requestId) → CooldownRequest
  getPendingRequests(address beneficiary) → uint256[]
  timeRemaining(uint256 requestId) → uint256

Events:
  CooldownRequested(uint256 indexed requestId, address indexed beneficiary, address token, uint256 amount, uint256 unlockTime)
  CooldownClaimed(uint256 indexed requestId, address indexed beneficiary, address token, uint256 amountOut)
  CooldownExpired(uint256 indexed requestId)
```

**3c. `contracts/interfaces/ICooldownRequestImpl.sol`**

```
Functions:
  initiateCooldown(uint256 shares, address receiver) → uint256 cooldownDuration
  finalizeCooldown(address receiver) → uint256 amountOut
  isCooldownComplete() → bool
  yieldToken() → address
  baseAsset() → address
```

**3d. `contracts/interfaces/IAprFeed.sol`**

```
Functions:
  getAprPair() → (uint256 aprTarget, uint256 aprBase)
  updateRoundData()

Events:
  AprUpdated(uint256 aprTarget, uint256 aprBase, uint256 timestamp)
```

**3e. `contracts/interfaces/IRatioController.sol`**

```
NOTE: Interface only — NOT implemented in MVP. Pre-wired hook.

Functions:
  getTargetRatio() → uint256
  isBalanced(uint256 currentRatio) → bool
  getDepositSplit(uint256 totalDepositUSD) → (uint256 wethAmountUSD, uint256 baseAmountUSD)
```

**3f. `contracts/interfaces/IPrimeCDO.sol`**

```
Enums:
  TrancheId { SENIOR, MEZZ, JUNIOR }

Structs:
  CDOWithdrawResult {
    bool isInstant
    uint256 amountOut
    uint256 cooldownId
    address cooldownHandler
    uint256 unlockTime
    uint256 feeAmount
    uint8 appliedCooldownType
  }

Functions:
  deposit(TrancheId tranche, address token, uint256 amount) → uint256 baseAmount
  depositJunior(address baseToken, uint256 baseAmount, uint256 wethAmount, address depositor) → uint256 totalBaseValue
  requestWithdraw(TrancheId, uint256, address, address, uint256) → CDOWithdrawResult
  withdrawJunior(uint256, address, address, uint256, uint256) → CDOWithdrawResult
  claimWithdraw(uint256 cooldownId, address cooldownHandler) → uint256
  instantWithdraw(TrancheId, uint256, address, address) → uint256
  rebalanceSellWETH()
  rebalanceBuyWETH(uint256 maxBaseToRecall)
  accounting() → address
  strategy() → address
```

**3g. `contracts/interfaces/IAccounting.sol`**

```
Functions:
  updateTVL(uint256 currentStrategyTVL, uint256 currentWethValueUSD)
  recordDeposit(TrancheId id, uint256 amount)
  recordWithdraw(TrancheId id, uint256 amount)
  recordFee(TrancheId id, uint256 feeAmount)
  setJuniorWethTVL(uint256 wethValueUSD)
  getTrancheTVL(TrancheId id) → uint256
  getJuniorTVL() → uint256
  getJuniorBaseTVL() → uint256
  getJuniorWethTVL() → uint256
  getAllTVLs() → (uint256 sr, uint256 mz, uint256 jr)
  getSeniorAPR() → uint256
```

**3h. `contracts/interfaces/IAaveWETHAdapter.sol`**

```
Functions:
  supply(uint256 wethAmount) → uint256 aWethReceived
  withdraw(uint256 wethAmount, address to) → uint256 amountOut
  withdrawAll(address to) → uint256 amountOut
  totalAssets() → uint256
  totalAssetsUSD() → uint256
  currentAPR() → uint256
```

**3i. `contracts/interfaces/ISwapFacility.sol`**

```
Functions:
  swapWETHFor(address outputToken, uint256 wethAmount, uint256 minOut) → uint256 amountOut
  swapForWETH(address inputToken, uint256 amount, uint256 minWethOut) → uint256 wethOut
  getMinOutput(uint256 wethAmount, uint256 wethPrice, bool isEmergency) → uint256 minOut
```

**3j. `contracts/interfaces/IWETHPriceOracle.sol`**

```
Functions:
  getWETHPrice() → uint256 price18
  getSpotPrice() → uint256 price18
```

---

## Phase 3: Core — Bottom Up

Build from leaf contracts (no dependencies) up to orchestrator.

### Step 4 — `contracts/governance/RiskParams.sol`

```
State:
  struct PremiumCurve { uint256 x; uint256 y; uint256 k; }
  PremiumCurve public s_seniorPremium   // default: x=0.10e18, y=0.125e18, k=0.3e18
  PremiumCurve public s_juniorPremium   // default: x=0.05e18, y=0.10e18, k=0.5e18
  uint256 public s_alpha                // default: 0.60e18
  uint256 public s_reserveBps          // default: 500

Inherits: Ownable2Step

Functions:
  setSeniorPremium(PremiumCurve calldata) onlyOwner
  setJuniorPremium(PremiumCurve calldata) onlyOwner
  setAlpha(uint256) onlyOwner
  setReserveBps(uint256) onlyOwner

Validation:
  x1 <= 0.30e18
  x1 + y1 <= 0.80e18
  x2 + y2 <= 0.50e18
  alpha >= 0.40e18 && alpha <= 0.80e18
  reserveBps <= 2000

NOTE: Timelock is external (PrimeGovernor wraps calls). RiskParams itself
doesn't enforce timelock — it's just storage + validation.
```

### Step 5 — `contracts/oracles/providers/AaveAprProvider.sol`

```
State:
  address public immutable i_aavePool         // Aave v3 Pool
  address public immutable i_usdc             // USDC address
  address public immutable i_usdt             // USDT address
  address public immutable i_aUsdc            // aUSDC address
  address public immutable i_aUsdt            // aUSDT address

Functions:
  fetchApr() → (uint256 aprTarget, uint256 aprBase)

  aprTarget (benchmark) = supply-weighted average of USDC + USDT lending rates on Aave
  aprBase = sUSDe/sUSDai exchange rate growth (passed in or fetched from strategy)

  Internal:
    _getAaveSupplyRate(address asset) → uint256
    _getSupplyBalance(address aToken) → uint256

NOTE for MVP: aprBase can be hardcoded or set by governance initially.
Full on-chain computation from sUSDe rate is phase 2.
```

### Step 6 — `contracts/oracles/AprPairFeed.sol`

```
State:
  address public s_provider          // AaveAprProvider
  uint256 public s_aprTarget
  uint256 public s_aprBase
  uint256 public s_lastUpdated
  uint256 public s_staleAfter        // default: 86400 (24h)

Inherits: Ownable2Step, IAprFeed

Functions:
  getAprPair() → (uint256, uint256)
    → revert if stale (block.timestamp - s_lastUpdated > s_staleAfter)
    → return (s_aprTarget, s_aprBase)

  updateRoundData() onlyUpdater
    → fetch from provider OR accept direct set for MVP
    → emit AprUpdated

  // MVP shortcut: allow direct set by governance
  setAprPair(uint256 aprTarget, uint256 aprBase) onlyOwner
    → s_aprTarget = aprTarget
    → s_aprBase = aprBase
    → s_lastUpdated = block.timestamp

  setStaleAfter(uint256) onlyOwner
  setProvider(address) onlyOwner

Roles:
  UPDATER_ROLE: can call updateRoundData()
  OWNER: can set provider, staleness, direct APR
```

### Step 7 — `contracts/core/Accounting.sol`

```
THIS IS THE MOST COMPLEX CONTRACT. Take it slow.

State:
  uint256 public s_seniorTVL
  uint256 public s_mezzTVL
  uint256 public s_juniorBaseTVL
  uint256 public s_juniorWethTVL
  uint256 public s_reserveTVL
  uint256 public s_lastUpdateTimestamp
  uint256 public s_srtTargetIndex        // init: 1e18
  uint256 public s_reserveBps

  address public immutable i_aprFeed
  address public immutable i_riskParams
  address public i_primeCDO              // set once after CDO deploy

Inherits: IAccounting

Modifier:
  onlyCDO: require(msg.sender == i_primeCDO)

Functions:

  // ─── Main update (called every deposit/withdraw) ───────────────
  updateTVL(uint256 currentStrategyTVL, uint256 currentWethValueUSD) onlyCDO
    Implement gain splitting algorithm:
    1. strategyGain = currentStrategyTVL - (s_seniorTVL + s_mezzTVL + s_juniorBaseTVL + s_reserveTVL)
    2. reserveCut = max(0, strategyGain) * s_reserveBps / 10000
    3. netGain = strategyGain - reserveCut
    4. seniorGainTarget = s_seniorTVL * seniorAPR * deltaT / (365 days * 1e18)
    5. Case A/B/C gain splitting
    6. s_juniorWethTVL = currentWethValueUSD
    7. Update srtTargetIndex + timestamp

  // ─── Senior APR computation ────────────────────────────────────
  _computeSeniorAPR() internal view → uint256
    1. ratio_sr = s_seniorTVL * 1e18 / (s_seniorTVL + getJuniorTVL())
    2. RP1 = x1 + y1 * ratio_sr^k1 (use _fpow)
    3. coverage = (s_seniorTVL + s_mezzTVL + getJuniorTVL()) * 1e18 / getJuniorTVL()
    4. RP2 = x2 + y2 * coverage^k2
    5. APR_sr_v2 = aprBase * (1e18 - RP1 - alpha * RP2 / 1e18) / 1e18
    6. return max(aprTarget, APR_sr_v2)

  // ─── Loss waterfall ────────────────────────────────────────────
  _handleLoss(uint256 loss) internal
    Layer 0: emit WETHCoverageNeeded if s_juniorWethTVL > 0
    Layer 1: s_juniorBaseTVL -= min(loss, s_juniorBaseTVL)
    Layer 2: s_mezzTVL -= min(remaining, s_mezzTVL)
    Layer 3: s_seniorTVL -= min(remaining, s_seniorTVL)

  // ─── Fixed-point power ─────────────────────────────────────────
  _fpow(uint256 base, uint256 exp) internal pure → uint256
    Use ABDKMath64x64 or custom implementation
    base and exp are 1e18 fixed-point

  // ─── Record deposit/withdraw ───────────────────────────────────
  recordDeposit(TrancheId, uint256) onlyCDO
  recordWithdraw(TrancheId, uint256) onlyCDO
  recordFee(TrancheId, uint256) onlyCDO
  setJuniorWethTVL(uint256) onlyCDO

  // ─── View ──────────────────────────────────────────────────────
  getTrancheTVL(TrancheId) → uint256
    JUNIOR: return s_juniorBaseTVL + s_juniorWethTVL
    SENIOR/MEZZ: return respective TVL
  getJuniorTVL() → s_juniorBaseTVL + s_juniorWethTVL
  getJuniorBaseTVL() → s_juniorBaseTVL
  getJuniorWethTVL() → s_juniorWethTVL
  getAllTVLs() → (sr, mz, jr)
  getSeniorAPR() → _computeSeniorAPR()

Dependencies:
  npm install abdk-libraries-solidity (for fixed-point math)
  OR implement simple _fpow using logarithm approximation
```

### Step 8 — Math library helper

```
contracts/libraries/FixedPointMath.sol

Functions:
  fpow(uint256 base, uint256 exp) → uint256
    Both base and exp are 1e18
    Returns base^exp in 1e18

  fpMul(uint256 a, uint256 b) → uint256
    return a * b / 1e18

  fpDiv(uint256 a, uint256 b) → uint256
    return a * 1e18 / b

Implementation options:
  Option A: Use ABDKMath64x64 (battle-tested, import from npm)
  Option B: Use PRBMath (popular, import from npm)
  Option C: Taylor series approximation for e^(exp * ln(base))

Recommend Option B: npm install @prb/math
```

---

## Phase 4: Junior WETH Buffer

### Step 9 — `contracts/junior/WETHPriceOracle.sol`

```
State:
  AggregatorV3Interface public immutable i_feed  // Chainlink ETH/USD
  uint256 public constant TWAP_PERIOD = 30 minutes
  uint256 public constant MAX_STALENESS = 1 hours

  struct PricePoint { uint256 price; uint256 timestamp; }
  PricePoint[10] private s_history
  uint256 private s_writeIndex

Functions:
  getWETHPrice() → uint256 price18
    _recordPrice()
    compute TWAP from s_history within TWAP_PERIOD
    revert if latest > MAX_STALENESS

  getSpotPrice() view → uint256 price18
    read latest from Chainlink, convert to 1e18

  _recordPrice() internal
    fetch from Chainlink
    store in circular buffer

  _getLatestRoundData() internal view → (uint256 price, uint256 timestamp)
    call i_feed.latestRoundData()
    convert 8-decimal Chainlink price to 18-decimal

Interface needed:
  import "@chainlink/contracts/src/v0.8/interfaces/AggregatorV3Interface.sol"
  npm install @chainlink/contracts
```

### Step 10 — `contracts/junior/AaveWETHAdapter.sol`

```
State:
  address public immutable i_weth
  address public immutable i_aweth
  address public immutable i_aavePool
  address public immutable i_primeCDO
  address public immutable i_priceOracle   // WETHPriceOracle

Modifier:
  onlyCDO: require(msg.sender == i_primeCDO)

Functions:
  supply(uint256 wethAmount) onlyCDO → uint256 aWethReceived
    before = IERC20(i_aweth).balanceOf(this)
    IERC20(i_weth).transferFrom(msg.sender, this, wethAmount)
    IERC20(i_weth).approve(i_aavePool, wethAmount)
    IPool(i_aavePool).supply(i_weth, wethAmount, this, 0)
    return IERC20(i_aweth).balanceOf(this) - before

  withdraw(uint256 wethAmount, address to) onlyCDO → uint256
    return IPool(i_aavePool).withdraw(i_weth, wethAmount, to)

  withdrawAll(address to) onlyCDO → uint256
    total = IERC20(i_aweth).balanceOf(this)
    return IPool(i_aavePool).withdraw(i_weth, total, to)

  totalAssets() view → uint256
    return IERC20(i_aweth).balanceOf(this)

  totalAssetsUSD() view → uint256
    return totalAssets() * IWETHPriceOracle(i_priceOracle).getSpotPrice() / 1e18
    NOTE: uses spot for view, TWAP for state-changing calls

  currentAPR() view → uint256
    data = IPool(i_aavePool).getReserveData(i_weth)
    return data.currentLiquidityRate / 1e9

Interface needed:
  Aave v3 IPool interface (supply, withdraw, getReserveData)
  npm install @aave/v3-core (or copy interface only)
```

### Step 11 — `contracts/junior/SwapFacility.sol`

```
State:
  ISwapRouter public immutable i_uniswapRouter   // Uniswap V3
  address public immutable i_weth
  address public immutable i_primeCDO
  uint256 public s_maxSlippage           // default: 0.01e18 (1%)
  uint256 public s_emergencySlippage     // default: 0.10e18 (10%)
  mapping(address => bytes) public s_swapPaths  // outputToken → swap path

Modifier:
  onlyCDO

Functions:
  swapWETHFor(address outputToken, uint256 wethAmount, uint256 minOut) onlyCDO → uint256
    IERC20(i_weth).transferFrom(msg.sender, this, wethAmount)
    IERC20(i_weth).approve(i_uniswapRouter, wethAmount)
    params = ISwapRouter.ExactInputParams({
      path: s_swapPaths[outputToken],
      recipient: msg.sender,
      deadline: block.timestamp,
      amountIn: wethAmount,
      amountOutMinimum: minOut
    })
    return i_uniswapRouter.exactInput(params)

  swapForWETH(address inputToken, uint256 amount, uint256 minWethOut) onlyCDO → uint256
    // reverse swap path
    similar to above but reversed

  getMinOutput(uint256 wethAmount, uint256 wethPrice, bool isEmergency) view → uint256
    expectedUSD = wethAmount * wethPrice / 1e18
    slippage = isEmergency ? s_emergencySlippage : s_maxSlippage
    return expectedUSD * (1e18 - slippage) / 1e18

  setSwapPath(address token, bytes calldata path) onlyOwner
  setSlippage(uint256 max, uint256 emergency) onlyOwner

Interface needed:
  Uniswap V3 ISwapRouter
  npm install @uniswap/v3-periphery (or copy interface)
```

---

## Phase 5: Cooldown System

### Step 12 — `contracts/cooldown/ERC20Cooldown.sol`

```
Implement full ICooldownHandler.

State:
  uint256 private s_nextRequestId
  mapping(uint256 => CooldownRequest) private s_requests
  mapping(address => uint256[]) private s_userRequests
  mapping(address => uint256) public s_cooldownDuration    // per token
  mapping(address => uint256) public s_claimWindow         // per token, 0 = no expiry
  mapping(address => bool) public s_authorized

Inherits: ICooldownHandler, Ownable2Step

Functions:
  setCooldownDuration(address token, uint256 duration) onlyOwner
  setClaimWindow(address token, uint256 window) onlyOwner
  setAuthorized(address caller, bool auth) onlyOwner
  request(...) onlyAuthorized → requestId
  claim(requestId) → amountOut
  isClaimable(requestId) view → bool
  getRequest(requestId) view → CooldownRequest
  getPendingRequests(address) view → uint256[]
  timeRemaining(requestId) view → uint256
```

### Step 13 — `contracts/cooldown/UnstakeCooldown.sol`

```
Same pattern as ERC20Cooldown but delegates to ICooldownRequestImpl.

Additional state:
  mapping(address => address) public s_implementations  // yieldToken → impl
  mapping(uint256 => address) private s_requestImpl     // requestId → impl

Key difference from ERC20Cooldown:
  request(): calls impl.initiateCooldown()
  claim(): calls impl.finalizeCooldown()
  isClaimable(): calls impl.isCooldownComplete()
```

### Step 14 — `contracts/cooldown/SharesCooldown.sol`

```
Similar to ERC20Cooldown but:
  - Locks vault shares (not regular tokens)
  - claim() returns shares to vault (not to user directly)
  - Vault then burns shares at CURRENT rate

State difference:
  struct SharesRequest { beneficiary, vault, shares, requestTime, unlockTime, status }
  mapping(address => uint256) public s_cooldownDuration  // per vault address
```

### Step 15 — `contracts/cooldown/RedemptionPolicy.sol`

```
State:
  enum CooldownType { NONE, ASSETS_LOCK, SHARES_LOCK, UNSTAKE }
  struct RedemptionCondition { CooldownType cooldownType; uint256 cooldownDuration; uint256 feeBps; }
  struct CoverageRange { uint256 minCoverage; uint256 maxCoverage; RedemptionCondition condition; }

  mapping(uint8 => CoverageRange[]) public s_ranges     // trancheId → ranges
  mapping(uint8 => RedemptionCondition) public s_defaultCondition
  address public i_accounting

Functions:
  setRanges(uint8 trancheId, CoverageRange[] calldata) onlyOwner
  setDefaultCondition(uint8, RedemptionCondition calldata) onlyOwner
  getCondition(uint8 trancheId, uint256 currentCoverage) view → RedemptionCondition
  getCurrentCoverage() view → uint256
```

### Step 16 — `contracts/strategies/implementations/cooldown/SUSDeCooldownRequestImpl.sol`

```
State:
  address public immutable i_sUSDe
  address public immutable i_USDe

Implements ICooldownRequestImpl:
  initiateCooldown(shares, receiver) → cooldownDuration
    IStakedUSDe(i_sUSDe).cooldownShares(shares)
    return IStakedUSDe(i_sUSDe).cooldownDuration()

  finalizeCooldown(receiver) → amountOut
    IStakedUSDe(i_sUSDe).unstake(receiver)
    return IERC20(i_USDe).balanceOf(receiver)

  isCooldownComplete() view → bool
    return IStakedUSDe(i_sUSDe).cooldownEnd(this) <= block.timestamp

Interface needed: IStakedUSDe (Ethena's sUSDe interface)
```

---

## Phase 6: Strategy

### Step 17 — `contracts/strategies/BaseStrategy.sol`

```
State:
  address public immutable i_primeCDO
  address public immutable i_baseAsset
  address public s_erc20Cooldown
  address public s_unstakeCooldown

Inherits: Ownable2Step, Pausable, IStrategy

Modifier: onlyCDO

Routing functions:
  deposit(uint256) external onlyCDO whenNotPaused → _deposit(amount)
  depositToken(address, uint256) external onlyCDO whenNotPaused → _depositToken(token, amount)
  withdraw(uint256, address, address) external onlyCDO → _withdraw(amount, outputToken, beneficiary)
  emergencyWithdraw() external onlyCDO → _emergencyWithdraw()

Helper functions:
  _lockInERC20Cooldown(token, amount, beneficiary) internal → WithdrawResult
  _lockInUnstakeCooldown(yieldToken, shares, beneficiary) internal → WithdrawResult

Abstract:
  _deposit(uint256) internal virtual → uint256
  _depositToken(address, uint256) internal virtual → uint256
  _withdraw(uint256, address, address) internal virtual → WithdrawResult
  _emergencyWithdraw() internal virtual → uint256
  _isSupported(address) internal view virtual → bool

Admin:
  setCooldownContracts(address erc20, address unstake) onlyOwner
  pause() / unpause() onlyOwner
```

### Step 18 — `contracts/strategies/implementations/SUSDeStrategy.sol`

```
State:
  address public immutable i_sUSDe
  address public immutable i_USDe
  uint256 public s_totalShares         // sUSDe shares held

Inherits: BaseStrategy

Constructor: BaseStrategy(primeCDO, USDe), set i_sUSDe, i_USDe

Implement:
  _deposit(uint256 amount) → uint256
    IERC20(i_baseAsset).transferFrom(i_primeCDO, this, amount)
    IERC20(i_baseAsset).approve(i_sUSDe, amount)
    shares = IERC4626(i_sUSDe).deposit(amount, this)
    s_totalShares += shares
    return shares

  _depositToken(address token, uint256 amount) → uint256
    if token == i_USDe: same as _deposit
    if token == i_sUSDe:
      IERC20(i_sUSDe).transferFrom(i_primeCDO, this, amount)
      s_totalShares += amount
      return amount
    revert UnsupportedToken

  _withdraw(uint256 amount, address outputToken, address beneficiary) → WithdrawResult
    shares = IERC4626(i_sUSDe).convertToShares(amount)
    s_totalShares -= shares

    if outputToken == i_sUSDe:
      IERC20(i_sUSDe).transfer(beneficiary, shares)
      return WithdrawResult(INSTANT, shares, 0, address(0), 0)

    if outputToken == i_USDe:
      return _lockInUnstakeCooldown(i_sUSDe, shares, beneficiary)

    revert UnsupportedToken

  _emergencyWithdraw() → uint256
    shares = s_totalShares
    s_totalShares = 0
    return IERC4626(i_sUSDe).redeem(shares, i_primeCDO, this)

  totalAssets() view → uint256
    return IERC4626(i_sUSDe).convertToAssets(s_totalShares)

  baseAsset() view → address: return i_USDe
  supportedTokens() view → [i_USDe, i_sUSDe]
  predictWithdrawType(token) view: sUSDe→INSTANT, USDe→UNSTAKE
  name() pure → "SUSDeStrategy"
  isActive() view → !paused()
```

---

## Phase 7: Integration — PrimeCDO

### Step 19 — `contracts/core/PrimeCDO.sol`

```
THIS IS THE LARGEST CONTRACT. Build incrementally.

State:
  // Core
  address public immutable i_accounting
  address public immutable i_strategy
  address public immutable i_redemptionPolicy
  address public immutable i_sharesCooldown
  address public s_erc20Cooldown

  // Junior WETH
  address public immutable i_aaveWETHAdapter
  address public immutable i_swapFacility
  address public immutable i_weth
  address public immutable i_wethOracle

  // Ratio (fixed 8:2 with upgrade hook)
  uint256 public s_ratioTarget         // 0.20e18
  uint256 public s_ratioTolerance      // 0.02e18
  address public s_ratioController     // address(0) at launch

  // Coverage gates
  uint256 public s_minCoverageForDeposit         // 1.05e18
  uint256 public s_minCoverageForJuniorRedeem    // 1.05e18
  uint256 public s_juniorShortfallPausePrice     // 0.90e18
  bool public s_shortfallPaused

  // Tranches
  mapping(TrancheId => address) public s_tranches

Inherits: Ownable2Step

Modifiers:
  onlyTranche(TrancheId)
  notShortfallPaused: require(!s_shortfallPaused)

Build in this order:
  19a. Internal helpers:
    _getTargetRatio() → fixed or dynamic
    _getTolerance(target) → fixed or relative
    _getCoverage() → coverage ratio
    _checkJuniorShortfall() → auto-pause check

  19b. Senior/Mezz deposit:
    deposit(TrancheId, address, uint256) → uint256
    → shortfall check → updateTVL → coverage gate → route to strategy → record

  19c. Junior deposit:
    depositJunior(baseToken, baseAmount, wethAmount, depositor) → uint256
    → shortfall check → updateTVL → validate ratio → route base to strategy → route WETH to Aave → record

  19d. Senior/Mezz withdraw:
    requestWithdraw(TrancheId, ...) → CDOWithdrawResult
    → shortfall check → updateTVL → coverage gate (Jr only) → RedemptionPolicy → route

  19e. Junior withdraw:
    withdrawJunior(...) → CDOWithdrawResult
    → shortfall check → updateTVL → coverage gate → proportional WETH → base cooldown flow

  19f. Claim:
    claimWithdraw(cooldownId, handler) → uint256
    claimSharesWithdraw(TrancheId, cooldownId, outputToken, beneficiary) → uint256
    instantWithdraw(TrancheId, amount, outputToken, receiver) → uint256

  19g. Loss coverage:
    executeWETHCoverage(lossUSD)
    → withdraw from Aave → swap → inject into strategy

  19h. Rebalance:
    rebalanceSellWETH() → permissionless
    rebalanceBuyWETH(maxBaseToRecall) → onlyOwner

  19i. Admin:
    setTranche(TrancheId, address) onlyOwner
    setRatioTarget(uint256) onlyOwner
    setRatioTolerance(uint256) onlyOwner
    setRatioController(address) onlyOwner
    setMinCoverageForDeposit(uint256) onlyOwner
    setMinCoverageForJuniorRedeem(uint256) onlyOwner
    setJuniorShortfallPausePrice(uint256) onlyOwner
    unpauseShortfall() onlyOwner
```

---

## Phase 8: Vault

### Step 20 — `contracts/core/TrancheVault.sol`

```
State:
  IPrimeCDO public immutable i_cdo
  TrancheId public immutable i_trancheId
  address public immutable i_weth       // needed for Junior deposit

  struct PendingWithdraw {
    uint256 cooldownId
    address cooldownHandler
    uint256 unlockTime
    address outputToken
    uint256 shares
    uint256 lockedShares
    uint8 cooldownType
  }
  mapping(address => PendingWithdraw[]) public s_pendingWithdraws

Inherits: ERC4626, Pausable

Functions:
  totalAssets() view override → uint256
    return IAccounting(i_cdo.accounting()).getTrancheTVL(i_trancheId)

  // ─── Standard deposit (Senior/Mezz) ─────────────────────
  deposit(uint256, address) override → uint256
  depositToken(address token, uint256 assets, address receiver) → uint256

  // ─── Junior deposit ──────────────────────────────────────
  depositJunior(address baseToken, uint256 baseAmount, uint256 wethAmount, address receiver) → uint256
    require(i_trancheId == JUNIOR)
    pull baseToken + WETH from user
    forward to CDO.depositJunior()
    mint shares

  // ─── Withdraw request ────────────────────────────────────
  requestWithdraw(uint256 shares, address outputToken, address receiver, address owner) → CDOWithdrawResult
    handle: instant (burn+transfer) vs cooldown (burn/lock + store pending)

  requestWithdrawJunior(uint256 shares, address outputToken, address receiver, address owner) → CDOWithdrawResult
    require(i_trancheId == JUNIOR)
    CDO handles WETH portion

  // ─── Withdraw claim ──────────────────────────────────────
  claimWithdraw(uint256 requestIndex) → uint256

  // ─── Preview ─────────────────────────────────────────────
  previewWithdraw(uint256 shares) view → (cooldownType, duration, feeBps)
  getPendingWithdraws(address user) view → PendingWithdraw[]
```

---

## Phase 9: Periphery

### Step 21 — `contracts/periphery/PrimeLens.sol`

```
Read-only contract. No state changes. Aggregates data for frontend.

Constructor: addresses of all contracts

Functions:
  getTrancheInfo(TrancheId) → (tvl, sharePrice, totalShares, apr)
  getAllTranches() → (senior, mezz, junior)
  getJuniorPosition() → (baseTVL, wethTVL, wethBalance, wethPrice, ratio)
  getProtocolHealth() → (coverage, isPaused, shortfallPaused)
  getSupportedTokens() → address[]
  getUserPendingWithdraws(address) → (senior[], mezz[], junior[])
  previewWithdrawCondition(TrancheId) → (cooldownType, duration, feeBps, coverage)
  getClaimableWithdraws(address, TrancheId) → uint256[]
  getWETHRebalanceStatus() → (currentRatio, target, tolerance, needsRebalance)
```

---

## Phase 10: Unit Tests

### Step 22 — Test helpers

```
test/helpers/
  deploy.ts         — deploy full stack helper
  fixtures.ts       — hardhat fixtures for common setups
  constants.ts      — default params, addresses
  mocks/
    MockStrategy.sol       — simple strategy for testing
    MockERC4626.sol        — mock sUSDe vault
    MockAavePool.sol       — mock Aave v3
    MockChainlinkFeed.sol  — mock price feed
    MockSwapRouter.sol     — mock Uniswap V3
```

### Step 23 — Accounting tests

```
test/unit/Accounting.test.ts

Tests:
  - updateTVL: positive gain → Senior gets target, Junior gets rest
  - updateTVL: positive gain < Senior target → Senior gets all
  - updateTVL: negative gain → loss waterfall (4 layers)
  - Senior APR computation with different ratios
  - RP1/RP2 curve outputs match expected values
  - Reserve cut calculation
  - Target index compound accumulation
  - Edge: Jr TVL = 0
  - Edge: all TVLs = 0 (empty protocol)
  - Access control: only CDO can call
```

### Step 24 — Strategy tests

```
test/unit/SUSDeStrategy.test.ts

Tests:
  - deposit USDe → receives sUSDe shares
  - deposit sUSDe → direct transfer
  - withdraw sUSDe → instant
  - withdraw USDe → unstake cooldown
  - totalAssets reflects sUSDe exchange rate
  - emergencyWithdraw returns all
  - Access control: only CDO
  - Pause/unpause
```

### Step 25 — Cooldown tests

```
test/unit/ERC20Cooldown.test.ts
test/unit/UnstakeCooldown.test.ts
test/unit/SharesCooldown.test.ts

Tests each:
  - request → creates pending
  - claim before unlock → revert
  - claim after unlock → success
  - claim twice → revert
  - expiry window
  - getPendingRequests
  - timeRemaining
  - Authorization checks
```

### Step 26 — Coverage gate tests

```
test/unit/CoverageGate.test.ts

Tests:
  - Sr deposit blocked below 105% coverage
  - Mz deposit blocked below 105% coverage
  - Jr deposit always allowed (even at 100%)
  - Jr withdraw blocked below 105% coverage
  - Sr/Mz withdraw always allowed (with cooldown)
  - Shortfall auto-pause: Jr price drops below 90%
  - Shortfall blocks all actions
  - unpauseShortfall: governance only
  - Edge: Jr TVL = 0, pool > 0 → coverage = 0 → block Sr/Mz deposit
```

### Step 27 — Rebalance tests

```
test/unit/Rebalance.test.ts

Tests:
  - rebalanceSellWETH: ratio above upper → sells WETH → injects base
  - rebalanceSellWETH: ratio within bounds → revert
  - rebalanceSellWETH: permissionless (anyone can call)
  - rebalanceBuyWETH: governance only
  - rebalanceBuyWETH: respects maxBaseToRecall cap
  - rebalanceBuyWETH: not governance → revert
```

### Step 28 — Vault tests

```
test/unit/TrancheVault.test.ts

Tests:
  - deposit → mint correct shares
  - totalAssets reads from Accounting
  - sharePrice increases with yield
  - requestWithdraw instant → burn + transfer
  - requestWithdraw cooldown → burn + store pending
  - claimWithdraw after cooldown
  - Junior deposit: validates 8:2 ratio
  - Junior deposit: rejects wrong ratio
  - Junior withdraw: returns proportional WETH
```

---

## Phase 11: Integration Tests

### Step 29 — Full flow integration

```
test/integration/FullFlow.test.ts

Fork mainnet. Use real sUSDe, Aave, Uniswap.

Tests:
  1. Deploy full stack
  2. User A deposits $10K into Senior
  3. User B deposits $5K into Mezz
  4. User C deposits $8K USDe + 0.67 WETH into Junior
  5. Advance time 7 days
  6. Verify: share prices increased
  7. Verify: Senior APR ≈ expected
  8. User A withdraws (instant at high coverage)
  9. User C withdraws Junior (gets base + WETH)
  10. Verify: all TVLs balance
```

### Step 30 — Loss scenario integration

```
test/integration/LossScenario.test.ts

Tests:
  1. Deploy + deposit into all tranches
  2. Simulate strategy loss (mock sUSDe depeg)
  3. Verify: WETH buffer sold first
  4. Verify: Junior base absorbs remainder
  5. Verify: Senior/Mezz unaffected
  6. Verify: shortfall pause triggers if loss > 10%
  7. Governance unpause
  8. Verify: protocol resumes
```

---

## Phase 12: Deployment

### Step 31 — Deploy script

```
deploy/01_deploy_shared.ts
  1. RiskParams
  2. WETHPriceOracle
  3. SwapFacility
  4. ERC20Cooldown
  5. UnstakeCooldown
  6. SharesCooldown

deploy/02_deploy_ethena_market.ts
  7. AprPairFeed + AaveAprProvider
  8. Accounting
  9. SUSDeStrategy
  10. SUSDeCooldownRequestImpl → register in UnstakeCooldown
  11. AaveWETHAdapter
  12. RedemptionPolicy
  13. PrimeCDO
  14. TrancheVault × 3

deploy/03_configure.ts
  15. Register vaults in PrimeCDO
  16. Authorize CDO + strategy in cooldown contracts
  17. Set cooldown durations
  18. Configure RedemptionPolicy ranges
  19. Set coverage gate params
  20. Set WETH ratio params
```

### Step 32 — Verify & sanity check script

```
scripts/verify-deployment.ts
  - Read all params, verify correct
  - Check all access control
  - Test deposit $1 into each tranche
  - Test withdraw $1 from each tranche
  - Verify PrimeLens returns correct data
```

---

## Implementation Priority

```
MUST HAVE (MVP):
  ✓ All interfaces (Step 3)
  ✓ Accounting + FixedPointMath (Step 7-8)
  ✓ SUSDeStrategy (Step 17-18)
  ✓ PrimeCDO (Step 19)
  ✓ TrancheVault (Step 20)
  ✓ AaveWETHAdapter (Step 10)
  ✓ WETHPriceOracle (Step 9)
  ✓ Coverage gates (in PrimeCDO)
  ✓ Unit tests (Step 22-28)

SHOULD HAVE (before audit):
  ✓ ERC20Cooldown (Step 12)
  ✓ UnstakeCooldown (Step 13)
  ✓ SharesCooldown (Step 14)
  ✓ RedemptionPolicy (Step 15)
  ✓ SwapFacility (Step 11)
  ✓ Integration tests (Step 29-30)

NICE TO HAVE (after audit):
  ✓ PrimeLens (Step 21)
  ✓ RatioController (future upgrade)
  ✓ Additional strategy implementations
```

---

## Estimated Effort

```
Phase 1-2: Setup + Interfaces        1 day
Phase 3: Core (Accounting + Math)     3 days  ← hardest part
Phase 4: Junior WETH                  2 days
Phase 5: Cooldown                     2 days
Phase 6: Strategy                     1 day
Phase 7: PrimeCDO                     3 days  ← second hardest
Phase 8: Vault                        2 days
Phase 9: Periphery                    1 day
Phase 10: Unit tests                  3 days
Phase 11: Integration tests           2 days
Phase 12: Deploy scripts              1 day
────────────────────────────────────
Total estimate:                       ~21 days
```

---

_PrimeVaults V3 — MVP Implementation Plan v3.4.1_  
_For use with Claude Code_  
_March 2026_
