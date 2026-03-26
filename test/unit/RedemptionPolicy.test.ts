import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

// CooldownMechanism enum
const NONE = 0;
const ASSETS_LOCK = 1;
const SHARES_LOCK = 2;

// TrancheId
const SENIOR = 0;
const MEZZ = 1;
const JUNIOR = 2;

describe("RedemptionPolicy", () => {
  let policy: any;
  let accounting: any;
  let owner: SignerWithAddress;
  let cdo: SignerWithAddress;
  let other: SignerWithAddress;

  const E18 = 10n ** 18n;

  beforeEach(async () => {
    [owner, cdo, other] = await ethers.getSigners();

    // Deploy Accounting (using dummy addresses for aprFeed/riskParams)
    const AccFactory = await ethers.getContractFactory("Accounting");
    accounting = await AccFactory.deploy(owner.address, owner.address);
    await accounting.setCDO(cdo.address);

    // Deploy RedemptionPolicy
    const PolicyFactory = await ethers.getContractFactory("RedemptionPolicy");
    policy = await PolicyFactory.deploy(owner.address, await accounting.getAddress());
  });

  /**
   * Helper: set TVLs to achieve desired coverage.
   * coverage = (sr + mz + jr) / jr
   */
  async function setTVLs(sr: bigint, mz: bigint, jrBase: bigint, jrWeth: bigint) {
    // Reset by depositing exact amounts (accounting starts at 0)
    if (sr > 0n) await accounting.connect(cdo).recordDeposit(SENIOR, sr);
    if (mz > 0n) await accounting.connect(cdo).recordDeposit(MEZZ, mz);
    if (jrBase > 0n) await accounting.connect(cdo).recordDeposit(JUNIOR, jrBase);
    if (jrWeth > 0n) await accounting.connect(cdo).setJuniorWethTVL(jrWeth);
  }

  // ═══════════════════════════════════════════════════════════════════
  //  Default ranges (constructor)
  // ═══════════════════════════════════════════════════════════════════

  describe("default ranges", () => {
    it("should have 2 ranges configured", async () => {
      expect(await policy.rangeCount()).to.equal(2);
    });

    it("should have range[0] = 1.5x → ASSETS_LOCK, 10 bps (ascending)", async () => {
      const r = await policy.s_ranges(0);
      expect(r.minCoverage).to.equal(15n * E18 / 10n);
      expect(r.mechanism).to.equal(ASSETS_LOCK);
      expect(r.feeBps).to.equal(10);
    });

    it("should have range[1] = 2.0x → NONE, 0 bps (ascending)", async () => {
      const r = await policy.s_ranges(1);
      expect(r.minCoverage).to.equal(2n * E18);
      expect(r.mechanism).to.equal(NONE);
      expect(r.feeBps).to.equal(0);
    });

    it("should have default = SHARES_LOCK, 50 bps", async () => {
      expect(await policy.s_defaultMechanism()).to.equal(SHARES_LOCK);
      expect(await policy.s_defaultFeeBps()).to.equal(50);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  Coverage > 2.0x → NONE, 0 fee
  // ═══════════════════════════════════════════════════════════════════

  describe("coverage > 2.0x", () => {
    it("should return NONE with 0 fee at 10x coverage", async () => {
      // Sr=7M, Mz=2M, Jr=1M → coverage = 10x
      await setTVLs(7_000n * E18, 2_000n * E18, 800n * E18, 200n * E18);

      const result = await policy.evaluate();
      expect(result.mechanism).to.equal(NONE);
      expect(result.feeBps).to.equal(0);
    });

    it("should return NONE at exactly 2.0x coverage", async () => {
      // coverage = (1000 + 0 + 1000) / 1000 = 2.0x
      await setTVLs(1_000n * E18, 0n, 1_000n * E18, 0n);

      const result = await policy.evaluate();
      expect(result.mechanism).to.equal(NONE);
      expect(result.feeBps).to.equal(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  Coverage 1.5-2.0x → ASSETS_LOCK, 10 bps
  // ═══════════════════════════════════════════════════════════════════

  describe("coverage 1.5-2.0x", () => {
    it("should return ASSETS_LOCK with 10 bps fee at 1.8x", async () => {
      // coverage = (800 + 0 + 1000) / 1000 = 1.8x
      await setTVLs(800n * E18, 0n, 1_000n * E18, 0n);

      const result = await policy.evaluate();
      expect(result.mechanism).to.equal(ASSETS_LOCK);
      expect(result.feeBps).to.equal(10);
    });

    it("should return ASSETS_LOCK at exactly 1.5x", async () => {
      // coverage = (500 + 0 + 1000) / 1000 = 1.5x
      await setTVLs(500n * E18, 0n, 1_000n * E18, 0n);

      const result = await policy.evaluate();
      expect(result.mechanism).to.equal(ASSETS_LOCK);
      expect(result.feeBps).to.equal(10);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  Coverage < 1.5x → SHARES_LOCK, 50 bps
  // ═══════════════════════════════════════════════════════════════════

  describe("coverage < 1.5x", () => {
    it("should return SHARES_LOCK with 50 bps fee at 1.2x", async () => {
      // coverage = (200 + 0 + 1000) / 1000 = 1.2x
      await setTVLs(200n * E18, 0n, 1_000n * E18, 0n);

      const result = await policy.evaluate();
      expect(result.mechanism).to.equal(SHARES_LOCK);
      expect(result.feeBps).to.equal(50);
    });

    it("should return SHARES_LOCK at 1.05x", async () => {
      // coverage = (50 + 0 + 1000) / 1000 = 1.05x
      await setTVLs(50n * E18, 0n, 1_000n * E18, 0n);

      const result = await policy.evaluate();
      expect(result.mechanism).to.equal(SHARES_LOCK);
      expect(result.feeBps).to.equal(50);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  evaluateForCoverage — direct coverage input
  // ═══════════════════════════════════════════════════════════════════

  describe("evaluateForCoverage", () => {
    it("should return NONE for 3.0x", async () => {
      const result = await policy.evaluateForCoverage(3n * E18);
      expect(result.mechanism).to.equal(NONE);
    });

    it("should return ASSETS_LOCK for 1.7x", async () => {
      const result = await policy.evaluateForCoverage(17n * E18 / 10n);
      expect(result.mechanism).to.equal(ASSETS_LOCK);
    });

    it("should return SHARES_LOCK for 1.0x", async () => {
      const result = await policy.evaluateForCoverage(E18);
      expect(result.mechanism).to.equal(SHARES_LOCK);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  getCurrentCoverage
  // ═══════════════════════════════════════════════════════════════════

  describe("getCurrentCoverage", () => {
    it("should read from accounting", async () => {
      await setTVLs(7_000n * E18, 2_000n * E18, 800n * E18, 200n * E18);

      const coverage = await policy.getCurrentCoverage();
      // (7000 + 2000 + 1000) / 1000 = 10x
      expect(coverage).to.equal(10n * E18);
    });

    it("should return max uint256 for empty protocol", async () => {
      const coverage = await policy.getCurrentCoverage();
      expect(coverage).to.equal(ethers.MaxUint256);
    });

    it("should return 0 when jr=0 but pool>0 (no protection)", async () => {
      await setTVLs(1_000n * E18, 0n, 0n, 0n);
      const coverage = await policy.getCurrentCoverage();
      expect(coverage).to.equal(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  setRanges
  // ═══════════════════════════════════════════════════════════════════

  describe("setRanges", () => {
    it("should update ranges and default", async () => {
      await policy.connect(owner).setRanges(
        [
          { minCoverage: 3n * E18, mechanism: NONE, feeBps: 0 },
          { minCoverage: 5n * E18, mechanism: ASSETS_LOCK, feeBps: 5 },
        ],
        SHARES_LOCK, 100,
      );

      expect(await policy.rangeCount()).to.equal(2);
      expect(await policy.s_defaultFeeBps()).to.equal(100);

      // 4x → falls between 3x and 5x → matches range[0] (3x)
      const result = await policy.evaluateForCoverage(4n * E18);
      expect(result.mechanism).to.equal(NONE);
    });

    it("should revert if ranges not ascending", async () => {
      await expect(
        policy.connect(owner).setRanges(
          [
            { minCoverage: 3n * E18, mechanism: NONE, feeBps: 0 },
            { minCoverage: 2n * E18, mechanism: ASSETS_LOCK, feeBps: 10 }, // not ascending
          ],
          SHARES_LOCK, 50,
        ),
      ).to.be.revertedWithCustomError(policy, "PrimeVaults__RangesNotAscending");
    });

    it("should revert if fee too high", async () => {
      await expect(
        policy.connect(owner).setRanges(
          [{ minCoverage: 2n * E18, mechanism: NONE, feeBps: 1001 }],
          SHARES_LOCK, 50,
        ),
      ).to.be.revertedWithCustomError(policy, "PrimeVaults__FeeTooHigh");
    });

    it("should revert if default fee too high", async () => {
      await expect(
        policy.connect(owner).setRanges([], SHARES_LOCK, 1001),
      ).to.be.revertedWithCustomError(policy, "PrimeVaults__FeeTooHigh");
    });

    it("should revert when called by non-owner", async () => {
      await expect(
        policy.connect(other).setRanges([], SHARES_LOCK, 50),
      ).to.be.revertedWithCustomError(policy, "OwnableUnauthorizedAccount");
    });
  });
});
