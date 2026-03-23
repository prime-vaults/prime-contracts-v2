# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

PrimeVaults V3 is a **3-tranche structured yield protocol** for Ethereum mainnet built with Solidity. Each yield source (sUSDe, sUSDai, etc.) deploys as a separate independent market: 1 CDO = 1 Strategy (Strata Protocol design).

**Tranche hierarchy:** Senior (lowest risk) → Mezzanine → Junior (highest risk, loss absorber)

**Status:** Specification-complete, implementation follows the 32-step roadmap in `docs/PV_V3_MVP_PLAN.md`.

## Build & Test Commands

```bash
# Install dependencies
pnpm install

# Compile contracts
npx hardhat compile

# Run all tests
npx hardhat test

# Run a single test file
npx hardhat test test/unit/Accounting.test.ts

# Gas reporting
REPORT_GAS=true npx hardhat test

# Coverage
npx hardhat coverage
```

```bash
# Mainnet fork for integration tests (uncomment forking in hardhat.config.ts)
MAINNET_RPC_URL=<your-url> npx hardhat test test/integration/
```

**Stack:** Hardhat + TypeScript, Solidity ^0.8.24 (optimizer: 200 runs), ethers v6 + Viem for tests. Package manager: **pnpm**.

**Key dependencies:** `@openzeppelin/contracts@5.1.0`, `@prb/math`, `@chainlink/contracts`, `@aave/v3-core`.

## Architecture

```
Market (e.g. "Ethena"):
  Senior Vault ──┐
  Mezz Vault    ──┼──► PrimeCDO ──► BaseStrategy/SUSDeStrategy ──► yield source
  Junior Vault  ──┘
                    ├─► Accounting (TVL tracking, gain splitting, loss waterfall)
                    ├─► AaveWETHAdapter (Junior WETH buffer yield via Aave)
                    ├─► WETHPriceOracle (30-min TWAP from Chainlink)
                    ├─► SwapFacility (WETH ↔ base asset swaps)
                    └─► Cooldown handlers (ERC20Cooldown, UnstakeCooldown, SharesCooldown)
```

### Contract Directory Layout

```
contracts/
├── interfaces/          # All I-prefixed interfaces (IStrategy, IPrimeCDO, IAccounting, etc.)
├── core/                # Accounting, PrimeCDO, TrancheVault
├── junior/              # AaveWETHAdapter, Junior WETH buffer logic
├── cooldown/            # ERC20Cooldown, UnstakeCooldown, SharesCooldown handlers
├── strategies/          # BaseStrategy + implementations/ (SUSDeStrategy, etc.)
│   └── implementations/cooldown/
├── oracles/             # WETHPriceOracle + providers/
├── governance/          # Access control, parameter management
└── periphery/           # SwapFacility, helper contracts
```

- **PrimeCDO** — Core orchestrator. Handles deposit routing, withdrawal with coverage gates, WETH management, loss coverage, and rebalancing. Asymmetric rebalance: permissionless WETH sell, governance-only buy.
- **Accounting** — Tracks per-tranche TVL. Splits gains (Senior gets target APR, Junior gets residual). Loss waterfall: WETH cover → Junior → Mezzanine → Senior.
- **TrancheVault** — ERC4626 wrapper per tranche. Delegates all logic to PrimeCDO.
- **Coverage Gate** — Blocks Senior/Mezz deposits when coverage < 105%. Blocks Junior withdrawals when coverage < 105%. Auto-pauses all actions if Junior exchange rate drops below 90%.
- **Senior APR** — Computed from two risk premium curves (RP1 for tranche structure, RP2 for pool coverage) with a governance floor (APR_target).
- **Junior** — Dual-asset (base + WETH). Fixed 8:2 WETH ratio with pre-wired upgrade hook.

## Specification Documents

Read these **before writing any code:**

| File                           | When to read                                                                      |
| ------------------------------ | --------------------------------------------------------------------------------- |
| `docs/PV_V3_FINAL_v34.md`      | Full 36-section spec. Read the relevant section before implementing any contract. |
| `docs/PV_V3_MATH_REFERENCE.md` | Formula reference. Reference in `@dev` comments (e.g., "See MATH_REFERENCE §E5"). |
| `docs/PV_V3_COVERAGE_GATE.md`  | Coverage gate blocking logic. Essential for PrimeCDO deposit/withdraw.            |
| `docs/PV_V3_MVP_PLAN.md`       | 32-step implementation roadmap with code templates and dependency order.          |
| `docs/CONVENTIONS.md`          | Coding standards (naming, formatting, NatSpec). Follow strictly.                  |
| `docs/PROMTS.md`               | Pre-written prompts (PROMPT 0-18) for each implementation phase.                  |

## Coding Conventions (Summary)

Full details in `docs/CONVENTIONS.md`. Key rules:

**Naming:**

- Immutables: `i_camelCase` (e.g., `i_primeCDO`)
- Storage: `s_camelCase` (e.g., `s_seniorTVL`)
- Constants: `UPPER_SNAKE_CASE` (e.g., `MAX_BPS`, `PRECISION`)
- Internal/private functions: `_prefixed` (e.g., `_computeSeniorAPR()`)
- Interfaces: `I` prefix (e.g., `IStrategy`)
- Errors: `PrimeVaults__ErrorName(params)` — no `require("string")`

**Formatting:**

- 120-char line width, horizontal priority (don't break lines early)
- Section separators: `// ═══════════════════` for major contract sections
- Numeric literals: use underscores (`10_000`, `0.60e18`)
- Custom errors only, inline when short: `if (amount == 0) revert PrimeVaults__ZeroAmount();`

**NatSpec:** Every external/public function must have `@notice`, `@dev`, `@param`, `@return`. Internal functions: `@dev` only.

**File header:** SPDX-MIT, `pragma solidity ^0.8.24;`, banner with contract name and spec section reference.

**Import order:** OpenZeppelin → external libs → internal interfaces → internal contracts.

**Tests:** Hardhat + TypeScript. Pattern: `"should [behavior] when [condition]"`. Use specific matchers (`revertedWithCustomError`, `emit().withArgs()`). Split large contracts into multiple test files (e.g., `PrimeCDO.deposit.test.ts`).

**Git commits:** `feat(accounting): implement gain splitting algorithm`, `fix(coverage-gate): handle zero junior TVL edge case`, `test(primecdo): add deposit coverage gate tests`.

## Implementation Status

The project is specification-complete but in early implementation. The 32-step roadmap in `docs/PV_V3_MVP_PLAN.md` defines the build order with dependency chains across 12 phases. **Always check the plan before starting a new contract** — earlier steps produce interfaces and types that later steps depend on.

MVP scope: 1 market (Ethena sUSDe), fixed 8:2 WETH ratio, coverage gates enabled.
