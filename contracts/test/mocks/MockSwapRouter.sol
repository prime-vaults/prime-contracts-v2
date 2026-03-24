// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @dev Mock swap router that swaps at a configurable rate.
 *      rate = how many outputTokens per 1e18 inputToken (18 decimals).
 *      e.g., WETH→USDai rate = 3000e18 means 1 WETH = 3000 USDai.
 *      Holds reserves of both tokens (mint before use).
 */
contract MockSwapRouter {
    // rate[tokenIn][tokenOut] = outputAmount per 1e18 input
    mapping(address => mapping(address => uint256)) public s_rates;

    function setRate(address tokenIn, address tokenOut, uint256 rate) external {
        s_rates[tokenIn][tokenOut] = rate;
    }

    function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut) external returns (uint256 amountOut) {
        uint256 rate = s_rates[tokenIn][tokenOut];
        require(rate > 0, "MockSwapRouter: no rate");

        amountOut = amountIn * rate / 1e18;
        require(amountOut >= minOut, "MockSwapRouter: slippage");

        IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn);
        IERC20(tokenOut).transfer(msg.sender, amountOut);
    }
}

/**
 * @dev Simple mintable ERC20 for test base assets (USDai, etc.).
 */
contract MockBaseAsset is ERC20 {
    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
