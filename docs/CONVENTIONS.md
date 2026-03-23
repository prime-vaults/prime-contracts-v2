# PrimeVaults V3 — Coding Conventions & Style Guide

**Purpose:** Prepend to Claude Code context. Every generated file MUST follow these rules.  
**File:** `docs/CONVENTIONS.md` — Claude Code reads this before every task.

---

## 1. Solidity Naming

### Contracts & Interfaces

```solidity
// Interface: prefix "I", PascalCase
interface IStrategy { }
interface ICooldownHandler { }
interface IPrimeCDO { }

// Abstract: suffix describes purpose, PascalCase
abstract contract BaseStrategy { }

// Concrete: PascalCase, descriptive
contract Accounting { }
contract PrimeCDO { }
contract TrancheVault { }
contract SUSDeStrategy { }
```

### State Variables

```solidity
// Immutable: prefix "i_", camelCase
address public immutable i_primeCDO;
address public immutable i_strategy;
address public immutable i_weth;

// Storage: prefix "s_", camelCase
uint256 public s_seniorTVL;
uint256 public s_ratioTarget;
mapping(address => uint256) private s_userBalances;
mapping(TrancheId => address) public s_tranches;

// Constants: UPPER_SNAKE_CASE
uint256 public constant MAX_BPS = 10_000;
uint256 public constant PRECISION = 1e18;
uint256 public constant TWAP_PERIOD = 30 minutes;

// No prefix for local/memory variables: camelCase
uint256 currentRatio = _getCurrentWethRatio();
uint256 seniorGainTarget = s_seniorTVL * aprSr * deltaT / (365 days * PRECISION);
```

### Functions

```solidity
// External/public: camelCase, verb-first, descriptive
function deposit(uint256 amount) external returns (uint256 shares);
function requestWithdraw(uint256 shares, address outputToken) external;
function claimWithdraw(uint256 requestIndex) external returns (uint256 amountOut);
function rebalanceSellWETH() external;
function getTargetRatio() external view returns (uint256);

// Internal/private: prefix "_", camelCase
function _computeSeniorAPR() internal view returns (uint256);
function _handleLoss(uint256 loss) internal;
function _checkJuniorShortfall() internal;
function _getCoverage() internal view returns (uint256);

// Pure helpers: prefix "_", descriptive
function _fpow(uint256 base, uint256 exp) internal pure returns (uint256);
function _min(uint256 a, uint256 b) internal pure returns (uint256);
```

### Events

```solidity
// PascalCase, past tense or descriptive noun
event Deposited(address indexed user, TrancheId indexed tranche, uint256 amount, uint256 shares);
event WithdrawRequested(address indexed user, uint256 cooldownId, uint256 unlockTime);
event WithdrawClaimed(address indexed user, uint256 amountOut);
event WETHCoverageExecuted(uint256 wethSold, uint256 underlyingReceived, uint256 lossUSD);
event RebalanceSellExecuted(uint256 wethSold, uint256 baseReceived);
event ShortfallPauseTriggered(uint256 pricePerShare, uint256 threshold);
event CoverageGateBlocked(TrancheId tranche, uint256 coverage, uint256 minimum);
```

### Errors

```solidity
// PascalCase, prefix "PrimeVaults__", descriptive
error PrimeVaults__Unauthorized(address caller);
error PrimeVaults__ZeroAmount();
error PrimeVaults__UnsupportedToken(address token);
error PrimeVaults__CoverageTooLow(uint256 current, uint256 minimum);
error PrimeVaults__RatioOutOfBounds(uint256 actual, uint256 target, uint256 tolerance);
error PrimeVaults__ShortfallPaused();
error PrimeVaults__CooldownNotReady(uint256 unlockTime);
error PrimeVaults__AlreadyClaimed(uint256 requestId);
error PrimeVaults__InvalidTrancheId();
error PrimeVaults__StaleApr(uint256 lastUpdated, uint256 staleAfter);
```

### Enums & Structs

```solidity
// Enum: PascalCase, members UPPER_CASE or PascalCase
enum TrancheId { SENIOR, MEZZ, JUNIOR }
enum WithdrawType { INSTANT, ASSETS_LOCK, UNSTAKE }
enum CooldownStatus { NONE, PENDING, CLAIMABLE, CLAIMED, EXPIRED }

// Struct: PascalCase, members camelCase
struct WithdrawResult {
    WithdrawType wType;
    uint256 amountOut;
    uint256 cooldownId;
    address cooldownHandler;
    uint256 unlockTime;
}

struct PremiumCurve {
    uint256 x;
    uint256 y;
    uint256 k;
}
```

---

## 2. Formatting — Horizontal Priority

### Line width

Target: **120 characters**. Không xuống dòng sớm. Prefer đọc ngang.

```solidity
// ✓ GOOD — fits on one line, easy to scan
function deposit(TrancheId tranche, address token, uint256 amount) external onlyTranche(tranche) returns (uint256 baseAmount) {

// ✗ BAD — broken too early, wastes vertical space
function deposit(
    TrancheId tranche,
    address token,
    uint256 amount
)
    external
    onlyTranche(tranche)
    returns (uint256 baseAmount)
{
```

Chỉ xuống dòng khi **thực sự** vượt 120 chars:

```solidity
// ✓ OK to break — genuinely long
function requestWithdraw(
    TrancheId tranche, uint256 baseAmount, address outputToken, address beneficiary, uint256 vaultShares
) external onlyTranche(tranche) returns (CDOWithdrawResult memory result) {
```

### Function body — logical blocks with spacing

```solidity
function updateTVL(uint256 currentStrategyTVL, uint256 currentWethValueUSD) external onlyCDO {
    uint256 prevTotalTVL = s_seniorTVL + s_mezzTVL + s_juniorBaseTVL + s_reserveTVL;
    int256 strategyGain = int256(currentStrategyTVL) - int256(prevTotalTVL);

    // Reserve cut — only on positive gains
    uint256 reserveCut = 0;
    if (strategyGain > 0) {
        reserveCut = uint256(strategyGain) * s_reserveBps / MAX_BPS;
        s_reserveTVL += reserveCut;
    }

    // Net gain after reserve
    int256 netGain = strategyGain - int256(reserveCut);

    // Senior target gain
    uint256 deltaT = block.timestamp - s_lastUpdateTimestamp;
    uint256 seniorAPR = _computeSeniorAPR();
    uint256 seniorGainTarget = s_seniorTVL * seniorAPR * deltaT / (365 days * PRECISION);

    // Gain distribution
    if (netGain >= 0 && uint256(netGain) >= seniorGainTarget) {
        s_seniorTVL += seniorGainTarget;
        s_juniorBaseTVL += uint256(netGain) - seniorGainTarget;
    } else if (netGain >= 0) {
        s_seniorTVL += uint256(netGain);
    } else {
        _handleLoss(uint256(-netGain));
    }

    // WETH value update — separate from strategy gain
    s_juniorWethTVL = currentWethValueUSD;

    // Update compound index
    s_srtTargetIndex = s_srtTargetIndex * (PRECISION + seniorAPR * deltaT / 365 days) / PRECISION;
    s_lastUpdateTimestamp = block.timestamp;
}
```

Rules:

- Blank line giữa mỗi logical block
- Comment ngắn ở đầu mỗi block giải thích **what** (không giải thích **how** — code tự nói)
- Không blank line giữa các dòng liên quan chặt (e.g. `if` và body)
- Dùng `// ──────────` separator cho major sections trong contract dài

### Contract-level sections

```solidity
contract PrimeCDO is Ownable2Step, IPrimeCDO {
    // ═══════════════════════════════════════════════════════════════════
    //  CONSTANTS
    // ═══════════════════════════════════════════════════════════════════

    uint256 public constant MAX_BPS = 10_000;
    uint256 public constant PRECISION = 1e18;

    // ═══════════════════════════════════════════════════════════════════
    //  IMMUTABLES
    // ═══════════════════════════════════════════════════════════════════

    address public immutable i_accounting;
    address public immutable i_strategy;

    // ═══════════════════════════════════════════════════════════════════
    //  STATE
    // ═══════════════════════════════════════════════════════════════════

    uint256 public s_ratioTarget;
    bool public s_shortfallPaused;
    mapping(TrancheId => address) public s_tranches;

    // ═══════════════════════════════════════════════════════════════════
    //  EVENTS
    // ═══════════════════════════════════════════════════════════════════

    event Deposited(address indexed user, TrancheId indexed tranche, uint256 amount);

    // ═══════════════════════════════════════════════════════════════════
    //  ERRORS
    // ═══════════════════════════════════════════════════════════════════

    error PrimeVaults__Unauthorized(address caller);

    // ═══════════════════════════════════════════════════════════════════
    //  MODIFIERS
    // ═══════════════════════════════════════════════════════════════════

    modifier onlyTranche(TrancheId id) {
        if (msg.sender != s_tranches[id]) revert PrimeVaults__Unauthorized(msg.sender);
        _;
    }

    // ═══════════════════════════════════════════════════════════════════
    //  CONSTRUCTOR
    // ═══════════════════════════════════════════════════════════════════

    constructor(...) { }

    // ═══════════════════════════════════════════════════════════════════
    //  DEPOSIT
    // ═══════════════════════════════════════════════════════════════════

    /// @notice ...
    function deposit(...) { }

    // ═══════════════════════════════════════════════════════════════════
    //  WITHDRAW
    // ═══════════════════════════════════════════════════════════════════

    /// @notice ...
    function requestWithdraw(...) { }

    // ═══════════════════════════════════════════════════════════════════
    //  INTERNAL
    // ═══════════════════════════════════════════════════════════════════

    function _getCoverage() internal view returns (uint256) { }

    // ═══════════════════════════════════════════════════════════════════
    //  ADMIN
    // ═══════════════════════════════════════════════════════════════════

    function setRatioTarget(uint256 target) external onlyOwner { }
}
```

### Mapping & array — one-liner when possible

```solidity
// ✓ GOOD
mapping(address => uint256) public s_cooldownDuration;
mapping(uint256 => CooldownRequest) private s_requests;

// ✗ BAD — don't break mappings across lines
mapping(
    address => uint256
) public s_cooldownDuration;
```

### Require / revert — inline khi ngắn

```solidity
// ✓ GOOD — short check, one line
if (amount == 0) revert PrimeVaults__ZeroAmount();
if (msg.sender != i_primeCDO) revert PrimeVaults__Unauthorized(msg.sender);
if (coverage < s_minCoverageForDeposit) revert PrimeVaults__CoverageTooLow(coverage, s_minCoverageForDeposit);

// ✗ BAD
require(amount > 0, "amount must be greater than zero");
```

Dùng custom errors, không dùng `require(condition, "string")`. Custom errors tiết kiệm gas và structured hơn.

### Numbers — underscores for readability

```solidity
// ✓ GOOD
uint256 public constant MAX_BPS = 10_000;
uint256 public constant PRECISION = 1e18;
uint256 defaultAlpha = 0.60e18;
uint256 maxRP1 = 0.80e18;

// ✗ BAD
uint256 public constant MAX_BPS = 10000;
```

---

## 3. NatSpec Documentation

### Every external/public function MUST have NatSpec

```solidity
/// @notice Deposit base asset into a Senior or Mezzanine tranche
/// @dev Updates accounting before processing. Checks coverage gate for Sr/Mz deposits.
///      Reverts if coverage below s_minCoverageForDeposit (105% default).
///      Reverts if protocol is shortfall-paused.
/// @param tranche Target tranche (SENIOR or MEZZ — Junior uses depositJunior)
/// @param token Deposit token address (must be in strategy.supportedTokens())
/// @param amount Token amount to deposit
/// @return baseAmount Base-asset-equivalent value deposited (used for share calculation)
function deposit(TrancheId tranche, address token, uint256 amount) external onlyTranche(tranche) returns (uint256 baseAmount) {
```

### Rules

```
@notice  — ONE sentence. What does this function do? (for users)
@dev     — Implementation details, side effects, reverts. (for developers)
           Multi-line OK. Include:
           - What state changes
           - When it reverts (and why)
           - Cross-references to other functions it calls
           - AUDIT NOTEs if applicable
@param   — ONE line per param. Name + what it is.
@return  — ONE line per return value. Name + what it is.
```

### Internal functions — lighter NatSpec

```solidity
/// @dev Compute Senior APR from risk premium curves and APR feed
///      Formula: APR_sr = MAX(APR_target, APR_base × (1 - RP1 - alpha × RP2))
///      See docs/PV_V3_MATH_REFERENCE.md section E5
function _computeSeniorAPR() internal view returns (uint256) {
```

Internal functions: `@dev` only (no `@notice`, no `@param`). Inline formula reference where applicable.

### Events — document what triggers them

```solidity
/// @notice Emitted when WETH is sold to cover strategy loss
/// @param wethSold Amount of WETH withdrawn from Aave and sold
/// @param underlyingReceived Amount of base asset received from swap
/// @param lossUSD Total USD loss that triggered the coverage
event WETHCoverageExecuted(uint256 wethSold, uint256 underlyingReceived, uint256 lossUSD);
```

### Errors — document when they're thrown

```solidity
/// @notice Thrown when coverage ratio is below minimum for the requested action
/// @param current Current coverage ratio (1e18 = 100%)
/// @param minimum Required minimum coverage ratio
error PrimeVaults__CoverageTooLow(uint256 current, uint256 minimum);
```

### Structs — document each field

```solidity
/// @notice Tracks a pending withdrawal request
struct PendingWithdraw {
    uint256 cooldownId;        // ID in the cooldown handler contract (0 if instant)
    address cooldownHandler;   // ICooldownHandler contract address
    uint256 unlockTime;        // Timestamp when claimable (0 if instant)
    address outputToken;       // Token user wants to receive
    uint256 shares;            // Vault shares burned at request time (AssetsLock/Unstake)
    uint256 lockedShares;      // Vault shares escrowed, not burned (SharesLock only)
    uint8 cooldownType;        // RedemptionPolicy.CooldownType applied
}
```

### Contract-level NatSpec

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title PrimeCDO
/// @author PrimeVaults Team
/// @notice Core orchestrator for a PrimeVaults market. Connects one Strategy
///         to three TrancheVaults (Senior, Mezzanine, Junior) via Accounting.
///         Handles deposit routing, withdrawal with coverage-aware cooldown,
///         Junior dual-asset (base + WETH) management, loss coverage, and rebalancing.
/// @dev    1 CDO = 1 Strategy (Strata model). No StrategyRegistry.
///         Fixed 8:2 WETH ratio at launch with pre-wired dynamic upgrade hook.
///         Asymmetric rebalance: sell WETH permissionless, buy WETH governance-only.
///         Coverage gates: block Sr/Mz deposit below 105%, block Jr withdraw below 105%.
///         See docs/PV_V3_FINAL_v34.md section 18 for full specification.
contract PrimeCDO is Ownable2Step, IPrimeCDO {
```

---

## 4. Test Conventions

### File naming

```
test/unit/Accounting.test.ts
test/unit/SUSDeStrategy.test.ts
test/unit/PrimeCDO.deposit.test.ts      // split large contracts
test/unit/PrimeCDO.withdraw.test.ts
test/unit/PrimeCDO.rebalance.test.ts
test/unit/CoverageGate.test.ts
test/integration/FullFlow.test.ts
test/integration/LossScenario.test.ts
```

### Test structure

```typescript
describe("Accounting", () => {
  // ═══════════════════════════════════════════════════════════════
  //  SETUP
  // ═══════════════════════════════════════════════════════════════

  let accounting: Accounting;
  let mockCDO: SignerWithAddress;

  beforeEach(async () => {
    // deploy fresh instance per test
  });

  // ═══════════════════════════════════════════════════════════════
  //  updateTVL — Positive Gain
  // ═══════════════════════════════════════════════════════════════

  describe("updateTVL — positive gain", () => {
    it("should allocate senior target gain to senior TVL", async () => {});
    it("should allocate residual to junior base TVL", async () => {});
    it("should cut reserve from positive gain", async () => {});
    it("should update srtTargetIndex", async () => {});
  });

  // ═══════════════════════════════════════════════════════════════
  //  updateTVL — Negative Gain (Loss)
  // ═══════════════════════════════════════════════════════════════

  describe("updateTVL — loss waterfall", () => {
    it("should emit WETHCoverageNeeded if WETH TVL > 0", async () => {});
    it("should reduce junior base TVL after WETH coverage", async () => {});
    it("should reduce mezzanine TVL if junior depleted", async () => {});
    it("should reduce senior TVL as last resort", async () => {});
  });

  // ═══════════════════════════════════════════════════════════════
  //  Access Control
  // ═══════════════════════════════════════════════════════════════

  describe("access control", () => {
    it("should revert if caller is not CDO", async () => {});
  });
});
```

### Test naming

```typescript
// Pattern: "should [expected behavior] when [condition]"

it("should allocate senior target gain to senior TVL", ...);
it("should revert when coverage below 105% for senior deposit", ...);
it("should return proportional WETH on junior withdrawal", ...);
it("should auto-pause when junior price drops below 90%", ...);
it("should allow junior deposit even at low coverage", ...);
```

### Assertions — use specific matchers

```typescript
// ✓ GOOD — specific
expect(await accounting.s_seniorTVL()).to.equal(expectedSeniorTVL);
expect(tx).to.emit(accounting, "WETHCoverageNeeded").withArgs(expectedAmount);
await expect(cdo.deposit(SENIOR, token, amount)).to.be.revertedWithCustomError(
  cdo,
  "PrimeVaults__CoverageTooLow",
);

// ✗ BAD — vague
expect(await accounting.s_seniorTVL()).to.not.equal(0);
```

---

## 5. File Header Template

Every `.sol` file starts with:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// ══════════════════════════════════════════════════════════════════════
//  PRIMEVAULTS V3 — [Contract Name]
//  [One-line description]
//  See: docs/PV_V3_FINAL_v34.md section [X]
// ══════════════════════════════════════════════════════════════════════

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
// ... imports grouped: OpenZeppelin → external libs → internal interfaces → internal contracts
```

### Import ordering

```solidity
// 1. OpenZeppelin
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";

// 2. External libraries
import {PRBMathUD60x18} from "@prb/math/src/UD60x18.sol";

// 3. Internal interfaces
import {IStrategy, WithdrawResult, WithdrawType} from "../interfaces/IStrategy.sol";
import {IAccounting} from "../interfaces/IAccounting.sol";
import {TrancheId} from "../interfaces/IPrimeCDO.sol";

// 4. Internal contracts
import {FixedPointMath} from "../libraries/FixedPointMath.sol";
```

---

## 6. Git Conventions

```
Branch naming:
  feature/accounting
  feature/primecdo-deposit
  feature/cooldown-system
  fix/coverage-gate-edge-case
  test/integration-full-flow

Commit messages:
  feat(accounting): implement gain splitting algorithm
  feat(primecdo): add coverage gate for deposits
  fix(accounting): handle jr TVL = 0 edge case in _getCoverage
  test(accounting): add loss waterfall unit tests
  docs(conventions): add NatSpec requirements
```

---

## 7. Claude Code — System Prompt Prefix

Paste vào đầu mỗi Claude Code session:

```
You are implementing PrimeVaults V3 smart contracts.

ALWAYS follow docs/CONVENTIONS.md for:
- Naming: i_ immutable, s_ storage, UPPER constants, _prefix internal
- Formatting: 120 char lines, horizontal priority, section separators ═══
- NatSpec: @notice + @dev + @param + @return on every external function
- Custom errors: PrimeVaults__ErrorName(params), no require strings
- Imports: OZ → external → interfaces → internal

Before writing code, read the relevant section from docs/PV_V3_FINAL_v34.md.
Reference formula sections from docs/PV_V3_MATH_REFERENCE.md in @dev comments.
```

---

_PrimeVaults V3 — Coding Conventions v3.4.1_
