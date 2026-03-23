// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {FixedPointMath} from "./FixedPointMath.sol";

/**
 * @dev Test harness that exposes FixedPointMath library functions as external calls.
 */
contract FixedPointMathHarness {
    using FixedPointMath for uint256;

    function fpow(uint256 base, uint256 exp) external pure returns (uint256) {
        return FixedPointMath.fpow(base, exp);
    }

    function fpMul(uint256 a, uint256 b) external pure returns (uint256) {
        return FixedPointMath.fpMul(a, b);
    }

    function fpDiv(uint256 a, uint256 b) external pure returns (uint256) {
        return FixedPointMath.fpDiv(a, b);
    }
}
