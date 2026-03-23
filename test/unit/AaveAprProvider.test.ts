import { expect } from "chai";
import { ethers } from "hardhat";

describe("AaveAprProvider", () => {
  let provider: any;
  let mockPool: any;
  let aUsdc: any;
  let aUsdt: any;

  const USDC = "0x0000000000000000000000000000000000000001";
  const USDT = "0x0000000000000000000000000000000000000002";

  // Aave rates in ray (1e27). Example: 3% APR = 0.03e27
  const RATE_USDC_RAY = 30000000000000000000000000n; // 3% in ray
  const RATE_USDT_RAY = 50000000000000000000000000n; // 5% in ray
  const RATE_USDC_WAD = 30000000000000000n; // 3% in wad (0.03e18)
  const RATE_USDT_WAD = 50000000000000000n; // 5% in wad (0.05e18)

  beforeEach(async () => {
    // Deploy mock Aave pool
    const PoolFactory = await ethers.getContractFactory("MockAavePool");
    mockPool = await PoolFactory.deploy();

    // Deploy mock aTokens
    const ATokenFactory = await ethers.getContractFactory("MockAToken");
    aUsdc = await ATokenFactory.deploy("aUSDC", "aUSDC");
    aUsdt = await ATokenFactory.deploy("aUSDT", "aUSDT");

    // Set rates in ray
    await mockPool.setLiquidityRate(USDC, RATE_USDC_RAY);
    await mockPool.setLiquidityRate(USDT, RATE_USDT_RAY);

    // Deploy provider
    const Factory = await ethers.getContractFactory("AaveAprProvider");
    provider = await Factory.deploy(
      await mockPool.getAddress(),
      USDC,
      USDT,
      await aUsdc.getAddress(),
      await aUsdt.getAddress(),
    );
  });

  // ═══════════════════════════════════════════════════════════════════
  //  fetchBenchmarkApr
  // ═══════════════════════════════════════════════════════════════════

  describe("fetchBenchmarkApr", () => {
    it("should return weighted average of USDC and USDT rates", async () => {
      const [signer] = await ethers.getSigners();

      // Mint aTokens to simulate supply: 1M USDC, 500K USDT
      await aUsdc.mint(signer.address, ethers.parseUnits("1000000", 18));
      await aUsdt.mint(signer.address, ethers.parseUnits("500000", 18));

      const apr = await provider.fetchBenchmarkApr();

      // Expected: (1M * 0.03 + 500K * 0.05) / 1.5M = (30K + 25K) / 1.5M
      // = 55000 / 1500000 = 0.03666... = ~3.667%
      // In wad: (1e24 * 3e16 + 5e23 * 5e16) / 1.5e24 = (3e40 + 2.5e40) / 1.5e24 = 3.667e16
      const expected = (1_000_000n * RATE_USDC_WAD + 500_000n * RATE_USDT_WAD) / 1_500_000n;
      expect(apr).to.equal(expected);
    });

    it("should return only USDC rate when no USDT supply", async () => {
      const [signer] = await ethers.getSigners();
      await aUsdc.mint(signer.address, ethers.parseUnits("1000000", 18));
      // No USDT supply

      const apr = await provider.fetchBenchmarkApr();
      expect(apr).to.equal(RATE_USDC_WAD);
    });

    it("should return only USDT rate when no USDC supply", async () => {
      const [signer] = await ethers.getSigners();
      await aUsdt.mint(signer.address, ethers.parseUnits("500000", 18));
      // No USDC supply

      const apr = await provider.fetchBenchmarkApr();
      expect(apr).to.equal(RATE_USDT_WAD);
    });

    it("should return 0 if no supply at all", async () => {
      const apr = await provider.fetchBenchmarkApr();
      expect(apr).to.equal(0);
    });

    it("should handle equal supply correctly", async () => {
      const [signer] = await ethers.getSigners();
      await aUsdc.mint(signer.address, ethers.parseUnits("1000000", 18));
      await aUsdt.mint(signer.address, ethers.parseUnits("1000000", 18));

      const apr = await provider.fetchBenchmarkApr();
      // Equal weights: (3% + 5%) / 2 = 4%
      const expected = (RATE_USDC_WAD + RATE_USDT_WAD) / 2n;
      expect(apr).to.equal(expected);
    });
  });
});
