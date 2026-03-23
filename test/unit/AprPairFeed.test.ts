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
  const STALE_AFTER = 172_800; // 48h

  // Helper to get UPDATER_FEED_ROLE hash
  let UPDATER_FEED_ROLE: string;

  beforeEach(async () => {
    [admin, updater, other] = await ethers.getSigners();

    // --- Mocks ---
    const PoolFactory = await ethers.getContractFactory("MockAavePool");
    mockPool = await PoolFactory.deploy();

    const ATokenFactory = await ethers.getContractFactory("MockAToken");
    aUsdc = await ATokenFactory.deploy("aUSDC", "aUSDC");
    aUsdt = await ATokenFactory.deploy("aUSDT", "aUSDT");

    await mockPool.setLiquidityRate(USDC, RATE_USDC_RAY);
    await mockPool.setLiquidityRate(USDT, RATE_USDT_RAY);
    await aUsdc.mint(admin.address, ethers.parseUnits("1000000", 18));
    await aUsdt.mint(admin.address, ethers.parseUnits("1000000", 18));

    const VaultFactory = await ethers.getContractFactory("MockERC4626");
    mockVault = await VaultFactory.deploy("sUSDai", "sUSDai", E18);

    // --- Provider ---
    const ProviderFactory = await ethers.getContractFactory("SUSDaiAprPairProvider");
    provider = await ProviderFactory.deploy(
      await mockPool.getAddress(), USDC, USDT,
      await aUsdc.getAddress(), await aUsdt.getAddress(),
      await mockVault.getAddress(),
    );

    // --- AprPairFeed ---
    const FeedFactory = await ethers.getContractFactory("AprPairFeed");
    feed = await FeedFactory.deploy(
      await provider.getAddress(),
      admin.address,
      STALE_AFTER,
    );

    UPDATER_FEED_ROLE = await feed.UPDATER_FEED_ROLE();

    // Grant updater role
    await feed.connect(admin).grantRole(UPDATER_FEED_ROLE, updater.address);
  });

  // ═══════════════════════════════════════════════════════════════════
  //  PUSH mode — updateRoundData(aprTarget, aprBase, timestamp)
  // ═══════════════════════════════════════════════════════════════════

  describe("PUSH mode", () => {
    it("should store a round with provided values", async () => {
      const now = BigInt(await time.latest()) + 1n;
      await time.setNextBlockTimestamp(Number(now));

      const aprTarget = 40_000_000_000n; // 4%
      const aprBase = 150_000_000_000n;  // 15%

      await feed.connect(updater)["updateRoundData(int64,int64,uint64)"](aprTarget, aprBase, now);

      expect(await feed.s_currentRoundId()).to.equal(1);

      const round = await feed.getRoundData(1);
      expect(round.aprTarget).to.equal(aprTarget);
      expect(round.aprBase).to.equal(aprBase);
      expect(round.timestamp).to.equal(now);
    });

    it("should emit RoundUpdated event", async () => {
      const now = BigInt(await time.latest()) + 1n;
      await time.setNextBlockTimestamp(Number(now));

      await expect(
        feed.connect(updater)["updateRoundData(int64,int64,uint64)"](40_000_000_000n, 150_000_000_000n, now),
      ).to.emit(feed, "RoundUpdated");
    });

    it("should store multiple rounds sequentially", async () => {
      let ts = BigInt(await time.latest());
      for (let i = 0; i < 5; i++) {
        ts += 100n;
        await time.setNextBlockTimestamp(Number(ts));
        await feed.connect(updater)["updateRoundData(int64,int64,uint64)"](
          BigInt(i) * 10_000_000_000n, BigInt(i) * 20_000_000_000n, ts,
        );
      }
      expect(await feed.s_currentRoundId()).to.equal(5);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  PULL mode — updateRoundData() calls provider
  // ═══════════════════════════════════════════════════════════════════

  describe("PULL mode", () => {
    it("should call provider.getAprPair() and store result", async () => {
      await time.increase(10);
      await feed.connect(updater)["updateRoundData()"]();

      expect(await feed.s_currentRoundId()).to.equal(1);

      const round = await feed.getRoundData(1);
      // aprTarget from Aave: (3%+5%)/2 = 4% = 40_000_000_000
      expect(round.aprTarget).to.equal(40_000_000_000n);
      // aprBase = 0 (first call, no prev snapshot)
      expect(round.aprBase).to.equal(0);
    });

    it("should store non-zero aprBase after provider has 2 snapshots", async () => {
      // First call: seeds provider prev snapshot
      await time.increase(86400);
      await feed.connect(updater)["updateRoundData()"]();

      // Increase vault rate (~15% APR)
      const dailyGrowth = (E18 * 15n) / (100n * 365n);
      await mockVault.setRate(E18 + dailyGrowth);

      // Second call: provider now has 2 snapshots
      await time.increase(86400);
      await feed.connect(updater)["updateRoundData()"]();

      const round = await feed.getRoundData(2);
      expect(round.aprBase).to.be.gt(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  latestRoundData — Feed mode
  // ═══════════════════════════════════════════════════════════════════

  describe("latestRoundData — Feed mode", () => {
    it("should return cached round if not stale", async () => {
      const now = BigInt(await time.latest()) + 10n;
      await time.setNextBlockTimestamp(Number(now));
      await feed.connect(updater)["updateRoundData(int64,int64,uint64)"](
        40_000_000_000n, 150_000_000_000n, now,
      );

      const round = await feed.latestRoundData.staticCall();
      expect(round.aprTarget).to.equal(40_000_000_000n);
      expect(round.aprBase).to.equal(150_000_000_000n);
      expect(round.roundId).to.equal(1);
    });

    it("should fall back to provider if cached round is stale", async () => {
      const now = BigInt(await time.latest()) + 10n;
      await time.setNextBlockTimestamp(Number(now));
      await feed.connect(updater)["updateRoundData(int64,int64,uint64)"](
        40_000_000_000n, 150_000_000_000n, now,
      );

      // Advance past staleAfter (48h)
      await time.increase(STALE_AFTER + 1);

      const round = await feed.latestRoundData.staticCall();
      // Falls back to provider — roundId = 0 (not from buffer)
      expect(round.roundId).to.equal(0);
      // aprTarget should come from Aave (4%)
      expect(round.aprTarget).to.equal(40_000_000_000n);
    });

    it("should revert if no round data and cache empty", async () => {
      // Feed mode, no rounds stored
      await expect(feed.latestRoundData.staticCall())
        .to.be.revertedWithCustomError(feed, "PrimeVaults__NoRoundData");
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  latestRoundData — Strategy mode
  // ═══════════════════════════════════════════════════════════════════

  describe("latestRoundData — Strategy mode", () => {
    it("should always call provider regardless of cache", async () => {
      await feed.connect(admin).setSourcePref(1); // Strategy = 1

      // Even with a cached round...
      const now = BigInt(await time.latest()) + 10n;
      await time.setNextBlockTimestamp(Number(now));
      await feed.connect(updater)["updateRoundData(int64,int64,uint64)"](
        99_000_000_000n, 99_000_000_000n, now,
      );

      // latestRoundData ignores cache, calls provider
      const round = await feed.latestRoundData.staticCall();
      expect(round.roundId).to.equal(0); // from provider, not buffer
      expect(round.aprTarget).to.equal(40_000_000_000n); // Aave 4%, not 99
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  Bounds validation
  // ═══════════════════════════════════════════════════════════════════

  describe("bounds validation", () => {
    it("should revert if aprTarget exceeds +200%", async () => {
      const now = BigInt(await time.latest()) + 10n;
      await time.setNextBlockTimestamp(Number(now));

      const tooHigh = 2_000_000_000_001n; // just over +200%
      await expect(
        feed.connect(updater)["updateRoundData(int64,int64,uint64)"](tooHigh, 0, now),
      ).to.be.revertedWithCustomError(feed, "PrimeVaults__AprOutOfBounds");
    });

    it("should revert if aprBase below -50%", async () => {
      const now = BigInt(await time.latest()) + 10n;
      await time.setNextBlockTimestamp(Number(now));

      const tooLow = -500_000_000_001n; // just below -50%
      await expect(
        feed.connect(updater)["updateRoundData(int64,int64,uint64)"](0, tooLow, now),
      ).to.be.revertedWithCustomError(feed, "PrimeVaults__AprOutOfBounds");
    });

    it("should accept values at boundaries", async () => {
      const now = BigInt(await time.latest()) + 10n;
      await time.setNextBlockTimestamp(Number(now));

      await expect(
        feed.connect(updater)["updateRoundData(int64,int64,uint64)"](
          2_000_000_000_000n, -500_000_000_000n, now,
        ),
      ).to.not.be.reverted;
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  Timestamp ordering
  // ═══════════════════════════════════════════════════════════════════

  describe("timestamp ordering", () => {
    it("should revert if timestamp is not increasing", async () => {
      const now = BigInt(await time.latest()) + 10n;
      await time.setNextBlockTimestamp(Number(now));
      await feed.connect(updater)["updateRoundData(int64,int64,uint64)"](0, 0, now);

      // Try to submit with same or older timestamp
      await time.setNextBlockTimestamp(Number(now) + 1);
      await expect(
        feed.connect(updater)["updateRoundData(int64,int64,uint64)"](0, 0, now), // same ts
      ).to.be.revertedWithCustomError(feed, "PrimeVaults__TimestampOutOfOrder");
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  getRoundData — historical access
  // ═══════════════════════════════════════════════════════════════════

  describe("getRoundData", () => {
    it("should return historical round by ID", async () => {
      let ts = BigInt(await time.latest());
      for (let i = 0; i < 3; i++) {
        ts += 100n;
        await time.setNextBlockTimestamp(Number(ts));
        await feed.connect(updater)["updateRoundData(int64,int64,uint64)"](
          BigInt(i + 1) * 10_000_000_000n, 0n, ts,
        );
      }

      const round1 = await feed.getRoundData(1);
      expect(round1.aprTarget).to.equal(10_000_000_000n);

      const round2 = await feed.getRoundData(2);
      expect(round2.aprTarget).to.equal(20_000_000_000n);
    });

    it("should revert if round has been overwritten (> 20 rounds)", async () => {
      let ts = BigInt(await time.latest());
      for (let i = 0; i < 21; i++) {
        ts += 100n;
        await time.setNextBlockTimestamp(Number(ts));
        await feed.connect(updater)["updateRoundData(int64,int64,uint64)"](0, 0, ts);
      }

      // Round 1 should be overwritten by round 21
      await expect(feed.getRoundData(1))
        .to.be.revertedWithCustomError(feed, "PrimeVaults__RoundNotAvailable");

      // Round 2 should still be accessible
      await expect(feed.getRoundData(2)).to.not.be.reverted;
    });

    it("should revert for roundId = 0", async () => {
      await expect(feed.getRoundData(0))
        .to.be.revertedWithCustomError(feed, "PrimeVaults__RoundNotAvailable");
    });

    it("should revert for roundId beyond current", async () => {
      await expect(feed.getRoundData(999))
        .to.be.revertedWithCustomError(feed, "PrimeVaults__RoundNotAvailable");
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  Access control
  // ═══════════════════════════════════════════════════════════════════

  describe("access control", () => {
    it("should revert PUSH updateRoundData when called without UPDATER_FEED_ROLE", async () => {
      const now = BigInt(await time.latest()) + 10n;
      await expect(
        feed.connect(other)["updateRoundData(int64,int64,uint64)"](0, 0, now),
      ).to.be.reverted;
    });

    it("should revert PULL updateRoundData when called without UPDATER_FEED_ROLE", async () => {
      await expect(
        feed.connect(other)["updateRoundData()"](),
      ).to.be.reverted;
    });

    it("should revert setSourcePref when called without DEFAULT_ADMIN_ROLE", async () => {
      await expect(
        feed.connect(other).setSourcePref(1),
      ).to.be.reverted;
    });

    it("should revert setStaleAfter when called without DEFAULT_ADMIN_ROLE", async () => {
      await expect(
        feed.connect(other).setStaleAfter(3600),
      ).to.be.reverted;
    });
  });
});
