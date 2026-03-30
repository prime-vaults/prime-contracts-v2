import { describe, it, expect, vi, beforeEach } from "vitest";
import { PrimeVaultsSDK } from "./PrimeVaultsSDK";
import type { PrimeVaultsConfig, TrancheId } from "./types";
import type { WalletClient } from "viem";

// ═══════════════════════════════════════════════════════════════════
//  Mock viem
// ═══════════════════════════════════════════════════════════════════

const mockReadContract = vi.fn();
const mockPublicClient = { readContract: mockReadContract };

vi.mock("viem", async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return {
    ...actual,
    createPublicClient: () => mockPublicClient,
  };
});

// ═══════════════════════════════════════════════════════════════════
//  Fixtures
// ═══════════════════════════════════════════════════════════════════

const ADDRESSES = {
  primeCDO: "0x1111111111111111111111111111111111111111",
  seniorVault: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  mezzVault: "0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
  juniorVault: "0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
  primeLens: "0xDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD",
};

const USER = "0xEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE";
const TOKEN = "0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF";

const CONFIG: PrimeVaultsConfig = {
  rpcUrl: "http://localhost:8545",
  chainId: 42161,
  addresses: ADDRESSES,
};

const makeTranche = (id: number, vault: string, name: string, symbol: string) => ({
  trancheId: id,
  vault,
  name,
  symbol,
  totalAssets: 1_000_000n * 10n ** 18n,
  totalSupply: 900_000n * 10n ** 18n,
  sharePrice: 1_111_111_111_111_111_111n,
});

const MOCK_TX_HASH = "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890";

const mockWalletClient = {
  writeContract: vi.fn().mockResolvedValue(MOCK_TX_HASH),
  chain: { id: 42161 },
  account: { address: USER },
} as unknown as WalletClient;

// ═══════════════════════════════════════════════════════════════════
//  Tests
// ═══════════════════════════════════════════════════════════════════

describe("PrimeVaultsSDK", () => {
  let sdk: PrimeVaultsSDK;

  beforeEach(() => {
    vi.clearAllMocks();
    sdk = new PrimeVaultsSDK(CONFIG);
  });

  // ─────────────────────────────────────────────────────────────────
  //  Constructor
  // ─────────────────────────────────────────────────────────────────

  describe("constructor", () => {
    it("should store config and addresses", () => {
      expect(sdk.config).toBe(CONFIG);
      expect(sdk.addresses).toBe(ADDRESSES);
    });

    it("should create a publicClient", () => {
      expect(sdk.publicClient).toBe(mockPublicClient);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  //  Helpers
  // ─────────────────────────────────────────────────────────────────

  describe("_requireLens", () => {
    it("should throw when primeLens is not configured", async () => {
      const noLens = new PrimeVaultsSDK({
        ...CONFIG,
        addresses: { ...ADDRESSES, primeLens: undefined },
      });
      await expect(() => noLens.getAllTranches()).rejects.toThrow("primeLens address not configured");
    });
  });

  // ─────────────────────────────────────────────────────────────────
  //  READ — PrimeLens
  // ─────────────────────────────────────────────────────────────────

  describe("getAllTranches", () => {
    it("should return senior, mezz, and junior tranche info", async () => {
      const senior = makeTranche(0, ADDRESSES.seniorVault, "Senior", "pvSR");
      const mezz = makeTranche(1, ADDRESSES.mezzVault, "Mezzanine", "pvMZ");
      const junior = makeTranche(2, ADDRESSES.juniorVault, "Junior", "pvJR");
      mockReadContract.mockResolvedValueOnce([senior, mezz, junior]);

      const result = await sdk.getAllTranches();

      expect(result.senior.trancheId).toBe("SENIOR");
      expect(result.senior.name).toBe("Senior");
      expect(result.mezz.trancheId).toBe("MEZZ");
      expect(result.junior.trancheId).toBe("JUNIOR");
      expect(result.junior.totalAssets).toBe(1_000_000n * 10n ** 18n);
      expect(mockReadContract).toHaveBeenCalledWith({
        address: ADDRESSES.primeLens,
        abi: expect.any(Array),
        functionName: "getAllTranches",
      });
    });
  });

  describe("getTrancheInfo", () => {
    it.each([
      ["SENIOR", 0],
      ["MEZZ", 1],
      ["JUNIOR", 2],
    ] as [TrancheId, number][])(
      "should fetch tranche info for %s (index %d)",
      async (trancheId, expectedIndex) => {
        const raw = makeTranche(expectedIndex, ADDRESSES.seniorVault, "Test", "TST");
        mockReadContract.mockResolvedValueOnce(raw);

        const result = await sdk.getTrancheInfo(trancheId);

        expect(result.trancheId).toBe(trancheId);
        expect(result.sharePrice).toBe(raw.sharePrice);
        expect(mockReadContract).toHaveBeenCalledWith(
          expect.objectContaining({
            functionName: "getTrancheInfo",
            args: [expectedIndex],
          }),
        );
      },
    );
  });

  describe("getJuniorPosition", () => {
    it("should return junior position data", async () => {
      const raw = {
        baseTVL: 800_000n * 10n ** 18n,
        wethTVL: 200_000n * 10n ** 18n,
        totalTVL: 1_000_000n * 10n ** 18n,
        wethAmount: 100n * 10n ** 18n,
        wethPrice: 2_000n * 10n ** 18n,
        currentRatio: 200_000_000_000_000_000n,
        aaveAPR: 35_000_000_000_000_000n,
      };
      mockReadContract.mockResolvedValueOnce(raw);

      const result = await sdk.getJuniorPosition();

      expect(result.baseTVL).toBe(raw.baseTVL);
      expect(result.wethPrice).toBe(raw.wethPrice);
      expect(result.currentRatio).toBe(raw.currentRatio);
    });
  });

  describe("getProtocolHealth", () => {
    it("should return protocol health data", async () => {
      const raw = {
        seniorTVL: 5_000_000n * 10n ** 18n,
        mezzTVL: 3_000_000n * 10n ** 18n,
        juniorTVL: 2_000_000n * 10n ** 18n,
        totalTVL: 10_000_000n * 10n ** 18n,
        coverageSenior: 1_200_000_000_000_000_000n,
        coverageMezz: 1_100_000_000_000_000_000n,
        minCoverageForDeposit: 1_050_000_000_000_000_000n,
        shortfallPaused: false,
        juniorShortfallPausePrice: 900_000_000_000_000_000n,
        strategyTVL: 8_000_000n * 10n ** 18n,
      };
      mockReadContract.mockResolvedValueOnce(raw);

      const result = await sdk.getProtocolHealth();

      expect(result.shortfallPaused).toBe(false);
      expect(result.totalTVL).toBe(raw.totalTVL);
      expect(result.coverageSenior).toBe(raw.coverageSenior);
    });
  });

  describe("getUserPendingWithdraws", () => {
    it("should return pending withdraws for user", async () => {
      const raw = [
        {
          requestId: 1n,
          handler: "0x1111111111111111111111111111111111111111",
          beneficiary: USER,
          token: TOKEN,
          amount: 1_000n * 10n ** 18n,
          unlockTime: 1700000000n,
          expiryTime: 1700086400n,
          status: 0,
          isClaimable: false,
          timeRemaining: 3600n,
        },
      ];
      mockReadContract.mockResolvedValueOnce(raw);

      const result = await sdk.getUserPendingWithdraws(USER);

      expect(result).toHaveLength(1);
      expect(result[0].requestId).toBe(1n);
      expect(result[0].isClaimable).toBe(false);
    });

    it("should return empty array when no pending withdraws", async () => {
      mockReadContract.mockResolvedValueOnce([]);
      const result = await sdk.getUserPendingWithdraws(USER);
      expect(result).toHaveLength(0);
    });
  });

  describe("getClaimableWithdraws", () => {
    it("should return claimable withdraws for user", async () => {
      const raw = [
        {
          requestId: 2n,
          handler: "0x2222222222222222222222222222222222222222",
          beneficiary: USER,
          token: TOKEN,
          amount: 500n * 10n ** 18n,
          unlockTime: 1699900000n,
          expiryTime: 1700086400n,
          status: 1,
          isClaimable: true,
          timeRemaining: 0n,
        },
      ];
      mockReadContract.mockResolvedValueOnce(raw);

      const result = await sdk.getClaimableWithdraws(USER);

      expect(result).toHaveLength(1);
      expect(result[0].isClaimable).toBe(true);
      expect(result[0].timeRemaining).toBe(0n);
    });
  });

  describe("previewWithdrawCondition", () => {
    it("should return withdraw condition for a tranche", async () => {
      const raw = {
        mechanism: 1,
        feeBps: 50n,
        cooldownDuration: 86400n,
        coverageSenior: 1_100_000_000_000_000_000n,
        coverageMezz: 1_050_000_000_000_000_000n,
      };
      mockReadContract.mockResolvedValueOnce(raw);

      const result = await sdk.previewWithdrawCondition("SENIOR");

      expect(result.mechanism).toBe(1);
      expect(result.feeBps).toBe(50n);
      expect(mockReadContract).toHaveBeenCalledWith(
        expect.objectContaining({ args: [0] }),
      );
    });
  });

  describe("getWETHRebalanceStatus", () => {
    it("should return rebalance status", async () => {
      const raw = {
        currentRatio: 180_000_000_000_000_000n,
        targetRatio: 200_000_000_000_000_000n,
        tolerance: 10_000_000_000_000_000n,
        wethAmount: 90n * 10n ** 18n,
        wethValueUSD: 180_000n * 10n ** 18n,
        wethPrice: 2_000n * 10n ** 18n,
        needsSell: false,
        needsBuy: true,
        excessOrDeficitUSD: 20_000n * 10n ** 18n,
      };
      mockReadContract.mockResolvedValueOnce(raw);

      const result = await sdk.getWETHRebalanceStatus();

      expect(result.needsBuy).toBe(true);
      expect(result.needsSell).toBe(false);
      expect(result.wethPrice).toBe(raw.wethPrice);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  //  READ — TrancheVault
  // ─────────────────────────────────────────────────────────────────

  describe("getShareBalance", () => {
    it("should read balanceOf from correct vault address", async () => {
      mockReadContract.mockResolvedValueOnce(500n * 10n ** 18n);

      const result = await sdk.getShareBalance("SENIOR", USER);

      expect(result).toBe(500n * 10n ** 18n);
      expect(mockReadContract).toHaveBeenCalledWith(
        expect.objectContaining({
          address: ADDRESSES.seniorVault,
          functionName: "balanceOf",
          args: [USER],
        }),
      );
    });

    it("should route to correct vault per tranche", async () => {
      mockReadContract.mockResolvedValue(100n);

      await sdk.getShareBalance("MEZZ", USER);
      expect(mockReadContract).toHaveBeenCalledWith(
        expect.objectContaining({ address: ADDRESSES.mezzVault }),
      );

      await sdk.getShareBalance("JUNIOR", USER);
      expect(mockReadContract).toHaveBeenCalledWith(
        expect.objectContaining({ address: ADDRESSES.juniorVault }),
      );
    });
  });

  describe("convertToAssets", () => {
    it("should convert shares to assets", async () => {
      mockReadContract.mockResolvedValueOnce(1_111n * 10n ** 18n);
      const result = await sdk.convertToAssets("SENIOR", 1_000n * 10n ** 18n);
      expect(result).toBe(1_111n * 10n ** 18n);
    });
  });

  describe("convertToShares", () => {
    it("should convert assets to shares", async () => {
      mockReadContract.mockResolvedValueOnce(900n * 10n ** 18n);
      const result = await sdk.convertToShares("MEZZ", 1_000n * 10n ** 18n);
      expect(result).toBe(900n * 10n ** 18n);
    });
  });

  describe("previewDeposit", () => {
    it("should preview deposit shares", async () => {
      mockReadContract.mockResolvedValueOnce(990n * 10n ** 18n);
      const result = await sdk.previewDeposit("JUNIOR", 1_000n * 10n ** 18n);
      expect(result).toBe(990n * 10n ** 18n);
    });
  });

  describe("previewRedeem", () => {
    it("should preview redeem assets", async () => {
      mockReadContract.mockResolvedValueOnce(1_050n * 10n ** 18n);
      const result = await sdk.previewRedeem("SENIOR", 1_000n * 10n ** 18n);
      expect(result).toBe(1_050n * 10n ** 18n);
    });
  });

  describe("getTotalAssets", () => {
    it("should return total assets for tranche", async () => {
      mockReadContract.mockResolvedValueOnce(5_000_000n * 10n ** 18n);
      const result = await sdk.getTotalAssets("SENIOR");
      expect(result).toBe(5_000_000n * 10n ** 18n);
    });
  });

  describe("getTotalSupply", () => {
    it("should return total supply for tranche", async () => {
      mockReadContract.mockResolvedValueOnce(4_500_000n * 10n ** 18n);
      const result = await sdk.getTotalSupply("MEZZ");
      expect(result).toBe(4_500_000n * 10n ** 18n);
    });
  });

  describe("getVaultDecimals", () => {
    it("should return vault decimals", async () => {
      mockReadContract.mockResolvedValueOnce(18);
      const result = await sdk.getVaultDecimals("JUNIOR");
      expect(result).toBe(18);
    });
  });

  describe("getVaultAsset", () => {
    it("should return vault underlying asset address", async () => {
      mockReadContract.mockResolvedValueOnce(TOKEN);
      const result = await sdk.getVaultAsset("SENIOR");
      expect(result).toBe(TOKEN);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  //  READ — User Portfolio
  // ─────────────────────────────────────────────────────────────────

  describe("getUserPortfolio", () => {
    it("should aggregate user positions across all tranches", async () => {
      mockReadContract
        .mockResolvedValueOnce(1_000n * 10n ** 18n)
        .mockResolvedValueOnce(500n * 10n ** 18n)
        .mockResolvedValueOnce(200n * 10n ** 18n)
        .mockResolvedValueOnce(1_100n * 10n ** 18n)
        .mockResolvedValueOnce(550n * 10n ** 18n)
        .mockResolvedValueOnce(220n * 10n ** 18n);

      const result = await sdk.getUserPortfolio(USER);

      expect(result.senior.shares).toBe(1_000n * 10n ** 18n);
      expect(result.senior.assets).toBe(1_100n * 10n ** 18n);
      expect(result.mezz.shares).toBe(500n * 10n ** 18n);
      expect(result.junior.assets).toBe(220n * 10n ** 18n);
      expect(result.totalAssetsUSD).toBe(1_100n * 10n ** 18n + 550n * 10n ** 18n + 220n * 10n ** 18n);
    });

    it("should skip convertToAssets when shares are zero", async () => {
      mockReadContract
        .mockResolvedValueOnce(0n)
        .mockResolvedValueOnce(0n)
        .mockResolvedValueOnce(100n * 10n ** 18n)
        .mockResolvedValueOnce(110n * 10n ** 18n);

      const result = await sdk.getUserPortfolio(USER);

      expect(result.senior.assets).toBe(0n);
      expect(result.mezz.assets).toBe(0n);
      expect(result.junior.assets).toBe(110n * 10n ** 18n);
      expect(result.totalAssetsUSD).toBe(110n * 10n ** 18n);
      expect(mockReadContract).toHaveBeenCalledTimes(4);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  //  READ — ERC20 helpers
  // ─────────────────────────────────────────────────────────────────

  describe("getTokenBalance", () => {
    it("should read ERC20 balanceOf", async () => {
      mockReadContract.mockResolvedValueOnce(10_000n * 10n ** 18n);
      const result = await sdk.getTokenBalance(TOKEN, USER);
      expect(result).toBe(10_000n * 10n ** 18n);
      expect(mockReadContract).toHaveBeenCalledWith(
        expect.objectContaining({
          address: TOKEN,
          functionName: "balanceOf",
          args: [USER],
        }),
      );
    });
  });

  describe("getTokenAllowance", () => {
    it("should read ERC20 allowance", async () => {
      mockReadContract.mockResolvedValueOnce(5_000n * 10n ** 18n);
      const spender = ADDRESSES.seniorVault;
      const result = await sdk.getTokenAllowance(TOKEN, USER, spender);
      expect(result).toBe(5_000n * 10n ** 18n);
      expect(mockReadContract).toHaveBeenCalledWith(
        expect.objectContaining({
          functionName: "allowance",
          args: [USER, spender],
        }),
      );
    });
  });

  // ─────────────────────────────────────────────────────────────────
  //  WRITE — Deposit
  // ─────────────────────────────────────────────────────────────────

  describe("deposit", () => {
    it("should call writeContract on the correct vault", async () => {
      const hash = await sdk.deposit(mockWalletClient, "SENIOR", 1_000n * 10n ** 18n, USER);

      expect(hash).toBe(MOCK_TX_HASH);
      expect(mockWalletClient.writeContract).toHaveBeenCalledWith(
        expect.objectContaining({
          address: ADDRESSES.seniorVault,
          functionName: "deposit",
          args: [1_000n * 10n ** 18n, USER],
        }),
      );
    });

    it("should use the correct vault for each tranche", async () => {
      await sdk.deposit(mockWalletClient, "MEZZ", 100n, USER);
      expect(mockWalletClient.writeContract).toHaveBeenCalledWith(
        expect.objectContaining({ address: ADDRESSES.mezzVault }),
      );
    });
  });

  describe("depositJunior", () => {
    it("should call depositJunior with base and WETH amounts", async () => {
      const hash = await sdk.depositJunior(mockWalletClient, 800n * 10n ** 18n, 200n * 10n ** 18n, USER);

      expect(hash).toBe(MOCK_TX_HASH);
      expect(mockWalletClient.writeContract).toHaveBeenCalledWith(
        expect.objectContaining({
          address: ADDRESSES.juniorVault,
          functionName: "depositJunior",
          args: [800n * 10n ** 18n, 200n * 10n ** 18n, USER],
        }),
      );
    });
  });

  // ─────────────────────────────────────────────────────────────────
  //  WRITE — Withdraw
  // ─────────────────────────────────────────────────────────────────

  describe("requestWithdraw", () => {
    it("should request withdraw with shares, output token, and receiver", async () => {
      const hash = await sdk.requestWithdraw(mockWalletClient, "SENIOR", 500n * 10n ** 18n, TOKEN, USER);

      expect(hash).toBe(MOCK_TX_HASH);
      expect(mockWalletClient.writeContract).toHaveBeenCalledWith(
        expect.objectContaining({
          address: ADDRESSES.seniorVault,
          functionName: "requestWithdraw",
          args: [500n * 10n ** 18n, TOKEN, USER],
        }),
      );
    });
  });

  describe("claimWithdraw", () => {
    it("should claim withdraw with cooldown id and handler", async () => {
      const handler = "0x3333333333333333333333333333333333333333";
      const hash = await sdk.claimWithdraw(mockWalletClient, "MEZZ", 42n, handler);

      expect(hash).toBe(MOCK_TX_HASH);
      expect(mockWalletClient.writeContract).toHaveBeenCalledWith(
        expect.objectContaining({
          functionName: "claimWithdraw",
          args: [42n, handler],
        }),
      );
    });
  });

  describe("claimSharesWithdraw", () => {
    it("should claim shares withdraw with cooldown id and output token", async () => {
      const hash = await sdk.claimSharesWithdraw(mockWalletClient, "JUNIOR", 7n, TOKEN);

      expect(hash).toBe(MOCK_TX_HASH);
      expect(mockWalletClient.writeContract).toHaveBeenCalledWith(
        expect.objectContaining({
          address: ADDRESSES.juniorVault,
          functionName: "claimSharesWithdraw",
          args: [7n, TOKEN],
        }),
      );
    });
  });

  // ─────────────────────────────────────────────────────────────────
  //  WRITE — ERC20 Approve
  // ─────────────────────────────────────────────────────────────────

  describe("approveToken", () => {
    it("should approve token spending", async () => {
      const spender = ADDRESSES.seniorVault;
      const hash = await sdk.approveToken(mockWalletClient, TOKEN, spender, 10_000n * 10n ** 18n);

      expect(hash).toBe(MOCK_TX_HASH);
      expect(mockWalletClient.writeContract).toHaveBeenCalledWith(
        expect.objectContaining({
          address: TOKEN,
          functionName: "approve",
          args: [spender, 10_000n * 10n ** 18n],
        }),
      );
    });
  });

  describe("approveVaultDeposit", () => {
    it("should approve the vault address as spender", async () => {
      const hash = await sdk.approveVaultDeposit(mockWalletClient, "SENIOR", TOKEN, 5_000n * 10n ** 18n);

      expect(hash).toBe(MOCK_TX_HASH);
      expect(mockWalletClient.writeContract).toHaveBeenCalledWith(
        expect.objectContaining({
          address: TOKEN,
          functionName: "approve",
          args: [ADDRESSES.seniorVault, 5_000n * 10n ** 18n],
        }),
      );
    });

    it("should use correct vault address per tranche", async () => {
      await sdk.approveVaultDeposit(mockWalletClient, "JUNIOR", TOKEN, 100n);
      expect(mockWalletClient.writeContract).toHaveBeenCalledWith(
        expect.objectContaining({
          args: [ADDRESSES.juniorVault, 100n],
        }),
      );
    });
  });

  // ─────────────────────────────────────────────────────────────────
  //  READ — estimateWETHAmount
  // ─────────────────────────────────────────────────────────────────

  describe("estimateWETHAmount", () => {
    it("should calculate WETH amount from base amount using on-chain ratio and price", async () => {
      // getWETHRebalanceStatus
      mockReadContract.mockResolvedValueOnce({
        currentRatio: 200_000_000_000_000_000n,
        targetRatio: 200_000_000_000_000_000n, // 20%
        tolerance: 30_000_000_000_000_000n,
        wethAmount: 50n * 10n ** 18n,
        wethValueUSD: 100_000n * 10n ** 18n,
        wethPrice: 2_000n * 10n ** 18n,
        needsSell: false,
        needsBuy: false,
        excessOrDeficitUSD: 0n,
      });
      // getJuniorPosition
      mockReadContract.mockResolvedValueOnce({
        baseTVL: 400_000n * 10n ** 18n,
        wethTVL: 100_000n * 10n ** 18n,
        totalTVL: 500_000n * 10n ** 18n,
        wethAmount: 50n * 10n ** 18n,
        wethPrice: 2_000n * 10n ** 18n, // $2000
        currentRatio: 200_000_000_000_000_000n,
        aaveAPR: 35_000_000_000_000_000n,
      });

      // Deposit 800 USD.AI base → need 200 USD worth of WETH → 0.1 WETH
      const baseAmount = 800n * 10n ** 18n;
      const result = await sdk.estimateWETHAmount(baseAmount);

      expect(result.targetRatio).toBe(200_000_000_000_000_000n); // 20%
      expect(result.wethPrice).toBe(2_000n * 10n ** 18n);        // $2000

      // wethValueUSD = 800 * 0.20 / 0.80 = 200
      expect(result.wethValueUSD).toBe(200n * 10n ** 18n);

      // wethAmount = 200 / 2000 = 0.1 WETH
      expect(result.wethAmount).toBe(100_000_000_000_000_000n); // 0.1e18
    });

    it("should handle small base amounts", async () => {
      mockReadContract.mockResolvedValueOnce({
        currentRatio: 200_000_000_000_000_000n,
        targetRatio: 200_000_000_000_000_000n,
        tolerance: 30_000_000_000_000_000n,
        wethAmount: 0n,
        wethValueUSD: 0n,
        wethPrice: 2_000n * 10n ** 18n,
        needsSell: false,
        needsBuy: false,
        excessOrDeficitUSD: 0n,
      });
      mockReadContract.mockResolvedValueOnce({
        baseTVL: 0n,
        wethTVL: 0n,
        totalTVL: 0n,
        wethAmount: 0n,
        wethPrice: 2_000n * 10n ** 18n,
        currentRatio: 0n,
        aaveAPR: 0n,
      });

      // 10 USD.AI → wethValue = 10 * 0.20 / 0.80 = 2.5 USD → 0.00125 WETH
      const result = await sdk.estimateWETHAmount(10n * 10n ** 18n);

      expect(result.wethValueUSD).toBe(2_500_000_000_000_000_000n); // 2.5e18
      expect(result.wethAmount).toBe(1_250_000_000_000_000n);       // 0.00125e18
    });

    it("should handle zero base amount", async () => {
      mockReadContract.mockResolvedValueOnce({
        currentRatio: 0n,
        targetRatio: 200_000_000_000_000_000n,
        tolerance: 30_000_000_000_000_000n,
        wethAmount: 0n,
        wethValueUSD: 0n,
        wethPrice: 2_000n * 10n ** 18n,
        needsSell: false,
        needsBuy: false,
        excessOrDeficitUSD: 0n,
      });
      mockReadContract.mockResolvedValueOnce({
        baseTVL: 0n,
        wethTVL: 0n,
        totalTVL: 0n,
        wethAmount: 0n,
        wethPrice: 2_000n * 10n ** 18n,
        currentRatio: 0n,
        aaveAPR: 0n,
      });

      const result = await sdk.estimateWETHAmount(0n);

      expect(result.wethAmount).toBe(0n);
      expect(result.wethValueUSD).toBe(0n);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  //  UTILS — Format helpers
  // ─────────────────────────────────────────────────────────────────

  describe("formatAmount", () => {
    it("should format with default 18 decimals", () => {
      expect(sdk.formatAmount(1_000_000_000_000_000_000n)).toBe("1");
      expect(sdk.formatAmount(1_500_000_000_000_000_000n)).toBe("1.5");
    });

    it("should format with custom decimals", () => {
      expect(sdk.formatAmount(1_000_000n, 6)).toBe("1");
      expect(sdk.formatAmount(1_500_000n, 6)).toBe("1.5");
    });

    it("should handle zero", () => {
      expect(sdk.formatAmount(0n)).toBe("0");
    });
  });

  describe("parseAmount", () => {
    it("should parse with default 18 decimals", () => {
      expect(sdk.parseAmount("1")).toBe(1_000_000_000_000_000_000n);
      expect(sdk.parseAmount("1.5")).toBe(1_500_000_000_000_000_000n);
    });

    it("should parse with custom decimals", () => {
      expect(sdk.parseAmount("1", 6)).toBe(1_000_000n);
    });

    it("should handle zero", () => {
      expect(sdk.parseAmount("0")).toBe(0n);
    });
  });

  describe("formatSharePrice", () => {
    it("should format share price with 18 decimals", () => {
      expect(sdk.formatSharePrice(1_000_000_000_000_000_000n)).toBe("1");
      expect(sdk.formatSharePrice(1_050_000_000_000_000_000n)).toBe("1.05");
    });
  });

  describe("formatBps", () => {
    it("should format basis points as percentage", () => {
      expect(sdk.formatBps(100n)).toBe("1%");
      expect(sdk.formatBps(50n)).toBe("0.5%");
      expect(sdk.formatBps(10_000n)).toBe("100%");
    });
  });

  describe("formatRatio", () => {
    it("should format 1e18 ratio as percentage", () => {
      expect(sdk.formatRatio(200_000_000_000_000_000n)).toBe("20.00%");
      expect(sdk.formatRatio(1_000_000_000_000_000_000n)).toBe("100.00%");
      expect(sdk.formatRatio(1_050_000_000_000_000_000n)).toBe("105.00%");
    });
  });
});
