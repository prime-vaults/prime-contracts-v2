import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

describe("AaveWETHAdapter", () => {
  let adapter: any;
  let mockPool: any;
  let mockWeth: any;
  let mockOracle: any;
  let aWeth: any;
  let cdo: SignerWithAddress;
  let recipient: SignerWithAddress;
  let other: SignerWithAddress;

  const E18 = 10n ** 18n;
  const E8 = 10n ** 8n;
  const ETH_PRICE_8DEC = 3000n * E8; // $3000 in Chainlink 8 decimals

  beforeEach(async () => {
    [cdo, recipient, other] = await ethers.getSigners();

    // Deploy MockWETH
    const WethFactory = await ethers.getContractFactory("MockWETH");
    mockWeth = await WethFactory.deploy();

    // Deploy MockAavePoolForAdapter (creates aWETH internally)
    const PoolFactory = await ethers.getContractFactory("MockAavePoolForAdapter");
    mockPool = await PoolFactory.deploy(await mockWeth.getAddress());
    aWeth = await ethers.getContractAt("MockAWETH", await mockPool.aWeth());

    // Deploy MockChainlinkFeed + WETHPriceOracle
    const FeedFactory = await ethers.getContractFactory("MockChainlinkFeed");
    const mockFeed = await FeedFactory.deploy(8, ETH_PRICE_8DEC);

    const OracleFactory = await ethers.getContractFactory("WETHPriceOracle");
    mockOracle = await OracleFactory.deploy(await mockFeed.getAddress());

    // Record a price so getWETHPrice works
    await mockOracle.recordPrice();

    // Deploy AaveWETHAdapter with CDO = cdo signer
    const AdapterFactory = await ethers.getContractFactory("AaveWETHAdapter");
    adapter = await AdapterFactory.deploy(
      await mockPool.getAddress(),
      await mockWeth.getAddress(),
      await mockOracle.getAddress(),
      cdo.address,
    );

    // Mint WETH to CDO for testing
    await mockWeth.mint(cdo.address, 100n * E18);
    // Approve adapter to spend CDO's WETH
    await mockWeth.connect(cdo).approve(await adapter.getAddress(), ethers.MaxUint256);
  });

  // ═══════════════════════════════════════════════════════════════════
  //  supply
  // ═══════════════════════════════════════════════════════════════════

  describe("supply", () => {
    it("should transfer WETH from CDO and increase aWETH balance", async () => {
      const tx = await adapter.connect(cdo).supply(10n * E18);

      expect(await aWeth.balanceOf(await adapter.getAddress())).to.equal(10n * E18);
      expect(await mockWeth.balanceOf(cdo.address)).to.equal(90n * E18);
    });

    it("should return correct aWethReceived", async () => {
      const received = await adapter.connect(cdo).supply.staticCall(10n * E18);
      expect(received).to.equal(10n * E18); // 1:1 in mock
    });

    it("should handle multiple supplies", async () => {
      await adapter.connect(cdo).supply(5n * E18);
      await adapter.connect(cdo).supply(3n * E18);

      expect(await aWeth.balanceOf(await adapter.getAddress())).to.equal(8n * E18);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  withdraw
  // ═══════════════════════════════════════════════════════════════════

  describe("withdraw", () => {
    beforeEach(async () => {
      await adapter.connect(cdo).supply(10n * E18);
    });

    it("should withdraw WETH to recipient", async () => {
      await adapter.connect(cdo).withdraw(3n * E18, recipient.address);

      expect(await mockWeth.balanceOf(recipient.address)).to.equal(3n * E18);
      expect(await aWeth.balanceOf(await adapter.getAddress())).to.equal(7n * E18);
    });

    it("should return correct amountOut", async () => {
      const out = await adapter.connect(cdo).withdraw.staticCall(3n * E18, recipient.address);
      expect(out).to.equal(3n * E18);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  withdrawAll
  // ═══════════════════════════════════════════════════════════════════

  describe("withdrawAll", () => {
    it("should withdraw full aWETH balance", async () => {
      await adapter.connect(cdo).supply(10n * E18);

      // Simulate 0.1 WETH yield
      await mockPool.simulateYield(await adapter.getAddress(), E18 / 10n);

      const totalBefore = await aWeth.balanceOf(await adapter.getAddress());
      expect(totalBefore).to.equal(10n * E18 + E18 / 10n); // 10.1

      await adapter.connect(cdo).withdrawAll(recipient.address);

      expect(await aWeth.balanceOf(await adapter.getAddress())).to.equal(0);
      expect(await mockWeth.balanceOf(recipient.address)).to.equal(totalBefore);
    });

    it("should return correct amountOut", async () => {
      await adapter.connect(cdo).supply(5n * E18);
      const out = await adapter.connect(cdo).withdrawAll.staticCall(recipient.address);
      expect(out).to.equal(5n * E18);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  totalAssets
  // ═══════════════════════════════════════════════════════════════════

  describe("totalAssets", () => {
    it("should return 0 when nothing supplied", async () => {
      expect(await adapter.totalAssets()).to.equal(0);
    });

    it("should return aWETH balance after supply", async () => {
      await adapter.connect(cdo).supply(10n * E18);
      expect(await adapter.totalAssets()).to.equal(10n * E18);
    });

    it("should reflect yield accrual", async () => {
      await adapter.connect(cdo).supply(10n * E18);
      await mockPool.simulateYield(await adapter.getAddress(), E18 / 100n); // 0.01 WETH yield
      expect(await adapter.totalAssets()).to.equal(10n * E18 + E18 / 100n);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  totalAssetsUSD
  // ═══════════════════════════════════════════════════════════════════

  describe("totalAssetsUSD", () => {
    it("should return 0 when nothing supplied", async () => {
      expect(await adapter.totalAssetsUSD()).to.equal(0);
    });

    it("should return balance × TWAP price", async () => {
      await adapter.connect(cdo).supply(10n * E18);
      // 10 WETH × $3000 = $30,000
      expect(await adapter.totalAssetsUSD()).to.equal(30_000n * E18);
    });

    it("should reflect yield in USD", async () => {
      await adapter.connect(cdo).supply(10n * E18);
      await mockPool.simulateYield(await adapter.getAddress(), E18); // +1 WETH
      // 11 WETH × $3000 = $33,000
      expect(await adapter.totalAssetsUSD()).to.equal(33_000n * E18);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  currentAPR
  // ═══════════════════════════════════════════════════════════════════

  describe("currentAPR", () => {
    it("should return Aave WETH supply rate in 18 decimals", async () => {
      const apr = await adapter.currentAPR();
      // Mock rate = 2.5% in ray = 25e24. In wad = 25e24 / 1e9 = 25e15 = 0.025e18
      expect(apr).to.equal(25_000_000_000_000_000n);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  Access control — onlyCDO
  // ═══════════════════════════════════════════════════════════════════

  describe("access control — onlyCDO", () => {
    it("should revert supply from non-CDO", async () => {
      await expect(adapter.connect(other).supply(E18))
        .to.be.revertedWithCustomError(adapter, "PrimeVaults__Unauthorized");
    });

    it("should revert withdraw from non-CDO", async () => {
      await expect(adapter.connect(other).withdraw(E18, other.address))
        .to.be.revertedWithCustomError(adapter, "PrimeVaults__Unauthorized");
    });

    it("should revert withdrawAll from non-CDO", async () => {
      await expect(adapter.connect(other).withdrawAll(other.address))
        .to.be.revertedWithCustomError(adapter, "PrimeVaults__Unauthorized");
    });
  });
});
