/**
 * Read-only dashboard — protocol state, tranche info, user portfolio.
 *
 * Usage:
 *   # Protocol overview:
 *   ARB_RPC_URL=<url> npx tsx lib/scripts/dashboard.ts
 *
 *   # User portfolio:
 *   ARB_RPC_URL=<url> npx tsx lib/scripts/dashboard.ts --user 0x...
 *
 *   # Junior position detail:
 *   ARB_RPC_URL=<url> npx tsx lib/scripts/dashboard.ts --junior
 *
 *   # WETH rebalance status:
 *   ARB_RPC_URL=<url> npx tsx lib/scripts/dashboard.ts --rebalance
 */

import { formatUnits } from "viem";
import { createSDK, parseFlag, hasFlag } from "./config";

async function main() {
  const args = process.argv.slice(2);
  const { sdk } = createSDK();

  // ─────────────────────────────────────────────────────────────────
  //  Protocol Health
  // ─────────────────────────────────────────────────────────────────

  const health = await sdk.getProtocolHealth();
  console.log(`\n  Protocol Health`);
  console.log(`  ───────────────────────────────────`);
  console.log(`  Senior TVL:   $${formatUnits(health.seniorTVL, 18)}`);
  console.log(`  Mezz TVL:     $${formatUnits(health.mezzTVL, 18)}`);
  console.log(`  Junior TVL:   $${formatUnits(health.juniorTVL, 18)}`);
  console.log(`  Total TVL:    $${formatUnits(health.totalTVL, 18)}`);
  console.log(`  Strategy TVL: $${formatUnits(health.strategyTVL, 18)}`);
  console.log(`  Coverage Sr:  ${sdk.formatRatio(health.coverageSenior)}`);
  console.log(`  Coverage Mz:  ${sdk.formatRatio(health.coverageMezz)}`);
  console.log(`  Paused:       ${health.shortfallPaused}`);

  // ─────────────────────────────────────────────────────────────────
  //  Tranche Info
  // ─────────────────────────────────────────────────────────────────

  const tranches = await sdk.getAllTranches();
  console.log(`\n  Tranches`);
  console.log(`  ───────────────────────────────────`);
  for (const [label, t] of [["Senior", tranches.senior], ["Mezz", tranches.mezz], ["Junior", tranches.junior]] as const) {
    console.log(`  ${label}: ${t.symbol} | assets=${formatUnits(t.totalAssets, 18)} | supply=${formatUnits(t.totalSupply, 18)} | price=${sdk.formatSharePrice(t.sharePrice)}`);
  }

  // ─────────────────────────────────────────────────────────────────
  //  Withdraw Conditions
  // ─────────────────────────────────────────────────────────────────

  const MECHANISM_NAMES: Record<number, string> = { 0: "NONE", 1: "ASSETS_LOCK", 2: "SHARES_LOCK" };

  console.log(`\n  Withdraw Conditions`);
  console.log(`  ───────────────────────────────────`);
  for (const tranche of ["SENIOR", "MEZZ", "JUNIOR"] as const) {
    const c = await sdk.previewWithdrawCondition(tranche);
    console.log(`  ${tranche}: ${MECHANISM_NAMES[c.mechanism] ?? c.mechanism} | fee=${sdk.formatBps(c.feeBps)} | cooldown=${Number(c.cooldownDuration) / 3600}h`);
  }

  // ─────────────────────────────────────────────────────────────────
  //  Junior Position
  // ─────────────────────────────────────────────────────────────────

  if (hasFlag(args, "--junior") || !parseFlag(args, "--user")) {
    const pos = await sdk.getJuniorPosition();
    console.log(`\n  Junior Position`);
    console.log(`  ───────────────────────────────────`);
    console.log(`  Base TVL:  $${formatUnits(pos.baseTVL, 18)}`);
    console.log(`  WETH TVL:  $${formatUnits(pos.wethTVL, 18)}`);
    console.log(`  WETH:      ${formatUnits(pos.wethAmount, 18)} ($${formatUnits(pos.wethPrice, 18)}/ETH)`);
    console.log(`  Ratio:     ${sdk.formatRatio(pos.currentRatio)} (target 20%)`);
    console.log(`  Aave APR:  ${sdk.formatRatio(pos.aaveAPR)}`);
  }

  // ─────────────────────────────────────────────────────────────────
  //  WETH Rebalance
  // ─────────────────────────────────────────────────────────────────

  if (hasFlag(args, "--rebalance")) {
    const rb = await sdk.getWETHRebalanceStatus();
    console.log(`\n  WETH Rebalance`);
    console.log(`  ───────────────────────────────────`);
    console.log(`  Ratio:     ${sdk.formatRatio(rb.currentRatio)} (target ${sdk.formatRatio(rb.targetRatio)} +/- ${sdk.formatRatio(rb.tolerance)})`);
    console.log(`  WETH:      ${formatUnits(rb.wethAmount, 18)} ($${formatUnits(rb.wethValueUSD, 18)})`);
    console.log(`  Needs sell: ${rb.needsSell}  Needs buy: ${rb.needsBuy}`);
    if (rb.needsSell || rb.needsBuy) {
      console.log(`  Amount:    $${formatUnits(rb.excessOrDeficitUSD, 18)}`);
    }
  }

  // ─────────────────────────────────────────────────────────────────
  //  User Portfolio
  // ─────────────────────────────────────────────────────────────────

  // Resolve user: --user flag, or PRIVATE_KEY env
  let userAddr = parseFlag(args, "--user");
  if (!userAddr && process.env.PRIVATE_KEY) {
    const { privateKeyToAccount } = await import("viem/accounts");
    userAddr = privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`).address;
  }

  if (userAddr) {
    const portfolio = await sdk.getUserPortfolio(userAddr);
    console.log(`\n  Portfolio — ${userAddr}`);
    console.log(`  ───────────────────────────────────`);
    console.log(`  Senior: ${formatUnits(portfolio.senior.shares, 18)} shares ($${formatUnits(portfolio.senior.assets, 18)})`);
    console.log(`  Mezz:   ${formatUnits(portfolio.mezz.shares, 18)} shares ($${formatUnits(portfolio.mezz.assets, 18)})`);
    console.log(`  Junior: ${formatUnits(portfolio.junior.shares, 18)} shares ($${formatUnits(portfolio.junior.assets, 18)})`);
    console.log(`  Total:  $${formatUnits(portfolio.totalAssetsUSD, 18)}`);

    // Pending withdraws
    const pending = await sdk.getUserPendingWithdraws(userAddr);
    console.log(`\n  Pending Withdraws: ${pending.length}`);
    for (const pw of pending) {
      const remaining = Number(pw.timeRemaining);
      const remainStr = remaining > 0 ? `${(remaining / 3600).toFixed(1)}h remaining` : "ready";
      console.log(`    #${pw.requestId} | ${formatUnits(pw.amount, 18)} | handler=${pw.handler.slice(0, 10)}... | claimable=${pw.isClaimable} | ${remainStr}`);
    }

    // Claimable withdraws
    const claimable = await sdk.getClaimableWithdraws(userAddr);
    if (claimable.length > 0) {
      console.log(`\n  Claimable Withdraws: ${claimable.length}`);
      for (const cw of claimable) {
        console.log(`    #${cw.requestId} | ${formatUnits(cw.amount, 18)} | handler=${cw.handler.slice(0, 10)}...`);
      }
    }
  }

  console.log();
}

main().catch((err) => { console.error(`\n  Error: ${err.message}\n`); process.exitCode = 1; });
