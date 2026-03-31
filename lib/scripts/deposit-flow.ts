/**
 * Deposit USD.AI into Senior or Mezzanine tranche.
 *
 * Usage:
 *   ARB_RPC_URL=<url> PRIVATE_KEY=<key> npx tsx lib/scripts/deposit-flow.ts --tranche SENIOR --amount 100
 *   ARB_RPC_URL=<url> PRIVATE_KEY=<key> npx tsx lib/scripts/deposit-flow.ts --tranche MEZZ --amount 50 --dry-run
 */

import { parseUnits, formatUnits, formatEther, type Hash } from "viem";
import { createSDK, createWallet, waitForTx, parseFlag, hasFlag, USDAI } from "./config";
import type { TrancheId } from "../types";

async function main() {
  const args = process.argv.slice(2);
  const tranche = (parseFlag(args, "--tranche") ?? "SENIOR").toUpperCase() as TrancheId;
  const amount = parseFlag(args, "--amount") ?? "1";
  const dryRun = hasFlag(args, "--dry-run");

  if (!["SENIOR", "MEZZ"].includes(tranche)) {
    throw new Error(`Invalid tranche: ${tranche}. Use SENIOR or MEZZ (Junior uses deposit-junior-flow.ts)`);
  }

  const { sdk, publicClient } = createSDK();
  const { account, walletClient } = createWallet();
  const user = account.address;
  const depositAmount = parseUnits(amount, 18);

  console.log(`\n  Deposit Flow — ${tranche}`);
  console.log(`  User:    ${user}`);
  console.log(`  Amount:  ${amount} USD.AI\n`);

  // 1. Check balance
  const balance = await sdk.getTokenBalance(USDAI, user);
  console.log(`  USD.AI balance: ${formatUnits(balance, 18)}`);
  if (balance < depositAmount) throw new Error(`Insufficient USD.AI`);

  // 2. Preview
  const previewShares = await sdk.previewDeposit(tranche, depositAmount);
  console.log(`  Preview shares:  ${formatUnits(previewShares, 18)}`);

  // 3. Protocol health
  const health = await sdk.getProtocolHealth();
  console.log(`  Coverage Sr: ${sdk.formatRatio(health.coverageSenior)} | Mz: ${sdk.formatRatio(health.coverageMezz)}`);
  if (health.shortfallPaused) throw new Error("Protocol is shortfall paused");

  if (dryRun) { console.log(`\n  Dry run — no tx sent.\n`); return; }

  // 4. Approve if needed
  const vaultAddr = sdk["_vaultAddress"](tranche);
  const allowance = await sdk.getTokenAllowance(USDAI, user, vaultAddr);
  if (allowance < depositAmount) {
    console.log(`\n  Approving USD.AI...`);
    const r = await sdk.approveVaultDeposit(walletClient, tranche, USDAI, depositAmount);
    await waitForTx(publicClient, r.hash as Hash, "Approve");
  }

  // 5. Deposit
  const sharesBefore = await sdk.getShareBalance(tranche, user);
  console.log(`  Depositing ${amount} USD.AI into ${tranche}...`);
  const r = await sdk.deposit(walletClient, tranche, depositAmount, user);
  console.log(`  Gas: ${r.gasEstimate} | Fee: ~${formatEther(r.estimatedFeeWei)} ETH`);
  await waitForTx(publicClient, r.hash as Hash, "Deposit");

  // 6. Verify
  const sharesAfter = await sdk.getShareBalance(tranche, user);
  console.log(`\n  Shares received: ${formatUnits(sharesAfter - sharesBefore, 18)}`);
  console.log(`  Done.\n`);
}

main().catch((err) => { console.error(`\n  Error: ${err.message}\n`); process.exitCode = 1; });
