// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// ══════════════════════════════════════════════════════════════════════
//  PRIMEVAULTS V3 — AaveAprProvider
//  Reads Aave v3 Arbitrum USDC + USDT supply rate as benchmark APR
//  See: docs/PV_V3_APR_ORACLE.md section 2
// ══════════════════════════════════════════════════════════════════════

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @dev Minimal Aave v3 Pool interface for reading reserve data.
 */
interface IAavePool {
    struct ReserveData {
        //stores the reserve configuration
        uint256 configuration;
        //the liquidity index. Expressed in ray
        uint128 liquidityIndex;
        //the current supply rate. Expressed in ray
        uint128 currentLiquidityRate;
        //variable borrow index. Expressed in ray
        uint128 variableBorrowIndex;
        //the current variable borrow rate. Expressed in ray
        uint128 currentVariableBorrowRate;
        //the current stable borrow rate. Expressed in ray
        uint128 currentStableBorrowRate;
        //timestamp of last update
        uint40 lastUpdateTimestamp;
        //the id of the reserve
        uint16 id;
        //aToken address
        address aTokenAddress;
        //stableDebtToken address
        address stableDebtTokenAddress;
        //variableDebtToken address
        address variableDebtTokenAddress;
        //address of the interest rate strategy
        address interestRateStrategyAddress;
        //the current treasury balance, scaled
        uint128 accruedToTreasury;
        //the outstanding unbacked aTokens minted through the bridging feature
        uint128 unbacked;
        //the outstanding debt secured by isolated assets
        uint128 isolationModeTotalDebt;
    }

    function getReserveData(address asset) external view returns (ReserveData memory);
}

/**
 * @title AaveAprProvider
 * @notice Computes benchmark APR from Aave v3 Arbitrum USDC + USDT supply-weighted average.
 * @dev Pure view — no state, no keeper, no snapshot needed.
 *      Aave returns currentLiquidityRate in ray (1e27), converted to wad (1e18).
 *      See MATH_REFERENCE §E1 for benchmark rate formula.
 */
contract AaveAprProvider {
    // ═══════════════════════════════════════════════════════════════════
    //  IMMUTABLES
    // ═══════════════════════════════════════════════════════════════════

    IAavePool public immutable i_aavePool;
    address public immutable i_usdc;
    address public immutable i_usdt;
    address public immutable i_aUsdc;
    address public immutable i_aUsdt;

    uint256 private constant RAY_TO_WAD = 1e9;

    // ═══════════════════════════════════════════════════════════════════
    //  CONSTRUCTOR
    // ═══════════════════════════════════════════════════════════════════

    constructor(address aavePool_, address usdc_, address usdt_, address aUsdc_, address aUsdt_) {
        i_aavePool = IAavePool(aavePool_);
        i_usdc = usdc_;
        i_usdt = usdt_;
        i_aUsdc = aUsdc_;
        i_aUsdt = aUsdt_;
    }

    // ═══════════════════════════════════════════════════════════════════
    //  LOGIC
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Compute benchmark APR = supply-weighted average of Aave USDC + USDT rates.
     * @return aprBenchmark Weighted average APR in 1e18 scale
     */
    function fetchBenchmarkApr() external view returns (uint256 aprBenchmark) {
        uint256 rateUsdc = _getSupplyRate(i_usdc);
        uint256 rateUsdt = _getSupplyRate(i_usdt);

        uint256 supplyUsdc = IERC20(i_aUsdc).totalSupply();
        uint256 supplyUsdt = IERC20(i_aUsdt).totalSupply();
        uint256 totalSupply = supplyUsdc + supplyUsdt;

        if (totalSupply == 0) return 0;

        aprBenchmark = (supplyUsdc * rateUsdc + supplyUsdt * rateUsdt) / totalSupply;
    }

    /**
     * @dev Read currentLiquidityRate from Aave, convert ray (1e27) → wad (1e18).
     */
    function _getSupplyRate(address asset) internal view returns (uint256) {
        IAavePool.ReserveData memory data = i_aavePool.getReserveData(asset);
        return uint256(data.currentLiquidityRate) / RAY_TO_WAD;
    }
}
