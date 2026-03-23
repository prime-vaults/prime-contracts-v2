// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @dev Mock ERC-4626 vault simulating sUSDai with a configurable exchange rate.
 *      convertToAssets(1e18) returns the current rate (set by test).
 */
contract MockERC4626 is ERC20 {
    uint256 private _rate; // convertToAssets(1e18) return value

    constructor(string memory name_, string memory symbol_, uint256 initialRate_) ERC20(name_, symbol_) {
        _rate = initialRate_;
    }

    function convertToAssets(uint256 shares) external view returns (uint256) {
        return shares * _rate / 1e18;
    }

    function setRate(uint256 newRate) external {
        _rate = newRate;
    }

    function rate() external view returns (uint256) {
        return _rate;
    }
}
