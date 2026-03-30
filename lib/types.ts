export type TrancheId = "SENIOR" | "MEZZ" | "JUNIOR";

export interface PrimeVaultsConfig {
  rpcUrl: string;
  chainId: number;
  addresses: ContractAddresses;
}

export interface ContractAddresses {
  primeCDO: string;
  seniorVault: string;
  mezzVault: string;
  juniorVault: string;
  primeLens?: string;
  accounting?: string;
  strategy?: string;
  aaveAdapter?: string;
  wethPriceOracle?: string;
  swapFacility?: string;
  erc20Cooldown?: string;
  sharesCooldown?: string;
  redemptionPolicy?: string;
  aprFeed?: string;
}

export interface TrancheInfo {
  trancheId: TrancheId;
  vault: string;
  name: string;
  symbol: string;
  totalAssets: bigint;
  totalSupply: bigint;
  sharePrice: bigint;
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
  expiryTime: bigint;
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

export interface CDOWithdrawResult {
  isInstant: boolean;
  amountOut: bigint;
  cooldownId: bigint;
  cooldownHandler: string;
  unlockTime: bigint;
  feeAmount: bigint;
  appliedCooldownType: number;
}

export interface WriteResult {
  hash: string;
  gasEstimate: bigint;
  gasPrice: bigint;
  estimatedFeeWei: bigint;
}

export interface UserPortfolio {
  senior: { shares: bigint; assets: bigint };
  mezz: { shares: bigint; assets: bigint };
  junior: { shares: bigint; assets: bigint };
  totalAssetsUSD: bigint;
}
