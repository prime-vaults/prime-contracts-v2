# PrimeVaults V3 — Tham chiếu Công thức Toán học

**Version:** 3.5.0  
**Phạm vi:** Mọi công thức toán học trong hệ thống  
**Quy ước:** Tất cả dùng fixed-point 18 decimals (`1e18 = 1.0` hoặc `100%`)  
**Network:** Arbitrum  
**Strategy:** sUSDai (USD.AI)

---

## Mục lục

**Nhóm A — Exchange Rate & ERC-4626**

- A1. Share Price
- A2. convertToShares (Deposit)
- A3. convertToAssets (Withdraw)
- A4. SharesLock Claim Rate

**Nhóm B — TVL & Accounting**

- B1. Junior TVL (Dual-Asset)
- B2. Total Protocol TVL
- B3. Leverage Ratio
- B4. WETH Value (USD)

**Nhóm C — Gain Splitting (3-tranche)**

- C1. Strategy Gain
- C2. Reserve Cut
- C3. Senior Target Gain
- C4. Mezzanine Target Gain
- C5. Gain Distribution (4 cases)

**Nhóm D — Loss Waterfall**

- D1. Loss Detection
- D2. WETH Coverage Amount
- D3. Swap Output with Slippage
- D4. 4-Layer Waterfall

**Nhóm E — APR Pipeline**

- E1. Benchmark Rate (aprTarget)
- E2. Strategy Rate (aprBase)
- E3. Risk Premium 1 — Senior → Subordination
- E4. Risk Premium 2 — Mezz → Junior
- E5. Senior APR
- E6. Mezzanine APR
- E7. Junior APR (residual)

**Nhóm F — Dynamic WETH Ratio (post-MVP)**

- F1. Sigmoid Function
- F2. Target WETH Ratio
- F3. Deposit Ratio Validation
- F4. Rebalance Amounts

**Nhóm G — Cooldown & Fees**

- G1. Exit Fee
- G2. Cooldown Unlock Time
- G3. Proportional WETH Withdrawal

**Nhóm H — Strategy-Level**

- H1. Strategy totalAssets
- H2. Aave WETH Supply APR
- H3. sUSDai APR (snapshot-based)

---

# Nhóm A — Exchange Rate & ERC-4626

---

## A1. Share Price (Exchange Rate)

```
sharePrice = totalAssets / totalSupply
```

- `totalAssets` = tổng giá trị tài sản thuộc tranche (từ Accounting)
- `totalSupply` = tổng số vault shares đã mint

Từng tranche:

```
Senior:  totalAssets = Accounting.s_seniorTVL
Mezz:    totalAssets = Accounting.s_mezzTVL
Junior:  totalAssets = Accounting.s_juniorBaseTVL + Accounting.s_juniorWethTVL
```

Yield tích luỹ qua sharePrice tăng. Không cần claim.

---

## A2. convertToShares (Deposit)

```
shares = assets × totalSupply / totalAssets

IF totalSupply == 0:
  shares = assets    (1:1 mint ban đầu)
```

Invariant: `sharePrice_before == sharePrice_after` (deposit không thay đổi exchange rate).

---

## A3. convertToAssets (Withdraw)

```
assets = shares × totalAssets / totalSupply
```

Nghịch đảo A2. Invariant: withdraw cũng không thay đổi sharePrice cho người còn lại.

---

## A4. SharesLock Claim Rate

```
// Request (t0): shares bị escrow, KHÔNG burn
lockedShares = shares

// Claim (t1, sau cooldown): burn tại rate hiện tại
assets_out = lockedShares × totalAssets(t1) / totalSupply(t1)
```

Khác AssetsLock: user tiếp tục hưởng yield trong cooldown.
Shares vẫn nằm trong totalSupply → TVL không giảm → coverage ổn định.

---

# Nhóm B — TVL & Accounting

---

## B1. Junior TVL (Dual-Asset)

```
TVL_jr = TVL_jr_base + TVL_jr_weth

TVL_jr_base = phần base asset của Junior (từ gain splitting)
TVL_jr_weth = aWETH_balance × WETH_price
```

---

## B2. Total Protocol TVL

```
TVL_total = TVL_sr + TVL_mz + TVL_jr_base + TVL_jr_weth + TVL_reserve

TVL_pool = TVL_sr + TVL_mz + TVL_jr
         = TVL_sr + TVL_mz + TVL_jr_base + TVL_jr_weth
```

Accounting invariant (kiểm tra mỗi updateTVL):

```
currentStrategyTVL + currentWethValueUSD
  ≈ TVL_sr + TVL_mz + TVL_jr_base + TVL_jr_weth + TVL_reserve
```

---

## B3. Coverage Metrics (2 per-tranche)

```
cs = (TVL_sr + TVL_mz + TVL_jr) / TVL_sr     (Senior coverage)
cm = (TVL_mz + TVL_jr) / TVL_mz              (Mezz coverage)
```

- `cs` đo "mỗi $1 Senior có bao nhiêu $ pool backing (bao gồm subordination bên dưới)"
- `cm` đo "mỗi $1 Mezz có bao nhiêu $ (Mz+Jr) backing (chỉ Junior bên dưới)"
- Senior và Mezz có **protection level khác nhau** → cần metrics riêng

### Ví dụ

```
Sr=$7M, Mz=$2M, Jr=$1.25M:
  cs = 10.25/7 = 1.464  (46.4% subordination dưới Senior)
  cm = 3.25/2 = 1.625   (62.5% Junior protection dưới Mezz)

Sr=$9M, Mz=$0.5M, Jr=$0.3M:
  cs = 9.8/9 = 1.089    (chỉ 8.9% subordination → Senior gần exposed)
  cm = 0.8/0.5 = 1.60   (60% Junior → Mezz vẫn OK)
  → Chỉ Senior đang stressed, không phải Mezz
  → 1 metric cũ (Pool/Jr=32.7x) không phân biệt được điều này
```

### Dùng ở đâu

```
cs: deposit gate Senior, withdrawal policy Senior
cm: deposit gate Mezz, withdrawal policy Mezz
MIN(cs, cm): withdrawal policy Junior (Jr rút ảnh hưởng cả cs và cm)

Note: mezzLeverage (E4) = (Mz+Jr)/Jr ≠ cm = (Mz+Jr)/Mz
  mezzLeverage đo Junior mỏng so với (Mz+Jr) → dùng cho RP2
  cm đo Mezz có bao nhiêu backing → dùng cho coverage gate
```

### Edge cases

```
Sr = 0: cs = ∞ (không có Senior → không cần protection)
Mz = 0: cm = ∞ (không có Mezz → không cần protection)
Jr = 0 AND (Sr+Mz) > 0: cs và cm tính bình thường nhưng rất gần 1.0
  → deposit gates block Sr/Mz (coverage < 105%)
  → Jr deposit OPEN → recovery path
Empty protocol (Sr=Mz=Jr=0): cho phép first deposit từ bất kỳ tranche
```

---

## B4. WETH Value (USD)

```
TVL_jr_weth = aWETH_balance × WETH_price

aWETH_balance = IERC20(aWETH).balanceOf(AaveWETHAdapter)
WETH_price    = Chainlink ETH/USD spot price (18 decimals)
```

- aWETH balance tự tăng per block (Aave rebasing token)
- Chainlink spot: 31 off-chain nodes consensus, flash loan immune
- Staleness check: revert nếu feed > 1 giờ không update

---

# Nhóm C — Gain Splitting (3-Tranche)

**Đây là phần quan trọng nhất. PrimeVaults có 3 tranches, Strata chỉ có 2.**

Nguyên tắc: **Senior ưu tiên trước, rồi Mezz, rồi Junior nhận residual.**

---

## C1. Strategy Gain

```
strategyGain = currentStrategyTVL - prevStrategyTVL

currentStrategyTVL = IStrategy(strategy).totalAssets()
prevStrategyTVL    = TVL_sr + TVL_mz + TVL_jr_base + TVL_reserve
```

- Chỉ tính strategy TVL (không tính WETH — WETH yield capture riêng qua B4)
- `totalAssets()` trả `sUSDai.convertToAssets(balanceOf(strategy))`
- Nếu strategy có `s_pendingRedeemShares` (shares trong sUSDai FIFO queue): `totalAssets()` phải KHÔNG đếm shares đang pending. Nếu `sUSDai.balanceOf(strategy)` tự giảm sau `requestRedeem()` thì OK. Nếu không → `totalAssets = convertToAssets(balance - s_pendingRedeemShares)`

---

## C2. Reserve Cut

```
IF strategyGain > 0:
  reserveCut = strategyGain × reserveBps / 10_000
ELSE:
  reserveCut = 0

netGain = strategyGain - reserveCut
TVL_reserve += reserveCut
```

Chỉ cắt khi có lãi. reserveBps default 500 (5%).

---

## C3. Senior Target Gain

```
interestFactor = APR_sr × deltaT / (365 days × 1e18)

srtTargetIndex_new = srtTargetIndex × (1e18 + interestFactor) / 1e18

seniorGainTarget = TVL_sr × (srtTargetIndex_new / srtTargetIndex - 1)
```

Simplified (equivalent cho short deltaT):

```
seniorGainTarget = TVL_sr × APR_sr × deltaT / (365 days)
```

- Compound index tích luỹ qua nhiều kỳ mà không mất precision
- APR_sr: xem E6

---

## C4. Mezzanine Target Gain

```
interestFactor_mz = APR_mz × deltaT / (365 days × 1e18)

mzTargetIndex_new = mzTargetIndex × (1e18 + interestFactor_mz) / 1e18

mezzGainTarget = TVL_mz × (mzTargetIndex_new / mzTargetIndex - 1)
```

Simplified:

```
mezzGainTarget = TVL_mz × APR_mz × deltaT / (365 days)
```

- Cùng compound index pattern như Senior
- APR_mz: xem E7

---

## C5. Gain Distribution (4 Cases)

```
netGain = strategyGain - reserveCut
totalTarget = seniorGainTarget + mezzGainTarget
```

### CASE A: netGain ≥ totalTarget (bình thường — yield đủ cho tất cả)

```
TVL_sr      += seniorGainTarget
TVL_mz      += mezzGainTarget
TVL_jr_base += (netGain - totalTarget)     ← Junior nhận residual
```

### CASE B: seniorGainTarget ≤ netGain < totalTarget (yield đủ Senior, thiếu Mezz)

```
TVL_sr      += seniorGainTarget
TVL_mz      += (netGain - seniorGainTarget)   ← Mezz nhận phần còn lại
TVL_jr_base += 0                               ← Junior không nhận gì
```

### CASE C: 0 ≤ netGain < seniorGainTarget (yield không đủ cho Senior)

```
TVL_sr      += netGain                         ← Senior nhận hết
TVL_mz      += 0                               ← Mezz không nhận
TVL_jr_base += 0                               ← Junior không nhận
```

Junior + Mezz đang "subsidize" Senior. Đây là cơ chế bảo hiểm: Junior/Mezz bán protection, Senior mua.

### CASE D: netGain < 0 (strategy bị lỗ)

```
Chuyển sang D4 (Loss Waterfall)
```

### Waterfall priority

```
Yield:  Senior → Mezz → Junior (Senior ưu tiên nhất)
Loss:   Junior → Mezz → Senior (Junior chịu trước)
```

Đây là CDO standard trong structured finance. Senior = safest, Junior = first loss.

### Ví dụ trace

```
TVL: Sr=$7M, Mz=$2M, Jr_base=$1M, Jr_weth=$0.25M, Jr=$1.25M
aprBase=12%, aprTarget=4%, deltaT = 1 day

RP1 = 21.2%, RP2 = 21.1%, subLev = 2.154

APR_sr = MAX(4%, 12% × (1 - 0.212)) = MAX(4%, 9.46%) = 9.46%
APR_mz = 12% × (1 + 0.212 × 2.154) × (1 - 0.211) = 13.79%

seniorGainTarget = $7M × 9.46% / 365 = $1,814
mezzGainTarget   = $2M × 13.79% / 365 = $756
totalTarget = $2,570

strategyTVL = Sr+Mz+Jr_base = $10M
actualGain = $10M × 12% / 365 = $3,288 (trước reserve)
reserveCut = $3,288 × 5% = $164
netGain = $3,124

CASE A: $3,124 > $2,570
  Senior: +$1,814
  Mezz:   +$756
  Junior: +$554 (residual = $3,124 - $1,814 - $756)
  + WETH yield: $0.25M × 2% / 365 = $14/day (riêng, từ Aave)

Kiểm tra: $1,814 + $756 + $554 + $164 = $3,288 = actualGain ✓
Jr APR: ($554 + $14) × 365 / $1.25M = 16.6%
Ordering: 9.46% < 13.79% < 16.6% ✓
```

---

# Nhóm D — Loss Waterfall

---

## D1. Loss Detection

```
loss = |netGain|    when netGain < 0
```

Detect khi strategy TVL giảm so với lần update trước. Nguyên nhân: sUSDai rate giảm (borrower default), exploit, etc.

---

## D2. WETH Coverage Amount

```
wethCoverageUSD = MIN(loss, TVL_jr_weth)
wethToSell      = wethCoverageUSD / WETH_price
actualWethSell  = MIN(wethToSell, aWETH_balance)
```

Bán đúng lượng WETH cần, không bán quá. WETH_price = Chainlink spot.

---

## D3. Swap Output with Slippage

```
expectedOutput = wethToSell × WETH_price
minOutput      = expectedOutput × (1 - maxSlippage)
actualOutput   = UniswapV3.swap(WETH → USDai, wethToSell, minOutput)

maxSlippage:
  Normal:    1% (0.01e18)
  Emergency: 10% (0.10e18)
```

`minOutput` ngăn sandwich attack.

---

## D4. 4-Layer Waterfall

```
remaining = loss

// Layer 0: WETH buffer (bán ETH, inject vào strategy)
wethAbsorbed = MIN(remaining, TVL_jr_weth)
TVL_jr_weth -= wethAbsorbed
remaining -= actualCovered    (actualCovered ≤ wethAbsorbed do slippage)

// Layer 1: Junior base (first loss)
jrAbsorbed = MIN(remaining, TVL_jr_base)
TVL_jr_base -= jrAbsorbed
remaining -= jrAbsorbed

// Layer 2: Mezzanine
mzAbsorbed = MIN(remaining, TVL_mz)
TVL_mz -= mzAbsorbed
remaining -= mzAbsorbed

// Layer 3: Senior (last resort)
srAbsorbed = MIN(remaining, TVL_sr)
TVL_sr -= srAbsorbed
```

- Layer 0 (WETH) là đặc thù PrimeVaults V3 — không có trong Strata hay CDO truyền thống
- Mỗi layer chỉ chịu tối đa bằng TVL của nó (MIN function)
- Shortfall auto-pause: nếu Junior sharePrice < 90% → pause protocol

---

# Nhóm E — APR Pipeline

**APR values từ AprPairFeed: int64 × 12 decimals (Strata-compatible).**  
**Accounting convert sang uint256 × 18 decimals trước khi dùng.**  
**Negative APR clamp to 0.**

---

## E1. Benchmark Rate (aprTarget)

```
aprTarget = Σ(supply_i × rate_i) / Σ supply_i
            for i ∈ benchmarkTokens [USDC, USDT] trên Aave v3 Arbitrum

rate_i    = Aave currentLiquidityRate (ray 1e27 → 12dec: ÷ 1e15)
supply_i  = IERC20(aTokenAddress_i).totalSupply()
aTokenAddress_i = đọc từ Aave getReserveData(asset_i) mỗi lần (không hardcode)
```

- aprTarget đến từ **on-chain Aave** (realtime), KHÔNG phải governance set
- Cap: BENCHMARK_MAX = 40% (0.4e12)
- aprTarget = sàn APR cho Senior. Senior không bao giờ earn ít hơn mức này

---

## E2. Strategy Rate (aprBase)

```
aprBase = (rate_T1 - rate_T0) × SECONDS_PER_YEAR × APR_SCALE / deltaT / rate_T0

rate_T0 = s_prevRate           (snapshot trước)
rate_T1 = s_latestRate         (snapshot mới)
deltaT  = T1 - T0             (seconds)

rate = sUSDai.convertToAssets(1e18)   (exchange rate)
```

- Snapshot shift: keeper gọi `AprPairFeed.updateRoundData()` → provider `getAprPair()` → shift snapshots
- Supports negative APR (int64 < 0 nếu rate giảm)
- Clamp: [-50%, +200%] trước int64 cast
- Xem docs/PV_V3_APR_ORACLE.md cho full spec

---

## E3. Risk Premium 1 (RP1) — Senior → Subordination

```
RP1 = x1 + y1 × (ratio_sr ^ k1)

ratio_sr = TVL_sr / (TVL_sr + TVL_mz + TVL_jr)
x1 = 0.10e18   (baseline 10%)
y1 = 0.125e18  (max additional 12.5%)
k1 = 0.3e18    (concave — tăng nhanh ở ratio thấp, chậm ở ratio cao)
```

- Denominator bao gồm **cả 3 tranches** (không chỉ Sr + Jr)
- RP1 = phí Senior trả cho **subordination** (cả Mezz + Junior protect Senior)
- ratio_sr tăng (Senior dominate) → RP1 tăng → Senior APR giảm
- Constraint: `x1 + y1 ≤ 0.80` (MAX_SENIOR_XY)

### Ví dụ

```
Sr=$7M, Mz=$2M, Jr=$1M:
  ratio_sr = 7/10 = 0.70
  RP1 = 0.10 + 0.125 × 0.70^0.3 = 0.10 + 0.112 = 21.2%

Sr=$3M, Mz=$2M, Jr=$5M:
  ratio_sr = 3/10 = 0.30
  RP1 = 0.10 + 0.125 × 0.30^0.3 = 0.10 + 0.088 = 18.8%

→ Senior dominate → RP1 cao → Senior APR giảm → incentivize Junior deposit
```

---

## E4. Risk Premium 2 (RP2) — Mezz → Junior

```
RP2 = x2 + y2 × (mezzLeverage ^ k2)

mezzLeverage = (TVL_mz + TVL_jr) / TVL_jr
x2 = 0.05e18   (baseline 5%)
y2 = 0.10e18   (max additional 10%)
k2 = 0.5e18    (square root — tăng sublinearly)
```

- RP2 = phí **Mezz trả cho Junior** (chỉ Mezz, không phải Senior)
- mezzLeverage đo "Junior mỏng bao nhiêu relative to Mezz"
- Dùng `(TVL_mz + TVL_jr) / TVL_jr` thay vì `TVL_pool / TVL_jr` vì chỉ Mezz trả RP2, không liên quan Senior TVL
- mezzLeverage cao → Junior mỏng so với Mezz → RP2 tăng
- Constraint: `x2 + y2 ≤ 0.50` (MAX_JUNIOR_XY)

### Ví dụ

```
Mz=$2M, Jr=$1.25M:
  mezzLeverage = 3.25 / 1.25 = 2.6x
  RP2 = 0.05 + 0.10 × 2.6^0.5 = 0.05 + 0.161 = 21.1%

Mz=$5M, Jr=$0.5M:
  mezzLeverage = 5.5 / 0.5 = 11x
  RP2 = 0.05 + 0.10 × 11^0.5 = 0.05 + 0.332 = 38.2%

→ Junior mỏng so với Mezz → RP2 cao → Mezz trả nhiều hơn → Junior APR tăng
```

### Tại sao dùng mezzLeverage thay vì leverageRatio (Pool/Jr)?

```
leverageRatio = Pool / Jr = (Sr + Mz + Jr) / Jr
  → Kéo Senior TVL vào RP2
  → Nhưng Senior KHÔNG trả RP2 (Senior trả RP1)
  → Senior TVL thay đổi → RP2 thay đổi → Mezz cost thay đổi
  → Không hợp lý: Mezz cost bị ảnh hưởng bởi Senior actions

mezzLeverage = (Mz + Jr) / Jr
  → Chỉ liên quan Mezz vs Junior
  → Senior deposit/withdraw không ảnh hưởng RP2
  → Clean separation: RP1 = f(Senior ratio), RP2 = f(Mezz/Jr ratio)
```

---

## E5. Senior APR

```
APR_sr = MAX(aprTarget, aprBase × (1 - RP1))
```

- Senior trả RP1 cho subordination (Mezz + Junior protect Senior)
- Senior **KHÔNG trả RP2** (RP2 = Mezz → Junior, không liên quan Senior)
- `MAX(aprTarget, ...)` = floor guarantee: Senior ít nhất bằng Aave benchmark
- Floor = **priority** không phải guarantee vô điều kiện. Nếu strategy yield = 0 → Senior yield = 0. Senior không rút TVL từ Junior để trả mình

### Constraint

```
RP1 < 1

Nếu RP1 ≥ 1 → (1 - RP1) ≤ 0 → APR_sr_v2 ≤ 0 → MAX chọn aprTarget
Senior không bao giờ APR âm. Với defaults x1+y1 = 0.225, RP1 max ~22.5% → luôn OK.
```

### Ví dụ

```
aprTarget = 4%, aprBase = 12%, RP1 = 21.2%

APR_sr = MAX(4%, 12% × (1 - 0.212))
       = MAX(4%, 12% × 0.788)
       = MAX(4%, 9.46%)
       = 9.46%
```

---

## E6. Mezzanine APR

```
subLeverage = TVL_sr / (TVL_mz + TVL_jr)

APR_mz = aprBase × (1 + RP1 × subLeverage) × (1 - RP2)
```

- **Không có floor.** Mezz riskier hơn Senior → không đảm bảo APR
- **Không cần MAX(0, ...).** Coverage gates prevent extreme scenarios. Nếu APR_mz âm (Jr cực mỏng) → market forces tự correct (Mezz rút → mezzLeverage giảm → RP2 giảm → APR_mz recover)

### Decomposition

```
Mezz income gồm 3 phần:

1. Base yield:    aprBase
   → Tiền Mezz nằm trong strategy, kiếm yield

2. RP1 received:  aprBase × RP1 × subLeverage
   → Senior bỏ lại TVL_sr × aprBase × RP1
   → Chia proportional cho Mezz + Junior theo TVL
   → Per $1 Mezz: aprBase × RP1 × TVL_sr / (TVL_mz + TVL_jr)
   → TVL_mz triệt tiêu khi quy về APR (xem derivation dưới)

3. RP2 paid:      × (1 - RP2) trên TOÀN BỘ income
   → Junior protect toàn bộ Mezz position
   → Phí tỉ lệ tổng yield (multiplicative), không phải flat deduction
   → Mezz kiếm nhiều → Junior cũng nhận nhiều hơn qua RP2

Ghép: aprBase × (1 + RP1 × subLev) × (1 - RP2)
      ↑ base      ↑ RP1 bonus        ↑ RP2 fee trên total
```

### subLeverage derivation

```
Senior bỏ lại: TVL_sr × aprBase × RP1

Chia cho Mezz + Junior theo TVL proportional:
  Mezz phần: × TVL_mz / (TVL_mz + TVL_jr)

Per $1 Mezz (chia cho TVL_mz):
  = TVL_sr × aprBase × RP1 × TVL_mz / (TVL_mz + TVL_jr) / TVL_mz
  = TVL_sr × aprBase × RP1 / (TVL_mz + TVL_jr)
    ↑ TVL_mz triệt tiêu (nhân rồi chia)
  = aprBase × RP1 × subLeverage

  subLeverage = TVL_sr / (TVL_mz + TVL_jr)

Verify balance: tổng RP1 paid = tổng RP1 received
  Senior pays:  TVL_sr × aprBase × RP1
  Mezz gets:    TVL_mz × aprBase × RP1 × subLev = TVL_mz × aprBase × RP1 × Sr/(Mz+Jr)
  Junior gets:  TVL_jr × aprBase × RP1 × subLev = TVL_jr × aprBase × RP1 × Sr/(Mz+Jr)
  Total gets:   (TVL_mz + TVL_jr) × aprBase × RP1 × Sr/(Mz+Jr)
              = aprBase × RP1 × TVL_sr = Senior pays ✓
```

### Tại sao (1-RP2) multiplicative, không additive?

```
Additive (sai):  aprBase × (1 + RP1×subLev - RP2)
  → RP2 trừ trên base yield only
  → Khi subLev cao, Mezz nhận RP1 bonus lớn nhưng RP2 cost cố định
  → Junior bị squeeze: protect pool lớn nhưng phí không tăng theo

Multiplicative (đúng): aprBase × (1 + RP1×subLev) × (1-RP2)
  → RP2 trừ trên TOÀN BỘ (base + RP1 share)
  → Khi Mezz kiếm nhiều → Junior cũng nhận nhiều hơn (proportional)
  → Fair: Junior protect toàn bộ position → phí trên toàn bộ income
```

### Ví dụ

```
aprBase = 12%, RP1 = 21.2%, RP2 = 21.1%
Sr=$7M, Mz=$2M, Jr=$1.25M
subLev = 7 / 3.25 = 2.154

Gross income: 12% × (1 + 0.212 × 2.154) = 12% × 1.457 = 17.48%
RP2 fee:      17.48% × 21.1% = 3.69%
Net:          17.48% - 3.69% = 13.79%

= 12% × 1.457 × 0.789 = 13.79% ✓

Decompose:
  Base yield:   12.00%
  RP1 received: +5.48%  (12% × 0.212 × 2.154)
  Gross:        17.48%
  RP2 paid:     -3.69%  (17.48% × 21.1%)
  Net:          13.79%
```

---

## E7. Junior APR (Residual)

### Trong Accounting (code thực tế)

```
Junior APR KHÔNG có formula riêng.
Junior nhận RESIDUAL từ gain splitting:

  juniorGain = netGain - seniorGainTarget - mezzGainTarget   (Case A)
  TVL_jr_base += juniorGain

  APR_jr hiệu quả = juniorGain × 365 / deltaT / TVL_jr
```

Junior APR là **consequence**, không phải input. Accounting chỉ cần: `TVL_jr_base += residual`.

### Trong PrimeLens (display cho frontend — KHÔNG dùng trong Accounting)

```
Decomposition thành 2 streams cho UI:

Stream 1 (base + RP residual):
  yield_base_rp = juniorGainFromSplit / TVL_jr × annualized

Stream 2 (WETH yield):
  yield_weth = TVL_jr_weth × APR_aave_weth / TVL_jr

APR_jr_display = yield_base_rp + yield_weth
```

**QUAN TRỌNG:** Streams là breakdown cho UI. Accounting chỉ biết `TVL_jr_base += residual`. WETH yield tách riêng (từ Aave, không từ strategy).

### Ví dụ

```
Sr=$7M, Mz=$2M, Jr_base=$1M, Jr_weth=$0.25M, Jr_total=$1.25M
aprBase=12%, APR_sr=9.46%, APR_mz=13.79%, Aave WETH APR=2%

Net strategy gain (daily):
  $10M × 12% / 365 × 95% = $3,123/day

Sr target: $7M × 9.46% / 365 = $1,814/day
Mz target: $2M × 13.79% / 365 = $756/day

Jr residual: $3,123 - $1,814 - $756 = $553/day
WETH yield:  $0.25M × 2% / 365 = $14/day
Jr total:    $553 + $14 = $567/day

APR_jr = $567 × 365 / $1.25M = 16.56%

Breakdown:
  Base residual: ($553 × 365) / $1.25M = 16.15%
  WETH yield:    ($14 × 365) / $1.25M  = 0.41%

Ordering: 9.46% < 13.79% < 16.56% ✓ (Sr < Mz < Jr)
```

---

# Nhóm F — Dynamic WETH Ratio (post-MVP)

**MVP dùng fixed 8:2 ratio. Section này cho upgrade path.**

---

## F1. Sigmoid Function

```
sigmoid(c, m, s) = 1 / (1 + (c / m) ^ s)

c = leverageRatio (input)
m = midpoint (default 2.0)
s = steepness (default 1.5)
```

Output [0, 1]. leverageRatio cao → sigmoid thấp → ít WETH cần. Bounded, smooth.

---

## F2. Target WETH Ratio

```
ratio_weth_target = R_min + (R_max - R_min) × sigmoid(leverageRatio, midpoint, steepness)

R_min = 10%, R_max = 35%
```

---

## F3. Deposit Ratio Validation

```
wethRatio = wethValueUSD / (baseValueUSD + wethValueUSD)
target = getTargetRatio()    // MVP: fixed 20%

isValid = |wethRatio - target| ≤ tolerance    // tolerance = 3%
```

---

## F4. Rebalance Amounts

```
Ratio quá cao (quá nhiều WETH):
  excessUSD = TVL_jr_weth - (TVL_jr × target)
  wethToSell = excessUSD / WETH_price

Ratio quá thấp (quá ít WETH):
  deficitUSD = (TVL_jr × target) - TVL_jr_weth
  baseToRecall = deficitUSD
  wethToBuy = deficitUSD / WETH_price
```

Rebalance sell: permissionless. Rebalance buy: governance only.

---

# Nhóm G — Cooldown & Fees

---

## G1. Withdrawal Policy (per-tranche coverage)

### Coverage metric per tranche

```
Senior withdrawal: dùng cs = Pool / Sr
Mezz withdrawal:   dùng cm = (Mz+Jr) / Mz
Junior withdrawal:  dùng cj = MIN(cs, cm)
```

### Fee + cooldown ranges

```
Senior (cs):
  cs > 200%       → INSTANT,      0 bps,    0 days
  150% < cs ≤ 200% → ASSETS_LOCK,  10 bps,   3 days
  105% < cs ≤ 150% → SHARES_LOCK,  50 bps,   7 days
  cs ≤ 105%       → SHARES_LOCK, 100 bps,  14 days

Mezz (cm):
  cm > 200%       → INSTANT,      0 bps,    0 days
  150% < cm ≤ 200% → ASSETS_LOCK,  10 bps,   3 days
  105% < cm ≤ 150% → SHARES_LOCK,  50 bps,   7 days
  cm ≤ 105%       → SHARES_LOCK, 100 bps,  14 days

Junior (cj = MIN(cs,cm)):
  cj > 200%       → INSTANT,      0 bps,    0 days
  150% < cj ≤ 200% → ASSETS_LOCK,  20 bps,   3 days
  105% < cj ≤ 150% → SHARES_LOCK, 100 bps,   7 days
  cj ≤ 105%       → SHARES_LOCK, 200 bps,  14 days
```

Junior fee cao hơn Sr/Mz ở cùng coverage vì: Jr rút = coverage giảm (harmful), Sr/Mz rút = coverage tăng (beneficial).

**Junior KHÔNG bị hard block.** Fee + cooldown escalation thay vì revert. User luôn có thể rút (trả phí cao + chờ lâu khi stressed).

### Fee calculation

```
feeAmount = baseAmount × feeBps / 10_000
netAmount = baseAmount - feeAmount
feeAmount → TVL_reserve
```

### Deposit gates (hard block)

```
cs ≤ 105% → Senior deposit BLOCKED
cm ≤ 105% → Mezz deposit BLOCKED
Junior deposit → ALWAYS OPEN (tăng cs và cm)
```

Block deposit OK: user chưa bỏ tiền vào → không trap funds.

---

## G2. Cooldown Unlock Time

### ERC20Cooldown + SharesCooldown (PrimeVaults controls duration)

```
unlockTime = requestTime + cooldownDuration
isClaimable = (block.timestamp ≥ unlockTime) AND (status == PENDING)
```

cooldownDuration governance-set per token.

### UnstakeCooldown + sUSDai (external protocol controls)

```
unlockTime = sUSDai.redemption(redemptionId).redemptionTimestamp   (EXACT from contract)

isClaimable = sUSDai.claimableRedeemRequest(redemptionId, controller) > 0
              (source of truth — NOT timestamp check)
```

- `redemptionTimestamp` = estimate cho UI ("claim ~March 31")
- `claimableRedeemRequest > 0` = actual check (admin phải gọi `serviceRedemptions()` trước)
- Timestamp necessary nhưng NOT sufficient (FIFO queue phụ thuộc admin)

---

## G3. Proportional WETH Withdrawal

```
userWETH = totalWETH × (userShares / totalJuniorShares)
```

WETH rút instant (từ Aave), không qua cooldown. WETH thuộc Junior depositors.

---

# Nhóm H — Strategy-Level

---

## H1. Strategy totalAssets

```
totalAssets = sUSDai.convertToAssets(activeShares)

activeShares = sUSDai.balanceOf(strategy) - s_pendingRedeemShares
```

- `s_pendingRedeemShares` = shares đã `requestRedeem()` nhưng chưa claim
- Nếu `sUSDai.balanceOf()` tự giảm sau `requestRedeem()` → không cần trừ riêng (verify trên Arbiscan)
- Nếu `balanceOf()` KHÔNG giảm → PHẢI trừ `s_pendingRedeemShares` → tránh TVL inflate

---

## H2. Aave WETH Supply APR

```
APR_aave_weth = currentLiquidityRate / 1e9

currentLiquidityRate = IPool(aavePool).getReserveData(WETH).currentLiquidityRate
(đơn vị ray = 1e27, convert sang 1e18: ÷ 1e9)
```

Dùng để tính Junior Stream 2 (PrimeLens display only).

---

## H3. sUSDai APR (Snapshot-based)

```
Trong SUSDaiAprPairProvider:

  rate = sUSDai.convertToAssets(1e18)

  getAprPair():  (state-changing — shift snapshots)
    prev ← latest
    latest ← current rate
    aprBase = (latest - prev) × YEAR × APR_SCALE / deltaT / prev

  getAprPairView():  (view — read existing snapshots, no shift)
    same formula but reads s_prevRate, s_latestRate from storage

Output: int64 × 12 decimals
Bounds: [-50%, +200%]
Benchmark cap: 40%
```

Xem docs/PV_V3_APR_ORACLE.md cho full spec.

---

## Tổng kết: Map công thức → Contract

| Công thức   | Contract                          | Function                                                  |
| ----------- | --------------------------------- | --------------------------------------------------------- |
| A1-A3       | TrancheVault                      | `totalAssets()`, `convertToShares()`, `convertToAssets()` |
| A4          | SharesCooldown + TrancheVault     | `claim()` → burn at current rate                          |
| B1-B2       | Accounting                        | `getJuniorTVL()`, `getAllTVLs()`                          |
| B3          | Accounting / PrimeCDO             | `_getCoverageSenior()`, `_getCoverageMezz()`              |
| B4          | AaveWETHAdapter + WETHPriceOracle | `totalAssetsUSD()` + `getWETHPrice()`                     |
| C1-C5       | Accounting                        | `updateTVL()`                                             |
| D1-D4       | Accounting + PrimeCDO             | `_handleLoss()` + `executeWETHCoverage()`                 |
| E1          | SUSDaiAprPairProvider             | `_computeBenchmarkApr()`                                  |
| E2          | SUSDaiAprPairProvider             | `_computeStrategyApr()`                                   |
| E3-E4       | Accounting (internal)             | `_computeRP1()`, `_computeRP2()`                          |
| E5          | Accounting                        | `_computeSeniorAPR()` → `getSeniorAPR()`                  |
| E6          | Accounting                        | `_computeMezzAPR()` → `getMezzAPR()`                      |
| E7          | Accounting                        | residual trong `updateTVL()`                              |
| E7 display  | PrimeLens                         | `getJuniorAPRBreakdown()`                                 |
| F1-F2       | RatioController (post-MVP)        | `getTargetRatio()`                                        |
| F3          | PrimeCDO                          | `depositJunior()` validation                              |
| F4          | PrimeCDO                          | `rebalanceSellWETH()`, `rebalanceBuyWETH()`               |
| G1          | PrimeCDO                          | `requestWithdraw()`                                       |
| G2 (ERC20)  | ERC20Cooldown                     | `request()`, `isClaimable()`                              |
| G2 (sUSDai) | SUSDaiCooldownRequestImpl         | `isCooldownComplete()` → `claimableRedeemRequest()`       |
| G3          | PrimeCDO                          | `withdrawJunior()`                                        |
| H1          | SUSDaiStrategy                    | `totalAssets()`                                           |
| H2          | AaveWETHAdapter                   | `currentAPR()`                                            |
| H3          | SUSDaiAprPairProvider             | `getAprPair()` / `getAprPairView()`                       |

---

## Tổng kết formulas (quick reference)

```
RP1 = x1 + y1 × (ratio_sr ^ k1)
  ratio_sr = TVL_sr / (TVL_sr + TVL_mz + TVL_jr)
  Senior trả → Mezz + Junior nhận

RP2 = x2 + y2 × (mezzLeverage ^ k2)
  mezzLeverage = (TVL_mz + TVL_jr) / TVL_jr
  Mezz trả → Junior nhận

APR_sr = MAX(aprTarget, aprBase × (1 - RP1))
APR_mz = aprBase × (1 + RP1 × subLeverage) × (1 - RP2)
  subLeverage = TVL_sr / (TVL_mz + TVL_jr)
APR_jr = residual (gain splitting)

Bỏ: alpha, beta (không cần)
Mỗi tranche trả ĐÚNG 1 loại phí cho layer dưới mình.
```

---

## Changelog

```
v3.5.0 (từ v3.4.0):
  [REDESIGN] B3: 1 leverageRatio → 2 coverage metrics
    → cs = Pool/Sr (Senior coverage), cm = (Mz+Jr)/Mz (Mezz coverage)
    → Mỗi tranche có risk profile riêng → metric riêng
  [REDESIGN] G1: Withdrawal policy per-tranche coverage
    → Senior dùng cs, Mezz dùng cm, Junior dùng MIN(cs,cm)
    → Junior KHÔNG bị hard block — fee + cooldown escalation thay vì revert
    → Jr fee cao hơn Sr/Mz (Jr rút = coverage giảm)
  [FIX] Deposit gates: cs<105% block Sr, cm<105% block Mz
  [NOTE] mezzLeverage (RP2) = (Mz+Jr)/Jr ≠ cm = (Mz+Jr)/Mz — clarified

v3.4.0 (từ v3.3.0):
  [REDESIGN] E4: RP2 dùng mezzLeverage = (Mz+Jr)/Jr
  [REDESIGN] E5: Senior chỉ trả RP1, không trả RP2
  [REDESIGN] E6: Mezz APR multiplicative: aprBase × (1+RP1×subLev) × (1-RP2)
  [REMOVED] alpha/beta split
  [REDESIGN] E7: Junior 2 streams (base residual + WETH)

v3.3.0 (từ v3.2.0):
  [FIX] C4-C5: Mezz explicit allocation (3 tranches, 4 cases)
  [FIX] E2: Tách E1=aprTarget, E2=aprBase
  [FIX] E3: ratio_sr denominator = cả 3 tranches
  [FIX] B4: TWAP → Chainlink spot
  [FIX] G2: sUSDai UnstakeCooldown
```

---

_PrimeVaults V3 — Mathematical Reference v3.5.0_  
_Arbitrum • sUSDai • 3-tranche gain splitting_  
_RP1: Senior→Subordination • RP2: Mezz→Junior (multiplicative)_  
_2 coverage metrics: cs (Senior), cm (Mezz) • No Junior withdraw block_  
_March 2026_
