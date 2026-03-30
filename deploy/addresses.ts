/**
 * Arbitrum mainnet contract addresses used by the deploy scripts.
 */
export const ARBITRUM = {
  SUSDAI: "0x0B2b2B2076d95dda7817e785989fE353fe955ef9",
  USDAI: "0x0A1a1A107E45b7Ced86833863f482BC5f4ed82EF",
  AAVE_V3_POOL: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
  WETH: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
  CHAINLINK_ETH_USD: "0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612",
  UNISWAP_V3_ROUTER: "0xE592427A0AEce92De3Edee1F18E0157C05861564",
} as const;

/**
 * Default protocol parameters for MVP deployment.
 */
export const DEFAULTS = {
  RATIO_TARGET: BigInt("200000000000000000"), // 0.20e18 = 20%
  RATIO_TOLERANCE: BigInt("30000000000000000"), // 0.03e18 = 3%
  MIN_COVERAGE_DEPOSIT: BigInt("1050000000000000000"), // 1.05e18 = 105%
  SHORTFALL_PAUSE_PRICE: BigInt("900000000000000000"), // 0.90e18 = 90%
  ERC20_COOLDOWN_DURATION: 3 * 86_400, // 3 days
  ERC20_COOLDOWN_EXPIRY: 3 * 86_400, // 3 days
  SHARES_COOLDOWN_DURATION: 7 * 86_400, // 7 days
  APR_STALE_AFTER: 30 * 86_400, // 30 days
  SWAP_MAX_SLIPPAGE: 100, // 1%
  SWAP_EMERGENCY_SLIPPAGE: 1000, // 10%
} as const;

/**
 * Deployed addresses — populated by deploy scripts, consumed by configure + verify.
 */
export interface DeployedAddresses {
  // Shared (01)
  riskParams: string;
  wethPriceOracle: string;
  swapFacility: string;
  erc20Cooldown: string;
  unstakeCooldown: string;
  sharesCooldown: string;
  // Market (02)
  aprProvider: string;
  aprFeed: string;
  accounting: string;
  strategy: string;
  cooldownImpl: string;
  aaveAdapter: string;
  redemptionPolicy: string;
  primeCDO: string;
  seniorVault: string;
  mezzVault: string;
  juniorVault: string;
  // Periphery (04)
  primeLens: string;
}

export function loadDeployed(): DeployedAddresses {
  try {
    return require("./deployed.json");
  } catch {
    throw new Error("deployed.json not found — run 01 and 02 first");
  }
}

export function saveDeployed(addresses: Partial<DeployedAddresses>) {
  const fs = require("fs");
  const path = require("path");
  const file = path.join(__dirname, "deployed.json");
  let existing: Partial<DeployedAddresses> = {};
  try {
    existing = require(file);
  } catch {}
  const merged = { ...existing, ...addresses };
  fs.writeFileSync(file, JSON.stringify(merged, null, 2));
}
