/**
 * Deploy Step 01 — Shared infrastructure (reusable across markets)
 *
 * Deploys: RiskParams, WETHPriceOracle, SwapFacility,
 *          ERC20Cooldown, SharesCooldown
 *
 * Usage:
 *   npx hardhat run deploy/01_deploy_shared.ts --network arbitrum
 */

import hre from "hardhat";
import "@nomicfoundation/hardhat-ethers";
import { ARBITRUM, saveDeployed } from "./addresses";

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log(`\n  Deployer: ${deployer.address}`);
  console.log(`  Network:  ${hre.network.name}\n`);

  // ═══════════════════════════════════════════════════════════════════
  //  1. RiskParams
  // ═══════════════════════════════════════════════════════════════════

  const RiskFactory = await hre.ethers.getContractFactory("RiskParams");
  const riskParams = await RiskFactory.deploy(deployer.address);
  await riskParams.waitForDeployment();
  const riskParamsAddr = await riskParams.getAddress();
  console.log(`  RiskParams:        ${riskParamsAddr}`);

  // ═══════════════════════════════════════════════════════════════════
  //  2. WETHPriceOracle
  // ═══════════════════════════════════════════════════════════════════

  const OracleFactory = await hre.ethers.getContractFactory("WETHPriceOracle");
  const wethOracle = await OracleFactory.deploy(ARBITRUM.CHAINLINK_ETH_USD);
  await wethOracle.waitForDeployment();
  const wethOracleAddr = await wethOracle.getAddress();
  console.log(`  WETHPriceOracle:   ${wethOracleAddr}`);

  // Seed first price point for TWAP
  await (await wethOracle.recordPrice()).wait();
  console.log(`  ✓ WETHPriceOracle.recordPrice() — initial seed`);

  // ═══════════════════════════════════════════════════════════════════
  //  3. SwapFacility
  // ═══════════════════════════════════════════════════════════════════

  const SwapFactory = await hre.ethers.getContractFactory("SwapFacility");
  const swapFacility = await SwapFactory.deploy(
    ARBITRUM.UNISWAP_V3_ROUTER, ARBITRUM.UNISWAP_V3_QUOTER, ARBITRUM.WETH, deployer.address,
  );
  await swapFacility.waitForDeployment();
  const swapFacilityAddr = await swapFacility.getAddress();
  console.log(`  SwapFacility:      ${swapFacilityAddr}`);

  // ═══════════════════════════════════════════════════════════════════
  //  4. ERC20Cooldown
  // ═══════════════════════════════════════════════════════════════════

  const ERC20CooldownFactory = await hre.ethers.getContractFactory("ERC20Cooldown");
  const erc20Cooldown = await ERC20CooldownFactory.deploy(deployer.address);
  await erc20Cooldown.waitForDeployment();
  const erc20CooldownAddr = await erc20Cooldown.getAddress();
  console.log(`  ERC20Cooldown:     ${erc20CooldownAddr}`);

  // ═══════════════════════════════════════════════════════════════════
  //  5. SharesCooldown
  // ═══════════════════════════════════════════════════════════════════

  const SharesCooldownFactory = await hre.ethers.getContractFactory("SharesCooldown");
  const sharesCooldown = await SharesCooldownFactory.deploy(deployer.address);
  await sharesCooldown.waitForDeployment();
  const sharesCooldownAddr = await sharesCooldown.getAddress();
  console.log(`  SharesCooldown:    ${sharesCooldownAddr}`);

  // ═══════════════════════════════════════════════════════════════════
  //  Save
  // ═══════════════════════════════════════════════════════════════════

  saveDeployed({
    riskParams: riskParamsAddr,
    wethPriceOracle: wethOracleAddr,
    swapFacility: swapFacilityAddr,
    erc20Cooldown: erc20CooldownAddr,
    sharesCooldown: sharesCooldownAddr,
  });

  console.log(`\n  ✓ Shared contracts deployed. Saved to deploy/deployed.json\n`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
