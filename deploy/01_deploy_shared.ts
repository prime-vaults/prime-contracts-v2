/**
 * Deploy Step 01 — Shared contracts (cross-market)
 *
 * Deploys: RiskParams, WETHPriceOracle, SwapFacility,
 *          ERC20Cooldown, UnstakeCooldown, SharesCooldown
 *
 * Usage:
 *   npx hardhat run deploy/01_deploy_shared.ts --network arbitrum
 *   ARB_RPC_URL=<url> npx hardhat run deploy/01_deploy_shared.ts
 */

import hre from "hardhat";
import "@nomicfoundation/hardhat-ethers";
import { ARBITRUM, DEFAULTS, saveDeployed } from "./addresses";

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log(`\n  Deployer: ${deployer.address}`);
  console.log(`  Network:  ${hre.network.name}\n`);

  // ═══════════════════════════════════════════════════════════════════
  //  1. RiskParams
  // ═══════════════════════════════════════════════════════════════════

  const RiskParamsFactory = await hre.ethers.getContractFactory("RiskParams");
  const riskParams = await RiskParamsFactory.deploy(deployer.address);
  await riskParams.waitForDeployment();
  const riskParamsAddr = await riskParams.getAddress();
  console.log(`  RiskParams:        ${riskParamsAddr}`);

  // ═══════════════════════════════════════════════════════════════════
  //  2. WETHPriceOracle (Chainlink ETH/USD)
  // ═══════════════════════════════════════════════════════════════════

  const OracleFactory = await hre.ethers.getContractFactory("WETHPriceOracle");
  const wethPriceOracle = await OracleFactory.deploy(ARBITRUM.CHAINLINK_ETH_USD);
  await wethPriceOracle.waitForDeployment();
  const wethPriceOracleAddr = await wethPriceOracle.getAddress();
  console.log(`  WETHPriceOracle:   ${wethPriceOracleAddr}`);

  // Seed first price
  await (await wethPriceOracle.recordPrice()).wait();
  console.log(`    → recordPrice() done`);

  // ═══════════════════════════════════════════════════════════════════
  //  3. SwapFacility (Uniswap V3)
  // ═══════════════════════════════════════════════════════════════════

  const SwapFactory = await hre.ethers.getContractFactory("SwapFacility");
  const swapFacility = await SwapFactory.deploy(
    ARBITRUM.UNISWAP_V3_ROUTER, ARBITRUM.WETH, deployer.address,
  );
  await swapFacility.waitForDeployment();
  const swapFacilityAddr = await swapFacility.getAddress();
  console.log(`  SwapFacility:      ${swapFacilityAddr}`);

  // ═══════════════════════════════════════════════════════════════════
  //  4. ERC20Cooldown
  // ═══════════════════════════════════════════════════════════════════

  const ERC20CooldownFactory = await hre.ethers.getContractFactory("ERC20Cooldown");
  const erc20Cooldown = await ERC20CooldownFactory.deploy(
    deployer.address, DEFAULTS.ERC20_COOLDOWN_DURATION, DEFAULTS.ERC20_COOLDOWN_EXPIRY,
  );
  await erc20Cooldown.waitForDeployment();
  const erc20CooldownAddr = await erc20Cooldown.getAddress();
  console.log(`  ERC20Cooldown:     ${erc20CooldownAddr}`);

  // ═══════════════════════════════════════════════════════════════════
  //  5. UnstakeCooldown
  // ═══════════════════════════════════════════════════════════════════

  const UnstakeCooldownFactory = await hre.ethers.getContractFactory("UnstakeCooldown");
  const unstakeCooldown = await UnstakeCooldownFactory.deploy(deployer.address);
  await unstakeCooldown.waitForDeployment();
  const unstakeCooldownAddr = await unstakeCooldown.getAddress();
  console.log(`  UnstakeCooldown:   ${unstakeCooldownAddr}`);

  // ═══════════════════════════════════════════════════════════════════
  //  6. SharesCooldown
  // ═══════════════════════════════════════════════════════════════════

  const SharesCooldownFactory = await hre.ethers.getContractFactory("SharesCooldown");
  const sharesCooldown = await SharesCooldownFactory.deploy(
    deployer.address, DEFAULTS.SHARES_COOLDOWN_DURATION,
  );
  await sharesCooldown.waitForDeployment();
  const sharesCooldownAddr = await sharesCooldown.getAddress();
  console.log(`  SharesCooldown:    ${sharesCooldownAddr}`);

  // ═══════════════════════════════════════════════════════════════════
  //  Save
  // ═══════════════════════════════════════════════════════════════════

  saveDeployed({
    riskParams: riskParamsAddr,
    wethPriceOracle: wethPriceOracleAddr,
    swapFacility: swapFacilityAddr,
    erc20Cooldown: erc20CooldownAddr,
    unstakeCooldown: unstakeCooldownAddr,
    sharesCooldown: sharesCooldownAddr,
  });

  console.log(`\n  ✓ Shared contracts deployed. Saved to deploy/deployed.json\n`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
