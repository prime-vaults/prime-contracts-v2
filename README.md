# PrimeVaults V2

## What is PrimeVaults?

PrimeVaults V2 is a **3-tranche structured yield protocol** on Arbitrum. It takes a single yield source (e.g. sUSDai from USD.AI) and splits its risk/reward into three tiers -- Senior, Mezzanine, and Junior -- so that depositors can choose the exact risk profile they want.

### The Problem

DeFi yield is binary: you either take all the risk of a yield source, or you don't participate. There's no way for conservative capital (treasuries, institutions) to earn yield with strong loss protection, while letting risk-tolerant capital earn amplified returns by absorbing that risk.

### The Solution

PrimeVaults solves this by structuring yield into tranches (inspired by traditional finance CDOs):

| Tranche       | Risk    | Yield                                     | Loss Absorption                 | Who Is It For?                                     |
| ------------- | ------- | ----------------------------------------- | ------------------------------- | -------------------------------------------------- |
| **Senior**    | Lowest  | Guaranteed floor APR (benchmark rate)     | Last to lose (4th layer)        | Conservative capital, treasuries, institutions     |
| **Mezzanine** | Medium  | Leveraged residual yield (~2-3x base APR) | 3rd layer                       | Yield seekers wanting moderate risk                |
| **Junior**    | Highest | 3 yield streams + risk premiums           | First to lose (1st + 2nd layer) | Risk-tolerant capital, protocol-aligned depositors |

**Key insight:** Junior depositors provide a WETH buffer (20% of their deposit) that acts as first-loss insurance. In exchange, they earn risk premiums paid by Senior and Mezzanine, plus Aave yield on the WETH buffer, plus base strategy yield.

### How It Works (Simple Example)

```
Yield source: sUSDai generating 11% APR
Total pool: $10M ($7M Senior + $2M Mezz + $1M Junior)

Senior earns:  ~6.2% APR (guaranteed floor, protected by $3M subordination)
Mezz earns:    ~22.1% APR (leveraged from Senior's yield transfer)
Junior earns:  ~25.4% APR (3 streams: base yield + WETH yield + risk premiums)

If sUSDai loses $500K:
  Layer 0: WETH buffer sells $220K of ETH to cover losses
  Layer 1: Junior base absorbs remaining $280K
  Layer 2-3: Mezz and Senior are completely unaffected
```

---

## Architecture

### Market Isolation (1 CDO = 1 Strategy)

Each yield source deploys as a completely independent **market**. Markets share NO state, NO capital, NO risk. One exploit in a sUSDe market cannot affect the sUSDai market.

```
Market "USD.AI" (sUSDai):
  Senior Vault  --+
  Mezz Vault    --+--> PrimeCDO --> SUSDaiStrategy --> sUSDai vault
  Junior Vault  --+       |
                          +--> AaveWETHAdapter --> Aave v3 (WETH buffer)
                          +--> Accounting (TVL math, gain splitting, loss waterfall)
                          +--> RedemptionPolicy (coverage-aware cooldowns)
                          +--> SwapFacility (WETH <-> base asset via Uniswap V3)
                          +--> WETHPriceOracle (30-min TWAP from Chainlink)
```

### Core Contracts -- What Each One Does

#### PrimeCDO -- The Orchestrator

**Problem it solves:** Someone needs to coordinate deposits across 3 tranches, enforce coverage gates, manage the WETH buffer, trigger loss coverage, and handle rebalancing -- all atomically and securely.

PrimeCDO is the central coordinator for a single market. It:

- Routes deposits to the strategy (Senior/Mezz) or strategy + Aave (Junior dual-asset)
- Enforces **coverage gates**: blocks Senior/Mezz deposits if coverage drops below 105% (insufficient Junior subordination)
- Manages the **WETH ratio** (fixed 80/20 base/WETH for Junior), with asymmetric rebalancing -- permissionless sell when ETH rises, governance-only buy when ETH drops
- Triggers the **4-layer loss waterfall** when the strategy loses money
- Auto-pauses all actions if Junior share price drops below 90% (shortfall protection)
- Routes withdrawals through the RedemptionPolicy for coverage-aware cooldowns

#### Accounting -- The Math Engine

**Problem it solves:** With 3 tranches sharing one yield source, how do you fairly split gains while ensuring losses hit the right people first?

Accounting tracks per-tranche TVL (including dual-asset Junior: base + WETH) and implements:

- **Gain splitting:** Senior gets a guaranteed target APR (from APR oracle). Junior base gets the residual. Mezzanine gets leveraged yield from the spread.
- **Loss waterfall (4 layers):** WETH buffer (Layer 0) -> Junior base (Layer 1) -> Mezzanine (Layer 2) -> Senior (Layer 3). Senior only loses if everything else is wiped out.
- **Risk premium curves (RP1, RP2):** Mathematical functions that auto-price the cost of protection. As more Senior capital enters, RP1 rises (Senior pays more to Mezz). As coverage drops, RP2 rises (pool pays more to Junior).

#### TrancheVault -- The User-Facing Token

**Problem it solves:** Users need a standard ERC-4626 vault token that represents their position in a specific tranche, while all the complex logic lives in PrimeCDO.

TrancheVault is deployed 3 times per market (pvSENIOR, pvMEZZ, pvJUNIOR) with identical bytecode. It:

- Wraps ERC-4626 (deposit/mint/convertToAssets) but delegates all logic to PrimeCDO
- Disables standard `withdraw`/`redeem` -- users must call `requestWithdraw` to enter the cooldown flow
- Junior mode: `depositJunior` accepts both base asset + WETH in 80/20 ratio

#### RedemptionPolicy -- Coverage-Aware Cooldowns

**Problem it solves:** During stress (low coverage), allowing instant withdrawals from riskier tranches would drain the protocol. But hard-blocking withdrawals is bad UX. How to balance?

RedemptionPolicy uses a **mechanism escalation** approach based on real-time coverage ratios:

- **Senior:** Always instant (best UX for safest tranche)
- **Mezzanine:** Instant (cs > 160%) -> AssetsLock cooldown (cs > 140%) -> SharesLock (cs <= 140%)
- **Junior:** Requires BOTH cs AND cm above thresholds. Most restrictive when coverage is stressed.

Three cooldown mechanisms:

- **NONE:** Instant withdrawal
- **ASSETS_LOCK (ERC20Cooldown):** Assets locked for a period, no yield during lock
- **SHARES_LOCK (SharesCooldown):** Shares locked but continue earning yield (important: shares may appreciate during lock)

#### AaveWETHAdapter -- The WETH Buffer

**Problem it solves:** Junior deposits 20% in WETH as first-loss insurance, but idle WETH earns nothing. How to make it productive while keeping it available for loss coverage?

AaveWETHAdapter deposits the WETH into Aave v3 to earn supply yield (~2-3% APR). When losses occur, it withdraws from Aave, swaps WETH to base asset via SwapFacility, and injects the proceeds back into the strategy -- all atomically in one transaction.

#### SwapFacility -- WETH <-> Base Asset Swaps

**Problem it solves:** The protocol needs to swap WETH to base asset (for loss coverage and rebalancing) and base asset to WETH (for rebalancing). These swaps need slippage protection and oracle-based pricing.

SwapFacility wraps Uniswap V3 swaps with Chainlink oracle price checks for MEV protection.

#### WETHPriceOracle -- ETH Price Feed

**Problem it solves:** The protocol needs a manipulation-resistant ETH/USD price for WETH ratio calculations and swap pricing.

Uses Chainlink with a 30-minute TWAP to resist short-term price manipulation.

#### BaseStrategy / SUSDaiStrategy -- Yield Source Adapter

**Problem it solves:** Different yield sources (sUSDe, sUSDai) have different interfaces, cooldown mechanisms, and token flows. The CDO needs a uniform interface.

BaseStrategy provides a standard interface (`deposit`, `withdraw`, `totalAssets`) that concrete implementations adapt to specific yield sources. SUSDaiStrategy connects to the sUSDai ERC-7540 vault on Arbitrum.

#### AprPairFeed / SUSDaiAprPairProvider -- APR Oracle

**Problem it solves:** The gain splitting algorithm needs to know the Senior target APR and the base strategy APR. These rates change over time and must come from a reliable source.

AprPairFeed provides two rates: the benchmark APR (from Aave weighted average) as Senior's floor, and the strategy's current APR for gain calculations.

#### RiskParams -- Premium Curve Configuration

**Problem it solves:** The risk premium curves (RP1, RP2) that price the cost of loss protection need tunable parameters, with safety bounds to prevent misconfiguration.

Stores curve parameters (x, y, k for each curve) with governance-enforced constraints (e.g., RP1 + alpha \* RP2 < 100%).

### Self-Balancing Economics

The protocol is designed to self-balance without governance intervention:

```
Coverage stressed (few Junior depositors relative to Senior/Mezz):
  -> Senior/Mezz deposits BLOCKED (coverage gate)
  -> Junior APR rises (RP2 curve) -> attracts Junior capital
  -> Junior withdrawals get SHARES_LOCK (expensive to exit) -> Junior stays
  -> Coverage recovers naturally

ETH price drops (WETH ratio too low):
  -> New Junior deposits bring fresh 20% WETH -> buffer rebuilds passively
  -> Governance can trigger rebalanceBuyWETH if needed

ETH price rises (WETH ratio too high):
  -> Anyone can call rebalanceSellWETH (permissionless) -> sells excess WETH gains
```

---

## Withdraw Flow

All tranches receive sUSDai (the underlying yield token) from strategy withdrawals. Full withdrawal is a 3-step process:

```
Step 1: TrancheVault.requestWithdraw(shares, receiver)
        -> PrimeCDO evaluates RedemptionPolicy -> routes to cooldown mechanism
        -> Strategy always returns sUSDai instantly
        -> Junior: proportional WETH also sent instantly from Aave

Step 2: User calls sUSDai.requestRedeem(shares) -> enters sUSDai ERC-7540 FIFO queue
        -> Wait for sUSDai cooldown (admin calls serviceRedemptions)

Step 3: User calls sUSDai.redeem(shares, receiver) -> receives USD.AI
```

---

## Contract Directory Layout

```
contracts/
  interfaces/          # All I-prefixed interfaces (IStrategy, IPrimeCDO, ICooldownHandler, etc.)
  core/                # Accounting, PrimeCDO, TrancheVault
  libraries/           # FixedPointMath (18-decimal arithmetic)
  junior/              # AaveWETHAdapter, WETHPriceOracle, SwapFacility
  cooldown/            # ERC20Cooldown, UnstakeCooldown, SharesCooldown, RedemptionPolicy
  strategies/          # BaseStrategy + implementations/ (SUSDaiStrategy)
    implementations/cooldown/  # SUSDaiCooldownRequestImpl
  oracles/             # AprPairFeed + providers/ (SUSDaiAprPairProvider)
  periphery/           # PrimeLens (read-only aggregator for frontend)
  governance/          # RiskParams (premium curve parameters)
  test/mocks/          # Mock contracts for testing
```

---

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) (v18+)
- [pnpm](https://pnpm.io/) (v10+)

### Install

```bash
pnpm install
```

### Compile

```bash
npx hardhat compile
```

### Test

```bash
npx hardhat test                                # Run all tests
npx hardhat test test/unit/Accounting.test.ts   # Run a single test file
REPORT_GAS=true npx hardhat test                # With gas reporting
npx hardhat coverage                            # Coverage report
```

### Integration Tests (Arbitrum Fork)

```bash
ARB_RPC_URL=<url> npx hardhat test test/integration/
```

---

## SDK

A TypeScript SDK in `lib/` wraps all contract interactions for frontend and scripting.

```bash
cd lib && pnpm install
pnpm build       # Build CJS + ESM + types
pnpm dev         # Watch mode
pnpm typecheck   # TypeScript check
```

### SDK Scripts

```bash
ARB_RPC_URL=<url> PRIVATE_KEY=<key> npx tsx lib/scripts/deposit-flow.ts --tranche SENIOR --amount 100
ARB_RPC_URL=<url> PRIVATE_KEY=<key> npx tsx lib/scripts/deposit-junior-flow.ts --base-amount 100
ARB_RPC_URL=<url> PRIVATE_KEY=<key> npx tsx lib/scripts/withdraw-flow.ts --tranche JUNIOR --shares 0.125
```

---

## Deployment

Deployed to **Arbitrum mainnet** (chain ID 42161). Key external contracts:

- **USD.AI** (base asset): `0x0A1a1A107E45b7Ced86833863f482BC5f4ed82EF`
- **sUSDai** (ERC-7540 vault): `0x0B2b2B2076d95dda7817e785989fE353fe955ef9`

Deploy scripts in `deploy/` run sequentially:

1. `01_deploy_shared.ts` -- Shared infra (RiskParams, WETHPriceOracle, SwapFacility, cooldown handlers)
2. `02_deploy_usdai_market.ts` -- Market contracts (Accounting, Strategy, PrimeCDO, 3x TrancheVault)
3. `03_configure.ts` -- Register tranches, wire CDO, authorize cooldowns
4. `04_deploy_prime_lens.ts` -- PrimeLens (read-only aggregator)
5. `05_redeploy_redemption_policy.ts` -- Redeploy when immutable refs change

Deployed addresses: `deploy/deployed.json`

---

## Stack

- **Solidity** ^0.8.24 (optimizer: 200 runs)
- **Hardhat** + TypeScript
- **ethers** v6 + **Viem** for tests
- **OpenZeppelin** Contracts 5.1.0
- **PRBMath** for fixed-point arithmetic
- **Chainlink** price feeds
- Package manager: **pnpm**

## Documentation

| File                           | Description                                          |
| ------------------------------ | ---------------------------------------------------- |
| `docs/PV_V3_FINAL_v34.md`      | Full 36-section technical specification              |
| `docs/PV_V3_MATH_REFERENCE.md` | Formula reference for all mathematical models        |
| `docs/PV_V3_COVERAGE_GATE.md`  | Coverage gate blocking and cooldown escalation logic |
| `docs/PV_V3_MVP_PLAN.md`       | 32-step implementation roadmap                       |
| `docs/CONVENTIONS.md`          | Coding standards and naming conventions              |

## License

MIT
