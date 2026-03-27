# primevaults-sdk

TypeScript SDK for interacting with PrimeVaults V3 — a 3-tranche structured yield protocol on Arbitrum.

## Directory Structure

```
lib/
├── PrimeVaultsSDK.ts   # Main class with all SDK logic
├── types.ts            # Type definitions (interfaces, types)
├── index.ts            # Export entry point
├── abis/               # Smart contract ABIs (PrimeLens, TrancheVault, ERC20)
├── dist/               # Build output (tsup)
├── tsup.config.ts      # Build config
├── tsconfig.json       # TypeScript config
└── package.json        # Dependencies and scripts
```

## Installation

```bash
# From the project root
cd lib
pnpm install
```

### Peer Dependency

The SDK requires `viem` >= 2.0.0. Your frontend must have viem installed:

```bash
pnpm add viem
```

## Build

```bash
cd lib
pnpm build       # Build CJS + ESM + types into dist/
pnpm dev         # Watch mode (auto-rebuild on changes)
pnpm typecheck   # TypeScript check (no emit)
```

Output after build:
- `dist/index.js` — CommonJS
- `dist/index.mjs` — ESM
- `dist/index.d.ts` — Type declarations

## Usage

### 1. Initialize the SDK

```ts
import { PrimeVaultsSDK } from "primevaults-sdk";

const sdk = new PrimeVaultsSDK({
  rpcUrl: "https://arb1.arbitrum.io/rpc",
  chainId: 42161,
  addresses: {
    primeCDO: "0x1869F39e4E4EA85776C0fe446ac03a2D6C86F543",
    seniorVault: "0xE77ec530D2e550049df9347E05612c58fc4C12A7",
    mezzVault: "0x71a4E7559eBF87611efB183a71EdA3Df77F0f766",
    juniorVault: "0x323eB19E3a34096947247fd97d3F5a7F098a0d8C",
    primeLens: "0x...", // required for aggregated view functions
  },
});
```

**Note:** The 4 required addresses are `primeCDO`, `seniorVault`, `mezzVault`, `juniorVault`. All others (`primeLens`, `accounting`, `strategy`, ...) are optional — see `types.ts > ContractAddresses` for the full list.

### 2. Read Operations

#### Protocol Health

```ts
const health = await sdk.getProtocolHealth();
console.log("Total TVL:", sdk.formatAmount(health.totalTVL));
console.log("Senior Coverage:", sdk.formatRatio(health.coverageSenior));
console.log("Paused:", health.shortfallPaused);
```

#### All Tranches

```ts
const { senior, mezz, junior } = await sdk.getAllTranches();
console.log("Senior share price:", sdk.formatSharePrice(senior.sharePrice));
console.log("Junior total assets:", sdk.formatAmount(junior.totalAssets));
```

#### Single Tranche Info

```ts
const info = await sdk.getTrancheInfo("SENIOR");
// TrancheId: "SENIOR" | "MEZZ" | "JUNIOR"
```

#### Junior WETH Position

```ts
const pos = await sdk.getJuniorPosition();
console.log("WETH ratio:", sdk.formatRatio(pos.currentRatio));
console.log("WETH amount:", sdk.formatAmount(pos.wethAmount));
console.log("Aave APR:", sdk.formatRatio(pos.aaveAPR));
```

#### User Portfolio

```ts
const portfolio = await sdk.getUserPortfolio("0xUserAddress");
console.log("Senior:", sdk.formatAmount(portfolio.senior.assets));
console.log("Mezz:", sdk.formatAmount(portfolio.mezz.assets));
console.log("Junior:", sdk.formatAmount(portfolio.junior.assets));
console.log("Total:", sdk.formatAmount(portfolio.totalAssetsUSD));
```

#### WETH Rebalance Status

```ts
const status = await sdk.getWETHRebalanceStatus();
console.log("Needs sell:", status.needsSell);
console.log("Needs buy:", status.needsBuy);
console.log("Excess/Deficit:", sdk.formatAmount(status.excessOrDeficitUSD));
```

#### Withdraw Conditions

```ts
const cond = await sdk.previewWithdrawCondition("SENIOR");
// mechanism: 0=instant, 1=ERC20 lock, 2=unstake, 3=shares lock
console.log("Mechanism:", cond.mechanism);
console.log("Fee:", sdk.formatBps(cond.feeBps));
```

#### Pending & Claimable Withdrawals

```ts
const pending = await sdk.getUserPendingWithdraws("0xUser");
const claimable = await sdk.getClaimableWithdraws("0xUser");
```

### 3. Write Operations (requires WalletClient)

Write operations require a [viem WalletClient](https://viem.sh/docs/clients/wallet.html).

#### Create a WalletClient

```ts
import { createWalletClient, custom } from "viem";
import { arbitrum } from "viem/chains";

const walletClient = createWalletClient({
  chain: arbitrum,
  transport: custom(window.ethereum),
});
```

#### Approve + Deposit into Senior/Mezz

```ts
const amount = sdk.parseAmount("1000"); // 1000 tokens (18 decimals)

// Step 1: Approve vault to spend tokens
await sdk.approveVaultDeposit(walletClient, "SENIOR", tokenAddress, amount);

// Step 2: Deposit
await sdk.deposit(walletClient, "SENIOR", amount, receiverAddress);
```

#### Junior Deposit (base + WETH)

Junior requires both base asset and WETH:

```ts
const baseAmount = sdk.parseAmount("800");
const wethAmount = sdk.parseAmount("0.1");
await sdk.depositJunior(walletClient, baseAmount, wethAmount, receiverAddress);
```

#### Request Withdrawal

```ts
const shares = sdk.parseAmount("500");
const txHash = await sdk.requestWithdraw(walletClient, "MEZZ", shares, outputToken, receiver);
```

#### Claim After Cooldown

```ts
// For ERC20/Unstake cooldown
await sdk.claimWithdraw(walletClient, "MEZZ", cooldownId, cooldownHandler);

// For Shares cooldown
await sdk.claimSharesWithdraw(walletClient, "MEZZ", cooldownId, outputToken);
```

### 4. Utility Methods

```ts
sdk.formatAmount(1000000000000000000n);     // "1.0"        — bigint -> readable string
sdk.parseAmount("1.0");                      // 1000000000000000000n — string -> bigint
sdk.formatSharePrice(1050000000000000000n);  // "1.05"       — share price display
sdk.formatBps(50n);                          // "0.5%"       — basis points -> percentage
sdk.formatRatio(200000000000000000n);        // "20.00%"     — 18-decimal ratio -> percentage
```

### 5. Per-Vault ERC4626 Read Functions

These functions read directly from each vault contract (no PrimeLens required):

| Function                           | Description                              |
| ---------------------------------- | ---------------------------------------- |
| `getShareBalance(tranche, user)`   | User's share balance in the vault        |
| `convertToAssets(tranche, shares)` | Convert shares to underlying assets      |
| `convertToShares(tranche, assets)` | Convert assets to shares                 |
| `previewDeposit(tranche, assets)`  | Estimate shares received on deposit      |
| `previewRedeem(tranche, shares)`   | Estimate assets received on redeem       |
| `getTotalAssets(tranche)`          | Total assets held by the vault           |
| `getTotalSupply(tranche)`          | Total share supply                       |
| `getVaultDecimals(tranche)`        | Vault decimals                           |
| `getVaultAsset(tranche)`           | Underlying asset address                 |

### 6. ERC20 Helper Functions

```ts
const balance = await sdk.getTokenBalance(tokenAddress, userAddress);
const allowance = await sdk.getTokenAllowance(tokenAddress, owner, spender);
```

## Types

All types are exported from the package:

```ts
import type {
  PrimeVaultsConfig,   // SDK initialization config
  ContractAddresses,   // Contract addresses
  TrancheId,           // "SENIOR" | "MEZZ" | "JUNIOR"
  TrancheInfo,         // Tranche info (name, symbol, totalAssets, sharePrice, ...)
  JuniorPosition,      // Junior WETH position (baseTVL, wethTVL, currentRatio, ...)
  ProtocolHealth,      // Protocol health (TVL, coverage, paused, ...)
  PendingWithdraw,     // Pending withdrawal (requestId, amount, unlockTime, ...)
  WithdrawCondition,   // Withdrawal conditions (mechanism, feeBps, cooldownDuration, ...)
  RebalanceStatus,     // WETH rebalance status (currentRatio, needsSell/Buy, ...)
  CDOWithdrawResult,   // CDO withdrawal result (isInstant, cooldownId, feeAmount, ...)
  UserPortfolio,       // Aggregated user portfolio across all tranches
} from "primevaults-sdk";
```

## Deployed Addresses (Arbitrum)

```json
{
  "primeCDO": "0x1869F39e4E4EA85776C0fe446ac03a2D6C86F543",
  "seniorVault": "0xE77ec530D2e550049df9347E05612c58fc4C12A7",
  "mezzVault": "0x71a4E7559eBF87611efB183a71EdA3Df77F0f766",
  "juniorVault": "0x323eB19E3a34096947247fd97d3F5a7F098a0d8C",
  "accounting": "0x7591134ba592961103c1E1dc7C4Ae2Fc0A6Fb2Fc",
  "strategy": "0x3e56c74B30433E9afe65E96744439Ca080A078E1",
  "aaveAdapter": "0x81b38dd6DCe97Fc4edA1e8f43455611151a4e494",
  "swapFacility": "0x174eb7789A87d72d1a812799195A9491bCd8B17c",
  "wethPriceOracle": "0x7dBDc6d655125bad5fDaa540B3AbFF0a83bB02DF",
  "redemptionPolicy": "0xb1DF2940530F827923eA15913D5f03FDECd99596",
  "aprFeed": "0xb65b26678089488eE6159D9C5774ba4A7CfE8C9Ff9D"
}
```

See full list at `deploy/deployed.json`.

## Requirements

- Node.js >= 18
- `viem` >= 2.0.0 (peer dependency)

## License

MIT
