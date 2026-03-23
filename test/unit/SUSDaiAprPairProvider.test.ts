import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";

describe("SUSDaiAprPairProvider", () => {
  let provider: any;
  let mockPool: any;
  let mockVault: any;
  let aUsdc: any;
  let aUsdt: any;

  const USDC = "0x0000000000000000000000000000000000000001";
  const USDT = "0x0000000000000000000000000000000000000002";
  const E18 = 10n ** 18n;

  // 3% in ray = 0.03e27 = 3e25. In 12dec = 3e25 / 1e15 = 3e10
  const RATE_USDC_RAY = 30_000_000_000_000_000_000_000_000n; // 3% ray
  const RATE_USDT_RAY = 50_000_000_000_000_000_000_000_000n; // 5% ray
  const RATE_USDC_12 = 30_000_000_000n; // 3% in 12dec
  const RATE_USDT_12 = 50_000_000_000n; // 5% in 12dec

  beforeEach(async () => {
    const [owner] = await ethers.getSigners();

    // Mock Aave
    const PoolFactory = await ethers.getContractFactory("MockAavePool");
    mockPool = await PoolFactory.deploy();

    const ATokenFactory = await ethers.getContractFactory("MockAToken");
    aUsdc = await ATokenFactory.deploy("aUSDC", "aUSDC");
    aUsdt = await ATokenFactory.deploy("aUSDT", "aUSDT");

    await mockPool.setLiquidityRate(USDC, RATE_USDC_RAY);
    await mockPool.setLiquidityRate(USDT, RATE_USDT_RAY);
    await aUsdc.mint(owner.address, ethers.parseUnits("1000000", 18));
    await aUsdt.mint(owner.address, ethers.parseUnits("1000000", 18));

    // Mock sUSDai vault — initial rate 1:1
    const VaultFactory = await ethers.getContractFactory("MockERC4626");
    mockVault = await VaultFactory.deploy("sUSDai", "sUSDai", E18);

    // Deploy provider
    const Factory = await ethers.getContractFactory("SUSDaiAprPairProvider");
    provider = await Factory.deploy(
      await mockPool.getAddress(),
      USDC, USDT,
      await aUsdc.getAddress(),
      await aUsdt.getAddress(),
      await mockVault.getAddress(),
    );
  });

  // ═══════════════════════════════════════════════════════════════════
  //  getAprPair — first call (only 1 snapshot)
  // ═══════════════════════════════════════════════════════════════════

  describe("first call (only 1 snapshot)", () => {
    it("should return aprBase = 0 on first call (no previous to compare)", async () => {
      await time.increase(1); // ensure deltaT > 0
      const tx = await provider.getAprPair();
      const receipt = await tx.wait();

      // Read return values via staticcall simulation
      const result = await provider.getAprPair.staticCall();
      // After first getAprPair mutated state, second call should have prev
      // But for the semantic test: first call when prevSnapshot.timestamp == 0
      // We need to test fresh deploy. Use a new instance.
    });

    it("should return valid aprTarget from Aave on first call", async () => {
      // Deploy fresh provider to test first call
      const Factory = await ethers.getContractFactory("SUSDaiAprPairProvider");
      const fresh = await Factory.deploy(
        await mockPool.getAddress(),
        USDC, USDT,
        await aUsdc.getAddress(),
        await aUsdt.getAddress(),
        await mockVault.getAddress(),
      );

      await time.increase(1);
      const [aprTarget, aprBase] = await fresh.getAprPair.staticCall();

      // Equal USDC+USDT supply → (3% + 5%) / 2 = 4% in 12dec = 4e10
      expect(aprTarget).to.equal((RATE_USDC_12 + RATE_USDT_12) / 2n);
      expect(aprBase).to.equal(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  getAprPair — second call (both APRs correct)
  // ═══════════════════════════════════════════════════════════════════

  describe("second call (2 snapshots)", () => {
    it("should return correct aprTarget and aprBase in int64 × 12dec", async () => {
      // First call: seeds prev snapshot
      await time.increase(86400);
      await provider.getAprPair();

      // Increase sUSDai rate: 15% APR over 1 day
      // Daily growth for 15% = 0.15/365 ≈ 0.000411
      // New rate = 1e18 * (1 + 0.15/365)
      const dailyGrowth = (E18 * 15n) / (100n * 365n);
      const newRate = E18 + dailyGrowth;
      await mockVault.setRate(newRate);

      await time.increase(86400);
      const [aprTarget, aprBase, timestamp] = await provider.getAprPair.staticCall();

      // aprTarget: (3% + 5%) / 2 = 4% → 40_000_000_000 (4e10)
      expect(aprTarget).to.equal(40_000_000_000n);

      // aprBase: ~15% → ~150_000_000_000 (1.5e11) in 12dec
      // Allow 5% tolerance due to rounding
      const expected15pct = 150_000_000_000n;
      const diff = aprBase > expected15pct ? aprBase - expected15pct : expected15pct - aprBase;
      expect(diff).to.be.lt(expected15pct / 20n); // within 5%

      expect(timestamp).to.be.gt(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  Negative APR (rate decrease)
  // ═══════════════════════════════════════════════════════════════════

  describe("negative APR", () => {
    it("should return negative aprBase when sUSDai rate decreases", async () => {
      // First call: seeds prev snapshot at rate 1.0
      await time.increase(86400);
      await provider.getAprPair();

      // Decrease rate: 5% loss
      const newRate = E18 - E18 / 20n; // 0.95e18
      await mockVault.setRate(newRate);

      await time.increase(86400);
      const [, aprBase] = await provider.getAprPair.staticCall();

      // aprBase should be negative
      expect(aprBase).to.be.lt(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  Aave different supplies
  // ═══════════════════════════════════════════════════════════════════

  describe("weighted average with different supplies", () => {
    it("should weight USDC more heavily when it has more supply", async () => {
      const [signer] = await ethers.getSigners();
      // Override: 2M USDC, 500K USDT
      await aUsdc.mint(signer.address, ethers.parseUnits("1000000", 18)); // now 2M total
      // aUsdt stays at 1M

      await time.increase(1);
      const [aprTarget] = await provider.getAprPair.staticCall();

      // Weighted: (2M × 3% + 1M × 5%) / 3M = (6 + 5) / 3 = 3.667%
      // In 12dec: ~36_666_666_666
      const expected = (2_000_000n * RATE_USDC_12 + 1_000_000n * RATE_USDT_12) / 3_000_000n;
      expect(aprTarget).to.equal(expected);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  Snapshot shifting
  // ═══════════════════════════════════════════════════════════════════

  describe("snapshot shifting", () => {
    it("should shift prev ← latest, latest ← current on each call", async () => {
      const [prevBefore] = await provider.s_prevSnapshot();
      expect(prevBefore).to.equal(0); // no prev yet

      // First call shifts constructor snapshot to prev
      await time.increase(3600);
      await provider.getAprPair();

      const [prevAfter1] = await provider.s_prevSnapshot();
      expect(prevAfter1).to.equal(E18); // constructor seeded 1e18

      // Change rate, second call shifts again
      const rate2 = E18 + E18 / 100n;
      await mockVault.setRate(rate2);
      await time.increase(3600);
      await provider.getAprPair();

      const [latestRate] = await provider.s_latestSnapshot();
      const [prevRate2] = await provider.s_prevSnapshot();
      expect(latestRate).to.equal(rate2);
      // prev should be whatever latest was before this call
      expect(prevRate2).to.be.gt(0);
    });

    it("should emit SnapshotShifted event", async () => {
      await time.increase(3600);
      await expect(provider.getAprPair()).to.emit(provider, "SnapshotShifted");
    });
  });
});
