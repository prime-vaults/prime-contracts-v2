# PrimeVaults V3 — APR Oracle (Fully On-Chain)

**Addendum to:** PV_V3_MVP_PLAN.md (replaces Step 5-6)  
**Version:** 3.4.2  
**Network:** Arbitrum (sUSDai + Aave v3 Arbitrum)

---

## 0. Network Note

USD.AI contracts deploy trên **Arbitrum**:

- USDai: `0x0A1a1A107E45b7Ced86833863f482BC5f4ed82EF`
- sUSDai: `0x0B2b2B2076d95dda7817e785989fE353fe955ef9`

sUSDai là **ERC-4626 deposit + ERC-7540 redeem** (async redeem, ~7 day timelock).

- Staking (deposit USDai → sUSDai): synchronous, ERC-4626 `deposit()`
- Unstaking (sUSDai → USDai): asynchronous, ERC-7540 `requestRedeem()` + `redeem()` sau timelock

PrimeVaults V3 MVP deploy trên **Arbitrum** cùng network với sUSDai.
Aave v3 cũng có trên Arbitrum → benchmark vẫn đọc được.

---

## 1. Architecture

```
AprPairFeed
  │
  ├── AaveAprProvider        → aprTarget (benchmark)
  │     Input: Aave v3 Arbitrum USDC + USDT supply rates
  │     Output: weighted average APR
  │     Realtime: không cần snapshot
  │
  └── SUSDaiAprProvider      → aprBase (strategy yield)
        Input: sUSDai.convertToAssets(1e18) snapshots
        Output: annualized exchange rate growth
        Cần keeper gọi snapshot() định kỳ (mỗi 24h)
```

---

## 2. AaveAprProvider

**File:** `contracts/oracles/providers/AaveAprProvider.sol`

### Spec

```solidity
/// @title AaveAprProvider
/// @notice Đọc Aave v3 USDC + USDT supply rate trên Arbitrum
/// @dev    Rate realtime — không cần snapshot hay keeper
///         Aave trả currentLiquidityRate đơn vị ray (1e27), convert sang 1e18
///         Formula: (supply_usdc × rate_usdc + supply_usdt × rate_usdt) / total_supply
///         See docs/PV_V3_MATH_REFERENCE.md section E1

contract AaveAprProvider {

    // ═══════════════════════════════════════════════════════════════
    //  IMMUTABLES
    // ═══════════════════════════════════════════════════════════════

    address public immutable i_aavePool;   // Aave v3 Pool (Arbitrum)
    address public immutable i_usdc;       // USDC (Arbitrum)
    address public immutable i_usdt;       // USDT (Arbitrum)
    address public immutable i_aUsdc;      // aUSDC (Arbitrum)
    address public immutable i_aUsdt;      // aUSDT (Arbitrum)

    uint256 private constant RAY_TO_WAD = 1e9;  // 1e27 → 1e18

    // ═══════════════════════════════════════════════════════════════
    //  LOGIC
    // ═══════════════════════════════════════════════════════════════

    /// @notice Tính benchmark APR = weighted average Aave USDC + USDT supply rate
    /// @return aprBenchmark 1e18 scale
    function fetchBenchmarkApr() external view returns (uint256 aprBenchmark) {
        // Đọc supply rate từ Aave
        uint256 rateUsdc = _getSupplyRate(i_usdc);    // ray → wad
        uint256 rateUsdt = _getSupplyRate(i_usdt);    // ray → wad

        // Đọc total supply (aToken balance = total supplied)
        uint256 supplyUsdc = IERC20(i_aUsdc).totalSupply();
        uint256 supplyUsdt = IERC20(i_aUsdt).totalSupply();
        uint256 totalSupply = supplyUsdc + supplyUsdt;

        if (totalSupply == 0) return 0;

        // Weighted average
        aprBenchmark = (supplyUsdc * rateUsdc + supplyUsdt * rateUsdt) / totalSupply;
    }

    /// @dev Đọc currentLiquidityRate từ Aave, convert ray → wad
    function _getSupplyRate(address asset) internal view returns (uint256) {
        DataTypes.ReserveData memory data = IPool(i_aavePool).getReserveData(asset);
        return data.currentLiquidityRate / RAY_TO_WAD;
    }
}
```

### Aave v3 Arbitrum addresses

```
Aave v3 Pool:  0x794a61358D6845594F94dc1DB02A252b5b4814aD
USDC:          0xaf88d065e77c8cC2239327C5EDb3A432268e5831
USDT:          0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9
aUSDC:         0x724dc807b04555b71ed48a6896b6F41593b8C637
aUSDT:         0x6ab707Aca953eDAeFBc4fD23bA73294241490620
```

---

## 3. SUSDaiAprProvider

**File:** `contracts/oracles/providers/SUSDaiAprProvider.sol`

### Vấn đề: sUSDai exchange rate on-chain nhưng không có "APR" trực tiếp

sUSDai là ERC-4626 → `convertToAssets(1e18)` cho biết 1 sUSDai = bao nhiêu USDai **tại thời điểm hiện tại**. Nhưng không cho biết APR.

Cần 2 data points để tính APR:

```
rate_prev = convertToAssets(1e18) tại thời điểm T-1
rate_now  = convertToAssets(1e18) tại thời điểm T-0
deltaT    = T-0 - T-1

APR = (rate_now / rate_prev - 1) × 365 days / deltaT
```

→ Cần **keeper gọi snapshot()** định kỳ để lưu rate_prev.

### Spec

```solidity
/// @title SUSDaiAprProvider
/// @notice Tính sUSDai APR từ exchange rate snapshots
/// @dev    Keeper gọi snapshot() mỗi 24h (hoặc thường xuyên hơn)
///         APR = annualized growth giữa 2 snapshots gần nhất
///         sUSDai contract: 0x0B2b2B2076d95dda7817e785989fE353fe955ef9 (Arbitrum)
///         See docs/PV_V3_MATH_REFERENCE.md section H3

contract SUSDaiAprProvider is Ownable2Step {

    // ═══════════════════════════════════════════════════════════════
    //  TYPES
    // ═══════════════════════════════════════════════════════════════

    struct RateSnapshot {
        uint256 rate;          // convertToAssets(1e18) tại thời điểm snapshot
        uint256 timestamp;     // block.timestamp
    }

    // ═══════════════════════════════════════════════════════════════
    //  IMMUTABLES
    // ═══════════════════════════════════════════════════════════════

    IERC4626 public immutable i_sUSDai;
    uint256 public constant MIN_SNAPSHOT_INTERVAL = 1 hours;

    // ═══════════════════════════════════════════════════════════════
    //  STATE
    // ═══════════════════════════════════════════════════════════════

    RateSnapshot public s_prevSnapshot;
    RateSnapshot public s_latestSnapshot;
    mapping(address => bool) public s_keepers;

    // ═══════════════════════════════════════════════════════════════
    //  ERRORS
    // ═══════════════════════════════════════════════════════════════

    error PrimeVaults__SnapshotTooSoon(uint256 elapsed, uint256 minimum);
    error PrimeVaults__NoSnapshotYet();
    error PrimeVaults__OnlyKeeper();

    // ═══════════════════════════════════════════════════════════════
    //  MODIFIERS
    // ═══════════════════════════════════════════════════════════════

    modifier onlyKeeper() {
        if (!s_keepers[msg.sender]) revert PrimeVaults__OnlyKeeper();
        _;
    }

    // ═══════════════════════════════════════════════════════════════
    //  CONSTRUCTOR
    // ═══════════════════════════════════════════════════════════════

    constructor(address sUSDai_, address initialKeeper) Ownable(msg.sender) {
        i_sUSDai = IERC4626(sUSDai_);
        s_keepers[initialKeeper] = true;

        // Seed first snapshot at deploy time
        uint256 currentRate = i_sUSDai.convertToAssets(1e18);
        s_latestSnapshot = RateSnapshot({rate: currentRate, timestamp: block.timestamp});
        // s_prevSnapshot stays zero — APR not available until second snapshot
    }

    // ═══════════════════════════════════════════════════════════════
    //  SNAPSHOT (keeper calls periodically)
    // ═══════════════════════════════════════════════════════════════

    /// @notice Record sUSDai exchange rate — keeper calls mỗi 24h
    /// @dev    Shifts latestSnapshot → prevSnapshot, records new latest
    ///         MIN_SNAPSHOT_INTERVAL prevents spam (1 hour minimum)
    function snapshot() external onlyKeeper {
        uint256 elapsed = block.timestamp - s_latestSnapshot.timestamp;
        if (elapsed < MIN_SNAPSHOT_INTERVAL) {
            revert PrimeVaults__SnapshotTooSoon(elapsed, MIN_SNAPSHOT_INTERVAL);
        }

        // Shift
        s_prevSnapshot = s_latestSnapshot;

        // Record new
        uint256 currentRate = i_sUSDai.convertToAssets(1e18);
        s_latestSnapshot = RateSnapshot({rate: currentRate, timestamp: block.timestamp});

        emit SnapshotRecorded(currentRate, block.timestamp);
    }

    // ═══════════════════════════════════════════════════════════════
    //  FETCH APR
    // ═══════════════════════════════════════════════════════════════

    /// @notice Tính sUSDai APR từ 2 snapshots gần nhất
    /// @dev    APR = (rate_now / rate_prev - 1) × 365 days / deltaT
    ///         Reverts nếu chưa có đủ 2 snapshots
    /// @return aprBase Annualized APR, 1e18 scale
    function fetchStrategyApr() external view returns (uint256 aprBase) {
        if (s_prevSnapshot.timestamp == 0) revert PrimeVaults__NoSnapshotYet();

        uint256 rateNow = s_latestSnapshot.rate;
        uint256 ratePrev = s_prevSnapshot.rate;
        uint256 deltaT = s_latestSnapshot.timestamp - s_prevSnapshot.timestamp;

        if (deltaT == 0 || ratePrev == 0) return 0;

        // Growth = (rateNow - ratePrev) / ratePrev
        // APR = growth × 365 days / deltaT
        if (rateNow <= ratePrev) return 0;  // no yield or negative → 0

        uint256 growth = (rateNow - ratePrev) * 1e18 / ratePrev;
        aprBase = growth * 365 days / deltaT;
    }

    // ═══════════════════════════════════════════════════════════════
    //  LIVE RATE (for real-time UI, not used by Accounting)
    // ═══════════════════════════════════════════════════════════════

    /// @notice Tính APR dùng latest snapshot + live rate (không chờ snapshot mới)
    /// @dev    Kém chính xác hơn fetchStrategyApr() nhưng realtime hơn
    /// @return aprLive Estimated live APR, 1e18 scale
    function fetchLiveApr() external view returns (uint256 aprLive) {
        if (s_latestSnapshot.timestamp == 0) return 0;

        uint256 rateLive = i_sUSDai.convertToAssets(1e18);
        uint256 ratePrev = s_latestSnapshot.rate;
        uint256 deltaT = block.timestamp - s_latestSnapshot.timestamp;

        if (deltaT == 0 || ratePrev == 0 || rateLive <= ratePrev) return 0;

        uint256 growth = (rateLive - ratePrev) * 1e18 / ratePrev;
        aprLive = growth * 365 days / deltaT;
    }

    // ═══════════════════════════════════════════════════════════════
    //  ADMIN
    // ═══════════════════════════════════════════════════════════════

    function setKeeper(address keeper, bool active) external onlyOwner {
        s_keepers[keeper] = active;
        emit KeeperUpdated(keeper, active);
    }

    // ═══════════════════════════════════════════════════════════════
    //  EVENTS
    // ═══════════════════════════════════════════════════════════════

    event SnapshotRecorded(uint256 rate, uint256 timestamp);
    event KeeperUpdated(address indexed keeper, bool active);
}
```

### Snapshot frequency

```
Recommended: keeper gọi mỗi 24h
Minimum interval: 1h (contract enforce)

Tại sao 24h?
  - sUSDai yield đến từ GPU loans — thay đổi chậm (không per-block)
  - 24h snapshot cho APR đủ chính xác (±0.5%)
  - Quá thường xuyên → APR nhảy lung tung vì noise ngắn hạn
  - Quá hiếm → APR không reflect thay đổi thị trường

Keeper options:
  - Gelato Automate (Arbitrum supported)
  - Chainlink Automation
  - Custom bot
```

---

## 4. AprPairFeed (updated)

**File:** `contracts/oracles/AprPairFeed.sol`

### Spec

```solidity
/// @title AprPairFeed
/// @notice Aggregates benchmark APR (Aave) + strategy APR (sUSDai) from providers
/// @dev    Replaces manual setAprPair. Both values fully on-chain.
///         Staleness check ensures data freshness.
///         Fallback: governance can override via setManualApr() for emergencies.
///         See docs/PV_V3_FINAL_v34.md section 29

contract AprPairFeed is Ownable2Step, IAprFeed {

    // ═══════════════════════════════════════════════════════════════
    //  IMMUTABLES
    // ═══════════════════════════════════════════════════════════════

    AaveAprProvider public immutable i_aaveProvider;
    SUSDaiAprProvider public immutable i_susdaiProvider;

    // ═══════════════════════════════════════════════════════════════
    //  STATE
    // ═══════════════════════════════════════════════════════════════

    uint256 public s_aprTarget;       // cached benchmark
    uint256 public s_aprBase;         // cached strategy APR
    uint256 public s_lastUpdated;
    uint256 public s_staleAfter;      // default: 48 hours

    bool public s_manualOverride;     // true = use manual values instead of providers
    uint256 public s_manualAprTarget;
    uint256 public s_manualAprBase;

    // ═══════════════════════════════════════════════════════════════
    //  ERRORS
    // ═══════════════════════════════════════════════════════════════

    error PrimeVaults__StaleApr(uint256 lastUpdated, uint256 staleAfter);

    // ═══════════════════════════════════════════════════════════════
    //  READ (Accounting calls this)
    // ═══════════════════════════════════════════════════════════════

    /// @notice Get APR pair — reverts if stale
    /// @return aprTarget Benchmark APR (Aave weighted avg)
    /// @return aprBase Strategy APR (sUSDai yield)
    function getAprPair() external view returns (uint256 aprTarget, uint256 aprBase) {
        if (block.timestamp - s_lastUpdated > s_staleAfter) {
            revert PrimeVaults__StaleApr(s_lastUpdated, s_staleAfter);
        }
        return (s_aprTarget, s_aprBase);
    }

    // ═══════════════════════════════════════════════════════════════
    //  UPDATE (keeper or anyone calls this)
    // ═══════════════════════════════════════════════════════════════

    /// @notice Fetch fresh APR from both providers and cache
    /// @dev    Permissionless — anyone can call (no value extraction possible)
    ///         In manual override mode: skips providers, uses manual values
    function updateRoundData() external {
        if (s_manualOverride) {
            s_aprTarget = s_manualAprTarget;
            s_aprBase = s_manualAprBase;
        } else {
            s_aprTarget = i_aaveProvider.fetchBenchmarkApr();
            s_aprBase = i_susdaiProvider.fetchStrategyApr();
        }

        s_lastUpdated = block.timestamp;
        emit AprUpdated(s_aprTarget, s_aprBase, block.timestamp);
    }

    // ═══════════════════════════════════════════════════════════════
    //  ADMIN
    // ═══════════════════════════════════════════════════════════════

    /// @notice Emergency manual override — governance sets APR directly
    /// @dev    Use when: provider broken, sUSDai contract paused, etc.
    function setManualApr(uint256 aprTarget, uint256 aprBase) external onlyOwner {
        s_manualOverride = true;
        s_manualAprTarget = aprTarget;
        s_manualAprBase = aprBase;
        emit ManualOverrideSet(aprTarget, aprBase);
    }

    /// @notice Disable manual override — resume reading from providers
    function clearManualOverride() external onlyOwner {
        s_manualOverride = false;
        emit ManualOverrideCleared();
    }

    function setStaleAfter(uint256 staleAfter_) external onlyOwner {
        s_staleAfter = staleAfter_;
    }

    // ═══════════════════════════════════════════════════════════════
    //  EVENTS
    // ═══════════════════════════════════════════════════════════════

    event AprUpdated(uint256 aprTarget, uint256 aprBase, uint256 timestamp);
    event ManualOverrideSet(uint256 aprTarget, uint256 aprBase);
    event ManualOverrideCleared();
}
```

---

## 5. Complete Flow

```
Keeper (mỗi 24h):
  │
  ├── SUSDaiAprProvider.snapshot()          ← record sUSDai rate
  │     └── reads sUSDai.convertToAssets(1e18)
  │     └── shifts prev ← latest, stores new latest
  │
  └── AprPairFeed.updateRoundData()         ← aggregate both APRs
        ├── AaveAprProvider.fetchBenchmarkApr()  ← live, no snapshot needed
        │     └── reads Aave USDC + USDT currentLiquidityRate
        │     └── weighted average
        │
        └── SUSDaiAprProvider.fetchStrategyApr() ← from snapshots
              └── (rate_now / rate_prev - 1) × 365 / deltaT

2 keeper calls total per cycle.


Accounting (mỗi user action):
  │
  └── AprPairFeed.getAprPair()              ← read cached values
        └── returns (aprTarget, aprBase)
        └── reverts if stale (> 48h since last updateRoundData)
```

---

## 6. Edge Cases

### sUSDai rate giảm (negative yield)

```
Nếu rate_now < rate_prev:
  → fetchStrategyApr() returns 0
  → aprBase = 0
  → Senior APR = MAX(aprTarget, 0 × ...) = aprTarget (benchmark floor)
  → Junior subsidizes Senior from premiums only
```

### Provider down / broken

```
Nếu SUSDaiAprProvider.snapshot() fails:
  → s_latestSnapshot stale
  → fetchStrategyApr() vẫn trả data cũ (từ snapshots trước)
  → Nếu quá stale: governance setManualApr() override

Nếu Aave v3 contract broken:
  → fetchBenchmarkApr() reverts
  → updateRoundData() reverts
  → getAprPair() returns stale cache
  → Nếu cache > staleAfter: revert → governance setManualApr()
```

### First 24h after deploy

```
Deploy SUSDaiAprProvider:
  → Constructor seeds first snapshot
  → s_prevSnapshot = zero
  → fetchStrategyApr() reverts (NoSnapshotYet)

After 24h, keeper calls snapshot():
  → s_prevSnapshot = constructor snapshot
  → s_latestSnapshot = new snapshot
  → fetchStrategyApr() hoạt động

Trong 24h đầu: dùng setManualApr() set aprBase từ off-chain observation.
Sau 24h: clearManualOverride() → tự động.
```

---

## 7. Updated Deployment Order

```
Shared (Arbitrum):
  1. RiskParams
  2. WETHPriceOracle (Chainlink ETH/USD Arbitrum)
  3. SwapFacility (Uniswap V3 Arbitrum)
  4. ERC20Cooldown
  5. UnstakeCooldown
  6. SharesCooldown

Per market (sUSDai market):
  7.  AaveAprProvider (Aave v3 Arbitrum)
  8.  SUSDaiAprProvider (sUSDai Arbitrum, keeper address)  ← NEW
  9.  AprPairFeed (aaveProvider, susdaiProvider)            ← UPDATED
  10. Accounting
  11. SUSDaiStrategy
  12. SUSDaiCooldownRequestImpl → register in UnstakeCooldown
  13. AaveWETHAdapter (Aave v3 Arbitrum)
  14. RedemptionPolicy
  15. PrimeCDO
      → setManualApr(benchmarkFromUI, aprBaseFromUI)  ← first 24h
  16. TrancheVault × 3
  17. Configure all
  18. After 24h: keeper calls snapshot() → clearManualOverride()  ← go live
```

---

## 8. Updated MVP Prompts

Replace PROMPT 5 in PV_V3_PROMPTS.md:

```
Do Step 5 from the updated APR Oracle spec (docs/PV_V3_APR_ORACLE.md).

Create 3 contracts:

1. contracts/oracles/providers/AaveAprProvider.sol
   - Reads Aave v3 Arbitrum USDC + USDT currentLiquidityRate
   - Returns weighted average as benchmark APR
   - Pure view function, no state, no keeper needed

2. contracts/oracles/providers/SUSDaiAprProvider.sol
   - snapshot(): keeper calls to record sUSDai.convertToAssets(1e18)
   - fetchStrategyApr(): compute APR from 2 snapshots
   - fetchLiveApr(): realtime estimate using latest snapshot + live rate
   - MIN_SNAPSHOT_INTERVAL = 1 hour

3. contracts/oracles/AprPairFeed.sol
   - updateRoundData(): fetch from both providers, cache
   - getAprPair(): return cached values, revert if stale
   - setManualApr(): emergency override by governance
   - clearManualOverride(): resume auto mode
   - Permissionless updateRoundData (anyone can call)

For testing create:
  test/helpers/mocks/MockERC4626.sol — simulate sUSDai with configurable rate
  test/helpers/mocks/MockAavePool.sol — simulate Aave getReserveData

Write tests:
  test/unit/AaveAprProvider.test.ts
  test/unit/SUSDaiAprProvider.test.ts
  test/unit/AprPairFeed.test.ts

Run compile + tests.
```

---

## 9. Arbitrum-Specific Notes

### Aave v3 Arbitrum

```
Pool:     0x794a61358D6845594F94dc1DB02A252b5b4814aD
USDC:     0xaf88d065e77c8cC2239327C5EDb3A432268e5831 (native USDC)
USDT:     0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9
aUSDC:    0x724dc807b04555b71ed48a6896b6F41593b8C637
aUSDT:    0x6ab707Aca953eDAeFBc4fD23bA73294241490620
WETH:     0x82aF49447D8a07e3bd95BD0d56f35241523fBab1
aWETH:    0xe50fA9b3c56FfB159cB0FCA61F5c9D750e8128c8
```

### Chainlink Arbitrum

```
ETH/USD:  0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612
```

### Uniswap V3 Arbitrum

```
Router:   0xE592427A0AEce92De3Edee1F18E0157C05861564
```

### sUSDai specifics

```
sUSDai:   0x0B2b2B2076d95dda7817e785989fE353fe955ef9
USDai:    0x0A1a1A107E45b7Ced86833863f482BC5f4ed82EF

Interface: ERC-4626 deposit + ERC-7540 async redeem
  deposit(assets, receiver) → shares     (synchronous, standard ERC-4626)
  requestRedeem(shares, receiver, owner)  (ERC-7540 async, starts ~7 day cooldown)
  redeem(shares, receiver, owner)         (after cooldown complete)
  convertToAssets(shares) → assets        (view, for APR calculation)
```

---

_PrimeVaults V3 — APR Oracle (Fully On-Chain) v3.4.2_  
_Arbitrum deployment, sUSDai-based strategy_  
_March 2026_
