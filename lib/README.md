# primevaults-sdk

TypeScript SDK for interacting with PrimeVaults V3 — a 3-tranche structured yield protocol on Arbitrum.

## Installation

```bash
npm install primevaults-sdk
# or
pnpm add primevaults-sdk
```

### Peer Dependency

The SDK requires `viem` >= 2.0.0:

```bash
pnpm add viem
```

## Build (from source)

```bash
cd lib
pnpm install
pnpm build       # Build CJS + ESM + types into dist/
pnpm dev         # Watch mode
pnpm typecheck   # TypeScript check
```

## Usage

### 1. Initialize the SDK

```ts
import { PrimeVaultsSDK } from "primevaults-sdk";

const sdk = new PrimeVaultsSDK({
  rpcUrl: "https://arb1.arbitrum.io/rpc",
  chainId: 42161,
  addresses: {
    primeCDO: "0x...",
    seniorVault: "0x...",
    mezzVault: "0x...",
    juniorVault: "0x...",
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
// mechanism: 0=NONE (instant), 1=ASSETS_LOCK, 2=SHARES_LOCK
console.log("Mechanism:", cond.mechanism);
console.log("Fee:", sdk.formatBps(cond.feeBps));
console.log("Cooldown:", Number(cond.cooldownDuration) / 3600, "hours");
```

#### Pending & Claimable Withdrawals

```ts
const pending = await sdk.getUserPendingWithdraws("0xUser");
const claimable = await sdk.getClaimableWithdraws("0xUser");
```

### 3. Estimate Helpers

#### Estimate WETH for Junior Deposit

```ts
const est = await sdk.estimateWETHAmount(sdk.parseAmount("1000"));
console.log("WETH needed:", sdk.formatAmount(est.wethAmount));
console.log("WETH price:", sdk.formatAmount(est.wethPrice));
```

#### Estimate Junior Withdraw

Junior withdrawals return both base assets (with fee) and proportional WETH:

```ts
const est = await sdk.estimateJuniorWithdraw(sdk.parseAmount("100"));
console.log("Base (gross):", sdk.formatAmount(est.baseAmount));
console.log("Fee:", sdk.formatAmount(est.feeAmount), `(${sdk.formatBps(est.feeBps)})`);
console.log("Base (net):", sdk.formatAmount(est.netBaseAmount));
console.log("WETH received:", sdk.formatAmount(est.wethAmount));
console.log("WETH value:", sdk.formatAmount(est.wethValueUSD));
// mechanism: 0=instant, 1=assets_lock, 2=shares_lock
console.log("Cooldown:", Number(est.cooldownDuration) / 3600, "hours");
```

### 4. Write Operations (requires WalletClient)

All write operations return `WriteResult` with gas estimation:

```ts
interface WriteResult {
  hash: string;           // Transaction hash
  gasEstimate: bigint;    // Gas units estimated
  gasPrice: bigint;       // Gas price (wei)
  estimatedFeeWei: bigint; // gasEstimate * gasPrice
}
```

#### Create a WalletClient

```ts
import { createWalletClient, custom, formatEther } from "viem";
import { arbitrum } from "viem/chains";

const walletClient = createWalletClient({
  chain: arbitrum,
  transport: custom(window.ethereum),
});
```

#### Approve + Deposit into Senior/Mezz

```ts
const amount = sdk.parseAmount("1000");

// Step 1: Approve
const approve = await sdk.approveVaultDeposit(walletClient, "SENIOR", tokenAddress, amount);
console.log("Approve fee:", formatEther(approve.estimatedFeeWei), "ETH");

// Step 2: Deposit
const deposit = await sdk.deposit(walletClient, "SENIOR", amount, receiverAddress);
console.log("Deposit fee:", formatEther(deposit.estimatedFeeWei), "ETH");
```

#### Junior Deposit (base + WETH)

```ts
const baseAmount = sdk.parseAmount("800");
const wethAmount = sdk.parseAmount("0.1");
const result = await sdk.depositJunior(walletClient, baseAmount, wethAmount, receiverAddress);
console.log("TX:", result.hash, "| Fee:", formatEther(result.estimatedFeeWei), "ETH");
```

#### Request Withdrawal

```ts
const shares = sdk.parseAmount("500");
const result = await sdk.requestWithdraw(walletClient, "MEZZ", shares, outputToken, receiver);
console.log("TX:", result.hash);
```

#### Claim After Cooldown

```ts
// For ERC20/Unstake cooldown
const claim = await sdk.claimWithdraw(walletClient, "MEZZ", cooldownId, cooldownHandler);

// For Shares cooldown
const claim = await sdk.claimSharesWithdraw(walletClient, "MEZZ", cooldownId, outputToken);
```

### 5. Per-Vault ERC4626 Read Functions

These read directly from each vault contract (no PrimeLens required):

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

### 6. Utility Methods

```ts
sdk.formatAmount(1000000000000000000n);     // "1.0"
sdk.parseAmount("1.0");                      // 1000000000000000000n
sdk.formatSharePrice(1050000000000000000n);  // "1.05"
sdk.formatBps(50n);                          // "0.5%"
sdk.formatRatio(200000000000000000n);        // "20.00%"
```

## Types

```ts
import type {
  PrimeVaultsConfig,       // SDK initialization config
  ContractAddresses,       // Contract addresses
  TrancheId,               // "SENIOR" | "MEZZ" | "JUNIOR"
  TrancheInfo,             // Tranche info (name, symbol, totalAssets, sharePrice, ...)
  JuniorPosition,          // Junior WETH position (baseTVL, wethTVL, currentRatio, ...)
  ProtocolHealth,          // Protocol health (TVL, coverage, paused, ...)
  PendingWithdraw,         // Pending withdrawal (requestId, amount, unlockTime, ...)
  WithdrawCondition,       // Withdrawal conditions (mechanism, feeBps, cooldownDuration, ...)
  RebalanceStatus,         // WETH rebalance status (currentRatio, needsSell/Buy, ...)
  CDOWithdrawResult,       // CDO withdrawal result (isInstant, cooldownId, feeAmount, ...)
  UserPortfolio,           // Aggregated user portfolio across all tranches
  WriteResult,             // Write operation result (hash, gasEstimate, gasPrice, estimatedFeeWei)
  EstimateJuniorWithdraw,  // Junior withdraw estimate (base, fee, WETH, mechanism, cooldown)
} from "primevaults-sdk";
```

## Scripts

Example scripts for testing on Arbitrum mainnet:

```bash
# Deposit into Senior/Mezz
ARB_RPC_URL=<url> PRIVATE_KEY=<key> npx tsx lib/scripts/deposit-flow.ts --tranche SENIOR --amount 10

# Junior dual-asset deposit (auto-calculates 80/20 split)
ARB_RPC_URL=<url> PRIVATE_KEY=<key> npx tsx lib/scripts/deposit-junior-flow.ts --amount 100

# Withdraw (request + claim)
ARB_RPC_URL=<url> PRIVATE_KEY=<key> npx tsx lib/scripts/withdraw-flow.ts --tranche SENIOR --shares 10

# Claim pending cooldown
ARB_RPC_URL=<url> PRIVATE_KEY=<key> npx tsx lib/scripts/withdraw-flow.ts --claim --cooldown-id 1 --handler 0x... --tranche SENIOR

# Dry run (preview only, no tx)
ARB_RPC_URL=<url> PRIVATE_KEY=<key> npx tsx lib/scripts/deposit-flow.ts --tranche SENIOR --amount 10 --dry-run
```

## Deployed Addresses (Arbitrum)

See `deploy/deployed.json` for the latest addresses.

## Requirements

- Node.js >= 18
- `viem` >= 2.0.0 (peer dependency)

## License

MIT
