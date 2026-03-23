// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// ══════════════════════════════════════════════════════════════════════
//  PRIMEVAULTS V3 — ICooldownRequestImpl
//  Strategy-specific unstake logic (e.g., Ethena sUSDe cooldown)
//  See: docs/PV_V3_FINAL_v34.md section 26
// ══════════════════════════════════════════════════════════════════════

/**
 * @title ICooldownRequestImpl
 * @notice Interface for strategy-specific external protocol unstaking logic
 * @dev Each strategy that requires external cooldowns (e.g., Ethena sUSDe → USDe)
 *      provides an implementation. Called by UnstakeCooldown to initiate and finalize
 *      protocol-native unstaking flows.
 */
interface ICooldownRequestImpl {
    /**
     * @notice Initiate the external protocol's cooldown/unstaking process
     * @dev Called by UnstakeCooldown. Triggers the underlying protocol's unstake
     *      (e.g., Ethena's cooldownShares). The shares should already be transferred.
     * @param shares Amount of yield-bearing shares to unstake
     * @param receiver Address that will receive the base asset after cooldown
     * @return cooldownDuration Expected seconds until the unstake completes
     */
    function initiateCooldown(uint256 shares, address receiver) external returns (uint256 cooldownDuration);

    /**
     * @notice Finalize the external cooldown and transfer base asset to receiver
     * @dev Called by UnstakeCooldown after the protocol's cooldown period has elapsed.
     * @param receiver Address to receive the unstaked base asset
     * @return amountOut Amount of base asset transferred to receiver
     */
    function finalizeCooldown(address receiver) external returns (uint256 amountOut);

    /**
     * @notice Check if the external protocol's cooldown has completed
     * @return true if the cooldown is complete and finalizeCooldown can be called
     */
    function isCooldownComplete() external view returns (bool);

    /**
     * @notice The yield-bearing token that this impl handles unstaking for
     * @return Address of the yield token (e.g., sUSDe)
     */
    function yieldToken() external view returns (address);

    /**
     * @notice The base asset received after unstaking
     * @return Address of the base asset (e.g., USDe)
     */
    function baseAsset() external view returns (address);
}
