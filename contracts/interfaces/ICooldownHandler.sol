// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// ══════════════════════════════════════════════════════════════════════
//  PRIMEVAULTS V3 — ICooldownHandler
//  Common interface for all cooldown mechanisms (ERC20, Unstake, Shares)
//  See: docs/PV_V3_FINAL_v34.md section 24
// ══════════════════════════════════════════════════════════════════════

/** @notice Status of a cooldown request through its lifecycle */
enum CooldownStatus {
    NONE,
    PENDING,
    CLAIMABLE,
    CLAIMED
}

/** @notice Tracks a pending cooldown withdrawal request */
struct CooldownRequest {
    address beneficiary;
    address token;
    uint256 amount;
    uint256 requestTime;
    uint256 unlockTime;
    CooldownStatus status;
}

/**
 * @title ICooldownHandler
 * @notice Interface for cooldown-based withdrawal mechanisms
 * @dev Shared across all markets. Request IDs must be globally unique.
 *      Implementations: ERC20Cooldown, SharesCooldown.
 */
interface ICooldownHandler {
    // ═══════════════════════════════════════════════════════════════════
    //  EVENTS
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Emitted when a new cooldown request is created
     * @param requestId Globally unique ID for this request
     * @param beneficiary Address that will receive tokens on claim
     * @param token Token address being withdrawn
     * @param amount Amount locked in cooldown
     * @param unlockTime Timestamp when the request becomes claimable
     */
    event CooldownRequested(uint256 indexed requestId, address indexed beneficiary, address token, uint256 amount, uint256 unlockTime);

    /**
     * @notice Emitted when a cooldown request is claimed
     * @param requestId The claimed request ID
     * @param beneficiary Address that received the tokens
     * @param token Token address that was withdrawn
     * @param amountOut Actual amount transferred to beneficiary
     */
    event CooldownClaimed(uint256 indexed requestId, address indexed beneficiary, address token, uint256 amountOut);

    // ═══════════════════════════════════════════════════════════════════
    //  MUTATIVE
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Create a new cooldown withdrawal request
     * @dev Only callable by authorized contracts (CDOs, strategies). Locks tokens/shares.
     *      Duration is passed by the caller (from RedemptionPolicy) — single source of truth.
     * @param beneficiary Address that will receive tokens when claimed
     * @param token Token being withdrawn
     * @param amount Amount to lock in cooldown
     * @param duration Cooldown duration in seconds (from RedemptionPolicy)
     * @return requestId Globally unique request ID
     */
    function request(address beneficiary, address token, uint256 amount, uint256 duration) external returns (uint256 requestId);

    /**
     * @notice Claim a completed cooldown request and transfer tokens to beneficiary
     * @dev Reverts if cooldown period has not elapsed or request already claimed.
     * @param requestId The request to claim
     * @return amountOut Actual amount transferred to beneficiary
     */
    function claim(uint256 requestId) external returns (uint256 amountOut);

    // ═══════════════════════════════════════════════════════════════════
    //  VIEW
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Check whether a cooldown request can be claimed now
     * @param requestId The request to check
     * @return true if the request is past its unlock time and not yet claimed
     */
    function isClaimable(uint256 requestId) external view returns (bool);

    /**
     * @notice Get full details of a cooldown request
     * @param requestId The request to query
     * @return The CooldownRequest struct with all fields
     */
    function getRequest(uint256 requestId) external view returns (CooldownRequest memory);

    /**
     * @notice Get all pending (unclaimed) request IDs for a beneficiary
     * @param beneficiary Address to query
     * @return Array of request IDs
     */
    function getPendingRequests(address beneficiary) external view returns (uint256[] memory);

    /**
     * @notice Seconds remaining until a request becomes claimable
     * @dev Returns 0 if already claimable or claimed.
     * @param requestId The request to check
     * @return Seconds remaining (0 if claimable)
     */
    function timeRemaining(uint256 requestId) external view returns (uint256);
}
