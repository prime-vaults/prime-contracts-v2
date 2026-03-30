/**
 * SDK Write Script — Junior dual-asset deposit (USD.AI + WETH).
 *
 * User inputs total USD amount. Script auto-calculates the 80/20 split
 * using the current WETH price from the on-chain oracle.
 *
 * Flow: Fetch WETH price → Calculate split → Check balances → Approve → Deposit → Verify
 *
 * Usage:
 *   ARB_RPC_URL=<url> PRIVATE_KEY=<key> npx tsx lib/scripts/deposit-junior-flow.ts \
 *     --amount 1000
 *
 * Options:
 *   --amount   Total deposit in USD  (default: 100)
 *   --dry-run  Preview only
 */

import { createWalletClient, createPublicClient, http, parseUnits, formatUnits, type Hash, formatEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrum } from "viem/chains";
import { PrimeVaultsSDK } from "../PrimeVaultsSDK";
import "dotenv/config";

// ═══════════════════════════════════════════════════════════════════
//  Config
// ═══════════════════════════════════════════════════════════════════

const DEPLOYED = {
  primeCDO: "0x0Db6Fb3C4719428Ac279355542c93fD215a634Df",
  seniorVault: "0xC5A4bf12AD29B58F5b7C106f3eA6F076B06AcCcC",
  mezzVault: "0x203164a5f3FA822bDF1b146Fa60190AA73c345D7",
  juniorVault: "0x4A3AEC901f035Bc8EEd904A0630D89B6D1f82D39",
  primeLens: "0x69eB815242e6206219679643dDf99849cF32Aa31",
};

const USDAI = "0x0A1a1A107E45b7Ced86833863f482BC5f4ed82EF";
const WETH = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1";

// ═══════════════════════════════════════════════════════════════════
//  Parse args
// ═══════════════════════════════════════════════════════════════════
//npx tsx lib/scripts/deposit-junior-flow.ts --dry-run
function parseArgs() {
  const args = process.argv.slice(2);
  let amount = "0.1";
  let dryRun = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--amount" && args[i + 1]) amount = args[++i];
    if (args[i] === "--dry-run") dryRun = true;
  }

  return { amount, dryRun };
}

// ═══════════════════════════════════════════════════════════════════
//  Helpers
// ═══════════════════════════════════════════════════════════════════

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env: ${name}`);
  return value;
}

async function waitForTx(publicClient: any, hash: Hash, label: string) {
  console.log(`  ⏳ ${label}: ${hash}`);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status === "reverted") throw new Error(`${label} reverted!`);
  console.log(`  ✓  ${label} confirmed (block ${receipt.blockNumber})`);
  return receipt;
}

// ═══════════════════════════════════════════════════════════════════
//  Main
// ═══════════════════════════════════════════════════════════════════

async function main() {
  const { amount, dryRun } = parseArgs();
  const rpcUrl = requireEnv("ARB_RPC_URL");
  const privateKey = requireEnv("PRIVATE_KEY");

  const account = privateKeyToAccount(privateKey as `0x${string}`);
  const publicClient = createPublicClient({ chain: arbitrum, transport: http(rpcUrl) });
  const walletClient = createWalletClient({ account, chain: arbitrum, transport: http(rpcUrl) });

  const sdk = new PrimeVaultsSDK({
    rpcUrl,
    chainId: 42161,
    addresses: DEPLOYED,
  });

  const user = account.address;
  const totalUSD = parseUnits(amount, 18);

  console.log(`\n══════════════════════════════════════════════════`);
  console.log(`  Junior Deposit Flow (dual-asset)`);
  console.log(`══════════════════════════════════════════════════`);
  console.log(`  User:      ${user}`);
  console.log(`  Total:     ${amount} USD`);
  console.log(`  Dry run:   ${dryRun}\n`);

  // ─────────────────────────────────────────────────────────────────
  //  1. Estimate WETH amount from on-chain ratio & price
  // ─────────────────────────────────────────────────────────────────

  const baseAmount = totalUSD;
  const estimate = await sdk.estimateWETHAmount(baseAmount);
  const { wethAmount, wethPrice, targetRatio, wethValueUSD } = estimate;

  console.log(`  WETH price:     $${formatUnits(wethPrice, 18)}`);
  console.log(`  Target ratio:   ${sdk.formatRatio(targetRatio)}`);
  console.log(`  Split:`);
  console.log(`    USD.AI (base): ${formatUnits(baseAmount, 18)}`);
  console.log(`    WETH:          ${formatUnits(wethAmount, 18)} ($${formatUnits(wethValueUSD, 18)})`);

  // ─────────────────────────────────────────────────────────────────
  //  2. Check balances
  // ─────────────────────────────────────────────────────────────────

  const usdaiBalance = await sdk.getTokenBalance(USDAI, user);
  const wethBalance = await sdk.getTokenBalance(WETH, user);
  console.log(`\n  Balances:`);
  console.log(`    USD.AI:  ${formatUnits(usdaiBalance, 18)}`);
  console.log(`    WETH:    ${formatUnits(wethBalance, 18)}`);

  if (usdaiBalance < baseAmount) {
    throw new Error(`Insufficient USD.AI: have ${formatUnits(usdaiBalance, 18)}, need ${formatUnits(baseAmount, 18)}`);
  }
  if (wethBalance < wethAmount) {
    throw new Error(`Insufficient WETH: have ${formatUnits(wethBalance, 18)}, need ${formatUnits(wethAmount, 18)}`);
  }

  // ─────────────────────────────────────────────────────────────────
  //  3. Check shares before
  // ─────────────────────────────────────────────────────────────────

  const sharesBefore = await sdk.getShareBalance("JUNIOR", user);
  console.log(`\n  Junior shares before: ${formatUnits(sharesBefore, 18)}`);

  if (dryRun) {
    console.log(`\n  Dry run — no transactions sent.\n`);
    return;
  }

  // ─────────────────────────────────────────────────────────────────
  //  5. Approve USD.AI (if needed)
  // ─────────────────────────────────────────────────────────────────

  const usdaiAllowance = await sdk.getTokenAllowance(USDAI, user, DEPLOYED.juniorVault);
  if (usdaiAllowance < baseAmount) {
    console.log(`\n  Approving ${formatUnits(baseAmount, 18)} USD.AI for Junior vault...`);
    const approveUsdai = await sdk.approveVaultDeposit(walletClient, "JUNIOR", USDAI, baseAmount);
    console.log(`  Gas: ${approveUsdai.gasEstimate} units | Fee: ~${formatEther(approveUsdai.estimatedFeeWei)} ETH`);
    await waitForTx(publicClient, approveUsdai.hash as Hash, "Approve USD.AI");
  }

  // ─────────────────────────────────────────────────────────────────
  //  6. Approve WETH (if needed)
  // ─────────────────────────────────────────────────────────────────

  const wethAllowance = await sdk.getTokenAllowance(WETH, user, DEPLOYED.juniorVault);
  if (wethAllowance < wethAmount) {
    console.log(`  Approving ${formatUnits(wethAmount, 18)} WETH for Junior vault...`);
    const approveWeth = await sdk.approveToken(walletClient, WETH, DEPLOYED.juniorVault, wethAmount);
    console.log(`  Gas: ${approveWeth.gasEstimate} units | Fee: ~${formatEther(approveWeth.estimatedFeeWei)} ETH`);
    await waitForTx(publicClient, approveWeth.hash as Hash, "Approve WETH");
  }

  // ─────────────────────────────────────────────────────────────────
  //  7. Deposit Junior
  // ─────────────────────────────────────────────────────────────────

  console.log(
    `  Depositing ${formatUnits(baseAmount, 18)} USD.AI + ${formatUnits(wethAmount, 18)} WETH into Junior...`,
  );
  const depositResult = await sdk.depositJunior(walletClient, baseAmount, wethAmount, user);
  console.log(`  Gas: ${depositResult.gasEstimate} units | Fee: ~${formatEther(depositResult.estimatedFeeWei)} ETH`);
  await waitForTx(publicClient, depositResult.hash as Hash, "DepositJunior");

  // ─────────────────────────────────────────────────────────────────
  //  8. Verify
  // ─────────────────────────────────────────────────────────────────

  const sharesAfter = await sdk.getShareBalance("JUNIOR", user);
  const sharesReceived = sharesAfter - sharesBefore;

  console.log(`\n  Junior shares after:    ${formatUnits(sharesAfter, 18)}`);
  console.log(`  Junior shares received: ${formatUnits(sharesReceived, 18)}`);

  const portfolio = await sdk.getUserPortfolio(user);
  console.log(`\n  Portfolio total: $${formatUnits(portfolio.totalAssetsUSD, 18)}`);
  console.log(`\n  ✓ Junior deposit complete!\n`);
}

main().catch((err) => {
  console.error(`\n  ✗ Error: ${err.message}\n`);
  process.exitCode = 1;
});
