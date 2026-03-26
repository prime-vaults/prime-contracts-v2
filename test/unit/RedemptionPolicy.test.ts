import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

const NONE = 0;
const ASSETS_LOCK = 1;
const SHARES_LOCK = 2;

const SENIOR = 0;
const MEZZ = 1;
const JUNIOR = 2;

const E18 = 10n ** 18n;
const DAY = 86400;

describe("RedemptionPolicy", () => {
  let policy: any;
  let accounting: any;
  let owner: SignerWithAddress;
  let cdo: SignerWithAddress;
  let other: SignerWithAddress;

  beforeEach(async () => {
    [owner, cdo, other] = await ethers.getSigners();

    const AccFactory = await ethers.getContractFactory("Accounting");
    accounting = await AccFactory.deploy(owner.address, owner.address);
    await accounting.setCDO(cdo.address);

    const PolicyFactory = await ethers.getContractFactory("RedemptionPolicy");
    policy = await PolicyFactory.deploy(owner.address, await accounting.getAddress());
  });

  async function seedTVLs(sr: bigint, mz: bigint, jr: bigint) {
    if (sr > 0n) await accounting.connect(cdo).recordDeposit(SENIOR, sr);
    if (mz > 0n) await accounting.connect(cdo).recordDeposit(MEZZ, mz);
    if (jr > 0n) await accounting.connect(cdo).recordDeposit(JUNIOR, jr);
  }

  // ═══════════════════════════════════════════════════════════════════
  //  getCoverages
  // ═══════════════════════════════════════════════════════════════════

  describe("getCoverages", () => {
    it("should compute cs and cm correctly", async () => {
      await seedTVLs(7_000n * E18, 2_000n * E18, 1_000n * E18);
      const [cs, cm] = await policy.getCoverages();
      expect(cs).to.equal(10_000n * E18 / 7_000n);
      expect(cm).to.equal(3_000n * E18 / 2_000n);
    });

    it("should return max uint256 for cs when Sr=0", async () => {
      await seedTVLs(0n, 1_000n * E18, 1_000n * E18);
      const [cs] = await policy.getCoverages();
      expect(cs).to.equal(ethers.MaxUint256);
    });

    it("should return max uint256 for cm when Mz=0", async () => {
      await seedTVLs(1_000n * E18, 0n, 1_000n * E18);
      const [, cm] = await policy.getCoverages();
      expect(cm).to.equal(ethers.MaxUint256);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  Senior: always instant
  // ═══════════════════════════════════════════════════════════════════

  describe("Senior — always instant", () => {
    it("should return NONE regardless of coverage", async () => {
      const r1 = await policy.evaluateForCoverage(SENIOR, E18, E18);
      expect(r1.mechanism).to.equal(NONE);
      expect(r1.feeBps).to.equal(0);
      expect(r1.cooldownDuration).to.equal(0);

      const r2 = await policy.evaluateForCoverage(SENIOR, 5n * E18, 5n * E18);
      expect(r2.mechanism).to.equal(NONE);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  Mezz: based on cs only
  // ═══════════════════════════════════════════════════════════════════

  describe("Mezz — based on cs", () => {
    it("should return NONE (instant) when cs > 160%", async () => {
      const result = await policy.evaluateForCoverage(MEZZ, 161n * E18 / 100n, E18);
      expect(result.mechanism).to.equal(NONE);
      expect(result.feeBps).to.equal(0); // instant fee = 0
      expect(result.cooldownDuration).to.equal(0);
    });

    it("should return ASSETS_LOCK when 140% < cs <= 160%", async () => {
      const result = await policy.evaluateForCoverage(MEZZ, 150n * E18 / 100n, E18);
      expect(result.mechanism).to.equal(ASSETS_LOCK);
      expect(result.feeBps).to.equal(10);
      expect(result.cooldownDuration).to.equal(3 * DAY);
    });

    it("should return ASSETS_LOCK at cs = 141%", async () => {
      const result = await policy.evaluateForCoverage(MEZZ, 141n * E18 / 100n, E18);
      expect(result.mechanism).to.equal(ASSETS_LOCK);
    });

    it("should return SHARES_LOCK when cs <= 140%", async () => {
      const result = await policy.evaluateForCoverage(MEZZ, 140n * E18 / 100n, E18);
      expect(result.mechanism).to.equal(SHARES_LOCK);
      expect(result.feeBps).to.equal(50);
      expect(result.cooldownDuration).to.equal(7 * DAY);
    });

    it("should return SHARES_LOCK when cs = 100%", async () => {
      const result = await policy.evaluateForCoverage(MEZZ, E18, E18);
      expect(result.mechanism).to.equal(SHARES_LOCK);
    });

    it("should return SHARES_LOCK at cs exactly 140%", async () => {
      const result = await policy.evaluateForCoverage(MEZZ, 14n * E18 / 10n, E18);
      expect(result.mechanism).to.equal(SHARES_LOCK);
    });

    it("should return ASSETS_LOCK at cs exactly 160% (not > 160%)", async () => {
      const result = await policy.evaluateForCoverage(MEZZ, 16n * E18 / 10n, E18);
      expect(result.mechanism).to.equal(ASSETS_LOCK);
    });

    it("should ignore cm value entirely", async () => {
      const result = await policy.evaluateForCoverage(MEZZ, 2n * E18, E18 / 2n);
      expect(result.mechanism).to.equal(NONE);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  Junior: two-dimensional (cs, cm)
  // ═══════════════════════════════════════════════════════════════════

  describe("Junior — two-dimensional (cs, cm)", () => {
    it("should return NONE when cm > 150% AND cs > 160%", async () => {
      const result = await policy.evaluateForCoverage(JUNIOR, 170n * E18 / 100n, 160n * E18 / 100n);
      expect(result.mechanism).to.equal(NONE);
      expect(result.feeBps).to.equal(0); // instant fee = 0
      expect(result.cooldownDuration).to.equal(0);
    });

    it("should return ASSETS_LOCK when cm > 150% but cs <= 160%", async () => {
      const result = await policy.evaluateForCoverage(JUNIOR, 150n * E18 / 100n, 160n * E18 / 100n);
      expect(result.mechanism).to.equal(ASSETS_LOCK);
      expect(result.feeBps).to.equal(20);
      expect(result.cooldownDuration).to.equal(3 * DAY);
    });

    it("should return ASSETS_LOCK when cs > 160% but cm <= 150%", async () => {
      const result = await policy.evaluateForCoverage(JUNIOR, 170n * E18 / 100n, 140n * E18 / 100n);
      expect(result.mechanism).to.equal(ASSETS_LOCK);
      expect(result.cooldownDuration).to.equal(3 * DAY);
    });

    it("should return ASSETS_LOCK when cm > 130% AND cs > 140%", async () => {
      const result = await policy.evaluateForCoverage(JUNIOR, 141n * E18 / 100n, 131n * E18 / 100n);
      expect(result.mechanism).to.equal(ASSETS_LOCK);
    });

    it("should return SHARES_LOCK when cm <= 130% (even if cs > 140%)", async () => {
      const result = await policy.evaluateForCoverage(JUNIOR, 150n * E18 / 100n, 130n * E18 / 100n);
      expect(result.mechanism).to.equal(SHARES_LOCK);
      expect(result.feeBps).to.equal(100);
      expect(result.cooldownDuration).to.equal(7 * DAY);
    });

    it("should return SHARES_LOCK when cs <= 140% (even if cm > 130%)", async () => {
      const result = await policy.evaluateForCoverage(JUNIOR, 140n * E18 / 100n, 140n * E18 / 100n);
      expect(result.mechanism).to.equal(SHARES_LOCK);
    });

    it("should return SHARES_LOCK when both cs and cm are low", async () => {
      const result = await policy.evaluateForCoverage(JUNIOR, E18, E18);
      expect(result.mechanism).to.equal(SHARES_LOCK);
    });

    it("should return ASSETS_LOCK at exact boundary cm=150%, cs=160%", async () => {
      // Exactly at thresholds (not >) → fails instant, passes asset lock (cm>130%&&cs>140%)
      const result = await policy.evaluateForCoverage(JUNIOR, 16n * E18 / 10n, 15n * E18 / 10n);
      expect(result.mechanism).to.equal(ASSETS_LOCK);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  evaluate() with live accounting
  // ═══════════════════════════════════════════════════════════════════

  describe("evaluate with live accounting", () => {
    it("should return instant for Senior regardless of TVL", async () => {
      await seedTVLs(10_000n * E18, 100n * E18, 100n * E18);
      const result = await policy.evaluate(SENIOR);
      expect(result.mechanism).to.equal(NONE);
    });

    it("should return correct Mezz policy based on live cs", async () => {
      // Sr=1K, Mz=500, Jr=1K → cs = 2500/1000 = 2.5x > 160% → instant
      await seedTVLs(1_000n * E18, 500n * E18, 1_000n * E18);
      const result = await policy.evaluate(MEZZ);
      expect(result.mechanism).to.equal(NONE);
    });

    it("should return SHARES_LOCK for Mezz when cs is low", async () => {
      // Sr=8K, Mz=1K, Jr=1K → cs = 10K/8K = 1.25x ≤ 140% → SHARES_LOCK
      await seedTVLs(8_000n * E18, 1_000n * E18, 1_000n * E18);
      const result = await policy.evaluate(MEZZ);
      expect(result.mechanism).to.equal(SHARES_LOCK);
    });

    it("should return correct Junior policy based on live cs and cm", async () => {
      // Sr=1K, Mz=1K, Jr=10K → cs = 12K/1K = 12x, cm = 11K/1K = 11x → instant
      await seedTVLs(1_000n * E18, 1_000n * E18, 10_000n * E18);
      const result = await policy.evaluate(JUNIOR);
      expect(result.mechanism).to.equal(NONE);
    });

    it("should return SHARES_LOCK for Junior when both coverages low", async () => {
      // Sr=8K, Mz=2K, Jr=500 → cs ≈ 1.3125, cm = 1.25 → both low → SHARES_LOCK
      await seedTVLs(8_000n * E18, 2_000n * E18, 500n * E18);
      const result = await policy.evaluate(JUNIOR);
      expect(result.mechanism).to.equal(SHARES_LOCK);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  Admin — setMezzParams
  // ═══════════════════════════════════════════════════════════════════

  describe("setMezzParams", () => {
    it("should update Mezz thresholds", async () => {
      // Change to: instant > 200%, asset lock > 180%
      await policy.connect(owner).setMezzParams(2_00n * E18 / 100n, 1_80n * E18 / 100n);

      // cs = 190% → was instant, now ASSETS_LOCK
      const result = await policy.evaluateForCoverage(MEZZ, 190n * E18 / 100n, E18);
      expect(result.mechanism).to.equal(ASSETS_LOCK);
    });

    it("should revert if instantCs <= assetLockCs", async () => {
      await expect(
        policy.connect(owner).setMezzParams(14n * E18 / 10n, 16n * E18 / 10n),
      ).to.be.revertedWithCustomError(policy, "PrimeVaults__InvalidThresholds");
    });

    it("should revert if equal", async () => {
      await expect(
        policy.connect(owner).setMezzParams(15n * E18 / 10n, 15n * E18 / 10n),
      ).to.be.revertedWithCustomError(policy, "PrimeVaults__InvalidThresholds");
    });

    it("should revert when called by non-owner", async () => {
      await expect(
        policy.connect(other).setMezzParams(2n * E18, E18),
      ).to.be.revertedWithCustomError(policy, "OwnableUnauthorizedAccount");
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  Admin — setJuniorParams
  // ═══════════════════════════════════════════════════════════════════

  describe("setJuniorParams", () => {
    it("should update Junior thresholds", async () => {
      // Tighten: instant cs>200% cm>180%, asset lock cs>170% cm>150%
      await policy.connect(owner).setJuniorParams(2_00n * E18 / 100n, 180n * E18 / 100n, 170n * E18 / 100n, 150n * E18 / 100n);

      // cs=180%, cm=160% → was instant (old thresholds), now ASSETS_LOCK
      const result = await policy.evaluateForCoverage(JUNIOR, 180n * E18 / 100n, 160n * E18 / 100n);
      expect(result.mechanism).to.equal(ASSETS_LOCK);
    });

    it("should revert if instantCs <= assetLockCs", async () => {
      await expect(
        policy.connect(owner).setJuniorParams(14n * E18 / 10n, 2n * E18, 16n * E18 / 10n, E18),
      ).to.be.revertedWithCustomError(policy, "PrimeVaults__InvalidThresholds");
    });

    it("should revert if instantCm <= assetLockCm", async () => {
      await expect(
        policy.connect(owner).setJuniorParams(2n * E18, E18, E18, 2n * E18),
      ).to.be.revertedWithCustomError(policy, "PrimeVaults__InvalidThresholds");
    });

    it("should revert when called by non-owner", async () => {
      await expect(
        policy.connect(other).setJuniorParams(2n * E18, 2n * E18, E18, E18),
      ).to.be.revertedWithCustomError(policy, "OwnableUnauthorizedAccount");
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  Admin — setMechanismConfig
  // ═══════════════════════════════════════════════════════════════════

  describe("setMechanismConfig", () => {
    it("should update fees and durations for a tranche", async () => {
      await policy.connect(owner).setMechanismConfig(MEZZ, {
        instantFeeBps: 5,
        assetsLockFeeBps: 25,
        assetsLockDuration: 5 * DAY,
        sharesLockFeeBps: 75,
        sharesLockDuration: 14 * DAY,
      });

      // Instant
      const r1 = await policy.evaluateForCoverage(MEZZ, 2n * E18, E18);
      expect(r1.feeBps).to.equal(5);

      // Assets lock
      const r2 = await policy.evaluateForCoverage(MEZZ, 150n * E18 / 100n, E18);
      expect(r2.feeBps).to.equal(25);
      expect(r2.cooldownDuration).to.equal(5 * DAY);

      // Shares lock
      const r3 = await policy.evaluateForCoverage(MEZZ, E18, E18);
      expect(r3.feeBps).to.equal(75);
      expect(r3.cooldownDuration).to.equal(14 * DAY);
    });

    it("should not affect other tranches", async () => {
      await policy.connect(owner).setMechanismConfig(MEZZ, {
        instantFeeBps: 100,
        assetsLockFeeBps: 200,
        assetsLockDuration: 10 * DAY,
        sharesLockFeeBps: 500,
        sharesLockDuration: 30 * DAY,
      });

      // Junior unchanged
      const result = await policy.evaluateForCoverage(JUNIOR, E18, E18);
      expect(result.feeBps).to.equal(100); // original junior shares lock fee
    });

    it("should revert if instantFeeBps > MAX_FEE_BPS", async () => {
      await expect(
        policy.connect(owner).setMechanismConfig(SENIOR, {
          instantFeeBps: 1001, assetsLockFeeBps: 0, assetsLockDuration: 0, sharesLockFeeBps: 0, sharesLockDuration: 0,
        }),
      ).to.be.revertedWithCustomError(policy, "PrimeVaults__FeeTooHigh");
    });

    it("should revert if assetsLockFeeBps > MAX_FEE_BPS", async () => {
      await expect(
        policy.connect(owner).setMechanismConfig(SENIOR, {
          instantFeeBps: 0, assetsLockFeeBps: 1001, assetsLockDuration: 0, sharesLockFeeBps: 0, sharesLockDuration: 0,
        }),
      ).to.be.revertedWithCustomError(policy, "PrimeVaults__FeeTooHigh");
    });

    it("should revert if sharesLockFeeBps > MAX_FEE_BPS", async () => {
      await expect(
        policy.connect(owner).setMechanismConfig(SENIOR, {
          instantFeeBps: 0, assetsLockFeeBps: 0, assetsLockDuration: 0, sharesLockFeeBps: 1001, sharesLockDuration: 0,
        }),
      ).to.be.revertedWithCustomError(policy, "PrimeVaults__FeeTooHigh");
    });

    it("should revert when called by non-owner", async () => {
      await expect(
        policy.connect(other).setMechanismConfig(SENIOR, {
          instantFeeBps: 0, assetsLockFeeBps: 0, assetsLockDuration: 0, sharesLockFeeBps: 0, sharesLockDuration: 0,
        }),
      ).to.be.revertedWithCustomError(policy, "OwnableUnauthorizedAccount");
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  Admin — setAccounting
  // ═══════════════════════════════════════════════════════════════════

  describe("setAccounting", () => {
    it("should allow owner to set accounting", async () => {
      const newAcc = ethers.Wallet.createRandom().address;
      await policy.connect(owner).setAccounting(newAcc);
      expect(await policy.s_accounting()).to.equal(newAcc);
    });

    it("should revert from non-owner", async () => {
      await expect(
        policy.connect(other).setAccounting(ethers.ZeroAddress),
      ).to.be.revertedWithCustomError(policy, "OwnableUnauthorizedAccount");
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  Default init values
  // ═══════════════════════════════════════════════════════════════════

  describe("default init values", () => {
    it("should have correct Mezz default thresholds", async () => {
      const p = await policy.s_mezzParams();
      expect(p.instantCs).to.equal(16n * E18 / 10n); // 160%
      expect(p.assetLockCs).to.equal(14n * E18 / 10n); // 140%
    });

    it("should have correct Junior default thresholds", async () => {
      const p = await policy.s_juniorParams();
      expect(p.instantCs).to.equal(16n * E18 / 10n);
      expect(p.instantCm).to.equal(15n * E18 / 10n);
      expect(p.assetLockCs).to.equal(14n * E18 / 10n);
      expect(p.assetLockCm).to.equal(13n * E18 / 10n);
    });

    it("should have correct default Mezz mechanism config", async () => {
      const [instantFee, assetsLockFee, assetsLockDur, sharesLockFee, sharesLockDur] = await policy.s_mechanismConfig(MEZZ);
      expect(instantFee).to.equal(0);
      expect(assetsLockFee).to.equal(10);
      expect(assetsLockDur).to.equal(3 * DAY);
      expect(sharesLockFee).to.equal(50);
      expect(sharesLockDur).to.equal(7 * DAY);
    });

    it("should have correct default Junior mechanism config", async () => {
      const [instantFee, assetsLockFee, assetsLockDur, sharesLockFee, sharesLockDur] = await policy.s_mechanismConfig(JUNIOR);
      expect(instantFee).to.equal(0);
      expect(assetsLockFee).to.equal(20);
      expect(assetsLockDur).to.equal(3 * DAY);
      expect(sharesLockFee).to.equal(100);
      expect(sharesLockDur).to.equal(7 * DAY);
    });
  });
});
