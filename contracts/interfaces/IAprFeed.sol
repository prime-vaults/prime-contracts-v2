// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// ══════════════════════════════════════════════════════════════════════
//  PRIMEVAULTS V3 — IAprFeed
//  Pluggable APR oracle interface (deployed per market)
//  See: docs/PV_V3_FINAL_v34.md section 29
// ══════════════════════════════════════════════════════════════════════

/**
 * @title IAprFeed
 * @notice Interface for APR oracle feeds used by Accounting to compute Senior APR
 * @dev Each market has its own AprPairFeed instance with a market-specific provider.
 *      Returns two rates: aprTarget (Senior floor, from Aave benchmark) and
 *      aprBase (strategy collateral APR, e.g., sUSDe exchange rate growth).
 *      See MATH_REFERENCE §E5 for usage in APR calculation pipeline.
 */
interface IAprFeed {
    // ═══════════════════════════════════════════════════════════════════
    //  EVENTS
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Emitted when APR values are updated
     * @param aprTarget Updated Senior target APR (benchmark floor), 18 decimals
     * @param aprBase Updated strategy base APR, 18 decimals
     * @param timestamp Block timestamp of the update
     */
    event AprUpdated(uint256 aprTarget, uint256 aprBase, uint256 timestamp);

    // ═══════════════════════════════════════════════════════════════════
    //  MUTATIVE
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Fetch latest APR data from the configured provider and update storage
     * @dev Only callable by authorized updater role. Reverts if provider returns invalid data.
     */
    function updateRoundData() external;

    // ═══════════════════════════════════════════════════════════════════
    //  VIEW
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Get the current APR pair (target + base)
     * @dev Reverts if data is stale (exceeds s_staleAfter threshold).
     * @return aprTarget Senior target APR (benchmark floor), 18 decimals
     * @return aprBase Strategy base APR, 18 decimals
     */
    function getAprPair() external view returns (uint256 aprTarget, uint256 aprBase);
}
