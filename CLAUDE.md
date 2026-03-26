# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

PrimeVaults V3 is a **3-tranche structured yield protocol** built with Solidity. Each yield source deploys as a separate independent market: 1 CDO = 1 Strategy (Strata Protocol design).

**Tranche hierarchy:** Senior (lowest risk) → Mezzanine → Junior (highest risk, loss absorber)

**MVP scope:** 1 market (sUSDai/USD.AI on Arbitrum), fixed 8:2 WETH ratio, coverage gates enabled.

**Status:** Specification-complete, implementation follows the 32-step roadmap in `docs/PV_V3_MVP_PLAN.md`.

## Build & Test Commands

```bash
pnpm install                                    # Install dependencies
npx hardhat compile                             # Compile (generates typechain-types/)
npx hardhat test                                # Run all tests
npx hardhat test test/unit/Accounting.test.ts   # Run a single test file
REPORT_GAS=true npx hardhat test                # Gas reporting
npx hardhat coverage                            # Coverage
```

Mainnet fork for integration tests (uncomment `forking` in `hardhat.config.ts`):
```bash
MAINNET_RPC_URL=<your-url> npx hardhat test test/integration/
```

**Stack:** Hardhat + TypeScript, Solidity ^0.8.24 (optimizer: 200 runs), ethers v6 + Viem for tests. Package manager: **pnpm**.

**Key dependencies:** `@openzeppelin/contracts@5.1.0`, `@prb/math`, `@chainlink/contracts`.

**Typechain:** `typechain-types/` is auto-generated on compile. Do not hand-edit these files — they regenerate from contract ABIs.

**Prettier:** 120-char lines, double quotes, trailing commas. Solidity overrides: 4-space tabs. See `.prettierrc`.

## Architecture

```
Market (e.g. "sUSDai"):
  Senior Vault ──┐
  Mezz Vault    ──┼──► PrimeCDO ──► BaseStrategy/SUSDaiStrategy ──► yield source
  Junior Vault  ──┘
                    ├─► Accounting (TVL tracking, gain splitting, loss waterfall)
                    ├─► AaveWETHAdapter (Junior WETH buffer yield via Aave)
                    ├─► WETHPriceOracle (30-min TWAP from Chainlink)
                    ├─► SwapFacility (WETH ↔ base asset swaps)
                    └─► Cooldown system (ERC20Cooldown, UnstakeCooldown, SharesCooldown, RedemptionPolicy)
```

### Key Contracts

- **PrimeCDO** — Core orchestrator. Deposit routing, withdrawal with coverage gates, WETH management, loss coverage, rebalancing. Asymmetric rebalance: permissionless WETH sell, governance-only buy.
- **Accounting** — Per-tranche TVL tracking. Gain splitting (Senior gets target APR, Junior gets residual). Loss waterfall: WETH cover → Junior → Mezzanine → Senior.
- **TrancheVault** — ERC4626 wrapper per tranche. Delegates all logic to PrimeCDO.
- **Coverage Gate** — Blocks Senior/Mezz deposits when coverage < 105%. Blocks Junior withdrawals when coverage < 105%. Auto-pauses all actions if Junior exchange rate drops below 90%.
- **RedemptionPolicy** — Determines cooldown type (instant, ERC20 lock, unstake, shares lock) per tranche based on withdrawal amount and liquidity.

### Contract Directory Layout

```
contracts/
├── interfaces/          # All I-prefixed interfaces
├── core/                # Accounting, PrimeCDO (TrancheVault not yet implemented)
├── libraries/           # FixedPointMath
├── junior/              # AaveWETHAdapter, WETHPriceOracle, SwapFacility
├── cooldown/            # ERC20Cooldown, UnstakeCooldown, SharesCooldown, RedemptionPolicy
├── strategies/          # BaseStrategy + implementations/ (SUSDaiStrategy)
│   └── implementations/cooldown/  # SUSDaiCooldownRequestImpl
├── oracles/             # AprPairFeed + providers/ (SUSDaiAprPairProvider)
├── governance/          # RiskParams
└── test/mocks/          # Mock contracts for testing
```

## Specification Documents

Read these **before writing any code:**

| File                           | When to read                                                                      |
| ------------------------------ | --------------------------------------------------------------------------------- |
| `docs/PV_V3_FINAL_v34.md`      | Full 36-section spec. Read the relevant section before implementing any contract. |
| `docs/PV_V3_MATH_REFERENCE.md` | Formula reference. Reference in `@dev` comments (e.g., "See MATH_REFERENCE §E5"). |
| `docs/PV_V3_COVERAGE_GATE.md`  | Coverage gate blocking logic. Essential for PrimeCDO deposit/withdraw.            |
| `docs/PV_V3_MVP_PLAN.md`       | 32-step implementation roadmap with dependency order across 12 phases.            |
| `docs/CONVENTIONS.md`          | Coding standards (naming, formatting, NatSpec). Follow strictly.                  |
| `docs/PROMTS.md`               | Pre-written prompts (PROMPT 0-18) for each implementation phase.                  |

## Coding Conventions (Summary)

Full details in `docs/CONVENTIONS.md`. Key rules:

- **Naming:** `i_camelCase` immutables, `s_camelCase` storage, `UPPER_SNAKE_CASE` constants, `_prefixed` internal functions, `I` prefix interfaces
- **Errors:** `PrimeVaults__ErrorName(params)` custom errors only — no `require("string")`
- **Formatting:** 120-char line width, horizontal priority (don't break lines early), `// ═══════════════════` section separators, underscored numeric literals (`10_000`, `0.60e18`)
- **NatSpec:** `@notice` + `@dev` + `@param` + `@return` on every external/public function. Internal: `@dev` only.
- **File header:** SPDX-MIT, `pragma solidity ^0.8.24;`, banner with contract name and spec section reference.
- **Import order:** OpenZeppelin → external libs → internal interfaces → internal contracts.
- **Tests:** Pattern: `"should [behavior] when [condition]"`. Use `revertedWithCustomError`, `emit().withArgs()`. Split large contracts: `PrimeCDO.deposit.test.ts`, `PrimeCDO.withdraw.test.ts`.
- **Git commits:** `feat(accounting): implement gain splitting algorithm`, `fix(coverage-gate): handle zero junior TVL edge case`.

## Implementation Status

The project is specification-complete but in active implementation. The 32-step roadmap in `docs/PV_V3_MVP_PLAN.md` defines the build order with dependency chains across 12 phases. **Always check the plan before starting a new contract** — earlier steps produce interfaces and types that later steps depend on.
