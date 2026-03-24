# PrimeVaults V3 — APR Oracle

**Version:** 3.6.0  
**Mode:** PULL only (trustless, no PUSH)  
**Inherits:** Strata AprPairFeed (rounds buffer, bounds, int64×12dec)  
**Custom:** SUSDaiAprPairProvider (snapshot-based)

---

## 1. Design

```
AprPairFeed (PULL only)
      │
      │  updateRoundData()        ← keeper triggers (KEEPER_ROLE)
      │  latestRoundData()        ← Accounting reads (view)
      │
      └── SUSDaiAprPairProvider
            │
            ├── getAprPair()      ← state-changing: shift snapshots + compute
            │                        (called by updateRoundData)
            │
            └── getAprPairView()  ← pure view: read existing snapshots
                                     (called by latestRoundData fallback)

No PUSH mode. No ESourcePref. No one controls APR data.
APR = 100% from on-chain contracts (Aave + sUSDai).
Keeper only triggers — cannot influence output.
```

### Why no PUSH

```
✓ Trustless — no key can push arbitrary APR data
✓ No Resolv-style attack surface (compromised key → push fake data)
✓ Less code, less audit surface
✓ Provider view fallback handles all failure cases:
    - sUSDai broken → getAprPairView() reads STORAGE snapshots, not sUSDai contract
    - Keeper down → latestRoundData() falls back to getAprPairView()
    - Both → stale but functional (APR from last valid snapshots + Aave realtime)
```

---

## 2. Interface

**File:** `contracts/interfaces/IAprPairFeed.sol`

```solidity
interface IStrategyAprPairProvider {
    /// @notice Shift snapshots + compute APRs (state-changing)
    /// @dev    Called by AprPairFeed.updateRoundData()
    function getAprPair() external returns (int64 aprTarget, int64 aprBase, uint64 timestamp);

    /// @notice Read APRs from existing snapshots (pure view, no shift)
    /// @dev    Called by AprPairFeed.latestRoundData() as fallback
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
    function updateRoundData() external;
}
```

---

## 3. AprPairFeed — PULL Only

**File:** `contracts/oracles/AprPairFeed.sol`

```solidity
/// @title AprPairFeed
/// @author PrimeVaults Team
/// @notice Caches APR pair from provider. PULL only — no PUSH, trustless.
/// @dev    Keeper calls updateRoundData() → provider shifts snapshots + computes APRs → cache.
///         Accounting calls latestRoundData() → returns cache if fresh, provider view if stale.
///         20-round circular buffer. Bounds [-50%, +200%]. int64 × 12 decimals.
///         Removed vs Strata: ESourcePref, PUSH overload, SourcePrefChanged event.

contract AprPairFeed is IAprPairFeed, AccessControl {

    // ═══════════════════════════════════════════════════════════════
    //  CONSTANTS
    // ═══════════════════════════════════════════════════════════════

    int64 private constant APR_BOUNDARY_MAX = 2e12;      // 200%
    int64 private constant APR_BOUNDARY_MIN = -0.5e12;   // -50%
    uint64 private constant MAX_FUTURE_DRIFT = 60;
    uint8 public constant ROUNDS_CAP = 20;
    uint8 public constant DECIMALS = 12;

    bytes32 public constant KEEPER_ROLE = keccak256("KEEPER_ROLE");

    // ═══════════════════════════════════════════════════════════════
    //  STATE
    // ═══════════════════════════════════════════════════════════════

    string public s_description;
    uint64 public s_currentRoundId;
    uint64 public s_oldestRoundId;
    TRound public s_latestRound;
    mapping(uint256 => TRound) public s_rounds;
    uint256 public s_roundStaleAfter;
    IStrategyAprPairProvider public s_provider;

    // ═══════════════════════════════════════════════════════════════
    //  EVENTS
    // ═══════════════════════════════════════════════════════════════

    event RoundUpdated(uint64 roundId, int64 aprTarget, int64 aprBase, uint64 updatedAt);
    event ProviderSet(address newProvider);
    event StalePeriodSet(uint256 stalePeriod);

    // ═══════════════════════════════════════════════════════════════
    //  ERRORS
    // ═══════════════════════════════════════════════════════════════

    error PrimeVaults__StaleUpdate(int64 aprTarget, int64 aprBase, uint64 timestamp);
    error PrimeVaults__OutOfOrderUpdate(int64 aprTarget, int64 aprBase, uint64 timestamp);
    error PrimeVaults__InvalidApr(int64 value);
    error PrimeVaults__RoundNotAvailable(uint64 roundId);

    // ═══════════════════════════════════════════════════════════════
    //  CONSTRUCTOR
    // ═══════════════════════════════════════════════════════════════

    constructor(address admin_, IStrategyAprPairProvider provider_, uint256 roundStaleAfter_, string memory description_) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin_);
        s_provider = provider_;
        s_roundStaleAfter = roundStaleAfter_;
        s_description = description_;
    }

    // ═══════════════════════════════════════════════════════════════
    //  READ — Accounting calls this
    // ═══════════════════════════════════════════════════════════════

    /// @notice Get latest APR pair — cache if fresh, provider view if stale
    /// @dev    staleAfter controls cache lifetime.
    ///         Fallback calls getAprPairView() (view, no state mutation).
    function latestRoundData() external view returns (TRound memory) {
        TRound memory round = s_latestRound;

        if (round.updatedAt > 0) {
            uint256 deltaT = block.timestamp - uint256(round.updatedAt);
            if (deltaT < s_roundStaleAfter) {
                return round;
            }
        }

        // Cache stale or empty → fallback to provider view
        (int64 aprTarget, int64 aprBase, uint64 t1) = s_provider.getAprPairView();
        _ensureValid(aprTarget);
        _ensureValid(aprBase);
        return TRound({
            aprTarget: aprTarget,
            aprBase: aprBase,
            updatedAt: t1,
            answeredInRound: s_currentRoundId + 1
        });
    }

    /// @notice Get historical round by ID
    function getRoundData(uint64 roundId) external view returns (TRound memory) {
        if (roundId < s_oldestRoundId || roundId > s_currentRoundId) {
            revert PrimeVaults__RoundNotAvailable(roundId);
        }
        uint256 idx = (roundId - 1) % ROUNDS_CAP;
        return s_rounds[idx];
    }

    // ═══════════════════════════════════════════════════════════════
    //  UPDATE — Keeper triggers PULL
    // ═══════════════════════════════════════════════════════════════

    /// @notice Pull APR from provider — shifts snapshots + caches result
    /// @dev    Keeper triggers only — cannot influence output.
    ///         Provider.getAprPair() is state-changing (shifts sUSDai snapshots).
    function updateRoundData() external onlyRole(KEEPER_ROLE) {
        (int64 aprTarget, int64 aprBase, uint64 t) = s_provider.getAprPair();
        _storeRound(aprTarget, aprBase, t);
    }

    // ═══════════════════════════════════════════════════════════════
    //  INTERNAL
    // ═══════════════════════════════════════════════════════════════

    function _storeRound(int64 aprTarget, int64 aprBase, uint64 t) internal {
        if (uint256(t) < block.timestamp - s_roundStaleAfter) {
            revert PrimeVaults__StaleUpdate(aprTarget, aprBase, t);
        }
        if (s_latestRound.updatedAt > 0 && (t <= s_latestRound.updatedAt || uint256(t) > block.timestamp + MAX_FUTURE_DRIFT)) {
            revert PrimeVaults__OutOfOrderUpdate(aprTarget, aprBase, t);
        }
        _ensureValid(aprTarget);
        _ensureValid(aprBase);

        s_currentRoundId++;
        uint256 idx = (s_currentRoundId - 1) % ROUNDS_CAP;

        TRound memory round = TRound({
            aprTarget: aprTarget,
            aprBase: aprBase,
            updatedAt: t,
            answeredInRound: s_currentRoundId
        });

        s_latestRound = round;
        s_rounds[idx] = round;

        if (s_currentRoundId > uint64(ROUNDS_CAP)) {
            s_oldestRoundId = s_currentRoundId - uint64(ROUNDS_CAP) + 1;
        } else if (s_oldestRoundId == 0) {
            s_oldestRoundId = 1;
        }

        emit RoundUpdated(s_currentRoundId, aprTarget, aprBase, t);
    }

    function _ensureValid(int64 answer) internal pure {
        if (answer < APR_BOUNDARY_MIN || answer > APR_BOUNDARY_MAX) {
            revert PrimeVaults__InvalidApr(answer);
        }
    }

    // ═══════════════════════════════════════════════════════════════
    //  ADMIN
    // ═══════════════════════════════════════════════════════════════

    /// @dev Calls getAprPairView() for compat check (view, no side effect)
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

## 4. SUSDaiAprPairProvider — Unchanged

Same as v3.5.1. Dual entry: `getAprPair()` (mutate) + `getAprPairView()` (view).

Benchmark: Aave weighted avg, `benchmarkTokens[]`, aToken from `getReserveData()`, cap 40%.
Strategy: snapshot growth, supports negative, clamp [-50%, +200%].

Full spec in v3.5.1 section 5. No changes needed.

---

## 5. Removed vs Strata

```
Removed:
  ✗ updateRoundData(int64, int64, uint64) overload    (PUSH)
  ✗ ESourcePref enum                                   (Feed/Strategy)
  ✗ s_sourcePref state variable
  ✗ _ensureSourcePref() function
  ✗ SourcePrefChanged event
  ✗ UPDATER_FEED_ROLE → replaced with KEEPER_ROLE

Kept:
  ✓ updateRoundData() no-args                          (PULL)
  ✓ latestRoundData() with cache + view fallback
  ✓ 20-round circular buffer with oldestRoundId tracking
  ✓ Bounds checking [-50%, +200%]
  ✓ Out-of-order + stale timestamp validation
  ✓ getRoundData() historical access
  ✓ setProvider() with compat check
  ✓ int64 × 12 decimals

Added:
  + getAprPairView() on provider interface (for view fallback)
  + oldestRoundId tracking (cleaner than Strata's answeredInRound check)
```

---

## 6. Flow

```
NORMAL (keeper mỗi 24h):

  Keeper (KEEPER_ROLE):
    AprPairFeed.updateRoundData()
      └── provider.getAprPair()            // STATE-CHANGING
            ├── shift: prev ← latest, latest ← sUSDai.convertToAssets()
            ├── _computeBenchmarkApr()      // Aave weighted avg (view)
            └── _computeStrategyApr()       // annualized growth (view)
      └── _storeRound() → buffer + s_latestRound

  Accounting (mỗi user action):
    AprPairFeed.latestRoundData()           // VIEW
      └── cache < 48h? → return cache       // fast path
      └── cache stale? → provider.getAprPairView()  // fallback


KEEPER DOWN (> 48h):

  latestRoundData():
    cache stale → provider.getAprPairView()
      ├── _computeBenchmarkApr() → Aave LIVE (realtime)
      └── _computeStrategyApr() → from LAST STORED snapshots (stale but valid)
    → Protocol continues. APR = stale strategy + fresh benchmark.
    → Khi keeper recover → next updateRoundData() refreshes snapshots.


sUSDai CONTRACT BROKEN:

  updateRoundData():
    provider.getAprPair() → sUSDai.convertToAssets() REVERT
    → Keeper call fails → no new round → cache stays

  latestRoundData():
    cache stale → provider.getAprPairView()
      ├── _computeBenchmarkApr() → Aave LIVE ✓
      └── _computeStrategyApr() → reads s_prevRate, s_latestRate from STORAGE ✓
                                   does NOT call sUSDai contract
    → Protocol continues with last valid APR.
```

---

## 7. staleAfter Behavior

```
staleAfter = 48 hours (default)

latestRoundData():
  cache < 48h old:   return cache (fast, no external call)
  cache ≥ 48h old:   call getAprPairView() (fresh benchmark, stale strategy)
  cache empty:       call getAprPairView()

_storeRound():
  provider timestamp < (now - 48h):   revert StaleUpdate (data too old)
  provider timestamp > (now + 60s):   revert OutOfOrderUpdate (future)

Keeper gọi mỗi 24h → cache luôn < 24h < 48h → latestRoundData() luôn trả cache.
getAprPairView() chỉ là backup nếu keeper miss > 48h.
```

---

## 8. Deployment

```
1. SUSDaiAprPairProvider(aavePool, [USDC, USDT], sUSDai)
   → Seeds first sUSDai snapshot

2. AprPairFeed(admin, provider, staleAfter=172800, "PrimeVaults sUSDai")
   → Grant KEEPER_ROLE to keeper bot address

3. Keeper gọi updateRoundData() lần 1 (24h sau deploy)
   → First snapshot pair → aprBase = 0 (chỉ 1 snapshot)

4. Keeper gọi updateRoundData() lần 2 (48h sau deploy)
   → 2 valid snapshots → aprBase accurate → system fully autonomous
```

---

## 9. sUSDai Verified Interface (from Arbiscan ABI)

**Contract:** `0x0B2b2B2076d95dda7817e785989fE353fe955ef9` (TransparentUpgradeableProxy)  
**Implementation:** `0xc0540184de0e42eab2b0a4fc35f4817041001e85`  
**Builder:** MetaStreet Labs (Permian Labs)

### ERC-4626 Deposit (synchronous)

```
deposit(amount, receiver) → shares
deposit(amount, receiver, minShares) → shares          // slippage protection
mint(shares, receiver) → assets
mint(shares, receiver, maxAmount) → assets             // slippage protection
convertToAssets(shares) → assets
convertToShares(assets) → shares
depositSharePrice() → uint256
totalAssets() → uint256
```

### ERC-7540 Redeem (async, FIFO queue)

```
requestRedeem(shares, controller, owner) → uint256 redemptionId

redemption(redemptionId) → (Redemption struct, uint256)
  struct Redemption {
      uint256 prev;                 // linked list
      uint256 next;                 // linked list
      uint256 pendingShares;        // shares waiting in queue
      uint256 redeemableShares;     // shares ready to claim
      uint256 withdrawableAmount;   // USDai amount claimable
      address controller;           // who controls this redemption
      uint64 redemptionTimestamp;   // EXACT unlock timestamp
  }

claimableRedeemRequest(redemptionId, controller) → uint256 shares
pendingRedeemRequest(redemptionId, controller) → uint256 shares
redeem(shares, receiver, controller) → uint256 assets
redemptionIds(controller) → uint256[] ids
redemptionTimestamp() → uint64                         // global redemption timelock
redemptionSharePrice() → uint256                       // share price for redemptions
redemptionQueueInfo() → (index, head, tail, pending, balance)

serviceRedemptions(shares) → uint256                   // STRATEGY_ADMIN_ROLE only
```

### Key findings for PrimeVaults integration

```
1. requestRedeem() returns redemptionId (uint256) — use this to track
2. redemption(id).redemptionTimestamp = EXACT unlock time from contract
   → No need for s_unstakeDuration governance-set estimate
   → No need to hardcode 7 days
3. claimableRedeemRequest(id, controller) > 0 = ready to claim
   → Source of truth for isCooldownComplete()
   → redemptionTimestamp is necessary but NOT sufficient
     (admin must call serviceRedemptions() to process queue)
4. FIFO queue — redemptions processed head-to-tail by admin
   → PrimeVaults cannot control when admin services queue
   → But can read exact state via claimableRedeemRequest()
5. Multiple redemptionIds per controller — track each separately
   → redemptionIds(controller) returns full list
```

---

## 10. Arbitrum Addresses

```
Aave v3 Pool:   0x794a61358D6845594F94dc1DB02A252b5b4814aD
USDC:           0xaf88d065e77c8cC2239327C5EDb3A432268e5831
USDT:           0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9
sUSDai:         0x0B2b2B2076d95dda7817e785989fE353fe955ef9
USDai:          0x0A1a1A107E45b7Ced86833863f482BC5f4ed82EF
```

---

_PrimeVaults V3 — APR Oracle v3.6.0_  
_PULL only • Trustless • No PUSH attack surface_  
_sUSDai interface verified from Arbiscan ABI_  
_March 2026_
