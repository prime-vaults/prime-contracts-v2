# PrimeVaults V3 — Tham chiếu Công thức Toán học

**Phạm vi:** Mọi công thức toán học trong hệ thống  
**Quy ước:** Tất cả dùng fixed-point 18 decimals (`1e18 = 1.0` hoặc `100%`)

---

## Mục lục

**Nhóm A — Exchange Rate & ERC-4626**
- [A1. Share Price (Exchange Rate)](#a1-share-price-exchange-rate)
- [A2. convertToShares (Deposit)](#a2-converttoshares-deposit)
- [A3. convertToAssets (Withdraw)](#a3-converttoassets-withdraw)
- [A4. SharesLock Claim Rate](#a4-shareslock-claim-rate)

**Nhóm B — TVL & Accounting**
- [B1. Junior TVL (Dual-Asset)](#b1-junior-tvl-dual-asset)
- [B2. Total Protocol TVL](#b2-total-protocol-tvl)
- [B3. Coverage Ratio](#b3-coverage-ratio)
- [B4. WETH Value (USD)](#b4-weth-value-usd)

**Nhóm C — Gain Splitting**
- [C1. Strategy Gain](#c1-strategy-gain)
- [C2. Reserve Cut](#c2-reserve-cut)
- [C3. Senior Target Gain (Compound Index)](#c3-senior-target-gain-compound-index)
- [C4. Gain Distribution (3 cases)](#c4-gain-distribution-3-cases)

**Nhóm D — Loss Waterfall**
- [D1. Loss Detection](#d1-loss-detection)
- [D2. WETH Coverage Amount](#d2-weth-coverage-amount)
- [D3. Swap Output with Slippage](#d3-swap-output-with-slippage)
- [D4. 4-Layer Waterfall](#d4-4-layer-waterfall)

**Nhóm E — APR Pipeline**
- [E1. Benchmark Rate (APR floor)](#e1-benchmark-rate-apr-floor)
- [E2. Risk Premium 1 (RP1)](#e2-risk-premium-1-rp1)
- [E3. Risk Premium 2 (RP2)](#e3-risk-premium-2-rp2)
- [E4. Alpha Split](#e4-alpha-split)
- [E5. Senior APR](#e5-senior-apr)
- [E6. Mezzanine APR](#e6-mezzanine-apr)
- [E7. Junior APR (3 Streams)](#e7-junior-apr-3-streams)

**Nhóm F — Dynamic WETH Ratio**
- [F1. Sigmoid Function](#f1-sigmoid-function)
- [F2. Target WETH Ratio](#f2-target-weth-ratio)
- [F3. Deposit Ratio Validation](#f3-deposit-ratio-validation)
- [F4. Rebalance Amounts](#f4-rebalance-amounts)

**Nhóm G — Cooldown & Fees**
- [G1. Exit Fee](#g1-exit-fee)
- [G2. Cooldown Unlock Time](#g2-cooldown-unlock-time)
- [G3. Proportional WETH Withdrawal](#g3-proportional-weth-withdrawal)

**Nhóm H — Strategy-Level**
- [H1. Strategy totalAssets (ERC-4626 underlying)](#h1-strategy-totalassets-erc-4626-underlying)
- [H2. Aave WETH Supply APR](#h2-aave-weth-supply-apr)
- [H3. Yield Oracle (sUSDe/sUSDai exchange rate)](#h3-yield-oracle-susdeusdai-exchange-rate)

---

# Nhóm A — Exchange Rate & ERC-4626

---

## A1. Share Price (Exchange Rate)

### Công thức

```
sharePrice = totalAssets / totalSupply
```

Trong đó:
- `totalAssets` = tổng giá trị tài sản thuộc tranche (từ Accounting)
- `totalSupply` = tổng số vault shares đã mint

### Tại sao có công thức này

Đây là cốt lõi của ERC-4626 vault standard. Share price cho biết 1 vault share đáng bao nhiêu base asset. Khi yield tích luỹ, `totalAssets` tăng nhưng `totalSupply` không đổi → `sharePrice` tăng → user nắm cùng số shares nhưng giá trị lớn hơn.

### Cơ sở

- **ERC-4626** (EIP-4626) — tiêu chuẩn Ethereum cho tokenized vaults. Mọi vault tuân thủ interface `totalAssets()`, `convertToShares()`, `convertToAssets()`.
- **Compound cToken model** — Compound Finance đã dùng mô hình exchange rate tăng dần từ 2019. ERC-4626 chuẩn hoá nó.
- Không cần claim yield — yield tự tích luỹ trong sharePrice.

### Đặc thù cho từng tranche

```
Senior:   totalAssets = Accounting.s_seniorTVL
Mezz:     totalAssets = Accounting.s_mezzTVL
Junior:   totalAssets = Accounting.s_juniorBaseTVL + Accounting.s_juniorWethTVL
```

Junior khác biệt vì totalAssets bao gồm cả WETH buffer value.

---

## A2. convertToShares (Deposit)

### Công thức

```
shares = assets × totalSupply / totalAssets

Trường hợp đặc biệt (vault trống):
  IF totalSupply == 0:
    shares = assets    (1:1 mint ban đầu)
```

### Tại sao có công thức này

Khi user deposit `assets`, cần tính xem mint bao nhiêu shares cho họ mà không làm loãng (dilute) người deposit trước. Công thức đảm bảo: sau deposit, sharePrice không đổi.

### Cơ sở

- **Pro-rata proportion** — đây là phép chia tỉ lệ cơ bản. User deposit X% tài sản → nhận X% shares.
- **Invariant:** `sharePrice_before == sharePrice_after` (deposit không thay đổi exchange rate).

### Chứng minh invariant

```
Trước deposit:
  sharePrice = totalAssets / totalSupply

Sau deposit (assets = a):
  newTotalAssets = totalAssets + a
  newShares = a × totalSupply / totalAssets
  newTotalSupply = totalSupply + newShares

  sharePrice_after = (totalAssets + a) / (totalSupply + a × totalSupply / totalAssets)
                   = (totalAssets + a) / (totalSupply × (totalAssets + a) / totalAssets)
                   = totalAssets / totalSupply
                   = sharePrice_before  ✓
```

---

## A3. convertToAssets (Withdraw)

### Công thức

```
assets = shares × totalAssets / totalSupply
```

### Tại sao có công thức này

Nghịch đảo của A2. Khi user redeem `shares`, tính ra bao nhiêu `assets` trả lại.

### Cơ sở

- Phép nghịch đảo trực tiếp: `shares = assets × totalSupply / totalAssets` ⟺ `assets = shares × totalAssets / totalSupply`
- **Invariant:** Withdraw cũng không thay đổi sharePrice cho những người còn lại.

---

## A4. SharesLock Claim Rate

### Công thức

```
// Tại thời điểm request (t0):
lockedShares = shares    // shares bị escrow, KHÔNG bị burn

// Tại thời điểm claim (t1, sau cooldown):
assets_out = lockedShares × totalAssets(t1) / totalSupply(t1)
```

### Tại sao có công thức này

SharesLock khác AssetsLock ở chỗ: exchange rate KHÔNG bị khoá tại thời điểm request. User tiếp tục hưởng yield trong thời gian chờ. Shares vẫn nằm trong totalSupply → TVL vẫn được tính → coverage không bị giảm.

### Cơ sở

- **Strata v1.1 SharesCooldown** — mô hình lock shares thay vì lock assets.
- **Lý do kinh tế:** Nếu lock assets khi coverage thấp, TVL giảm → coverage giảm tiếp → death spiral. Lock shares giữ TVL ổn định.
- User nhận `totalAssets(t1)` thay vì `totalAssets(t0)` → nếu yield dương trong cooldown, user được lợi.

---

# Nhóm B — TVL & Accounting

---

## B1. Junior TVL (Dual-Asset)

### Công thức

```
TVL_jr = TVL_jr_base + TVL_jr_weth

Trong đó:
  TVL_jr_base = phần base asset của Junior (từ gain splitting)
  TVL_jr_weth = WETH_balance × WETH_price_USD
```

### Tại sao có công thức này

Junior giữ 2 loại tài sản: base strategy asset (sUSDe/sUSDai) và WETH buffer (aWETH trên Aave). Cần cộng cả hai để có Junior's true NAV.

### Cơ sở

- **Multi-collateral vault** — tương tự MakerDAO vault chấp nhận nhiều loại collateral.
- WETH value phải quy đổi sang USD vì base asset đã denominate bằng USD. Dùng oracle TWAP để tránh manipulation.

---

## B2. Total Protocol TVL

### Công thức

```
TVL_total = TVL_sr + TVL_mz + TVL_jr_base + TVL_jr_weth + TVL_reserve

TVL_pool = TVL_sr + TVL_mz + TVL_jr   (không tính reserve)
         = TVL_sr + TVL_mz + TVL_jr_base + TVL_jr_weth
```

### Tại sao có công thức này

`TVL_total` = tổng tài sản protocol quản lý. `TVL_pool` = phần tài sản thuộc depositors (không tính reserve của protocol).

### Cơ sở

- **Accounting identity:** Tổng tài sản strategy + WETH phải luôn bằng tổng TVL các tranche + reserve. Đây là invariant được kiểm tra mỗi lần `updateTVL()`.

---

## B3. Coverage Ratio

### Công thức

```
coverage = TVL_pool / TVL_jr
         = (TVL_sr + TVL_mz + TVL_jr) / TVL_jr
```

### Tại sao có công thức này

Coverage đo "Junior bảo vệ được bao nhiêu". Coverage = 10× nghĩa là Junior's TVL bằng 1/10 tổng pool → nếu pool mất 10%, Junior mất 100%.

### Cơ sở

- **CDO tranche sizing** — tương tự tỉ lệ subordination trong CDO truyền thống (TradFi). Credit rating agencies dùng coverage ratio để đánh giá tranche safety.
- **Inverse relationship với risk:** Coverage cao → Junior chịu rủi ro lớn hơn (bảo vệ pool lớn hơn) → RP2 tăng (bù đắp).
- Dùng `TVL_jr` bao gồm WETH value — WETH làm tăng TVL_jr → coverage giảm → nhưng loss protection tốt hơn. Đây là trade-off có chủ đích.

---

## B4. WETH Value (USD)

### Công thức

```
TVL_jr_weth = aWETH_balance × WETH_price_TWAP

Trong đó:
  aWETH_balance = IERC20(aWETH).balanceOf(AaveWETHAdapter)
                  (tự tăng per block nhờ Aave supply yield)
  WETH_price_TWAP = 30-minute TWAP từ Chainlink ETH/USD feed
```

### Tại sao có công thức này

aWETH balance phản ánh cả principal + accrued Aave yield (Aave dùng rebasing token). Nhân với TWAP price → USD value.

### Cơ sở

- **aToken rebasing** — Aave v3 aTokens tự tăng balance mỗi block. Không cần harvest.
- **TWAP thay vì spot price** — Spot price có thể bị manipulate trong 1 block bằng flash loan. 30-min TWAP yêu cầu attacker duy trì manipulation qua nhiều block → chi phí kinh tế không khả thi.
- **Chainlink oracle** — Nguồn price data đáng tin cậy nhất on-chain. Được 80%+ DeFi protocols sử dụng.

---

# Nhóm C — Gain Splitting

---

## C1. Strategy Gain

### Công thức

```
strategyGain = currentStrategyTVL - prevStrategyTVL

Trong đó:
  currentStrategyTVL = StrategyRegistry.totalAssets()   (live, on-chain)
  prevStrategyTVL    = TVL_sr + TVL_mz + TVL_jr_base + TVL_reserve  (stored)
```

### Tại sao có công thức này

So sánh TVL hiện tại với lần update trước → biết được yield (hoặc loss) phát sinh trong khoảng thời gian đó.

### Cơ sở

- **Delta-based accounting** — thay vì track yield riêng, chỉ cần so sánh snapshot. Đơn giản, không cần keeper gọi `harvest()`.
- Chỉ tính strategy TVL (không tính WETH) vì WETH yield được capture riêng qua B4.

---

## C2. Reserve Cut

### Công thức

```
IF strategyGain > 0:
  reserveCut = strategyGain × reserveBps / 10_000
ELSE:
  reserveCut = 0
```

### Tại sao có công thức này

Protocol giữ lại một phần yield làm quỹ dự phòng (reserve). Chỉ cắt khi có lãi, không cắt khi lỗ.

### Cơ sở

- **Revenue model** — reserve là nguồn thu của protocol. Dùng cho: quỹ bảo hiểm, operational costs, governance incentives.
- **Basis points** — dùng bps (1 bps = 0.01%) thay vì % để chính xác hơn trong fixed-point arithmetic.
- **Strata pattern** — Strata cũng dùng `reserveBps` cắt gain trước khi chia cho tranches.

---

## C3. Senior Target Gain (Compound Index)

### Công thức

```
interestFactor = APR_sr × deltaT / (365 days × 1e18)

srtTargetIndex_new = srtTargetIndex × (1e18 + interestFactor) / 1e18

seniorGainTarget = TVL_sr × (srtTargetIndex_new / srtTargetIndex - 1)
```

Equivalent simplified:
```
seniorGainTarget = TVL_sr × APR_sr × deltaT / (365 days)
```

### Tại sao có công thức này

Senior được hứa một target APR. Công thức tính ra bao nhiêu USD Senior "nên nhận" trong khoảng thời gian deltaT.

### Cơ sở

- **Compound interest index** — Strata dùng `Target_Index` tích luỹ compound. Tránh rounding error khi tính nhiều lần liên tiếp.
- **Linear approximation cho short periods:** Vì `updateTVL()` được gọi thường xuyên (mỗi deposit/withdraw), `deltaT` thường nhỏ → `(1 + r×dt)` gần đúng với `e^(r×dt)`.
- **Tại sao dùng index thay vì tính trực tiếp:** Index tích luỹ qua nhiều kỳ mà không mất precision. Nếu tính `TVL_sr × APR × dt` mỗi lần rồi cộng dồn → rounding error tích luỹ.

### Chứng minh index equivalence

```
Kỳ 1: TVL_sr × (index_1 / index_0 - 1) = TVL_sr × r × dt_1
Kỳ 2: TVL_sr' × (index_2 / index_1 - 1) = TVL_sr' × r × dt_2

index_2 / index_0 = (index_1 / index_0) × (index_2 / index_1)
                   = (1 + r×dt_1) × (1 + r×dt_2)
                   ≈ 1 + r×(dt_1 + dt_2) + r²×dt_1×dt_2   (compound effect)

Nếu dùng phép cộng đơn giản: 1 + r×dt_1 + r×dt_2 (thiếu compound term)
→ Index chính xác hơn cho long-term accumulation.
```

---

## C4. Gain Distribution (3 Cases)

### Công thức

```
netGain = strategyGain - reserveCut

CASE A: netGain ≥ seniorGainTarget (bình thường)
  TVL_sr += seniorGainTarget
  TVL_jr_base += (netGain - seniorGainTarget)

CASE B: 0 ≤ netGain < seniorGainTarget (thiếu hụt)
  TVL_sr += netGain
  // Junior không nhận gì, subsidize shortfall

CASE C: netGain < 0 (lỗ)
  Chuyển sang D4 (Loss Waterfall)
```

### Tại sao có 3 cases

- **Case A:** Yield đủ → Senior lấy target, Junior lấy residual. Đây là trạng thái bình thường.
- **Case B:** Yield không đủ cho Senior target → Senior lấy hết, Junior chịu thiệt. Đây là cơ chế "Junior subsidizes Senior" — Junior bán bảo hiểm cho Senior.
- **Case C:** Strategy bị lỗ → waterfall.

### Cơ sở

- **Strata Gain Splitting** — copy trực tiếp từ Strata Accounting contract. Đây là mô hình CDO tiêu chuẩn trong structured finance.
- **TradFi CDO waterfall** — Senior tranche luôn được ưu tiên. Junior là "first loss" piece. Mô hình này đã tồn tại từ thập niên 1980 trong securitization.
- **Mezz implicit:** Trong V3, Mezzanine TVL được tính implicit: `TVL_mz = TVL_pool - TVL_sr - TVL_jr_base`. Thay đổi Mezz là consequence của Senior/Junior changes.

---

# Nhóm D — Loss Waterfall

---

## D1. Loss Detection

### Công thức

```
loss = |netGain|    when netGain < 0
     = prevStrategyTVL - currentStrategyTVL - reserveCut
```

### Tại sao có công thức này

Detect khi strategy báo cáo TVL thấp hơn lần update trước. Có thể do: de-peg, default, negative funding rate, exploit.

---

## D2. WETH Coverage Amount

### Công thức

```
wethCoverageUSD = MIN(loss, TVL_jr_weth)
wethToSell      = wethCoverageUSD / WETH_price_TWAP
actualWethSell  = MIN(wethToSell, aWETH_balance)
```

### Tại sao có công thức này

Bán đúng lượng WETH cần thiết để bù lỗ, không bán quá. Nếu WETH không đủ, bán hết rồi chuyển sang layer tiếp theo.

### Cơ sở

- **Minimum principle** — chỉ bán đúng lượng cần. Bảo toàn tối đa WETH buffer cho sự cố tiếp theo.
- Dùng TWAP price (không spot) để tránh bán quá nhiều nếu price đang bị manipulate thấp.

---

## D3. Swap Output with Slippage

### Công thức

```
expectedOutput = wethToSell × WETH_price
minOutput      = expectedOutput × (1 - maxSlippage)
actualOutput   = UniswapV3.swap(WETH → underlying, wethToSell, minOutput)

IF actualOutput < minOutput:
  REVERT (transaction thất bại, không có partial state)

slippageCost = expectedOutput - actualOutput
```

### Tại sao có công thức này

Swap trên DEX luôn có slippage (giá thực khác giá mong đợi). `minOutput` đảm bảo không bị sandwich attack lấy quá nhiều.

### Cơ sở

- **AMM slippage model** — Uniswap V3 concentrated liquidity. Slippage phụ thuộc vào swap size / pool depth.
- **1% standard / 10% emergency** — 1% là mức chấp nhận được cho swap bình thường. 10% chỉ dùng khi phải bán hết WETH (extreme stress), chấp nhận slippage cao hơn để đổi lấy tốc độ coverage.
- **MEV protection** — `minOutput` ngăn sandwich bot trích giá trị quá mức.

---

## D4. 4-Layer Waterfall

### Công thức

```
remaining = loss

// Layer 0: WETH buffer
wethAbsorbed = MIN(remaining, TVL_jr_weth)
TVL_jr_weth -= wethAbsorbed
remaining -= actualCovered    // actualCovered ≤ wethAbsorbed (do slippage)

// Layer 1: Junior base
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

### Tại sao có công thức này

Xác định rõ thứ tự ai chịu lỗ. Junior (với WETH buffer) chịu trước, Senior chịu sau cùng. Đây là lý do Senior yield thấp hơn — họ trả phí bảo hiểm qua RP2.

### Cơ sở

- **CDO subordination** — cấu trúc CDO truyền thống từ TradFi. AAA tranche (Senior) chỉ bị ảnh hưởng khi tất cả tranche dưới đã cháy.
- **MIN function** — mỗi layer chỉ chịu tối đa bằng TVL của nó. Không thể giảm TVL dưới 0.
- **WETH Layer 0 là đặc thù V3** — không có trong Strata hay CDO truyền thống. Đây là innovation của PrimeVaults: bán tài sản biến động (ETH) để bảo vệ tài sản ổn định (stablecoin pool).

---

# Nhóm E — APR Pipeline

---

## E1. Benchmark Rate (APR floor)

### Công thức

```
APR_benchmark = Σ(Supply_i × APY_i) / Σ Supply_i
                for i ∈ {USDC, USDT} trên Aave v3

= (Supply_USDC × APY_USDC + Supply_USDT × APY_USDT)
  / (Supply_USDC + Supply_USDT)
```

### Tại sao có công thức này

Benchmark là sàn APR cho Senior — Senior không bao giờ kiếm ít hơn mức này. Nếu strategy yield thấp, Senior vẫn nhận benchmark (Junior subsidize phần thiếu).

### Cơ sở

- **Risk-free rate concept** — trong TradFi, risk-free rate = yield trái phiếu chính phủ. Trong DeFi, không có risk-free thực sự, nhưng Aave stablecoin lending là mức gần nhất (blue-chip, battle-tested, lớn nhất).
- **Supply-weighted average** — cho weight theo pool size, tránh bị skew bởi pool nhỏ có APY bất thường.
- **Strata AprPairFeed** — Strata dùng cùng concept: `APR_benchmark` từ Aave làm floor.

---

## E2. Risk Premium 1 (RP1)

### Công thức

```
RP1 = x1 + y1 × (ratio_sr ^ k1)

Trong đó:
  ratio_sr = TVL_sr / (TVL_sr + TVL_jr)
  x1 = baseline premium (default 10%)
  y1 = max additional premium (default 12.5%)
  k1 = curvature exponent (default 0.3)
```

### Tại sao có công thức này

RP1 là "phí bảo hiểm" Senior trả cho Mezzanine. Khi Senior chiếm phần lớn pool, Mezz phải cover nhiều rủi ro hơn tương đối → RP1 tăng để bù đắp.

### Cơ sở

- **Power law pricing** — dạng `x + y × r^k`. Được chọn vì:
  - `x` đảm bảo luôn có baseline premium (Senior luôn trả ít nhất `x` cho Mezz)
  - `y × r^k` tăng theo ratio, nhưng tốc độ tăng phụ thuộc `k`
  - `k < 1` (concave): premium tăng nhanh ở ratio thấp, chậm lại ở ratio cao → khuyến khích cân bằng sớm
  - `k > 1` (convex): premium tăng chậm ở ratio thấp, tăng nhanh ở ratio cao → cho phép Senior dominate nhiều hơn trước khi penalty

- **Strata Risk Premium** — Strata dùng cùng dạng: `Risk_Premium = x + y × TVL_ratio_sr ^ k`

- **Tại sao không dùng linear (k=1)?** Linear không capture được hành vi phi tuyến của rủi ro. Rủi ro tăng nhanh hơn tuyến tính khi tranche ratio tiến về cực trị (0% hoặc 100%).

---

## E3. Risk Premium 2 (RP2)

### Công thức

```
RP2 = x2 + y2 × (coverage ^ k2)

Trong đó:
  coverage = TVL_pool / TVL_jr
  x2 = baseline (default 5%)
  y2 = max additional (default 10%)
  k2 = curvature (default 0.5)
```

### Tại sao có công thức này

RP2 là "phí bảo hiểm" toàn pool trả cho Junior. Coverage cao → Junior buffer mỏng so với pool → Junior rủi ro lớn hơn → RP2 tăng.

### Cơ sở

- Cùng dạng power law như RP1, nhưng biến số là `coverage` thay vì `ratio_sr`.
- **k2 = 0.5 (square root):** RP2 tăng theo √coverage. Được chọn vì: rủi ro tăng sublinearly theo coverage (doubling coverage không doubling risk, vì probability of total wipeout vẫn thấp).
- **Unbounded khi coverage → ∞:** Theo lý thuyết, nếu Junior chỉ còn $1 bảo vệ pool $1 tỷ, premium phải rất cao. Công thức cho phép RP2 tăng vô hạn (nhưng bị constraint bởi `x2 + y2 ≤ 50%` trong thực tế).

---

## E4. Alpha Split

### Công thức

```
Senior_RP2_cost = alpha × RP2    (default alpha = 60%)
Mezz_RP2_cost   = beta × RP2     (beta = 1 - alpha = 40%)
```

### Tại sao có công thức này

RP2 là tổng phí Junior nhận. Cần chia ai trả bao nhiêu. Senior trả nhiều hơn (60%) vì Senior được ưu tiên yield cao hơn và rủi ro thấp hơn.

### Cơ sở

- **Proportional to benefit** — Senior benefited nhất từ protection (được trả cuối cùng khi lỗ) → trả phần lớn hơn.
- **Alpha ∈ [40%, 80%]** — Governance có thể điều chỉnh nhưng trong range hợp lý. Alpha quá thấp → Senior được bảo hiểm rẻ quá → unfair cho Mezz. Alpha quá cao → Senior yield quá thấp.

---

## E5. Senior APR

### Công thức

```
APR_sr_v1 = APR_target       (governance-set target)
APR_sr_v2 = APR_base × (1 - RP1 - alpha × RP2)

APR_sr = MAX(APR_sr_v1, APR_sr_v2)
```

### Tại sao có 2 candidates rồi lấy MAX

- **v1 = APR_target:** Governance set một mức target. Nếu strategy yield cao, Senior có thể earn nhiều hơn target.
- **v2 = market-driven:** Từ strategy yield trừ đi các premiums. Khi yield cao, v2 > v1 → Senior hưởng thêm.
- **MAX đảm bảo:** Senior ít nhất nhận target, nhưng không bị cap nếu thị trường tốt.

### Cơ sở

- **Strata Senior APR:** Chính xác cùng formula — `APR_sr = MAX(APR_target, APR_base × (1 - Risk_Premium))`
- **Hybrid fixed/floating:** Tương tự trái phiếu fixed-to-floating trong TradFi. Fixed floor + floating upside.

### Constraint

```
RP1 + alpha × RP2 < 1
```
Nếu vi phạm → `(1 - RP1 - alpha × RP2)` âm → APR_sr_v2 âm → MAX chọn v1 (target). Senior không bao giờ có APR âm.

---

## E6. Mezzanine APR

### Công thức

```
APR_mz_gross = (APR_base - APR_sr) × (TVL_sr / TVL_mz) + APR_base

rp2_mz_cost  = beta × RP2 × APR_base × (TVL_sr / TVL_mz)

APR_mz = MAX(0, APR_mz_gross - rp2_mz_cost)
```

### Tại sao có công thức này

Mezz nhận "phần yield Senior bỏ lại", nhưng được nhân lên (leverage) theo tỉ lệ TVL.

### Cơ sở phần gross

```
Yield Senior không lấy = (APR_base - APR_sr) × TVL_sr
Yield này thuộc về Mezz + Junior.
Phần Mezz nhận = yield_bỏ_lại × (TVL_sr / TVL_mz) (leverage ratio)
                 + yield riêng của Mezz (APR_base)

Leverage giải thích:
  Senior = 70%, Mezz = 20%
  Leverage = 70/20 = 3.5×
  Nếu Senior bỏ lại 7% → Mezz nhận 7% × 3.5 = 24.5% thêm
```

### Tại sao trừ rp2_mz_cost

Mezz phải trả 40% (beta) của RP2 cho Junior. Cost này cũng được nhân leverage ratio.

### Cơ sở

- **Leveraged residual claim** — khái niệm từ TradFi structured finance. Mezz tranche tương tự equity tranche nhưng có senior protection phía trên.
- **MAX(0, ...)** — APR_mz không thể âm. Nếu chi phí > thu nhập, APR_mz = 0 (Mezz không nhận yield, nhưng cũng không mất vốn trừ khi có loss waterfall).

---

## E7. Junior APR (3 Streams)

### Công thức

```
Stream 1: yield_base = TVL_jr_base × APR_base
Stream 2: yield_weth = TVL_jr_weth × APR_aave_weth
Stream 3: yield_rp2  = (alpha × RP2 × APR_sr × TVL_sr)
                     + (beta × RP2 × APR_mz_gross × TVL_mz)

APR_jr = (yield_base + yield_weth + yield_rp2) / TVL_jr
```

### Tại sao có 3 streams

1. **Base yield:** Junior cũng có tiền trong strategy pool → nhận yield trên phần đó.
2. **WETH yield:** ETH buffer trong Aave kiếm thêm supply APR → thu nhập thụ động.
3. **RP2 premium:** Senior + Mezz trả phí bảo hiểm cho Junior → đây là nguồn thu lớn nhất.

### Cơ sở

- **V2 PrimeVaults DYSEngine** — V2 cũng có 3 streams (sUSDai yield + Aave ETH yield + RP2). V3 giữ nguyên concept, thay đổi naming.
- **Insurance premium model:** Junior = người bán bảo hiểm. Premium (RP2) = phí bảo hiểm. Claim event = loss waterfall. Đây là cơ chế bảo hiểm phi tập trung.

### Decomposition ví dụ

```
APR_jr = 28.69%

Từ base yield:  11.70%  (41% tổng)
Từ WETH yield:   0.55%  (2% tổng)
Từ RP2:         16.44%  (57% tổng)
                ───────
                28.69%

→ RP2 premium là nguồn thu chính của Junior (>50%)
→ WETH yield nhỏ nhưng quan trọng vì ETH chủ yếu đóng vai trò buffer
```

---

# Nhóm F — Dynamic WETH Ratio

---

## F1. Sigmoid Function

### Công thức

```
sigmoid(c, m, s) = 1 / (1 + (c / m) ^ s)

Trong đó:
  c = coverage ratio (input)
  m = midpoint (default 2.0)
  s = steepness (default 1.5)
```

### Tại sao chọn sigmoid

- **Bounded output [0, 1]** — output luôn nằm trong range hợp lý, dù coverage cực thấp hay cực cao.
- **Smooth S-curve** — chuyển tiếp mượt mà giữa "cần nhiều buffer" và "cần ít buffer". Không có bước nhảy đột ngột.
- **Midpoint control** — `m` xác định điểm mà output = 0.5 → ratio target = trung bình. Governance có thể tune.
- **Steepness control** — `s` xác định chuyển tiếp nhanh hay chậm. `s` lớn → gần step function. `s` nhỏ → chuyển tiếp chậm.

### Cơ sở

- **Logistic function** — dạng sigmoid phổ biến nhất trong toán học. Dùng trong: machine learning (activation function), population growth, dose-response curves.
- **Inverse power sigmoid** — dạng `1 / (1 + (x/m)^s)` thay vì `1 / (1 + e^(-x))` vì dễ control midpoint và steepness hơn, và không cần tính exponential (tốn gas).

---

## F2. Target WETH Ratio

### Công thức

```
ratio_weth_target = R_min + (R_max - R_min) × sigmoid(coverage, midpoint, steepness)
```

### Tại sao có công thức này

Map sigmoid output [0, 1] vào range [R_min, R_max]. Khi sigmoid ≈ 1 (low coverage) → target ≈ R_max. Khi sigmoid ≈ 0 (high coverage) → target ≈ R_min.

### Cơ sở

- **Affine transformation** — chuyển range [0,1] → [R_min, R_max]. Đảm bảo output luôn trong range hợp lệ.
- **R_min = 10%:** Luôn yêu cầu tối thiểu 10% ETH buffer, dù protocol rất khoẻ. Vì unexpected loss vẫn có thể xảy ra.
- **R_max = 35%:** Không yêu cầu quá 35% ETH vì: (a) giảm capital efficiency, (b) ETH là volatile → quá nhiều ETH tạo thêm risk thay vì giảm risk.

---

## F3. Deposit Ratio Validation

### Công thức

```
wethRatio = wethValueUSD / (baseValueUSD + wethValueUSD)
target = getTargetRatio()

isValid = |wethRatio - target| ≤ tolerance
```

### Tại sao có công thức này

Mỗi deposit Junior phải tuân thủ dynamic ratio. Nếu user gửi quá nhiều hoặc quá ít ETH → revert. Buộc mọi deposit đều đúng tỉ lệ protocol muốn.

### Cơ sở

- **Tolerance band ±3%** — cho phép sai lệch nhỏ vì: (a) ETH price thay đổi giữa lúc user xem UI và lúc tx confirm, (b) rounding errors, (c) UX — quá strict thì user khó deposit.

---

## F4. Rebalance Amounts

### Công thức

```
Ratio quá cao (quá nhiều WETH):
  excessUSD = TVL_jr_weth - (TVL_jr × target)
  wethToSell = excessUSD / WETH_price

Ratio quá thấp (quá ít WETH):
  deficitUSD = (TVL_jr × target) - TVL_jr_weth
  baseToRecall = deficitUSD
  wethToBuy = deficitUSD / WETH_price
```

### Tại sao có công thức này

Khi ETH price biến động, ratio drift khỏi target. Rebalance bán/mua ETH để quay về target. Chỉ trigger khi vượt tolerance.

### Cơ sở

- **Portfolio rebalancing** — concept từ TradFi portfolio management. Rebalance khi asset allocation drift quá threshold.
- **One-sided:** Chỉ cần 1 swap direction mỗi lần rebalance (sell WETH hoặc buy WETH), không cần đồng thời.

---

# Nhóm G — Cooldown & Fees

---

## G1. Exit Fee

### Công thức

```
feeAmount = baseAmount × feeBps / 10_000
netAmount = baseAmount - feeAmount

feeAmount → TVL_reserve (vào quỹ dự phòng)
```

### Tại sao có công thức này

Fee tỉ lệ thuận với số tiền rút. Fee cao hơn khi coverage thấp → discourage withdrawal khi protocol stressed.

### Cơ sở

- **Strata Coverage-Aware Redemption** — Strata dùng cùng concept: fee tăng khi coverage giảm.
- **Bank run prevention** — Nếu rút miễn phí khi coverage thấp → incentive rút sớm → coverage giảm thêm → death spiral. Fee tạo friction ngăn cascade.

---

## G2. Cooldown Unlock Time

### Công thức

```
unlockTime = requestTime + cooldownDuration

isClaimable = (block.timestamp ≥ unlockTime) AND (status == PENDING)

// Với claim window (optional):
isExpired = (expiryTime > 0) AND (block.timestamp > expiryTime)
expiryTime = unlockTime + claimWindowDuration
```

### Tại sao có công thức này

Đơn giản: chờ đủ thời gian → claim. Claim window tránh request bị "quên" vĩnh viễn.

---

## G3. Proportional WETH Withdrawal

### Công thức

```
userWETH = totalWETH × (userShares / totalJuniorShares)
```

### Tại sao có công thức này

Khi Junior user rút tiền, nhận lại phần WETH tỉ lệ với shares sở hữu. Đảm bảo fair — ai nắm 10% Junior shares → nhận 10% WETH buffer.

### Cơ sở

- **Pro-rata distribution** — phân chia tỉ lệ cơ bản. Giống dividend distribution trong cổ phiếu.
- WETH rút luôn instant (từ Aave), không qua cooldown. Vì WETH thuộc về Junior user, không ảnh hưởng strategy pool.

---

# Nhóm H — Strategy-Level

---

## H1. Strategy totalAssets (ERC-4626 underlying)

### Công thức

```
totalAssets = IERC4626(yieldToken).convertToAssets(totalShares)

Ví dụ (sUSDe):
  totalShares = 1,000,000 sUSDe shares held by strategy
  convertToAssets(1e18) = 1.05e18 (current exchange rate)
  totalAssets = 1,000,000 × 1.05 = 1,050,000 USDe
```

### Tại sao có công thức này

Strategy cần report "tôi đang giữ bao nhiêu tiền" cho Accounting. Vì strategy giữ yield-bearing token (sUSDe), cần convert qua exchange rate để có base asset value.

### Cơ sở

- **ERC-4626 convertToAssets()** — standard function trả về bao nhiêu underlying asset cho N shares. Exchange rate tự tăng khi yield tích luỹ.
- **No harvest needed** — exchange rate tăng per-block. `totalAssets()` chỉ cần call `convertToAssets()` — always live, zero gas cost (view function).

---

## H2. Aave WETH Supply APR

### Công thức

```
APR_aave_weth = currentLiquidityRate / 1e9

Trong đó:
  currentLiquidityRate = IPool(aavePool).getReserveData(WETH).currentLiquidityRate
  (đơn vị ray = 1e27, convert sang 1e18 bằng chia 1e9)
```

### Tại sao có công thức này

Đọc APR hiện tại của WETH supply trên Aave v3. Dùng để tính Junior's Stream 2 yield.

### Cơ sở

- **Aave v3 ReserveData** — Aave expose `currentLiquidityRate` on-chain, updated mỗi block. Đây là variable rate (thay đổi theo utilization).
- **Ray → 1e18:** Aave dùng đơn vị ray (27 decimals). Protocol dùng 18 decimals. Chia 1e9 để convert.

---

## H3. Yield Oracle (sUSDe/sUSDai exchange rate)

### Công thức

```
exchangeRate = IERC4626(yieldToken).convertToAssets(1e18)

Ví dụ:
  Day 0:   convertToAssets(1e18) = 1.000000e18  (1 sUSDe = 1.00 USDe)
  Day 30:  convertToAssets(1e18) = 1.008219e18  (1 sUSDe = 1.008219 USDe)
  Day 365: convertToAssets(1e18) = 1.100000e18  (10% APY)
```

### Tại sao có công thức này

Đây là cách yield "xuất hiện" trong hệ thống. Không ai gọi `harvest()` hay `distribute()`. Exchange rate tự tăng → `totalAssets()` tự tăng → sharePrice tự tăng.

### Cơ sở

- **ERC-4626 exchange rate model** — yield tích luỹ trong exchange rate, không phải balance. User giữ cùng số shares nhưng mỗi share đáng hơn theo thời gian.
- **Ethena sUSDe:** Exchange rate tăng khi funding rate dương + staking rewards.
- **USD.AI sUSDai:** Exchange rate tăng khi borrowers trả lãi cho AI infrastructure loans.

---

## Tổng kết: Map công thức → Contract

| Công thức | Contract | Function |
|-----------|----------|----------|
| A1-A3 | TrancheVault | `totalAssets()`, `convertToShares()`, `convertToAssets()` |
| A4 | SharesCooldown + TrancheVault | `claim()` + `_claimSharesCooldown()` |
| B1-B2 | Accounting | `getJuniorTVL()`, `getAllTVLs()` |
| B3 | RedemptionPolicy | `getCurrentCoverage()` |
| B4 | AaveWETHAdapter | `totalAssetsUSD()` |
| C1-C4 | Accounting | `updateTVL()` |
| D1-D4 | Accounting + PrimeCDO | `_handleLoss()` + `executeWETHCoverage()` |
| E1 | AaveAprProvider | `fetchApr()` |
| E2-E4 | Accounting (internal) | `_computeRiskPremiums()` |
| E5-E7 | Accounting / PrimeLens | `_computeSeniorAPR()`, `calcAllAPRs()` |
| F1-F2 | RatioController | `getTargetRatio()` |
| F3 | PrimeCDO | `depositJunior()` validation |
| F4 | PrimeCDO | `rebalanceJuniorRatio()` |
| G1 | PrimeCDO | `requestWithdraw()` |
| G2 | ERC20Cooldown / UnstakeCooldown | `request()`, `isClaimable()` |
| G3 | PrimeCDO | `withdrawJunior()` |
| H1 | BaseStrategy impl | `totalAssets()` |
| H2 | AaveWETHAdapter | `currentAPR()` |
| H3 | Strategy impl | `totalAssets()` (internal) |

---

*PrimeVaults V3 — Mathematical Reference v3.2.0*  
*March 2026*
