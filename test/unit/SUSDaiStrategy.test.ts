import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

const INSTANT = 0;

describe("SUSDaiStrategy", () => {
  let strategy: any;
  let mockSUSDai: any;
  let mockUSDai: any;
  let cdo: SignerWithAddress;
  let owner: SignerWithAddress;
  let beneficiary: SignerWithAddress;
  let other: SignerWithAddress;

  const E18 = 10n ** 18n;

  beforeEach(async () => {
    [cdo, owner, beneficiary, other] = await ethers.getSigners();

    // Deploy USDai
    const BaseFactory = await ethers.getContractFactory("MockBaseAsset");
    mockUSDai = await BaseFactory.deploy("USDai", "USDai");

    // Deploy MockStakedUSDai
    const SUSDaiFactory = await ethers.getContractFactory("MockStakedUSDai");
    mockSUSDai = await SUSDaiFactory.deploy(await mockUSDai.getAddress(), E18);
    await mockUSDai.mint(await mockSUSDai.getAddress(), 1_000_000n * E18);

    // Deploy strategy
    const StratFactory = await ethers.getContractFactory("SUSDaiStrategy");
    strategy = await StratFactory.deploy(
      cdo.address, await mockUSDai.getAddress(), await mockSUSDai.getAddress(),
      owner.address,
    );

    // Mint USDai to CDO and approve strategy
    await mockUSDai.mint(cdo.address, 100_000n * E18);
    await mockUSDai.connect(cdo).approve(await strategy.getAddress(), ethers.MaxUint256);

    // Get sUSDai for CDO (for depositToken tests)
    await mockUSDai.mint(cdo.address, 10_000n * E18);
    await mockUSDai.connect(cdo).approve(await mockSUSDai.getAddress(), ethers.MaxUint256);
    await mockSUSDai.connect(cdo).deposit(10_000n * E18, cdo.address);
    await mockSUSDai.connect(cdo).approve(await strategy.getAddress(), ethers.MaxUint256);
  });

  // ═══════════════════════════════════════════════════════════════════
  //  deposit USDai → sUSDai
  // ═══════════════════════════════════════════════════════════════════

  describe("deposit (USDai)", () => {
    it("should deposit USDai and mint sUSDai shares internally", async () => {
      await strategy.connect(cdo).deposit(1000n * E18);
      expect(await mockSUSDai.balanceOf(await strategy.getAddress())).to.equal(1000n * E18);
    });

    it("should emit Deposited event", async () => {
      await expect(strategy.connect(cdo).deposit(1000n * E18))
        .to.emit(strategy, "Deposited")
        .withArgs(await mockUSDai.getAddress(), 1000n * E18, 1000n * E18);
    });

    it("should handle rate > 1 (yield accrued)", async () => {
      await mockSUSDai.setRate(11n * E18 / 10n);
      const shares = await strategy.connect(cdo).deposit.staticCall(1100n * E18);
      expect(shares).to.equal(1000n * E18);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  depositToken sUSDai → direct
  // ═══════════════════════════════════════════════════════════════════

  describe("depositToken (sUSDai)", () => {
    it("should accept sUSDai directly", async () => {
      await strategy.connect(cdo).depositToken(await mockSUSDai.getAddress(), 500n * E18);
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
  //  withdraw sUSDai → INSTANT
  // ═══════════════════════════════════════════════════════════════════

  describe("withdraw sUSDai (instant)", () => {
    beforeEach(async () => {
      await strategy.connect(cdo).deposit(5000n * E18);
    });

    it("should return INSTANT type and transfer sUSDai to beneficiary", async () => {
      const sAddr = await mockSUSDai.getAddress();
      const result = await strategy.connect(cdo).withdraw.staticCall(1000n * E18, sAddr, beneficiary.address);
      expect(result.wType).to.equal(INSTANT);
      expect(result.amountOut).to.equal(1000n * E18);
      expect(result.cooldownHandler).to.equal(ethers.ZeroAddress);
    });

    it("should actually transfer sUSDai", async () => {
      await strategy.connect(cdo).withdraw(1000n * E18, await mockSUSDai.getAddress(), beneficiary.address);
      expect(await mockSUSDai.balanceOf(beneficiary.address)).to.equal(1000n * E18);
    });
  });

  describe("withdraw unsupported token", () => {
    beforeEach(async () => {
      await strategy.connect(cdo).deposit(5000n * E18);
    });

    it("should revert for USDai as output token (only sUSDai supported)", async () => {
      await expect(strategy.connect(cdo).withdraw(1000n * E18, await mockUSDai.getAddress(), beneficiary.address))
        .to.be.revertedWithCustomError(strategy, "PrimeVaults__UnsupportedToken");
    });

    it("should revert for arbitrary address as output token", async () => {
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
      await mockSUSDai.setRate(11n * E18 / 10n);
      expect(await strategy.totalAssets()).to.equal(5500n * E18);
    });

    it("should decrease after sUSDai withdraw", async () => {
      await strategy.connect(cdo).deposit(5000n * E18);
      await strategy.connect(cdo).withdraw(1000n * E18, await mockSUSDai.getAddress(), beneficiary.address);
      expect(await strategy.totalAssets()).to.equal(4000n * E18);
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
    });

    it("should return base-equivalent value", async () => {
      await strategy.connect(cdo).deposit(5000n * E18);
      await mockSUSDai.setRate(11n * E18 / 10n);
      const out = await strategy.connect(cdo).emergencyWithdraw.staticCall();
      expect(out).to.equal(5500n * E18);
    });

    it("should emit EmergencyWithdrawn event", async () => {
      await strategy.connect(cdo).deposit(1000n * E18);
      await expect(strategy.connect(cdo).emergencyWithdraw()).to.emit(strategy, "EmergencyWithdrawn");
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

    it("should revert for USDai (unsupported output)", async () => {
      await expect(strategy.predictWithdrawType(await mockUSDai.getAddress()))
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
