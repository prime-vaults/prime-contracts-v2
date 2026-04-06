import { createPublicClient, http, type PublicClient, type Address } from "viem";
import { PRIME_LENS_ABI, TRANCHE_VAULT_ABI, ACCOUNTING_ABI, PRIME_CDO_ABI, ERC20_ABI } from "./abis";
import { CooldownType } from "./types";
import type {
  PrimeVaultsConfig,
  ContractAddresses,
  TrancheId,
  TrancheInfo,
  JuniorTrancheInfo,
  PreviewDeposit,
  PreviewJuniorDeposit,
  PreviewWithdraw,
  PendingWithdraw,
  ProtocolHealth,
  RebalanceStatus,
  UserPortfolio,
} from "./types";

const TRANCHE_MAP: Record<TrancheId, number> = { SENIOR: 0, MEZZ: 1, JUNIOR: 2 };
const PRECISION = 10n ** 18n;

export class PrimeVaultsSDK {
  readonly config: PrimeVaultsConfig;
  readonly publicClient: PublicClient;
  readonly addresses: ContractAddresses;

  constructor(config: PrimeVaultsConfig) {
    this.config = config;
    this.addresses = config.addresses;
    this.publicClient = createPublicClient({
      transport: http(config.rpcUrl),
    });
  }

  // ═══════════════════════════════════════════════════════════════════
  //  READ — Tranches
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Get tranche info by ID: trancheId, totalAssets, totalSupply, sharePrice, asset, apr.
   * For Junior-specific data (WETH, ratio, etc.), use getJuniorTranche() instead.
   */
  async getTrancheById(trancheId: TrancheId): Promise<TrancheInfo> {
    const trancheNum = TRANCHE_MAP[trancheId];
    const vaultAddr = this._getVaultAddress(trancheId);
    const aprFn = trancheId === "SENIOR" ? "getSeniorAPR" : trancheId === "MEZZ" ? "getMezzAPR" : "getJuniorAPR";

    const results = await this.publicClient.multicall({
      contracts: [
        {
          address: this.addresses.primeLens as Address,
          abi: PRIME_LENS_ABI,
          functionName: "getTrancheInfo",
          args: [trancheNum],
        },
        { address: this.addresses.accounting as Address, abi: ACCOUNTING_ABI, functionName: aprFn },
        { address: vaultAddr as Address, abi: TRANCHE_VAULT_ABI, functionName: "asset" },
      ],
    });

    const [lensResult, aprResult, assetResult] = results;
    if (lensResult.status !== "success") throw new Error(`getTrancheInfo(${trancheId}) failed`);

    const info = lensResult.result as any;
    return {
      trancheId,
      vault: info.vault,
      name: info.name,
      symbol: info.symbol,
      totalAssets: info.totalAssets,
      totalSupply: info.totalSupply,
      sharePrice: info.sharePrice,
      asset: assetResult.status === "success" ? (assetResult.result as string) : "",
      apr: aprResult.status === "success" ? (aprResult.result as bigint) : 0n,
    };
  }

  // ═══════════════════════════════════════════════════════════════════
  //  READ — Preview Deposit
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Preview deposit for Senior or Mezzanine: how many shares for a given base amount.
   * For Junior, use previewJuniorDeposit() instead.
   */
  async previewDeposit(trancheId: TrancheId, amount: bigint): Promise<PreviewDeposit> {
    if (trancheId === "JUNIOR") throw new Error("Use previewJuniorDeposit() for Junior");

    const vaultAddr = this._getVaultAddress(trancheId);
    const results = await this.publicClient.multicall({
      contracts: [
        { address: vaultAddr as Address, abi: TRANCHE_VAULT_ABI, functionName: "previewDeposit", args: [amount] },
        { address: vaultAddr as Address, abi: TRANCHE_VAULT_ABI, functionName: "totalAssets" },
        { address: vaultAddr as Address, abi: TRANCHE_VAULT_ABI, functionName: "totalSupply" },
      ],
    });

    const shares = results[0].status === "success" ? (results[0].result as bigint) : 0n;
    const totalAssets = results[1].status === "success" ? (results[1].result as bigint) : 0n;
    const totalSupply = results[2].status === "success" ? (results[2].result as bigint) : 0n;
    const sharePrice = totalSupply > 0n ? (totalAssets * PRECISION) / totalSupply : PRECISION;

    return { trancheId, shares, sharePrice, totalBaseValue: amount };
  }

  /**
   * Preview Junior dual-asset deposit: computes shares, WETH valuation, ratio.
   * If wethAmount omitted, auto-computes from ratioTarget via getWethNeeded logic.
   * @param baseAmount Base asset amount (18 decimals)
   * @param wethAmount WETH amount (18 decimals). If omitted, computed from ratio target.
   */
  async previewJuniorDeposit(baseAmount: bigint, wethAmount?: bigint): Promise<PreviewJuniorDeposit> {
    const state = await this._fetchJuniorDepositState();

    // Auto-compute wethAmount if not provided
    if (wethAmount === undefined) {
      const { ratioTarget, wethPrice } = state;
      if (ratioTarget > 0n && ratioTarget < PRECISION && wethPrice > 0n) {
        const wethValueUSD = (baseAmount * ratioTarget) / (PRECISION - ratioTarget);
        wethAmount = (wethValueUSD * PRECISION) / wethPrice;
      } else {
        wethAmount = 0n;
      }
    }

    const wethValueUSD = (wethAmount * state.wethPrice) / PRECISION;
    const totalBaseValue = baseAmount + wethValueUSD;

    // Share calculation (same as TrancheVault.depositJunior: pre-deposit snapshot)
    const sharePrice = state.totalSupply > 0n ? (state.totalAssets * PRECISION) / state.totalSupply : PRECISION;
    const shares = state.totalSupply > 0n ? (totalBaseValue * state.totalSupply) / state.totalAssets : totalBaseValue;

    // Ratio
    const wethRatio = totalBaseValue > 0n ? (wethValueUSD * PRECISION) / totalBaseValue : 0n;

    return {
      trancheId: "JUNIOR",
      shares,
      sharePrice,
      totalBaseValue,
      baseAmount,
      wethAmount,
      wethValueUSD,
      wethPrice: state.wethPrice,
      wethRatio,
    };
  }

  /**
   * Given a base deposit amount, compute how much WETH is needed to match the ratio target.
   * @param baseAmount Base asset amount (18 decimals)
   */
  async getWethNeeded(
    baseAmount: bigint,
  ): Promise<{ wethNeeded: bigint; wethValueUSD: bigint; wethPrice: bigint; ratioTarget: bigint }> {
    const state = await this._fetchJuniorDepositState();
    const { ratioTarget, wethPrice } = state;

    if (ratioTarget === 0n || ratioTarget >= PRECISION || wethPrice === 0n) {
      return { wethNeeded: 0n, wethValueUSD: 0n, wethPrice, ratioTarget };
    }

    const wethValueUSD = (baseAmount * ratioTarget) / (PRECISION - ratioTarget);
    const wethNeeded = (wethValueUSD * PRECISION) / wethPrice;

    return { wethNeeded, wethValueUSD, wethPrice, ratioTarget };
  }

  // ═══════════════════════════════════════════════════════════════════
  //  READ — Preview Withdraw
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Preview withdrawal: given shares, returns mechanism (lock type), cooldown duration,
   * fee, net base amount out, and for Junior: proportional WETH.
   * @param trancheId Tranche to withdraw from
   * @param shares Vault shares to redeem (18 decimals)
   */
  async previewWithdraw(trancheId: TrancheId, shares: bigint): Promise<PreviewWithdraw> {
    const trancheNum = TRANCHE_MAP[trancheId];
    const vaultAddr = this._getVaultAddress(trancheId);

    const contracts: any[] = [
      // convertToAssets: how much base for these shares
      { address: vaultAddr as Address, abi: TRANCHE_VAULT_ABI, functionName: "convertToAssets", args: [shares] },
      // RedemptionPolicy via PrimeLens: mechanism, fee, duration
      {
        address: this.addresses.primeLens as Address,
        abi: PRIME_LENS_ABI,
        functionName: "previewWithdrawCondition",
        args: [trancheNum],
      },
    ];

    // Junior: also fetch WETH position for proportional calc
    if (trancheId === "JUNIOR") {
      contracts.push(
        { address: this.addresses.primeLens as Address, abi: PRIME_LENS_ABI, functionName: "getJuniorPosition" },
        { address: vaultAddr as Address, abi: TRANCHE_VAULT_ABI, functionName: "totalSupply" },
      );
    }

    const results = await this.publicClient.multicall({ contracts });

    const baseAmountOut = results[0].status === "success" ? (results[0].result as bigint) : 0n;
    const cond = results[1].status === "success" ? (results[1].result as any) : null;

    const mechanism: CooldownType = cond ? Number(cond.mechanism) : CooldownType.NONE;
    const feeBps = cond ? cond.feeBps : 0n;
    const cooldownDuration = cond ? cond.cooldownDuration : 0n;

    const feeAmount = (baseAmountOut * feeBps) / 10_000n;
    const netBaseAmount = baseAmountOut - feeAmount;

    // Junior: proportional WETH = totalWeth × shares / totalSupply
    let wethAmount = 0n;
    let wethValueUSD = 0n;

    if (trancheId === "JUNIOR" && results.length > 3) {
      const pos = results[2].status === "success" ? (results[2].result as any) : null;
      const totalSupply = results[3].status === "success" ? (results[3].result as bigint) : 0n;

      if (pos && totalSupply > 0n) {
        wethAmount = (pos.wethAmount * shares) / totalSupply;
        wethValueUSD = (wethAmount * pos.wethPrice) / PRECISION;
      }
    }

    return {
      trancheId,
      mechanism,
      cooldownDuration,
      feeBps,
      feeAmount,
      netBaseAmount,
      baseAmountOut,
      wethAmount,
      wethValueUSD,
    };
  }

  // ═══════════════════════════════════════════════════════════════════
  //  READ — Protocol Health
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Get protocol health: all TVLs, coverage ratios, pause state.
   */
  async getProtocolHealth(): Promise<ProtocolHealth> {
    const result = await this.publicClient.readContract({
      address: this.addresses.primeLens as Address,
      abi: PRIME_LENS_ABI,
      functionName: "getProtocolHealth",
    });

    const h = result as any;
    return {
      seniorTVL: h.seniorTVL,
      mezzTVL: h.mezzTVL,
      juniorTVL: h.juniorTVL,
      totalTVL: h.totalTVL,
      coverageSenior: h.coverageSenior,
      coverageMezz: h.coverageMezz,
      minCoverageForDeposit: h.minCoverageForDeposit,
      shortfallPaused: h.shortfallPaused,
      juniorShortfallPausePrice: h.juniorShortfallPausePrice,
      strategyTVL: h.strategyTVL,
    };
  }

  // ═══════════════════════════════════════════════════════════════════
  //  READ — User Withdraw Requests
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Get all pending + claimable withdraw requests for a user.
   * Each item includes: requestId, handler, token, amount, unlockTime, status, isClaimable, timeRemaining.
   * @param user Wallet address
   */
  async getUserWithdrawRequests(user: string): Promise<PendingWithdraw[]> {
    const result = await this.publicClient.readContract({
      address: this.addresses.primeLens as Address,
      abi: PRIME_LENS_ABI,
      functionName: "getUserPendingWithdraws",
      args: [user as Address],
    });

    return (result as any[]).map((w: any) => ({
      requestId: w.requestId,
      handler: w.handler,
      beneficiary: w.beneficiary,
      token: w.token,
      amount: w.amount,
      unlockTime: w.unlockTime,
      status: Number(w.status),
      isClaimable: w.isClaimable,
      timeRemaining: w.timeRemaining,
    }));
  }

  // ═══════════════════════════════════════════════════════════════════
  //  READ — Token & Share Balances
  // ═══════════════════════════════════════════════════════════════════

  /** Get ERC20 token balance for a user. */
  async getTokenBalance(token: string, user: string): Promise<bigint> {
    return (await this.publicClient.readContract({
      address: token as Address,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [user as Address],
    })) as bigint;
  }

  /** Get ERC20 allowance (owner → spender). */
  async getTokenAllowance(token: string, owner: string, spender: string): Promise<bigint> {
    return (await this.publicClient.readContract({
      address: token as Address,
      abi: ERC20_ABI,
      functionName: "allowance",
      args: [owner as Address, spender as Address],
    })) as bigint;
  }

  /** Get vault share balance for a user. */
  async getShareBalance(trancheId: TrancheId, user: string): Promise<bigint> {
    const vaultAddr = this._getVaultAddress(trancheId);
    return (await this.publicClient.readContract({
      address: vaultAddr as Address,
      abi: TRANCHE_VAULT_ABI,
      functionName: "balanceOf",
      args: [user as Address],
    })) as bigint;
  }

  /** Convert shares to assets (no fee/mechanism — raw ERC4626 conversion). */
  async previewRedeem(trancheId: TrancheId, shares: bigint): Promise<bigint> {
    const vaultAddr = this._getVaultAddress(trancheId);
    return (await this.publicClient.readContract({
      address: vaultAddr as Address,
      abi: TRANCHE_VAULT_ABI,
      functionName: "previewRedeem",
      args: [shares],
    })) as bigint;
  }

  // ═══════════════════════════════════════════════════════════════════
  //  READ — Rebalance & Portfolio
  // ═══════════════════════════════════════════════════════════════════

  /** Get WETH rebalance status: current ratio, target, needs sell/buy. */
  async getRebalanceStatus(): Promise<RebalanceStatus> {
    const result = await this.publicClient.readContract({
      address: this.addresses.primeLens as Address,
      abi: PRIME_LENS_ABI,
      functionName: "getWETHRebalanceStatus",
    });
    const s = result as any;
    return {
      currentRatio: s.currentRatio,
      targetRatio: s.targetRatio,
      tolerance: s.tolerance,
      wethAmount: s.wethAmount,
      wethValueUSD: s.wethValueUSD,
      wethPrice: s.wethPrice,
      needsSell: s.needsSell,
      needsBuy: s.needsBuy,
      excessOrDeficitUSD: s.excessOrDeficitUSD,
    };
  }

  /** Get aggregated user portfolio across all 3 tranches. */
  async getUserPortfolio(user: string): Promise<UserPortfolio> {
    const vaults = [this.addresses.seniorVault, this.addresses.mezzVault, this.addresses.juniorVault];

    // 1. Get share balances
    const balResults = await this.publicClient.multicall({
      contracts: vaults.map((v) => ({
        address: v as Address,
        abi: TRANCHE_VAULT_ABI,
        functionName: "balanceOf" as const,
        args: [user as Address],
      })),
    });

    const shares = balResults.map((r) => (r.status === "success" ? (r.result as bigint) : 0n));

    // 2. Convert shares to assets
    const assetResults = await this.publicClient.multicall({
      contracts: vaults.map((v, i) => ({
        address: v as Address,
        abi: TRANCHE_VAULT_ABI,
        functionName: "convertToAssets" as const,
        args: [shares[i]],
      })),
    });

    const assets = assetResults.map((r) => (r.status === "success" ? (r.result as bigint) : 0n));

    return {
      senior: { shares: shares[0], assets: assets[0] },
      mezz: { shares: shares[1], assets: assets[1] },
      junior: { shares: shares[2], assets: assets[2] },
      totalAssetsUSD: assets[0] + assets[1] + assets[2],
    };
  }

  // ═══════════════════════════════════════════════════════════════════
  //  INTERNAL
  // ═══════════════════════════════════════════════════════════════════

  private _getVaultAddress(trancheId: TrancheId): string {
    if (trancheId === "SENIOR") return this.addresses.seniorVault;
    if (trancheId === "MEZZ") return this.addresses.mezzVault;
    return this.addresses.juniorVault;
  }

  /** Shared state fetch for previewJuniorDeposit + getWethNeeded (1 multicall, 4 reads). */
  private async _fetchJuniorDepositState(): Promise<{
    totalAssets: bigint;
    totalSupply: bigint;
    wethPrice: bigint;
    ratioTarget: bigint;
  }> {
    const results = await this.publicClient.multicall({
      contracts: [
        { address: this.addresses.juniorVault as Address, abi: TRANCHE_VAULT_ABI, functionName: "totalAssets" },
        { address: this.addresses.juniorVault as Address, abi: TRANCHE_VAULT_ABI, functionName: "totalSupply" },
        { address: this.addresses.primeLens as Address, abi: PRIME_LENS_ABI, functionName: "getJuniorPosition" },
        { address: this.addresses.primeCDO as Address, abi: PRIME_CDO_ABI, functionName: "s_ratioTarget" },
      ],
    });

    const totalAssets = results[0].status === "success" ? (results[0].result as bigint) : 0n;
    const totalSupply = results[1].status === "success" ? (results[1].result as bigint) : 0n;
    const pos = results[2].status === "success" ? (results[2].result as any) : null;
    const ratioTarget = results[3].status === "success" ? (results[3].result as bigint) : 0n;

    return { totalAssets, totalSupply, wethPrice: pos ? pos.wethPrice : 0n, ratioTarget };
  }

  /**
   * Get Junior tranche info with dual-asset details: base TVL, WETH TVL, ratio, Aave APR, etc.
   * Batches PrimeLens tranche info + Junior position + Accounting APR + vault asset in one multicall.
   */
  async getJuniorTranche(): Promise<JuniorTrancheInfo> {
    const results = await this.publicClient.multicall({
      contracts: [
        {
          address: this.addresses.primeLens as Address,
          abi: PRIME_LENS_ABI,
          functionName: "getTrancheInfo",
          args: [2],
        },
        { address: this.addresses.primeLens as Address, abi: PRIME_LENS_ABI, functionName: "getJuniorPosition" },
        { address: this.addresses.accounting as Address, abi: ACCOUNTING_ABI, functionName: "getJuniorAPR" },
        { address: this.addresses.juniorVault as Address, abi: TRANCHE_VAULT_ABI, functionName: "asset" },
      ],
    });

    const [lensResult, posResult, aprResult, assetResult] = results;

    if (lensResult.status !== "success") throw new Error("getTrancheInfo(JUNIOR) failed");
    if (posResult.status !== "success") throw new Error("getJuniorPosition failed");

    const info = lensResult.result as any;
    const pos = posResult.result as any;

    return {
      trancheId: "JUNIOR",
      vault: info.vault,
      name: info.name,
      symbol: info.symbol,
      totalAssets: info.totalAssets,
      totalSupply: info.totalSupply,
      sharePrice: info.sharePrice,
      asset: assetResult.status === "success" ? (assetResult.result as string) : "",
      apr: aprResult.status === "success" ? (aprResult.result as bigint) : 0n,
      baseTVL: pos.baseTVL,
      wethTVL: pos.wethTVL,
      wethAmount: pos.wethAmount,
      wethPrice: pos.wethPrice,
      currentRatio: pos.currentRatio,
      aaveAPR: pos.aaveAPR,
    };
  }
}
