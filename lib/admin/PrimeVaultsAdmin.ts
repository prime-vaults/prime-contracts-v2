import {
  createPublicClient,
  http,
  type PublicClient,
  type WalletClient,
  type Address,
  formatUnits,
} from "viem";
import {
  PRIME_CDO_ADMIN_ABI,
  ACCOUNTING_ADMIN_ABI,
  RISK_PARAMS_ABI,
  REDEMPTION_POLICY_ABI,
  SWAP_FACILITY_ABI,
  STRATEGY_ADMIN_ABI,
} from "../abis/admin";
import type { TrancheId } from "../types";
import type {
  AdminConfig,
  AdminDashboard,
  AdminWriteResult,
  AccountingState,
  CDOConfig,
  RiskParamsState,
  RedemptionPolicyState,
  MechanismConfig,
  PremiumCurve,
  SwapConfig,
  StrategyState,
} from "./types";

const TRANCHE_MAP: Record<TrancheId, number> = { SENIOR: 0, MEZZ: 1, JUNIOR: 2 };

export class PrimeVaultsAdmin {
  readonly config: AdminConfig;
  readonly publicClient: PublicClient;

  constructor(config: AdminConfig) {
    this.config = config;
    this.publicClient = createPublicClient({ transport: http(config.rpcUrl) });
  }

  // ═══════════════════════════════════════════════════════════════════
  //  HELPERS
  // ═══════════════════════════════════════════════════════════════════

  private async _send(
    walletClient: WalletClient,
    address: Address,
    abi: readonly any[],
    functionName: string,
    args: readonly any[] = [],
  ): Promise<AdminWriteResult> {
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

  private get _cdo(): Address {
    return this.config.addresses.primeCDO as Address;
  }
  private get _accounting(): Address {
    return this.config.addresses.accounting as Address;
  }
  private get _riskParams(): Address {
    return this.config.addresses.riskParams as Address;
  }
  private get _redemptionPolicy(): Address {
    return this.config.addresses.redemptionPolicy as Address;
  }
  private get _swapFacility(): Address {
    return this.config.addresses.swapFacility as Address;
  }
  private get _strategy(): Address {
    return this.config.addresses.strategy as Address;
  }

  // ═══════════════════════════════════════════════════════════════════
  //  READ — Full Dashboard (single call)
  // ═══════════════════════════════════════════════════════════════════

  async getDashboard(): Promise<AdminDashboard> {
    const [cdo, accounting, riskParams, redemptionPolicy, swap, strategy] = await Promise.all([
      this.getCDOConfig(),
      this.getAccountingState(),
      this.getRiskParams(),
      this.getRedemptionPolicyState(),
      this.getSwapConfig(),
      this.getStrategyState(),
    ]);
    return { cdo, accounting, riskParams, redemptionPolicy, swap, strategy };
  }

  // ═══════════════════════════════════════════════════════════════════
  //  READ — CDO Config
  // ═══════════════════════════════════════════════════════════════════

  async getCDOConfig(): Promise<CDOConfig> {
    const read = (fn: string) =>
      this.publicClient.readContract({ address: this._cdo, abi: PRIME_CDO_ADMIN_ABI, functionName: fn as any });

    const [minCoverage, pausePrice, paused, target, tolerance, controller, owner] = await Promise.all([
      read("s_minCoverageForDeposit"),
      read("s_juniorShortfallPausePrice"),
      read("s_shortfallPaused"),
      read("s_ratioTarget"),
      read("s_ratioTolerance"),
      read("s_ratioController"),
      read("owner"),
    ]);

    return {
      minCoverageForDeposit: minCoverage as bigint,
      juniorShortfallPausePrice: pausePrice as bigint,
      shortfallPaused: paused as boolean,
      ratioTarget: target as bigint,
      ratioTolerance: tolerance as bigint,
      ratioController: controller as string,
      owner: owner as string,
    };
  }

  // ═══════════════════════════════════════════════════════════════════
  //  READ — Accounting
  // ═══════════════════════════════════════════════════════════════════

  async getAccountingState(): Promise<AccountingState> {
    const read = (fn: string) =>
      this.publicClient.readContract({ address: this._accounting, abi: ACCOUNTING_ADMIN_ABI, functionName: fn as any });

    const [srTVL, mzTVL, jrBase, jrWeth, reserve, timestamp, srAPR, mzAPR] = await Promise.all([
      read("s_seniorTVL"),
      read("s_mezzTVL"),
      read("s_juniorBaseTVL"),
      read("s_juniorWethTVL"),
      read("s_reserveTVL"),
      read("s_lastUpdateTimestamp"),
      read("getSeniorAPR"),
      read("getMezzAPR"),
    ]);

    return {
      seniorTVL: srTVL as bigint,
      mezzTVL: mzTVL as bigint,
      juniorBaseTVL: jrBase as bigint,
      juniorWethTVL: jrWeth as bigint,
      reserveTVL: reserve as bigint,
      lastUpdateTimestamp: timestamp as bigint,
      seniorAPR: srAPR as bigint,
      mezzAPR: mzAPR as bigint,
    };
  }

  // ═══════════════════════════════════════════════════════════════════
  //  READ — Risk Params
  // ═══════════════════════════════════════════════════════════════════

  async getRiskParams(): Promise<RiskParamsState> {
    const read = (fn: string) =>
      this.publicClient.readContract({ address: this._riskParams, abi: RISK_PARAMS_ABI, functionName: fn as any });

    const [senior, junior, alpha, reserveBps] = await Promise.all([
      read("s_seniorPremium"),
      read("s_juniorPremium"),
      read("s_alpha"),
      read("s_reserveBps"),
    ]);

    const toCurve = (raw: any): PremiumCurve => ({ x: raw[0] ?? raw.x, y: raw[1] ?? raw.y, k: raw[2] ?? raw.k });

    return {
      seniorPremium: toCurve(senior),
      juniorPremium: toCurve(junior),
      alpha: alpha as bigint,
      reserveBps: reserveBps as bigint,
    };
  }

  // ═══════════════════════════════════════════════════════════════════
  //  READ — Redemption Policy
  // ═══════════════════════════════════════════════════════════════════

  async getRedemptionPolicyState(): Promise<RedemptionPolicyState> {
    const addr = this._redemptionPolicy;
    const read = (fn: string, args?: readonly any[]) =>
      this.publicClient.readContract({ address: addr, abi: REDEMPTION_POLICY_ABI, functionName: fn as any, args: args as any });

    const [mezzRaw, juniorRaw, coverages, srCfg, mzCfg, jrCfg] = await Promise.all([
      read("s_mezzParams"),
      read("s_juniorParams"),
      read("getCoverages"),
      read("s_mechanismConfig", [TRANCHE_MAP.SENIOR]),
      read("s_mechanismConfig", [TRANCHE_MAP.MEZZ]),
      read("s_mechanismConfig", [TRANCHE_MAP.JUNIOR]),
    ]);

    const toConfig = (raw: any): MechanismConfig => ({
      instantFeeBps: raw[0] ?? raw.instantFeeBps,
      assetsLockFeeBps: raw[1] ?? raw.assetsLockFeeBps,
      assetsLockDuration: raw[2] ?? raw.assetsLockDuration,
      sharesLockFeeBps: raw[3] ?? raw.sharesLockFeeBps,
      sharesLockDuration: raw[4] ?? raw.sharesLockDuration,
    });

    const mz = mezzRaw as any;
    const jr = juniorRaw as any;
    const cov = coverages as any;

    return {
      mezzParams: { instantCs: mz[0] ?? mz.instantCs, assetLockCs: mz[1] ?? mz.assetLockCs },
      juniorParams: {
        instantCs: jr[0] ?? jr.instantCs,
        instantCm: jr[1] ?? jr.instantCm,
        assetLockCs: jr[2] ?? jr.assetLockCs,
        assetLockCm: jr[3] ?? jr.assetLockCm,
      },
      coverageSenior: cov[0] ?? cov.cs,
      coverageMezz: cov[1] ?? cov.cm,
      seniorConfig: toConfig(srCfg),
      mezzConfig: toConfig(mzCfg),
      juniorConfig: toConfig(jrCfg),
    };
  }

  // ═══════════════════════════════════════════════════════════════════
  //  READ — Swap Facility
  // ═══════════════════════════════════════════════════════════════════

  async getSwapConfig(): Promise<SwapConfig> {
    const read = (fn: string) =>
      this.publicClient.readContract({ address: this._swapFacility, abi: SWAP_FACILITY_ABI, functionName: fn as any });

    const [maxSlippage, emergencySlippage] = await Promise.all([read("s_maxSlippage"), read("s_emergencySlippage")]);

    return { maxSlippage: maxSlippage as bigint, emergencySlippage: emergencySlippage as bigint };
  }

  // ═══════════════════════════════════════════════════════════════════
  //  READ — Strategy
  // ═══════════════════════════════════════════════════════════════════

  async getStrategyState(): Promise<StrategyState> {
    const read = (fn: string) =>
      this.publicClient.readContract({ address: this._strategy, abi: STRATEGY_ADMIN_ABI, functionName: fn as any });

    const [paused, totalAssets, isActive] = await Promise.all([read("paused"), read("totalAssets"), read("isActive")]);

    return { paused: paused as boolean, totalAssets: totalAssets as bigint, isActive: isActive as boolean };
  }

  // ═══════════════════════════════════════════════════════════════════
  //  WRITE — Rebalance
  // ═══════════════════════════════════════════════════════════════════

  async rebalanceSellWETH(walletClient: WalletClient): Promise<AdminWriteResult> {
    return this._send(walletClient, this._cdo, PRIME_CDO_ADMIN_ABI, "rebalanceSellWETH");
  }

  async rebalanceBuyWETH(walletClient: WalletClient, maxBaseToRecall: bigint): Promise<AdminWriteResult> {
    return this._send(walletClient, this._cdo, PRIME_CDO_ADMIN_ABI, "rebalanceBuyWETH", [maxBaseToRecall]);
  }

  // ═══════════════════════════════════════════════════════════════════
  //  WRITE — Loss Coverage
  // ═══════════════════════════════════════════════════════════════════

  async executeWETHCoverage(walletClient: WalletClient, lossUSD: bigint): Promise<AdminWriteResult> {
    return this._send(walletClient, this._cdo, PRIME_CDO_ADMIN_ABI, "executeWETHCoverage", [lossUSD]);
  }

  // ═══════════════════════════════════════════════════════════════════
  //  WRITE — Reserve / Fee
  // ═══════════════════════════════════════════════════════════════════

  async claimReserve(walletClient: WalletClient): Promise<AdminWriteResult> {
    return this._send(walletClient, this._cdo, PRIME_CDO_ADMIN_ABI, "claimReserve");
  }

  // ═══════════════════════════════════════════════════════════════════
  //  WRITE — CDO Configuration
  // ═══════════════════════════════════════════════════════════════════

  async setMinCoverageForDeposit(walletClient: WalletClient, minCoverage: bigint): Promise<AdminWriteResult> {
    return this._send(walletClient, this._cdo, PRIME_CDO_ADMIN_ABI, "setMinCoverageForDeposit", [minCoverage]);
  }

  async setJuniorShortfallPausePrice(walletClient: WalletClient, price: bigint): Promise<AdminWriteResult> {
    return this._send(walletClient, this._cdo, PRIME_CDO_ADMIN_ABI, "setJuniorShortfallPausePrice", [price]);
  }

  async unpauseShortfall(walletClient: WalletClient): Promise<AdminWriteResult> {
    return this._send(walletClient, this._cdo, PRIME_CDO_ADMIN_ABI, "unpauseShortfall");
  }

  async setRatioTarget(walletClient: WalletClient, target: bigint): Promise<AdminWriteResult> {
    return this._send(walletClient, this._cdo, PRIME_CDO_ADMIN_ABI, "setRatioTarget", [target]);
  }

  async setRatioTolerance(walletClient: WalletClient, tolerance: bigint): Promise<AdminWriteResult> {
    return this._send(walletClient, this._cdo, PRIME_CDO_ADMIN_ABI, "setRatioTolerance", [tolerance]);
  }

  async setRatioController(walletClient: WalletClient, controller: string): Promise<AdminWriteResult> {
    return this._send(walletClient, this._cdo, PRIME_CDO_ADMIN_ABI, "setRatioController", [controller as Address]);
  }

  // ═══════════════════════════════════════════════════════════════════
  //  WRITE — Risk Params
  // ═══════════════════════════════════════════════════════════════════

  async setSeniorPremium(walletClient: WalletClient, curve: PremiumCurve): Promise<AdminWriteResult> {
    return this._send(walletClient, this._riskParams, RISK_PARAMS_ABI, "setSeniorPremium", [curve]);
  }

  async setJuniorPremium(walletClient: WalletClient, curve: PremiumCurve): Promise<AdminWriteResult> {
    return this._send(walletClient, this._riskParams, RISK_PARAMS_ABI, "setJuniorPremium", [curve]);
  }

  async setAlpha(walletClient: WalletClient, alpha: bigint): Promise<AdminWriteResult> {
    return this._send(walletClient, this._riskParams, RISK_PARAMS_ABI, "setAlpha", [alpha]);
  }

  async setReserveBps(walletClient: WalletClient, reserveBps: bigint): Promise<AdminWriteResult> {
    return this._send(walletClient, this._riskParams, RISK_PARAMS_ABI, "setReserveBps", [reserveBps]);
  }

  // ═══════════════════════════════════════════════════════════════════
  //  WRITE — Redemption Policy
  // ═══════════════════════════════════════════════════════════════════

  async setMezzParams(walletClient: WalletClient, instantCs: bigint, assetLockCs: bigint): Promise<AdminWriteResult> {
    return this._send(walletClient, this._redemptionPolicy, REDEMPTION_POLICY_ABI, "setMezzParams", [
      instantCs,
      assetLockCs,
    ]);
  }

  async setJuniorParams(
    walletClient: WalletClient,
    instantCs: bigint,
    instantCm: bigint,
    assetLockCs: bigint,
    assetLockCm: bigint,
  ): Promise<AdminWriteResult> {
    return this._send(walletClient, this._redemptionPolicy, REDEMPTION_POLICY_ABI, "setJuniorParams", [
      instantCs,
      instantCm,
      assetLockCs,
      assetLockCm,
    ]);
  }

  async setMechanismConfig(
    walletClient: WalletClient,
    tranche: TrancheId,
    config: MechanismConfig,
  ): Promise<AdminWriteResult> {
    return this._send(walletClient, this._redemptionPolicy, REDEMPTION_POLICY_ABI, "setMechanismConfig", [
      TRANCHE_MAP[tranche],
      config,
    ]);
  }

  // ═══════════════════════════════════════════════════════════════════
  //  WRITE — Swap Facility
  // ═══════════════════════════════════════════════════════════════════

  async setSlippage(walletClient: WalletClient, maxSlippage: bigint, emergencySlippage: bigint): Promise<AdminWriteResult> {
    return this._send(walletClient, this._swapFacility, SWAP_FACILITY_ABI, "setSlippage", [
      maxSlippage,
      emergencySlippage,
    ]);
  }

  async setAuthorizedCDO(walletClient: WalletClient, cdo: string, authorized: boolean): Promise<AdminWriteResult> {
    return this._send(walletClient, this._swapFacility, SWAP_FACILITY_ABI, "setAuthorizedCDO", [
      cdo as Address,
      authorized,
    ]);
  }

  async setPoolFee(walletClient: WalletClient, token: string, fee: number): Promise<AdminWriteResult> {
    return this._send(walletClient, this._swapFacility, SWAP_FACILITY_ABI, "setPoolFee", [token as Address, fee]);
  }

  // ═══════════════════════════════════════════════════════════════════
  //  WRITE — Strategy
  // ═══════════════════════════════════════════════════════════════════

  async pauseStrategy(walletClient: WalletClient): Promise<AdminWriteResult> {
    return this._send(walletClient, this._strategy, STRATEGY_ADMIN_ABI, "pause");
  }

  async unpauseStrategy(walletClient: WalletClient): Promise<AdminWriteResult> {
    return this._send(walletClient, this._strategy, STRATEGY_ADMIN_ABI, "unpause");
  }

  // ═══════════════════════════════════════════════════════════════════
  //  UTILS
  // ═══════════════════════════════════════════════════════════════════

  formatAmount(value: bigint, decimals: number = 18): string {
    return formatUnits(value, decimals);
  }

  formatRatio(ratio: bigint): string {
    if (ratio >= 2n ** 255n) return "∞";
    return `${(Number(ratio) / 1e16).toFixed(2)}%`;
  }

  formatBps(bps: bigint): string {
    return `${Number(bps) / 100}%`;
  }
}
