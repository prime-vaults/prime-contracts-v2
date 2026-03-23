// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// ══════════════════════════════════════════════════════════════════════
//  PRIMEVAULTS V3 — IWETHPriceOracle
//  30-min TWAP ETH price oracle (shared across all markets)
//  See: docs/PV_V3_FINAL_v34.md section 22
// ══════════════════════════════════════════════════════════════════════

/**
 * @title IWETHPriceOracle
 * @notice Interface for the WETH price oracle using Chainlink 30-min TWAP
 * @dev Shared across all markets. Provides two price views:
 *      - getWETHPrice(): 30-min TWAP — used for TVL calculations (manipulation-resistant)
 *      - getSpotPrice(): Latest Chainlink round — used for display/UI only
 *      Reverts if price data is stale (>1 hour since last update).
 */
interface IWETHPriceOracle {
    /**
     * @notice Get the 30-minute TWAP price of WETH in USD
     * @dev Used by AaveWETHAdapter.totalAssetsUSD() and PrimeCDO for ratio calculations.
     *      Intentional 30-min lag prevents oracle manipulation of Junior totalAssets.
     *      Reverts if the oracle data is stale (>1 hour).
     * @return price18 WETH price in USD with 18 decimals
     */
    function getWETHPrice() external view returns (uint256 price18);

    /**
     * @notice Get the latest spot price of WETH in USD from Chainlink
     * @dev For display/UI purposes only. NOT used in TVL calculations.
     *      Reverts if the oracle data is stale.
     * @return price18 WETH spot price in USD with 18 decimals
     */
    function getSpotPrice() external view returns (uint256 price18);
}
