/**
 * Withdraw flow — request withdraw, claim cooldowns.
 *
 * Usage:
 *   # Request withdraw (any tranche):
 *   npx tsx lib/scripts/withdraw-flow.ts --tranche JUNIOR --shares 100
 *
 *   # Claim ERC20Cooldown (ASSETS_LOCK — sUSDai or WETH):
 *   npx tsx lib/scripts/withdraw-flow.ts --claim --cooldown-id 1 --tranche SENIOR
 *
 *   # Claim SharesCooldown (SHARES_LOCK):
 *   npx tsx lib/scripts/withdraw-flow.ts --claim-shares --cooldown-id 1 --tranche MEZZ
 *
 *   Add --dry-run to preview without sending tx.
 *
 * Env: ARB_RPC_URL, PRIVATE_KEY
 */

import { parseUnits, formatUnits, formatEther, type Hash } from "viem";
import { createSDK, createWallet, waitForTx, parseFlag, hasFlag } from "./config";
import type { TrancheId } from "../types";

const MECHANISM_NAMES: Record<number, string> = {
  0: "NONE (instant)",
  1: "ASSETS_LOCK",
  2: "SHARES_LOCK",
};

// ═══════════════════════════════════════════════════════════════════
//  Request Withdraw
// ═══════════════════════════════════════════════════════════════════

async function requestWithdraw() {
  const args = process.argv.slice(2);
  const tranche = (parseFlag(args, "--tranche") ?? "SENIOR").toUpperCase() as TrancheId;
  const shares = parseFlag(args, "--shares") ?? "1";
  const dryRun = hasFlag(args, "--dry-run");

  if (!["SENIOR", "MEZZ", "JUNIOR"].includes(tranche)) throw new Error(`Invalid tranche: ${tranche}`);

  const { sdk, publicClient } = createSDK();
  const { account, walletClient } = createWallet();
  const user = account.address;
  const withdrawShares = parseUnits(shares, 18);

  console.log(`\n  Withdraw Flow — ${tranche}`);
  console.log(`  User:    ${user}`);
  console.log(`  Shares:  ${shares}`);
  console.log(`  Output:  sUSDai (underlying)\n`);

  // 1. Check balance
  const shareBalance = await sdk.getShareBalance(tranche, user);
  console.log(`  Share balance: ${formatUnits(shareBalance, 18)}`);
  if (shareBalance < withdrawShares) throw new Error(`Insufficient shares`);

  // 2. Preview
  const previewAssets = await sdk.previewRedeem(tranche, withdrawShares);
  console.log(`  Preview value: ${formatUnits(previewAssets, 18)} USD`);

  // 3. Withdraw condition
  const condition = await sdk.previewWithdrawCondition(tranche);
  console.log(`\n  Mechanism: ${MECHANISM_NAMES[condition.mechanism] ?? condition.mechanism}`);
  console.log(`  Fee:       ${sdk.formatBps(condition.feeBps)}`);
  console.log(`  Cooldown:  ${Number(condition.cooldownDuration) / 3600}h`);

  // 4. Junior estimate
  if (tranche === "JUNIOR") {
    const est = await sdk.estimateJuniorWithdraw(withdrawShares);
    console.log(`\n  Junior Estimate:`);
    console.log(`    Base:  ${formatUnits(est.netBaseAmount, 18)} sUSDai (fee: ${formatUnits(est.feeAmount, 18)})`);
    console.log(`    WETH:  ${formatUnits(est.wethAmount, 18)} ($${formatUnits(est.wethValueUSD, 18)})`);
  }

  // 5. Pending withdraws
  const pending = await sdk.getUserPendingWithdraws(user);
  if (pending.length > 0) {
    console.log(`\n  Pending withdraws: ${pending.length}`);
    for (const pw of pending) {
      console.log(`    #${pw.requestId} | ${formatUnits(pw.amount, 18)} | claimable=${pw.isClaimable}`);
    }
  }

  if (dryRun) { console.log(`\n  Dry run — no tx sent.\n`); return; }

  // 6. Request withdraw
  console.log(`\n  Requesting withdraw...`);
  const result = await sdk.requestWithdraw(walletClient, tranche, withdrawShares);
  console.log(`  Gas: ${result.gasEstimate} | Fee: ~${formatEther(result.estimatedFeeWei)} ETH`);

  const wr = result.withdrawResult;
  console.log(`\n  Result:`);
  console.log(`    Instant:    ${wr.isInstant}`);
  console.log(`    AmountOut:  ${formatUnits(wr.amountOut, 18)}`);
  console.log(`    Mechanism:  ${MECHANISM_NAMES[wr.appliedCooldownType] ?? wr.appliedCooldownType}`);
  console.log(`    CooldownId: ${wr.cooldownId}`);
  console.log(`    Fee:        ${formatUnits(wr.feeAmount, 18)}`);
  if (wr.wethAmount > 0n) {
    console.log(`    WETH:       ${formatUnits(wr.wethAmount, 18)}`);
    if (wr.wethCooldownId > 0n) console.log(`    WETH CdId:  ${wr.wethCooldownId}`);
  }

  // 7. Next action
  const next = result.nextAction;
  console.log(`\n  Next: ${next.type}`);
  switch (next.type) {
    case "DONE":
      console.log(`  Withdraw complete. sUSDai + WETH received.\n`);
      break;
    case "CLAIM_COOLDOWN":
      console.log(`  CooldownId: ${next.cooldownId} | Handler: ${next.cooldownHandler}`);
      if (next.wethCooldownId > 0n) console.log(`  WETH CdId:  ${next.wethCooldownId} (claim separately)`);
      console.log(`  Run: --claim --cooldown-id ${next.cooldownId} --tranche ${tranche}\n`);
      break;
    case "CLAIM_SHARES":
      console.log(`  CooldownId: ${next.cooldownId}`);
      console.log(`  Run: --claim-shares --cooldown-id ${next.cooldownId} --tranche ${tranche}\n`);
      break;
  }
}

// ═══════════════════════════════════════════════════════════════════
//  Claim ERC20Cooldown (ASSETS_LOCK)
// ═══════════════════════════════════════════════════════════════════

async function claimCooldown() {
  const args = process.argv.slice(2);
  const tranche = (parseFlag(args, "--tranche") ?? "SENIOR").toUpperCase() as TrancheId;
  const cooldownId = parseFlag(args, "--cooldown-id");
  const dryRun = hasFlag(args, "--dry-run");

  if (!cooldownId) throw new Error("--cooldown-id required");

  const { sdk, publicClient } = createSDK();
  const { account, walletClient } = createWallet();
  const user = account.address;

  console.log(`\n  Claim Cooldown — ${tranche} #${cooldownId}`);

  const claimable = await sdk.getClaimableWithdraws(user);
  console.log(`  Claimable: ${claimable.length}`);
  for (const cw of claimable) {
    console.log(`    #${cw.requestId} | ${formatUnits(cw.amount, 18)} | handler=${cw.handler}`);
  }

  if (dryRun) { console.log(`\n  Dry run.\n`); return; }

  const target = claimable.find((c) => c.requestId === BigInt(cooldownId));
  if (!target) throw new Error(`Cooldown #${cooldownId} not found or not claimable`);

  console.log(`  Claiming #${cooldownId}...`);
  const r = await sdk.claimWithdraw(walletClient, tranche, BigInt(cooldownId), target.handler);
  console.log(`  Gas: ${r.gasEstimate} | Fee: ~${formatEther(r.estimatedFeeWei)} ETH`);
  await waitForTx(publicClient, r.hash as Hash, "ClaimWithdraw");
  console.log(`  Done.\n`);
}

// ═══════════════════════════════════════════════════════════════════
//  Claim SharesCooldown (SHARES_LOCK)
// ═══════════════════════════════════════════════════════════════════

async function claimShares() {
  const args = process.argv.slice(2);
  const tranche = (parseFlag(args, "--tranche") ?? "SENIOR").toUpperCase() as TrancheId;
  const cooldownId = parseFlag(args, "--cooldown-id");
  const dryRun = hasFlag(args, "--dry-run");

  if (!cooldownId) throw new Error("--cooldown-id required");

  const { sdk, publicClient } = createSDK();
  const { walletClient } = createWallet();

  console.log(`\n  Claim Shares Lock — ${tranche} #${cooldownId}`);

  if (dryRun) { console.log(`  Dry run.\n`); return; }

  console.log(`  Claiming shares cooldown #${cooldownId}...`);
  const r = await sdk.claimSharesWithdraw(walletClient, tranche, BigInt(cooldownId));
  console.log(`  Gas: ${r.gasEstimate} | Fee: ~${formatEther(r.estimatedFeeWei)} ETH`);
  await waitForTx(publicClient, r.hash as Hash, "ClaimSharesWithdraw");
  console.log(`  Done.\n`);
}

// ═══════════════════════════════════════════════════════════════════
//  Entry
// ═══════════════════════════════════════════════════════════════════

const args = process.argv.slice(2);

if (hasFlag(args, "--claim-shares")) {
  claimShares().catch((e) => { console.error(`\n  Error: ${e.message}\n`); process.exitCode = 1; });
} else if (hasFlag(args, "--claim")) {
  claimCooldown().catch((e) => { console.error(`\n  Error: ${e.message}\n`); process.exitCode = 1; });
} else {
  requestWithdraw().catch((e) => { console.error(`\n  Error: ${e.message}\n`); process.exitCode = 1; });
}
