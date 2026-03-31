// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// ══════════════════════════════════════════════════════════════════════
//  PRIMEVAULTS V3 — IStrategy
//  Strategy interface for yield source adapters (1 CDO = 1 Strategy)
//  See: docs/PV_V3_FINAL_v34.md section 15
// ══════════════════════════════════════════════════════════════════════

/** @notice Type of withdrawal mechanism returned by a strategy */
enum WithdrawType {
    INSTANT,
    ASSETS_LOCK
}

/** @notice Result returned by strategy withdraw operations */
struct WithdrawResult {
    WithdrawType wType;
    uint256 amountOut;
    uint256 cooldownId;
    address cooldownHandler;
    uint256 unlockTime;
}

/**
 * @title IStrategy
 * @notice Interface for yield source strategy adapters
 * @dev Each PrimeCDO is paired 1:1 with exactly one strategy implementation.
 *      Strategies handle deposit/withdraw routing to the underlying yield protocol.
 */
interface IStrategy {
    // ═══════════════════════════════════════════════════════════════════
    //  EVENTS
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Emitted when tokens are deposited into the yield source
     * @param token The deposited token address
     * @param amount The amount deposited
     * @param shares The yield-bearing shares received
     */
    event Deposited(address indexed token, uint256 amount, uint256 shares);

    /**
     * @notice Emitted when tokens are withdrawn from the yield source
     * @param token The withdrawn token address
     * @param amount The amount withdrawn
     * @param shares The yield-bearing shares redeemed
     */
    event Withdrawn(address indexed token, uint256 amount, uint256 shares);

    /**
     * @notice Emitted when an emergency withdrawal is executed
     * @param amount The total amount recovered
     */
    event EmergencyWithdrawn(uint256 amount);

    // ═══════════════════════════════════════════════════════════════════
    //  MUTATIVE
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Deposit the base asset into the yield source
     * @dev Only callable by the paired PrimeCDO. Transfers base asset from caller.
     * @param amount Amount of base asset to deposit
     * @return shares Yield-bearing shares received from the yield source
     */
    function deposit(uint256 amount) external returns (uint256 shares);

    /**
     * @notice Deposit a supported token (may differ from base asset) into the yield source
     * @dev Only callable by the paired PrimeCDO. Handles token conversion if needed.
     * @param token Address of the token to deposit
     * @param amount Amount of token to deposit
     * @return shares Yield-bearing shares received from the yield source
     */
    function depositToken(address token, uint256 amount) external returns (uint256 shares);

    /**
     * @notice Withdraw base-equivalent value from the yield source
     * @dev Only callable by the paired PrimeCDO. May return instant funds or initiate cooldown.
     * @param amount Amount of base-equivalent value to withdraw
     * @param outputToken Desired output token (determines withdraw type)
     * @param beneficiary Address that will receive the withdrawn tokens
     * @return result Struct describing the withdrawal outcome and any cooldown details
     */
    function withdraw(uint256 amount, address outputToken, address beneficiary) external returns (WithdrawResult memory result);

    /**
     * @notice Emergency withdrawal of all assets back to the CDO
     * @dev Only callable by governance via PrimeCDO. Bypasses normal cooldown flow.
     * @return amountOut Total base-equivalent amount recovered
     */
    function emergencyWithdraw() external returns (uint256 amountOut);

    // ═══════════════════════════════════════════════════════════════════
    //  VIEW
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Total base-equivalent value of all assets held by this strategy
     * @dev Used by Accounting to compute TVL changes and gain/loss.
     * @return Total assets in base asset decimals
     */
    function totalAssets() external view returns (uint256);

    /**
     * @notice The base asset denomination for this strategy
     * @return Address of the base asset token (e.g., USDe)
     */
    function baseAsset() external view returns (address);

    /**
     * @notice List of all tokens accepted for deposit
     * @return Array of supported token addresses
     */
    function supportedTokens() external view returns (address[] memory);

    /**
     * @notice Predict which withdrawal mechanism will be used for a given output token
     * @dev Used by RedemptionPolicy to determine cooldown type before executing.
     * @param outputToken The token the user wants to receive
     * @return The WithdrawType that will be applied
     */
    function predictWithdrawType(address outputToken) external view returns (WithdrawType);

    /**
     * @notice List of cooldown handler contracts used by this strategy
     * @return Array of ICooldownHandler addresses
     */
    function getCooldownHandlers() external view returns (address[] memory);

    /**
     * @notice Human-readable name of the strategy (e.g., "Ethena sUSDe")
     * @return Strategy name string
     */
    function name() external view returns (string memory);

    /**
     * @notice Whether the strategy is currently active and accepting deposits
     * @return true if active, false if paused or decommissioned
     */
    function isActive() external view returns (bool);
}
