import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

const SENIOR = 0;
const MEZZ = 1;
const JUNIOR = 2;

describe("PrimeCDO — Loss Coverage & Shortfall", () => {
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
  const ETH_PRICE = 3000n * E8;

  async function seedTVL(tranche: number, amount: bigint) {
    const cdoAddr = await cdo.getAddress();
    await ethers.provider.send("hardhat_setBalance", [cdoAddr, "0x56BC75E2D63100000"]);
    const cdoSigner = await ethers.getImpersonatedSigner(cdoAddr);
    await accounting.connect(cdoSigner).recordDeposit(tranche, amount);
    await mockUSDai.mint(await strategy.getAddress(), amount);
  }

  async function seedWETHInAave(amount: bigint) {
    const cdoAddr = await cdo.getAddress();
    await mockWeth.mint(cdoAddr, amount);
    await ethers.provider.send("hardhat_setBalance", [cdoAddr, "0x56BC75E2D63100000"]);
    const cdoSigner = await ethers.getImpersonatedSigner(cdoAddr);
    await mockWeth.connect(cdoSigner).approve(await adapter.getAddress(), amount);
    await adapter.connect(cdoSigner).supply(amount);
    await accounting.connect(cdoSigner).setJuniorWethTVL(await adapter.totalAssetsUSD());
  }

  beforeEach(async () => {
    [owner, seniorVault, mezzVault, juniorVault, other] = await ethers.getSigners();

    // --- Tokens ---
    const BaseFactory = await ethers.getContractFactory("MockBaseAsset");
    mockUSDai = await BaseFactory.deploy("USDai", "USDai");
    const WethFactory = await ethers.getContractFactory("MockWETH");
    mockWeth = await WethFactory.deploy();

    // --- Oracle ---
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
      ethers.ZeroAddress, ethers.ZeroAddress, ethers.ZeroAddress, ethers.ZeroAddress, owner.address,
    );

    // --- Wire up ---
    await accounting.setCDO(await cdo.getAddress());
    await swap.connect(owner).setAuthorizedCDO(await cdo.getAddress(), true);
    await cdo.connect(owner).registerTranche(SENIOR, seniorVault.address);
    await cdo.connect(owner).registerTranche(MEZZ, mezzVault.address);
    await cdo.connect(owner).registerTranche(JUNIOR, juniorVault.address);
    await cdo.connect(owner).setJuniorShortfallPausePrice(0);
  });

  // ═══════════════════════════════════════════════════════════════════
  //  executeWETHCoverage — Layer 0 of loss waterfall
  // ═══════════════════════════════════════════════════════════════════

  describe("executeWETHCoverage", () => {
    it("should sell WETH and inject proceeds into strategy", async () => {
      // Seed: 10 WETH in Aave ($30,000)
      await seedTVL(JUNIOR, 80_000n * E18);
      await seedWETHInAave(10n * E18);

      const wethBefore = await adapter.totalAssets();
      const strategyBefore = await strategy.totalAssets();

      // Cover $9,000 loss (= 3 WETH worth)
      await cdo.connect(owner).executeWETHCoverage(9_000n * E18);

      const wethAfter = await adapter.totalAssets();
      const strategyAfter = await strategy.totalAssets();

      // WETH decreased by ~3 WETH
      expect(wethBefore - wethAfter).to.be.gte(29n * E18 / 10n); // ≥ 2.9
      expect(wethBefore - wethAfter).to.be.lte(31n * E18 / 10n); // ≤ 3.1

      // Strategy increased by ~$9,000 (minus emergency slippage: 10%)
      // With mock router 1:1, output = 3 × 3000 = 9000, emergency slip = getMinOutput
      expect(strategyAfter - strategyBefore).to.be.gte(8_000n * E18); // at least 8K after slippage
    });

    it("should cap at available WETH when loss exceeds buffer", async () => {
      // Only 2 WETH in Aave ($6,000)
      await seedTVL(JUNIOR, 50_000n * E18);
      await seedWETHInAave(2n * E18);

      // Try to cover $15,000 (needs 5 WETH, but only 2 available)
      await cdo.connect(owner).executeWETHCoverage(15_000n * E18);

      // Should have sold all 2 WETH
      expect(await adapter.totalAssets()).to.equal(0n);
    });

    it("should emit WETHCoverageExecuted event", async () => {
      await seedTVL(JUNIOR, 80_000n * E18);
      await seedWETHInAave(10n * E18);

      await expect(
        cdo.connect(owner).executeWETHCoverage(9_000n * E18),
      ).to.emit(cdo, "WETHCoverageExecuted");
    });

    it("should revert with zero loss amount", async () => {
      await expect(
        cdo.connect(owner).executeWETHCoverage(0),
      ).to.be.revertedWithCustomError(cdo, "PrimeVaults__ZeroAmount");
    });

    it("should revert when called by non-owner", async () => {
      await expect(
        cdo.connect(other).executeWETHCoverage(1_000n * E18),
      ).to.be.revertedWithCustomError(cdo, "OwnableUnauthorizedAccount");
    });

    it("should update Junior WETH TVL in accounting after coverage", async () => {
      await seedTVL(JUNIOR, 80_000n * E18);
      await seedWETHInAave(10n * E18);

      const wethTVLBefore = await accounting.getJuniorWethTVL();
      await cdo.connect(owner).executeWETHCoverage(9_000n * E18);
      const wethTVLAfter = await accounting.getJuniorWethTVL();

      // WETH TVL should have decreased
      expect(wethTVLAfter).to.be.lt(wethTVLBefore);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  Loss waterfall: WETH → Jr base → Mz → Sr
  // ═══════════════════════════════════════════════════════════════════

  describe("loss waterfall ordering", () => {
    it("should use WETH buffer first (Layer 0) before Jr base absorbs loss", async () => {
      // Setup: Sr=100K, Mz=50K, Jr base=40K, WETH=5 ($15K)
      await seedTVL(SENIOR, 100_000n * E18);
      await seedTVL(MEZZ, 50_000n * E18);
      await seedTVL(JUNIOR, 40_000n * E18);
      await seedWETHInAave(5n * E18);

      const srBefore = await accounting.s_seniorTVL();
      const mzBefore = await accounting.s_mezzTVL();
      const jrBaseBefore = await accounting.s_juniorBaseTVL();

      // Execute WETH coverage for $12,000 loss
      await cdo.connect(owner).executeWETHCoverage(12_000n * E18);

      // Senior and Mezz TVL should be unchanged (WETH covers first)
      expect(await accounting.s_seniorTVL()).to.equal(srBefore);
      expect(await accounting.s_mezzTVL()).to.equal(mzBefore);
      // Jr base should be unchanged (WETH buffer absorbed the loss)
      expect(await accounting.s_juniorBaseTVL()).to.equal(jrBaseBefore);
      // WETH buffer decreased
      expect(await adapter.totalAssets()).to.be.lt(5n * E18);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  Shortfall auto-pause at 90% Junior price
  // ═══════════════════════════════════════════════════════════════════

  describe("shortfall auto-pause", () => {
    let mockJrVault: any;

    async function drainStrategy(amount: bigint) {
      const stratAddr = await strategy.getAddress();
      await ethers.provider.send("hardhat_setBalance", [stratAddr, "0x56BC75E2D63100000"]);
      const stratSigner = await ethers.getImpersonatedSigner(stratAddr);
      await mockUSDai.connect(stratSigner).transfer(owner.address, amount);
    }

    beforeEach(async () => {
      const TokenFactory = await ethers.getContractFactory("MockBaseAsset");
      mockJrVault = await TokenFactory.deploy("pvJUNIOR", "pvJR");
      await cdo.connect(owner).registerTranche(JUNIOR, await mockJrVault.getAddress());
      await mockJrVault.mint(other.address, 10_000n * E18);
    });

    it("should auto-pause when Junior exchange rate drops below 90%", async () => {
      await seedTVL(JUNIOR, 10_000n * E18);
      await cdo.connect(owner).setJuniorShortfallPausePrice(9n * E18 / 10n); // 0.9e18

      // Simulate 20% loss: Jr TVL drops from 10K to 8K AND reduce strategy assets
      const cdoAddr = await cdo.getAddress();
      await ethers.provider.send("hardhat_setBalance", [cdoAddr, "0x56BC75E2D63100000"]);
      const cdoSigner = await ethers.getImpersonatedSigner(cdoAddr);
      await accounting.connect(cdoSigner).recordWithdraw(JUNIOR, 2_000n * E18);
      // Also remove USDai from strategy so updateTVL sees the loss
      const stratAddr = await strategy.getAddress();
      await ethers.provider.send("hardhat_setBalance", [stratAddr, "0x56BC75E2D63100000"]);
      const stratSigner = await ethers.getImpersonatedSigner(stratAddr);
      await mockUSDai.connect(stratSigner).transfer(owner.address, 2_000n * E18);

      await seedTVL(SENIOR, 1_000n * E18);
      await mockUSDai.mint(seniorVault.address, 100_000n * E18);
      await mockUSDai.connect(seniorVault).approve(await cdo.getAddress(), ethers.MaxUint256);
      try {
        await cdo.connect(seniorVault).deposit(SENIOR, await mockUSDai.getAddress(), 100n * E18);
      } catch {}

      expect(await cdo.s_shortfallPaused()).to.be.true;
    });

    it("should emit ShortfallPauseTriggered event", async () => {
      await seedTVL(JUNIOR, 10_000n * E18);
      await seedTVL(SENIOR, 1_000n * E18);
      await cdo.connect(owner).setJuniorShortfallPausePrice(9n * E18 / 10n);

      const cdoAddr = await cdo.getAddress();
      await ethers.provider.send("hardhat_setBalance", [cdoAddr, "0x56BC75E2D63100000"]);
      const cdoSigner = await ethers.getImpersonatedSigner(cdoAddr);
      await accounting.connect(cdoSigner).recordWithdraw(JUNIOR, 2_000n * E18);
      await drainStrategy(2_000n * E18);

      await mockUSDai.mint(seniorVault.address, 100_000n * E18);
      await mockUSDai.connect(seniorVault).approve(await cdo.getAddress(), ethers.MaxUint256);

      // The deposit triggers _checkJuniorShortfall internally
      await expect(
        cdo.connect(seniorVault).deposit(SENIOR, await mockUSDai.getAddress(), 100n * E18),
      ).to.emit(cdo, "ShortfallPauseTriggered");
    });

    it("should NOT pause when loss is < 10% (price stays above 0.9)", async () => {
      await seedTVL(JUNIOR, 10_000n * E18);
      await seedTVL(SENIOR, 1_000n * E18);
      await cdo.connect(owner).setJuniorShortfallPausePrice(9n * E18 / 10n);

      // 5% loss: 10K → 9.5K, price = 0.95 > 0.9
      const cdoAddr = await cdo.getAddress();
      await ethers.provider.send("hardhat_setBalance", [cdoAddr, "0x56BC75E2D63100000"]);
      const cdoSigner = await ethers.getImpersonatedSigner(cdoAddr);
      await accounting.connect(cdoSigner).recordWithdraw(JUNIOR, 500n * E18);
      await drainStrategy(500n * E18);

      await mockUSDai.mint(seniorVault.address, 100_000n * E18);
      await mockUSDai.connect(seniorVault).approve(await cdo.getAddress(), ethers.MaxUint256);
      try {
        await cdo.connect(seniorVault).deposit(SENIOR, await mockUSDai.getAddress(), 100n * E18);
      } catch {}

      expect(await cdo.s_shortfallPaused()).to.be.false;
    });

    it("should block all deposits when shortfall paused", async () => {
      await seedTVL(JUNIOR, 10_000n * E18);
      await seedTVL(SENIOR, 1_000n * E18);
      await cdo.connect(owner).setJuniorShortfallPausePrice(9n * E18 / 10n);

      // Trigger pause
      const cdoAddr = await cdo.getAddress();
      await ethers.provider.send("hardhat_setBalance", [cdoAddr, "0x56BC75E2D63100000"]);
      const cdoSigner = await ethers.getImpersonatedSigner(cdoAddr);
      await accounting.connect(cdoSigner).recordWithdraw(JUNIOR, 2_000n * E18);
      await drainStrategy(2_000n * E18);

      await mockUSDai.mint(seniorVault.address, 100_000n * E18);
      await mockUSDai.connect(seniorVault).approve(await cdo.getAddress(), ethers.MaxUint256);
      try {
        await cdo.connect(seniorVault).deposit(SENIOR, await mockUSDai.getAddress(), 100n * E18);
      } catch {}
      expect(await cdo.s_shortfallPaused()).to.be.true;

      // Now all deposits should revert
      await expect(
        cdo.connect(seniorVault).deposit(SENIOR, await mockUSDai.getAddress(), 100n * E18),
      ).to.be.revertedWithCustomError(cdo, "PrimeVaults__ShortfallPaused");
    });

    it("should allow deposits again after owner unpauses", async () => {
      await seedTVL(JUNIOR, 10_000n * E18);
      await seedTVL(SENIOR, 1_000n * E18);
      await cdo.connect(owner).setJuniorShortfallPausePrice(9n * E18 / 10n);

      const cdoAddr = await cdo.getAddress();
      await ethers.provider.send("hardhat_setBalance", [cdoAddr, "0x56BC75E2D63100000"]);
      const cdoSigner = await ethers.getImpersonatedSigner(cdoAddr);
      await accounting.connect(cdoSigner).recordWithdraw(JUNIOR, 2_000n * E18);
      await drainStrategy(2_000n * E18);

      await mockUSDai.mint(seniorVault.address, 100_000n * E18);
      await mockUSDai.connect(seniorVault).approve(await cdo.getAddress(), ethers.MaxUint256);
      try {
        await cdo.connect(seniorVault).deposit(SENIOR, await mockUSDai.getAddress(), 100n * E18);
      } catch {}
      expect(await cdo.s_shortfallPaused()).to.be.true;

      await cdo.connect(owner).unpauseShortfall();
      await cdo.connect(owner).setJuniorShortfallPausePrice(0); // disable threshold

      await expect(
        cdo.connect(seniorVault).deposit(SENIOR, await mockUSDai.getAddress(), 100n * E18),
      ).to.not.be.reverted;
    });
  });
});
