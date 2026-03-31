/**
 * Deposit USD.AI + WETH into Junior tranche (dual-asset).
 *
 * User inputs base USD.AI amount. Script auto-calculates WETH needed
 * using the on-chain target ratio and WETH price.
 *
 * Usage:
 *   ARB_RPC_URL=<url> PRIVATE_KEY=<key> npx tsx lib/scripts/deposit-junior-flow.ts --amount 100
 *   ARB_RPC_URL=<url> PRIVATE_KEY=<key> npx tsx lib/scripts/deposit-junior-flow.ts --amount 100 --dry-run
 */

import { parseUnits, formatUnits, formatEther, type Hash } from "viem";
import { createSDK, createWallet, waitForTx, parseFlag, hasFlag, USDAI, WETH } from "./config";

async function main() {
  const args = process.argv.slice(2);
  const amount = parseFlag(args, "--amount") ?? "1";
  const dryRun = hasFlag(args, "--dry-run");

  const { sdk, publicClient, addresses } = createSDK();
  const { account, walletClient } = createWallet();
  const user = account.address;
  const baseAmount = parseUnits(amount, 18);

  console.log(`\n  Junior Deposit Flow (dual-asset)`);
  console.log(`  User:    ${user}`);
  console.log(`  Base:    ${amount} USD.AI\n`);

  // 1. Estimate WETH needed
  const estimate = await sdk.estimateWETHAmount(baseAmount);
  console.log(`  WETH price:  $${formatUnits(estimate.wethPrice, 18)}`);
  console.log(`  Ratio:       ${sdk.formatRatio(estimate.targetRatio)}`);
  console.log(`  USD.AI:      ${formatUnits(baseAmount, 18)}`);
  console.log(`  WETH needed: ${formatUnits(estimate.wethAmount, 18)} ($${formatUnits(estimate.wethValueUSD, 18)})`);

  // 2. Check balances
  const [usdaiBalance, wethBalance] = await Promise.all([
    sdk.getTokenBalance(USDAI, user),
    sdk.getTokenBalance(WETH, user),
  ]);
  console.log(`\n  USD.AI balance: ${formatUnits(usdaiBalance, 18)}`);
  console.log(`  WETH balance:   ${formatUnits(wethBalance, 18)}`);

  if (usdaiBalance < baseAmount) throw new Error(`Insufficient USD.AI`);
  if (wethBalance < estimate.wethAmount) throw new Error(`Insufficient WETH`);

  if (dryRun) { console.log(`\n  Dry run — no tx sent.\n`); return; }

  // 3. Approve USD.AI
  const juniorVault = addresses.juniorVault;
  const usdaiAllowance = await sdk.getTokenAllowance(USDAI, user, juniorVault);
  if (usdaiAllowance < baseAmount) {
    console.log(`\n  Approving USD.AI...`);
    const r = await sdk.approveVaultDeposit(walletClient, "JUNIOR", USDAI, baseAmount);
    await waitForTx(publicClient, r.hash as Hash, "Approve USD.AI");
  }

  // 4. Approve WETH
  const wethAllowance = await sdk.getTokenAllowance(WETH, user, juniorVault);
  if (wethAllowance < estimate.wethAmount) {
    console.log(`  Approving WETH...`);
    const r = await sdk.approveToken(walletClient, WETH, juniorVault, estimate.wethAmount);
    await waitForTx(publicClient, r.hash as Hash, "Approve WETH");
  }

  // 5. Deposit
  const sharesBefore = await sdk.getShareBalance("JUNIOR", user);
  console.log(`  Depositing into Junior...`);
  const r = await sdk.depositJunior(walletClient, baseAmount, estimate.wethAmount, user);
  console.log(`  Gas: ${r.gasEstimate} | Fee: ~${formatEther(r.estimatedFeeWei)} ETH`);
  await waitForTx(publicClient, r.hash as Hash, "DepositJunior");

  // 6. Verify
  const sharesAfter = await sdk.getShareBalance("JUNIOR", user);
  console.log(`\n  Shares received: ${formatUnits(sharesAfter - sharesBefore, 18)}`);
  console.log(`  Done.\n`);
}

main().catch((err) => { console.error(`\n  Error: ${err.message}\n`); process.exitCode = 1; });
