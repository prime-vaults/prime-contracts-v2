/**
 * Deploy Step 03 — Configure all wiring between contracts
 *
 * Actions:
 *   - Register vaults in CDO
 *   - Set CDO in Accounting
 *   - Authorize CDO in cooldown contracts
 *   - Authorize CDO in SwapFacility
 *   - Register sUSDai impl in UnstakeCooldown
 *   - Authorize strategy in UnstakeCooldown
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
import { ARBITRUM, DEFAULTS, loadDeployed } from "./addresses";

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
  await (await cdo.registerTranche(0, d.seniorVault)).wait(); // SENIOR
  console.log(`  ✓ CDO.registerTranche(SENIOR, ${d.seniorVault})`);
  await (await cdo.registerTranche(1, d.mezzVault)).wait(); // MEZZ
  console.log(`  ✓ CDO.registerTranche(MEZZ, ${d.mezzVault})`);
  await (await cdo.registerTranche(2, d.juniorVault)).wait(); // JUNIOR
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
  //  4. Authorize Strategy in UnstakeCooldown + register impl
  // ═══════════════════════════════════════════════════════════════════

  const unstakeCooldown = await hre.ethers.getContractAt("UnstakeCooldown", d.unstakeCooldown);
  await (await unstakeCooldown.setAuthorized(d.strategy, true)).wait();
  console.log(`  ✓ UnstakeCooldown.setAuthorized(Strategy)`);

  await (await unstakeCooldown.setImplementation(ARBITRUM.SUSDAI, d.cooldownImpl)).wait();
  console.log(`  ✓ UnstakeCooldown.setImplementation(sUSDai → CooldownImpl)`);

  // ═══════════════════════════════════════════════════════════════════
  //  5. Authorize CDO in SwapFacility
  // ═══════════════════════════════════════════════════════════════════

  const swapFacility = await hre.ethers.getContractAt("SwapFacility", d.swapFacility);
  await (await swapFacility.setAuthorizedCDO(d.primeCDO, true)).wait();
  console.log(`  ✓ SwapFacility.setAuthorizedCDO(CDO)`);

  // ═══════════════════════════════════════════════════════════════════
  //  6. Set coverage gate params (already defaults in constructor, but explicit)
  // ═══════════════════════════════════════════════════════════════════

  await (await cdo.setMinCoverageForDeposit(DEFAULTS.MIN_COVERAGE_DEPOSIT)).wait();
  console.log(`  ✓ CDO.setMinCoverageForDeposit(105%)`);

  await (await cdo.setJuniorShortfallPausePrice(DEFAULTS.SHORTFALL_PAUSE_PRICE)).wait();
  console.log(`  ✓ CDO.setJuniorShortfallPausePrice(90%)`);

  // ═══════════════════════════════════════════════════════════════════
  //  7. Set WETH ratio params (already defaults, but explicit)
  // ═══════════════════════════════════════════════════════════════════

  await (await cdo.setRatioTarget(DEFAULTS.RATIO_TARGET)).wait();
  console.log(`  ✓ CDO.setRatioTarget(20%)`);

  await (await cdo.setRatioTolerance(DEFAULTS.RATIO_TOLERANCE)).wait();
  console.log(`  ✓ CDO.setRatioTolerance(2%)`);

  // ═══════════════════════════════════════════════════════════════════
  //  8. Grant KEEPER_ROLE on AprPairFeed
  // ═══════════════════════════════════════════════════════════════════

  const aprFeed = await hre.ethers.getContractAt("AprPairFeed", d.aprFeed);
  const KEEPER_ROLE = hre.ethers.keccak256(hre.ethers.toUtf8Bytes("KEEPER_ROLE"));
  await (await aprFeed.grantRole(KEEPER_ROLE, keeperAddr)).wait();
  console.log(`  ✓ AprPairFeed.grantRole(KEEPER_ROLE, ${keeperAddr})`);

  console.log(`\n  ✓ All configuration complete!\n`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

//npx hardhat run deploy/01_deploy_shared.ts --network arbitrum
//npx hardhat run deploy/02_deploy_usdai_market.ts --network arbitrum
// npx hardhat run deploy/03_configure.ts --network arbitrum
