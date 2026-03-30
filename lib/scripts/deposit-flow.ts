/**
 * SDK Write Script — Full deposit flow on Arbitrum production.
 *
 * Flow: Check balance → Approve → Deposit → Verify shares
 *
 * Usage:
 *   ARB_RPC_URL=<url> PRIVATE_KEY=<key> npx tsx lib/scripts/deposit-flow.ts \
 *     --tranche SENIOR --amount 10
 *
 * Options:
 *   --tranche  SENIOR | MEZZ | JUNIOR  (default: SENIOR)
 *   --amount   Amount in USD.AI tokens  (default: 1)
 *   --dry-run  Preview only, no tx sent (default: false)
 */

import {
  createWalletClient,
  createPublicClient,
  http,
  parseUnits,
  formatUnits,
  type Hash,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrum } from "viem/chains";
import { PrimeVaultsSDK } from "../PrimeVaultsSDK";
import type { TrancheId } from "../types";

// ═══════════════════════════════════════════════════════════════════
//  Config
// ═══════════════════════════════════════════════════════════════════

const DEPLOYED = {
  primeCDO: "0x1869F39e4E4EA85776C0fe446ac03a2D6C86F543",
  seniorVault: "0xE77ec530D2e550049df9347E05612c58fc4C12A7",
  mezzVault: "0x71a4E7559eBF87611efB183a71EdA3Df77F0f766",
  juniorVault: "0x323eB19E3a34096947247fd97d3F5a7F098a0d8C",
  primeLens: "0xAfb731AD79374C3273514e9F86D39AD0D551A280",
};

const USDAI = "0x0A1a1A107E45b7Ced86833863f482BC5f4ed82EF";
const WETH = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1";

// ═══════════════════════════════════════════════════════════════════
//  Parse args
// ═══════════════════════════════════════════════════════════════════

function parseArgs() {
  const args = process.argv.slice(2);
  let tranche: TrancheId = "SENIOR";
  let amount = "1";
  let dryRun = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--tranche" && args[i + 1]) tranche = args[++i].toUpperCase() as TrancheId;
    if (args[i] === "--amount" && args[i + 1]) amount = args[++i];
    if (args[i] === "--dry-run") dryRun = true;
  }

  if (!["SENIOR", "MEZZ", "JUNIOR"].includes(tranche)) {
    throw new Error(`Invalid tranche: ${tranche}. Must be SENIOR, MEZZ, or JUNIOR`);
  }

  return { tranche, amount, dryRun };
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
  const { tranche, amount, dryRun } = parseArgs();
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

  const depositAmount = parseUnits(amount, 18);
  const user = account.address;

  console.log(`\n══════════════════════════════════════════════════`);
  console.log(`  Deposit Flow — ${tranche}`);
  console.log(`══════════════════════════════════════════════════`);
  console.log(`  User:    ${user}`);
  console.log(`  Tranche: ${tranche}`);
  console.log(`  Amount:  ${amount} USD.AI (${depositAmount})`);
  console.log(`  Dry run: ${dryRun}\n`);

  // ─────────────────────────────────────────────────────────────────
  //  1. Check USD.AI balance
  // ─────────────────────────────────────────────────────────────────

  const usdaiBalance = await sdk.getTokenBalance(USDAI, user);
  console.log(`  USD.AI balance: ${formatUnits(usdaiBalance, 18)}`);

  if (usdaiBalance < depositAmount) {
    throw new Error(`Insufficient USD.AI: have ${formatUnits(usdaiBalance, 18)}, need ${amount}`);
  }

  // ─────────────────────────────────────────────────────────────────
  //  2. Check current allowance
  // ─────────────────────────────────────────────────────────────────

  const vaultAddr = tranche === "SENIOR" ? DEPLOYED.seniorVault
    : tranche === "MEZZ" ? DEPLOYED.mezzVault
    : DEPLOYED.juniorVault;

  const currentAllowance = await sdk.getTokenAllowance(USDAI, user, vaultAddr);
  console.log(`  Current allowance: ${formatUnits(currentAllowance, 18)}`);

  // ─────────────────────────────────────────────────────────────────
  //  3. Preview deposit
  // ─────────────────────────────────────────────────────────────────

  const previewShares = await sdk.previewDeposit(tranche, depositAmount);
  console.log(`  Preview shares:    ${formatUnits(previewShares, 18)}`);

  // ─────────────────────────────────────────────────────────────────
  //  4. Check protocol health & coverage gate
  // ─────────────────────────────────────────────────────────────────

  const health = await sdk.getProtocolHealth();
  console.log(`\n  Protocol Health:`);
  console.log(`    Total TVL:  $${formatUnits(health.totalTVL, 18)}`);
  console.log(`    Coverage Sr: ${sdk.formatRatio(health.coverageSenior)}`);
  console.log(`    Coverage Mz: ${sdk.formatRatio(health.coverageMezz)}`);
  console.log(`    Paused:      ${health.shortfallPaused}`);

  if (health.shortfallPaused) {
    throw new Error("Protocol is paused due to shortfall!");
  }

  // ─────────────────────────────────────────────────────────────────
  //  5. Check shares before
  // ─────────────────────────────────────────────────────────────────

  const sharesBefore = await sdk.getShareBalance(tranche, user);
  console.log(`\n  Shares before: ${formatUnits(sharesBefore, 18)}`);

  if (dryRun) {
    console.log(`\n  🔍 Dry run — no transactions sent.\n`);
    return;
  }

  // ─────────────────────────────────────────────────────────────────
  //  6. Approve (if needed)
  // ─────────────────────────────────────────────────────────────────

  if (currentAllowance < depositAmount) {
    console.log(`\n  Approving ${amount} USD.AI for ${tranche} vault...`);
    const approveTx = await sdk.approveVaultDeposit(walletClient, tranche, USDAI, depositAmount);
    await waitForTx(publicClient, approveTx, "Approve");
  } else {
    console.log(`\n  Allowance sufficient, skipping approve.`);
  }

  // ─────────────────────────────────────────────────────────────────
  //  7. Deposit
  // ─────────────────────────────────────────────────────────────────

  console.log(`  Depositing ${amount} USD.AI into ${tranche}...`);
  const depositTx = await sdk.deposit(walletClient, tranche, depositAmount, user);
  await waitForTx(publicClient, depositTx, "Deposit");

  // ─────────────────────────────────────────────────────────────────
  //  8. Verify shares after
  // ─────────────────────────────────────────────────────────────────

  const sharesAfter = await sdk.getShareBalance(tranche, user);
  const sharesReceived = sharesAfter - sharesBefore;

  console.log(`\n  Shares after:    ${formatUnits(sharesAfter, 18)}`);
  console.log(`  Shares received: ${formatUnits(sharesReceived, 18)}`);
  console.log(`\n  ✓ Deposit complete!\n`);
}

main().catch((err) => {
  console.error(`\n  ✗ Error: ${err.message}\n`);
  process.exitCode = 1;
});
