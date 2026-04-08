import { Chain } from "viem";

export enum TrancheId {
  SENIOR,
  MEZZ,
  JUNIOR,
}

export interface PrimeVaultsConfig {
  rpcUrl: string;
  addresses: ContractAddresses;
  chain: Chain;
}

export interface ContractAddresses {
  primeCDO: string;
  seniorVault: string;
  mezzVault: string;
  juniorVault: string;
  primeLens: string;
  accounting: string;
  strategy: string;
  aaveAdapter?: string;
  wethPriceOracle?: string;
  swapFacility?: string;
  erc20Cooldown?: string;
  sharesCooldown?: string;
  redemptionPolicy?: string;
  aprFeed?: string;
  riskParams?: string;
}

export interface TrancheInfo {
  trancheId: TrancheId;
  vault: string;
  name: string;
  symbol: string;
  totalAssets: bigint;
  totalSupply: bigint;
  sharePrice: bigint;
  asset: string;
  apr: bigint;
}

export interface JuniorTrancheInfo extends TrancheInfo {
  baseTVL: bigint;
  wethTVL: bigint;
  wethAmount: bigint;
  wethPrice: bigint;
  currentRatio: bigint;
  aaveAPR: bigint;
}

export interface PreviewDeposit {
  trancheId: TrancheId;
  shares: bigint;
  sharePrice: bigint;
  totalBaseValue: bigint;
}

export interface PreviewJuniorDeposit extends PreviewDeposit {
  baseAmount: bigint;
  wethAmount: bigint;
  wethValueUSD: bigint;
  wethPrice: bigint;
  wethRatio: bigint;
}

export interface PreviewWithdraw {
  trancheId: TrancheId;
  mechanism: CooldownType;
  cooldownDuration: bigint;
  feeBps: bigint;
  feeAmount: bigint;
  netBaseAmount: bigint;
  baseAmountOut: bigint;
  /** Junior only: proportional WETH returned */
  wethAmount: bigint;
  /** Junior only: WETH USD value */
  wethValueUSD: bigint;
}

export interface JuniorPosition {
  baseTVL: bigint;
  wethTVL: bigint;
  totalTVL: bigint;
  wethAmount: bigint;
  wethPrice: bigint;
  currentRatio: bigint;
  aaveAPR: bigint;
}

export interface ProtocolHealth {
  seniorTVL: bigint;
  mezzTVL: bigint;
  juniorTVL: bigint;
  totalTVL: bigint;
  coverageSenior: bigint;
  coverageMezz: bigint;
  minCoverageForDeposit: bigint;
  shortfallPaused: boolean;
  juniorShortfallPausePrice: bigint;
  strategyTVL: bigint;
}

export interface PendingWithdraw {
  requestId: bigint;
  handler: string;
  beneficiary: string;
  token: string;
  amount: bigint;
  unlockTime: bigint;
  status: number;
  isClaimable: boolean;
  timeRemaining: bigint;
}

export interface WithdrawCondition {
  mechanism: number;
  feeBps: bigint;
  cooldownDuration: bigint;
  coverageSenior: bigint;
  coverageMezz: bigint;
}

export interface RebalanceStatus {
  currentRatio: bigint;
  targetRatio: bigint;
  tolerance: bigint;
  wethAmount: bigint;
  wethValueUSD: bigint;
  wethPrice: bigint;
  needsSell: boolean;
  needsBuy: boolean;
  excessOrDeficitUSD: bigint;
}

/** @notice Cooldown mechanism applied to a withdrawal (mirrors Solidity enum) */
export enum CooldownType {
  NONE = 0, // instant withdrawal
  ASSETS_LOCK = 1, // sUSDai/WETH locked in ERC20Cooldown
  SHARES_LOCK = 2, // vault shares escrowed in SharesCooldown
}

export interface CDOWithdrawResult {
  isInstant: boolean;
  amountOut: bigint;
  cooldownId: bigint;
  cooldownHandler: string;
  unlockTime: bigint;
  feeAmount: bigint;
  appliedCooldownType: CooldownType;
  wethAmount: bigint;
  wethCooldownId: bigint;
}

export interface EstimateJuniorWithdraw {
  baseAmount: bigint;
  feeBps: bigint;
  feeAmount: bigint;
  netBaseAmount: bigint;
  wethAmount: bigint;
  wethValueUSD: bigint;
  mechanism: number;
  cooldownDuration: bigint;
}

export interface WriteResult {
  hash: string;
  gasEstimate: bigint;
  gasPrice: bigint;
  estimatedFeeWei: bigint;
}

/**
 * Returned by requestWithdraw — includes tx info + parsed CDOWithdrawResult from event.
 * FE uses `nextAction` to determine what to show the user next.
 */
export interface WithdrawRequestResult extends WriteResult {
  /** Parsed CDOWithdrawResult from WithdrawRequested event */
  withdrawResult: CDOWithdrawResult;
  /** What the FE should do next */
  nextAction:
    | { type: "DONE" }
    | {
        type: "CLAIM_COOLDOWN";
        cooldownId: bigint;
        cooldownHandler: string;
        unlockTime: bigint;
        wethCooldownId: bigint;
      }
    | { type: "CLAIM_SHARES"; cooldownId: bigint; unlockTime: bigint };
}

export interface UserPortfolio {
  senior: { shares: bigint; assets: bigint };
  mezz: { shares: bigint; assets: bigint };
  junior: { shares: bigint; assets: bigint };
  totalAssetsUSD: bigint;
}
