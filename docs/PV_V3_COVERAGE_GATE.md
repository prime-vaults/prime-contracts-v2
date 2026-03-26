# PrimeVaults V3 — Coverage Gate System

**Version:** 3.5.0  
**Addendum to:** PV_V3_FINAL_v34.md

---

## 1. Two Coverage Metrics

Senior và Mezz có protection level khác nhau → cần metrics riêng.

```
cs = (TVL_sr + TVL_mz + TVL_jr) / TVL_sr    (Senior coverage)
cm = (TVL_mz + TVL_jr) / TVL_mz             (Mezz coverage)
```

- `cs` = mỗi $1 Senior có bao nhiêu $ pool backing
- `cm` = mỗi $1 Mezz có bao nhiêu $ (Mz+Jr) backing

```solidity
function _getCoverageSenior() internal view returns (uint256) {
    (uint256 sr, uint256 mz, uint256 jr) = IAccounting(i_accounting).getAllTVLs();
    if (sr == 0) {
        if (mz + jr > 0) return type(uint256).max;
        return type(uint256).max; // empty protocol
    }
    return (sr + mz + jr) * 1e18 / sr;
}

function _getCoverageMezz() internal view returns (uint256) {
    (, uint256 mz, uint256 jr) = IAccounting(i_accounting).getAllTVLs();
    if (mz == 0) return type(uint256).max;
    return (mz + jr) * 1e18 / mz;
}
```

---

## 2. Deposit Gates (check AFTER deposit)

Deposit Senior **decreases** cs. Deposit Mezz **decreases** cm. Must verify coverage AFTER recording deposit, not before.

```
cs = 1 + (Mz+Jr)/Sr → Sr tăng → cs giảm
cm = 1 + Jr/Mz      → Mz tăng → cm giảm
```

```solidity
function deposit(TrancheId tranche, address token, uint256 amount) external {
    require(!s_shortfallPaused, "paused");

    // 1. Update TVL
    _updateTVL();

    // 2. Route to strategy
    uint256 baseAmount = IStrategy(i_strategy).depositToken(token, amount);

    // 3. Record deposit (TVL changes here)
    IAccounting(i_accounting).recordDeposit(tranche, baseAmount);

    // 4. Coverage gate AFTER deposit
    if (tranche == TrancheId.SENIOR) {
        require(_getCoverageSenior() >= s_minCoverageForDeposit, "cs too low after deposit");
    }
    if (tranche == TrancheId.MEZZ) {
        require(_getCoverageMezz() >= s_minCoverageForDeposit, "cm too low after deposit");
    }
    // Junior: no gate (Jr deposit increases both cs and cm)

    // 5. Shortfall check
    _checkJuniorShortfall();
}
```

Default: `s_minCoverageForDeposit = 1.05e18` (105%)

If coverage drops below threshold after deposit → entire tx reverts (deposit undone).

---

## 3. Withdrawal Policy (fee + cooldown escalation)

**Không tranche nào bị hard block withdraw.** Dùng mechanism escalation thay vì revert.

### Senior withdrawal — always instant

```
Senior luôn INSTANT, 0 fee, 0 days.
Safest tranche → best UX, no delay.
```

### Mezz withdrawal (dựa trên cs — Senior coverage)

```
cs > 160%       → INSTANT
140% < cs ≤ 160% → ASSETS_LOCK
cs ≤ 140%       → SHARES_LOCK
```

Tại sao Mezz dùng cs (không phải cm)?
Mezz là subordination cho Senior. Mezz rút → cs giảm (Senior subordination yếu hơn).
Gate by cs = protect Senior khi subordination mỏng.

### Junior withdrawal (dựa trên cs VÀ cm)

```
cs > 160% AND cm > 150%       → INSTANT
cs > 140% AND cm > 130%       → ASSETS_LOCK
otherwise                      → SHARES_LOCK
```

Junior phải pass CẢ HAI thresholds. 1 trong 2 fail → mechanism thấp hơn.
Threshold khác nhau cho cs vs cm per mechanism (governance-configurable).

### Code

```solidity
struct MezzParams {
    uint256 instantCs;     // default: 1.60e18
    uint256 assetLockCs;   // default: 1.40e18
}

struct JuniorParams {
    uint256 instantCs;     // default: 1.60e18
    uint256 instantCm;     // default: 1.50e18
    uint256 assetLockCs;   // default: 1.40e18
    uint256 assetLockCm;   // default: 1.30e18
}

function _evaluateMezzMechanism(uint256 cs) internal view returns (CooldownMechanism) {
    MezzParams memory p = s_mezzParams;
    if (cs > p.instantCs) return CooldownMechanism.NONE;
    if (cs > p.assetLockCs) return CooldownMechanism.ASSETS_LOCK;
    return CooldownMechanism.SHARES_LOCK;
}

function _evaluateJuniorMechanism(uint256 cs, uint256 cm) internal view returns (CooldownMechanism) {
    JuniorParams memory p = s_juniorParams;
    if (cs > p.instantCs && cm > p.instantCm) return CooldownMechanism.NONE;
    if (cs > p.assetLockCs && cm > p.assetLockCm) return CooldownMechanism.ASSETS_LOCK;
    return CooldownMechanism.SHARES_LOCK;
}

function requestWithdraw(TrancheId tranche, ...) {
    require(!s_shortfallPaused, "paused");

    (uint256 cs, uint256 cm) = _getCoverages();

    CooldownMechanism mechanism;
    if (tranche == TrancheId.SENIOR) mechanism = CooldownMechanism.NONE;
    else if (tranche == TrancheId.MEZZ) mechanism = _evaluateMezzMechanism(cs);
    else mechanism = _evaluateJuniorMechanism(cs, cm);

    // Fee + route by mechanism...
}
```

---

## 4. Shortfall Auto-Pause

```solidity
uint256 public s_juniorShortfallPausePrice;  // default: 0.90e18 (90%)
bool public s_shortfallPaused;

function _checkJuniorShortfall() internal {
    if (s_juniorShortfallPausePrice == 0) return;

    address juniorVault = s_tranches[TrancheId.JUNIOR];
    uint256 totalAssets = IAccounting(i_accounting).getJuniorTVL();
    uint256 totalSupply = IERC20(juniorVault).totalSupply();
    if (totalSupply == 0) return;

    uint256 pricePerShare = totalAssets * 1e18 / totalSupply;
    if (pricePerShare < s_juniorShortfallPausePrice) {
        s_shortfallPaused = true;
        emit ShortfallPauseTriggered(pricePerShare, s_juniorShortfallPausePrice);
    }
}
```

When paused: ALL actions blocked except claimWithdraw() for existing pending cooldowns.
Unpause: governance only via `unpauseShortfall()`.

---

## 5. Action Matrix

```
DEPOSIT (check AFTER — revert if coverage drops below 105%):
  Sr deposit:  cs ≥ 105% after deposit → ✓, else ✗ REVERT
  Mz deposit:  cm ≥ 105% after deposit → ✓, else ✗ REVERT
  Jr deposit:  ✓ ALWAYS (increases cs and cm)


WITHDRAW (mechanism escalation — NO hard block):

  Senior: ALWAYS INSTANT (0 fee, 0 days)

  Mezz (cs):
    cs > 160%        → INSTANT
    140% < cs ≤ 160%  → ASSETS_LOCK
    cs ≤ 140%        → SHARES_LOCK

  Junior (cs AND cm):
    cs>160% AND cm>150%  → INSTANT
    cs>140% AND cm>130%  → ASSETS_LOCK
    otherwise            → SHARES_LOCK


Shortfall (Jr price < 90%): ALL → ✗ PAUSED
```

---

## 6. Self-Balancing Economics

```
Coverage stressed (cs or cm near 105%):

  Sr/Mz deposit: BLOCKED (coverage check after deposit fails)
  Jr deposit: OPEN + RP2 very high → attract Junior capital
  Sr withdraw: INSTANT (always) → Senior can leave freely
  Mz withdraw: SHARES_LOCK at low cs → slow Mezz drain
  Jr withdraw: SHARES_LOCK (high fee) → strong disincentive

→ Jr deposits (high APR) + Jr stays (high exit fee) → coverage recovers
→ Senior always has best UX → attract Senior capital
→ No governance intervention needed for normal dynamics
```

---

## 7. Default Parameters

```
s_minCoverageForDeposit      = 1.05e18  (105%)
s_juniorShortfallPausePrice  = 0.90e18  (90%)

RedemptionPolicy ranges: governance-configurable
```

---

_PrimeVaults V3 — Coverage Gate System v3.5.0_  
_2 metrics: cs (Senior), cm (Mezz)_  
_No Junior withdraw block — fee escalation instead_  
_March 2026_
