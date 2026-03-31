// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// ══════════════════════════════════════════════════════════════════════
//  PRIMEVAULTS V3 — ERC20Cooldown
//  Lock ERC-20 tokens during cooldown, release to beneficiary on claim
//  See: docs/PV_V3_FINAL_v34.md section 25
// ══════════════════════════════════════════════════════════════════════

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ICooldownHandler, CooldownRequest, CooldownStatus} from "../interfaces/ICooldownHandler.sol";

/**
 * @title ERC20Cooldown
 * @notice Locks ERC-20 tokens during a cooldown period, releases to beneficiary on claim.
 * @dev Shared across all markets. Request IDs are globally unique.
 *      Flow: authorized caller (CDO/strategy) calls request() → tokens locked here →
 *      after unlockTime, anyone calls claim() → tokens sent to beneficiary.
 *      No expiry — tokens can be claimed at any time after unlock.
 */
contract ERC20Cooldown is Ownable2Step, ICooldownHandler {
    using SafeERC20 for IERC20;

    // ═══════════════════════════════════════════════════════════════════
    //  STATE
    // ═══════════════════════════════════════════════════════════════════

    uint256 public s_nextRequestId;
    uint256 public s_cooldownDuration;  // seconds until claimable

    mapping(uint256 => CooldownRequest) public s_requests;
    mapping(address => uint256[]) private s_beneficiaryRequests;
    mapping(address => bool) public s_authorized;

    // ═══════════════════════════════════════════════════════════════════
    //  ERRORS
    // ═══════════════════════════════════════════════════════════════════

    error PrimeVaults__Unauthorized(address caller);
    error PrimeVaults__NotClaimable(uint256 requestId);
    error PrimeVaults__AlreadyClaimed(uint256 requestId);
    error PrimeVaults__CooldownNotReady(uint256 requestId, uint256 unlockTime);

    // ═══════════════════════════════════════════════════════════════════
    //  MODIFIERS
    // ═══════════════════════════════════════════════════════════════════

    modifier onlyAuthorized() {
        if (!s_authorized[msg.sender]) revert PrimeVaults__Unauthorized(msg.sender);
        _;
    }

    // ═══════════════════════════════════════════════════════════════════
    //  CONSTRUCTOR
    // ═══════════════════════════════════════════════════════════════════

    constructor(address owner_, uint256 cooldownDuration_) Ownable(owner_) {
        s_cooldownDuration = cooldownDuration_;
        s_nextRequestId = 1;
    }

    // ═══════════════════════════════════════════════════════════════════
    //  MUTATIVE
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Create a new cooldown request. Locks tokens from caller.
     * @dev Only callable by authorized contracts (CDOs, strategies).
     */
    function request(address beneficiary, address token, uint256 amount) external override onlyAuthorized returns (uint256 requestId) {
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);

        requestId = s_nextRequestId++;
        uint256 unlockTime = block.timestamp + s_cooldownDuration;

        s_requests[requestId] = CooldownRequest({
            beneficiary: beneficiary,
            token: token,
            amount: amount,
            requestTime: block.timestamp,
            unlockTime: unlockTime,
            status: CooldownStatus.PENDING
        });

        s_beneficiaryRequests[beneficiary].push(requestId);

        emit CooldownRequested(requestId, beneficiary, token, amount, unlockTime);
    }

    /**
     * @notice Claim a completed cooldown request. Transfers tokens to beneficiary.
     * @dev Anyone can call (beneficiary or on their behalf).
     */
    function claim(uint256 requestId) external override returns (uint256 amountOut) {
        CooldownRequest storage req = s_requests[requestId];

        if (req.status == CooldownStatus.CLAIMED) revert PrimeVaults__AlreadyClaimed(requestId);
        if (req.status != CooldownStatus.PENDING) revert PrimeVaults__NotClaimable(requestId);
        if (block.timestamp < req.unlockTime) revert PrimeVaults__CooldownNotReady(requestId, req.unlockTime);

        req.status = CooldownStatus.CLAIMED;
        amountOut = req.amount;

        IERC20(req.token).safeTransfer(req.beneficiary, amountOut);

        emit CooldownClaimed(requestId, req.beneficiary, req.token, amountOut);
    }

    // ═══════════════════════════════════════════════════════════════════
    //  VIEW
    // ═══════════════════════════════════════════════════════════════════

    /** @notice Check whether a request can be claimed now. */
    function isClaimable(uint256 requestId) external view override returns (bool) {
        CooldownRequest memory req = s_requests[requestId];
        return req.status == CooldownStatus.PENDING && block.timestamp >= req.unlockTime;
    }

    /** @notice Get full details of a request. */
    function getRequest(uint256 requestId) external view override returns (CooldownRequest memory) {
        return s_requests[requestId];
    }

    /** @notice Get all pending request IDs for a beneficiary. */
    function getPendingRequests(address beneficiary) external view override returns (uint256[] memory) {
        uint256[] memory allIds = s_beneficiaryRequests[beneficiary];
        uint256 count;
        for (uint256 i = 0; i < allIds.length; i++) {
            if (s_requests[allIds[i]].status == CooldownStatus.PENDING) count++;
        }

        uint256[] memory pending = new uint256[](count);
        uint256 idx;
        for (uint256 i = 0; i < allIds.length; i++) {
            if (s_requests[allIds[i]].status == CooldownStatus.PENDING) {
                pending[idx++] = allIds[i];
            }
        }
        return pending;
    }

    /** @notice Seconds remaining until claimable. 0 if already claimable or claimed. */
    function timeRemaining(uint256 requestId) external view override returns (uint256) {
        CooldownRequest memory req = s_requests[requestId];
        if (req.status != CooldownStatus.PENDING || block.timestamp >= req.unlockTime) return 0;
        return req.unlockTime - block.timestamp;
    }

    // ═══════════════════════════════════════════════════════════════════
    //  ADMIN
    // ═══════════════════════════════════════════════════════════════════

    function setAuthorized(address addr, bool authorized) external onlyOwner {
        s_authorized[addr] = authorized;
    }

    function setCooldownDuration(uint256 duration_) external onlyOwner {
        s_cooldownDuration = duration_;
    }

}
