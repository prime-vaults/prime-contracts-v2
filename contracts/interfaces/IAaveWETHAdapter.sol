// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// ══════════════════════════════════════════════════════════════════════
//  PRIMEVAULTS V3 — IAaveWETHAdapter
//  Junior WETH buffer management via Aave v3
//  See: docs/PV_V3_FINAL_v34.md section 20
// ══════════════════════════════════════════════════════════════════════

/**
 * @title IAaveWETHAdapter
 * @notice Interface for the Aave v3 WETH supply/withdraw adapter
 * @dev Manages the Junior tranche's WETH buffer. Supplies WETH to Aave to earn yield
 *      while maintaining instant withdrawability. USD value uses 30-min TWAP price.
 *      Only the paired PrimeCDO can call mutative functions.
 */
interface IAaveWETHAdapter {
    // ═══════════════════════════════════════════════════════════════════
    //  MUTATIVE
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Supply WETH to Aave v3, receiving aWETH
     * @dev Only callable by the paired PrimeCDO. Transfers WETH from caller.
     * @param wethAmount Amount of WETH to supply
     * @return aWethReceived Amount of aWETH received from Aave
     */
    function supply(uint256 wethAmount) external returns (uint256 aWethReceived);

    /**
     * @notice Withdraw a specific amount of WETH from Aave v3
     * @dev Only callable by the paired PrimeCDO.
     * @param wethAmount Amount of WETH to withdraw
     * @param to Address to receive the withdrawn WETH
     * @return amountOut Actual WETH amount withdrawn
     */
    function withdraw(uint256 wethAmount, address to) external returns (uint256 amountOut);

    /**
     * @notice Withdraw all WETH from Aave v3 (emergency or full liquidation)
     * @dev Only callable by the paired PrimeCDO. Redeems entire aWETH balance.
     * @param to Address to receive the withdrawn WETH
     * @return amountOut Total WETH amount withdrawn
     */
    function withdrawAll(address to) external returns (uint256 amountOut);

    // ═══════════════════════════════════════════════════════════════════
    //  VIEW
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Total WETH held in Aave (aWETH balance in WETH terms)
     * @return WETH amount (18 decimals)
     */
    function totalAssets() external view returns (uint256);

    /**
     * @notice Total WETH value in USD using 30-min TWAP price
     * @dev Uses WETHPriceOracle.getWETHPrice() for the TWAP. Intentional 30-min lag
     *      prevents oracle manipulation of Junior totalAssets.
     * @return USD value (18 decimals)
     */
    function totalAssetsUSD() external view returns (uint256);

    /**
     * @notice Current Aave v3 WETH supply APR
     * @return APR as 18-decimal fixed-point
     */
    function currentAPR() external view returns (uint256);
}
