import { expect } from "chai";
import { ethers } from "hardhat";

describe("FixedPointMath", () => {
  let math: any;

  const E18 = 10n ** 18n;

  // Helper: check result is within `bps` basis points of expected (0.1% = 10 bps)
  function expectApprox(actual: bigint, expected: bigint, bps: bigint = 10n) {
    const diff = actual > expected ? actual - expected : expected - actual;
    const tolerance = (expected * bps) / 10_000n;
    expect(diff).to.be.lte(tolerance, `Expected ~${expected}, got ${actual} (diff ${diff}, tolerance ${tolerance})`);
  }

  beforeEach(async () => {
    const Factory = await ethers.getContractFactory("FixedPointMathHarness");
    math = await Factory.deploy();
  });

  // ═══════════════════════════════════════════════════════════════════
  //  fpow — Power Function
  // ═══════════════════════════════════════════════════════════════════

  describe("fpow", () => {
    it("should return 0 when base is 0", async () => {
      expect(await math.fpow(0, 5n * E18)).to.equal(0);
      expect(await math.fpow(0, E18)).to.equal(0);
    });

    it("should return 1e18 when exponent is 0", async () => {
      expect(await math.fpow(5n * E18, 0)).to.equal(E18);
      expect(await math.fpow(E18 / 2n, 0)).to.equal(E18);
    });

    it("should return base when exponent is 1e18", async () => {
      const base = 2n * E18;
      expectApprox(await math.fpow(base, E18), base);
    });

    it("should compute 0.5^0.3 ≈ 0.8123 (within 0.1%)", async () => {
      // 0.5e18 ^ 0.3e18 ≈ 0.812252396...e18
      const result = await math.fpow(E18 / 2n, 3n * E18 / 10n);
      expectApprox(result, 812_252_396_000_000_000n);
    });

    it("should compute 2.0^0.5 ≈ 1.4142 (within 0.1%)", async () => {
      // sqrt(2) ≈ 1.41421356...
      const result = await math.fpow(2n * E18, E18 / 2n);
      expectApprox(result, 1_414_213_562_373_095_048n);
    });

    it("should compute 10.0^0.5 ≈ 3.1623 (within 0.1%)", async () => {
      // sqrt(10) ≈ 3.16227766...
      const result = await math.fpow(10n * E18, E18 / 2n);
      expectApprox(result, 3_162_277_660_168_379_331n);
    });

    it("should compute RP1 curve example: 0.10e18 + 0.125e18 * 0.7^0.3", async () => {
      // ratio_sr = 0.7, RP1 = x1 + y1 * ratio_sr^k1 = 0.10 + 0.125 * 0.7^0.3
      // 0.7^0.3 ≈ 0.89536...
      // RP1 ≈ 0.10 + 0.125 * 0.89536 ≈ 0.21192
      const ratioSr = 7n * E18 / 10n;
      const k1 = 3n * E18 / 10n;
      const x1 = E18 / 10n;
      const y1 = 125n * E18 / 1000n;

      const rPow = await math.fpow(ratioSr, k1);
      const yTimesR = await math.fpMul(y1, rPow);
      const rp1 = x1 + yTimesR;

      expectApprox(rp1, 211_920_000_000_000_000n, 50n); // within 0.5%
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  fpMul — Fixed-Point Multiplication
  // ═══════════════════════════════════════════════════════════════════

  describe("fpMul", () => {
    it("should return 0 when either operand is 0", async () => {
      expect(await math.fpMul(0, 5n * E18)).to.equal(0);
      expect(await math.fpMul(5n * E18, 0)).to.equal(0);
    });

    it("should return a when b is 1e18", async () => {
      const a = 123n * E18;
      expect(await math.fpMul(a, E18)).to.equal(a);
    });

    it("should compute 2.5 * 0.4 = 1.0", async () => {
      const a = 25n * E18 / 10n;
      const b = 4n * E18 / 10n;
      expect(await math.fpMul(a, b)).to.equal(E18);
    });

    it("should compute 0.6 * 0.5 = 0.3", async () => {
      const a = 6n * E18 / 10n;
      const b = 5n * E18 / 10n;
      expect(await math.fpMul(a, b)).to.equal(3n * E18 / 10n);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  fpDiv — Fixed-Point Division
  // ═══════════════════════════════════════════════════════════════════

  describe("fpDiv", () => {
    it("should return 0 when numerator is 0", async () => {
      expect(await math.fpDiv(0, 5n * E18)).to.equal(0);
    });

    it("should return 1e18 when a equals b", async () => {
      const val = 42n * E18;
      expect(await math.fpDiv(val, val)).to.equal(E18);
    });

    it("should compute 1 / 2 = 0.5e18", async () => {
      expect(await math.fpDiv(E18, 2n * E18)).to.equal(E18 / 2n);
    });

    it("should compute 3 / 4 = 0.75e18", async () => {
      expect(await math.fpDiv(3n * E18, 4n * E18)).to.equal(75n * E18 / 100n);
    });

    it("should revert on division by zero", async () => {
      await expect(math.fpDiv(E18, 0)).to.be.reverted;
    });
  });
});
