// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// ══════════════════════════════════════════════════════════════════════
//  PRIMEVAULTS V3 — IAccounting
//  TVL tracking, gain splitting, and loss waterfall interface
//  See: docs/PV_V3_FINAL_v34.md section 17
// ══════════════════════════════════════════════════════════════════════

import {TrancheId} from "./IPrimeCDO.sol";

/**
 * @title IAccounting
 * @notice Interface for the dual-asset Accounting contract
 * @dev Tracks per-tranche TVL (Senior, Mezzanine, Junior base, Junior WETH).
 *      Splits gains: Senior gets target APR, Junior gets residual.
 *      Loss waterfall: WETH cover → Junior base → Mezzanine → Senior.
 *      See MATH_REFERENCE §E5 for gain splitting and §E9 for loss waterfall.
 */
interface IAccounting {
    // ═══════════════════════════════════════════════════════════════════
    //  MUTATIVE
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Update all TVL values based on current strategy and WETH positions
     * @dev Only callable by the paired PrimeCDO. Computes gain/loss, splits gains
     *      according to Senior APR target, runs loss waterfall on negative gain.
     *      Updates srtTargetIndex and lastUpdateTimestamp.
     *      See MATH_REFERENCE §E8 for gain splitting algorithm.
     * @param currentStrategyTVL Current total assets reported by the strategy
     * @param currentWethValueUSD Current WETH buffer value in USD (from AaveWETHAdapter.totalAssetsUSD)
     */
    function updateTVL(uint256 currentStrategyTVL, uint256 currentWethValueUSD) external;

    /**
     * @notice Record a new deposit into a tranche's TVL
     * @dev Only callable by the paired PrimeCDO. Increases the tranche's tracked TVL.
     * @param id Target tranche
     * @param amount Base-equivalent amount deposited
     */
    function recordDeposit(TrancheId id, uint256 amount) external;

    /**
     * @notice Record a withdrawal from a tranche's TVL
     * @dev Only callable by the paired PrimeCDO. Decreases the tranche's tracked TVL.
     * @param id Target tranche
     * @param amount Base-equivalent amount withdrawn
     */
    function recordWithdraw(TrancheId id, uint256 amount) external;

    /**
     * @notice Record a fee deducted from a tranche's TVL
     * @dev Only callable by the paired PrimeCDO. Moves amount from tranche TVL to reserve.
     * @param id Tranche the fee was charged to
     * @param feeAmount Fee amount in base-equivalent
     */
    function recordFee(TrancheId id, uint256 feeAmount) external;

    /**
     * @notice Directly set the Junior WETH TVL (USD value)
     * @dev Only callable by the paired PrimeCDO. Used when WETH value changes
     *      outside of the normal updateTVL flow (e.g., after rebalance).
     * @param wethValueUSD New WETH buffer value in USD (18 decimals)
     */
    function setJuniorWethTVL(uint256 wethValueUSD) external;

    /**
     * @notice Claim accumulated reserve (fees + gain cuts). Resets s_reserveTVL to 0.
     * @dev Only callable by the paired PrimeCDO.
     * @return amount Reserve amount claimed (base-equivalent, 18 decimals)
     */
    function claimReserve() external returns (uint256 amount);

    // ═══════════════════════════════════════════════════════════════════
    //  VIEW
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Get TVL for a specific tranche
     * @dev For Junior, returns total (base + WETH). Use getJuniorBaseTVL/getJuniorWethTVL for split.
     * @param id Tranche to query
     * @return TVL in base-equivalent (18 decimals)
     */
    function getTrancheTVL(TrancheId id) external view returns (uint256);

    /**
     * @notice Get total Junior TVL (base + WETH combined)
     * @return Total Junior TVL in base-equivalent (18 decimals)
     */
    function getJuniorTVL() external view returns (uint256);

    /**
     * @notice Get Junior base asset TVL only (excluding WETH buffer)
     * @return Junior base TVL in base-equivalent (18 decimals)
     */
    function getJuniorBaseTVL() external view returns (uint256);

    /**
     * @notice Get Junior WETH buffer TVL in USD
     * @return Junior WETH TVL in USD (18 decimals)
     */
    function getJuniorWethTVL() external view returns (uint256);

    /**
     * @notice Get TVL for all three tranches at once
     * @return sr Senior TVL
     * @return mz Mezzanine TVL
     * @return jr Junior total TVL (base + WETH)
     */
    function getAllTVLs() external view returns (uint256 sr, uint256 mz, uint256 jr);

    /**
     * @notice Get the current computed Senior APR
     * @dev Computed from risk premium curves and APR feed.
     *      Formula: APR_sr = MAX(APR_target, APR_base × (1 - RP1 - alpha × RP2))
     *      See MATH_REFERENCE §E5.
     * @return Senior APR as 18-decimal fixed-point
     */
    function getSeniorAPR() external view returns (uint256);
}
