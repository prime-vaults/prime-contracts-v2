# PrimeVaults V3 — APR Oracle

**Version:** 3.5.0 (final)  
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

sUSDai (USD.AI):
  sUSDai expose:
    ✓ convertToAssets()             → exchange rate
    ✗ getUnvestedAmount()           → KHÔNG CÓ
    ✗ lastDistributionTimestamp()   → KHÔNG CÓ
  → Yield tích luỹ qua exchange rate, PHẢI dùng snapshot

→ AprPairFeed: copy Strata 100%
→ Provider: custom cho sUSDai (snapshot exchange rate)
```

---

## 2. Architecture

```
                    ┌─── PUSH: off-chain observer tính APR, gọi updateRoundData(apr, apr, t)
                    │         (dùng khi cần APR chính xác, hoặc emergency override)
                    │
AprPairFeed ────────┤
                    │
                    └─── PULL: gọi provider.getAprPair() tự động khi PUSH data stale
                              │
                              └── SUSDaiAprPairProvider
                                    ├── aprTarget: Aave USDC+USDT weighted avg (realtime view)
                                    └── aprBase: sUSDai exchange rate growth (từ snapshots)

latestRoundData():
  IF sourcePref == Feed AND cache not stale → return cache (PUSH data)
  ELSE → call provider.getAprPair() trực tiếp (PULL fallback)

→ Không bao giờ stuck. Nếu keeper down → PULL tự động.
→ Nếu provider broken → PUSH override vẫn hoạt động.
```

---

## 3. AprPairFeed — Copy Strata

**File:** `contracts/oracles/AprPairFeed.sol`  
**Copy Strata 100%,** chỉ thay AccessControlled bằng OZ AccessControl.

```solidity
/// @title AprPairFeed
/// @author PrimeVaults Team
/// @notice Manages APR Pair data with dual-source: PUSH (external) + PULL (provider)
/// @dev    Copied from Strata AprPairFeed. PUSH data preferred, PULL fallback when stale.
///         20-round circular buffer for audit trail. Bounds checking [-50%, +200%].
///         Uses int64 with 12 decimals for APR values (Strata-compatible).

contract AprPairFeed is IAprPairFeed, AccessControl {

    // ═══════════════════════════════════════════════════════════════
    //  CONSTANTS
    // ═══════════════════════════════════════════════════════════════

    int64 private constant APR_BOUNDARY_MAX =    2e12;   // 200%
    int64 private constant APR_BOUNDARY_MIN = -0.5e12;   // -50%
    uint64 private constant MAX_FUTURE_DRIFT = 60;       // 60s clock skew tolerance
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

    /// @notice Get latest APR pair — prefers PUSH data, falls back to PULL
    /// @dev    If sourcePref == Feed AND cache not stale → return cache
    ///         Otherwise → call provider.getAprPair() directly (PULL)
    /// @return round Latest round data
    function latestRoundData() external view returns (TRound memory) {
        TRound memory round = s_latestRound;

        if (s_sourcePref == ESourcePref.Feed) {
            uint256 deltaT = block.timestamp - uint256(round.updatedAt);
            if (deltaT < s_roundStaleAfter) {
                return round;
            }
            // falls back to strategy ↓
        }

        (int64 aprTarget, int64 aprBase, uint64 t1) = s_provider.getAprPair();
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
    //  PUSH — external observer sends APR (sets sourcePref = Feed)
    // ═══════════════════════════════════════════════════════════════

    /// @notice Push APR values from off-chain observer
    /// @dev    Access: UPDATER_FEED_ROLE only
    ///         Sets sourcePref to Feed — latestRoundData() will prefer this data
    ///         Also serves as emergency override (replaces setManualApr)
    function updateRoundData(int64 aprTarget, int64 aprBase, uint64 timestamp) external onlyRole(UPDATER_FEED_ROLE) {
        _updateRoundDataInner(aprTarget, aprBase, timestamp);
        _ensureSourcePref(ESourcePref.Feed);
    }

    // ═══════════════════════════════════════════════════════════════
    //  PULL — fetch from provider (sets sourcePref = Strategy)
    // ═══════════════════════════════════════════════════════════════

    /// @notice Pull APR from strategy provider
    /// @dev    Access: UPDATER_FEED_ROLE only
    ///         Sets sourcePref to Strategy — latestRoundData() will always call provider
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

    function setProvider(IStrategyAprPairProvider provider_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        (int64 aprTarget, int64 aprBase, ) = provider_.getAprPair();
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

## 4. SUSDaiAprPairProvider — Custom cho sUSDai

**File:** `contracts/oracles/providers/SUSDaiAprPairProvider.sol`

### Tại sao khác Strata's AaveAprPairProvider

```
Strata (sUSDe): getAPRbase() dùng sUSDe.getUnvestedAmount()
  → Pure view, realtime, không cần snapshot
  → Vì Ethena distribute yield qua 8h vesting period
  → Đọc "còn bao nhiêu chưa vest" → APR

sUSDai: KHÔNG có getUnvestedAmount()
  → Yield tích luỹ qua exchange rate tăng dần
  → PHẢI so sánh 2 thời điểm: rate(T0) vs rate(T1)
  → CẦN snapshot mechanism

NHƯNG: snapshot nằm TRONG provider (internal), KHÔNG cần keeper riêng.
AprPairFeed.updateRoundData() → provider.getAprPair() → snapshot + compute.
1 keeper call = snapshot + APR + cache. Giống Strata.
```

### Spec

```solidity
/// @title SUSDaiAprPairProvider
/// @author PrimeVaults Team
/// @notice Provides benchmark APR (Aave) + strategy APR (sUSDai) for PrimeVaults
/// @dev    Benchmark: Aave v3 Arbitrum USDC+USDT supply rate weighted avg (realtime view)
///         Base: sUSDai exchange rate growth between 2 snapshots, annualized
///         Snapshot happens inside getAprPair() — no separate keeper call needed
///         Unlike Strata's sUSDe provider, sUSDai doesn't expose vesting API,
///         so we use rate delta instead.
///
///         Interface: IStrategyAprPairProvider (same as Strata)
///         APR units: int64, 12 decimals (Strata-compatible)

contract SUSDaiAprPairProvider is IStrategyAprPairProvider {

    // ═══════════════════════════════════════════════════════════════
    //  CONSTANTS
    // ═══════════════════════════════════════════════════════════════

    uint256 private constant SECONDS_PER_YEAR = 31_536_000;
    uint256 private constant PRECISION = 1e18;
    uint256 private constant APR_SCALE = 1e12;

    // ═══════════════════════════════════════════════════════════════
    //  IMMUTABLES
    // ═══════════════════════════════════════════════════════════════

    IAavePool public immutable i_aave;
    IERC4626 public immutable i_sUSDai;
    address[] public i_benchmarkTokens;       // [USDC, USDT]

    // ═══════════════════════════════════════════════════════════════
    //  STATE — sUSDai exchange rate snapshots
    // ═══════════════════════════════════════════════════════════════

    uint256 public s_prevRate;
    uint256 public s_prevTimestamp;
    uint256 public s_latestRate;
    uint256 public s_latestTimestamp;

    // ═══════════════════════════════════════════════════════════════
    //  EVENTS
    // ═══════════════════════════════════════════════════════════════

    event RateSnapshotted(uint256 rate, uint256 timestamp);

    // ═══════════════════════════════════════════════════════════════
    //  CONSTRUCTOR
    // ═══════════════════════════════════════════════════════════════

    /// @dev Seeds first sUSDai rate snapshot at deploy
    constructor(IAavePool aave_, address[] memory benchmarkTokens_, IERC4626 sUSDai_) {
        i_aave = aave_;
        i_benchmarkTokens = benchmarkTokens_;
        i_sUSDai = sUSDai_;

        // Seed first snapshot
        s_latestRate = sUSDai_.convertToAssets(PRECISION);
        s_latestTimestamp = block.timestamp;
    }

    // ═══════════════════════════════════════════════════════════════
    //  IStrategyAprPairProvider (Strata interface)
    // ═══════════════════════════════════════════════════════════════

    /// @notice Get both APRs — snapshots sUSDai rate as side effect
    /// @dev    Called by AprPairFeed.updateRoundData() (PULL mode)
    ///         State-changing: shifts sUSDai exchange rate snapshots
    ///         aprTarget: Aave weighted avg (realtime view, no snapshot)
    ///         aprBase: sUSDai annualized growth from snapshots
    /// @return aprTarget Benchmark APR, int64, 12 decimals
    /// @return aprBase Strategy APR, int64, 12 decimals
    /// @return timestamp Current block timestamp
    function getAprPair() external returns (int64 aprTarget, int64 aprBase, uint64 timestamp) {
        timestamp = uint64(block.timestamp);
        aprTarget = _getAPRtarget();
        aprBase = _getAPRbase();
    }

    // ═══════════════════════════════════════════════════════════════
    //  BENCHMARK — Aave weighted average
    // ═══════════════════════════════════════════════════════════════

    /// @notice Aave USDC+USDT supply rate, supply-weighted average
    /// @dev    Same logic as Strata's AaveAprPairProvider.getAPRtarget()
    ///         Pure view — no snapshot needed
    function _getAPRtarget() internal view returns (int64) {
        uint256 totalWeight = 0;
        uint256 weightedSum = 0;
        for (uint256 i = 0; i < i_benchmarkTokens.length; i++) {
            (uint256 apr, uint256 totalSupply) = _getAaveAsset(i);
            weightedSum += apr * totalSupply;
            totalWeight += totalSupply;
        }
        if (totalWeight == 0) return 0;
        uint256 aprAvg = weightedSum / totalWeight;
        return int64(int256(aprAvg));
    }

    /// @dev Fetch raw Aave reserve data: APR (12 dec) + total supplied
    function _getAaveAsset(uint256 i) internal view returns (uint256 apr, uint256 totalSupply) {
        address asset = i_benchmarkTokens[i];
        (
            , , uint128 currentLiquidityRate, , , , , ,
            address aTokenAddress, , , , , ,
        ) = i_aave.getReserveData(asset);

        uint256 ONE_in = 1e27;    // Aave ray
        uint256 ONE_out = 1e12;   // our decimals
        apr = uint256(currentLiquidityRate) * ONE_out / ONE_in;
        totalSupply = IERC20(aTokenAddress).totalSupply();
    }

    // ═══════════════════════════════════════════════════════════════
    //  STRATEGY — sUSDai exchange rate growth
    // ═══════════════════════════════════════════════════════════════

    /// @notice sUSDai APR from exchange rate snapshots
    /// @dev    Unlike Strata's sUSDe (which uses getUnvestedAmount for realtime APR),
    ///         sUSDai doesn't expose vesting internals. We compare exchange rates instead.
    ///
    ///         Formula (same as Strata tranches_math.md):
    ///           Growth_Factor = ExchangeRate_T1 / ExchangeRate_T0 - 1
    ///           APR = Growth_Factor / (T1 - T0) * 1Year
    ///
    ///         Side effect: shifts snapshots (prev ← latest, latest ← current)
    ///         Returns 0 if: no prev snapshot, deltaT = 0, or rate decreased
    function _getAPRbase() internal returns (int64) {
        uint256 currentRate = i_sUSDai.convertToAssets(PRECISION);

        // Shift snapshots
        s_prevRate = s_latestRate;
        s_prevTimestamp = s_latestTimestamp;
        s_latestRate = currentRate;
        s_latestTimestamp = block.timestamp;

        emit RateSnapshotted(currentRate, block.timestamp);

        // Need 2 valid snapshots
        if (s_prevTimestamp == 0 || s_prevRate == 0) return 0;

        uint256 deltaT = s_latestTimestamp - s_prevTimestamp;
        if (deltaT == 0) return 0;

        // Rate decreased → negative yield
        if (s_latestRate < s_prevRate) {
            uint256 loss = (s_prevRate - s_latestRate) * SECONDS_PER_YEAR * APR_SCALE
                / deltaT / s_prevRate;
            return -int64(int256(loss));
        }

        // Rate increased → positive yield
        uint256 growth = (s_latestRate - s_prevRate) * SECONDS_PER_YEAR * APR_SCALE
            / deltaT / s_prevRate;
        return int64(int256(growth));
    }
}
```

### Key differences from Strata's AaveAprPairProvider

```
Strata sUSDe:
  getAPRbase():
    unvestedAmount = sUSDe.getUnvestedAmount()
    totalAssets = sUSDe.totalAssets()
    apr = unvestedAmount × SECONDS_PER_YEAR / (VESTING_PERIOD - deltaT) / totalAssets
    → Pure view. Realtime. No state.

PrimeVaults sUSDai:
  _getAPRbase():
    currentRate = sUSDai.convertToAssets(1e18)
    shift snapshots
    apr = (currentRate - prevRate) × SECONDS_PER_YEAR / deltaT / prevRate
    → State-changing (snapshots). Needs previous call for baseline.
    → Supports negative APR (returns int64 < 0 if rate decreased)
```

---

## 5. Interface

**File:** `contracts/interfaces/IAprPairFeed.sol`

```solidity
/// @dev Strata-compatible interface

interface IStrategyAprPairProvider {
    /// @notice Get APR pair from strategy
    /// @return aprTarget Benchmark APR, int64, 12 decimals
    /// @return aprBase Strategy APR, int64, 12 decimals
    /// @return timestamp Update timestamp
    function getAprPair() external returns (int64 aprTarget, int64 aprBase, uint64 timestamp);
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

## 6. Accounting Integration

Accounting đọc APR từ AprPairFeed, cần convert int64×12dec → uint256×18dec:

```solidity
// Trong Accounting._computeSeniorAPR():

function _readAprPair() internal view returns (uint256 aprTarget, uint256 aprBase) {
    IAprPairFeed.TRound memory round = IAprPairFeed(i_aprFeed).latestRoundData();

    // int64 (12 dec) → uint256 (18 dec)
    // Negative APR → clamp to 0 for Senior target (Senior floor protects)
    aprTarget = round.aprTarget > 0 ? uint256(int256(round.aprTarget)) * 1e6 : 0;
    aprBase = round.aprBase > 0 ? uint256(int256(round.aprBase)) * 1e6 : 0;
}
```

---

## 7. Flow

```
NORMAL OPERATION (PULL mode):

  Keeper (UPDATER_FEED_ROLE) mỗi 24h:
    AprPairFeed.updateRoundData()          // no-args = PULL
      └── provider.getAprPair()
            ├── Aave weighted avg → aprTarget (realtime)
            ├── Shift sUSDai snapshots → compute aprBase
            └── return (aprTarget, aprBase, timestamp)
      └── Store in round buffer
      └── sourcePref = Strategy

  Accounting reads:
    AprPairFeed.latestRoundData()
      └── sourcePref == Strategy → call provider.getAprPair() live
      └── Return realtime data


EMERGENCY / PRECISE OVERRIDE (PUSH mode):

  Observer (UPDATER_FEED_ROLE):
    AprPairFeed.updateRoundData(aprTarget, aprBase, timestamp)  // with args = PUSH
      └── Store in round buffer
      └── sourcePref = Feed

  Accounting reads:
    AprPairFeed.latestRoundData()
      └── sourcePref == Feed, cache not stale → return cache
      └── Nếu stale → auto fallback to provider.getAprPair()


KEEPER DOWN:

  latestRoundData():
    sourcePref == Feed → cache stale → fallback to provider
    sourcePref == Strategy → call provider directly (always fresh)
  → KHÔNG BAO GIỜ STUCK. Automatic fallback.
```

---

## 8. So sánh Final

```
                        Strata                  PrimeVaults
────────────────────────────────────────────────────────────────
AprPairFeed             Copy 100%               Copy 100%
  PUSH + PULL           ✓                       ✓
  20-round buffer       ✓                       ✓
  Bounds [-50%, 200%]   ✓                       ✓
  int64 × 12 dec        ✓                       ✓
  UPDATER_FEED_ROLE     ✓                       ✓
  Auto fallback         ✓                       ✓

Provider                AaveAprPairProvider     SUSDaiAprPairProvider
  aprTarget source      Aave weighted avg       Aave weighted avg (same)
  aprBase source        sUSDe vesting API       sUSDai exchange rate snapshots
  State                 Stateless (pure view)   Stateful (snapshots)
  Negative APR          Returns 0               Returns int64 < 0
  getAprPair() mutates  No                      Yes (shifts snapshots)
```

---

## 9. Deployment

```
1. SUSDaiAprPairProvider
   constructor(aavePool, [USDC, USDT], sUSDai)
   → Seeds first sUSDai snapshot

2. AprPairFeed
   constructor(admin, provider, staleAfter=48h, "PrimeVaults sUSDai Market")
   → Grant UPDATER_FEED_ROLE to keeper address

3. First 24h:
   Keeper: updateRoundData(4e10, 12e10, timestamp)    // PUSH with estimated APRs
   → sourcePref = Feed

4. After 24h:
   Keeper: updateRoundData()                           // PULL (no args)
   → First real snapshot pair
   → sourcePref = Strategy

5. After 48h:
   Keeper: updateRoundData()                           // PULL
   → 2 valid snapshots → aprBase accurate
   → System fully autonomous
```

---

## 10. Arbitrum Addresses

```
Aave v3 Pool:   0x794a61358D6845594F94dc1DB02A252b5b4814aD
USDC:           0xaf88d065e77c8cC2239327C5EDb3A432268e5831
USDT:           0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9
sUSDai:         0x0B2b2B2076d95dda7817e785989fE353fe955ef9
```

---

_PrimeVaults V3 — APR Oracle v3.5.0 (final)_  
_AprPairFeed: Strata copy • Provider: custom sUSDai snapshots_  
_March 2026_
