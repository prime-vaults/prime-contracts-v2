/**
 * Deploy Step 03 — Configure all wiring between contracts
 *
 * Actions:
 *   - Set CDO in Accounting (one-time)
 *   - Register vaults in CDO
 *   - Authorize CDO in cooldown contracts
 *   - Authorize CDO in SwapFacility
 *   - Set coverage gate params
 *   - Set WETH ratio params
 *   - Grant KEEPER_ROLE on AprPairFeed
 *
 * Requires: deploy/01 and deploy/02 have been run.
 *
 * Usage:
 *   KEEPER_ADDRESS=0x... npx hardhat run deploy/03_configure.ts --network arbitrum
 */

import hre from "hardhat";
import "@nomicfoundation/hardhat-ethers";
import { DEFAULTS, loadDeployed } from "./addresses";

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const d = loadDeployed();
  const keeperAddr = process.env.KEEPER_ADDRESS || deployer.address;

  console.log(`\n  Deployer: ${deployer.address}`);
  console.log(`  Keeper:   ${keeperAddr}`);
  console.log(`  Network:  ${hre.network.name}\n`);

  // ═══════════════════════════════════════════════════════════════════
  //  1. Set CDO in Accounting (one-time)
  // ═══════════════════════════════════════════════════════════════════

  const accounting = await hre.ethers.getContractAt("Accounting", d.accounting);
  await (await accounting.setCDO(d.primeCDO)).wait();
  console.log(`  ✓ Accounting.setCDO(${d.primeCDO})`);

  // ═══════════════════════════════════════════════════════════════════
  //  2. Register vaults in CDO
  // ═══════════════════════════════════════════════════════════════════

  const cdo = await hre.ethers.getContractAt("PrimeCDO", d.primeCDO);
  await (await cdo.registerTranche(0, d.seniorVault)).wait();
  console.log(`  ✓ CDO.registerTranche(SENIOR, ${d.seniorVault})`);
  await (await cdo.registerTranche(1, d.mezzVault)).wait();
  console.log(`  ✓ CDO.registerTranche(MEZZ, ${d.mezzVault})`);
  await (await cdo.registerTranche(2, d.juniorVault)).wait();
  console.log(`  ✓ CDO.registerTranche(JUNIOR, ${d.juniorVault})`);

  // ═══════════════════════════════════════════════════════════════════
  //  3. Authorize CDO in cooldown contracts
  // ═══════════════════════════════════════════════════════════════════

  const erc20Cooldown = await hre.ethers.getContractAt("ERC20Cooldown", d.erc20Cooldown);
  await (await erc20Cooldown.setAuthorized(d.primeCDO, true)).wait();
  console.log(`  ✓ ERC20Cooldown.setAuthorized(CDO)`);

  const sharesCooldown = await hre.ethers.getContractAt("SharesCooldown", d.sharesCooldown);
  await (await sharesCooldown.setAuthorized(d.primeCDO, true)).wait();
  console.log(`  ✓ SharesCooldown.setAuthorized(CDO)`);

  // ═══════════════════════════════════════════════════════════════════
  //  4. Authorize CDO in SwapFacility
  // ═══════════════════════════════════════════════════════════════════

  const swapFacility = await hre.ethers.getContractAt("SwapFacility", d.swapFacility);
  await (await swapFacility.setAuthorizedCDO(d.primeCDO, true)).wait();
  console.log(`  ✓ SwapFacility.setAuthorizedCDO(CDO)`);

  // ═══════════════════════════════════════════════════════════════════
  //  5. Set coverage gate params
  // ═══════════════════════════════════════════════════════════════════

  await (await cdo.setMinCoverageForDeposit(DEFAULTS.MIN_COVERAGE_DEPOSIT)).wait();
  console.log(`  ✓ CDO.setMinCoverageForDeposit(105%)`);

  await (await cdo.setJuniorShortfallPausePrice(DEFAULTS.SHORTFALL_PAUSE_PRICE)).wait();
  console.log(`  ✓ CDO.setJuniorShortfallPausePrice(90%)`);

  // ═══════════════════════════════════════════════════════════════════
  //  6. Set WETH ratio params
  // ═══════════════════════════════════════════════════════════════════

  await (await cdo.setRatioTarget(DEFAULTS.RATIO_TARGET)).wait();
  console.log(`  ✓ CDO.setRatioTarget(20%)`);

  await (await cdo.setRatioTolerance(DEFAULTS.RATIO_TOLERANCE)).wait();
  console.log(`  ✓ CDO.setRatioTolerance(3%)`);

  // ═══════════════════════════════════════════════════════════════════
  //  7. Grant KEEPER_ROLE on AprPairFeed
  // ═══════════════════════════════════════════════════════════════════

  const aprFeed = await hre.ethers.getContractAt("AprPairFeed", d.aprFeed);
  const KEEPER_ROLE = hre.ethers.keccak256(hre.ethers.toUtf8Bytes("KEEPER_ROLE"));
  await (await aprFeed.grantRole(KEEPER_ROLE, keeperAddr)).wait();
  console.log(`  ✓ AprPairFeed.grantRole(KEEPER_ROLE, ${keeperAddr})`);

  console.log(`\n  ✓ All configuration complete!`);
  console.log(`  Next: npx hardhat run deploy/04_deploy_lens.ts --network arbitrum\n`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
