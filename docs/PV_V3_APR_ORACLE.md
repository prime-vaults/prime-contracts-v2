# PrimeVaults V3 — APR Oracle

**Version:** 3.5.1  
**Inherits:** Strata `AprPairFeed` (PUSH+PULL, 20-round buffer, bounds, int64×12dec)  
**Custom:** `SUSDaiAprPairProvider` (snapshot-based, vì sUSDai không có vesting API)

---

## 1. Tại sao khác Strata Provider

```
Strata (sUSDe — Ethena):
  sUSDe expose:
    ✓ getUnvestedAmount()          → yield đang vesting
    ✓ lastDistributionTimestamp()   → khi nào distribute
    ✓ totalAssets()
  → Tính APR realtime, pure view, KHÔNG cần snapshot
  → getAprPair() là pure view → AprPairFeed.latestRoundData() gọi được trực tiếp

sUSDai (USD.AI):
  sUSDai expose:
    ✓ convertToAssets()             → exchange rate
    ✗ getUnvestedAmount()           → KHÔNG CÓ
    ✗ lastDistributionTimestamp()   → KHÔNG CÓ
  → Yield tích luỹ qua exchange rate, PHẢI dùng snapshot
  → getAprPair() là state-changing (shift snapshots)
  → CẦN tách: getAprPair() (mutate) + getAprPairView() (view cho fallback)
```

---

## 2. Architecture

```
                    ┌─── PUSH: off-chain observer gọi updateRoundData(apr, apr, t)
                    │
AprPairFeed ────────┤
                    │
                    └─── PULL: 2 paths
                           │
                           ├── updateRoundData() → provider.getAprPair()
                           │     (state-changing: shifts snapshots + caches)
                           │
                           └── latestRoundData() fallback → provider.getAprPairView()
                                 (view: reads current snapshots WITHOUT shifting)

latestRoundData():
  IF sourcePref == Feed AND cache not stale → return cache
  ELSE → call provider.getAprPairView() (view, no mutation)

→ Không bao giờ stuck. View fallback luôn hoạt động.
→ Snapshots chỉ shift khi keeper gọi updateRoundData() (PULL).
```

---

## 3. Interface

**File:** `contracts/interfaces/IAprPairFeed.sol`

```solidity
/// @dev Strata-compatible interface, extended with view fallback for snapshot-based providers

interface IStrategyAprPairProvider {
    /// @notice Get APR pair — MAY be state-changing (snapshot shift)
    /// @dev    Called by AprPairFeed.updateRoundData() (PULL mode)
    function getAprPair() external returns (int64 aprTarget, int64 aprBase, uint64 timestamp);

    /// @notice Get APR pair — pure view, reads from current snapshots without shifting
    /// @dev    Called by AprPairFeed.latestRoundData() as fallback
    ///         For Strata-style providers (pure view): identical to getAprPair()
    ///         For snapshot-based providers: reads existing snapshots, no mutation
    function getAprPairView() external view returns (int64 aprTarget, int64 aprBase, uint64 timestamp);
}

interface IAprPairFeed {
    struct TRound {
        int64 aprTarget;
        int64 aprBase;
        uint64 updatedAt;
        uint64 answeredInRound;
    }

    function latestRoundData() external view returns (TRound memory);
    function getRoundData(uint64 roundId) external view returns (TRound memory);
}
```

---

## 4. AprPairFeed — Copy Strata + view fallback fix

**File:** `contracts/oracles/AprPairFeed.sol`

**Thay đổi so với Strata:** `latestRoundData()` gọi `getAprPairView()` thay vì `getAprPair()`.

```solidity
/// @title AprPairFeed
/// @author PrimeVaults Team
/// @notice Manages APR Pair data with dual-source: PUSH (external) + PULL (provider)
/// @dev    Based on Strata AprPairFeed. PUSH data preferred, PULL fallback when stale.
///         20-round circular buffer for audit trail. Bounds checking [-50%, +200%].
///         Uses int64 with 12 decimals for APR values (Strata-compatible).
///         Difference from Strata: latestRoundData() calls getAprPairView() instead of
///         getAprPair(), because our provider is state-changing (snapshot shifts).

contract AprPairFeed is IAprPairFeed, AccessControl {

    // ═══════════════════════════════════════════════════════════════
    //  CONSTANTS
    // ═══════════════════════════════════════════════════════════════

    int64 private constant APR_BOUNDARY_MAX =    2e12;   // 200%
    int64 private constant APR_BOUNDARY_MIN = -0.5e12;   // -50%
    uint64 private constant MAX_FUTURE_DRIFT = 60;
    uint8 public constant ROUNDS_CAP = 20;
    uint8 public constant DECIMALS = 12;

    bytes32 public constant UPDATER_FEED_ROLE = keccak256("UPDATER_FEED_ROLE");

    // ═══════════════════════════════════════════════════════════════
    //  TYPES
    // ═══════════════════════════════════════════════════════════════

    struct TRound {
        int64 aprTarget;
        int64 aprBase;
        uint64 updatedAt;
        uint64 answeredInRound;
    }

    enum ESourcePref { Feed, Strategy }

    // ═══════════════════════════════════════════════════════════════
    //  STATE
    // ═══════════════════════════════════════════════════════════════

    string public s_description;
    uint64 public s_latestRoundId;
    TRound public s_latestRound;
    mapping(uint80 => TRound) public s_rounds;
    uint256 public s_roundStaleAfter;
    IStrategyAprPairProvider public s_provider;
    ESourcePref public s_sourcePref;

    // ═══════════════════════════════════════════════════════════════
    //  EVENTS
    // ═══════════════════════════════════════════════════════════════

    event AnswerUpdated(int64 aprTarget, int64 aprBase, uint64 roundId, uint64 updatedAt);
    event ProviderSet(address newProvider);
    event StalePeriodSet(uint256 stalePeriod);
    event SourcePrefChanged(ESourcePref newPref);

    // ═══════════════════════════════════════════════════════════════
    //  ERRORS
    // ═══════════════════════════════════════════════════════════════

    error PrimeVaults__StaleUpdate(int64 aprTarget, int64 aprBase, uint64 timestamp);
    error PrimeVaults__OutOfOrderUpdate(int64 aprTarget, int64 aprBase, uint64 timestamp);
    error PrimeVaults__InvalidApr(int64 value);
    error PrimeVaults__NoDataPresent();
    error PrimeVaults__OldRound();

    // ═══════════════════════════════════════════════════════════════
    //  CONSTRUCTOR
    // ═══════════════════════════════════════════════════════════════

    constructor(
        address admin_,
        IStrategyAprPairProvider provider_,
        uint256 roundStaleAfter_,
        string memory description_
    ) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin_);
        s_provider = provider_;
        s_roundStaleAfter = roundStaleAfter_;
        s_description = description_;
    }

    // ═══════════════════════════════════════════════════════════════
    //  READ — Accounting calls this
    // ═══════════════════════════════════════════════════════════════

    /// @notice Get latest APR pair — prefers PUSH cache, falls back to provider VIEW
    /// @dev    Uses getAprPairView() for fallback (not getAprPair()) because
    ///         our provider is state-changing. View fallback reads existing snapshots
    ///         without shifting them.
    function latestRoundData() external view returns (TRound memory) {
        TRound memory round = s_latestRound;

        if (s_sourcePref == ESourcePref.Feed) {
            uint256 deltaT = block.timestamp - uint256(round.updatedAt);
            if (deltaT < s_roundStaleAfter) {
                return round;
            }
        }

        // Fallback: call VIEW function (no state mutation)
        (int64 aprTarget, int64 aprBase, uint64 t1) = s_provider.getAprPairView();
        _ensureValid(aprTarget);
        _ensureValid(aprBase);
        return TRound({
            aprTarget: aprTarget,
            aprBase: aprBase,
            updatedAt: t1,
            answeredInRound: s_latestRoundId + 1
        });
    }

    /// @notice Get specific historical round
    function getRoundData(uint64 roundId) external view returns (TRound memory) {
        uint64 roundIdx = roundId % ROUNDS_CAP;
        TRound memory round = s_rounds[roundIdx];
        if (round.updatedAt == 0) revert PrimeVaults__NoDataPresent();
        if (round.answeredInRound != roundId) revert PrimeVaults__OldRound();
        return round;
    }

    // ═══════════════════════════════════════════════════════════════
    //  PUSH — external observer sends APR
    // ═══════════════════════════════════════════════════════════════

    function updateRoundData(int64 aprTarget, int64 aprBase, uint64 timestamp) external onlyRole(UPDATER_FEED_ROLE) {
        _updateRoundDataInner(aprTarget, aprBase, timestamp);
        _ensureSourcePref(ESourcePref.Feed);
    }

    // ═══════════════════════════════════════════════════════════════
    //  PULL — fetch from provider (state-changing: shifts snapshots)
    // ═══════════════════════════════════════════════════════════════

    /// @dev Calls getAprPair() which shifts provider snapshots
    function updateRoundData() external onlyRole(UPDATER_FEED_ROLE) {
        (int64 aprTarget, int64 aprBase, uint64 t) = s_provider.getAprPair();
        _updateRoundDataInner(aprTarget, aprBase, t);
        _ensureSourcePref(ESourcePref.Strategy);
    }

    // ═══════════════════════════════════════════════════════════════
    //  INTERNAL
    // ═══════════════════════════════════════════════════════════════

    function _updateRoundDataInner(int64 aprTarget, int64 aprBase, uint64 t) internal {
        if (uint256(t) < block.timestamp - s_roundStaleAfter) {
            revert PrimeVaults__StaleUpdate(aprTarget, aprBase, t);
        }
        if (t <= s_latestRound.updatedAt || uint256(t) > block.timestamp + MAX_FUTURE_DRIFT) {
            revert PrimeVaults__OutOfOrderUpdate(aprTarget, aprBase, t);
        }
        _ensureValid(aprTarget);
        _ensureValid(aprBase);

        uint64 roundId = s_latestRoundId + 1;
        uint64 roundIdx = roundId % ROUNDS_CAP;

        s_latestRoundId = roundId;
        s_latestRound = TRound({
            aprTarget: aprTarget,
            aprBase: aprBase,
            updatedAt: t,
            answeredInRound: roundId
        });
        s_rounds[roundIdx] = s_latestRound;

        emit AnswerUpdated(aprTarget, aprBase, roundId, t);
    }

    function _ensureSourcePref(ESourcePref pref) internal {
        if (s_sourcePref != pref) {
            s_sourcePref = pref;
            emit SourcePrefChanged(pref);
        }
    }

    function _ensureValid(int64 answer) internal pure {
        if (answer < APR_BOUNDARY_MIN || answer > APR_BOUNDARY_MAX) {
            revert PrimeVaults__InvalidApr(answer);
        }
    }

    // ═══════════════════════════════════════════════════════════════
    //  ADMIN
    // ═══════════════════════════════════════════════════════════════

    /// @dev Calls getAprPairView() for compatibility check (view, no side effect)
    function setProvider(IStrategyAprPairProvider provider_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        (int64 aprTarget, int64 aprBase, ) = provider_.getAprPairView();
        _ensureValid(aprTarget);
        _ensureValid(aprBase);
        s_provider = provider_;
        emit ProviderSet(address(provider_));
    }

    function setRoundStaleAfter(uint256 roundStaleAfter_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        s_roundStaleAfter = roundStaleAfter_;
        emit StalePeriodSet(roundStaleAfter_);
    }
}
```

---

## 5. SUSDaiAprPairProvider — Fixed

**File:** `contracts/oracles/providers/SUSDaiAprPairProvider.sol`

### Fixes applied

```
#1 CRITICAL:  getAprPairView() added — view function for PULL fallback
#2 MEDIUM:    benchmarkTokens[] + aTokenAddress from getReserveData (not hardcoded)
#3 LOW:       Bounds check on benchmark (cap 40%)
#4 LOW:       Clamp APR to [-50%, +200%] before int64 cast
```

```solidity
/// @title SUSDaiAprPairProvider
/// @author PrimeVaults Team
/// @notice Provides benchmark APR (Aave) + strategy APR (sUSDai) for PrimeVaults
/// @dev    Benchmark: Aave v3 Arbitrum supply rate weighted avg (realtime view)
///         Base: sUSDai exchange rate growth between 2 snapshots, annualized
///         Two entry points:
///           getAprPair()     — state-changing, shifts snapshots (called by Feed PULL update)
///           getAprPairView() — pure view, reads existing snapshots (called by Feed fallback)
///         APR units: int64, 12 decimals (Strata-compatible)

contract SUSDaiAprPairProvider is IStrategyAprPairProvider {

    // ═══════════════════════════════════════════════════════════════
    //  CONSTANTS
    // ═══════════════════════════════════════════════════════════════

    uint256 private constant SECONDS_PER_YEAR = 31_536_000;
    uint256 private constant PRECISION = 1e18;
    uint256 private constant APR_SCALE = 1e12;

    int256 private constant APR_CLAMP_MAX = 2e12;      // +200%
    int256 private constant APR_CLAMP_MIN = -0.5e12;   // -50%
    uint256 private constant BENCHMARK_MAX = 0.4e12;    // 40% max benchmark

    // ═══════════════════════════════════════════════════════════════
    //  IMMUTABLES
    // ═══════════════════════════════════════════════════════════════

    IAavePool public immutable i_aavePool;
    IERC4626 public immutable i_sUSDai;
    address[] public i_benchmarkTokens;              // [USDC, USDT]

    // ═══════════════════════════════════════════════════════════════
    //  STATE
    // ═══════════════════════════════════════════════════════════════

    uint256 public s_prevRate;
    uint256 public s_prevTimestamp;
    uint256 public s_latestRate;
    uint256 public s_latestTimestamp;

    // ═══════════════════════════════════════════════════════════════
    //  EVENTS
    // ═══════════════════════════════════════════════════════════════

    event SnapshotShifted(uint256 prevRate, uint256 newRate, uint256 timestamp);

    // ═══════════════════════════════════════════════════════════════
    //  CONSTRUCTOR
    // ═══════════════════════════════════════════════════════════════

    constructor(IAavePool aavePool_, address[] memory benchmarkTokens_, IERC4626 sUSDai_) {
        i_aavePool = aavePool_;
        i_benchmarkTokens = benchmarkTokens_;
        i_sUSDai = sUSDai_;

        s_latestRate = sUSDai_.convertToAssets(PRECISION);
        s_latestTimestamp = block.timestamp;
    }

    // ═══════════════════════════════════════════════════════════════
    //  STATE-CHANGING — called by AprPairFeed.updateRoundData() PULL
    // ═══════════════════════════════════════════════════════════════

    /// @notice Get APR pair + shift snapshots
    /// @dev    Shifts prev ← latest, latest ← current sUSDai rate.
    ///         ONLY called by AprPairFeed.updateRoundData() (no-args PULL).
    function getAprPair() external override returns (int64 aprTarget, int64 aprBase, uint64 timestamp) {
        // Shift snapshots
        s_prevRate = s_latestRate;
        s_prevTimestamp = s_latestTimestamp;

        uint256 currentRate = i_sUSDai.convertToAssets(PRECISION);
        s_latestRate = currentRate;
        s_latestTimestamp = block.timestamp;

        emit SnapshotShifted(s_prevRate, currentRate, block.timestamp);

        // Compute APRs from new state
        aprTarget = _computeBenchmarkApr();
        aprBase = _computeStrategyApr();
        timestamp = uint64(block.timestamp);
    }

    // ═══════════════════════════════════════════════════════════════
    //  VIEW — called by AprPairFeed.latestRoundData() fallback
    // ═══════════════════════════════════════════════════════════════

    /// @notice Get APR pair WITHOUT shifting snapshots
    /// @dev    Reads existing snapshots. No state mutation.
    ///         Used by AprPairFeed.latestRoundData() which is a view function.
    function getAprPairView() external view override returns (int64 aprTarget, int64 aprBase, uint64 timestamp) {
        aprTarget = _computeBenchmarkApr();
        aprBase = _computeStrategyApr();
        timestamp = uint64(block.timestamp);
    }

    // ═══════════════════════════════════════════════════════════════
    //  BENCHMARK — Aave weighted average (view)
    // ═══════════════════════════════════════════════════════════════

    /// @dev Aave supply rate weighted by aToken totalSupply
    ///      aTokenAddress read from Aave getReserveData (not hardcoded)
    ///      Capped at BENCHMARK_MAX (40%)
    function _computeBenchmarkApr() internal view returns (int64) {
        uint256 totalWeight = 0;
        uint256 weightedSum = 0;

        for (uint256 i = 0; i < i_benchmarkTokens.length; i++) {
            (uint256 apr, uint256 supply) = _getAaveAsset(i);
            weightedSum += apr * supply;
            totalWeight += supply;
        }

        if (totalWeight == 0) return 0;

        uint256 aprAvg = weightedSum / totalWeight;

        // Bounds: cap at 40%, match Strata's BOUND_MAX
        if (aprAvg > BENCHMARK_MAX) aprAvg = BENCHMARK_MAX;

        return int64(int256(aprAvg));
    }

    /// @dev Read APR + totalSupply from Aave reserve
    ///      aTokenAddress from getReserveData — not hardcoded as immutable
    function _getAaveAsset(uint256 i) internal view returns (uint256 apr, uint256 totalSupply) {
        address asset = i_benchmarkTokens[i];
        IAavePool.ReserveData memory data = i_aavePool.getReserveData(asset);

        // currentLiquidityRate: ray (1e27) → 12 decimals (1e12)
        apr = uint256(data.currentLiquidityRate) * APR_SCALE / 1e27;

        // aToken totalSupply from Aave (not hardcoded address)
        totalSupply = IERC20(data.aTokenAddress).totalSupply();
    }

    // ═══════════════════════════════════════════════════════════════
    //  STRATEGY — sUSDai exchange rate growth (view)
    // ═══════════════════════════════════════════════════════════════

    /// @dev Reads current snapshots, computes annualized growth
    ///      Supports negative APR. Clamps to [-50%, +200%] before int64 cast.
    ///      View function — does NOT shift snapshots.
    function _computeStrategyApr() internal view returns (int64) {
        if (s_prevTimestamp == 0 || s_prevRate == 0) return 0;

        uint256 deltaT = s_latestTimestamp - s_prevTimestamp;
        if (deltaT == 0) return 0;

        int256 apr;

        if (s_latestRate >= s_prevRate) {
            // Positive yield
            uint256 growth = (s_latestRate - s_prevRate) * SECONDS_PER_YEAR * APR_SCALE / deltaT / s_prevRate;
            apr = int256(growth);
        } else {
            // Negative yield
            uint256 loss = (s_prevRate - s_latestRate) * SECONDS_PER_YEAR * APR_SCALE / deltaT / s_prevRate;
            apr = -int256(loss);
        }

        // Clamp to safe int64 range, matching AprPairFeed bounds
        if (apr > APR_CLAMP_MAX) apr = APR_CLAMP_MAX;
        if (apr < APR_CLAMP_MIN) apr = APR_CLAMP_MIN;

        return int64(apr);
    }
}

// ═══════════════════════════════════════════════════════════════════
//  Minimal Aave v3 interface
// ═══════════════════════════════════════════════════════════════════

interface IAavePool {
    struct ReserveData {
        uint256 configuration;
        uint128 liquidityIndex;
        uint128 currentLiquidityRate;
        uint128 variableBorrowIndex;
        uint128 currentVariableBorrowRate;
        uint128 currentStableBorrowRate;
        uint40 lastUpdateTimestamp;
        uint16 id;
        address aTokenAddress;
        address stableDebtTokenAddress;
        address variableDebtTokenAddress;
        address interestRateStrategyAddress;
        uint128 accruedToTreasury;
        uint128 unbacked;
        uint128 isolationModeTotalDebt;
    }

    function getReserveData(address asset) external view returns (ReserveData memory);
}
```

---

## 6. Accounting Integration

```solidity
function _readAprPair() internal view returns (uint256 aprTarget, uint256 aprBase) {
    IAprPairFeed.TRound memory round = IAprPairFeed(i_aprFeed).latestRoundData();

    // int64 (12 dec) → uint256 (18 dec). Negative → clamp to 0.
    aprTarget = round.aprTarget > 0 ? uint256(int256(round.aprTarget)) * 1e6 : 0;
    aprBase = round.aprBase > 0 ? uint256(int256(round.aprBase)) * 1e6 : 0;
}
```

---

## 7. Flow

```
NORMAL (PULL):

  Keeper (UPDATER_FEED_ROLE) mỗi 24h:
    AprPairFeed.updateRoundData()                       // no-args = PULL
      └── provider.getAprPair()                          // STATE-CHANGING
            ├── shift snapshots: prev ← latest, latest ← current
            ├── _computeBenchmarkApr() → Aave weighted avg
            └── _computeStrategyApr() → annualized growth from snapshots
      └── Store in round buffer, sourcePref = Strategy

  Accounting reads (mỗi user action):
    AprPairFeed.latestRoundData()                       // VIEW
      └── sourcePref == Strategy → provider.getAprPairView()  // VIEW
            ├── _computeBenchmarkApr() → Aave realtime
            └── _computeStrategyApr() → from EXISTING snapshots (no shift)


EMERGENCY (PUSH):

  Observer (UPDATER_FEED_ROLE):
    AprPairFeed.updateRoundData(aprTarget, aprBase, timestamp)
      └── Store in round buffer, sourcePref = Feed

  Accounting reads:
    AprPairFeed.latestRoundData()
      └── sourcePref == Feed, not stale → return cache
      └── if stale → fallback provider.getAprPairView()


KEEPER DOWN:

  sourcePref == Feed → cache stale → fallback getAprPairView() ✓
  sourcePref == Strategy → always calls getAprPairView() ✓
  → NEVER STUCK
```

---

## 8. Fixes Summary

```
#1 CRITICAL — View/mutate separation
   Problem:  latestRoundData() is view but called getAprPair() which mutates state
   Fix:      Added getAprPairView() (view) for fallback, getAprPair() (mutate) for update
   Where:    Interface, AprPairFeed.latestRoundData(), Provider dual functions

#2 MEDIUM — Hardcoded aToken addresses
   Problem:  If Aave upgrades aToken → reads wrong totalSupply
   Fix:      Read aTokenAddress from getReserveData() per call, use benchmarkTokens[] array
   Where:    Provider._getAaveAsset(), removed i_aUsdc/i_aUsdt immutables

#3 LOW — No bounds check in provider
   Problem:  Abnormal Aave rate passes through unchecked
   Fix:      BENCHMARK_MAX = 40% cap in _computeBenchmarkApr()
   Where:    Provider._computeBenchmarkApr()

#4 LOW — int64 overflow on cast
   Problem:  Large APR silently truncated on int64 cast
   Fix:      Clamp to [-50%, +200%] before cast, matching AprPairFeed bounds
   Where:    Provider._computeStrategyApr()
```

---

## 9. Strata vs PrimeVaults — Final Comparison

```
                        Strata                  PrimeVaults
────────────────────────────────────────────────────────────────
AprPairFeed             Copy                    Copy + getAprPairView fallback
  PUSH + PULL           ✓                       ✓
  20-round buffer       ✓                       ✓
  Bounds [-50%, 200%]   ✓                       ✓
  int64 × 12 dec        ✓                       ✓
  UPDATER_FEED_ROLE     ✓                       ✓

Provider                Pure view               Dual: mutate + view
  aprTarget             Aave weighted avg       Aave weighted avg
  aprBase               sUSDe vesting API       sUSDai snapshot growth
  getAprPair()          view                    state-changing (shifts)
  getAprPairView()      N/A (not needed)        view (for fallback)
  Benchmark bounds      BOUND_MAX = 40%         BENCHMARK_MAX = 40%
  APR clamp             Not needed (uint)       [-50%, +200%] (int)
  aToken address        From getReserveData     From getReserveData
  benchmarkTokens[]     ✓                       ✓
```

---

## 10. Deployment

```
1. SUSDaiAprPairProvider(aavePool, [USDC, USDT], sUSDai)
   → Seeds first snapshot

2. AprPairFeed(admin, provider, staleAfter=48h, "PrimeVaults sUSDai Market")
   → Grant UPDATER_FEED_ROLE to keeper

3. First 24h: PUSH mode
   updateRoundData(4e10, 12e10, timestamp)

4. After 24h: PULL mode
   updateRoundData()  → first real snapshot pair

5. After 48h: fully autonomous
   updateRoundData()  → 2 valid snapshots → aprBase accurate
```

---

## 11. Arbitrum Addresses

```
Aave v3 Pool:   0x794a61358D6845594F94dc1DB02A252b5b4814aD
USDC:           0xaf88d065e77c8cC2239327C5EDb3A432268e5831
USDT:           0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9
sUSDai:         0x0B2b2B2076d95dda7817e785989fE353fe955ef9
```

---

_PrimeVaults V3 — APR Oracle v3.5.1_  
_AprPairFeed: Strata copy + view fallback • Provider: dual mutate/view_  
_March 2026_
