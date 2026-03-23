// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// ══════════════════════════════════════════════════════════════════════
//  PRIMEVAULTS V3 — SUSDaiAprPairProvider
//  Strata-compatible APR pair provider for sUSDai market (Arbitrum)
//  See: docs/PV_V3_APR_ORACLE.md section 3
// ══════════════════════════════════════════════════════════════════════

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {IStrategyAprPairProvider} from "../../interfaces/IAprPairFeed.sol";

/**
 * @dev Minimal Aave v3 Pool interface for reading reserve data.
 */
interface IAavePool {
    struct ReserveData {
        uint256 configuration;
        uint128 liquidityIndex;
        uint128 currentLiquidityRate;
        uint128 variableBorrowIndex;
        uint128 currentVariableBorrowRate;
        uint128 currentStableBorrowRate;
        uint40 lastUpdateTimestamp;
        uint16 id;
        address aTokenAddress;
        address stableDebtTokenAddress;
        address variableDebtTokenAddress;
        address interestRateStrategyAddress;
        uint128 accruedToTreasury;
        uint128 unbacked;
        uint128 isolationModeTotalDebt;
    }

    function getReserveData(address asset) external view returns (ReserveData memory);
}

/**
 * @title SUSDaiAprPairProvider
 * @notice Computes (aprTarget, aprBase) for sUSDai market in Strata-compatible format.
 * @dev aprTarget: Aave USDC+USDT supply-weighted average (realtime, like Strata getAPRtarget).
 *      aprBase: sUSDai exchange rate growth between snapshots (annualized).
 *      Returns int64 with 12 decimals. Supports negative APR (rate decrease).
 *      getAprPair() is state-changing — shifts snapshots on each call.
 */
contract SUSDaiAprPairProvider is IStrategyAprPairProvider {
    // ═══════════════════════════════════════════════════════════════════
    //  TYPES
    // ═══════════════════════════════════════════════════════════════════

    struct RateSnapshot {
        uint256 rate;
        uint256 timestamp;
    }

    // ═══════════════════════════════════════════════════════════════════
    //  CONSTANTS
    // ═══════════════════════════════════════════════════════════════════

    uint256 private constant RAY_TO_12DEC = 1e15;  // 1e27 → 1e12
    uint256 private constant PRECISION = 1e12;
    uint256 private constant YEAR = 365 days;

    // ═══════════════════════════════════════════════════════════════════
    //  IMMUTABLES
    // ═══════════════════════════════════════════════════════════════════

    IAavePool public immutable i_aavePool;
    address public immutable i_usdc;
    address public immutable i_usdt;
    address public immutable i_aUsdc;
    address public immutable i_aUsdt;
    IERC4626 public immutable i_vault;

    // ═══════════════════════════════════════════════════════════════════
    //  STATE
    // ═══════════════════════════════════════════════════════════════════

    RateSnapshot public s_prevSnapshot;
    RateSnapshot public s_latestSnapshot;

    // ═══════════════════════════════════════════════════════════════════
    //  EVENTS
    // ═══════════════════════════════════════════════════════════════════

    event SnapshotShifted(uint256 prevRate, uint256 newRate, uint256 timestamp);

    // ═══════════════════════════════════════════════════════════════════
    //  CONSTRUCTOR
    // ═══════════════════════════════════════════════════════════════════

    constructor(
        address aavePool_,
        address usdc_,
        address usdt_,
        address aUsdc_,
        address aUsdt_,
        address vault_
    ) {
        i_aavePool = IAavePool(aavePool_);
        i_usdc = usdc_;
        i_usdt = usdt_;
        i_aUsdc = aUsdc_;
        i_aUsdt = aUsdt_;
        i_vault = IERC4626(vault_);

        // Seed first snapshot
        uint256 currentRate = IERC4626(vault_).convertToAssets(1e18);
        s_latestSnapshot = RateSnapshot({rate: currentRate, timestamp: block.timestamp});
    }

    // ═══════════════════════════════════════════════════════════════════
    //  IStrategyAprPairProvider
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Compute APR pair. State-changing: shifts sUSDai snapshots.
     * @dev aprTarget = Aave USDC+USDT weighted avg (realtime, no snapshot needed).
     *      aprBase = sUSDai annualized growth from snapshots. Negative if rate decreased.
     *      First call after deploy: aprBase = 0 (only 1 snapshot exists).
     * @return aprTarget Benchmark APR, int64 × 12 decimals
     * @return aprBase Strategy APR, int64 × 12 decimals
     * @return timestamp Current block timestamp
     */
    function getAprPair() external override returns (int64 aprTarget, int64 aprBase, uint64 timestamp) {
        // --- aprTarget: Aave weighted average (realtime) ---
        aprTarget = _getAaveApr();

        // --- Shift sUSDai snapshots ---
        uint256 prevRate = s_latestSnapshot.rate;
        uint256 prevTimestamp = s_latestSnapshot.timestamp;

        s_prevSnapshot = s_latestSnapshot;
        uint256 currentRate = i_vault.convertToAssets(1e18);
        s_latestSnapshot = RateSnapshot({rate: currentRate, timestamp: block.timestamp});

        emit SnapshotShifted(prevRate, currentRate, block.timestamp);

        // --- aprBase: annualized growth ---
        if (s_prevSnapshot.timestamp == 0 || prevTimestamp == 0) {
            // First call — no prev snapshot to compare against
            return (aprTarget, 0, uint64(block.timestamp));
        }

        uint256 deltaT = block.timestamp - prevTimestamp;
        if (deltaT == 0 || prevRate == 0) {
            return (aprTarget, 0, uint64(block.timestamp));
        }

        // Growth = (currentRate / prevRate - 1), supports negative
        // In 1e12 precision: growth = (currentRate - prevRate) * 1e12 / prevRate
        int256 growth = (int256(currentRate) - int256(prevRate)) * int256(PRECISION) / int256(prevRate);
        // APR = growth × YEAR / deltaT
        int256 apr = growth * int256(YEAR) / int256(deltaT);

        aprBase = int64(apr);
        timestamp = uint64(block.timestamp);
    }

    // ═══════════════════════════════════════════════════════════════════
    //  INTERNAL
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @dev Compute Aave USDC+USDT supply-weighted average APR.
     *      Reads currentLiquidityRate (ray) → converts to int64 × 12 decimals.
     */
    function _getAaveApr() internal view returns (int64) {
        uint256 rateUsdc = _getSupplyRate(i_usdc);
        uint256 rateUsdt = _getSupplyRate(i_usdt);

        uint256 supplyUsdc = IERC20(i_aUsdc).totalSupply();
        uint256 supplyUsdt = IERC20(i_aUsdt).totalSupply();
        uint256 totalSupply = supplyUsdc + supplyUsdt;

        if (totalSupply == 0) return 0;

        uint256 weightedAvg = (supplyUsdc * rateUsdc + supplyUsdt * rateUsdt) / totalSupply;
        return int64(int256(weightedAvg));
    }

    /**
     * @dev Read Aave currentLiquidityRate (ray, 1e27) → convert to 1e12 scale.
     */
    function _getSupplyRate(address asset) internal view returns (uint256) {
        IAavePool.ReserveData memory data = i_aavePool.getReserveData(asset);
        return uint256(data.currentLiquidityRate) / RAY_TO_12DEC;
    }
}
