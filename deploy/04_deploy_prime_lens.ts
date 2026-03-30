/**
 * Deploy Step 04 — PrimeLens (read-only aggregator)
 *
 * Deploys: PrimeLens
 *
 * Requires: deploy/01, deploy/02, deploy/03 have been run.
 *           PrimeLens reads immutables from PrimeCDO in its constructor,
 *           so CDO must already be configured with vaults registered.
 *
 * Usage:
 *   npx hardhat run deploy/04_deploy_prime_lens.ts --network arbitrum
 */

import hre from "hardhat";
import "@nomicfoundation/hardhat-ethers";
import { loadDeployed, saveDeployed } from "./addresses";

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const d = loadDeployed();

  console.log(`\n  Deployer: ${deployer.address}`);
  console.log(`  Network:  ${hre.network.name}\n`);

  // ═══════════════════════════════════════════════════════════════════
  //  PrimeLens
  // ═══════════════════════════════════════════════════════════════════

  const LensFactory = await hre.ethers.getContractFactory("PrimeLens");
  const primeLens = await LensFactory.deploy(d.primeCDO, d.seniorVault, d.mezzVault, d.juniorVault);
  await primeLens.waitForDeployment();
  const primeLensAddr = await primeLens.getAddress();
  console.log(`  PrimeLens:         ${primeLensAddr}`);

  // ═══════════════════════════════════════════════════════════════════
  //  Verify immutables read from CDO
  // ═══════════════════════════════════════════════════════════════════

  const resolvedAccounting = await primeLens.i_accounting();
  const resolvedStrategy = await primeLens.i_strategy();
  const resolvedAdapter = await primeLens.i_aaveAdapter();
  const resolvedOracle = await primeLens.i_wethOracle();

  console.log(`\n  Immutables resolved from CDO:`);
  console.log(`    i_accounting:      ${resolvedAccounting}`);
  console.log(`    i_strategy:        ${resolvedStrategy}`);
  console.log(`    i_aaveAdapter:     ${resolvedAdapter}`);
  console.log(`    i_wethOracle:      ${resolvedOracle}`);

  // Sanity checks
  if (resolvedAccounting.toLowerCase() !== d.accounting.toLowerCase()) {
    console.warn(`  !! Accounting mismatch: expected ${d.accounting}, got ${resolvedAccounting}`);
  }
  if (resolvedStrategy.toLowerCase() !== d.strategy.toLowerCase()) {
    console.warn(`  !! Strategy mismatch: expected ${d.strategy}, got ${resolvedStrategy}`);
  }
  if (resolvedAdapter.toLowerCase() !== d.aaveAdapter.toLowerCase()) {
    console.warn(`  !! AaveAdapter mismatch: expected ${d.aaveAdapter}, got ${resolvedAdapter}`);
  }

  // ═══════════════════════════════════════════════════════════════════
  //  Save
  // ═══════════════════════════════════════════════════════════════════

  saveDeployed({ primeLens: primeLensAddr });

  console.log(`\n  ✓ PrimeLens deployed. Saved to deploy/deployed.json\n`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
