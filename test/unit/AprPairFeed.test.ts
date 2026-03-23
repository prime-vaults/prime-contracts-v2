import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

describe("AprPairFeed", () => {
  let feed: any;
  let mockPool: any;
  let mockVault: any;
  let aaveProvider: any;
  let susdaiProvider: any;
  let aUsdc: any;
  let aUsdt: any;
  let owner: SignerWithAddress;
  let keeper: SignerWithAddress;
  let other: SignerWithAddress;

  const E18 = 10n ** 18n;
  const USDC = "0x0000000000000000000000000000000000000001";
  const USDT = "0x0000000000000000000000000000000000000002";

  // 3% and 5% in ray
  const RATE_USDC_RAY = 30000000000000000000000000n;
  const RATE_USDT_RAY = 50000000000000000000000000n;

  beforeEach(async () => {
    [owner, keeper, other] = await ethers.getSigners();

    // --- Mock Aave setup ---
    const PoolFactory = await ethers.getContractFactory("MockAavePool");
    mockPool = await PoolFactory.deploy();

    const ATokenFactory = await ethers.getContractFactory("MockAToken");
    aUsdc = await ATokenFactory.deploy("aUSDC", "aUSDC");
    aUsdt = await ATokenFactory.deploy("aUSDT", "aUSDT");

    await mockPool.setLiquidityRate(USDC, RATE_USDC_RAY);
    await mockPool.setLiquidityRate(USDT, RATE_USDT_RAY);
    await aUsdc.mint(owner.address, ethers.parseUnits("1000000", 18));
    await aUsdt.mint(owner.address, ethers.parseUnits("1000000", 18));

    const AaveFactory = await ethers.getContractFactory("AaveAprProvider");
    aaveProvider = await AaveFactory.deploy(
      await mockPool.getAddress(), USDC, USDT,
      await aUsdc.getAddress(), await aUsdt.getAddress(),
    );

    // --- Mock sUSDai setup ---
    const VaultFactory = await ethers.getContractFactory("MockERC4626");
    mockVault = await VaultFactory.deploy("sUSDai", "sUSDai", E18);

    const SUSDaiFactory = await ethers.getContractFactory("SUSDaiAprProvider");
    susdaiProvider = await SUSDaiFactory.deploy(
      await mockVault.getAddress(), keeper.address, owner.address,
    );

    // Take a second snapshot so fetchStrategyApr works
    await time.increase(86400);
    const newRate = E18 + (E18 * 15n) / (100n * 365n); // ~15% APR daily growth
    await mockVault.setRate(newRate);
    await susdaiProvider.connect(keeper).snapshot();

    // --- Deploy AprPairFeed ---
    const FeedFactory = await ethers.getContractFactory("AprPairFeed");
    feed = await FeedFactory.deploy(
      await aaveProvider.getAddress(),
      await susdaiProvider.getAddress(),
      owner.address,
    );
  });

  // ═══════════════════════════════════════════════════════════════════
  //  Constructor
  // ═══════════════════════════════════════════════════════════════════

  describe("constructor", () => {
    it("should set staleAfter to 48 hours", async () => {
      expect(await feed.s_staleAfter()).to.equal(172_800);
    });

    it("should not be in manual override mode", async () => {
      expect(await feed.s_manualOverride()).to.be.false;
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  updateRoundData
  // ═══════════════════════════════════════════════════════════════════

  describe("updateRoundData", () => {
    it("should cache both APRs from providers", async () => {
      await feed.updateRoundData();

      const aprTarget = await feed.s_aprTarget();
      const aprBase = await feed.s_aprBase();

      // Aave: equal supply of USDC (3%) and USDT (5%) → 4%
      expect(aprTarget).to.equal(40000000000000000n); // 0.04e18

      // sUSDai: ~15% APR
      expect(aprBase).to.be.gt(0);
    });

    it("should update lastUpdated timestamp", async () => {
      await feed.updateRoundData();
      expect(await feed.s_lastUpdated()).to.be.gt(0);
    });

    it("should emit AprUpdated event", async () => {
      await expect(feed.updateRoundData()).to.emit(feed, "AprUpdated");
    });

    it("should be callable by anyone (permissionless)", async () => {
      await expect(feed.connect(other).updateRoundData()).to.not.be.reverted;
    });

    it("should use manual values when in override mode", async () => {
      const manualTarget = (5n * E18) / 100n;
      const manualBase = (20n * E18) / 100n;
      await feed.connect(owner).setManualApr(manualTarget, manualBase);

      await feed.updateRoundData();

      expect(await feed.s_aprTarget()).to.equal(manualTarget);
      expect(await feed.s_aprBase()).to.equal(manualBase);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  getAprPair
  // ═══════════════════════════════════════════════════════════════════

  describe("getAprPair", () => {
    it("should return cached values after updateRoundData", async () => {
      await feed.updateRoundData();

      const [aprTarget, aprBase] = await feed.getAprPair();
      expect(aprTarget).to.equal(await feed.s_aprTarget());
      expect(aprBase).to.equal(await feed.s_aprBase());
    });

    it("should revert when stale (never updated)", async () => {
      await expect(feed.getAprPair())
        .to.be.revertedWithCustomError(feed, "PrimeVaults__StaleApr");
    });

    it("should revert when data exceeds staleAfter", async () => {
      await feed.updateRoundData();

      // Advance past 48h
      await time.increase(172_801);

      await expect(feed.getAprPair())
        .to.be.revertedWithCustomError(feed, "PrimeVaults__StaleApr");
    });

    it("should not revert at exactly staleAfter boundary", async () => {
      await feed.updateRoundData();
      await time.increase(172_800);

      await expect(feed.getAprPair()).to.not.be.reverted;
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  setManualApr / clearManualOverride
  // ═══════════════════════════════════════════════════════════════════

  describe("manual override", () => {
    it("should enable manual override with setManualApr", async () => {
      const target = (4n * E18) / 100n;
      const base = (12n * E18) / 100n;

      await expect(feed.connect(owner).setManualApr(target, base))
        .to.emit(feed, "ManualOverrideSet")
        .withArgs(target, base);

      expect(await feed.s_manualOverride()).to.be.true;
      expect(await feed.s_manualAprTarget()).to.equal(target);
      expect(await feed.s_manualAprBase()).to.equal(base);
    });

    it("should resume auto mode with clearManualOverride", async () => {
      await feed.connect(owner).setManualApr((4n * E18) / 100n, (12n * E18) / 100n);
      expect(await feed.s_manualOverride()).to.be.true;

      await expect(feed.connect(owner).clearManualOverride())
        .to.emit(feed, "ManualOverrideCleared");

      expect(await feed.s_manualOverride()).to.be.false;

      // updateRoundData should now use providers
      await feed.updateRoundData();
      const aprTarget = await feed.s_aprTarget();
      // Should be Aave rate (4%), not manual override
      expect(aprTarget).to.equal(40000000000000000n);
    });

    it("should revert setManualApr when called by non-owner", async () => {
      await expect(feed.connect(other).setManualApr(E18, E18))
        .to.be.revertedWithCustomError(feed, "OwnableUnauthorizedAccount");
    });

    it("should revert clearManualOverride when called by non-owner", async () => {
      await expect(feed.connect(other).clearManualOverride())
        .to.be.revertedWithCustomError(feed, "OwnableUnauthorizedAccount");
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  setStaleAfter
  // ═══════════════════════════════════════════════════════════════════

  describe("setStaleAfter", () => {
    it("should update staleness threshold", async () => {
      await feed.connect(owner).setStaleAfter(3600);
      expect(await feed.s_staleAfter()).to.equal(3600);
    });

    it("should revert when called by non-owner", async () => {
      await expect(feed.connect(other).setStaleAfter(3600))
        .to.be.revertedWithCustomError(feed, "OwnableUnauthorizedAccount");
    });
  });
});
