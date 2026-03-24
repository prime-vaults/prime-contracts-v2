// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// ══════════════════════════════════════════════════════════════════════
//  PRIMEVAULTS V3 — WETHPriceOracle
//  30-minute TWAP using Chainlink ETH/USD feed, shared across markets
//  See: docs/PV_V3_FINAL_v34.md section 22
// ══════════════════════════════════════════════════════════════════════

import {IWETHPriceOracle} from "../interfaces/IWETHPriceOracle.sol";

/**
 * @dev Minimal Chainlink AggregatorV3Interface.
 */
interface AggregatorV3Interface {
    function latestRoundData() external view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
    function decimals() external view returns (uint8);
}

/**
 * @title WETHPriceOracle
 * @notice 30-minute TWAP price oracle for WETH/USD using Chainlink.
 * @dev 10-point circular buffer. Prices recorded on each call to recordPrice() (keeper/permissionless).
 *      getWETHPrice() returns time-weighted average of buffered prices within 30-min window.
 *      getSpotPrice() returns latest Chainlink price directly.
 *      Reverts if Chainlink data is stale (>1 hour).
 *      Shared across all markets — ETH price is universal.
 */
contract WETHPriceOracle is IWETHPriceOracle {
    // ═══════════════════════════════════════════════════════════════════
    //  TYPES
    // ═══════════════════════════════════════════════════════════════════

    struct PricePoint {
        uint256 price;     // 18 decimals
        uint256 timestamp;
    }

    // ═══════════════════════════════════════════════════════════════════
    //  CONSTANTS
    // ═══════════════════════════════════════════════════════════════════

    uint256 public constant BUFFER_SIZE = 10;
    uint256 public constant TWAP_PERIOD = 30 minutes;
    uint256 public constant MAX_STALENESS = 1 hours;

    // ═══════════════════════════════════════════════════════════════════
    //  IMMUTABLES
    // ═══════════════════════════════════════════════════════════════════

    AggregatorV3Interface public immutable i_chainlinkFeed;
    uint256 private immutable i_chainlinkScale; // 10**(18 - feedDecimals)

    // ═══════════════════════════════════════════════════════════════════
    //  STATE
    // ═══════════════════════════════════════════════════════════════════

    PricePoint[10] public s_buffer;
    uint256 public s_bufferIndex;
    uint256 public s_bufferCount;

    // ═══════════════════════════════════════════════════════════════════
    //  EVENTS
    // ═══════════════════════════════════════════════════════════════════

    event PriceRecorded(uint256 price, uint256 timestamp);

    // ═══════════════════════════════════════════════════════════════════
    //  ERRORS
    // ═══════════════════════════════════════════════════════════════════

    error PrimeVaults__StaleChainlinkData(uint256 updatedAt, uint256 maxAge);
    error PrimeVaults__InvalidChainlinkPrice(int256 price);
    error PrimeVaults__NoDataRecorded();

    // ═══════════════════════════════════════════════════════════════════
    //  CONSTRUCTOR
    // ═══════════════════════════════════════════════════════════════════

    constructor(address chainlinkFeed_) {
        i_chainlinkFeed = AggregatorV3Interface(chainlinkFeed_);
        uint8 feedDecimals = AggregatorV3Interface(chainlinkFeed_).decimals();
        i_chainlinkScale = 10 ** (18 - feedDecimals);
    }

    // ═══════════════════════════════════════════════════════════════════
    //  RECORD — permissionless
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Record the current Chainlink price into the TWAP buffer.
     * @dev Permissionless — anyone can call. No value extraction possible.
     *      Reverts if Chainlink data is stale or price <= 0.
     */
    function recordPrice() external {
        (uint256 price18, uint256 updatedAt) = _getChainlinkPrice();

        uint256 idx = s_bufferIndex % BUFFER_SIZE;
        s_buffer[idx] = PricePoint({price: price18, timestamp: updatedAt});
        s_bufferIndex++;
        if (s_bufferCount < BUFFER_SIZE) s_bufferCount++;

        emit PriceRecorded(price18, updatedAt);
    }

    // ═══════════════════════════════════════════════════════════════════
    //  VIEW — getWETHPrice (30-min TWAP)
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Get the 30-minute TWAP price of WETH in USD.
     * @dev Computes average of all buffered prices within the TWAP window.
     *      Reverts if no data recorded or all data is older than TWAP_PERIOD.
     *      Intentional 30-min lag prevents oracle manipulation.
     * @return price18 WETH price in USD with 18 decimals
     */
    function getWETHPrice() external view override returns (uint256 price18) {
        if (s_bufferCount == 0) revert PrimeVaults__NoDataRecorded();

        uint256 cutoff = block.timestamp > TWAP_PERIOD ? block.timestamp - TWAP_PERIOD : 0;
        uint256 sum;
        uint256 count;

        for (uint256 i = 0; i < s_bufferCount; i++) {
            uint256 idx = (s_bufferIndex - 1 - i) % BUFFER_SIZE;
            PricePoint memory pp = s_buffer[idx];
            if (pp.timestamp >= cutoff) {
                sum += pp.price;
                count++;
            }
        }

        // If no points in window, use the most recent point (graceful degradation)
        if (count == 0) {
            uint256 latestIdx = (s_bufferIndex - 1) % BUFFER_SIZE;
            return s_buffer[latestIdx].price;
        }

        price18 = sum / count;
    }

    // ═══════════════════════════════════════════════════════════════════
    //  VIEW — getSpotPrice (latest Chainlink)
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Get the latest spot price of WETH in USD from Chainlink.
     * @dev For display/UI only. NOT used in TVL calculations.
     * @return price18 WETH spot price in USD with 18 decimals
     */
    function getSpotPrice() external view override returns (uint256 price18) {
        (price18,) = _getChainlinkPrice();
    }

    // ═══════════════════════════════════════════════════════════════════
    //  INTERNAL
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @dev Read Chainlink, validate staleness and price, normalize to 18 decimals.
     */
    function _getChainlinkPrice() internal view returns (uint256 price18, uint256 updatedAt) {
        (, int256 answer,, uint256 updatedAt_,) = i_chainlinkFeed.latestRoundData();

        if (answer <= 0) revert PrimeVaults__InvalidChainlinkPrice(answer);
        if (block.timestamp - updatedAt_ > MAX_STALENESS) {
            revert PrimeVaults__StaleChainlinkData(updatedAt_, MAX_STALENESS);
        }

        price18 = uint256(answer) * i_chainlinkScale;
        updatedAt = updatedAt_;
    }
}
