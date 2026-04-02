# PrimeVaults V3 — Tham chiếu Công thức Toán học

**Version:** 3.6.1  
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
- B3. Coverage Metrics
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

**Nhóm E — APY Pipeline (Recursive 2-Tranche)**

- E0. Base APY (Diluted)
- E1. Benchmark Rate (Floor)
- E2. Strategy Rate (APY_strategy)
- E3. Risk Premium 1 — Senior → Sub-pool
- E4. Senior APY
- E5. Sub-Pool Effective APY
- E6. Risk Premium 2 — Mezz → Junior
- E7. Mezzanine APY
- E8. Junior APY (Residual)
- E9. Junior APY Display (+ WETH Aave)
- E10. Conservation Proof

**Nhóm F — Dynamic WETH Ratio (post-MVP)**

- F1. Sigmoid Function
- F2. Target WETH Ratio
- F3. Deposit Ratio Validation
- F4. Rebalance Amounts

**Nhóm G — Cooldown & Fees**

- G1. Withdrawal Policy
- G2. Cooldown Unlock Time
- G3. Proportional WETH Withdrawal

**Nhóm H — Strategy-Level**

- H1. Strategy totalAssets
- H2. Aave WETH Supply APY
- H3. sUSDai APY (snapshot-based)

---

## Quy ước TVL

```
Strategy_TVL = TVL_sr + TVL_mz + TVL_jr_base
  → Phần vốn nằm trong strategy (sUSDai), earn APY_strategy

Pool_TVL = TVL_sr + TVL_mz + TVL_jr
  → Toàn bộ pool bao gồm WETH buffer
  → Jr = Jr_base + Jr_weth
  → Dùng cho MỌI ratio, RP, APY formula

Jr = TVL_jr_base + TVL_jr_weth
  → Luôn dùng full Jr trong mọi công thức
  → WETH vừa nhận yield (Aave) vừa nhận RP (protection buffer)
```

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
Jr = TVL_jr_base + TVL_jr_weth

TVL_jr_base = phần base asset của Junior (từ gain splitting)
TVL_jr_weth = aWETH_balance × WETH_price
```

**QUAN TRỌNG:** `Jr` luôn bao gồm cả WETH trong mọi formula.
WETH vừa là protection buffer, vừa nhận yield từ RP redistribution và Aave.

---

## B2. Total Protocol TVL

```
Strategy_TVL = TVL_sr + TVL_mz + TVL_jr_base
  → Phần earn APY_strategy (sUSDai yield)

Pool_TVL = TVL_sr + TVL_mz + Jr
         = TVL_sr + TVL_mz + TVL_jr_base + TVL_jr_weth
  → Dùng cho ratio, RP, APY

TVL_total = Pool_TVL + TVL_reserve
```

Accounting invariant (kiểm tra mỗi updateTVL):

```
currentStrategyTVL + currentWethValueUSD
  ≈ TVL_sr + TVL_mz + TVL_jr_base + TVL_jr_weth + TVL_reserve
```

---

## B3. Coverage Metrics (2 per-tranche)

```
cs = (TVL_sr + TVL_mz + Jr) / TVL_sr       (Senior coverage)
cm = (TVL_mz + Jr) / TVL_mz                (Mezz coverage)
```

- `cs` đo "mỗi $1 Senior có bao nhiêu $ pool backing (bao gồm subordination bên dưới)"
- `cm` đo "mỗi $1 Mezz có bao nhiêu $ (Mz+Jr) backing (chỉ Junior bên dưới)"
- Jr bao gồm WETH → WETH là protection buffer → tính vào coverage

### Ví dụ

```
Sr=$7M, Mz=$2M, Jr=$1.25M (base=$1M + weth=$0.25M):
  cs = 10.25/7 = 1.464  (46.4% subordination)
  cm = 3.25/2 = 1.625   (62.5% Junior protection)

Sr=$9M, Mz=$0.5M, Jr=$0.3M:
  cs = 9.8/9 = 1.089    (8.9% subordination → stressed)
  cm = 0.8/0.5 = 1.60   (60% Junior → Mezz OK)
```

### Dùng ở đâu

```
cs: deposit gate Senior, withdrawal policy Senior
cm: deposit gate Mezz, withdrawal policy Mezz
MIN(cs, cm): withdrawal policy Junior
```

### Edge cases

```
Sr = 0: cs = ∞
Mz = 0: cm = ∞
Jr = 0 AND (Sr+Mz) > 0: cs, cm gần 1.0 → gates block Sr/Mz
Empty protocol: cho phép first deposit bất kỳ tranche
```

---

## B4. WETH Value (USD)

```
TVL_jr_weth = aWETH_balance × WETH_price

aWETH_balance = IERC20(aWETH).balanceOf(AaveWETHAdapter)
WETH_price    = Chainlink ETH/USD spot price (18 decimals)
```

- aWETH balance tự tăng per block (Aave rebasing token)
- Staleness check: revert nếu feed > 1 giờ không update

---

# Nhóm C — Gain Splitting (3-Tranche)

Nguyên tắc: **Senior ưu tiên trước, rồi Mezz, rồi Junior nhận residual.**

---

## C1. Strategy Gain

```
strategyGain = currentStrategyTVL - prevStrategyTVL

currentStrategyTVL = IStrategy(strategy).totalAssets()
prevStrategyTVL    = TVL_sr + TVL_mz + TVL_jr_base + TVL_reserve
```

- Chỉ tính strategy TVL (WETH yield capture riêng qua Aave rebasing)
- Nếu strategy có `s_pendingRedeemShares`: `totalAssets = convertToAssets(balance - s_pendingRedeemShares)`

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
seniorGainTarget = TVL_sr × APY_sr × deltaT / (365 days)
```

Compound index version:

```
interestFactor = APY_sr × deltaT / (365 days × 1e18)
srtTargetIndex_new = srtTargetIndex × (1e18 + interestFactor) / 1e18
seniorGainTarget = TVL_sr × (srtTargetIndex_new / srtTargetIndex - 1)
```

APY_sr: xem E4.

---

## C4. Mezzanine Target Gain

```
mezzGainTarget = TVL_mz × APY_mz × deltaT / (365 days)
```

Compound index version:

```
interestFactor_mz = APY_mz × deltaT / (365 days × 1e18)
mzTargetIndex_new = mzTargetIndex × (1e18 + interestFactor_mz) / 1e18
mezzGainTarget = TVL_mz × (mzTargetIndex_new / mzTargetIndex - 1)
```

APY_mz: xem E7.

---

## C5. Gain Distribution (4 Cases)

```
netGain = strategyGain - reserveCut
totalTarget = seniorGainTarget + mezzGainTarget
```

### CASE A: netGain ≥ totalTarget

```
TVL_sr      += seniorGainTarget
TVL_mz      += mezzGainTarget
TVL_jr_base += (netGain - totalTarget)     ← Junior nhận residual
```

### CASE B: seniorGainTarget ≤ netGain < totalTarget

```
TVL_sr      += seniorGainTarget
TVL_mz      += (netGain - seniorGainTarget)
TVL_jr_base += 0
```

### CASE C: 0 ≤ netGain < seniorGainTarget

```
TVL_sr      += netGain
TVL_mz      += 0
TVL_jr_base += 0
```

### CASE D: netGain < 0

```
→ Chuyển sang D4 (Loss Waterfall)
```

### Waterfall priority

```
Yield:  Senior → Mezz → Junior (Senior ưu tiên nhất)
Loss:   Junior → Mezz → Senior (Junior chịu trước)
```

---

# Nhóm D — Loss Waterfall

---

## D1. Loss Detection

```
loss = |netGain|    when netGain < 0
```

---

## D2. WETH Coverage Amount

```
wethCoverageUSD = MIN(loss, TVL_jr_weth)
wethToSell      = wethCoverageUSD / WETH_price
actualWethSell  = MIN(wethToSell, aWETH_balance)
```

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

---

## D4. 4-Layer Waterfall

```
remaining = loss

// Layer 0: WETH buffer
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

- Shortfall auto-pause: nếu Junior sharePrice < 90% → pause protocol

---

# Nhóm E — APY Pipeline (Recursive 2-Tranche)

**Thiết kế core: 3-tranche = 2 lớp đệ quy của cùng 1 pattern 2-tranche.**

### Nguyên lý

```
1. Strategy sinh yield trên Strategy_TVL (không bao gồm WETH)
2. Dilute yield ra Pool_TVL (bao gồm WETH) → APY_base
3. Mọi formula dùng Jr = Jr_base + Jr_weth thống nhất
4. WETH vừa nhận yield (Aave) vừa nhận RP (protection buffer)
5. Conservation: APY_base × Pool = APY_strategy × Strategy_TVL
```

### Pattern đệ quy

```
Tầng 1:  [Senior]  vs  [Mezz + Junior]     → RP1, SubPool APY
Tầng 2:  [Mezz]    vs  [Junior]            → RP2, Junior residual

Mỗi tầng cùng 1 pattern:
  APY_lower = APY_pool + (APY_pool - APY_upper) × TVL_upper / TVL_lower
```

---

## E0. Base APY (Diluted) ⭐

```
APY_base = APY_strategy × Strategy_TVL / Pool_TVL

Strategy_TVL = TVL_sr + TVL_mz + TVL_jr_base
Pool_TVL     = TVL_sr + TVL_mz + Jr
Jr           = TVL_jr_base + TVL_jr_weth
```

### Tại sao dilute?

```
Strategy chỉ earn trên Strategy_TVL (sUSDai stake).
WETH nằm Aave, không earn APY_strategy.

Nhưng WETH là phần của pool (protection buffer, tính vào Jr).
Khi phân phối yield qua RP, WETH cần tham gia.

Dilute = "spread" strategy yield ra toàn pool:
  APY_base × Pool_TVL = APY_strategy × Strategy_TVL

Tổng yield KHÔNG đổi. Chỉ quy về per-dollar cho pool lớn hơn.
```

### Ví dụ

```
APY_strategy = 12%, Sr=7M, Mz=2M, Jr_base=1M, Jr_weth=0.25M
Strategy_TVL = 10M, Pool_TVL = 10.25M

APY_base = 12% × 10/10.25 = 11.707%

Check: 11.707% × 10.25M = 12% × 10M = 1.2M ✓
```

---

## E1. Benchmark Rate (Floor)

```
Floor = Σ(supply_i × rate_i) / Σ supply_i
        for i ∈ [USDC, USDT] trên Aave v3 Arbitrum

rate_i    = Aave currentLiquidityRate (ray 1e27 → 12dec: ÷ 1e15)
supply_i  = IERC20(aTokenAddress_i).totalSupply()
```

- Floor đến từ **on-chain Aave** (realtime)
- Cap: BENCHMARK_MAX = 40% (0.4e12)
- Floor = sàn APY cho Senior

---

## E2. Strategy Rate (APY_strategy)

```
APY_strategy = (rate_T1 - rate_T0) × SECONDS_PER_YEAR × APY_SCALE / deltaT / rate_T0

rate = sUSDai.convertToAssets(1e18)
```

- Snapshot shift: keeper gọi `AprPairFeed.updateRoundData()`
- Supports negative (int64 < 0 nếu rate giảm)
- Clamp: [-50%, +200%]

---

## E3. Risk Premium 1 (RP1) — Senior → Sub-pool

```
RP1 = x1 + y1 × (ratio_sr ^ k1)

ratio_sr = TVL_sr / Pool_TVL

x1 = 0.10e18   (baseline 10%)
y1 = 0.125e18  (max additional 12.5%)
k1 = 0.3e18    (concave)
```

- Pool_TVL bao gồm WETH → Jr WETH tham gia tính ratio
- ratio_sr tăng → RP1 tăng → Senior APY giảm → incentivize subordination
- Constraint: `x1 + y1 ≤ 0.80`

### Ví dụ

```
Sr=$7M, Mz=$2M, Jr=$1.25M, Pool=$10.25M:
  ratio_sr = 7/10.25 = 0.683
  RP1 = 0.10 + 0.125 × 0.683^0.3 = 0.10 + 0.112 = 21.15%
```

---

## E4. Senior APY

```
APY_sr = MAX(Floor, APY_base × (1 - RP1))
```

- Senior trả RP1 cho subordination (Mezz + Junior protect Senior)
- `MAX(Floor, ...)` = sàn: Senior ít nhất bằng Aave benchmark
- Floor = **priority**, nếu strategy yield = 0 → Senior yield = 0

### Ví dụ

```
Floor = 4%, APY_base = 11.707%, RP1 = 21.15%

APY_sr = MAX(4%, 11.707% × (1 - 0.2115))
       = MAX(4%, 11.707% × 0.7885)
       = MAX(4%, 9.23%)
       = 9.23%
```

---

## E5. Sub-Pool Effective APY ⭐

Sau khi Senior lấy phần của mình, phần yield còn lại chảy vào sub-pool (Mz + Jr):

```
APY_sub = APY_base + (APY_base - APY_sr) × TVL_sr / (TVL_mz + Jr)
```

### Derivation

```
Total yield    = APY_base × Pool_TVL
Senior takes   = APY_sr × TVL_sr
Remaining      = APY_base × Pool_TVL - APY_sr × TVL_sr
               = APY_base × (TVL_sr + TVL_mz + Jr) - APY_sr × TVL_sr
               = APY_base × (TVL_mz + Jr) + (APY_base - APY_sr) × TVL_sr

Per-dollar sub-pool:
APY_sub = Remaining / (TVL_mz + Jr)
        = APY_base + (APY_base - APY_sr) × TVL_sr / (TVL_mz + Jr)
```

### Ý nghĩa

```
(APY_base - APY_sr) = phần yield Senior bỏ lại (vì Senior trả RP1)
TVL_sr / (TVL_mz + Jr) = leverage — Senior lớn hơn → sub-pool nhận nhiều hơn

Bình thường (APY_base > APY_sr): APY_sub > APY_base (sub-pool hưởng leverage)
Floor active (APY_sr > APY_base): APY_sub < APY_base (sub-pool bù cho Senior)
```

### Ví dụ

```
Case 1 (bình thường):
  APY_base=11.707%, APY_sr=9.23%, Sr=7M, Mz+Jr=3.25M
  APY_sub = 11.707% + (11.707% - 9.23%) × 7/3.25
          = 11.707% + 2.477% × 2.154
          = 11.707% + 5.335% = 17.042%

Case 2 (floor active):
  APY_base=7%, Floor=10%, APY_sr=10% (floor), Sr=8M, Mz+Jr=2M
  APY_sub = 7% + (7% - 10%) × 8/2
          = 7% + (-3%) × 4
          = 7% - 12% = -5%
  → Sub-pool negative, cả Mezz lẫn Junior chịu ✓
```

---

## E6. Risk Premium 2 (RP2) — Mezz → Junior

**Cùng pattern với RP1, lặp lại trong sub-pool.**

```
RP2 = x2 + y2 × (ratio_mz_sub ^ k2)

ratio_mz_sub = TVL_mz / (TVL_mz + Jr)

x2 = 0.05e18   (baseline 5%)
y2 = 0.10e18   (max additional 10%)
k2 = 0.5e18    (square root)
```

### Tại sao cùng dạng ratio (không dùng leverage)?

```
Recursive pattern yêu cầu cùng dạng ở mỗi tầng:

Tầng 1: RP1 = x1 + y1 × (TVL_sr / Pool)^k1
                           ↑ ratio of "upper" in pool

Tầng 2: RP2 = x2 + y2 × (TVL_mz / (TVL_mz + Jr))^k2
                           ↑ ratio of "upper" in sub-pool

Mở rộng n-tranche: RP_n = x_n + y_n × (ratio_upper_in_subpool)^k_n
```

### Properties

- Jr bao gồm WETH → WETH tham gia protection ratio
- Senior TVL thay đổi → RP2 **KHÔNG thay đổi** (clean separation)
- Constraint: `x2 + y2 ≤ 0.50`

### Ví dụ

```
Mz=$2M, Jr=$1.25M:
  ratio_mz_sub = 2/3.25 = 0.615
  RP2 = 0.05 + 0.10 × 0.615^0.5 = 0.05 + 0.0785 = 12.85%

Mz=$5M, Jr=$0.5M:
  ratio_mz_sub = 5/5.5 = 0.909
  RP2 = 0.05 + 0.10 × 0.909^0.5 = 0.05 + 0.0954 = 14.54%

Mz=$0.5M, Jr=$5M:
  ratio_mz_sub = 0.5/5.5 = 0.091
  RP2 = 0.05 + 0.10 × 0.091^0.5 = 0.05 + 0.0302 = 8.02%

→ Mezz dominate → RP2 cao → Mezz APY giảm
→ Junior dominate → RP2 thấp → Mezz APY cao
→ Senior TVL thay đổi → RP2 KHÔNG đổi ✓
```

---

## E7. Mezzanine APY

```
APY_mz = APY_sub × (1 - RP2)
```

- Cùng dạng với APY_sr: `APY = APY_pool × (1 - RP)`
- **Không có floor** — Mezz riskier hơn Senior
- Khi APY_sub < 0 (floor kích hoạt tầng trên) → APY_mz cũng < 0
  → Mezz chịu phần floor cost proportional qua RP2

### So sánh v3.5 → v3.6

```
Khi floor KHÔNG kích hoạt:
  APY_sub = APY_base × (1 + RP1 × subLev)     (rút gọn được)
  APY_mz  = APY_base × (1 + RP1 × subLev) × (1 - RP2)
  → TƯƠNG ĐƯƠNG v3.5 dạng multiplicative ✓

Khi floor KÍCH HOẠT:
  v3.5: APY_mz không adjust → Jr chịu hết floor cost
  v3.6: APY_mz adjust qua APY_sub → floor cost chia cho Mz+Jr theo RP2
  → v3.6 fair hơn ✓
```

### Ví dụ

```
APY_sub = 17.042%, RP2 = 12.85%
APY_mz = 17.042% × (1 - 0.1285) = 17.042% × 0.8715 = 14.85%
```

---

## E8. Junior APY (Residual)

**Cùng dạng residual 2-tranche, lặp lại trong sub-pool.**

### Closed-form (cho PrimeLens display)

```
APY_jr = APY_sub + (APY_sub - APY_mz) × TVL_mz / Jr
```

### Derivation

```
Junior_Yield = SubPool_Yield - Mezz_Yield
             = APY_sub × (TVL_mz + Jr) - APY_mz × TVL_mz

APY_jr = Junior_Yield / Jr
       = APY_sub × (TVL_mz + Jr) / Jr - APY_mz × TVL_mz / Jr
       = APY_sub + (APY_sub - APY_mz) × TVL_mz / Jr
```

### Pattern đệ quy

```
Tầng 1: APY_sub = APY_base + (APY_base - APY_sr)  × TVL_sr / (TVL_mz + Jr)
Tầng 2: APY_jr  = APY_sub  + (APY_sub  - APY_mz)  × TVL_mz / Jr

Cùng dạng: APY_lower = APY_pool + (APY_pool - APY_upper) × TVL_upper / TVL_lower
```

### Trong Accounting (code thực tế)

```
Junior APY KHÔNG có formula riêng trong Accounting.
Junior nhận RESIDUAL từ gain splitting (C5):

  juniorGain = netGain - seniorGainTarget - mezzGainTarget   (Case A)
  TVL_jr_base += juniorGain
```

### Ví dụ

```
APY_sub=17.042%, APY_mz=14.85%, Mz=2M, Jr=1.25M

APY_jr = 17.042% + (17.042% - 14.85%) × 2/1.25
       = 17.042% + 2.192% × 1.6
       = 17.042% + 3.507% = 20.549%
```

---

## E9. Junior APY Display (+ WETH Aave Yield)

```
APY_jr_display = APY_jr + APY_aave × TVL_jr_weth / Jr
```

- `APY_jr` = phần từ strategy yield redistribution (E8)
- `APY_aave × TVL_jr_weth / Jr` = phần từ Aave WETH supply yield
- WETH earn **cả hai**: RP redistribution (built-in qua E8) + Aave yield (cộng thêm)

### Trong PrimeLens (display cho frontend)

```
Stream 1 (base + RP residual):
  yield_strategy = APY_jr × Jr (annualized)

Stream 2 (WETH yield):
  yield_weth = APY_aave × TVL_jr_weth (annualized)

APY_jr_display = (yield_strategy + yield_weth) / Jr
```

### Ví dụ

```
APY_jr = 20.549%, APY_aave = 2%, Jr_weth = 0.25M, Jr = 1.25M

APY_jr_display = 20.549% + 2% × 0.25/1.25
               = 20.549% + 0.400%
               = 20.949%
```

---

## E10. Conservation Proof

### Theorem: APY_sr × Sr + APY_mz × Mz + APY_jr × Jr = APY_base × Pool

```
Bước 1: Thay APY_jr

  APY_jr × Jr
  = [APY_sub + (APY_sub - APY_mz) × Mz/Jr] × Jr
  = APY_sub × Jr + (APY_sub - APY_mz) × Mz
  = APY_sub × (Mz + Jr) - APY_mz × Mz

Bước 2: Cộng APY_mz × Mz

  APY_mz × Mz + APY_jr × Jr
  = APY_mz × Mz + APY_sub × (Mz + Jr) - APY_mz × Mz
  = APY_sub × (Mz + Jr)                              ← APY_mz triệt tiêu!

Bước 3: Thay APY_sub

  APY_sub × (Mz + Jr)
  = [APY_base + (APY_base - APY_sr) × Sr/(Mz+Jr)] × (Mz+Jr)
  = APY_base × (Mz+Jr) + (APY_base - APY_sr) × Sr
  = APY_base × (Sr + Mz + Jr) - APY_sr × Sr
  = APY_base × Pool - APY_sr × Sr

Bước 4: Cộng APY_sr × Sr

  APY_sr × Sr + APY_mz × Mz + APY_jr × Jr
  = APY_sr × Sr + APY_base × Pool - APY_sr × Sr
  = APY_base × Pool                                  ← APY_sr triệt tiêu!

  ∎ QED
```

### Corollary: link to actual strategy yield

```
APY_base × Pool = APY_strategy × Strategy_TVL    (từ E0)

→ APY_sr × Sr + APY_mz × Mz + APY_jr × Jr = APY_strategy × Strategy_TVL

Tổng yield phân phối = Tổng yield strategy tạo ra. Không có leak, không có free money.
```

### Conservation luôn đúng vì:

```
1. Telescoping cancellation: mỗi tầng triệt tiêu tầng dưới
2. Không phụ thuộc RP1, RP2 values
3. Không phụ thuộc floor có kích hoạt hay không
4. Chỉ cần APY_jr = residual (từ C5)
```

---

### Full trace (v3.6.1)

```
TVL: Sr=$7M, Mz=$2M, Jr_base=$1M, Jr_weth=$0.25M, Jr=$1.25M
APY_strategy=12%, Floor=4%, APY_aave=2%, reserveBps=500
RP1 params: x1=0.10, y1=0.125, k1=0.3
RP2 params: x2=0.05, y2=0.10, k2=0.5

Strategy_TVL = 10M, Pool_TVL = 10.25M

E0: APY_base = 12% × 10/10.25 = 11.707%

E3: RP1
  ratio_sr = 7/10.25 = 0.683
  RP1 = 0.10 + 0.125 × 0.683^0.3 = 21.15%

E4: APY_sr
  APY_sr = MAX(4%, 11.707% × 0.7885) = MAX(4%, 9.23%) = 9.23%

E5: APY_sub
  APY_sub = 11.707% + (11.707% - 9.23%) × 7/3.25
          = 11.707% + 2.477% × 2.154 = 17.042%

E6: RP2
  ratio_mz_sub = 2/3.25 = 0.615
  RP2 = 0.05 + 0.10 × 0.615^0.5 = 12.85%

E7: APY_mz
  APY_mz = 17.042% × (1 - 0.1285) = 14.85%

E8: APY_jr
  APY_jr = 17.042% + (17.042% - 14.85%) × 2/1.25 = 20.549%

E9: APY_jr_display
  APY_jr_display = 20.549% + 2% × 0.25/1.25 = 20.949%

E10: Conservation
  9.23% × 7M + 14.85% × 2M + 20.549% × 1.25M
  = 646.1K + 297.0K + 256.9K = 1,200.0K
  APY_strategy × Strategy_TVL = 12% × 10M = 1,200.0K ✓

Ordering: 9.23% < 14.85% < 20.95%  (Sr < Mz < Jr) ✓

Gain splitting (daily, sau reserve 5%):
  strategyGain = 12% × 10M / 365 = $3,288
  reserveCut = $164, netGain = $3,124

  seniorTarget = 9.23% × 7M / 365 = $1,770
  mezzTarget   = 14.85% × 2M / 365 = $814
  totalTarget  = $2,584

  CASE A: $3,124 > $2,584
    Senior: +$1,770
    Mezz:   +$814
    Junior: +$540 (residual)
    + WETH:  $14/day (Aave, riêng)

  Conservation: $1,770 + $814 + $540 + $164 = $3,288 = strategyGain ✓
```

---

### Scalability — thêm tranche thứ 4

```
Tầng 1:  [Senior]       vs  [Mezz + Junior + SuperJr]     → RP1, SubPool1
Tầng 2:  [Mezz]         vs  [Junior + SuperJr]            → RP2, SubPool2
Tầng 3:  [Junior]       vs  [SuperJr]                     → RP3, SuperJr residual

APY_base dilute ra Pool bao gồm SuperJr
Cùng pattern RP = x + y × ratio^k ở mỗi tầng
Conservation: telescoping cancellation qua n tầng
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
Ratio quá cao:
  excessUSD = TVL_jr_weth - (Jr × target)
  wethToSell = excessUSD / WETH_price

Ratio quá thấp:
  deficitUSD = (Jr × target) - TVL_jr_weth
  wethToBuy = deficitUSD / WETH_price
```

Rebalance sell: permissionless. Rebalance buy: governance only.

---

# Nhóm G — Cooldown & Fees

---

## G1. Withdrawal Policy (per-tranche coverage)

```
Senior: ALWAYS INSTANT (no fee, no delay)

Mezz (dựa trên cs):
  cs > 160%        → INSTANT
  140% < cs ≤ 160% → ASSETS_LOCK
  cs ≤ 140%        → SHARES_LOCK

Junior (dựa trên cs VÀ cm):
  cs > 160% AND cm > 150%       → INSTANT
  cs > 140% AND cm > 130%       → ASSETS_LOCK
  otherwise                      → SHARES_LOCK
```

**Không tranche nào bị hard block withdraw.** Mechanism escalation kèm fee tăng dần.

### Fee + cooldown per mechanism

```
INSTANT:     0 bps, 0 days
ASSETS_LOCK: configurable (e.g. 10-20 bps, 3 days)
SHARES_LOCK: configurable (e.g. 50-200 bps, 7-14 days)
Junior fees higher than Mezz at same mechanism.
```

### Fee calculation

```
feeAmount = baseAmount × feeBps / 10_000
netAmount = baseAmount - feeAmount
feeAmount → TVL_reserve
```

### Deposit gates (check AFTER deposit)

```
cs < 105% after Sr deposit → revert
cm < 105% after Mz deposit → revert
Jr deposit → ALWAYS OPEN
```

---

## G2. Cooldown Unlock Time

### ERC20Cooldown + SharesCooldown

```
unlockTime = requestTime + cooldownDuration
isClaimable = (block.timestamp ≥ unlockTime) AND (status == PENDING)
```

### UnstakeCooldown + sUSDai

```
isClaimable = sUSDai.claimableRedeemRequest(redemptionId, controller) > 0
```

- `claimableRedeemRequest > 0` = source of truth (admin phải gọi `serviceRedemptions()`)

---

## G3. Proportional WETH Withdrawal

```
userWETH = totalWETH × (userShares / totalJuniorShares)
```

WETH rút instant (từ Aave), không qua cooldown.

---

# Nhóm H — Strategy-Level

---

## H1. Strategy totalAssets

```
totalAssets = sUSDai.convertToAssets(activeShares)

activeShares = sUSDai.balanceOf(strategy) - s_pendingRedeemShares
```

---

## H2. Aave WETH Supply APY

```
APY_aave = currentLiquidityRate / 1e9

currentLiquidityRate = IPool(aavePool).getReserveData(WETH).currentLiquidityRate
```

Dùng cho E9 (Junior APY display).

---

## H3. sUSDai APY (Snapshot-based)

```
APY_strategy = (rate_T1 - rate_T0) × YEAR × APY_SCALE / deltaT / rate_T0

rate = sUSDai.convertToAssets(1e18)

Output: int64 × 12 decimals
Bounds: [-50%, +200%]
```

---

## Tổng kết: Map công thức → Contract

| Công thức | Contract                          | Function                                                  |
| --------- | --------------------------------- | --------------------------------------------------------- |
| A1-A3     | TrancheVault                      | `totalAssets()`, `convertToShares()`, `convertToAssets()` |
| A4        | SharesCooldown + TrancheVault     | `claim()` → burn at current rate                          |
| B1-B2     | Accounting                        | `getJuniorTVL()`, `getAllTVLs()`                          |
| B3        | Accounting / PrimeCDO             | `_getCoverageSenior()`, `_getCoverageMezz()`              |
| B4        | AaveWETHAdapter + WETHPriceOracle | `totalAssetsUSD()` + `getWETHPrice()`                     |
| C1-C5     | Accounting                        | `updateTVL()`                                             |
| D1-D4     | Accounting + PrimeCDO             | `_handleLoss()` + `executeWETHCoverage()`                 |
| E0        | Accounting                        | `_computeBaseAPY()` (dilute)                              |
| E1        | SUSDaiAprPairProvider             | `_computeBenchmarkApr()`                                  |
| E2        | SUSDaiAprPairProvider             | `_computeStrategyApr()`                                   |
| E3        | Accounting (internal)             | `_computeRP1()`                                           |
| E4        | Accounting                        | `_computeSeniorAPY()` → `getSeniorAPY()`                  |
| E5        | Accounting (internal)             | `_computeSubPoolAPY()`                                    |
| E6        | Accounting (internal)             | `_computeRP2()`                                           |
| E7        | Accounting                        | `_computeMezzAPY()` → `getMezzAPY()`                      |
| E8        | Accounting                        | residual trong `updateTVL()`                              |
| E9        | PrimeLens                         | `getJuniorAPYBreakdown()`                                 |
| F1-F4     | RatioController / PrimeCDO        | WETH ratio management                                     |
| G1-G3     | PrimeCDO / Cooldown contracts     | Withdrawal policy                                         |
| H1-H3     | Strategy / Adapters / Oracle      | Strategy-level data                                       |

---

## Tổng kết formulas (quick reference)

```
// Step 0: Dilute strategy yield ra Pool (bao gồm WETH)
APY_base = APY_strategy × Strategy_TVL / Pool_TVL

// Tầng 1: Senior vs Pool
RP1 = x1 + y1 × (Sr / Pool)^k1
APY_sr = MAX(Floor, APY_base × (1 - RP1))

// Sub-pool hiệu dụng
APY_sub = APY_base + (APY_base - APY_sr) × Sr / (Mz + Jr)

// Tầng 2: Mezz vs Junior (cùng pattern)
RP2 = x2 + y2 × (Mz / (Mz + Jr))^k2
APY_mz = APY_sub × (1 - RP2)

// Junior = residual
APY_jr = APY_sub + (APY_sub - APY_mz) × Mz / Jr

// Display (thêm Aave WETH yield)
APY_jr_display = APY_jr + APY_aave × Jr_weth / Jr

// Conservation
APY_base × Pool = APY_strategy × Strategy_TVL  ✓
APY_sr × Sr + APY_mz × Mz + APY_jr × Jr = APY_base × Pool  ✓

// Jr = Jr_base + Jr_weth LUÔN LUÔN
```

---

## Changelog

```
v3.6.1 (từ v3.6.0):
  [FIX] E0: Thêm APY_base diluted = APY_strategy × Strategy_TVL / Pool_TVL
    → Strategy earn trên (Sr+Mz+Jr_base), nhưng distribute ra (Sr+Mz+Jr)
    → WETH không earn APY_strategy nhưng tham gia RP redistribution
  [FIX] Mọi formula dùng Jr = Jr_base + Jr_weth thống nhất
    → Trước: lẫn lộn Jr_base vs Jr ở E5, E8
    → Sau: Jr full everywhere, APY_base tự adjust
  [FIX] APR → APY terminology toàn bộ document
  [NOTE] WETH vừa nhận RP yield (built-in qua Jr) vừa nhận Aave yield (E9)
  [NOTE] Conservation: APY_base × Pool = APY_strategy × Strategy_TVL

v3.6.0 (từ v3.5.0):
  [REDESIGN] E — Recursive 2-tranche pattern
  [ADDED] SubPool APY concept
  [CHANGED] RP2 dùng ratio_mz_sub thay vì mezzLeverage
  [ADDED] Conservation proof formal

v3.5.0 (từ v3.4.0):
  [REDESIGN] B3: 2 coverage metrics (cs, cm)
  [REDESIGN] G1: Per-tranche withdrawal policy

v3.4.0 (từ v3.3.0):
  [REDESIGN] E4-E6: RP separation, multiplicative APR_mz
  [REMOVED] alpha/beta split
```

---

_PrimeVaults V3 — Mathematical Reference v3.6.1_
_Arbitrum • sUSDai • Recursive 2-tranche yield splitting_
_APY_base diluted: Strategy yield spread across Pool including WETH_
_Jr = Jr_base + Jr_weth everywhere • WETH gets RP + Aave yield_
_Conservation by construction (telescoping cancellation)_
_April 2026_
