import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

describe("SUSDaiAprProvider", () => {
  let provider: any;
  let mockVault: any;
  let owner: SignerWithAddress;
  let keeper: SignerWithAddress;
  let other: SignerWithAddress;

  const E18 = 10n ** 18n;
  const INITIAL_RATE = E18; // 1:1 at start

  beforeEach(async () => {
    [owner, keeper, other] = await ethers.getSigners();

    // Deploy mock sUSDai vault
    const VaultFactory = await ethers.getContractFactory("MockERC4626");
    mockVault = await VaultFactory.deploy("sUSDai", "sUSDai", INITIAL_RATE);

    // Deploy provider
    const Factory = await ethers.getContractFactory("SUSDaiAprProvider");
    provider = await Factory.deploy(
      await mockVault.getAddress(),
      keeper.address,
      owner.address,
    );
  });

  // ═══════════════════════════════════════════════════════════════════
  //  Constructor
  // ═══════════════════════════════════════════════════════════════════

  describe("constructor", () => {
    it("should seed first snapshot with current rate", async () => {
      const [rate, timestamp] = await provider.s_latestSnapshot();
      expect(rate).to.equal(INITIAL_RATE);
      expect(timestamp).to.be.gt(0);
    });

    it("should have zero prevSnapshot", async () => {
      const [rate, timestamp] = await provider.s_prevSnapshot();
      expect(rate).to.equal(0);
      expect(timestamp).to.equal(0);
    });

    it("should register initial keeper", async () => {
      expect(await provider.s_keepers(keeper.address)).to.be.true;
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  snapshot
  // ═══════════════════════════════════════════════════════════════════

  describe("snapshot", () => {
    it("should record new rate and shift previous", async () => {
      // Advance time + increase rate
      await time.increase(3600); // 1 hour
      const newRate = E18 + E18 / 1000n; // 1.001e18 (0.1% growth)
      await mockVault.setRate(newRate);

      await provider.connect(keeper).snapshot();

      const [latestRate] = await provider.s_latestSnapshot();
      const [prevRate] = await provider.s_prevSnapshot();
      expect(latestRate).to.equal(newRate);
      expect(prevRate).to.equal(INITIAL_RATE);
    });

    it("should emit SnapshotRecorded event", async () => {
      await time.increase(3600);
      const newRate = E18 + E18 / 100n;
      await mockVault.setRate(newRate);

      await expect(provider.connect(keeper).snapshot())
        .to.emit(provider, "SnapshotRecorded");
    });

    it("should revert if called too soon (< 1 hour)", async () => {
      await time.increase(1800); // 30 min — well under 1 hour
      await expect(provider.connect(keeper).snapshot())
        .to.be.revertedWithCustomError(provider, "PrimeVaults__SnapshotTooSoon");
    });

    it("should succeed at exactly 1 hour", async () => {
      await time.increase(3600);
      await expect(provider.connect(keeper).snapshot()).to.not.be.reverted;
    });

    it("should revert if caller is not keeper", async () => {
      await time.increase(3600);
      await expect(provider.connect(other).snapshot())
        .to.be.revertedWithCustomError(provider, "PrimeVaults__OnlyKeeper");
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  fetchStrategyApr
  // ═══════════════════════════════════════════════════════════════════

  describe("fetchStrategyApr", () => {
    it("should revert before second snapshot", async () => {
      await expect(provider.fetchStrategyApr())
        .to.be.revertedWithCustomError(provider, "PrimeVaults__NoSnapshotYet");
    });

    it("should compute correct annualized APR from 2 snapshots", async () => {
      // First snapshot was at deploy (rate = 1.0e18)
      // After 24h, rate increases to 1.00041e18 (~15% APR)
      const SECONDS_PER_DAY = 86400;
      await time.increase(SECONDS_PER_DAY);

      // 15% APR over 1 day = 15% / 365 ≈ 0.0411% daily growth
      // rate_new = 1e18 * (1 + 0.15/365) = 1e18 + 410958904109589
      const dailyGrowth = (15n * E18 / 100n) / 365n; // ~0.0411% in 1e18
      const newRate = E18 + dailyGrowth * E18 / E18;
      await mockVault.setRate(newRate);

      await provider.connect(keeper).snapshot();

      const apr = await provider.fetchStrategyApr();

      // APR = growth * 365 days / deltaT
      // growth = (newRate - INITIAL_RATE) * 1e18 / INITIAL_RATE
      // APR should be ~15% (0.15e18)
      const growth = (newRate - INITIAL_RATE) * E18 / INITIAL_RATE;
      const expectedApr = growth * BigInt(365 * SECONDS_PER_DAY) / BigInt(SECONDS_PER_DAY);

      // Allow 1% tolerance due to rounding
      const diff = apr > expectedApr ? apr - expectedApr : expectedApr - apr;
      expect(diff).to.be.lt(expectedApr / 100n);
    });

    it("should return 0 when rate decreases (negative yield)", async () => {
      await time.increase(86400);
      // Rate decreased
      await mockVault.setRate(E18 - E18 / 100n); // 0.99e18

      await provider.connect(keeper).snapshot();

      const apr = await provider.fetchStrategyApr();
      expect(apr).to.equal(0);
    });

    it("should return 0 when rate stays the same", async () => {
      await time.increase(86400);
      // Rate unchanged
      await provider.connect(keeper).snapshot();

      const apr = await provider.fetchStrategyApr();
      expect(apr).to.equal(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  fetchLiveApr
  // ═══════════════════════════════════════════════════════════════════

  describe("fetchLiveApr", () => {
    it("should return realtime estimate using live rate", async () => {
      // Advance time and increase rate
      await time.increase(86400);
      const newRate = E18 + E18 / 1000n; // 0.1% growth in 1 day
      await mockVault.setRate(newRate);

      const apr = await provider.fetchLiveApr();

      // growth = 0.001, APR = 0.001 * 365 = 0.365 (36.5%)
      // Allow some tolerance for block timestamp
      expect(apr).to.be.gt(0);
    });

    it("should return 0 if rate decreased", async () => {
      await time.increase(86400);
      await mockVault.setRate(E18 - 1n);

      const apr = await provider.fetchLiveApr();
      expect(apr).to.equal(0);
    });

    it("should return 0 if no time has passed", async () => {
      // Same block as constructor — deltaT = 0
      const apr = await provider.fetchLiveApr();
      expect(apr).to.equal(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  setKeeper
  // ═══════════════════════════════════════════════════════════════════

  describe("setKeeper", () => {
    it("should add a new keeper", async () => {
      await provider.connect(owner).setKeeper(other.address, true);
      expect(await provider.s_keepers(other.address)).to.be.true;

      // New keeper can snapshot
      await time.increase(3600);
      await expect(provider.connect(other).snapshot()).to.not.be.reverted;
    });

    it("should remove a keeper", async () => {
      await provider.connect(owner).setKeeper(keeper.address, false);
      expect(await provider.s_keepers(keeper.address)).to.be.false;

      await time.increase(3600);
      await expect(provider.connect(keeper).snapshot())
        .to.be.revertedWithCustomError(provider, "PrimeVaults__OnlyKeeper");
    });

    it("should emit KeeperUpdated event", async () => {
      await expect(provider.connect(owner).setKeeper(other.address, true))
        .to.emit(provider, "KeeperUpdated")
        .withArgs(other.address, true);
    });

    it("should revert when called by non-owner", async () => {
      await expect(provider.connect(other).setKeeper(other.address, true))
        .to.be.revertedWithCustomError(provider, "OwnableUnauthorizedAccount");
    });
  });
});
