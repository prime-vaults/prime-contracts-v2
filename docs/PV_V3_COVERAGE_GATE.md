# PrimeVaults V3 — Coverage Gate System

**Addendum to:** PV_V3_FINAL_v34.md  
**Version:** 3.4.1  
**Reference:** Strata `setMinimumJrtSrtRatio`, `setMinimumJrtSrtRatioBuffer`, `setJrtShortfallPausePrice`

---

## 1. Problem Statement

PrimeVaults V3 hiện tại chỉ control **withdrawal** qua RedemptionPolicy (cooldown + fee). Nhưng không control **deposit** — nghĩa là khi coverage thấp, ai cũng có thể deposit thêm Senior/Mezz, làm coverage tệ hơn. Và Junior withdraw chỉ bị delay (SharesLock), không bị hard block — sau 7 ngày vẫn rút được, coverage vẫn crash.

Strata giải quyết bằng 2 mechanism:
1. **Block Senior minting** khi coverage dưới ngưỡng
2. **Block Junior redemption** khi coverage dưới ngưỡng

PrimeVaults cần cả 2, plus thêm mechanism thứ 3 mà Strata cũng có:
3. **Auto-pause** khi Junior exchange rate giảm đột ngột (strategy loss detection)

---

## 2. Coverage Gate — Contract

**Location:** Logic nằm trực tiếp trong `PrimeCDO.sol` (không cần contract mới).

### New state variables

```solidity
/// @notice Minimum coverage ratio to allow Senior/Mezz deposits
/// @dev    Below this: Senior/Mezz deposit REVERTS
///         Default: 1.05e18 (105%)
///         Strata equivalent: setMinimumJrtSrtRatioBuffer
uint256 public s_minCoverageForDeposit;

/// @notice Minimum coverage ratio to allow Junior withdrawals
/// @dev    Below this: Junior withdraw REVERTS (hard block, not just delay)
///         Default: 1.05e18 (105%)
///         Strata equivalent: setMinimumJrtSrtRatio
uint256 public s_minCoverageForJuniorRedeem;

/// @notice Minimum Junior exchange rate before auto-pause
/// @dev    If pvJUNIOR pricePerShare drops below this: ALL actions paused
///         Default: 0.90e18 (90% of initial — i.e. 10% loss triggers pause)
///         Strata equivalent: setJrtShortfallPausePrice
///         Set to 0 to disable
uint256 public s_juniorShortfallPausePrice;

/// @notice Whether protocol is auto-paused due to shortfall
bool public s_shortfallPaused;
```

### Governance setters

```solidity
/// @dev All setters: onlyGovernance, timelock 24h

function setMinCoverageForDeposit(uint256 minCoverage) external onlyGovernance {
    require(minCoverage >= 1.0e18 && minCoverage <= 2.0e18, "out of range");
    s_minCoverageForDeposit = minCoverage;
    emit MinCoverageForDepositUpdated(minCoverage);
}

function setMinCoverageForJuniorRedeem(uint256 minCoverage) external onlyGovernance {
    require(minCoverage >= 1.0e18 && minCoverage <= 2.0e18, "out of range");
    s_minCoverageForJuniorRedeem = minCoverage;
    emit MinCoverageForJuniorRedeemUpdated(minCoverage);
}

function setJuniorShortfallPausePrice(uint256 price) external onlyGovernance {
    s_juniorShortfallPausePrice = price;
    emit JuniorShortfallPausePriceUpdated(price);
}

/// @notice Unpause after shortfall — governance only, requires coverage recovery
function unpauseShortfall() external onlyGovernance {
    require(s_shortfallPaused, "not paused");
    // Optionally: require coverage above threshold before unpause
    s_shortfallPaused = false;
    emit ShortfallUnpaused();
}
```

---

## 3. Modified PrimeCDO — Deposit with Coverage Gate

### Senior/Mezz deposit

```solidity
function deposit(
    TrancheId tranche,
    address token,
    uint256 amount
) external onlyTranche(tranche) returns (uint256 baseAmount) {

    // ─── SHORTFALL CHECK ─────────────────────────────────────────────
    require(!s_shortfallPaused, "protocol paused: junior shortfall");

    // ─── UPDATE ACCOUNTING ───────────────────────────────────────────
    uint256 wethUSD = IAaveWETHAdapter(i_aaveWETHAdapter).totalAssetsUSD();
    IAccounting(i_accounting).updateTVL(IStrategy(i_strategy).totalAssets(), wethUSD);

    // ─── COVERAGE GATE: block Senior/Mezz deposit if coverage too low ─
    if (tranche == TrancheId.SENIOR || tranche == TrancheId.MEZZ) {
        uint256 coverage = _getCoverage();
        require(
            coverage >= s_minCoverageForDeposit,
            "coverage too low: sr/mz deposit blocked"
        );
    }

    // ─── SHORTFALL DETECTION ─────────────────────────────────────────
    _checkJuniorShortfall();

    // ─── ROUTE TO STRATEGY ───────────────────────────────────────────
    IERC20(token).approve(i_strategy, amount);
    uint256 shares = IStrategy(i_strategy).depositToken(token, amount);
    baseAmount = _sharesToAssets(shares);
    IAccounting(i_accounting).recordDeposit(tranche, baseAmount);
}
```

### Junior deposit (dual-asset)

```solidity
function depositJunior(
    address baseToken,
    uint256 baseAmount,
    uint256 wethAmount,
    address depositor
) external onlyTranche(TrancheId.JUNIOR) returns (uint256 totalBaseValue) {

    // ─── SHORTFALL CHECK ─────────────────────────────────────────────
    require(!s_shortfallPaused, "protocol paused: junior shortfall");

    // ─── UPDATE ACCOUNTING ───────────────────────────────────────────
    // ... (existing logic) ...

    // ─── NOTE: Junior deposits are ALWAYS allowed ────────────────────
    // Junior deposit INCREASES coverage (good)
    // No coverage gate needed for Junior deposits
    // In fact, Junior deposits are the PRIMARY way coverage recovers

    // ─── SHORTFALL DETECTION ─────────────────────────────────────────
    _checkJuniorShortfall();

    // ─── VALIDATE RATIO + ROUTE ──────────────────────────────────────
    // ... (existing 8:2 logic) ...
}
```

---

## 4. Modified PrimeCDO — Withdraw with Coverage Gate

### All tranches

```solidity
function requestWithdraw(
    TrancheId tranche,
    uint256 baseAmount,
    address outputToken,
    address beneficiary,
    uint256 vaultShares
) external onlyTranche(tranche) returns (CDOWithdrawResult memory result) {

    // ─── SHORTFALL CHECK ─────────────────────────────────────────────
    require(!s_shortfallPaused, "protocol paused: junior shortfall");

    // ─── UPDATE ACCOUNTING ───────────────────────────────────────────
    uint256 wethUSD = IAaveWETHAdapter(i_aaveWETHAdapter).totalAssetsUSD();
    IAccounting(i_accounting).updateTVL(IStrategy(i_strategy).totalAssets(), wethUSD);

    // ─── COVERAGE GATE: hard block Junior withdraw if coverage too low ─
    if (tranche == TrancheId.JUNIOR) {
        uint256 coverage = _getCoverage();
        require(
            coverage >= s_minCoverageForJuniorRedeem,
            "coverage too low: jr withdraw blocked"
        );
    }

    // ─── NOTE: Senior/Mezz withdrawals are ALWAYS allowed ────────────
    // Senior/Mezz withdraw INCREASES coverage (good)
    // Blocking Senior/Mezz withdrawals would trap user funds unfairly
    // RedemptionPolicy (cooldown + fee) already handles Sr/Mz exits

    // ─── SHORTFALL DETECTION ─────────────────────────────────────────
    _checkJuniorShortfall();

    // ─── PROCESS WITHDRAWAL (existing logic) ─────────────────────────
    // ... RedemptionPolicy → cooldown routing ...
}
```

---

## 5. Junior Shortfall Auto-Pause

### Detection

```solidity
/// @notice Check if Junior exchange rate dropped below pause threshold
/// @dev    Called on every deposit/withdraw. If triggered, ALL actions blocked
///         until governance manually unpauses after investigation.
function _checkJuniorShortfall() internal {
    if (s_juniorShortfallPausePrice == 0) return; // disabled

    address juniorVault = s_tranches[TrancheId.JUNIOR];
    uint256 totalAssets = IAccounting(i_accounting).getJuniorTVL();
    uint256 totalSupply = IERC20(juniorVault).totalSupply();

    if (totalSupply == 0) return; // no shares minted yet

    uint256 pricePerShare = totalAssets * 1e18 / totalSupply;

    if (pricePerShare < s_juniorShortfallPausePrice) {
        s_shortfallPaused = true;
        emit ShortfallPauseTriggered(pricePerShare, s_juniorShortfallPausePrice);
    }
}
```

### What happens when auto-paused

```
s_shortfallPaused = true

ALL actions blocked:
  ✗ Senior/Mezz deposit → revert
  ✗ Junior deposit → revert
  ✗ Senior/Mezz withdraw → revert
  ✗ Junior withdraw → revert
  ✗ Rebalance → revert

Still allowed:
  ✓ claimWithdraw() for EXISTING pending cooldowns (users already in queue)
  ✓ Governance unpause
  ✓ Guardian emergency actions

Why pause EVERYTHING?
  → Junior shortfall means strategy had significant loss
  → Need time to investigate: is it oracle issue? actual loss? exploit?
  → Allowing any action during investigation could worsen damage
  → Strata does the same: full protocol halt on shortfall
```

### Unpause flow

```
1. Governance investigates root cause
2. If false alarm (oracle glitch): unpauseShortfall()
3. If real loss: 
   a. Wait for loss waterfall to process (WETH sell + Jr absorb)
   b. Verify accounting is correct post-loss
   c. Optionally adjust s_juniorShortfallPausePrice to new level
   d. unpauseShortfall()
4. Protocol resumes
```

---

## 6. Complete Action Matrix

### Who can do what at each coverage level

```
coverage =  TVL_pool / TVL_jr

                        > 2.0x      1.5-2.0x     1.2-1.5x     1.05-1.2x    < 1.05x
─────────────────────────────────────────────────────────────────────────────────────
Sr/Mz DEPOSIT           ✓           ✓            ✓             ✗ BLOCKED    ✗ BLOCKED
Jr DEPOSIT              ✓           ✓            ✓             ✓            ✓ (always)
Sr/Mz WITHDRAW          instant     assetsLock   sharesLock    sharesLock   sharesLock
Jr WITHDRAW             instant     assetsLock   sharesLock    ✗ BLOCKED    ✗ BLOCKED
Jr WETH portion         instant     instant      instant       ✗ BLOCKED    ✗ BLOCKED
─────────────────────────────────────────────────────────────────────────────────────

Junior shortfall (exchange rate drop):
  ALL actions → ✗ BLOCKED (except claim existing cooldowns)
```

### Logic tại sao mỗi cell

```
Sr/Mz DEPOSIT blocked below 1.05x:
  → Thêm Senior/Mezz khi coverage thấp = thêm "nợ" cho Junior bảo vệ
  → Unfair cho Junior holders hiện tại
  → Strata equivalent: srUSDe minting paused below 105%

Jr DEPOSIT always allowed:
  → Junior deposit TĂNG coverage (tốt cho protocol)
  → Đây là cách chính để recovery
  → RP2 cao khi coverage thấp → tự thu hút Junior capital

Jr WITHDRAW blocked below 1.05x:
  → Junior rút → coverage giảm thêm → death spiral
  → Hard block (không phải delay) vì delay vẫn cho rút sau N ngày
  → Strata equivalent: jrUSDe redemption blocked below 105%

Sr/Mz WITHDRAW always allowed (with cooldown):
  → Blocking Senior/Mezz withdrawals = trapping user funds
  → Ethically và legally problematic
  → Cooldown + fee đã sufficient disincentive
  → Sr/Mz withdraw TĂNG coverage (ít "nợ" cho Junior bảo vệ)
```

---

## 7. Coverage Calculation

```solidity
function _getCoverage() internal view returns (uint256) {
    (uint256 sr, uint256 mz, uint256 jr) = IAccounting(i_accounting).getAllTVLs();
    if (jr == 0) return type(uint256).max; // no Junior = infinite coverage
    return (sr + mz + jr) * 1e18 / jr;
}
```

### Edge case: Jr TVL = 0

```
Nếu tất cả Junior rút hết → jr = 0 → coverage = ∞

Lúc này:
  Sr/Mz deposit: coverage ∞ > 1.05 → allowed ✓
  → NHƯNG: không có Junior bảo vệ gì cả!
  
  Fix: thêm check riêng
  IF jr == 0 AND (sr + mz) > 0:
    → Block Sr/Mz deposit (không có Junior = không có protection)
    → Chỉ cho deposit Jr trước, sau đó mới Sr/Mz
```

```solidity
function _getCoverage() internal view returns (uint256) {
    (uint256 sr, uint256 mz, uint256 jr) = IAccounting(i_accounting).getAllTVLs();
    if (jr == 0) {
        if (sr + mz > 0) return 0;    // no protection → coverage = 0 → block deposits
        return type(uint256).max;       // empty protocol → allow first deposit from any tranche
    }
    return (sr + mz + jr) * 1e18 / jr;
}
```

---

## 8. Default Parameters

```
s_minCoverageForDeposit      = 1.05e18  (105%)
s_minCoverageForJuniorRedeem = 1.05e18  (105%)
s_juniorShortfallPausePrice  = 0.90e18  (90% of initial = 10% loss triggers pause)
```

### Timelock

```
setMinCoverageForDeposit:       24h timelock
setMinCoverageForJuniorRedeem:  24h timelock
setJuniorShortfallPausePrice:   24h timelock
unpauseShortfall:               governance only (no timelock — need fast recovery)
```

---

## 9. Interaction with Existing Systems

### RedemptionPolicy + Coverage Gate

```
Coverage gate runs BEFORE RedemptionPolicy:

  requestWithdraw():
    1. Check shortfall pause      ← NEW
    2. Check coverage gate        ← NEW (Jr only)
    3. Query RedemptionPolicy     ← existing (cooldown + fee)
    4. Process withdrawal         ← existing

Coverage gate = hard block (revert)
RedemptionPolicy = soft block (delay + fee)

If both apply (e.g. coverage = 1.04x, Jr withdraw):
  → Coverage gate reverts FIRST → RedemptionPolicy never reached
  → User cannot withdraw at all until coverage > 1.05x
```

### Asymmetric Rebalance + Coverage Gate

```
rebalanceSellWETH():
  → Requires !s_shortfallPaused
  → No coverage gate (selling WETH is always fine directionally)

rebalanceBuyWETH():
  → Requires !s_shortfallPaused
  → Governance-only (existing)
  → No additional coverage gate (governance already decided)
```

### Loss Waterfall + Shortfall Pause

```
Loss detected in updateTVL():
  → Loss waterfall executes (WETH sell → Jr base → Mz → Sr)
  → AFTER waterfall: _checkJuniorShortfall() runs
  → If Jr exchange rate dropped below threshold → auto-pause
  → Prevents further actions until governance reviews

Timeline:
  Block N:     Strategy reports loss
  Block N:     updateTVL() runs waterfall + shortfall check
  Block N:     s_shortfallPaused = true (if threshold breached)
  Block N+1:   All user actions revert
  Governance:  Investigate → unpause when safe
```

---

## 10. Audit Notes

```
AUDIT NOTE — Coverage Gate:

AD-11: Sr/Mz deposit blocked below 105% coverage (intentional, Strata-equivalent)
AD-12: Jr withdraw hard-blocked below 105% (not just delayed)
AD-13: Jr deposit always allowed (increases coverage = good)
AD-14: Sr/Mz withdraw always allowed with cooldown (blocking = trapping funds)
AD-15: Auto-pause on Jr shortfall blocks ALL actions (full halt for investigation)
AD-16: coverage = 0 when jr == 0 AND pool > 0 (prevents deposit without protection)

INV-8:  Coverage gate check happens BEFORE RedemptionPolicy
INV-9:  shortfallPaused blocks new actions but NOT pending cooldown claims
INV-10: unpauseShortfall is governance-only (cannot be called by anyone else)

S-8: Edge case: coverage oscillates around 1.05x → rapid block/unblock?
     → Not an issue: coverage gate is checked per-tx, not continuous.
        If coverage = 1.049 → blocked. Next Jr deposit → coverage > 1.05 → unblocked.
        No oscillation risk because the gate itself doesn't change coverage.

S-9: Can attacker manipulate coverage to block Sr/Mz deposits?
     → Would need to reduce Jr TVL → requires being Jr depositor and withdrawing
     → But Jr withdraw is also blocked below 1.05x → cannot self-trigger
     → Only organic coverage decrease (strategy loss) can trigger the gate

S-10: Jr shortfall pause threshold — what if oracle returns wrong price?
      → pricePerShare is computed from on-chain totalAssets/totalSupply, no oracle
      → Only strategy.totalAssets() and WETH oracle could be manipulated
      → WETH oracle uses 30-min TWAP → manipulation infeasible
      → strategy.totalAssets() reads ERC-4626 convertToAssets() → on-chain, no oracle
```

---

## 11. Updated Deployment

Thêm vào Step 14 (PrimeCDO setup):

```
14. PrimeCDO (needs: ...)
    → Set s_ratioTarget = 0.20e18
    → Set s_ratioTolerance = 0.02e18
    → Set s_ratioController = address(0)
    → Set s_minCoverageForDeposit = 1.05e18       ← NEW
    → Set s_minCoverageForJuniorRedeem = 1.05e18   ← NEW
    → Set s_juniorShortfallPausePrice = 0.90e18    ← NEW
```

---

*PrimeVaults V3 — Coverage Gate System v3.4.1*  
*March 2026*
