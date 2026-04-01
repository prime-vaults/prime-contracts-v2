import type { ContractAddresses, TrancheId } from "../types";

export interface AdminConfig {
  rpcUrl: string;
  addresses: ContractAddresses & AdminAddresses;
}

export interface AdminAddresses {
  riskParams: string;
  swapFacility: string;
  redemptionPolicy: string;
}

export interface PremiumCurve {
  x: bigint;
  y: bigint;
  k: bigint;
}

export interface RiskParamsState {
  seniorPremium: PremiumCurve;
  juniorPremium: PremiumCurve;
  alpha: bigint;
  reserveBps: bigint;
}

export interface AccountingState {
  seniorTVL: bigint;
  mezzTVL: bigint;
  juniorBaseTVL: bigint;
  juniorWethTVL: bigint;
  reserveTVL: bigint;
  lastUpdateTimestamp: bigint;
  seniorAPR: bigint;
  mezzAPR: bigint;
}

export interface CDOConfig {
  minCoverageForDeposit: bigint;
  juniorShortfallPausePrice: bigint;
  shortfallPaused: boolean;
  ratioTarget: bigint;
  ratioTolerance: bigint;
  ratioController: string;
  owner: string;
}

export interface MezzParams {
  instantCs: bigint;
  assetLockCs: bigint;
}

export interface JuniorParams {
  instantCs: bigint;
  instantCm: bigint;
  assetLockCs: bigint;
  assetLockCm: bigint;
}

export interface MechanismConfig {
  instantFeeBps: bigint;
  assetsLockFeeBps: bigint;
  assetsLockDuration: bigint;
  sharesLockFeeBps: bigint;
  sharesLockDuration: bigint;
}

export interface RedemptionPolicyState {
  mezzParams: MezzParams;
  juniorParams: JuniorParams;
  coverageSenior: bigint;
  coverageMezz: bigint;
  seniorConfig: MechanismConfig;
  mezzConfig: MechanismConfig;
  juniorConfig: MechanismConfig;
}

export interface SwapConfig {
  maxSlippage: bigint;
  emergencySlippage: bigint;
}

export interface StrategyState {
  paused: boolean;
  totalAssets: bigint;
  isActive: boolean;
}

export interface AdminDashboard {
  cdo: CDOConfig;
  accounting: AccountingState;
  riskParams: RiskParamsState;
  redemptionPolicy: RedemptionPolicyState;
  swap: SwapConfig;
  strategy: StrategyState;
}

export interface AdminWriteResult {
  hash: string;
  gasEstimate: bigint;
  gasPrice: bigint;
  estimatedFeeWei: bigint;
}
