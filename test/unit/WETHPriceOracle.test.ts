import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";

describe("WETHPriceOracle", () => {
  let oracle: any;
  let mockFeed: any;

  const E8 = 10n ** 8n;
  const E18 = 10n ** 18n;
  const ETH_PRICE = 3000n * E8; // $3000 in 8 decimals (Chainlink)
  const ETH_PRICE_18 = 3000n * E18; // $3000 in 18 decimals

  beforeEach(async () => {
    const FeedFactory = await ethers.getContractFactory("MockChainlinkFeed");
    mockFeed = await FeedFactory.deploy(8, ETH_PRICE); // Chainlink ETH/USD = 8 decimals

    const OracleFactory = await ethers.getContractFactory("WETHPriceOracle");
    oracle = await OracleFactory.deploy(await mockFeed.getAddress());
  });

  // ═══════════════════════════════════════════════════════════════════
  //  recordPrice
  // ═══════════════════════════════════════════════════════════════════

  describe("recordPrice", () => {
    it("should record price into buffer", async () => {
      await oracle.recordPrice();
      expect(await oracle.s_bufferCount()).to.equal(1);
    });

    it("should emit PriceRecorded event", async () => {
      await expect(oracle.recordPrice())
        .to.emit(oracle, "PriceRecorded");
    });

    it("should record multiple prices", async () => {
      for (let i = 0; i < 5; i++) {
        await mockFeed.setPrice(ETH_PRICE + BigInt(i) * E8);
        await oracle.recordPrice();
      }
      expect(await oracle.s_bufferCount()).to.equal(5);
    });

    it("should wrap around circular buffer (>10 entries)", async () => {
      for (let i = 0; i < 12; i++) {
        await mockFeed.setPrice(ETH_PRICE + BigInt(i) * E8);
        await oracle.recordPrice();
      }
      // Buffer capped at 10
      expect(await oracle.s_bufferCount()).to.equal(10);
      expect(await oracle.s_bufferIndex()).to.equal(12);
    });

    it("should revert if Chainlink price <= 0", async () => {
      await mockFeed.setPrice(0);
      await expect(oracle.recordPrice())
        .to.be.revertedWithCustomError(oracle, "PrimeVaults__InvalidChainlinkPrice");
    });

    it("should revert if Chainlink data is stale (>1 hour)", async () => {
      await mockFeed.setUpdatedAt(1); // very old timestamp
      await expect(oracle.recordPrice())
        .to.be.revertedWithCustomError(oracle, "PrimeVaults__StaleChainlinkData");
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  getWETHPrice — 30-min TWAP
  // ═══════════════════════════════════════════════════════════════════

  describe("getWETHPrice (TWAP)", () => {
    it("should revert if no data recorded", async () => {
      await expect(oracle.getWETHPrice())
        .to.be.revertedWithCustomError(oracle, "PrimeVaults__NoDataRecorded");
    });

    it("should return single price if only one recorded", async () => {
      await oracle.recordPrice();
      expect(await oracle.getWETHPrice()).to.equal(ETH_PRICE_18);
    });

    it("should return average of multiple prices within 30-min window", async () => {
      // Record prices: $3000, $3100, $3200
      await mockFeed.setPrice(3000n * E8);
      await oracle.recordPrice();

      await time.increase(600); // 10 min
      await mockFeed.setPrice(3100n * E8);
      await oracle.recordPrice();

      await time.increase(600); // 10 min
      await mockFeed.setPrice(3200n * E8);
      await oracle.recordPrice();

      const twap = await oracle.getWETHPrice();
      // Average: (3000 + 3100 + 3200) / 3 = 3100
      expect(twap).to.equal(3100n * E18);
    });

    it("should exclude prices older than 30 minutes", async () => {
      // Record old price
      await mockFeed.setPrice(2000n * E8);
      await oracle.recordPrice();

      // Advance 31 minutes
      await time.increase(31 * 60);

      // Record fresh price
      await mockFeed.setPrice(3000n * E8);
      await oracle.recordPrice();

      const twap = await oracle.getWETHPrice();
      // Only fresh price within window
      expect(twap).to.equal(3000n * E18);
    });

    it("should fall back to most recent price if all points outside window", async () => {
      await mockFeed.setPrice(2500n * E8);
      await oracle.recordPrice();

      // Advance 2 hours — all points outside 30-min window
      await time.increase(7200);

      const twap = await oracle.getWETHPrice();
      // Graceful degradation: return most recent
      expect(twap).to.equal(2500n * E18);
    });

    it("should compute correct TWAP with varying prices", async () => {
      const prices = [2800n, 2900n, 3000n, 3100n, 3200n];
      for (const p of prices) {
        await mockFeed.setPrice(p * E8);
        await oracle.recordPrice();
        await time.increase(300); // 5 min each
      }

      const twap = await oracle.getWETHPrice();
      const expected = ((2800n + 2900n + 3000n + 3100n + 3200n) / 5n) * E18;
      expect(twap).to.equal(expected);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  getSpotPrice — latest Chainlink
  // ═══════════════════════════════════════════════════════════════════

  describe("getSpotPrice", () => {
    it("should return latest Chainlink price in 18 decimals", async () => {
      expect(await oracle.getSpotPrice()).to.equal(ETH_PRICE_18);
    });

    it("should reflect updated Chainlink price", async () => {
      await mockFeed.setPrice(3500n * E8);
      expect(await oracle.getSpotPrice()).to.equal(3500n * E18);
    });

    it("should revert if Chainlink data is stale", async () => {
      await mockFeed.setUpdatedAt(1);
      await expect(oracle.getSpotPrice())
        .to.be.revertedWithCustomError(oracle, "PrimeVaults__StaleChainlinkData");
    });

    it("should revert if Chainlink price is negative", async () => {
      await mockFeed.setPrice(-1);
      await expect(oracle.getSpotPrice())
        .to.be.revertedWithCustomError(oracle, "PrimeVaults__InvalidChainlinkPrice");
    });
  });
});
