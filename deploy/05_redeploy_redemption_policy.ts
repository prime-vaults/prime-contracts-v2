/**
 * Deploy Step 05 — Redeploy RedemptionPolicy + dependents
 *
 * Redeploys: Accounting, RedemptionPolicy, SUSDaiStrategy, AaveWETHAdapter,
 *            PrimeCDO, TrancheVault × 3, PrimeLens
 * Reconfigures: CDO wiring (vaults, cooldowns, swap, coverage gate, WETH ratio)
 *
 * Reason: RedemptionPolicy logic updated (Junior mechanism now evaluates cs/cm independently).
 *         Accounting.setCDO is one-time-only → must redeploy Accounting too.
 *         PrimeCDO, Strategy, Adapter, TrancheVaults all use immutable CDO refs → must redeploy.
 *
 * Requires: deploy/01–04 have been run. Reads existing addresses from deployed.json.
 *
 * Usage:
 *   npx hardhat run deploy/05_redeploy_redemption_policy.ts --network arbitrum
 */

import hre from "hardhat";
import "@nomicfoundation/hardhat-ethers";
import { ARBITRUM, DEFAULTS, loadDeployed, saveDeployed } from "./addresses";

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const d = loadDeployed();
  const keeperAddr = process.env.KEEPER_ADDRESS || deployer.address;

  console.log(`\n  Deployer: ${deployer.address}`);
  console.log(`  Keeper:   ${keeperAddr}`);
  console.log(`  Network:  ${hre.network.name}`);
  console.log(`  ── Redeploying: Accounting → RedemptionPolicy → Strategy → Adapter → CDO → Vaults → Lens\n`);

  // ═══════════════════════════════════════════════════════════════════
  //  1. Redeploy Accounting (setCDO is one-time-only, must redeploy)
  // ═══════════════════════════════════════════════════════════════════

  const AccFactory = await hre.ethers.getContractFactory("Accounting");
  const accounting = await AccFactory.deploy(d.aprFeed, d.riskParams);
  await accounting.waitForDeployment();
  const accountingAddr = await accounting.getAddress();
  console.log(`  Accounting:        ${accountingAddr}  (was ${d.accounting})`);

  // ═══════════════════════════════════════════════════════════════════
  //  2. Redeploy RedemptionPolicy (updated logic, new Accounting)
  // ═══════════════════════════════════════════════════════════════════

  const RPFactory = await hre.ethers.getContractFactory("RedemptionPolicy");
  const redemptionPolicy = await RPFactory.deploy(deployer.address, accountingAddr);
  await redemptionPolicy.waitForDeployment();
  const redemptionPolicyAddr = await redemptionPolicy.getAddress();
  console.log(`  RedemptionPolicy:  ${redemptionPolicyAddr}  (was ${d.redemptionPolicy})`);

  // ═══════════════════════════════════════════════════════════════════
  //  3. Predict new CDO address for Strategy + Adapter constructors
  // ═══════════════════════════════════════════════════════════════════

  const nonceBefore = await hre.ethers.provider.getTransactionCount(deployer.address);
  // Strategy (+0), Adapter (+1), CDO (+2)
  const predictedCDO = hre.ethers.getCreateAddress({ from: deployer.address, nonce: nonceBefore + 2 });
  console.log(`  PrimeCDO (pred):   ${predictedCDO}`);

  // ═══════════════════════════════════════════════════════════════════
  //  4. Redeploy SUSDaiStrategy (needs new CDO address)
  // ═══════════════════════════════════════════════════════════════════

  const StratFactory = await hre.ethers.getContractFactory("SUSDaiStrategy");
  const strategy = await StratFactory.deploy(
    predictedCDO,
    ARBITRUM.USDAI,
    ARBITRUM.SUSDAI,
    d.unstakeCooldown,
    deployer.address,
  );
  await strategy.waitForDeployment();
  const strategyAddr = await strategy.getAddress();
  console.log(`  SUSDaiStrategy:    ${strategyAddr}  (was ${d.strategy})`);

  // ═══════════════════════════════════════════════════════════════════
  //  5. Redeploy AaveWETHAdapter (needs new CDO address)
  // ═══════════════════════════════════════════════════════════════════

  const AdapterFactory = await hre.ethers.getContractFactory("AaveWETHAdapter");
  const aaveAdapter = await AdapterFactory.deploy(
    ARBITRUM.AAVE_V3_POOL,
    ARBITRUM.WETH,
    d.wethPriceOracle,
    predictedCDO,
  );
  await aaveAdapter.waitForDeployment();
  const aaveAdapterAddr = await aaveAdapter.getAddress();
  console.log(`  AaveWETHAdapter:   ${aaveAdapterAddr}  (was ${d.aaveAdapter})`);

  // ═══════════════════════════════════════════════════════════════════
  //  6. Redeploy PrimeCDO (new Accounting + RedemptionPolicy + Strategy/Adapter)
  // ═══════════════════════════════════════════════════════════════════

  const CDOFactory = await hre.ethers.getContractFactory("PrimeCDO");
  const primeCDO = await CDOFactory.deploy(
    accountingAddr,
    strategyAddr,
    aaveAdapterAddr,
    d.wethPriceOracle,
    d.swapFacility,
    ARBITRUM.WETH,
    redemptionPolicyAddr,
    d.erc20Cooldown,
    d.sharesCooldown,
    deployer.address,
  );
  await primeCDO.waitForDeployment();
  const primeCDOAddr = await primeCDO.getAddress();
  console.log(`  PrimeCDO:          ${primeCDOAddr}  (was ${d.primeCDO})`);

  if (primeCDOAddr !== predictedCDO) {
    throw new Error(`CDO address mismatch! predicted=${predictedCDO} actual=${primeCDOAddr}`);
  }

  // ═══════════════════════════════════════════════════════════════════
  //  7. Reconfigure wiring for new CDO
  // ═══════════════════════════════════════════════════════════════════

  console.log(`\n  ── Reconfiguring wiring...\n`);

  // 7a. Set new CDO in new Accounting
  const accountingContract = await hre.ethers.getContractAt("Accounting", accountingAddr);
  await (await accountingContract.setCDO(primeCDOAddr)).wait();
  console.log(`  ✓ Accounting.setCDO(${primeCDOAddr})`);

  // 7b. Redeploy TrancheVault × 3 (immutable i_cdo → needs new CDO address)
  const cdo = await hre.ethers.getContractAt("PrimeCDO", primeCDOAddr);
  const VaultFactory = await hre.ethers.getContractFactory("TrancheVault");

  const seniorVault = await VaultFactory.deploy(
    primeCDOAddr, 0, ARBITRUM.USDAI, ARBITRUM.WETH, "Prime Senior sUSDai", "srUSDai",
  );
  await seniorVault.waitForDeployment();
  const seniorVaultAddr = await seniorVault.getAddress();
  console.log(`  SeniorVault:       ${seniorVaultAddr}  (was ${d.seniorVault})`);

  const mezzVault = await VaultFactory.deploy(
    primeCDOAddr, 1, ARBITRUM.USDAI, ARBITRUM.WETH, "Prime Mezzanine sUSDai", "mzUSDai",
  );
  await mezzVault.waitForDeployment();
  const mezzVaultAddr = await mezzVault.getAddress();
  console.log(`  MezzVault:         ${mezzVaultAddr}  (was ${d.mezzVault})`);

  const juniorVault = await VaultFactory.deploy(
    primeCDOAddr, 2, ARBITRUM.USDAI, ARBITRUM.WETH, "Prime Junior sUSDai", "jrUSDai",
  );
  await juniorVault.waitForDeployment();
  const juniorVaultAddr = await juniorVault.getAddress();
  console.log(`  JuniorVault:       ${juniorVaultAddr}  (was ${d.juniorVault})`);

  // 7c. Register new vaults in new CDO
  await (await cdo.registerTranche(0, seniorVaultAddr)).wait();
  console.log(`  ✓ CDO.registerTranche(SENIOR, ${seniorVaultAddr})`);
  await (await cdo.registerTranche(1, mezzVaultAddr)).wait();
  console.log(`  ✓ CDO.registerTranche(MEZZ, ${mezzVaultAddr})`);
  await (await cdo.registerTranche(2, juniorVaultAddr)).wait();
  console.log(`  ✓ CDO.registerTranche(JUNIOR, ${juniorVaultAddr})`);

  // 7d. Deauthorize old CDO + authorize new CDO in cooldown contracts
  const erc20Cooldown = await hre.ethers.getContractAt("ERC20Cooldown", d.erc20Cooldown);
  await (await erc20Cooldown.setAuthorized(d.primeCDO, false)).wait();
  console.log(`  ✓ ERC20Cooldown.setAuthorized(oldCDO, false)`);
  await (await erc20Cooldown.setAuthorized(primeCDOAddr, true)).wait();
  console.log(`  ✓ ERC20Cooldown.setAuthorized(newCDO, true)`);

  const sharesCooldown = await hre.ethers.getContractAt("SharesCooldown", d.sharesCooldown);
  await (await sharesCooldown.setAuthorized(d.primeCDO, false)).wait();
  console.log(`  ✓ SharesCooldown.setAuthorized(oldCDO, false)`);
  await (await sharesCooldown.setAuthorized(primeCDOAddr, true)).wait();
  console.log(`  ✓ SharesCooldown.setAuthorized(newCDO, true)`);

  // 7e. Deauthorize old Strategy + authorize new Strategy in UnstakeCooldown
  const unstakeCooldown = await hre.ethers.getContractAt("UnstakeCooldown", d.unstakeCooldown);
  await (await unstakeCooldown.setAuthorized(d.strategy, false)).wait();
  console.log(`  ✓ UnstakeCooldown.setAuthorized(oldStrategy, false)`);
  await (await unstakeCooldown.setAuthorized(strategyAddr, true)).wait();
  console.log(`  ✓ UnstakeCooldown.setAuthorized(newStrategy, true)`);

  // 7f. Deauthorize old CDO + authorize new CDO in SwapFacility
  const swapFacility = await hre.ethers.getContractAt("SwapFacility", d.swapFacility);
  await (await swapFacility.setAuthorizedCDO(d.primeCDO, false)).wait();
  console.log(`  ✓ SwapFacility.setAuthorizedCDO(oldCDO, false)`);
  await (await swapFacility.setAuthorizedCDO(primeCDOAddr, true)).wait();
  console.log(`  ✓ SwapFacility.setAuthorizedCDO(newCDO, true)`);

  // 7g. Set coverage gate + WETH ratio params
  await (await cdo.setMinCoverageForDeposit(DEFAULTS.MIN_COVERAGE_DEPOSIT)).wait();
  console.log(`  ✓ CDO.setMinCoverageForDeposit(105%)`);
  await (await cdo.setJuniorShortfallPausePrice(DEFAULTS.SHORTFALL_PAUSE_PRICE)).wait();
  console.log(`  ✓ CDO.setJuniorShortfallPausePrice(90%)`);
  await (await cdo.setRatioTarget(DEFAULTS.RATIO_TARGET)).wait();
  console.log(`  ✓ CDO.setRatioTarget(20%)`);
  await (await cdo.setRatioTolerance(DEFAULTS.RATIO_TOLERANCE)).wait();
  console.log(`  ✓ CDO.setRatioTolerance(3%)`);

  // ═══════════════════════════════════════════════════════════════════
  //  8. Redeploy PrimeLens (reads immutables from new CDO)
  // ═══════════════════════════════════════════════════════════════════

  console.log(``);
  const LensFactory = await hre.ethers.getContractFactory("PrimeLens");
  const primeLens = await LensFactory.deploy(primeCDOAddr, seniorVaultAddr, mezzVaultAddr, juniorVaultAddr);
  await primeLens.waitForDeployment();
  const primeLensAddr = await primeLens.getAddress();
  console.log(`  PrimeLens:         ${primeLensAddr}  (was ${d.primeLens})`);

  // ═══════════════════════════════════════════════════════════════════
  //  9. Save updated addresses
  // ═══════════════════════════════════════════════════════════════════

  saveDeployed({
    accounting: accountingAddr,
    redemptionPolicy: redemptionPolicyAddr,
    strategy: strategyAddr,
    aaveAdapter: aaveAdapterAddr,
    primeCDO: primeCDOAddr,
    seniorVault: seniorVaultAddr,
    mezzVault: mezzVaultAddr,
    juniorVault: juniorVaultAddr,
    primeLens: primeLensAddr,
  });

  console.log(`\n  ═══════════════════════════════════════════════════════════`);
  console.log(`  ✓ Redeploy complete. Updated addresses saved to deployed.json`);
  console.log(`  ═══════════════════════════════════════════════════════════`);
  console.log(`    Accounting:        ${accountingAddr}`);
  console.log(`    RedemptionPolicy:  ${redemptionPolicyAddr}`);
  console.log(`    SUSDaiStrategy:    ${strategyAddr}`);
  console.log(`    AaveWETHAdapter:   ${aaveAdapterAddr}`);
  console.log(`    PrimeCDO:          ${primeCDOAddr}`);
  console.log(`    SeniorVault:       ${seniorVaultAddr}`);
  console.log(`    MezzVault:         ${mezzVaultAddr}`);
  console.log(`    JuniorVault:       ${juniorVaultAddr}`);
  console.log(`    PrimeLens:         ${primeLensAddr}`);
  console.log(`\n  Next: npx hardhat run scripts/verify-deployment.ts --network arbitrum\n`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
