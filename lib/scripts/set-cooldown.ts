/**
 * Update cooldown duration for ERC20Cooldown or SharesCooldown (governance only).
 *
 * Usage:
 *   npx tsx lib/scripts/set-cooldown.ts --handler erc20 --duration 3d
 *   npx tsx lib/scripts/set-cooldown.ts --handler shares --duration 7d
 *   npx tsx lib/scripts/set-cooldown.ts --handler erc20 --duration 12h
 *   npx tsx lib/scripts/set-cooldown.ts --handler erc20 --duration 300   # seconds
 *
 * Env: ARB_RPC_URL, PRIVATE_KEY
 */

import { type Hash } from "viem";
import { createSDK, createWallet, waitForTx, parseFlag } from "./config";

const COOLDOWN_ABI = [
  { inputs: [], name: "s_cooldownDuration", outputs: [{ name: "", type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [{ name: "duration_", type: "uint256" }], name: "setCooldownDuration", outputs: [], stateMutability: "nonpayable", type: "function" },
] as const;

function parseDuration(input: string): bigint {
  const match = input.match(/^(\d+)(d|h|m|s)?$/);
  if (!match) throw new Error(`Invalid duration: ${input}. Use: 3d, 12h, 30m, 300s, or 300`);
  const value = BigInt(match[1]);
  const unit = match[2] ?? "s";
  const multiplier = { d: 86400n, h: 3600n, m: 60n, s: 1n }[unit]!;
  return value * multiplier;
}

function formatDuration(seconds: bigint): string {
  const s = Number(seconds);
  if (s >= 86400 && s % 86400 === 0) return `${s / 86400}d`;
  if (s >= 3600 && s % 3600 === 0) return `${s / 3600}h`;
  if (s >= 60 && s % 60 === 0) return `${s / 60}m`;
  return `${s}s`;
}

async function main() {
  const args = process.argv.slice(2);
  const handler = parseFlag(args, "--handler");
  const durationStr = parseFlag(args, "--duration");

  if (!handler || !["erc20", "shares"].includes(handler)) {
    throw new Error("--handler required: erc20 or shares");
  }
  if (!durationStr) throw new Error("--duration required: e.g. 3d, 12h, 300");

  const newDuration = parseDuration(durationStr);
  const { publicClient, addresses } = createSDK();
  const { account, walletClient } = createWallet();

  const addr = (handler === "erc20" ? addresses.erc20Cooldown : addresses.sharesCooldown) as `0x${string}`;
  const label = handler === "erc20" ? "ERC20Cooldown" : "SharesCooldown";

  const current = await publicClient.readContract({ address: addr, abi: COOLDOWN_ABI, functionName: "s_cooldownDuration" });

  console.log(`\n  ${label}: ${addr}`);
  console.log(`  Current: ${formatDuration(current)}`);
  console.log(`  New:     ${formatDuration(newDuration)}\n`);

  if (current === newDuration) {
    console.log(`  Already set. No change needed.\n`);
    return;
  }

  console.log(`  Setting cooldown duration...`);
  const hash = await walletClient.writeContract({
    address: addr, abi: COOLDOWN_ABI, functionName: "setCooldownDuration",
    args: [newDuration], chain: walletClient.chain, account,
  });
  await waitForTx(publicClient, hash as Hash, "setCooldownDuration");

  const after = await publicClient.readContract({ address: addr, abi: COOLDOWN_ABI, functionName: "s_cooldownDuration" });
  console.log(`  After: ${formatDuration(after)}`);
  console.log(`  Done.\n`);
}

main().catch((err) => { console.error(`\n  Error: ${err.message}\n`); process.exitCode = 1; });
