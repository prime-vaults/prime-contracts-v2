// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// ══════════════════════════════════════════════════════════════════════
//  PRIMEVAULTS V3 — IStakedUSDai
//  Partial interface for sUSDai (Arbiscan-verified ABI)
//  ERC-4626 deposit + ERC-7540 FIFO queue redeem
// ══════════════════════════════════════════════════════════════════════

/**
 * @title IStakedUSDai
 * @notice Partial interface for sUSDai matching actual Arbitrum deployment ABI.
 * @dev sUSDai: 0x0B2b2B2076d95dda7817e785989fE353fe955ef9 (Arbitrum)
 */
interface IStakedUSDai {
    struct Redemption {
        uint256 prev;
        uint256 next;
        uint256 pendingShares;
        uint256 redeemableShares;
        uint256 withdrawableAmount;
        address controller;
        uint64 redemptionTimestamp;
    }

    // ERC-4626
    function deposit(uint256 assets, address receiver) external returns (uint256 shares);
    function convertToAssets(uint256 shares) external view returns (uint256);
    function convertToShares(uint256 assets) external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);

    // ERC-7540 FIFO queue
    function requestRedeem(uint256 shares, address controller, address owner) external returns (uint256 redemptionId);
    function redemption(uint256 redemptionId) external view returns (Redemption memory, uint256);
    function claimableRedeemRequest(uint256 redemptionId, address controller) external view returns (uint256);
    function pendingRedeemRequest(uint256 redemptionId, address controller) external view returns (uint256);
    function redeem(uint256 shares, address receiver, address controller) external returns (uint256);
    function redemptionIds(address controller) external view returns (uint256[] memory);
}
