// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// ══════════════════════════════════════════════════════════════════════
//  PRIMEVAULTS V3 — FixedPointMath
//  Thin wrapper over PRBMath UD60x18 for 18-decimal fixed-point ops
//  See: docs/PV_V3_MATH_REFERENCE.md sections E2, E3
// ══════════════════════════════════════════════════════════════════════

import {UD60x18, ud} from "@prb/math/src/UD60x18.sol";
import {pow} from "@prb/math/src/ud60x18/Math.sol";

/**
 * @title FixedPointMath
 * @dev Fixed-point arithmetic helpers for RP1/RP2 premium curves.
 *      All values use 18-decimal representation (1e18 = 1.0).
 *      Power function delegates to PRBMath UD60x18.pow().
 */
library FixedPointMath {
    uint256 internal constant PRECISION = 1e18;

    /**
     * @dev Compute base^exp where both are 18-decimal fixed-point.
     *      Used for RP curves: RP = x + y * r^k.
     *      See MATH_REFERENCE §E2, §E3.
     * @param base The base value (1e18 scale)
     * @param exp The exponent value (1e18 scale)
     * @return result base raised to exp (1e18 scale)
     */
    function fpow(uint256 base, uint256 exp) internal pure returns (uint256 result) {
        if (base == 0) return 0;
        if (exp == 0) return PRECISION;
        UD60x18 udResult = pow(ud(base), ud(exp));
        result = udResult.unwrap();
    }

    /**
     * @dev Fixed-point multiplication: a * b / 1e18
     * @param a First operand (1e18 scale)
     * @param b Second operand (1e18 scale)
     * @return result Product in 1e18 scale
     */
    function fpMul(uint256 a, uint256 b) internal pure returns (uint256 result) {
        result = (a * b) / PRECISION;
    }

    /**
     * @dev Fixed-point division: a * 1e18 / b
     * @param a Numerator (1e18 scale)
     * @param b Denominator (1e18 scale). Must be non-zero.
     * @return result Quotient in 1e18 scale
     */
    function fpDiv(uint256 a, uint256 b) internal pure returns (uint256 result) {
        result = (a * PRECISION) / b;
    }
}
