// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// ══════════════════════════════════════════════════════════════════════
//  PRIMEVAULTS V3 — SUSDaiCooldownRequestImpl
//  Wraps sUSDai ERC-7540 FIFO queue for UnstakeCooldown
//  See: docs/PV_V3_FINAL_v34.md section 26
// ══════════════════════════════════════════════════════════════════════

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ICooldownRequestImpl} from "../../../interfaces/ICooldownRequestImpl.sol";
import {IStakedUSDai} from "../../../interfaces/IStakedUSDai.sol";

/**
 * @title SUSDaiCooldownRequestImpl
 * @notice Wraps sUSDai's ERC-7540 FIFO queue for PrimeVaults UnstakeCooldown.
 * @dev Flow:
 *      1. initiateCooldown(): requestRedeem → gets redemptionId + exact timestamp
 *      2. isCooldownComplete(): checks claimableRedeemRequest > 0 (source of truth)
 *      3. finalizeCooldown(): calls redeem() → USDai to receiver
 *      Note: unlockTime uses sUSDai.redemptionTimestamp (necessary condition).
 *      But actual claimability depends on USD.AI admin calling serviceRedemptions()
 *      (sufficient condition checked by isCooldownComplete).
 */
contract SUSDaiCooldownRequestImpl is ICooldownRequestImpl {
    // ═══════════════════════════════════════════════════════════════════
    //  IMMUTABLES
    // ═══════════════════════════════════════════════════════════════════

    IStakedUSDai public immutable i_sUSDai;
    address public immutable i_usdai;
    address public immutable i_unstakeCooldown; // only UnstakeCooldown can call

    // ═══════════════════════════════════════════════════════════════════
    //  STATE
    // ═══════════════════════════════════════════════════════════════════

    uint256 public s_nextCooldownId;
    mapping(uint256 => uint256) public s_cooldownToRedemption; // cooldownId → sUSDai redemptionId

    // ═══════════════════════════════════════════════════════════════════
    //  ERRORS
    // ═══════════════════════════════════════════════════════════════════

    error PrimeVaults__Unauthorized(address caller);
    error PrimeVaults__NotClaimable(uint256 cooldownId);
    error PrimeVaults__InvalidCooldownId(uint256 cooldownId);

    // ═══════════════════════════════════════════════════════════════════
    //  MODIFIERS
    // ═══════════════════════════════════════════════════════════════════

    modifier onlyUnstakeCooldown() {
        if (msg.sender != i_unstakeCooldown) revert PrimeVaults__Unauthorized(msg.sender);
        _;
    }

    // ═══════════════════════════════════════════════════════════════════
    //  CONSTRUCTOR
    // ═══════════════════════════════════════════════════════════════════

    constructor(address sUSDai_, address usdai_, address unstakeCooldown_) {
        i_sUSDai = IStakedUSDai(sUSDai_);
        i_usdai = usdai_;
        i_unstakeCooldown = unstakeCooldown_;
        s_nextCooldownId = 1;

        // Approve sUSDai to spend this contract's sUSDai (for requestRedeem owner = this)
        IStakedUSDai(sUSDai_).approve(sUSDai_, type(uint256).max);
    }

    // ═══════════════════════════════════════════════════════════════════
    //  ICooldownRequestImpl
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Initiate sUSDai unstake via ERC-7540 requestRedeem.
     * @dev Shares must already be transferred to this contract.
     *      Reads exact redemptionTimestamp from sUSDai (not estimated).
     * @return cooldownId Internal ID mapping to sUSDai redemptionId
     * @return cooldownDuration Seconds until redemptionTimestamp
     */
    function initiateCooldown(uint256 shares) external override onlyUnstakeCooldown returns (uint256 cooldownId, uint256 cooldownDuration) {
        // Request redeem on sUSDai — controller = this, owner = this
        uint256 redemptionId = i_sUSDai.requestRedeem(shares, address(this), address(this));

        // Read exact timestamp from sUSDai contract
        (IStakedUSDai.Redemption memory r,) = i_sUSDai.redemption(redemptionId);

        cooldownId = s_nextCooldownId++;
        s_cooldownToRedemption[cooldownId] = redemptionId;

        cooldownDuration = uint256(r.redemptionTimestamp) > block.timestamp
            ? uint256(r.redemptionTimestamp) - block.timestamp
            : 0;
    }

    /**
     * @notice Finalize sUSDai unstake — claim USDai from FIFO queue.
     * @dev Checks claimableRedeemRequest > 0 (source of truth from sUSDai).
     */
    function finalizeCooldown(uint256 cooldownId, address receiver) external override onlyUnstakeCooldown returns (uint256 amountOut) {
        uint256 redemptionId = s_cooldownToRedemption[cooldownId];
        if (redemptionId == 0) revert PrimeVaults__InvalidCooldownId(cooldownId);

        uint256 claimable = i_sUSDai.claimableRedeemRequest(redemptionId, address(this));
        if (claimable == 0) revert PrimeVaults__NotClaimable(cooldownId);

        amountOut = i_sUSDai.redeem(claimable, receiver, address(this));
    }

    /**
     * @notice Check if sUSDai redemption has been serviced and is claimable.
     * @dev Source of truth: claimableRedeemRequest > 0 (not timestamp).
     */
    function isCooldownComplete(uint256 cooldownId) external view override returns (bool) {
        uint256 redemptionId = s_cooldownToRedemption[cooldownId];
        if (redemptionId == 0) return false;
        return i_sUSDai.claimableRedeemRequest(redemptionId, address(this)) > 0;
    }

    function yieldToken() external view override returns (address) {
        return address(i_sUSDai);
    }

    function baseAsset() external view override returns (address) {
        return i_usdai;
    }
}
