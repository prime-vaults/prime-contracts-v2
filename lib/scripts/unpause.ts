/**
 * Unpause shortfall + optionally disable pause threshold.
 *
 * Usage:
 *   npx tsx lib/scripts/unpause.ts                      # unpause only
 *   npx tsx lib/scripts/unpause.ts --disable-threshold   # unpause + set threshold to 0
 */

import { type Hash } from "viem";
import { createSDK, createWallet, waitForTx, hasFlag } from "./config";

const CDO_ABI = [
  { inputs: [], name: "unpauseShortfall", outputs: [], stateMutability: "nonpayable", type: "function" },
  { inputs: [{ name: "price", type: "uint256" }], name: "setJuniorShortfallPausePrice", outputs: [], stateMutability: "nonpayable", type: "function" },
  { inputs: [], name: "s_shortfallPaused", outputs: [{ name: "", type: "bool" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "s_juniorShortfallPausePrice", outputs: [{ name: "", type: "uint256" }], stateMutability: "view", type: "function" },
] as const;

async function main() {
  const args = process.argv.slice(2);
  const disableThreshold = hasFlag(args, "--disable-threshold");

  const { publicClient, addresses } = createSDK();
  const { account, walletClient } = createWallet();
  const cdoAddr = addresses.primeCDO as `0x${string}`;

  const paused = await publicClient.readContract({ address: cdoAddr, abi: CDO_ABI, functionName: "s_shortfallPaused" });
  const threshold = await publicClient.readContract({ address: cdoAddr, abi: CDO_ABI, functionName: "s_juniorShortfallPausePrice" });
  console.log(`\n  CDO:       ${cdoAddr}`);
  console.log(`  Paused:    ${paused}`);
  console.log(`  Threshold: ${threshold} (0 = disabled)\n`);

  if (paused) {
    console.log(`  Unpausing...`);
    const hash = await walletClient.writeContract({ address: cdoAddr, abi: CDO_ABI, functionName: "unpauseShortfall", chain: walletClient.chain, account });
    await waitForTx(publicClient, hash as Hash, "unpauseShortfall");
  } else {
    console.log(`  Already unpaused.`);
  }

  if (disableThreshold && threshold !== 0n) {
    console.log(`  Disabling shortfall threshold...`);
    const hash = await walletClient.writeContract({ address: cdoAddr, abi: CDO_ABI, functionName: "setJuniorShortfallPausePrice", args: [0n], chain: walletClient.chain, account });
    await waitForTx(publicClient, hash as Hash, "setJuniorShortfallPausePrice(0)");
  }

  const afterPaused = await publicClient.readContract({ address: cdoAddr, abi: CDO_ABI, functionName: "s_shortfallPaused" });
  const afterThreshold = await publicClient.readContract({ address: cdoAddr, abi: CDO_ABI, functionName: "s_juniorShortfallPausePrice" });
  console.log(`\n  After:`);
  console.log(`  Paused:    ${afterPaused}`);
  console.log(`  Threshold: ${afterThreshold}`);
  console.log(`  Done.\n`);
}

main().catch((err) => { console.error(`\n  Error: ${err.message}\n`); process.exitCode = 1; });
