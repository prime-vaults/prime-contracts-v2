// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// ══════════════════════════════════════════════════════════════════════
//  PRIMEVAULTS V3 — IRatioController
//  Future dynamic WETH ratio controller (not implemented in MVP)
//  See: docs/PV_V3_FINAL_v34.md section 49
// ══════════════════════════════════════════════════════════════════════

/**
 * @title IRatioController
 * @notice Interface for dynamic WETH ratio controllers
 * @dev NOT implemented in MVP. Pre-wired hook in PrimeCDO for zero-downtime upgrade.
 *      At launch, PrimeCDO uses fixed s_ratioTarget (20%) and s_ratioTolerance (2%).
 *      When s_ratioController != address(0), PrimeCDO delegates to this interface.
 *      See docs/PV_V3_FINAL_v34.md section 49 for upgrade path.
 */
interface IRatioController {
    /**
     * @notice Get the current target WETH ratio for Junior deposits
     * @dev Called by PrimeCDO._getTargetRatio() when s_ratioController is set.
     * @return Target ratio as 18-decimal fixed-point (e.g., 0.20e18 = 20%)
     */
    function getTargetRatio() external view returns (uint256);

    /**
     * @notice Check whether the current WETH ratio is within acceptable bounds
     * @dev Called during deposit validation and rebalance checks.
     * @param currentRatio The current WETH ratio (18-decimal fixed-point)
     * @return true if the ratio is within the controller's tolerance range
     */
    function isBalanced(uint256 currentRatio) external view returns (bool);

    /**
     * @notice Compute how a Junior deposit should be split between base and WETH
     * @dev Called by PrimeCDO.depositJunior() to validate or compute the split.
     * @param totalDepositUSD Total deposit value in USD (18 decimals)
     * @return wethAmountUSD USD value that should go to WETH
     * @return baseAmountUSD USD value that should go to base asset
     */
    function getDepositSplit(uint256 totalDepositUSD) external view returns (uint256 wethAmountUSD, uint256 baseAmountUSD);
}
