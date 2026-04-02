// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// ══════════════════════════════════════════════════════════════════════
//  PRIMEVAULTS V3 — IQuoterV2
//  Uniswap V3 QuoterV2 interface (quoteExactOutputSingle only)
// ══════════════════════════════════════════════════════════════════════

/**
 * @title IQuoterV2
 * @notice Uniswap V3 QuoterV2 interface for single-hop exact output quotes.
 */
interface IQuoterV2 {
    struct QuoteExactOutputSingleParams {
        address tokenIn;
        address tokenOut;
        uint256 amount;
        uint24 fee;
        uint160 sqrtPriceLimitX96;
    }

    /**
     * @notice Returns the amount of tokenIn required to receive the given exact amount of tokenOut.
     * @param params The parameters for the quote
     * @return amountIn Amount of tokenIn required
     * @return sqrtPriceX96After The sqrt price of the pool after the swap
     * @return initializedTicksCrossed Number of initialized ticks crossed
     * @return gasEstimate Estimated gas for the swap
     */
    function quoteExactOutputSingle(QuoteExactOutputSingleParams memory params)
        external
        returns (uint256 amountIn, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate);
}
