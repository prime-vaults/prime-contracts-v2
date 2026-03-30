/**
 * SDK Write Script — Full withdraw flow on Arbitrum production.
 *
 * Flow: Check shares → Preview condition → Request withdraw → (wait cooldown) → Claim
 *
 * Usage:
 *   ARB_RPC_URL=<url> PRIVATE_KEY=<key> npx tsx lib/scripts/withdraw-flow.ts \
 *     --tranche SENIOR --shares 10
 *
 *   # Claim a pending cooldown:
 *   ARB_RPC_URL=<url> PRIVATE_KEY=<key> npx tsx lib/scripts/withdraw-flow.ts \
 *     --claim --cooldown-id 1 --handler 0x... --tranche SENIOR
 *
 * Options:
 *   --tranche      SENIOR | MEZZ | JUNIOR  (default: SENIOR)
 *   --shares       Shares to withdraw       (default: 1)
 *   --claim        Claim mode (skip request, just claim)
 *   --cooldown-id  Cooldown ID to claim
 *   --handler      Cooldown handler address
 *   --dry-run      Preview only, no tx sent
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

// ═══════════════════════════════════════════════════════════════════
//  Parse args
// ═══════════════════════════════════════════════════════════════════

function parseArgs() {
  const args = process.argv.slice(2);
  let tranche: TrancheId = "SENIOR";
  let shares = "1";
  let dryRun = false;
  let claimMode = false;
  let cooldownId: string | null = null;
  let handler: string | null = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--tranche" && args[i + 1]) tranche = args[++i].toUpperCase() as TrancheId;
    if (args[i] === "--shares" && args[i + 1]) shares = args[++i];
    if (args[i] === "--dry-run") dryRun = true;
    if (args[i] === "--claim") claimMode = true;
    if (args[i] === "--cooldown-id" && args[i + 1]) cooldownId = args[++i];
    if (args[i] === "--handler" && args[i + 1]) handler = args[++i];
  }

  if (!["SENIOR", "MEZZ", "JUNIOR"].includes(tranche)) {
    throw new Error(`Invalid tranche: ${tranche}`);
  }

  return { tranche, shares, dryRun, claimMode, cooldownId, handler };
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

const MECHANISM_NAMES: Record<number, string> = {
  0: "INSTANT",
  1: "ERC20_COOLDOWN",
  2: "UNSTAKE",
  3: "SHARES_COOLDOWN",
};

// ═══════════════════════════════════════════════════════════════════
//  Main — Request Withdraw
// ═══════════════════════════════════════════════════════════════════

async function requestWithdraw() {
  const { tranche, shares, dryRun } = parseArgs();
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

  const withdrawShares = parseUnits(shares, 18);
  const user = account.address;

  console.log(`\n══════════════════════════════════════════════════`);
  console.log(`  Withdraw Flow — ${tranche}`);
  console.log(`══════════════════════════════════════════════════`);
  console.log(`  User:    ${user}`);
  console.log(`  Tranche: ${tranche}`);
  console.log(`  Shares:  ${shares} (${withdrawShares})`);
  console.log(`  Dry run: ${dryRun}\n`);

  // ─────────────────────────────────────────────────────────────────
  //  1. Check share balance
  // ─────────────────────────────────────────────────────────────────

  const shareBalance = await sdk.getShareBalance(tranche, user);
  console.log(`  Share balance: ${formatUnits(shareBalance, 18)}`);

  if (shareBalance < withdrawShares) {
    throw new Error(`Insufficient shares: have ${formatUnits(shareBalance, 18)}, need ${shares}`);
  }

  // ─────────────────────────────────────────────────────────────────
  //  2. Preview redeem
  // ─────────────────────────────────────────────────────────────────

  const previewAssets = await sdk.previewRedeem(tranche, withdrawShares);
  console.log(`  Preview assets: ${formatUnits(previewAssets, 18)} USD.AI`);

  // ─────────────────────────────────────────────────────────────────
  //  3. Preview withdraw condition (cooldown type, fee)
  // ─────────────────────────────────────────────────────────────────

  const condition = await sdk.previewWithdrawCondition(tranche);
  console.log(`\n  Withdraw Condition:`);
  console.log(`    Mechanism: ${MECHANISM_NAMES[condition.mechanism] ?? condition.mechanism}`);
  console.log(`    Fee:       ${sdk.formatBps(condition.feeBps)}`);
  console.log(`    Cooldown:  ${Number(condition.cooldownDuration) / 3600}h`);
  console.log(`    Cov Sr:    ${sdk.formatRatio(condition.coverageSenior)}`);
  console.log(`    Cov Mz:    ${sdk.formatRatio(condition.coverageMezz)}`);

  // ─────────────────────────────────────────────────────────────────
  //  4. Check existing pending withdraws
  // ─────────────────────────────────────────────────────────────────

  const pending = await sdk.getUserPendingWithdraws(user);
  console.log(`\n  Pending withdraws: ${pending.length}`);
  for (const pw of pending) {
    console.log(`    #${pw.requestId} | ${formatUnits(pw.amount, 18)} | claimable=${pw.isClaimable} | remaining=${Number(pw.timeRemaining)}s`);
  }

  if (dryRun) {
    console.log(`\n  🔍 Dry run — no transactions sent.\n`);
    return;
  }

  // ─────────────────────────────────────────────────────────────────
  //  5. Request withdraw
  // ─────────────────────────────────────────────────────────────────

  console.log(`\n  Requesting withdraw of ${shares} shares from ${tranche}...`);
  const withdrawTx = await sdk.requestWithdraw(walletClient, tranche, withdrawShares, USDAI, user);
  await waitForTx(publicClient, withdrawTx, "RequestWithdraw");

  // ─────────────────────────────────────────────────────────────────
  //  6. Verify — check pending withdraws again
  // ─────────────────────────────────────────────────────────────────

  const pendingAfter = await sdk.getUserPendingWithdraws(user);
  console.log(`\n  Pending withdraws after: ${pendingAfter.length}`);
  for (const pw of pendingAfter) {
    console.log(`    #${pw.requestId} | ${formatUnits(pw.amount, 18)} | handler=${pw.handler} | claimable=${pw.isClaimable}`);
  }

  const sharesAfter = await sdk.getShareBalance(tranche, user);
  console.log(`  Shares after: ${formatUnits(sharesAfter, 18)}`);
  console.log(`\n  ✓ Withdraw request complete!\n`);
}

// ═══════════════════════════════════════════════════════════════════
//  Main — Claim Withdraw
// ═══════════════════════════════════════════════════════════════════

async function claimWithdraw() {
  const { tranche, dryRun, cooldownId, handler } = parseArgs();
  const rpcUrl = requireEnv("ARB_RPC_URL");
  const privateKey = requireEnv("PRIVATE_KEY");

  if (!cooldownId) throw new Error("--cooldown-id is required in claim mode");
  if (!handler) throw new Error("--handler is required in claim mode");

  const account = privateKeyToAccount(privateKey as `0x${string}`);
  const publicClient = createPublicClient({ chain: arbitrum, transport: http(rpcUrl) });
  const walletClient = createWalletClient({ account, chain: arbitrum, transport: http(rpcUrl) });

  const sdk = new PrimeVaultsSDK({
    rpcUrl,
    chainId: 42161,
    addresses: DEPLOYED,
  });

  const user = account.address;

  console.log(`\n══════════════════════════════════════════════════`);
  console.log(`  Claim Withdraw — ${tranche}`);
  console.log(`══════════════════════════════════════════════════`);
  console.log(`  User:        ${user}`);
  console.log(`  Cooldown ID: ${cooldownId}`);
  console.log(`  Handler:     ${handler}`);
  console.log(`  Dry run:     ${dryRun}\n`);

  // ─────────────────────────────────────────────────────────────────
  //  1. Check claimable
  // ─────────────────────────────────────────────────────────────────

  const claimable = await sdk.getClaimableWithdraws(user);
  console.log(`  Claimable withdraws: ${claimable.length}`);
  for (const cw of claimable) {
    console.log(`    #${cw.requestId} | ${formatUnits(cw.amount, 18)} | handler=${cw.handler}`);
  }

  const usdaiBalanceBefore = await sdk.getTokenBalance(USDAI, user);
  console.log(`  USD.AI balance before: ${formatUnits(usdaiBalanceBefore, 18)}`);

  if (dryRun) {
    console.log(`\n  🔍 Dry run — no transactions sent.\n`);
    return;
  }

  // ─────────────────────────────────────────────────────────────────
  //  2. Claim
  // ─────────────────────────────────────────────────────────────────

  console.log(`\n  Claiming cooldown #${cooldownId}...`);
  const claimTx = await sdk.claimWithdraw(walletClient, tranche, BigInt(cooldownId), handler);
  await waitForTx(publicClient, claimTx, "ClaimWithdraw");

  // ─────────────────────────────────────────────────────────────────
  //  3. Verify
  // ─────────────────────────────────────────────────────────────────

  const usdaiBalanceAfter = await sdk.getTokenBalance(USDAI, user);
  const received = usdaiBalanceAfter - usdaiBalanceBefore;
  console.log(`\n  USD.AI balance after: ${formatUnits(usdaiBalanceAfter, 18)}`);
  console.log(`  USD.AI received:     ${formatUnits(received, 18)}`);
  console.log(`\n  ✓ Claim complete!\n`);
}

// ═══════════════════════════════════════════════════════════════════
//  Entry
// ═══════════════════════════════════════════════════════════════════

const { claimMode } = parseArgs();

if (claimMode) {
  claimWithdraw().catch((err) => {
    console.error(`\n  ✗ Error: ${err.message}\n`);
    process.exitCode = 1;
  });
} else {
  requestWithdraw().catch((err) => {
    console.error(`\n  ✗ Error: ${err.message}\n`);
    process.exitCode = 1;
  });
}
