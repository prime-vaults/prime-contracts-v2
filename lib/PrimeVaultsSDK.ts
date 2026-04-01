import {
  createPublicClient,
  http,
  decodeEventLog,
  type PublicClient,
  type WalletClient,
  type Address,
  formatUnits,
  parseUnits,
} from "viem";
import { PRIME_LENS_ABI, TRANCHE_VAULT_ABI, ERC20_ABI, ACCOUNTING_ABI } from "./abis";
import { CooldownType } from "./types";
import type {
  PrimeVaultsConfig,
  ContractAddresses,
  TrancheId,
  TrancheInfo,
  JuniorPosition,
  ProtocolHealth,
  PendingWithdraw,
  WithdrawCondition,
  RebalanceStatus,
  CDOWithdrawResult,
  UserPortfolio,
  WriteResult,
  WithdrawRequestResult,
  EstimateJuniorWithdraw,
} from "./types";

const TRANCHE_MAP: Record<TrancheId, number> = { SENIOR: 0, MEZZ: 1, JUNIOR: 2 };

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
  //  HELPERS
  // ═══════════════════════════════════════════════════════════════════

  private _vaultAddress(tranche: TrancheId): Address {
    const map: Record<TrancheId, string> = {
      SENIOR: this.addresses.seniorVault,
      MEZZ: this.addresses.mezzVault,
      JUNIOR: this.addresses.juniorVault,
    };
    return map[tranche] as Address;
  }

  // ═══════════════════════════════════════════════════════════════════
  //  READ — PrimeLens (aggregated views)
  // ═══════════════════════════════════════════════════════════════════

  async getAllTranches(): Promise<{ senior: TrancheInfo; mezz: TrancheInfo; junior: TrancheInfo }> {
    const accountingAddr = this.addresses.accounting as Address;
    const [trancheResult, seniorAPR, mezzAPR, juniorAPR] = await Promise.all([
      this.publicClient.readContract({
        address: this.addresses.primeLens as Address,
        abi: PRIME_LENS_ABI,
        functionName: "getAllTranches",
      }),
      this.publicClient.readContract({
        address: accountingAddr,
        abi: ACCOUNTING_ABI,
        functionName: "getSeniorAPR",
      }),
      this.publicClient.readContract({
        address: accountingAddr,
        abi: ACCOUNTING_ABI,
        functionName: "getMezzAPR",
      }),
      this.getJuniorAPR(),
    ]);
    const [senior, mezz, junior] = trancheResult as unknown as any[];
    const map = (raw: any, id: TrancheId, apr: bigint): TrancheInfo => ({
      trancheId: id,
      vault: raw.vault,
      name: raw.name,
      symbol: raw.symbol,
      totalAssets: raw.totalAssets,
      totalSupply: raw.totalSupply,
      sharePrice: raw.sharePrice,
      apr,
    });
    return {
      senior: map(senior, "SENIOR", seniorAPR as bigint),
      mezz: map(mezz, "MEZZ", mezzAPR as bigint),
      junior: map(junior, "JUNIOR", juniorAPR),
    };
  }

  async getTrancheInfo(tranche: TrancheId): Promise<TrancheInfo> {
    const accountingAddr = this.addresses.accounting as Address;
    const [result, apr] = await Promise.all([
      this.publicClient.readContract({
        address: this.addresses.primeLens as Address,
        abi: PRIME_LENS_ABI,
        functionName: "getTrancheInfo",
        args: [TRANCHE_MAP[tranche]],
      }),
      tranche === "SENIOR"
        ? this.publicClient.readContract({ address: accountingAddr, abi: ACCOUNTING_ABI, functionName: "getSeniorAPR" })
        : tranche === "MEZZ"
          ? this.publicClient.readContract({ address: accountingAddr, abi: ACCOUNTING_ABI, functionName: "getMezzAPR" })
          : this.getJuniorAPR(),
    ]);
    const raw = result as any;
    return {
      trancheId: tranche,
      vault: raw.vault,
      name: raw.name,
      symbol: raw.symbol,
      totalAssets: raw.totalAssets,
      totalSupply: raw.totalSupply,
      sharePrice: raw.sharePrice,
      apr: apr as bigint,
    };
  }

  async getJuniorPosition(): Promise<JuniorPosition> {
    const result = await this.publicClient.readContract({
      address: this.addresses.primeLens as Address,
      abi: PRIME_LENS_ABI,
      functionName: "getJuniorPosition",
    });
    const raw = result as any;
    return {
      baseTVL: raw.baseTVL,
      wethTVL: raw.wethTVL,
      totalTVL: raw.totalTVL,
      wethAmount: raw.wethAmount,
      wethPrice: raw.wethPrice,
      currentRatio: raw.currentRatio,
      aaveAPR: raw.aaveAPR,
    };
  }

  /**
   * Compute total Junior APR = on-chain strategy residual + Aave WETH yield weighted by ratio.
   *
   * Accounting.getJuniorAPR() returns the strategy residual (after Senior & Mezz claims).
   * Aave WETH yield is added here, weighted by the current WETH ratio in the Junior tranche.
   *
   * @returns Junior APR in 18-decimal precision (1e18 = 100%)
   */
  async getJuniorAPR(): Promise<bigint> {
    const PRECISION = 1_000_000_000_000_000_000n;
    const accountingAddr = this.addresses.accounting as Address;

    const [strategyResidualAPR, juniorPos] = await Promise.all([
      this.publicClient.readContract({ address: accountingAddr, abi: ACCOUNTING_ABI, functionName: "getJuniorAPR" }),
      this.getJuniorPosition(),
    ]);

    // Aave WETH yield weighted by WETH ratio
    const wethAPR = (juniorPos.aaveAPR * juniorPos.currentRatio) / PRECISION;

    return (strategyResidualAPR as bigint) + wethAPR;
  }

  async getProtocolHealth(): Promise<ProtocolHealth> {
    const result = await this.publicClient.readContract({
      address: this.addresses.primeLens as Address,
      abi: PRIME_LENS_ABI,
      functionName: "getProtocolHealth",
    });
    const raw = result as any;
    return {
      seniorTVL: raw.seniorTVL,
      mezzTVL: raw.mezzTVL,
      juniorTVL: raw.juniorTVL,
      totalTVL: raw.totalTVL,
      coverageSenior: raw.coverageSenior,
      coverageMezz: raw.coverageMezz,
      minCoverageForDeposit: raw.minCoverageForDeposit,
      shortfallPaused: raw.shortfallPaused,
      juniorShortfallPausePrice: raw.juniorShortfallPausePrice,
      strategyTVL: raw.strategyTVL,
    };
  }

  async getUserPendingWithdraws(user: string): Promise<PendingWithdraw[]> {
    const result = await this.publicClient.readContract({
      address: this.addresses.primeLens as Address,
      abi: PRIME_LENS_ABI,
      functionName: "getUserPendingWithdraws",
      args: [user as Address],
    });
    return (result as any[]).map((raw: any) => ({
      requestId: raw.requestId,
      handler: raw.handler,
      beneficiary: raw.beneficiary,
      token: raw.token,
      amount: raw.amount,
      unlockTime: raw.unlockTime,
      status: raw.status,
      isClaimable: raw.isClaimable,
      timeRemaining: raw.timeRemaining,
    }));
  }

  async getClaimableWithdraws(user: string): Promise<PendingWithdraw[]> {
    const result = await this.publicClient.readContract({
      address: this.addresses.primeLens as Address,
      abi: PRIME_LENS_ABI,
      functionName: "getClaimableWithdraws",
      args: [user as Address],
    });
    return (result as any[]).map((raw: any) => ({
      requestId: raw.requestId,
      handler: raw.handler,
      beneficiary: raw.beneficiary,
      token: raw.token,
      amount: raw.amount,
      unlockTime: raw.unlockTime,
      status: raw.status,
      isClaimable: raw.isClaimable,
      timeRemaining: raw.timeRemaining,
    }));
  }

  async previewWithdrawCondition(tranche: TrancheId): Promise<WithdrawCondition> {
    const result = await this.publicClient.readContract({
      address: this.addresses.primeLens as Address,
      abi: PRIME_LENS_ABI,
      functionName: "previewWithdrawCondition",
      args: [TRANCHE_MAP[tranche]],
    });
    const raw = result as any;
    return {
      mechanism: raw.mechanism,
      feeBps: raw.feeBps,
      cooldownDuration: raw.cooldownDuration,
      coverageSenior: raw.coverageSenior,
      coverageMezz: raw.coverageMezz,
    };
  }

  async getWETHRebalanceStatus(): Promise<RebalanceStatus> {
    const result = await this.publicClient.readContract({
      address: this.addresses.primeLens as Address,
      abi: PRIME_LENS_ABI,
      functionName: "getWETHRebalanceStatus",
    });
    const raw = result as any;
    return {
      currentRatio: raw.currentRatio,
      targetRatio: raw.targetRatio,
      tolerance: raw.tolerance,
      wethAmount: raw.wethAmount,
      wethValueUSD: raw.wethValueUSD,
      wethPrice: raw.wethPrice,
      needsSell: raw.needsSell,
      needsBuy: raw.needsBuy,
      excessOrDeficitUSD: raw.excessOrDeficitUSD,
    };
  }

  // ═══════════════════════════════════════════════════════════════════
  //  READ — TrancheVault (per-vault reads)
  // ═══════════════════════════════════════════════════════════════════

  async getShareBalance(tranche: TrancheId, user: string): Promise<bigint> {
    return this.publicClient.readContract({
      address: this._vaultAddress(tranche),
      abi: TRANCHE_VAULT_ABI,
      functionName: "balanceOf",
      args: [user as Address],
    }) as Promise<bigint>;
  }

  async convertToAssets(tranche: TrancheId, shares: bigint): Promise<bigint> {
    return this.publicClient.readContract({
      address: this._vaultAddress(tranche),
      abi: TRANCHE_VAULT_ABI,
      functionName: "convertToAssets",
      args: [shares],
    }) as Promise<bigint>;
  }

  async convertToShares(tranche: TrancheId, assets: bigint): Promise<bigint> {
    return this.publicClient.readContract({
      address: this._vaultAddress(tranche),
      abi: TRANCHE_VAULT_ABI,
      functionName: "convertToShares",
      args: [assets],
    }) as Promise<bigint>;
  }

  async previewDeposit(tranche: TrancheId, assets: bigint): Promise<bigint> {
    return this.publicClient.readContract({
      address: this._vaultAddress(tranche),
      abi: TRANCHE_VAULT_ABI,
      functionName: "previewDeposit",
      args: [assets],
    }) as Promise<bigint>;
  }

  async previewRedeem(tranche: TrancheId, shares: bigint): Promise<bigint> {
    return this.publicClient.readContract({
      address: this._vaultAddress(tranche),
      abi: TRANCHE_VAULT_ABI,
      functionName: "previewRedeem",
      args: [shares],
    }) as Promise<bigint>;
  }

  async getTotalAssets(tranche: TrancheId): Promise<bigint> {
    return this.publicClient.readContract({
      address: this._vaultAddress(tranche),
      abi: TRANCHE_VAULT_ABI,
      functionName: "totalAssets",
    }) as Promise<bigint>;
  }

  async getTotalSupply(tranche: TrancheId): Promise<bigint> {
    return this.publicClient.readContract({
      address: this._vaultAddress(tranche),
      abi: TRANCHE_VAULT_ABI,
      functionName: "totalSupply",
    }) as Promise<bigint>;
  }

  async getVaultDecimals(tranche: TrancheId): Promise<number> {
    return this.publicClient.readContract({
      address: this._vaultAddress(tranche),
      abi: TRANCHE_VAULT_ABI,
      functionName: "decimals",
    }) as Promise<number>;
  }

  async getVaultAsset(tranche: TrancheId): Promise<string> {
    return this.publicClient.readContract({
      address: this._vaultAddress(tranche),
      abi: TRANCHE_VAULT_ABI,
      functionName: "asset",
    }) as Promise<string>;
  }

  // ═══════════════════════════════════════════════════════════════════
  //  READ — User Portfolio (aggregated)
  // ═══════════════════════════════════════════════════════════════════

  async getUserPortfolio(user: string): Promise<UserPortfolio> {
    const [srShares, mzShares, jrShares] = await Promise.all([
      this.getShareBalance("SENIOR", user),
      this.getShareBalance("MEZZ", user),
      this.getShareBalance("JUNIOR", user),
    ]);

    const [srAssets, mzAssets, jrAssets] = await Promise.all([
      srShares > 0n ? this.convertToAssets("SENIOR", srShares) : Promise.resolve(0n),
      mzShares > 0n ? this.convertToAssets("MEZZ", mzShares) : Promise.resolve(0n),
      jrShares > 0n ? this.convertToAssets("JUNIOR", jrShares) : Promise.resolve(0n),
    ]);

    return {
      senior: { shares: srShares, assets: srAssets },
      mezz: { shares: mzShares, assets: mzAssets },
      junior: { shares: jrShares, assets: jrAssets },
      totalAssetsUSD: srAssets + mzAssets + jrAssets,
    };
  }

  // ═══════════════════════════════════════════════════════════════════
  //  READ — ERC20 Token helpers
  // ═══════════════════════════════════════════════════════════════════

  async getTokenBalance(token: string, user: string): Promise<bigint> {
    return this.publicClient.readContract({
      address: token as Address,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [user as Address],
    }) as Promise<bigint>;
  }

  async getTokenAllowance(token: string, owner: string, spender: string): Promise<bigint> {
    return this.publicClient.readContract({
      address: token as Address,
      abi: ERC20_ABI,
      functionName: "allowance",
      args: [owner as Address, spender as Address],
    }) as Promise<bigint>;
  }

  // ═══════════════════════════════════════════════════════════════════
  //  WRITE — Deposit (requires walletClient)
  // ═══════════════════════════════════════════════════════════════════

  private async _estimateAndSend(
    walletClient: WalletClient,
    address: Address,
    abi: readonly any[],
    functionName: string,
    args: readonly any[],
  ): Promise<WriteResult> {
    const account = walletClient.account!;
    const [gasEstimate, gasPrice] = await Promise.all([
      this.publicClient.estimateContractGas({ address, abi, functionName, args, account }),
      this.publicClient.getGasPrice(),
    ]);
    const hash = await walletClient.writeContract({
      address,
      abi,
      functionName,
      args,
      gas: gasEstimate,
      chain: walletClient.chain,
      account,
    });
    return { hash, gasEstimate, gasPrice, estimatedFeeWei: gasEstimate * gasPrice };
  }

  async deposit(
    walletClient: WalletClient,
    tranche: TrancheId,
    assets: bigint,
    receiver: string,
  ): Promise<WriteResult> {
    return this._estimateAndSend(walletClient, this._vaultAddress(tranche), TRANCHE_VAULT_ABI, "deposit", [
      assets,
      receiver as Address,
    ]);
  }

  async depositJunior(
    walletClient: WalletClient,
    baseAmount: bigint,
    wethAmount: bigint,
    receiver: string,
  ): Promise<WriteResult> {
    return this._estimateAndSend(
      walletClient,
      this.addresses.juniorVault as Address,
      TRANCHE_VAULT_ABI,
      "depositJunior",
      [baseAmount, wethAmount, receiver as Address],
    );
  }

  // ═══════════════════════════════════════════════════════════════════
  //  WRITE — Withdraw
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Request withdrawal from a tranche. Always withdraws sUSDai (hardcoded in CDO).
   * Junior withdrawals also include proportional WETH (follows same mechanism).
   *
   * nextAction types:
   *   - DONE: instant — sUSDai (+ WETH for Junior) received
   *   - CLAIM_COOLDOWN: ASSETS_LOCK — sUSDai + WETH locked in ERC20Cooldown, show timer
   *   - CLAIM_SHARES: SHARES_LOCK — shares escrowed (yield accrues), show timer
   */
  async requestWithdraw(
    walletClient: WalletClient,
    tranche: TrancheId,
    shares: bigint,
    receiver?: string,
  ): Promise<WithdrawRequestResult> {
    const account = walletClient.account!;
    const resolvedReceiver = (receiver ?? account.address) as Address;

    const vaultAddress = this._vaultAddress(tranche);
    const writeResult = await this._estimateAndSend(walletClient, vaultAddress, TRANCHE_VAULT_ABI, "requestWithdraw", [
      shares,
      resolvedReceiver,
    ]);

    // Wait for receipt and parse WithdrawRequested event
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash: writeResult.hash as `0x${string}` });

    let withdrawResult: CDOWithdrawResult = {
      isInstant: false,
      amountOut: 0n,
      cooldownId: 0n,
      cooldownHandler: "0x",
      unlockTime: 0n,
      feeAmount: 0n,
      appliedCooldownType: CooldownType.NONE,
      wethAmount: 0n,
      wethCooldownId: 0n,
    };

    for (const log of receipt.logs) {
      try {
        const decoded = decodeEventLog({ abi: TRANCHE_VAULT_ABI, data: log.data, topics: log.topics });
        if (decoded.eventName === "WithdrawRequested") {
          const r = (decoded.args as any).result;
          withdrawResult = {
            isInstant: r.isInstant,
            amountOut: r.amountOut,
            cooldownId: r.cooldownId,
            cooldownHandler: r.cooldownHandler,
            unlockTime: r.unlockTime,
            feeAmount: r.feeAmount,
            appliedCooldownType: Number(r.appliedCooldownType),
            wethAmount: r.wethAmount ?? 0n,
            wethCooldownId: r.wethCooldownId ?? 0n,
          };
          break;
        }
      } catch {
        // not our event, skip
      }
    }

    // Determine next action for FE
    let nextAction: WithdrawRequestResult["nextAction"];

    if (withdrawResult.isInstant) {
      // Instant: sUSDai + WETH sent directly
      nextAction = { type: "DONE" };
    } else if (withdrawResult.appliedCooldownType === CooldownType.SHARES_LOCK) {
      // SHARES_LOCK: shares escrowed, WETH stays in Aave — both released at claim
      nextAction = {
        type: "CLAIM_SHARES",
        cooldownId: withdrawResult.cooldownId,
        unlockTime: withdrawResult.unlockTime,
      };
    } else {
      // ASSETS_LOCK: sUSDai + WETH both locked in ERC20Cooldown
      nextAction = {
        type: "CLAIM_COOLDOWN",
        cooldownId: withdrawResult.cooldownId,
        cooldownHandler: withdrawResult.cooldownHandler,
        unlockTime: withdrawResult.unlockTime,
        wethCooldownId: withdrawResult.wethCooldownId,
      };
    }

    return { ...writeResult, withdrawResult, nextAction };
  }

  async claimWithdraw(
    walletClient: WalletClient,
    tranche: TrancheId,
    cooldownId: bigint,
    cooldownHandler: string,
  ): Promise<WriteResult> {
    return this._estimateAndSend(walletClient, this._vaultAddress(tranche), TRANCHE_VAULT_ABI, "claimWithdraw", [
      cooldownId,
      cooldownHandler as Address,
    ]);
  }

  async claimSharesWithdraw(walletClient: WalletClient, tranche: TrancheId, cooldownId: bigint): Promise<WriteResult> {
    return this._estimateAndSend(walletClient, this._vaultAddress(tranche), TRANCHE_VAULT_ABI, "claimSharesWithdraw", [
      cooldownId,
    ]);
  }

  // ═══════════════════════════════════════════════════════════════════
  //  WRITE — ERC20 Approve
  // ═══════════════════════════════════════════════════════════════════

  async approveToken(walletClient: WalletClient, token: string, spender: string, amount: bigint): Promise<WriteResult> {
    return this._estimateAndSend(walletClient, token as Address, ERC20_ABI, "approve", [spender as Address, amount]);
  }

  async approveVaultDeposit(
    walletClient: WalletClient,
    tranche: TrancheId,
    token: string,
    amount: bigint,
  ): Promise<WriteResult> {
    return this.approveToken(walletClient, token, this._vaultAddress(tranche), amount);
  }

  // ═══════════════════════════════════════════════════════════════════
  //  READ — Estimate helpers
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Estimate Junior withdraw output for a given share amount.
   * Junior withdrawals return both base assets (with fee) and proportional WETH.
   *
   * Base: shares × juniorBaseTVL / totalSupply (excludes WETH TVL)
   * WETH: proportional = totalWETH × shares / totalSupply
   *
   * @param shares Junior vault shares to withdraw (18 decimals)
   * @returns Breakdown of base amount, fee, net, WETH amount, mechanism, cooldown
   */
  async estimateJuniorWithdraw(shares: bigint): Promise<EstimateJuniorWithdraw> {
    const [condition, juniorPos, totalSupply] = await Promise.all([
      this.previewWithdrawCondition("JUNIOR"),
      this.getJuniorPosition(),
      this.getTotalSupply("JUNIOR"),
    ]);

    // Base amount = only base portion (exclude WETH TVL to avoid double-counting)
    const baseAmount = totalSupply > 0n ? (shares * juniorPos.baseTVL) / totalSupply : 0n;
    const feeAmount = (baseAmount * condition.feeBps) / 10_000n;
    const netBaseAmount = baseAmount - feeAmount;

    const wethAmount = totalSupply > 0n ? (juniorPos.wethAmount * shares) / totalSupply : 0n;
    const wethValueUSD =
      juniorPos.wethPrice > 0n ? (wethAmount * juniorPos.wethPrice) / 1_000_000_000_000_000_000n : 0n;

    return {
      baseAmount,
      feeBps: condition.feeBps,
      feeAmount,
      netBaseAmount,
      wethAmount,
      wethValueUSD,
      mechanism: condition.mechanism,
      cooldownDuration: condition.cooldownDuration,
    };
  }

  /**
   * Estimate the WETH amount needed for a Junior deposit given a base asset amount.
   * Uses the on-chain target ratio and WETH price.
   *
   * Formula: wethAmount = (baseAmount * targetRatio) / ((1 - targetRatio) * wethPrice)
   *
   * @param baseAmount The base asset (USD.AI) amount to deposit (18 decimals)
   * @returns { wethAmount, wethPrice, targetRatio, wethValueUSD }
   */
  async estimateWETHAmount(baseAmount: bigint): Promise<{
    wethAmount: bigint;
    wethPrice: bigint;
    targetRatio: bigint;
    wethValueUSD: bigint;
  }> {
    const PRECISION = 1_000_000_000_000_000_000n; // 1e18

    const [rebalance, juniorPos] = await Promise.all([this.getWETHRebalanceStatus(), this.getJuniorPosition()]);

    const targetRatio = rebalance.targetRatio; // e.g. 0.20e18 = 20%
    const wethPrice = juniorPos.wethPrice; // 18 decimals

    // wethValueUSD = baseAmount * targetRatio / (1e18 - targetRatio)
    const wethValueUSD = (baseAmount * targetRatio) / (PRECISION - targetRatio);

    // wethAmount = wethValueUSD * 1e18 / wethPrice
    const wethAmount = (wethValueUSD * PRECISION) / wethPrice;

    return { wethAmount, wethPrice, targetRatio, wethValueUSD };
  }

  // ═══════════════════════════════════════════════════════════════════
  //  UTILS — Format helpers
  // ═══════════════════════════════════════════════════════════════════

  formatAmount(value: bigint, decimals: number = 18): string {
    return formatUnits(value, decimals);
  }

  parseAmount(value: string, decimals: number = 18): bigint {
    return parseUnits(value, decimals);
  }

  formatSharePrice(sharePrice: bigint): string {
    return formatUnits(sharePrice, 18);
  }

  formatBps(bps: bigint): string {
    return `${Number(bps) / 100}%`;
  }

  formatRatio(ratio: bigint): string {
    if (ratio >= 2n ** 255n) return "∞";
    return `${(Number(ratio) / 1e16).toFixed(2)}%`;
  }
}
