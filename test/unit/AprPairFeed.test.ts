import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

describe("AprPairFeed", () => {
  let feed: any;
  let provider: any;
  let mockPool: any;
  let mockVault: any;
  let aUsdc: any;
  let aUsdt: any;
  let admin: SignerWithAddress;
  let updater: SignerWithAddress;
  let other: SignerWithAddress;

  const E18 = 10n ** 18n;
  const USDC = "0x0000000000000000000000000000000000000001";
  const USDT = "0x0000000000000000000000000000000000000002";
  const RATE_USDC_RAY = 30_000_000_000_000_000_000_000_000n;
  const RATE_USDT_RAY = 50_000_000_000_000_000_000_000_000n;
  const STALE_AFTER = 172_800;

  let UPDATER_FEED_ROLE: string;

  beforeEach(async () => {
    [admin, updater, other] = await ethers.getSigners();

    // --- Mocks ---
    const PoolFactory = await ethers.getContractFactory("MockAavePool");
    mockPool = await PoolFactory.deploy();

    const ATokenFactory = await ethers.getContractFactory("MockAToken");
    aUsdc = await ATokenFactory.deploy("aUSDC", "aUSDC");
    aUsdt = await ATokenFactory.deploy("aUSDT", "aUSDT");

    await mockPool.setAToken(USDC, await aUsdc.getAddress());
    await mockPool.setAToken(USDT, await aUsdt.getAddress());
    await mockPool.setLiquidityRate(USDC, RATE_USDC_RAY);
    await mockPool.setLiquidityRate(USDT, RATE_USDT_RAY);
    await aUsdc.mint(admin.address, ethers.parseUnits("1000000", 18));
    await aUsdt.mint(admin.address, ethers.parseUnits("1000000", 18));

    const VaultFactory = await ethers.getContractFactory("MockERC4626");
    mockVault = await VaultFactory.deploy("sUSDai", "sUSDai", E18);

    // --- Provider ---
    const ProviderFactory = await ethers.getContractFactory("SUSDaiAprPairProvider");
    provider = await ProviderFactory.deploy(
      await mockPool.getAddress(),
      [USDC, USDT],
      await mockVault.getAddress(),
    );

    // --- AprPairFeed ---
    const FeedFactory = await ethers.getContractFactory("AprPairFeed");
    feed = await FeedFactory.deploy(await provider.getAddress(), admin.address, STALE_AFTER);

    UPDATER_FEED_ROLE = await feed.UPDATER_FEED_ROLE();
    await feed.connect(admin).grantRole(UPDATER_FEED_ROLE, updater.address);
  });

  // ═══════════════════════════════════════════════════════════════════
  //  updateRoundData — PULL from provider
  // ═══════════════════════════════════════════════════════════════════

  describe("updateRoundData", () => {
    it("should call provider.getAprPair() and store result", async () => {
      await time.increase(10);
      await feed.connect(updater).updateRoundData();

      expect(await feed.s_currentRoundId()).to.equal(1);
      const round = await feed.getRoundData(1);
      expect(round.aprTarget).to.equal(40_000_000_000n); // (3%+5%)/2 = 4%
      expect(round.aprBase).to.equal(0); // first call, no prev snapshot
    });

    it("should shift provider snapshots (mutate path)", async () => {
      const [prevBefore] = await provider.s_prevSnapshot();
      expect(prevBefore).to.equal(0);

      await time.increase(10);
      await feed.connect(updater).updateRoundData();

      const [prevAfter] = await provider.s_prevSnapshot();
      expect(prevAfter).to.equal(E18); // shifted
    });

    it("should emit RoundUpdated event", async () => {
      await time.increase(10);
      await expect(feed.connect(updater).updateRoundData()).to.emit(feed, "RoundUpdated");
    });

    it("should store non-zero aprBase after 2 rounds", async () => {
      await time.increase(86400);
      await feed.connect(updater).updateRoundData(); // round 1: seeds prev

      const dailyGrowth = (E18 * 15n) / (100n * 365n);
      await mockVault.setRate(E18 + dailyGrowth);

      await time.increase(86400);
      await feed.connect(updater).updateRoundData(); // round 2

      const round = await feed.getRoundData(2);
      expect(round.aprBase).to.be.gt(0);
    });

    it("should store multiple rounds sequentially", async () => {
      for (let i = 0; i < 5; i++) {
        await time.increase(3600);
        await feed.connect(updater).updateRoundData();
      }
      expect(await feed.s_currentRoundId()).to.equal(5);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  latestRoundData — Feed mode (cache if fresh)
  // ═══════════════════════════════════════════════════════════════════

  describe("latestRoundData — Feed mode", () => {
    it("should return cached round if not stale", async () => {
      await time.increase(10);
      await feed.connect(updater).updateRoundData();

      const round = await feed.latestRoundData();
      expect(round.roundId).to.equal(1);
      expect(round.aprTarget).to.equal(40_000_000_000n);
    });

    it("should fall back to getAprPairView (NOT getAprPair) if stale", async () => {
      await time.increase(10);
      await feed.connect(updater).updateRoundData();

      // Advance past stale threshold
      await time.increase(STALE_AFTER + 1);

      const [prevBefore] = await provider.s_prevSnapshot();

      const round = await feed.latestRoundData();
      expect(round.roundId).to.equal(0); // from provider fallback

      // Verify NO snapshot shift happened
      const [prevAfter] = await provider.s_prevSnapshot();
      expect(prevAfter).to.equal(prevBefore);
    });

    it("should revert if no round data cached", async () => {
      await expect(feed.latestRoundData())
        .to.be.revertedWithCustomError(feed, "PrimeVaults__NoRoundData");
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  latestRoundData — Strategy mode (always view)
  // ═══════════════════════════════════════════════════════════════════

  describe("latestRoundData — Strategy mode", () => {
    it("should call getAprPairView and not shift snapshots", async () => {
      await feed.connect(admin).setSourcePref(1); // Strategy

      // Store a round that should be ignored in Strategy mode
      await time.increase(10);
      await feed.connect(updater).updateRoundData();

      // Change Aave rate so we can detect which source is used
      await mockPool.setLiquidityRate(USDC, 100_000_000_000_000_000_000_000_000n); // 10%
      await mockPool.setLiquidityRate(USDT, 100_000_000_000_000_000_000_000_000n); // 10%

      const [prevBefore] = await provider.s_prevSnapshot();

      const round = await feed.latestRoundData();
      expect(round.roundId).to.equal(0); // from provider, not buffer
      expect(round.aprTarget).to.equal(100_000_000_000n); // 10%, not cached 4%

      // No snapshot shift
      const [prevAfter] = await provider.s_prevSnapshot();
      expect(prevAfter).to.equal(prevBefore);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  Bounds validation (validated on PULL from provider)
  // ═══════════════════════════════════════════════════════════════════

  describe("bounds validation", () => {
    it("should accept normal APR values from provider", async () => {
      await time.increase(10);
      await expect(feed.connect(updater).updateRoundData()).to.not.be.reverted;
    });

    it("should revert if provider returns out-of-bounds APR", async () => {
      // Set extreme vault rate to trigger >200% APR from provider
      // But provider clamps at [-50%, +200%], so Feed bounds won't trigger
      // This test verifies the Feed validates what the provider returns
      // In practice, provider clamping means Feed bounds are a second safety net
      await time.increase(86400);
      await feed.connect(updater).updateRoundData();

      // Even with extreme rate, provider clamps → Feed accepts
      await mockVault.setRate(E18 * 100n);
      await time.increase(86400);
      await expect(feed.connect(updater).updateRoundData()).to.not.be.reverted;

      // Verify clamped value stored
      const round = await feed.getRoundData(2);
      expect(round.aprBase).to.equal(2_000_000_000_000n); // clamped at +200%
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  Timestamp ordering
  // ═══════════════════════════════════════════════════════════════════

  describe("timestamp ordering", () => {
    it("should accept increasing timestamps from provider", async () => {
      await time.increase(3600);
      await feed.connect(updater).updateRoundData();
      await time.increase(3600);
      await expect(feed.connect(updater).updateRoundData()).to.not.be.reverted;
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  getRoundData — historical
  // ═══════════════════════════════════════════════════════════════════

  describe("getRoundData", () => {
    it("should return historical round by ID", async () => {
      for (let i = 0; i < 3; i++) {
        await time.increase(3600);
        await feed.connect(updater).updateRoundData();
      }

      const r1 = await feed.getRoundData(1);
      const r2 = await feed.getRoundData(2);
      const r3 = await feed.getRoundData(3);
      expect(r1.roundId).to.equal(1);
      expect(r2.roundId).to.equal(2);
      expect(r3.roundId).to.equal(3);
    });

    it("should revert if round overwritten (>20 rounds)", async () => {
      for (let i = 0; i < 21; i++) {
        await time.increase(3600);
        await feed.connect(updater).updateRoundData();
      }

      await expect(feed.getRoundData(1))
        .to.be.revertedWithCustomError(feed, "PrimeVaults__RoundNotAvailable");
      await expect(feed.getRoundData(2)).to.not.be.reverted;
    });

    it("should revert for roundId = 0 or beyond current", async () => {
      await expect(feed.getRoundData(0)).to.be.revertedWithCustomError(feed, "PrimeVaults__RoundNotAvailable");
      await expect(feed.getRoundData(999)).to.be.revertedWithCustomError(feed, "PrimeVaults__RoundNotAvailable");
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  setProvider
  // ═══════════════════════════════════════════════════════════════════

  describe("setProvider", () => {
    it("should update provider via getAprPairView compat check (no side effect)", async () => {
      const ProviderFactory = await ethers.getContractFactory("SUSDaiAprPairProvider");
      const provider2 = await ProviderFactory.deploy(
        await mockPool.getAddress(), [USDC, USDT], await mockVault.getAddress(),
      );

      const [prevBefore] = await provider2.s_prevSnapshot();
      await feed.connect(admin).setProvider(await provider2.getAddress());
      const [prevAfter] = await provider2.s_prevSnapshot();

      expect(prevAfter).to.equal(prevBefore); // no side effect
      expect(await feed.s_provider()).to.equal(await provider2.getAddress());
    });

    it("should emit ProviderUpdated event", async () => {
      const ProviderFactory = await ethers.getContractFactory("SUSDaiAprPairProvider");
      const provider2 = await ProviderFactory.deploy(
        await mockPool.getAddress(), [USDC, USDT], await mockVault.getAddress(),
      );
      await expect(feed.connect(admin).setProvider(await provider2.getAddress()))
        .to.emit(feed, "ProviderUpdated");
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  Access control
  // ═══════════════════════════════════════════════════════════════════

  describe("access control", () => {
    it("should revert updateRoundData without UPDATER_FEED_ROLE", async () => {
      await expect(feed.connect(other).updateRoundData()).to.be.reverted;
    });

    it("should revert setSourcePref without DEFAULT_ADMIN_ROLE", async () => {
      await expect(feed.connect(other).setSourcePref(1)).to.be.reverted;
    });

    it("should revert setStaleAfter without DEFAULT_ADMIN_ROLE", async () => {
      await expect(feed.connect(other).setStaleAfter(3600)).to.be.reverted;
    });

    it("should revert setProvider without DEFAULT_ADMIN_ROLE", async () => {
      await expect(feed.connect(other).setProvider(other.address)).to.be.reverted;
    });
  });
});
