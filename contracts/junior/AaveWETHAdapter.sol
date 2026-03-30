// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// ══════════════════════════════════════════════════════════════════════
//  PRIMEVAULTS V3 — AaveWETHAdapter
//  Junior WETH buffer — supply/withdraw WETH to Aave v3
//  See: docs/PV_V3_FINAL_v34.md section 20
// ══════════════════════════════════════════════════════════════════════

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IAaveWETHAdapter} from "../interfaces/IAaveWETHAdapter.sol";
import {IWETHPriceOracle} from "../interfaces/IWETHPriceOracle.sol";

/**
 * @dev Minimal Aave v3 Pool interface for supply/withdraw.
 */
interface IAaveV3Pool {
    function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external;
    function withdraw(address asset, uint256 amount, address to) external returns (uint256);

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
 * @title AaveWETHAdapter
 * @notice Manages Junior tranche's WETH buffer via Aave v3.
 * @dev Supplies WETH → receives aWETH (earns yield). Withdraws aWETH → returns WETH.
 *      totalAssetsUSD() uses 30-min TWAP from WETHPriceOracle (manipulation-resistant).
 *      Only the paired PrimeCDO can call mutative functions.
 */
contract AaveWETHAdapter is IAaveWETHAdapter {
    using SafeERC20 for IERC20;

    // ═══════════════════════════════════════════════════════════════════
    //  CONSTANTS
    // ═══════════════════════════════════════════════════════════════════

    uint256 private constant PRECISION = 1e18;
    uint256 private constant RAY_TO_WAD = 1e9;

    // ═══════════════════════════════════════════════════════════════════
    //  IMMUTABLES
    // ═══════════════════════════════════════════════════════════════════

    IAaveV3Pool public immutable i_aavePool;
    IERC20 public immutable i_weth;
    IERC20 public immutable i_aWeth;
    IWETHPriceOracle public immutable i_priceOracle;
    address public immutable i_primeCDO;

    // ═══════════════════════════════════════════════════════════════════
    //  ERRORS
    // ═══════════════════════════════════════════════════════════════════

    error PrimeVaults__Unauthorized(address caller);

    // ═══════════════════════════════════════════════════════════════════
    //  MODIFIERS
    // ═══════════════════════════════════════════════════════════════════

    modifier onlyCDO() {
        if (msg.sender != i_primeCDO) revert PrimeVaults__Unauthorized(msg.sender);
        _;
    }

    // ═══════════════════════════════════════════════════════════════════
    //  CONSTRUCTOR
    // ═══════════════════════════════════════════════════════════════════

    constructor(address aavePool_, address weth_, address priceOracle_, address primeCDO_) {
        i_aavePool = IAaveV3Pool(aavePool_);
        i_weth = IERC20(weth_);
        i_priceOracle = IWETHPriceOracle(priceOracle_);
        i_primeCDO = primeCDO_;

        // Read aWETH address from Aave (not hardcoded)
        IAaveV3Pool.ReserveData memory data = IAaveV3Pool(aavePool_).getReserveData(weth_);
        i_aWeth = IERC20(data.aTokenAddress);

        // Max-approve Aave pool to spend WETH
        IERC20(weth_).approve(aavePool_, type(uint256).max);
    }

    // ═══════════════════════════════════════════════════════════════════
    //  MUTATIVE
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Supply WETH to Aave v3, receiving aWETH.
     * @dev Transfers WETH from caller (CDO), supplies to Aave on behalf of this contract.
     */
    function supply(uint256 wethAmount) external override onlyCDO returns (uint256 aWethReceived) {
        uint256 before = i_aWeth.balanceOf(address(this));
        i_weth.safeTransferFrom(msg.sender, address(this), wethAmount);
        i_aavePool.supply(address(i_weth), wethAmount, address(this), 0);
        aWethReceived = i_aWeth.balanceOf(address(this)) - before;
    }

    /**
     * @notice Withdraw a specific amount of WETH from Aave v3.
     */
    function withdraw(uint256 wethAmount, address to) external override onlyCDO returns (uint256 amountOut) {
        amountOut = i_aavePool.withdraw(address(i_weth), wethAmount, to);
    }

    /**
     * @notice Withdraw all WETH from Aave v3 (emergency or full liquidation).
     */
    function withdrawAll(address to) external override onlyCDO returns (uint256 amountOut) {
        amountOut = i_aavePool.withdraw(address(i_weth), type(uint256).max, to);
    }

    // ═══════════════════════════════════════════════════════════════════
    //  VIEW
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Total WETH held in Aave (aWETH balance ≈ WETH equivalent).
     */
    function totalAssets() external view override returns (uint256) {
        return i_aWeth.balanceOf(address(this));
    }

    /**
     * @notice Total WETH value in USD using latest Chainlink spot price.
     * @dev Uses WETHPriceOracle.getSpotPrice() for MVP simplicity.
     */
    function totalAssetsUSD() external view override returns (uint256) {
        uint256 balance = i_aWeth.balanceOf(address(this));
        uint256 price = i_priceOracle.getSpotPrice();
        return balance * price / PRECISION;
    }

    /**
     * @notice Current Aave v3 WETH supply APR.
     * @dev Reads currentLiquidityRate (ray) → converts to wad (18 dec).
     */
    function currentAPR() external view override returns (uint256) {
        IAaveV3Pool.ReserveData memory data = i_aavePool.getReserveData(address(i_weth));
        return uint256(data.currentLiquidityRate) / RAY_TO_WAD;
    }
}
