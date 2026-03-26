import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

const SENIOR = 0;
const MEZZ = 1;
const JUNIOR = 2;

describe("PrimeCDO — Rebalance (Asymmetric)", () => {
  let cdo: any;
  let accounting: any;
  let strategy: any;
  let adapter: any;
  let oracle: any;
  let swap: any;
  let mockRouter: any;
  let mockUSDai: any;
  let mockWeth: any;
  let mockPool: any;

  let owner: SignerWithAddress;
  let seniorVault: SignerWithAddress;
  let mezzVault: SignerWithAddress;
  let juniorVault: SignerWithAddress;
  let other: SignerWithAddress;

  const E18 = 10n ** 18n;
  const E8 = 10n ** 8n;
  const ETH_PRICE = 3000n * E8; // Chainlink 8-decimal format

  async function seedTVL(tranche: number, amount: bigint) {
    const cdoAddr = await cdo.getAddress();
    await ethers.provider.send("hardhat_setBalance", [cdoAddr, "0x56BC75E2D63100000"]);
    const cdoSigner = await ethers.getImpersonatedSigner(cdoAddr);
    await accounting.connect(cdoSigner).recordDeposit(tranche, amount);
  }

  async function seedWETHInAave(amount: bigint) {
    // Mint WETH to CDO, approve adapter, supply
    const cdoAddr = await cdo.getAddress();
    await mockWeth.mint(cdoAddr, amount);
    await ethers.provider.send("hardhat_setBalance", [cdoAddr, "0x56BC75E2D63100000"]);
    const cdoSigner = await ethers.getImpersonatedSigner(cdoAddr);
    await mockWeth.connect(cdoSigner).approve(await adapter.getAddress(), amount);
    await adapter.connect(cdoSigner).supply(amount);
    // Update WETH TVL in accounting
    await accounting.connect(cdoSigner).setJuniorWethTVL(await adapter.totalAssetsUSD());
  }

  beforeEach(async () => {
    [owner, seniorVault, mezzVault, juniorVault, other] = await ethers.getSigners();

    // --- Tokens ---
    const BaseFactory = await ethers.getContractFactory("MockBaseAsset");
    mockUSDai = await BaseFactory.deploy("USDai", "USDai");
    const WethFactory = await ethers.getContractFactory("MockWETH");
    mockWeth = await WethFactory.deploy();

    // --- Oracle (Chainlink 8-dec) ---
    const FeedFactory = await ethers.getContractFactory("MockChainlinkFeed");
    const mockFeed = await FeedFactory.deploy(8, ETH_PRICE);
    const OracleFactory = await ethers.getContractFactory("WETHPriceOracle");
    oracle = await OracleFactory.deploy(await mockFeed.getAddress());
    await oracle.recordPrice();

    // --- Aave mock ---
    const PoolFactory = await ethers.getContractFactory("MockAavePoolForAdapter");
    mockPool = await PoolFactory.deploy(await mockWeth.getAddress());

    // --- Swap Router + SwapFacility ---
    const RouterFactory = await ethers.getContractFactory("MockSwapRouter");
    mockRouter = await RouterFactory.deploy();
    await mockRouter.setRate(await mockWeth.getAddress(), await mockUSDai.getAddress(), 3000n * E18);
    await mockRouter.setRate(await mockUSDai.getAddress(), await mockWeth.getAddress(), E18 * E18 / (3000n * E18));
    await mockUSDai.mint(await mockRouter.getAddress(), 10_000_000n * E18);
    await mockWeth.mint(await mockRouter.getAddress(), 10_000n * E18);

    const SwapFactory = await ethers.getContractFactory("SwapFacility");
    swap = await SwapFactory.deploy(
      await mockRouter.getAddress(), await mockWeth.getAddress(), owner.address,
    );

    // --- Accounting ---
    const RiskFactory = await ethers.getContractFactory("RiskParams");
    const riskParams = await RiskFactory.deploy(owner.address);
    const AccFactory = await ethers.getContractFactory("Accounting");
    accounting = await AccFactory.deploy(owner.address, await riskParams.getAddress());

    // --- Predict CDO address: Strategy(+0), Adapter(+1), CDO(+2) ---
    const nonceBefore = await ethers.provider.getTransactionCount(owner.address);
    const predictedCDO = ethers.getCreateAddress({ from: owner.address, nonce: nonceBefore + 2 });

    const StratFactory = await ethers.getContractFactory("MockStrategy");
    strategy = await StratFactory.deploy(predictedCDO, await mockUSDai.getAddress());

    const AdapterFactory = await ethers.getContractFactory("AaveWETHAdapter");
    adapter = await AdapterFactory.deploy(
      await mockPool.getAddress(), await mockWeth.getAddress(),
      await oracle.getAddress(), predictedCDO,
    );

    const CDOFactory = await ethers.getContractFactory("PrimeCDO");
    cdo = await CDOFactory.deploy(
      await accounting.getAddress(), await strategy.getAddress(),
      await adapter.getAddress(), await oracle.getAddress(), await swap.getAddress(),
      await mockWeth.getAddress(),
      ethers.ZeroAddress, ethers.ZeroAddress, ethers.ZeroAddress, owner.address,
    );

    // --- Wire up ---
    await accounting.setCDO(await cdo.getAddress());
    await swap.connect(owner).setAuthorizedCDO(await cdo.getAddress(), true);
    await cdo.connect(owner).registerTranche(SENIOR, seniorVault.address);
    await cdo.connect(owner).registerTranche(MEZZ, mezzVault.address);
    await cdo.connect(owner).registerTranche(JUNIOR, juniorVault.address);
    await cdo.connect(owner).setJuniorShortfallPausePrice(0);

    // Fund strategy with base asset for withdrawals
    await mockUSDai.mint(await strategy.getAddress(), 10_000_000n * E18);
  });

  // ═══════════════════════════════════════════════════════════════════
  //  rebalanceSellWETH — permissionless
  // ═══════════════════════════════════════════════════════════════════

  describe("rebalanceSellWETH", () => {
    it("should sell excess WETH when ratio > target + tolerance (22%)", async () => {
      // Junior base TVL = 60,000 USDai
      await seedTVL(JUNIOR, 60_000n * E18);
      // WETH in Aave: 10 WETH × $3000 = $30,000
      // Junior TVL = 60,000 + 30,000 = 90,000
      // WETH ratio = 30,000/90,000 = 33.3% > 22% threshold
      await seedWETHInAave(10n * E18);

      const wethBefore = await adapter.totalAssets();
      await cdo.connect(other).rebalanceSellWETH();
      const wethAfter = await adapter.totalAssets();

      // WETH should have decreased (sold excess)
      expect(wethAfter).to.be.lt(wethBefore);

      // Target WETH USD at 20% of 90K TVL = 18K → 6 WETH
      // Excess = 10 - 6 = 4 WETH sold. Remaining ≈ 6 WETH.
      expect(wethAfter).to.be.gte(5n * E18); // ≥ 5 WETH
      expect(wethAfter).to.be.lte(7n * E18); // ≤ 7 WETH
    });

    it("should revert when ratio is within bounds", async () => {
      // Junior base TVL = 80,000
      await seedTVL(JUNIOR, 80_000n * E18);
      // WETH: 6 WETH × $3000 = $18,000
      // Junior TVL = 80,000 + 18,000 = 98,000
      // ratio = 18,000/98,000 ≈ 18.4% — within [18%, 22%]
      await seedWETHInAave(6n * E18);

      await expect(
        cdo.connect(other).rebalanceSellWETH(),
      ).to.be.revertedWithCustomError(cdo, "PrimeVaults__RatioWithinBounds");
    });

    it("should be callable by anyone (permissionless)", async () => {
      // Set up ratio > 22%
      await seedTVL(JUNIOR, 60_000n * E18);
      await seedWETHInAave(10n * E18);

      // Non-owner, non-vault address can call
      await expect(
        cdo.connect(other).rebalanceSellWETH(),
      ).to.not.be.reverted;
    });

    it("should emit RebalanceSellExecuted event", async () => {
      await seedTVL(JUNIOR, 60_000n * E18);
      await seedWETHInAave(10n * E18);

      await expect(
        cdo.connect(other).rebalanceSellWETH(),
      ).to.emit(cdo, "RebalanceSellExecuted");
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  rebalanceBuyWETH — governance only
  // ═══════════════════════════════════════════════════════════════════

  describe("rebalanceBuyWETH", () => {
    it("should buy WETH when ratio < target - tolerance (18%)", async () => {
      // Junior base TVL = 90,000
      await seedTVL(JUNIOR, 90_000n * E18);
      // WETH: 1 WETH × $3000 = $3,000
      // Junior TVL = 90,000 + 3,000 = 93,000
      // ratio = 3,000/93,000 ≈ 3.2% < 18%
      await seedWETHInAave(1n * E18);
      const wethBefore = await adapter.totalAssets();
      await cdo.connect(owner).rebalanceBuyWETH(50_000n * E18);
      const wethAfter = await adapter.totalAssets();

      // WETH in Aave should have increased
      expect(wethAfter).to.be.gt(wethBefore);
    });

    it("should revert when called by non-owner", async () => {
      await seedTVL(JUNIOR, 90_000n * E18);
      await seedWETHInAave(1n * E18);

      await expect(
        cdo.connect(other).rebalanceBuyWETH(10_000n * E18),
      ).to.be.revertedWithCustomError(cdo, "OwnableUnauthorizedAccount");
    });

    it("should revert when ratio is within bounds", async () => {
      // Junior base TVL = 80,000
      await seedTVL(JUNIOR, 80_000n * E18);
      // WETH: 6 WETH × $3000 = $18,000
      // ratio = 18,000/98,000 ≈ 18.4% — within bounds
      await seedWETHInAave(6n * E18);

      await expect(
        cdo.connect(owner).rebalanceBuyWETH(10_000n * E18),
      ).to.be.revertedWithCustomError(cdo, "PrimeVaults__RatioWithinBounds");
    });

    it("should respect maxRecall cap", async () => {
      // ratio ≈ 3.2% (very low)
      await seedTVL(JUNIOR, 90_000n * E18);
      await seedWETHInAave(1n * E18);

      // Small maxRecall = 3,000 (won't fully rebalance but caps exposure)
      const wethBefore = await adapter.totalAssets();
      await cdo.connect(owner).rebalanceBuyWETH(3_000n * E18);
      const wethAfter = await adapter.totalAssets();

      // Should have bought some WETH but capped by maxRecall
      const wethGained = wethAfter - wethBefore;
      // 3,000 USDai / 3000 = ~1 WETH max (minus slippage)
      expect(wethGained).to.be.lte(1n * E18 + E18 / 100n); // ≤ ~1.01 WETH
      expect(wethGained).to.be.gt(0n);
    });

    it("should emit RebalanceBuyExecuted event", async () => {
      await seedTVL(JUNIOR, 90_000n * E18);
      await seedWETHInAave(1n * E18);

      await expect(
        cdo.connect(owner).rebalanceBuyWETH(50_000n * E18),
      ).to.emit(cdo, "RebalanceBuyExecuted");
    });
  });
});
