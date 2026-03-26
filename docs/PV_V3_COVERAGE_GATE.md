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

## 2. Deposit Gates (hard block)

```solidity
// Senior deposit: block when subordination too thin
if (tranche == TrancheId.SENIOR) {
    require(_getCoverageSenior() >= s_minCoverageForDeposit, "cs too low");
}

// Mezz deposit: block when Junior too thin
if (tranche == TrancheId.MEZZ) {
    require(_getCoverageMezz() >= s_minCoverageForDeposit, "cm too low");
}

// Junior deposit: ALWAYS OPEN (increases both cs and cm)
```

Default: `s_minCoverageForDeposit = 1.05e18` (105%)

Block deposit OK: user chưa bỏ tiền vào → không trap funds.

---

## 3. Withdrawal Policy (fee + cooldown escalation)

**Không tranche nào bị hard block withdraw.** Dùng fee + cooldown thay vì revert.

### Senior withdrawal (dựa trên cs)

```
cs > 200%       → INSTANT,      0 bps,    0 days
150% < cs ≤ 200% → ASSETS_LOCK,  10 bps,   3 days
105% < cs ≤ 150% → SHARES_LOCK,  50 bps,   7 days
cs ≤ 105%       → SHARES_LOCK, 100 bps,  14 days
```

### Mezz withdrawal (dựa trên cm)

```
cm > 200%       → INSTANT,      0 bps,    0 days
150% < cm ≤ 200% → ASSETS_LOCK,  10 bps,   3 days
105% < cm ≤ 150% → SHARES_LOCK,  50 bps,   7 days
cm ≤ 105%       → SHARES_LOCK, 100 bps,  14 days
```

### Junior withdrawal (dựa trên cj = MIN(cs, cm))

```
cj > 200%       → INSTANT,      0 bps,    0 days
150% < cj ≤ 200% → ASSETS_LOCK,  20 bps,   3 days
105% < cj ≤ 150% → SHARES_LOCK, 100 bps,   7 days
cj ≤ 105%       → SHARES_LOCK, 200 bps,  14 days
```

Junior fee cao hơn Sr/Mz vì: Jr rút = coverage giảm (harmful). Sr/Mz rút = coverage tăng (beneficial).

Junior dùng MIN(cs, cm) vì Jr rút ảnh hưởng CẢ cs VÀ cm.

```solidity
function requestWithdraw(TrancheId tranche, ...) {
    require(!s_shortfallPaused, "paused");

    // Per-tranche coverage for RedemptionPolicy
    uint256 coverage;
    if (tranche == TrancheId.SENIOR) coverage = _getCoverageSenior();
    else if (tranche == TrancheId.MEZZ) coverage = _getCoverageMezz();
    else coverage = Math.min(_getCoverageSenior(), _getCoverageMezz());

    RedemptionCondition memory cond = IRedemptionPolicy(i_redemptionPolicy)
        .getCondition(uint8(tranche), coverage);

    // Fee
    uint256 fee = baseAmount * cond.feeBps / 10_000;
    // Route by cooldown type...
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
                     cs>200%  150-200%   105-150%    ≤105%
Sr deposit           ✓        ✓          ✓           ✗ BLOCKED
Sr withdraw          0bp/0d   10bp/3d    50bp/7d     100bp/14d

                     cm>200%  150-200%   105-150%    ≤105%
Mz deposit           ✓        ✓          ✓           ✗ BLOCKED
Mz withdraw          0bp/0d   10bp/3d    50bp/7d     100bp/14d

                     cj>200%  150-200%   105-150%    ≤105%
Jr deposit           ✓        ✓          ✓           ✓ (always)
Jr withdraw          0bp/0d   20bp/3d    100bp/7d    200bp/14d

Shortfall (Jr price < 90%): ALL → ✗ PAUSED
```

---

## 6. Self-Balancing Economics

```
Coverage stressed (≤105%):
  Sr/Mz deposit: BLOCKED → no new pressure
  Jr deposit: OPEN + RP2 very high → attract Junior capital
  Jr withdraw: 200bps + 14 days → strong disincentive
  Sr/Mz withdraw: 100bps + 14 days → slow drain

→ Jr deposits (high APR) + Jr stays (high exit fee) → coverage recovers
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
