import {
  createPublicClient,
  http,
  type PublicClient,
  type WalletClient,
  type Address,
  type Hash,
  formatUnits,
  parseUnits,
} from "viem";
import { PRIME_LENS_ABI, TRANCHE_VAULT_ABI, ERC20_ABI } from "./abis";
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

  private _requireLens(): Address {
    if (!this.addresses.primeLens) throw new Error("primeLens address not configured");
    return this.addresses.primeLens as Address;
  }

  // ═══════════════════════════════════════════════════════════════════
  //  READ — PrimeLens (aggregated views)
  // ═══════════════════════════════════════════════════════════════════

  async getAllTranches(): Promise<{ senior: TrancheInfo; mezz: TrancheInfo; junior: TrancheInfo }> {
    const result = await this.publicClient.readContract({
      address: this._requireLens(),
      abi: PRIME_LENS_ABI,
      functionName: "getAllTranches",
    });
    const [senior, mezz, junior] = result as unknown as any[];
    const map = (raw: any, id: TrancheId): TrancheInfo => ({
      trancheId: id,
      vault: raw.vault,
      name: raw.name,
      symbol: raw.symbol,
      totalAssets: raw.totalAssets,
      totalSupply: raw.totalSupply,
      sharePrice: raw.sharePrice,
    });
    return { senior: map(senior, "SENIOR"), mezz: map(mezz, "MEZZ"), junior: map(junior, "JUNIOR") };
  }

  async getTrancheInfo(tranche: TrancheId): Promise<TrancheInfo> {
    const result = await this.publicClient.readContract({
      address: this._requireLens(),
      abi: PRIME_LENS_ABI,
      functionName: "getTrancheInfo",
      args: [TRANCHE_MAP[tranche]],
    });
    const raw = result as any;
    return {
      trancheId: tranche,
      vault: raw.vault,
      name: raw.name,
      symbol: raw.symbol,
      totalAssets: raw.totalAssets,
      totalSupply: raw.totalSupply,
      sharePrice: raw.sharePrice,
    };
  }

  async getJuniorPosition(): Promise<JuniorPosition> {
    const result = await this.publicClient.readContract({
      address: this._requireLens(),
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

  async getProtocolHealth(): Promise<ProtocolHealth> {
    const result = await this.publicClient.readContract({
      address: this._requireLens(),
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
      address: this._requireLens(),
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
      expiryTime: raw.expiryTime,
      status: raw.status,
      isClaimable: raw.isClaimable,
      timeRemaining: raw.timeRemaining,
    }));
  }

  async getClaimableWithdraws(user: string): Promise<PendingWithdraw[]> {
    const result = await this.publicClient.readContract({
      address: this._requireLens(),
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
      expiryTime: raw.expiryTime,
      status: raw.status,
      isClaimable: raw.isClaimable,
      timeRemaining: raw.timeRemaining,
    }));
  }

  async previewWithdrawCondition(tranche: TrancheId): Promise<WithdrawCondition> {
    const result = await this.publicClient.readContract({
      address: this._requireLens(),
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
      address: this._requireLens(),
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

  async deposit(walletClient: WalletClient, tranche: TrancheId, assets: bigint, receiver: string): Promise<Hash> {
    const vault = this._vaultAddress(tranche);
    return walletClient.writeContract({
      address: vault,
      abi: TRANCHE_VAULT_ABI,
      functionName: "deposit",
      args: [assets, receiver as Address],
      chain: walletClient.chain,
      account: walletClient.account!,
    });
  }

  async depositJunior(
    walletClient: WalletClient,
    baseAmount: bigint,
    wethAmount: bigint,
    receiver: string,
  ): Promise<Hash> {
    return walletClient.writeContract({
      address: this.addresses.juniorVault as Address,
      abi: TRANCHE_VAULT_ABI,
      functionName: "depositJunior",
      args: [baseAmount, wethAmount, receiver as Address],
      chain: walletClient.chain,
      account: walletClient.account!,
    });
  }

  // ═══════════════════════════════════════════════════════════════════
  //  WRITE — Withdraw
  // ═══════════════════════════════════════════════════════════════════

  async requestWithdraw(
    walletClient: WalletClient,
    tranche: TrancheId,
    shares: bigint,
    outputToken: string,
    receiver: string,
  ): Promise<Hash> {
    return walletClient.writeContract({
      address: this._vaultAddress(tranche),
      abi: TRANCHE_VAULT_ABI,
      functionName: "requestWithdraw",
      args: [shares, outputToken as Address, receiver as Address],
      chain: walletClient.chain,
      account: walletClient.account!,
    });
  }

  async claimWithdraw(
    walletClient: WalletClient,
    tranche: TrancheId,
    cooldownId: bigint,
    cooldownHandler: string,
  ): Promise<Hash> {
    return walletClient.writeContract({
      address: this._vaultAddress(tranche),
      abi: TRANCHE_VAULT_ABI,
      functionName: "claimWithdraw",
      args: [cooldownId, cooldownHandler as Address],
      chain: walletClient.chain,
      account: walletClient.account!,
    });
  }

  async claimSharesWithdraw(
    walletClient: WalletClient,
    tranche: TrancheId,
    cooldownId: bigint,
    outputToken: string,
  ): Promise<Hash> {
    return walletClient.writeContract({
      address: this._vaultAddress(tranche),
      abi: TRANCHE_VAULT_ABI,
      functionName: "claimSharesWithdraw",
      args: [cooldownId, outputToken as Address],
      chain: walletClient.chain,
      account: walletClient.account!,
    });
  }

  // ═══════════════════════════════════════════════════════════════════
  //  WRITE — ERC20 Approve
  // ═══════════════════════════════════════════════════════════════════

  async approveToken(walletClient: WalletClient, token: string, spender: string, amount: bigint): Promise<Hash> {
    return walletClient.writeContract({
      address: token as Address,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [spender as Address, amount],
      chain: walletClient.chain,
      account: walletClient.account!,
    });
  }

  async approveVaultDeposit(
    walletClient: WalletClient,
    tranche: TrancheId,
    token: string,
    amount: bigint,
  ): Promise<Hash> {
    return this.approveToken(walletClient, token, this._vaultAddress(tranche), amount);
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
    return `${(Number(ratio) / 1e16).toFixed(2)}%`;
  }
}
