import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

describe("SwapFacility", () => {
  let swap: any;
  let mockRouter: any;
  let mockWeth: any;
  let mockUsdai: any;
  let owner: SignerWithAddress;
  let cdo: SignerWithAddress;
  let other: SignerWithAddress;

  const E18 = 10n ** 18n;
  const ETH_PRICE = 3000n * E18; // 1 WETH = 3000 USDai

  beforeEach(async () => {
    [owner, cdo, other] = await ethers.getSigners();

    // Deploy tokens
    const WethFactory = await ethers.getContractFactory("MockWETH");
    mockWeth = await WethFactory.deploy();

    const BaseFactory = await ethers.getContractFactory("MockBaseAsset");
    mockUsdai = await BaseFactory.deploy("USDai", "USDai");

    // Deploy mock router
    const RouterFactory = await ethers.getContractFactory("MockSwapRouter");
    mockRouter = await RouterFactory.deploy();

    // Set rates: 1 WETH → 3000 USDai, 3000 USDai → 1 WETH
    await mockRouter.setRate(await mockWeth.getAddress(), await mockUsdai.getAddress(), ETH_PRICE);
    // Reverse: 1 USDai → 1/3000 WETH = 333333333333333n (0.000333e18)
    await mockRouter.setRate(await mockUsdai.getAddress(), await mockWeth.getAddress(), E18 * E18 / ETH_PRICE);

    // Fund router with reserves
    await mockUsdai.mint(await mockRouter.getAddress(), 10_000_000n * E18);
    await mockWeth.mint(await mockRouter.getAddress(), 10_000n * E18);

    // Deploy SwapFacility
    const SwapFactory = await ethers.getContractFactory("SwapFacility");
    swap = await SwapFactory.deploy(
      await mockRouter.getAddress(),
      await mockWeth.getAddress(),
      owner.address,
    );

    // Authorize CDO
    await swap.connect(owner).setAuthorizedCDO(cdo.address, true);

    // Fund CDO with WETH and USDai
    await mockWeth.mint(cdo.address, 100n * E18);
    await mockUsdai.mint(cdo.address, 300_000n * E18);

    // CDO approves SwapFacility
    await mockWeth.connect(cdo).approve(await swap.getAddress(), ethers.MaxUint256);
    await mockUsdai.connect(cdo).approve(await swap.getAddress(), ethers.MaxUint256);
  });

  // ═══════════════════════════════════════════════════════════════════
  //  swapWETHFor
  // ═══════════════════════════════════════════════════════════════════

  describe("swapWETHFor", () => {
    it("should swap WETH for base asset at correct rate", async () => {
      const wethIn = 10n * E18;
      const minOut = 29_000n * E18; // allow some slack

      await swap.connect(cdo).swapWETHFor(await mockUsdai.getAddress(), wethIn, minOut);

      // CDO should receive 10 × 3000 = 30,000 USDai
      expect(await mockUsdai.balanceOf(cdo.address)).to.equal(300_000n * E18 + 30_000n * E18);
      expect(await mockWeth.balanceOf(cdo.address)).to.equal(90n * E18);
    });

    it("should return correct amountOut", async () => {
      const out = await swap.connect(cdo).swapWETHFor.staticCall(
        await mockUsdai.getAddress(), 5n * E18, 0,
      );
      expect(out).to.equal(15_000n * E18); // 5 × 3000
    });

    it("should revert if output < minOut (slippage protection)", async () => {
      // Ask for more than market can give
      const minOut = 31_000n * E18; // 10 WETH × 3000 = 30,000, but we want 31,000
      await expect(
        swap.connect(cdo).swapWETHFor(await mockUsdai.getAddress(), 10n * E18, minOut),
      ).to.be.reverted; // MockSwapRouter reverts "slippage"
    });

    it("should emit WETHSwapped event", async () => {
      await expect(
        swap.connect(cdo).swapWETHFor(await mockUsdai.getAddress(), 1n * E18, 0),
      ).to.emit(swap, "WETHSwapped");
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  swapForWETH
  // ═══════════════════════════════════════════════════════════════════

  describe("swapForWETH", () => {
    it("should swap base asset for WETH at correct rate", async () => {
      const usdaiIn = 3000n * E18;
      const wethBefore = await mockWeth.balanceOf(cdo.address);
      await swap.connect(cdo).swapForWETH(await mockUsdai.getAddress(), usdaiIn, 0);

      const wethAfter = await mockWeth.balanceOf(cdo.address);
      const received = wethAfter - wethBefore;
      // ~1 WETH (may have tiny rounding from integer division)
      expect(received).to.be.gte(E18 - E18 / 1000n); // within 0.1%
      expect(received).to.be.lte(E18);
    });

    it("should return correct wethOut", async () => {
      const out = await swap.connect(cdo).swapForWETH.staticCall(
        await mockUsdai.getAddress(), 6000n * E18, 0,
      );
      // ~2 WETH (rounding from integer division)
      expect(out).to.be.gte(2n * E18 - E18 / 1000n);
      expect(out).to.be.lte(2n * E18);
    });

    it("should revert if output < minWethOut", async () => {
      await expect(
        swap.connect(cdo).swapForWETH(await mockUsdai.getAddress(), 3000n * E18, 2n * E18),
      ).to.be.reverted; // wants 2 WETH but gets 1
    });

    it("should emit SwappedForWETH event", async () => {
      await expect(
        swap.connect(cdo).swapForWETH(await mockUsdai.getAddress(), 3000n * E18, 0),
      ).to.emit(swap, "SwappedForWETH");
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  getMinOutput
  // ═══════════════════════════════════════════════════════════════════

  describe("getMinOutput", () => {
    it("should compute normal slippage (1%)", async () => {
      // 10 WETH × $3000 = $30,000 gross. 1% slip → $29,700
      const minOut = await swap.getMinOutput(10n * E18, ETH_PRICE, false);
      expect(minOut).to.equal(29_700n * E18);
    });

    it("should compute emergency slippage (10%)", async () => {
      // 10 WETH × $3000 = $30,000 gross. 10% slip → $27,000
      const minOut = await swap.getMinOutput(10n * E18, ETH_PRICE, true);
      expect(minOut).to.equal(27_000n * E18);
    });

    it("should return 0 for 0 input", async () => {
      expect(await swap.getMinOutput(0, ETH_PRICE, false)).to.equal(0);
    });

    it("should reflect updated slippage params", async () => {
      await swap.connect(owner).setSlippage(200, 2000); // 2%, 20%

      const normal = await swap.getMinOutput(10n * E18, ETH_PRICE, false);
      expect(normal).to.equal(29_400n * E18); // 30000 × 0.98

      const emergency = await swap.getMinOutput(10n * E18, ETH_PRICE, true);
      expect(emergency).to.equal(24_000n * E18); // 30000 × 0.80
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  Access control — onlyAuthorizedCDO
  // ═══════════════════════════════════════════════════════════════════

  describe("access control", () => {
    it("should revert swapWETHFor from unauthorized caller", async () => {
      await expect(
        swap.connect(other).swapWETHFor(await mockUsdai.getAddress(), E18, 0),
      ).to.be.revertedWithCustomError(swap, "PrimeVaults__Unauthorized");
    });

    it("should revert swapForWETH from unauthorized caller", async () => {
      await expect(
        swap.connect(other).swapForWETH(await mockUsdai.getAddress(), E18, 0),
      ).to.be.revertedWithCustomError(swap, "PrimeVaults__Unauthorized");
    });

    it("should allow after authorization", async () => {
      await swap.connect(owner).setAuthorizedCDO(other.address, true);
      await mockWeth.mint(other.address, 10n * E18);
      await mockWeth.connect(other).approve(await swap.getAddress(), ethers.MaxUint256);

      await expect(
        swap.connect(other).swapWETHFor(await mockUsdai.getAddress(), 1n * E18, 0),
      ).to.not.be.reverted;
    });

    it("should block after deauthorization", async () => {
      await swap.connect(owner).setAuthorizedCDO(cdo.address, false);

      await expect(
        swap.connect(cdo).swapWETHFor(await mockUsdai.getAddress(), E18, 0),
      ).to.be.revertedWithCustomError(swap, "PrimeVaults__Unauthorized");
    });

    it("should revert setAuthorizedCDO from non-owner", async () => {
      await expect(
        swap.connect(other).setAuthorizedCDO(other.address, true),
      ).to.be.revertedWithCustomError(swap, "OwnableUnauthorizedAccount");
    });

    it("should revert setSlippage from non-owner", async () => {
      await expect(
        swap.connect(other).setSlippage(200, 2000),
      ).to.be.revertedWithCustomError(swap, "OwnableUnauthorizedAccount");
    });
  });
});
