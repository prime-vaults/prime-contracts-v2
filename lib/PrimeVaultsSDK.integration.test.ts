/**
 * Integration tests — PrimeVaultsSDK against production Arbitrum contracts.
 *
 * Requires: ARB_RPC_URL env variable.
 *
 * Usage:
 *   ARB_RPC_URL=<url> npx vitest run PrimeVaultsSDK.integration.test.ts
 */

import { describe, it, expect, beforeAll } from "vitest";
import { PrimeVaultsSDK } from "./PrimeVaultsSDK";
import type { PrimeVaultsConfig } from "./types";

// ═══════════════════════════════════════════════════════════════════
//  Production addresses (from deploy/deployed.json)
// ═══════════════════════════════════════════════════════════════════

const DEPLOYED = {
  primeCDO: "0x1869F39e4E4EA85776C0fe446ac03a2D6C86F543",
  seniorVault: "0xE77ec530D2e550049df9347E05612c58fc4C12A7",
  mezzVault: "0x71a4E7559eBF87611efB183a71EdA3Df77F0f766",
  juniorVault: "0x323eB19E3a34096947247fd97d3F5a7F098a0d8C",
  primeLens: "0xAfb731AD79374C3273514e9F86D39AD0D551A280",
  accounting: "0x7591134ba592961103c1E1dc7C4Ae2Fc0A6Fb2Fc",
  erc20Cooldown: "0x47D0ce8985f39fC41D5ef93881276dCA9cC30906",
  sharesCooldown: "0x336474a6dAafCB9eEA38282bc15d85cA2E09C560",
};

const USDAI = "0x0A1a1A107E45b7Ced86833863f482BC5f4ed82EF";

/** A random address with no holdings — used for zero-balance checks */
const ZERO_USER = "0x0000000000000000000000000000000000000001";

// ═══════════════════════════════════════════════════════════════════
//  Setup
// ═══════════════════════════════════════════════════════════════════

const rpcUrl = process.env.ARB_RPC_URL;

describe.skipIf(!rpcUrl)("PrimeVaultsSDK — Integration (Arbitrum Production)", () => {
  let sdk: PrimeVaultsSDK;

  beforeAll(() => {
    const config: PrimeVaultsConfig = {
      rpcUrl: rpcUrl!,
      chainId: 42161,
      addresses: {
        primeCDO: DEPLOYED.primeCDO,
        seniorVault: DEPLOYED.seniorVault,
        mezzVault: DEPLOYED.mezzVault,
        juniorVault: DEPLOYED.juniorVault,
        primeLens: DEPLOYED.primeLens,
        accounting: DEPLOYED.accounting,
        erc20Cooldown: DEPLOYED.erc20Cooldown,
        sharesCooldown: DEPLOYED.sharesCooldown,
      },
    };
    sdk = new PrimeVaultsSDK(config);
  });

  // ─────────────────────────────────────────────────────────────────
  //  PrimeLens — getAllTranches
  // ─────────────────────────────────────────────────────────────────

  describe("getAllTranches", () => {
    it("should return valid info for all three tranches", async () => {
      const result = await sdk.getAllTranches();

      expect(result.senior.trancheId).toBe("SENIOR");
      expect(result.mezz.trancheId).toBe("MEZZ");
      expect(result.junior.trancheId).toBe("JUNIOR");

      // Vault addresses match deployed
      expect(result.senior.vault.toLowerCase()).toBe(DEPLOYED.seniorVault.toLowerCase());
      expect(result.mezz.vault.toLowerCase()).toBe(DEPLOYED.mezzVault.toLowerCase());
      expect(result.junior.vault.toLowerCase()).toBe(DEPLOYED.juniorVault.toLowerCase());

      // Names and symbols should be non-empty strings
      for (const tranche of [result.senior, result.mezz, result.junior]) {
        expect(tranche.name.length).toBeGreaterThan(0);
        expect(tranche.symbol.length).toBeGreaterThan(0);
        expect(tranche.sharePrice).toBeGreaterThan(0n);
        expect(tranche.totalAssets).toBeGreaterThanOrEqual(0n);
        expect(tranche.totalSupply).toBeGreaterThanOrEqual(0n);
      }

      console.log(`    Senior: ${sdk.formatAmount(result.senior.totalAssets)} assets, price=${sdk.formatSharePrice(result.senior.sharePrice)}`);
      console.log(`    Mezz:   ${sdk.formatAmount(result.mezz.totalAssets)} assets, price=${sdk.formatSharePrice(result.mezz.sharePrice)}`);
      console.log(`    Junior: ${sdk.formatAmount(result.junior.totalAssets)} assets, price=${sdk.formatSharePrice(result.junior.sharePrice)}`);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  //  PrimeLens — getTrancheInfo (per tranche)
  // ─────────────────────────────────────────────────────────────────

  describe("getTrancheInfo", () => {
    it("should return SENIOR tranche info", async () => {
      const info = await sdk.getTrancheInfo("SENIOR");
      expect(info.trancheId).toBe("SENIOR");
      expect(info.vault.toLowerCase()).toBe(DEPLOYED.seniorVault.toLowerCase());
      expect(info.sharePrice).toBeGreaterThan(0n);
    });

    it("should return MEZZ tranche info", async () => {
      const info = await sdk.getTrancheInfo("MEZZ");
      expect(info.trancheId).toBe("MEZZ");
      expect(info.vault.toLowerCase()).toBe(DEPLOYED.mezzVault.toLowerCase());
    });

    it("should return JUNIOR tranche info", async () => {
      const info = await sdk.getTrancheInfo("JUNIOR");
      expect(info.trancheId).toBe("JUNIOR");
      expect(info.vault.toLowerCase()).toBe(DEPLOYED.juniorVault.toLowerCase());
    });
  });

  // ─────────────────────────────────────────────────────────────────
  //  PrimeLens — getJuniorPosition
  // ─────────────────────────────────────────────────────────────────

  describe("getJuniorPosition", () => {
    it("should return junior dual-asset position", async () => {
      const pos = await sdk.getJuniorPosition();

      expect(pos.totalTVL).toBeGreaterThanOrEqual(0n);
      expect(pos.wethPrice).toBeGreaterThan(0n);
      // ratio is 0..1e18 range (0-100%)
      expect(pos.currentRatio).toBeGreaterThanOrEqual(0n);
      expect(pos.currentRatio).toBeLessThanOrEqual(1_000_000_000_000_000_000n);

      console.log(`    baseTVL:  ${sdk.formatAmount(pos.baseTVL)}`);
      console.log(`    wethTVL:  ${sdk.formatAmount(pos.wethTVL)}`);
      console.log(`    totalTVL: ${sdk.formatAmount(pos.totalTVL)}`);
      console.log(`    wethAmt:  ${sdk.formatAmount(pos.wethAmount)} WETH`);
      console.log(`    wethPx:   $${sdk.formatAmount(pos.wethPrice)}`);
      console.log(`    ratio:    ${sdk.formatRatio(pos.currentRatio)}`);
      console.log(`    aaveAPR:  ${sdk.formatRatio(pos.aaveAPR)}`);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  //  PrimeLens — getProtocolHealth
  // ─────────────────────────────────────────────────────────────────

  describe("getProtocolHealth", () => {
    it("should return valid protocol health metrics", async () => {
      const health = await sdk.getProtocolHealth();

      expect(health.totalTVL).toBeGreaterThanOrEqual(0n);
      expect(health.totalTVL).toBe(health.seniorTVL + health.mezzTVL + health.juniorTVL);
      expect(typeof health.shortfallPaused).toBe("boolean");
      expect(health.minCoverageForDeposit).toBeGreaterThan(0n);
      expect(health.strategyTVL).toBeGreaterThanOrEqual(0n);

      console.log(`    seniorTVL: ${sdk.formatAmount(health.seniorTVL)}`);
      console.log(`    mezzTVL:   ${sdk.formatAmount(health.mezzTVL)}`);
      console.log(`    juniorTVL: ${sdk.formatAmount(health.juniorTVL)}`);
      console.log(`    totalTVL:  ${sdk.formatAmount(health.totalTVL)}`);
      console.log(`    covSenior: ${sdk.formatRatio(health.coverageSenior)}`);
      console.log(`    covMezz:   ${sdk.formatRatio(health.coverageMezz)}`);
      console.log(`    paused:    ${health.shortfallPaused}`);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  //  PrimeLens — previewWithdrawCondition
  // ─────────────────────────────────────────────────────────────────

  describe("previewWithdrawCondition", () => {
    it("should return withdraw condition for SENIOR", async () => {
      const cond = await sdk.previewWithdrawCondition("SENIOR");
      expect(cond.mechanism).toBeGreaterThanOrEqual(0);
      expect(cond.feeBps).toBeGreaterThanOrEqual(0n);
      expect(cond.cooldownDuration).toBeGreaterThanOrEqual(0n);

      console.log(`    mechanism: ${cond.mechanism}`);
      console.log(`    fee:       ${sdk.formatBps(cond.feeBps)}`);
      console.log(`    cooldown:  ${Number(cond.cooldownDuration) / 3600}h`);
    });

    it("should return withdraw condition for MEZZ", async () => {
      const cond = await sdk.previewWithdrawCondition("MEZZ");
      expect(cond.mechanism).toBeGreaterThanOrEqual(0);
    });

    it("should return withdraw condition for JUNIOR", async () => {
      const cond = await sdk.previewWithdrawCondition("JUNIOR");
      expect(cond.mechanism).toBeGreaterThanOrEqual(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  //  PrimeLens — getWETHRebalanceStatus
  // ─────────────────────────────────────────────────────────────────

  describe("getWETHRebalanceStatus", () => {
    it("should return WETH rebalance status", async () => {
      const status = await sdk.getWETHRebalanceStatus();

      expect(status.wethPrice).toBeGreaterThan(0n);
      expect(status.targetRatio).toBeGreaterThan(0n);
      expect(status.tolerance).toBeGreaterThan(0n);
      expect(typeof status.needsSell).toBe("boolean");
      expect(typeof status.needsBuy).toBe("boolean");
      // Cannot need both
      expect(status.needsSell && status.needsBuy).toBe(false);

      console.log(`    current:  ${sdk.formatRatio(status.currentRatio)}`);
      console.log(`    target:   ${sdk.formatRatio(status.targetRatio)}`);
      console.log(`    tol:      ${sdk.formatRatio(status.tolerance)}`);
      console.log(`    wethAmt:  ${sdk.formatAmount(status.wethAmount)} WETH`);
      console.log(`    wethUSD:  $${sdk.formatAmount(status.wethValueUSD)}`);
      console.log(`    needsSell: ${status.needsSell}, needsBuy: ${status.needsBuy}`);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  //  PrimeLens — getUserPendingWithdraws / getClaimableWithdraws
  // ─────────────────────────────────────────────────────────────────

  describe("getUserPendingWithdraws", () => {
    it("should return an array (possibly empty) for a random address", async () => {
      const result = await sdk.getUserPendingWithdraws(ZERO_USER);
      expect(Array.isArray(result)).toBe(true);
      console.log(`    pendingWithdraws: ${result.length}`);
    });
  });

  describe("getClaimableWithdraws", () => {
    it("should return an array (possibly empty) for a random address", async () => {
      const result = await sdk.getClaimableWithdraws(ZERO_USER);
      expect(Array.isArray(result)).toBe(true);
      console.log(`    claimableWithdraws: ${result.length}`);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  //  TrancheVault — per-vault reads
  // ─────────────────────────────────────────────────────────────────

  describe("TrancheVault reads", () => {
    it("should return totalAssets for each tranche", async () => {
      const sr = await sdk.getTotalAssets("SENIOR");
      const mz = await sdk.getTotalAssets("MEZZ");
      const jr = await sdk.getTotalAssets("JUNIOR");

      expect(sr).toBeGreaterThanOrEqual(0n);
      expect(mz).toBeGreaterThanOrEqual(0n);
      expect(jr).toBeGreaterThanOrEqual(0n);

      console.log(`    Senior totalAssets: ${sdk.formatAmount(sr)}`);
      console.log(`    Mezz   totalAssets: ${sdk.formatAmount(mz)}`);
      console.log(`    Junior totalAssets: ${sdk.formatAmount(jr)}`);
    });

    it("should return totalSupply for each tranche", async () => {
      const sr = await sdk.getTotalSupply("SENIOR");
      const mz = await sdk.getTotalSupply("MEZZ");
      const jr = await sdk.getTotalSupply("JUNIOR");

      expect(sr).toBeGreaterThanOrEqual(0n);
      expect(mz).toBeGreaterThanOrEqual(0n);
      expect(jr).toBeGreaterThanOrEqual(0n);
    });

    it("should return decimals for each tranche", async () => {
      const sr = await sdk.getVaultDecimals("SENIOR");
      const mz = await sdk.getVaultDecimals("MEZZ");
      const jr = await sdk.getVaultDecimals("JUNIOR");

      expect(sr).toBe(18);
      expect(mz).toBe(18);
      expect(jr).toBe(18);
    });

    it("should return underlying asset address for each tranche", async () => {
      const sr = await sdk.getVaultAsset("SENIOR");
      const mz = await sdk.getVaultAsset("MEZZ");
      const jr = await sdk.getVaultAsset("JUNIOR");

      expect(sr.toLowerCase()).toBe(USDAI.toLowerCase());
      expect(mz.toLowerCase()).toBe(USDAI.toLowerCase());
      expect(jr.toLowerCase()).toBe(USDAI.toLowerCase());
    });

    it("should return zero share balance for random user", async () => {
      const balance = await sdk.getShareBalance("SENIOR", ZERO_USER);
      expect(balance).toBe(0n);
    });

    it("should handle convertToAssets with zero shares", async () => {
      const assets = await sdk.convertToAssets("SENIOR", 0n);
      expect(assets).toBe(0n);
    });

    it("should handle convertToShares with zero assets", async () => {
      const shares = await sdk.convertToShares("SENIOR", 0n);
      expect(shares).toBe(0n);
    });

    it("should preview deposit correctly", async () => {
      const oneToken = 1_000_000_000_000_000_000n; // 1e18
      const shares = await sdk.previewDeposit("SENIOR", oneToken);
      expect(shares).toBeGreaterThanOrEqual(0n);
      console.log(`    previewDeposit(1 token) = ${sdk.formatAmount(shares)} shares`);
    });

    it("should preview redeem correctly", async () => {
      const oneShare = 1_000_000_000_000_000_000n; // 1e18
      const assets = await sdk.previewRedeem("SENIOR", oneShare);
      expect(assets).toBeGreaterThanOrEqual(0n);
      console.log(`    previewRedeem(1 share) = ${sdk.formatAmount(assets)} assets`);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  //  User Portfolio
  // ─────────────────────────────────────────────────────────────────

  describe("getUserPortfolio", () => {
    it("should return zero portfolio for random address", async () => {
      const portfolio = await sdk.getUserPortfolio(ZERO_USER);

      expect(portfolio.senior.shares).toBe(0n);
      expect(portfolio.senior.assets).toBe(0n);
      expect(portfolio.mezz.shares).toBe(0n);
      expect(portfolio.mezz.assets).toBe(0n);
      expect(portfolio.junior.shares).toBe(0n);
      expect(portfolio.junior.assets).toBe(0n);
      expect(portfolio.totalAssetsUSD).toBe(0n);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  //  ERC20 helpers
  // ─────────────────────────────────────────────────────────────────

  describe("ERC20 helpers", () => {
    it("should return token balance for random address", async () => {
      const balance = await sdk.getTokenBalance(USDAI, ZERO_USER);
      expect(balance).toBeGreaterThanOrEqual(0n);
    });

    it("should return token allowance", async () => {
      const allowance = await sdk.getTokenAllowance(USDAI, ZERO_USER, DEPLOYED.seniorVault);
      expect(allowance).toBe(0n);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  //  Format utils (pure — no RPC needed)
  // ─────────────────────────────────────────────────────────────────

  describe("format utils", () => {
    it("formatAmount", () => {
      expect(sdk.formatAmount(1_000_000_000_000_000_000n)).toBe("1");
      expect(sdk.formatAmount(1_500_000n, 6)).toBe("1.5");
    });

    it("parseAmount", () => {
      expect(sdk.parseAmount("100")).toBe(100_000_000_000_000_000_000n);
      expect(sdk.parseAmount("1", 6)).toBe(1_000_000n);
    });

    it("formatSharePrice", () => {
      expect(sdk.formatSharePrice(1_050_000_000_000_000_000n)).toBe("1.05");
    });

    it("formatBps", () => {
      expect(sdk.formatBps(50n)).toBe("0.5%");
      expect(sdk.formatBps(10_000n)).toBe("100%");
    });

    it("formatRatio", () => {
      expect(sdk.formatRatio(200_000_000_000_000_000n)).toBe("20.00%");
    });
  });
});
