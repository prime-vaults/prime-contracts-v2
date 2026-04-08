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

import { parseUnits, formatUnits, type Hash } from "viem";
import { createSDK, createWallet, waitForTx, parseFlag, hasFlag, USDAI, WETH } from "./config";
import { TRANCHE_VAULT_ABI, ERC20_ABI } from "../abis";
import { TrancheId } from "../types";

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
  const estimate = await sdk.getWethNeeded(baseAmount);
  console.log(`  WETH price:  $${formatUnits(estimate.wethPrice, 18)}`);
  console.log(`  Ratio:       ${(Number(estimate.ratioTarget) / 1e16).toFixed(2)}%`);
  console.log(`  USD.AI:      ${formatUnits(baseAmount, 18)}`);
  console.log(`  WETH needed: ${formatUnits(estimate.wethNeeded, 18)} ($${formatUnits(estimate.wethValueUSD, 18)})`);

  // 2. Preview Junior deposit
  const preview = await sdk.previewJuniorDeposit(baseAmount, estimate.wethNeeded);
  console.log(`  Preview shares: ${formatUnits(preview.shares, 18)}`);
  console.log(`  WETH ratio:     ${(Number(preview.wethRatio) / 1e16).toFixed(2)}%`);

  // 3. Check balances
  const [usdaiBalance, wethBalance] = await Promise.all([
    sdk.getTokenBalance(USDAI, user),
    sdk.getTokenBalance(WETH, user),
  ]);
  console.log(`\n  USD.AI balance: ${formatUnits(usdaiBalance, 18)}`);
  console.log(`  WETH balance:   ${formatUnits(wethBalance, 18)}`);

  if (usdaiBalance < baseAmount) throw new Error(`Insufficient USD.AI`);
  if (wethBalance < estimate.wethNeeded) throw new Error(`Insufficient WETH`);

  if (dryRun) {
    console.log(`\n  Dry run — no tx sent.\n`);
    return;
  }

  const juniorVault = addresses.juniorVault as `0x${string}`;

  // 4. Approve USD.AI
  const usdaiAllowance = await sdk.getTokenAllowance(USDAI, user, juniorVault);
  if (usdaiAllowance < baseAmount) {
    console.log(`\n  Approving USD.AI...`);
    const hash = await walletClient.writeContract({
      address: USDAI as `0x${string}`,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [juniorVault, baseAmount],
      chain: walletClient.chain,
      account,
    });
    await waitForTx(publicClient, hash as Hash, "Approve USD.AI");
  }

  // 5. Approve WETH
  const wethAllowance = await sdk.getTokenAllowance(WETH, user, juniorVault);
  if (wethAllowance < estimate.wethNeeded) {
    console.log(`  Approving WETH...`);
    const hash = await walletClient.writeContract({
      address: WETH as `0x${string}`,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [juniorVault, estimate.wethNeeded],
      chain: walletClient.chain,
      account,
    });
    await waitForTx(publicClient, hash as Hash, "Approve WETH");
  }

  // 6. Deposit
  const sharesBefore = await sdk.getShareBalance(TrancheId.JUNIOR, user);
  console.log(`  Depositing into Junior...`);
  // Simulate first to get clear revert reason
  try {
    await publicClient.simulateContract({
      address: juniorVault,
      abi: TRANCHE_VAULT_ABI,
      functionName: "depositJunior",
      args: [baseAmount, estimate.wethNeeded, user],
      account: account.address,
    });
  } catch (err: any) {
    console.error(`\n  Simulation failed:`);
    console.error(`  ${err.shortMessage ?? err.message}\n`);
    throw err;
  }

  const hash = await walletClient.writeContract({
    address: juniorVault,
    abi: TRANCHE_VAULT_ABI,
    functionName: "depositJunior",
    args: [baseAmount, estimate.wethNeeded, user],
    chain: walletClient.chain,
    account,
  });
  await waitForTx(publicClient, hash as Hash, "DepositJunior");

  // 7. Verify
  const sharesAfter = await sdk.getShareBalance(TrancheId.JUNIOR, user);
  console.log(`\n  Shares received: ${formatUnits(sharesAfter - sharesBefore, 18)}`);
  console.log(`  Done.\n`);
}

main().catch((err) => {
  console.error(`\n  Error: ${err.message}\n`);
  process.exitCode = 1;
});
