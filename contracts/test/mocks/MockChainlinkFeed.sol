// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @dev Mock Chainlink AggregatorV3Interface for testing WETHPriceOracle.
 *      Allows setting price, updatedAt, and decimals.
 */
contract MockChainlinkFeed {
    int256 private _price;
    uint256 private _updatedAt;
    uint8 private _decimals;

    constructor(uint8 decimals_, int256 initialPrice_) {
        _decimals = decimals_;
        _price = initialPrice_;
        _updatedAt = block.timestamp;
    }

    function setPrice(int256 price_) external {
        _price = price_;
        _updatedAt = block.timestamp;
    }

    function setPriceAndTimestamp(int256 price_, uint256 updatedAt_) external {
        _price = price_;
        _updatedAt = updatedAt_;
    }

    function setUpdatedAt(uint256 updatedAt_) external {
        _updatedAt = updatedAt_;
    }

    function decimals() external view returns (uint8) {
        return _decimals;
    }

    function latestRoundData() external view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound) {
        return (1, _price, _updatedAt, _updatedAt, 1);
    }
}
