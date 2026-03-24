// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// ══════════════════════════════════════════════════════════════════════
//  PRIMEVAULTS V3 — UnstakeCooldown
//  Delegates to strategy-specific CooldownRequestImpl for external unstaking
//  See: docs/PV_V3_FINAL_v34.md section 26
// ══════════════════════════════════════════════════════════════════════

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ICooldownHandler, CooldownRequest, CooldownStatus} from "../interfaces/ICooldownHandler.sol";
import {ICooldownRequestImpl} from "../interfaces/ICooldownRequestImpl.sol";

/**
 * @title UnstakeCooldown
 * @notice Routes unstake cooldowns to strategy-specific CooldownRequestImpl contracts.
 * @dev Shared across all markets. Maps yield token → impl (e.g., sUSDai → SUSDaiCooldownRequestImpl).
 *      Flow: authorized caller requests with token → impl.initiateCooldown() → impl.finalizeCooldown().
 *      Request IDs are globally unique across all impls.
 */
contract UnstakeCooldown is Ownable2Step, ICooldownHandler {
    using SafeERC20 for IERC20;

    // ═══════════════════════════════════════════════════════════════════
    //  STATE
    // ═══════════════════════════════════════════════════════════════════

    uint256 public s_nextRequestId;

    // token → impl mapping
    mapping(address => ICooldownRequestImpl) public s_implementations;

    // requestId → request data
    mapping(uint256 => CooldownRequest) public s_requests;
    // requestId → which impl + cooldownId within that impl
    mapping(uint256 => address) public s_requestImpl;
    mapping(uint256 => uint256) public s_requestCooldownId;

    // beneficiary → requestIds
    mapping(address => uint256[]) private s_beneficiaryRequests;
    mapping(address => bool) public s_authorized;

    // ═══════════════════════════════════════════════════════════════════
    //  ERRORS
    // ═══════════════════════════════════════════════════════════════════

    error PrimeVaults__Unauthorized(address caller);
    error PrimeVaults__NoImplForToken(address token);
    error PrimeVaults__NotClaimable(uint256 requestId);
    error PrimeVaults__AlreadyClaimed(uint256 requestId);

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

    constructor(address owner_) Ownable(owner_) {
        s_nextRequestId = 1;
    }

    // ═══════════════════════════════════════════════════════════════════
    //  ICooldownHandler — MUTATIVE
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Create an unstake cooldown request. Delegates to token-specific impl.
     * @dev Transfers token from caller → impl, calls impl.initiateCooldown().
     *      unlockTime read from protocol (e.g., sUSDai.redemptionTimestamp).
     */
    function request(address beneficiary, address token, uint256 amount) external override onlyAuthorized returns (uint256 requestId) {
        ICooldownRequestImpl impl = s_implementations[token];
        if (address(impl) == address(0)) revert PrimeVaults__NoImplForToken(token);

        // Transfer token from caller to impl
        IERC20(token).safeTransferFrom(msg.sender, address(impl), amount);

        // Delegate to impl
        (uint256 cooldownId, uint256 cooldownDuration) = impl.initiateCooldown(amount);

        requestId = s_nextRequestId++;
        uint256 unlockTime = block.timestamp + cooldownDuration;

        s_requests[requestId] = CooldownRequest({
            beneficiary: beneficiary,
            token: token,
            amount: amount,
            requestTime: block.timestamp,
            unlockTime: unlockTime,
            expiryTime: 0, // no expiry for unstake cooldowns
            status: CooldownStatus.PENDING
        });

        s_requestImpl[requestId] = address(impl);
        s_requestCooldownId[requestId] = cooldownId;
        s_beneficiaryRequests[beneficiary].push(requestId);

        emit CooldownRequested(requestId, beneficiary, token, amount, unlockTime);
    }

    /**
     * @notice Claim a completed unstake cooldown. Delegates to impl.finalizeCooldown().
     * @dev Checks isCooldownComplete() on impl (source of truth from external protocol).
     */
    function claim(uint256 requestId) external override returns (uint256 amountOut) {
        CooldownRequest storage req = s_requests[requestId];
        if (req.status == CooldownStatus.CLAIMED) revert PrimeVaults__AlreadyClaimed(requestId);
        if (req.status != CooldownStatus.PENDING) revert PrimeVaults__NotClaimable(requestId);

        ICooldownRequestImpl impl = ICooldownRequestImpl(s_requestImpl[requestId]);
        uint256 cooldownId = s_requestCooldownId[requestId];

        if (!impl.isCooldownComplete(cooldownId)) revert PrimeVaults__NotClaimable(requestId);

        req.status = CooldownStatus.CLAIMED;
        amountOut = impl.finalizeCooldown(cooldownId, req.beneficiary);

        emit CooldownClaimed(requestId, req.beneficiary, req.token, amountOut);
    }

    // ═══════════════════════════════════════════════════════════════════
    //  ICooldownHandler — VIEW
    // ═══════════════════════════════════════════════════════════════════

    function isClaimable(uint256 requestId) external view override returns (bool) {
        CooldownRequest memory req = s_requests[requestId];
        if (req.status != CooldownStatus.PENDING) return false;

        ICooldownRequestImpl impl = ICooldownRequestImpl(s_requestImpl[requestId]);
        uint256 cooldownId = s_requestCooldownId[requestId];
        return impl.isCooldownComplete(cooldownId);
    }

    function getRequest(uint256 requestId) external view override returns (CooldownRequest memory) {
        return s_requests[requestId];
    }

    function getPendingRequests(address beneficiary) external view override returns (uint256[] memory) {
        uint256[] memory allIds = s_beneficiaryRequests[beneficiary];
        uint256 count;
        for (uint256 i = 0; i < allIds.length; i++) {
            if (s_requests[allIds[i]].status == CooldownStatus.PENDING) count++;
        }
        uint256[] memory pending = new uint256[](count);
        uint256 idx;
        for (uint256 i = 0; i < allIds.length; i++) {
            if (s_requests[allIds[i]].status == CooldownStatus.PENDING) pending[idx++] = allIds[i];
        }
        return pending;
    }

    function timeRemaining(uint256 requestId) external view override returns (uint256) {
        CooldownRequest memory req = s_requests[requestId];
        if (req.status != CooldownStatus.PENDING || block.timestamp >= req.unlockTime) return 0;
        return req.unlockTime - block.timestamp;
    }

    // ═══════════════════════════════════════════════════════════════════
    //  ADMIN
    // ═══════════════════════════════════════════════════════════════════

    function setImplementation(address token, address impl) external onlyOwner {
        s_implementations[token] = ICooldownRequestImpl(impl);
    }

    function setAuthorized(address addr, bool authorized) external onlyOwner {
        s_authorized[addr] = authorized;
    }
}
