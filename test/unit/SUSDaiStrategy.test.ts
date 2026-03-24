import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

// WithdrawType enum
const INSTANT = 0;
const ASSETS_LOCK = 1;
const UNSTAKE = 2;

describe("SUSDaiStrategy", () => {
  let strategy: any;
  let mockSUSDai: any;
  let mockUSDai: any;
  let cdo: SignerWithAddress;
  let owner: SignerWithAddress;
  let beneficiary: SignerWithAddress;
  let other: SignerWithAddress;

  const E18 = 10n ** 18n;
  const INITIAL_RATE = E18; // 1:1

  beforeEach(async () => {
    [cdo, owner, beneficiary, other] = await ethers.getSigners();

    // Deploy MockBaseAsset as USDai
    const BaseFactory = await ethers.getContractFactory("MockBaseAsset");
    mockUSDai = await BaseFactory.deploy("USDai", "USDai");

    // Deploy MockSUSDai
    const SUSDaiFactory = await ethers.getContractFactory("MockSUSDai");
    mockSUSDai = await SUSDaiFactory.deploy(await mockUSDai.getAddress(), INITIAL_RATE);

    // Fund mock sUSDai vault with USDai for redemptions
    await mockUSDai.mint(await mockSUSDai.getAddress(), 1_000_000n * E18);

    // Deploy strategy
    const StratFactory = await ethers.getContractFactory("SUSDaiStrategy");
    strategy = await StratFactory.deploy(
      cdo.address,
      await mockUSDai.getAddress(),
      await mockSUSDai.getAddress(),
      owner.address,
    );

    // Mint USDai + sUSDai to CDO for deposits
    await mockUSDai.mint(cdo.address, 100_000n * E18);
    await mockUSDai.connect(cdo).approve(await strategy.getAddress(), ethers.MaxUint256);

    // Mint sUSDai directly for depositToken(sUSDai) tests
    // First deposit USDai → sUSDai to get real shares
    await mockUSDai.mint(cdo.address, 10_000n * E18);
    await mockUSDai.connect(cdo).approve(await mockSUSDai.getAddress(), ethers.MaxUint256);
    await mockSUSDai.connect(cdo).deposit(10_000n * E18, cdo.address);
    await mockSUSDai.connect(cdo).approve(await strategy.getAddress(), ethers.MaxUint256);
  });

  // ═══════════════════════════════════════════════════════════════════
  //  deposit — USDai → sUSDai
  // ═══════════════════════════════════════════════════════════════════

  describe("deposit (USDai)", () => {
    it("should deposit USDai and mint sUSDai shares internally", async () => {
      await strategy.connect(cdo).deposit(1000n * E18);

      // Strategy should hold sUSDai
      expect(await mockSUSDai.balanceOf(await strategy.getAddress())).to.equal(1000n * E18);
    });

    it("should emit Deposited event", async () => {
      await expect(strategy.connect(cdo).deposit(1000n * E18))
        .to.emit(strategy, "Deposited")
        .withArgs(await mockUSDai.getAddress(), 1000n * E18, 1000n * E18);
    });

    it("should return correct shares count", async () => {
      const shares = await strategy.connect(cdo).deposit.staticCall(500n * E18);
      expect(shares).to.equal(500n * E18);
    });

    it("should handle rate > 1 (yield accrued)", async () => {
      // Rate 1.1 → 1000 USDai → ~909.09 sUSDai shares
      await mockSUSDai.setRate(11n * E18 / 10n);

      const shares = await strategy.connect(cdo).deposit.staticCall(1000n * E18);
      expect(shares).to.equal(1000n * E18 * E18 / (11n * E18 / 10n));
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  depositToken — sUSDai direct
  // ═══════════════════════════════════════════════════════════════════

  describe("depositToken (sUSDai)", () => {
    it("should accept sUSDai directly", async () => {
      const sUSDaiAddr = await mockSUSDai.getAddress();
      await strategy.connect(cdo).depositToken(sUSDaiAddr, 500n * E18);

      // Strategy holds the sUSDai
      expect(await mockSUSDai.balanceOf(await strategy.getAddress())).to.equal(500n * E18);
    });

    it("should also accept USDai via depositToken", async () => {
      await strategy.connect(cdo).depositToken(await mockUSDai.getAddress(), 500n * E18);
      expect(await mockSUSDai.balanceOf(await strategy.getAddress())).to.equal(500n * E18);
    });

    it("should revert for unsupported token", async () => {
      await expect(strategy.connect(cdo).depositToken(other.address, 100n * E18))
        .to.be.revertedWithCustomError(strategy, "PrimeVaults__UnsupportedToken");
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  withdraw sUSDai — INSTANT
  // ═══════════════════════════════════════════════════════════════════

  describe("withdraw sUSDai (instant)", () => {
    beforeEach(async () => {
      await strategy.connect(cdo).deposit(5000n * E18);
    });

    it("should transfer sUSDai to beneficiary instantly", async () => {
      const sUSDaiAddr = await mockSUSDai.getAddress();
      const result = await strategy.connect(cdo).withdraw.staticCall(1000n * E18, sUSDaiAddr, beneficiary.address);

      expect(result.wType).to.equal(INSTANT);
      expect(result.amountOut).to.equal(1000n * E18); // shares at 1:1 rate
      expect(result.cooldownId).to.equal(0);
      expect(result.cooldownHandler).to.equal(ethers.ZeroAddress);
    });

    it("should actually transfer sUSDai", async () => {
      const sUSDaiAddr = await mockSUSDai.getAddress();
      await strategy.connect(cdo).withdraw(1000n * E18, sUSDaiAddr, beneficiary.address);

      expect(await mockSUSDai.balanceOf(beneficiary.address)).to.equal(1000n * E18);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  withdraw USDai — UNSTAKE (ERC-7540 async)
  // ═══════════════════════════════════════════════════════════════════

  describe("withdraw USDai (unstake)", () => {
    beforeEach(async () => {
      await strategy.connect(cdo).deposit(5000n * E18);
    });

    it("should return UNSTAKE type with cooldown details", async () => {
      const usdaiAddr = await mockUSDai.getAddress();
      const result = await strategy.connect(cdo).withdraw.staticCall(1000n * E18, usdaiAddr, beneficiary.address);

      expect(result.wType).to.equal(UNSTAKE);
      expect(result.amountOut).to.equal(0); // no instant output
      expect(result.cooldownHandler).to.equal(await mockSUSDai.getAddress());
      expect(result.unlockTime).to.be.gt(0);
    });

    it("should initiate ERC-7540 requestRedeem on sUSDai", async () => {
      const usdaiAddr = await mockUSDai.getAddress();
      await strategy.connect(cdo).withdraw(1000n * E18, usdaiAddr, beneficiary.address);

      // Strategy should have 4000 sUSDai left (1000 burned by requestRedeem)
      expect(await mockSUSDai.balanceOf(await strategy.getAddress())).to.equal(4000n * E18);
    });

    it("should set unlockTime ~7 days from now", async () => {
      const usdaiAddr = await mockUSDai.getAddress();
      const result = await strategy.connect(cdo).withdraw.staticCall(1000n * E18, usdaiAddr, beneficiary.address);

      const now = BigInt(await time.latest());
      // unlockTime should be ~7 days from now (allow +2 for block advancement)
      expect(result.unlockTime).to.be.gte(now + 7n * 86400n);
      expect(result.unlockTime).to.be.lte(now + 7n * 86400n + 2n);
    });

    it("should revert for unsupported output token", async () => {
      await expect(strategy.connect(cdo).withdraw(1000n * E18, other.address, beneficiary.address))
        .to.be.revertedWithCustomError(strategy, "PrimeVaults__UnsupportedToken");
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  totalAssets
  // ═══════════════════════════════════════════════════════════════════

  describe("totalAssets", () => {
    it("should return 0 when empty", async () => {
      expect(await strategy.totalAssets()).to.equal(0);
    });

    it("should reflect deposited amount at 1:1 rate", async () => {
      await strategy.connect(cdo).deposit(5000n * E18);
      expect(await strategy.totalAssets()).to.equal(5000n * E18);
    });

    it("should reflect exchange rate increase (yield)", async () => {
      await strategy.connect(cdo).deposit(5000n * E18);
      // Rate goes from 1.0 → 1.1 (10% yield)
      await mockSUSDai.setRate(11n * E18 / 10n);
      // 5000 shares × 1.1 = 5500 USDai equivalent
      expect(await strategy.totalAssets()).to.equal(5500n * E18);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  emergencyWithdraw
  // ═══════════════════════════════════════════════════════════════════

  describe("emergencyWithdraw", () => {
    it("should transfer all sUSDai back to CDO", async () => {
      await strategy.connect(cdo).deposit(5000n * E18);

      await strategy.connect(cdo).emergencyWithdraw();

      expect(await mockSUSDai.balanceOf(await strategy.getAddress())).to.equal(0);
      expect(await mockSUSDai.balanceOf(cdo.address)).to.be.gt(0);
    });

    it("should return base-equivalent value", async () => {
      await strategy.connect(cdo).deposit(5000n * E18);
      await mockSUSDai.setRate(11n * E18 / 10n); // 10% yield

      const out = await strategy.connect(cdo).emergencyWithdraw.staticCall();
      expect(out).to.equal(5500n * E18); // 5000 shares × 1.1
    });

    it("should emit EmergencyWithdrawn event", async () => {
      await strategy.connect(cdo).deposit(1000n * E18);
      await expect(strategy.connect(cdo).emergencyWithdraw())
        .to.emit(strategy, "EmergencyWithdrawn");
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  supportedTokens + predictWithdrawType
  // ═══════════════════════════════════════════════════════════════════

  describe("supportedTokens + predictWithdrawType", () => {
    it("should return [USDai, sUSDai]", async () => {
      const tokens = await strategy.supportedTokens();
      expect(tokens.length).to.equal(2);
      expect(tokens[0]).to.equal(await mockUSDai.getAddress());
      expect(tokens[1]).to.equal(await mockSUSDai.getAddress());
    });

    it("should predict INSTANT for sUSDai", async () => {
      expect(await strategy.predictWithdrawType(await mockSUSDai.getAddress())).to.equal(INSTANT);
    });

    it("should predict UNSTAKE for USDai", async () => {
      expect(await strategy.predictWithdrawType(await mockUSDai.getAddress())).to.equal(UNSTAKE);
    });

    it("should revert for unsupported token", async () => {
      await expect(strategy.predictWithdrawType(other.address))
        .to.be.revertedWithCustomError(strategy, "PrimeVaults__UnsupportedToken");
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  Access control + pause
  // ═══════════════════════════════════════════════════════════════════

  describe("access control + pause", () => {
    it("should revert deposit from non-CDO", async () => {
      await expect(strategy.connect(other).deposit(E18))
        .to.be.revertedWithCustomError(strategy, "PrimeVaults__Unauthorized");
    });

    it("should revert depositToken from non-CDO", async () => {
      await expect(strategy.connect(other).depositToken(await mockUSDai.getAddress(), E18))
        .to.be.revertedWithCustomError(strategy, "PrimeVaults__Unauthorized");
    });

    it("should revert withdraw from non-CDO", async () => {
      await expect(strategy.connect(other).withdraw(E18, await mockUSDai.getAddress(), other.address))
        .to.be.revertedWithCustomError(strategy, "PrimeVaults__Unauthorized");
    });

    it("should revert emergencyWithdraw from non-CDO", async () => {
      await expect(strategy.connect(other).emergencyWithdraw())
        .to.be.revertedWithCustomError(strategy, "PrimeVaults__Unauthorized");
    });

    it("should revert deposit when paused", async () => {
      await strategy.connect(owner).pause();
      await expect(strategy.connect(cdo).deposit(E18))
        .to.be.revertedWithCustomError(strategy, "EnforcedPause");
    });

    it("should allow deposit after unpause", async () => {
      await strategy.connect(owner).pause();
      await strategy.connect(owner).unpause();
      await expect(strategy.connect(cdo).deposit(1000n * E18)).to.not.be.reverted;
    });

    it("should revert deposit with zero amount", async () => {
      await expect(strategy.connect(cdo).deposit(0))
        .to.be.revertedWithCustomError(strategy, "PrimeVaults__ZeroAmount");
    });

    it("isActive should return false when paused", async () => {
      expect(await strategy.isActive()).to.be.true;
      await strategy.connect(owner).pause();
      expect(await strategy.isActive()).to.be.false;
    });

    it("name should return strategy name", async () => {
      expect(await strategy.name()).to.equal("PrimeVaults sUSDai Strategy");
    });
  });
});
