// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// ══════════════════════════════════════════════════════════════════════
//  PRIMEVAULTS V3 — ICooldownRequestImpl
//  Strategy-specific unstake logic (e.g., sUSDai ERC-7540 FIFO queue)
//  See: docs/PV_V3_FINAL_v34.md section 26
// ══════════════════════════════════════════════════════════════════════

/**
 * @title ICooldownRequestImpl
 * @notice Interface for strategy-specific external protocol unstaking logic.
 * @dev Each strategy that requires external cooldowns provides an implementation.
 *      Called by UnstakeCooldown to initiate and finalize protocol-native unstaking.
 *      Supports per-request tracking via cooldownId (needed for FIFO queues like sUSDai).
 */
interface ICooldownRequestImpl {
    /**
     * @notice Initiate the external protocol's cooldown/unstaking process.
     * @dev Shares should already be transferred to this contract before calling.
     *      For sUSDai: calls requestRedeem(), reads redemptionTimestamp.
     * @param shares Amount of yield-bearing shares to unstake
     * @return cooldownId Internal ID for this cooldown request
     * @return cooldownDuration Expected seconds until the unstake completes
     */
    function initiateCooldown(uint256 shares) external returns (uint256 cooldownId, uint256 cooldownDuration);

    /**
     * @notice Finalize the external cooldown and transfer base asset to receiver.
     * @dev For sUSDai: checks claimableRedeemRequest > 0, then calls redeem().
     * @param cooldownId The cooldown request to finalize
     * @param receiver Address to receive the unstaked base asset
     * @return amountOut Amount of base asset transferred to receiver
     */
    function finalizeCooldown(uint256 cooldownId, address receiver) external returns (uint256 amountOut);

    /**
     * @notice Check if a specific cooldown request has completed.
     * @dev For sUSDai: returns claimableRedeemRequest() > 0 (source of truth from protocol).
     * @param cooldownId The cooldown request to check
     * @return true if the cooldown is complete and finalizeCooldown can be called
     */
    function isCooldownComplete(uint256 cooldownId) external view returns (bool);

    /** @notice The yield-bearing token that this impl handles unstaking for. */
    function yieldToken() external view returns (address);

    /** @notice The base asset received after unstaking. */
    function baseAsset() external view returns (address);
}
