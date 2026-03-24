// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @dev Mock sUSDai vault: ERC-4626 deposit (sync) + ERC-7540 redeem (async ~7 days).
 *      - deposit(assets, receiver) → pull USDai, mint sUSDai shares
 *      - requestRedeem(shares, receiver, owner) → burn shares, start cooldown
 *      - redeem(shares, receiver, owner) → transfer USDai after cooldown
 *      - convertToAssets/convertToShares with configurable exchange rate
 */
contract MockSUSDai is ERC20 {
    IERC20 public immutable usdai;
    uint256 private _rate; // 1e18 = 1:1
    uint256 public cooldownDuration;

    struct RedeemRequest {
        address receiver;
        uint256 assets;
        uint256 unlockTime;
        bool claimed;
    }

    mapping(uint256 => RedeemRequest) public s_redeemRequests;
    uint256 public s_nextRequestId;

    event RedeemRequested(uint256 indexed requestId, address indexed owner, uint256 shares, uint256 assets, uint256 unlockTime);

    constructor(address usdai_, uint256 initialRate_) ERC20("Staked USDai", "sUSDai") {
        usdai = IERC20(usdai_);
        _rate = initialRate_;
        cooldownDuration = 7 days;
    }

    // ═══════════════════════════════════════════════════════════════════
    //  ERC-4626 — deposit (synchronous)
    // ═══════════════════════════════════════════════════════════════════

    function deposit(uint256 assets, address receiver) external returns (uint256 shares) {
        shares = convertToShares(assets);
        usdai.transferFrom(msg.sender, address(this), assets);
        _mint(receiver, shares);
    }

    // ═══════════════════════════════════════════════════════════════════
    //  ERC-7540 — async redeem
    // ═══════════════════════════════════════════════════════════════════

    function requestRedeem(uint256 shares, address receiver, address owner_) external returns (uint256 requestId) {
        require(balanceOf(owner_) >= shares, "insufficient shares");
        if (msg.sender != owner_) {
            // simplified: require sender == owner or approved
            require(msg.sender == owner_, "not owner");
        }

        uint256 assets = convertToAssets(shares);
        _burn(owner_, shares);

        requestId = s_nextRequestId++;
        s_redeemRequests[requestId] = RedeemRequest({
            receiver: receiver,
            assets: assets,
            unlockTime: block.timestamp + cooldownDuration,
            claimed: false
        });

        emit RedeemRequested(requestId, owner_, shares, assets, block.timestamp + cooldownDuration);
    }

    function redeem(uint256 requestId, address receiver, address) external returns (uint256 assets) {
        RedeemRequest storage req = s_redeemRequests[requestId];
        require(!req.claimed, "already claimed");
        require(block.timestamp >= req.unlockTime, "cooldown not complete");
        require(req.receiver == receiver, "wrong receiver");

        req.claimed = true;
        assets = req.assets;
        usdai.transfer(receiver, assets);
    }

    function isRedeemable(uint256 requestId) external view returns (bool) {
        RedeemRequest memory req = s_redeemRequests[requestId];
        return !req.claimed && block.timestamp >= req.unlockTime;
    }

    // ═══════════════════════════════════════════════════════════════════
    //  ERC-4626 — view
    // ═══════════════════════════════════════════════════════════════════

    function convertToAssets(uint256 shares) public view returns (uint256) {
        return shares * _rate / 1e18;
    }

    function convertToShares(uint256 assets) public view returns (uint256) {
        return assets * 1e18 / _rate;
    }

    function setRate(uint256 newRate) external {
        _rate = newRate;
    }

    function setCooldownDuration(uint256 duration_) external {
        cooldownDuration = duration_;
    }
}
