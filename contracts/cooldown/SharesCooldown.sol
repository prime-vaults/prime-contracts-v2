// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// ══════════════════════════════════════════════════════════════════════
//  PRIMEVAULTS V3 — SharesCooldown
//  Escrow vault shares during cooldown, return to CDO on claim
//  See: docs/PV_V3_FINAL_v34.md section 27
// ══════════════════════════════════════════════════════════════════════

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ICooldownHandler, CooldownRequest, CooldownStatus} from "../interfaces/ICooldownHandler.sol";

/**
 * @title SharesCooldown
 * @notice Escrows vault shares during cooldown, returns them to the caller on claim.
 * @dev Key difference from ERC20Cooldown:
 *      - Locks vault SHARES (not underlying assets)
 *      - Shares are NOT burned during cooldown — just escrowed here
 *      - TVL stays counted (shares still in totalSupply) → coverage not reduced
 *      - At claim: shares return to caller (CDO), which then burns at current rate
 *      - User benefits from yield accrued during cooldown (rate may increase)
 *      See MATH_REFERENCE §A4 for SharesLock claim rate formula.
 */
contract SharesCooldown is Ownable2Step, ICooldownHandler {
    using SafeERC20 for IERC20;

    // ═══════════════════════════════════════════════════════════════════
    //  STATE
    // ═══════════════════════════════════════════════════════════════════

    uint256 public s_nextRequestId;
    uint256 public s_cooldownDuration;

    mapping(uint256 => CooldownRequest) public s_requests;
    mapping(uint256 => address) public s_requestCaller; // who to return shares to
    mapping(address => uint256[]) private s_beneficiaryRequests;
    mapping(address => bool) public s_authorized;

    // ═══════════════════════════════════════════════════════════════════
    //  ERRORS
    // ═══════════════════════════════════════════════════════════════════

    error PrimeVaults__Unauthorized(address caller);
    error PrimeVaults__AlreadyClaimed(uint256 requestId);
    error PrimeVaults__CooldownNotReady(uint256 requestId, uint256 unlockTime);
    error PrimeVaults__NotPending(uint256 requestId);

    // ═══════════════════════════════════════════════════════════════════
    //  MODIFIERS
    // ═══════════════════════════════════════════════════════════════════

    modifier onlyAuthorized() {
        if (!s_authorized[msg.sender])
            revert PrimeVaults__Unauthorized(msg.sender);
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
    //  ICooldownHandler — MUTATIVE
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Escrow vault shares from caller. Shares NOT burned — just held here.
     * @dev token = vault share address. Shares stay in totalSupply → TVL unchanged.
     */
    function request(
        address beneficiary,
        address token,
        uint256 amount
    ) external override onlyAuthorized returns (uint256 requestId) {
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);

        requestId = s_nextRequestId++;
        uint256 unlockTime = block.timestamp + s_cooldownDuration;

        s_requests[requestId] = CooldownRequest({
            beneficiary: beneficiary,
            token: token,
            amount: amount,
            requestTime: block.timestamp,
            unlockTime: unlockTime,
            expiryTime: 0, // no expiry for SharesCooldown
            status: CooldownStatus.PENDING
        });

        s_requestCaller[requestId] = msg.sender;
        s_beneficiaryRequests[beneficiary].push(requestId);

        emit CooldownRequested(
            requestId,
            beneficiary,
            token,
            amount,
            unlockTime
        );
    }

    /**
     * @notice Return escrowed shares to the original caller (CDO) after cooldown.
     * @dev Shares go back to caller (not beneficiary) — CDO then burns at current rate
     *      and sends assets to beneficiary. This preserves the "claim at current rate" design.
     */
    function claim(
        uint256 requestId
    ) external override returns (uint256 amountOut) {
        CooldownRequest storage req = s_requests[requestId];

        if (req.status == CooldownStatus.CLAIMED)
            revert PrimeVaults__AlreadyClaimed(requestId);
        if (req.status != CooldownStatus.PENDING)
            revert PrimeVaults__NotPending(requestId);
        if (block.timestamp < req.unlockTime)
            revert PrimeVaults__CooldownNotReady(requestId, req.unlockTime);

        req.status = CooldownStatus.CLAIMED;
        amountOut = req.amount;

        // Return shares to original caller (CDO), NOT to beneficiary
        address caller = s_requestCaller[requestId];
        IERC20(req.token).safeTransfer(caller, amountOut);

        emit CooldownClaimed(requestId, req.beneficiary, req.token, amountOut);
    }

    // ═══════════════════════════════════════════════════════════════════
    //  ICooldownHandler — VIEW
    // ═══════════════════════════════════════════════════════════════════

    function isClaimable(
        uint256 requestId
    ) external view override returns (bool) {
        CooldownRequest memory req = s_requests[requestId];
        return
            req.status == CooldownStatus.PENDING &&
            block.timestamp >= req.unlockTime;
    }

    function getRequest(
        uint256 requestId
    ) external view override returns (CooldownRequest memory) {
        return s_requests[requestId];
    }

    function getPendingRequests(
        address beneficiary
    ) external view override returns (uint256[] memory) {
        uint256[] memory allIds = s_beneficiaryRequests[beneficiary];
        uint256 count;
        for (uint256 i = 0; i < allIds.length; i++) {
            if (s_requests[allIds[i]].status == CooldownStatus.PENDING) count++;
        }
        uint256[] memory pending = new uint256[](count);
        uint256 idx;
        for (uint256 i = 0; i < allIds.length; i++) {
            if (s_requests[allIds[i]].status == CooldownStatus.PENDING)
                pending[idx++] = allIds[i];
        }
        return pending;
    }

    function timeRemaining(
        uint256 requestId
    ) external view override returns (uint256) {
        CooldownRequest memory req = s_requests[requestId];
        if (
            req.status != CooldownStatus.PENDING ||
            block.timestamp >= req.unlockTime
        ) return 0;
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
