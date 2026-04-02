// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// ══════════════════════════════════════════════════════════════════════
//  PRIMEVAULTS V3 — ISwapFacility
//  WETH ↔ base asset swap interface (shared across all markets)
//  See: docs/PV_V3_FINAL_v34.md section 21
// ══════════════════════════════════════════════════════════════════════

/**
 * @title ISwapFacility
 * @notice Interface for the WETH ↔ base asset swap facility
 * @dev Shared across all markets (ETH price is universal). Used for:
 *      1. Loss coverage: sell WETH → base asset to inject into strategy
 *      2. Rebalance sell: sell excess WETH → base asset
 *      3. Rebalance buy: sell base asset → WETH (governance-only)
 *      Only authorized PrimeCDOs can call mutative functions.
 */
interface ISwapFacility {
    // ═══════════════════════════════════════════════════════════════════
    //  MUTATIVE
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Swap WETH for a base asset (e.g., USDe) via DEX
     * @dev Only callable by authorized PrimeCDOs. Used during rebalance sell and loss coverage.
     * @param outputToken Address of the base asset to receive
     * @param wethAmount Amount of WETH to sell
     * @param minOut Minimum output amount (slippage protection)
     * @return amountOut Actual amount of outputToken received
     */
    function swapWETHFor(address outputToken, uint256 wethAmount, uint256 minOut) external returns (uint256 amountOut);

    /**
     * @notice Swap a base asset for WETH via DEX
     * @dev Only callable by authorized PrimeCDOs. Used during rebalance buy (governance-only).
     * @param inputToken Address of the base asset to sell
     * @param amount Amount of inputToken to sell
     * @param minWethOut Minimum WETH output amount (slippage protection)
     * @return wethOut Actual amount of WETH received
     */
    function swapForWETH(address inputToken, uint256 amount, uint256 minWethOut) external returns (uint256 wethOut);

    // ═══════════════════════════════════════════════════════════════════
    //  VIEW
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Calculate the minimum acceptable output for a WETH swap given slippage tolerance
     * @dev Uses different slippage thresholds for normal vs emergency (loss coverage) swaps.
     * @param wethAmount Amount of WETH to sell
     * @param wethPrice Current WETH price in USD (18 decimals)
     * @param isEmergency true for loss coverage swaps (uses s_emergencySlippage), false for normal (uses s_maxSlippage)
     * @return minOut Minimum acceptable output amount
     */
    function getMinOutput(uint256 wethAmount, uint256 wethPrice, bool isEmergency) external view returns (uint256 minOut);

    /**
     * @notice Quote how much WETH is needed to receive exactly `baseAmountOut` of a base asset.
     * @dev Uses Uniswap V3 QuoterV2. This is a view-like call (uses staticcall internally).
     * @param outputToken Address of the base asset
     * @param baseAmountOut Exact amount of base asset desired
     * @return wethNeeded Amount of WETH required
     */
    function quoteWETHForExactOutput(address outputToken, uint256 baseAmountOut) external returns (uint256 wethNeeded);
}
