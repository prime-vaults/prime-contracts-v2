import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

const SENIOR = 0;
const MEZZ = 1;
const JUNIOR = 2;

describe("PrimeLens — Read-only aggregator", () => {
  let lens: any;
  let cdo: any;
  let accounting: any;
  let strategy: any;
  let adapter: any;
  let oracle: any;
  let redemptionPolicy: any;
  let erc20Cooldown: any;
  let sharesCooldown: any;
  let seniorVault: any;
  let mezzVault: any;
  let juniorVault: any;
  let mockUSDai: any;
  let mockWeth: any;
  let mockPool: any;

  let owner: SignerWithAddress;
  let alice: SignerWithAddress;
  let bob: SignerWithAddress;

  const E18 = 10n ** 18n;
  const E8 = 10n ** 8n;
  const ETH_PRICE = 3000n * E8;
  const DAY = 86400;

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
    [owner, alice, bob] = await ethers.getSigners();

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

    // --- Accounting ---
    const RiskFactory = await ethers.getContractFactory("RiskParams");
    const riskParams = await RiskFactory.deploy(owner.address);
    const AccFactory = await ethers.getContractFactory("Accounting");
    accounting = await AccFactory.deploy(owner.address, await riskParams.getAddress());

    // --- Cooldown handlers ---
    const EC20Factory = await ethers.getContractFactory("ERC20Cooldown");
    erc20Cooldown = await EC20Factory.deploy(owner.address, 3 * DAY, 3 * DAY);
    const SCFactory = await ethers.getContractFactory("SharesCooldown");
    sharesCooldown = await SCFactory.deploy(owner.address, 7 * DAY);

    // --- RedemptionPolicy ---
    const RPFactory = await ethers.getContractFactory("RedemptionPolicy");
    redemptionPolicy = await RPFactory.deploy(owner.address, await accounting.getAddress());

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
      await adapter.getAddress(), await oracle.getAddress(), ethers.ZeroAddress,
      await mockWeth.getAddress(),
      await redemptionPolicy.getAddress(), await erc20Cooldown.getAddress(),
      await sharesCooldown.getAddress(), owner.address,
    );

    // --- Deploy TrancheVaults ---
    const VaultFactory = await ethers.getContractFactory("TrancheVault");
    seniorVault = await VaultFactory.deploy(
      await cdo.getAddress(), SENIOR, await mockUSDai.getAddress(),
      await mockWeth.getAddress(), "PrimeVaults Senior", "pvSENIOR",
    );
    mezzVault = await VaultFactory.deploy(
      await cdo.getAddress(), MEZZ, await mockUSDai.getAddress(),
      await mockWeth.getAddress(), "PrimeVaults Mezzanine", "pvMEZZ",
    );
    juniorVault = await VaultFactory.deploy(
      await cdo.getAddress(), JUNIOR, await mockUSDai.getAddress(),
      await mockWeth.getAddress(), "PrimeVaults Junior", "pvJUNIOR",
    );

    // --- Wire up ---
    await accounting.setCDO(await cdo.getAddress());
    await cdo.connect(owner).registerTranche(SENIOR, await seniorVault.getAddress());
    await cdo.connect(owner).registerTranche(MEZZ, await mezzVault.getAddress());
    await cdo.connect(owner).registerTranche(JUNIOR, await juniorVault.getAddress());
    await cdo.connect(owner).setJuniorShortfallPausePrice(0);
    await erc20Cooldown.connect(owner).setAuthorized(await cdo.getAddress(), true);
    await sharesCooldown.connect(owner).setAuthorized(await cdo.getAddress(), true);

    // --- Deploy PrimeLens ---
    const LensFactory = await ethers.getContractFactory("PrimeLens");
    lens = await LensFactory.deploy(
      await cdo.getAddress(),
      await seniorVault.getAddress(),
      await mezzVault.getAddress(),
      await juniorVault.getAddress(),
    );

    // --- Seed some TVL ---
    await seedTVL(JUNIOR, 100_000n * E18);
  });

  // ═══════════════════════════════════════════════════════════════════
  //  getTrancheInfo
  // ═══════════════════════════════════════════════════════════════════

  describe("getTrancheInfo", () => {
    it("should return correct Senior tranche info", async () => {
      await seedTVL(SENIOR, 50_000n * E18);

      const info = await lens.getTrancheInfo(SENIOR);
      expect(info.vault).to.equal(await seniorVault.getAddress());
      expect(info.name).to.equal("PrimeVaults Senior");
      expect(info.symbol).to.equal("pvSENIOR");
      expect(info.totalAssets).to.equal(50_000n * E18);
      // No deposits through vault, so totalSupply = 0
      expect(info.totalSupply).to.equal(0n);
      // Share price = 1e18 when supply is 0
      expect(info.sharePrice).to.equal(E18);
    });

    it("should return correct share price after deposits", async () => {
      await seedTVL(JUNIOR, 400_000n * E18); // ensure coverage

      await mockUSDai.mint(alice.address, 100_000n * E18);
      await mockUSDai.connect(alice).approve(await seniorVault.getAddress(), ethers.MaxUint256);
      await seniorVault.connect(alice).deposit(10_000n * E18, alice.address);

      const info = await lens.getTrancheInfo(SENIOR);
      expect(info.totalAssets).to.equal(10_000n * E18);
      expect(info.totalSupply).to.equal(10_000n * E18);
      expect(info.sharePrice).to.equal(E18); // 1:1
    });

    it("should return Junior tranche info", async () => {
      const info = await lens.getTrancheInfo(JUNIOR);
      expect(info.vault).to.equal(await juniorVault.getAddress());
      expect(info.name).to.equal("PrimeVaults Junior");
      expect(info.totalAssets).to.equal(100_000n * E18);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  getAllTranches
  // ═══════════════════════════════════════════════════════════════════

  describe("getAllTranches", () => {
    it("should return all three tranches in one call", async () => {
      await seedTVL(SENIOR, 50_000n * E18);
      await seedTVL(MEZZ, 20_000n * E18);

      const [sr, mz, jr] = await lens.getAllTranches();
      expect(sr.name).to.equal("PrimeVaults Senior");
      expect(sr.totalAssets).to.equal(50_000n * E18);
      expect(mz.name).to.equal("PrimeVaults Mezzanine");
      expect(mz.totalAssets).to.equal(20_000n * E18);
      expect(jr.name).to.equal("PrimeVaults Junior");
      expect(jr.totalAssets).to.equal(100_000n * E18);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  getJuniorPosition
  // ═══════════════════════════════════════════════════════════════════

  describe("getJuniorPosition", () => {
    it("should return base/WETH split and ratio", async () => {
      // Jr base=100K already seeded. Add 10 WETH ($30K)
      await seedWETHInAave(10n * E18);

      const pos = await lens.getJuniorPosition();
      expect(pos.baseTVL).to.equal(100_000n * E18);
      expect(pos.wethTVL).to.be.gt(0n); // $30K in WETH
      expect(pos.totalTVL).to.equal(pos.baseTVL + pos.wethTVL);
      expect(pos.wethAmount).to.equal(10n * E18);
      expect(pos.currentRatio).to.be.gt(0n);
      // Ratio ≈ 30K / 130K ≈ 0.23 (23%)
      expect(pos.currentRatio).to.be.gte(22n * E18 / 100n);
      expect(pos.currentRatio).to.be.lte(24n * E18 / 100n);
    });

    it("should return 0 ratio when Junior TVL is 0", async () => {
      // Withdraw all Junior TVL
      const cdoAddr = await cdo.getAddress();
      await ethers.provider.send("hardhat_setBalance", [cdoAddr, "0x56BC75E2D63100000"]);
      const cdoSigner = await ethers.getImpersonatedSigner(cdoAddr);
      await accounting.connect(cdoSigner).recordWithdraw(JUNIOR, 100_000n * E18);

      const pos = await lens.getJuniorPosition();
      expect(pos.totalTVL).to.equal(0n);
      expect(pos.currentRatio).to.equal(0n);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  getProtocolHealth
  // ═══════════════════════════════════════════════════════════════════

  describe("getProtocolHealth", () => {
    it("should return TVLs and coverage ratios", async () => {
      await seedTVL(SENIOR, 10_000n * E18);
      await seedTVL(MEZZ, 5_000n * E18);

      const health = await lens.getProtocolHealth();
      expect(health.seniorTVL).to.equal(10_000n * E18);
      expect(health.mezzTVL).to.equal(5_000n * E18);
      expect(health.juniorTVL).to.equal(100_000n * E18);
      expect(health.totalTVL).to.equal(115_000n * E18);

      // cs = (10K+5K+100K)/10K = 11.5
      expect(health.coverageSenior).to.equal(115n * E18 / 10n);
      // cm = (5K+100K)/5K = 21
      expect(health.coverageMezz).to.equal(21n * E18);

      expect(health.shortfallPaused).to.be.false;
    });

    it("should return max coverage when Senior is 0", async () => {
      const health = await lens.getProtocolHealth();
      expect(health.coverageSenior).to.equal(ethers.MaxUint256);
    });

    it("should reflect shortfall pause state", async () => {
      // Artificially pause
      const cdoAddr = await cdo.getAddress();
      // Set pause price to max so any check triggers pause
      await cdo.connect(owner).setJuniorShortfallPausePrice(ethers.MaxUint256);

      // Create a mock Jr vault token for shortfall check
      const TokenFactory = await ethers.getContractFactory("MockBaseAsset");
      const mockJrVault = await TokenFactory.deploy("pvJR", "pvJR");
      await cdo.connect(owner).registerTranche(JUNIOR, await mockJrVault.getAddress());
      await mockJrVault.mint(alice.address, 10_000n * E18);

      // Trigger any action to check shortfall
      await mockUSDai.mint(alice.address, 100_000n * E18);
      const srVaultAddr = await seniorVault.getAddress();
      await mockUSDai.connect(alice).approve(srVaultAddr, ethers.MaxUint256);
      try { await seniorVault.connect(alice).deposit(100n * E18, alice.address); } catch {}

      // Re-register original jr vault for lens
      await cdo.connect(owner).registerTranche(JUNIOR, await juniorVault.getAddress());

      const health = await lens.getProtocolHealth();
      expect(health.shortfallPaused).to.be.true;
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  getUserPendingWithdraws
  // ═══════════════════════════════════════════════════════════════════

  describe("getUserPendingWithdraws", () => {
    it("should return empty array when user has no pending withdrawals", async () => {
      const withdraws = await lens.getUserPendingWithdraws(alice.address);
      expect(withdraws.length).to.equal(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  previewWithdrawCondition
  // ═══════════════════════════════════════════════════════════════════

  describe("previewWithdrawCondition", () => {
    it("should return NONE for Senior tranche (always instant)", async () => {
      const cond = await lens.previewWithdrawCondition(SENIOR);
      expect(cond.mechanism).to.equal(0); // NONE
    });

    it("should return coverage ratios alongside mechanism", async () => {
      await seedTVL(SENIOR, 10_000n * E18);
      await seedTVL(MEZZ, 5_000n * E18);

      const cond = await lens.previewWithdrawCondition(MEZZ);
      expect(cond.coverageSenior).to.be.gt(0n);
      expect(cond.coverageMezz).to.be.gt(0n);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  getClaimableWithdraws
  // ═══════════════════════════════════════════════════════════════════

  describe("getClaimableWithdraws", () => {
    it("should return empty array when user has no claimable withdrawals", async () => {
      const claimable = await lens.getClaimableWithdraws(alice.address);
      expect(claimable.length).to.equal(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  getWETHRebalanceStatus
  // ═══════════════════════════════════════════════════════════════════

  describe("getWETHRebalanceStatus", () => {
    it("should indicate needsSell when ratio > target + tolerance", async () => {
      // Jr base=100K, WETH=20 ETH ($60K), total=160K, ratio=60/160=37.5% > 22%
      await seedWETHInAave(20n * E18);

      const status = await lens.getWETHRebalanceStatus();
      expect(status.needsSell).to.be.true;
      expect(status.needsBuy).to.be.false;
      expect(status.excessOrDeficitUSD).to.be.gt(0n);
      expect(status.targetRatio).to.equal(2n * E18 / 10n); // 0.20e18
      expect(status.tolerance).to.equal(2n * E18 / 100n); // 0.02e18
    });

    it("should indicate needsBuy when ratio < target - tolerance", async () => {
      // Jr base=100K, WETH=0.5 ETH ($1500), total≈101.5K, ratio≈1.5% < 18%
      await seedWETHInAave(5n * E18 / 10n);

      const status = await lens.getWETHRebalanceStatus();
      expect(status.needsBuy).to.be.true;
      expect(status.needsSell).to.be.false;
      expect(status.excessOrDeficitUSD).to.be.gt(0n);
    });

    it("should indicate neither when ratio is within bounds", async () => {
      // Jr base=100K, need WETH ratio ≈ 20%. Target WETH USD = 25K → ~8.33 ETH
      // With 100K base + 25K WETH = 125K total, ratio = 25/125 = 20%
      await seedWETHInAave(833n * E18 / 100n); // ~8.33 WETH

      const status = await lens.getWETHRebalanceStatus();
      expect(status.needsSell).to.be.false;
      expect(status.needsBuy).to.be.false;
      expect(status.excessOrDeficitUSD).to.equal(0n);
    });

    it("should return correct WETH price and amount", async () => {
      await seedWETHInAave(5n * E18);

      const status = await lens.getWETHRebalanceStatus();
      expect(status.wethAmount).to.equal(5n * E18);
      expect(status.wethPrice).to.be.gt(0n);
      // wethValueUSD ≈ 5 × $3000 = $15,000
      expect(status.wethValueUSD).to.be.gte(14_000n * E18);
      expect(status.wethValueUSD).to.be.lte(16_000n * E18);
    });
  });
});
